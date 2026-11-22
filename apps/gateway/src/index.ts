import { WebSocket, WebSocketServer } from 'ws';
import {
  TASK_RECEIPTS,
  envelope,
  type AgentProviderInfo,
  type Envelope,
  type ServerHello,
  type SessionEvent,
  type TaskRef,
  type TaskReport,
} from '@rab/protocol';
import type { IncomingMessage } from 'node:http';
import { readRuntimeConfig, readSetupToken, validSetupToken } from '@rab/config';
import { app } from './app.js';
import { isAgentBound, slot } from './agent-slot.js';
import { issueChallenge, normalizePublicKey, verifyDeviceSignature } from './device-keys.js';
import { valid } from './hashing.js';
import { isAllowedOrigin, originFor } from './security.js';
import { host, port } from './runtime.js';
import { onAgentDisconnected, reconcileAgent, recordTaskReport, reportMissingTask } from './task-dispatch.js';
import {
  devices,
  pendingCommands,
  pairings,
  persistState,
  StateWriteError,
} from './state.js';

// Each route module registers its handlers against the shared instance above.
import './routes/pages.js';
import './routes/setup.js';
import './routes/auth.js';
import './routes/providers.js';
import './routes/devices.js';
import './routes/sessions.js';
import './routes/tasks.js';
import './routes/dashboard.js';


// Create the setup token eagerly so the operator (and the launcher, which reads
// it from the data directory) can obtain it without a privileged request first.
readSetupToken();


app.addHook('onRequest', async (request, reply) => {
  const origin = originFor(request);
  if (origin && !isAllowedOrigin(request)) {
    if (request.method === 'OPTIONS') return reply.code(403).send({ error: 'origin_not_allowed' });
    return reply.code(403).send({ error: 'origin_not_allowed' });
  }
  // Minimal hardening headers for every browser-facing response.
  reply.header('x-content-type-options', 'nosniff');
  reply.header('referrer-policy', 'no-referrer');
  reply.header('x-frame-options', 'DENY');
  reply.header('content-security-policy', "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'");
  if (request.url.startsWith('/api/')) reply.header('cache-control', 'no-store');
  if (origin) {
    reply.header('access-control-allow-origin', origin);
    reply.header('vary', 'Origin');
    reply.header('access-control-allow-headers', 'content-type, authorization, x-rab-setup-token');
    reply.header('access-control-allow-methods', 'GET,POST,DELETE,OPTIONS');
  }
  if (request.method === 'OPTIONS') return reply.code(204).send();
});









await app.listen({ port, host });
const wss = new WebSocketServer({ server: app.server, path: '/agent', maxPayload: 768 * 1024, verifyClient: (info: { origin: string; secure: boolean; req: IncomingMessage }) => {
  const origin = String(info.req.headers.origin ?? '');
  if (!origin) return true;
  const hostHeader = String(info.req.headers.host ?? '').trim();
  const configured = readRuntimeConfig().publicUrl.trim().replace(/\/$/, '');
  return origin === `http://${hostHeader}` || origin === `https://${hostHeader}` ||
    (configured.length > 0 && origin === configured) ||
    origin === `http://127.0.0.1:${port}` || origin === `https://127.0.0.1:${port}` ||
    origin === `http://localhost:${port}` || origin === `https://localhost:${port}`;
} });
const awaitingPong = new WeakSet<WebSocket>();
const heartbeat = setInterval(() => {
  for (const socket of wss.clients) {
    if (socket.readyState !== WebSocket.OPEN) continue;
    if (awaitingPong.has(socket)) socket.terminate();
    else { awaitingPong.add(socket); socket.ping(); }
  }
}, 15_000).unref();
wss.once('close', () => clearInterval(heartbeat));
wss.on('connection', socket => {
  socket.on('pong', () => awaitingPong.delete(socket));
  socket.on('error', () => app.log.debug('Agent socket error'));
  // Handshake state: nothing is accepted from this socket until agent.hello
  // proves possession of the device's Ed25519 key (or, for an already-bound
  // legacy device, the old bearer token) and the device is bound.
  let handshakePassed = false;
  const handshakeTimer = setTimeout(() => socket.close(1008, 'handshake_timeout'), 10_000).unref();
  let socketDeviceId: string | undefined;
  let socketAuthenticated = false;
  // The challenge is issued only when the Agent asks for it, so the Gateway
  // never speaks first: an unauthenticated peer receives no data at all.
  let challenge: (ServerHello & { issued_at: number }) | undefined;
  socket.on('message', data => {
    try {
      const event = JSON.parse(data.toString()) as Envelope<{
        device_id: string;
        platform: string;
        interaction_mode: string;
        capabilities: string[];
        providers?: AgentProviderInfo[];
        device_token?: string;
        public_key?: string;
        signature?: string;
        /** Proves the peer can read this machine's data directory. */
        local_proof?: string;
      } | SessionEvent | TaskReport | TaskRef>;
      if (!event || event.version !== 1 || typeof event.type !== 'string' || typeof event.request_id !== 'string' || event.request_id.length > 128 ||
          !event.payload || typeof event.payload !== 'object' || Array.isArray(event.payload)) {
        socket.close(1008, 'invalid_envelope');
        return;
      }
      if (event.type === 'agent.challenge') {
        // One challenge per connection. A second request is ignored rather
        // than answered, so a peer cannot shop for a nonce that suits it.
        if (handshakePassed || challenge) return;
        challenge = { ...issueChallenge(), issued_at: Date.now() };
        socket.send(JSON.stringify(envelope('server.hello', { nonce: challenge.nonce, expires_at: challenge.expires_at })));
        return;
      }
      if (event.type === 'agent.hello') {
        if (handshakePassed) return;
        const hello = event.payload as {
          device_id: string;
          device_token?: string;
          public_key?: string;
          signature?: string;
          local_proof?: string;
          platform: string;
          interaction_mode: string;
          capabilities: string[];
          providers?: AgentProviderInfo[];
        };
        if (typeof hello.device_id !== 'string' || !hello.device_id.trim() || hello.device_id.length > 128) {
          socket.close(1008, 'device_identity_invalid');
          return;
        }
        const existingDevice = devices.get(hello.device_id);
        // ---- Proof of identity -------------------------------------------
        // Preferred: the device signs this connection's nonce with its Ed25519
        // key. The signature is worthless on any other connection, so neither
        // a captured handshake nor a copied state file can impersonate it.
        const presentedKey = normalizePublicKey(hello.public_key);
        const freshChallenge = challenge && Date.now() <= challenge.expires_at ? challenge.nonce : undefined;
        const keyProofValid = Boolean(
          presentedKey &&
          freshChallenge &&
          verifyDeviceSignature(freshChallenge, presentedKey, String(hello.signature ?? '')),
        );
        // The nonce is single use whatever the outcome.
        challenge = undefined;
        // Legacy: a bearer token, accepted only to migrate a device that was
        // bound before device keys existed. New pairings never mint one.
        const storedKey = existingDevice?.auth_public_key;
        const tokenAuthenticated = Boolean(
          !storedKey && existingDevice?.auth_token_hash && typeof hello.device_token === 'string' && valid(hello.device_token, existingDevice.auth_token_hash),
        );
        // A key-bound device authenticates only against the key on record: a
        // different key that merely self-signs the nonce proves nothing.
        const keyAuthenticated = Boolean(storedKey && presentedKey === storedKey && keyProofValid);
        socketAuthenticated = keyAuthenticated || tokenAuthenticated;
        if ((storedKey || existingDevice?.auth_token_hash) && !socketAuthenticated) {
          socket.close(1008, 'device_identity_invalid');
          return;
        }
        // A device that still holds a token but can now sign upgrades itself:
        // the token hash is dropped, so the old bearer secret stops working.
        let upgraded = false;
        // The Agent always runs on this machine and can therefore read the
        // setup token from the data directory; a peer that reaches the Gateway
        // across a tunnel cannot. Without this check a remote peer could
        // connect first, hold the single agent slot, and be the device the
        // operator ends up pairing — binding the operator's computer to it.
        const localProof = String(hello.local_proof ?? '');
        const socketLocal = Boolean(localProof) && validSetupToken(localProof);
        if (!socketAuthenticated && !socketLocal) {
          socket.close(1008, 'local_proof_required');
          return;
        }
        // Slot arbitration. Every connection that got this far is either
        // authenticated (it proved a device key or token) or local (it proved
        // it can read this machine's data dir); a remote peer with neither was
        // already refused above. A newcomer may take the slot when:
        //   - it proved a device key, or
        //   - it is the local Agent and the incumbent is not authenticated.
        // The second case matters because a restarted Agent has no useful
        // credential on first run, and it must still be able to reclaim the
        // slot from an unauthenticated peer. An authenticated incumbent is
        // never displaced by a different device id, so one device cannot
        // shadow another.
        if (slot.agent && slot.agent.readyState === WebSocket.OPEN) {
          const sameDevice = slot.deviceId === hello.device_id;
          if ((sameDevice && socketAuthenticated) || !slot.authenticated) {
            if (!sameDevice && slot.deviceId) {
              const previous = devices.get(slot.deviceId);
              if (previous) previous.online = false;
            }
            slot.agent.close(1000, socketAuthenticated ? 'superseded_by_reconnect' : 'superseded_by_local_agent');
          } else {
            socket.close(1008, 'agent_already_connected');
            return;
          }
        }
        if (tokenAuthenticated && keyProofValid && presentedKey) {
          devices.set(hello.device_id, { ...existingDevice!, auth_public_key: presentedKey, auth_token_hash: undefined });
          try { persistState(); }
          catch {
            devices.set(hello.device_id, existingDevice!);
            app.log.error('Device credential migration could not be persisted');
            socket.close(1011, 'state_write_failed');
            return;
          }
          upgraded = true;
        }
        handshakePassed = true;
        clearTimeout(handshakeTimer);
        slot.authenticated = socketAuthenticated;
        slot.local = socketLocal;
        slot.publicKey = keyProofValid ? presentedKey : undefined;
        slot.authMode = socketAuthenticated ? (keyAuthenticated || upgraded ? 'device_key' : 'token') : 'unbound';
        slot.queuePaused = false;
        slot.agent = socket;
        // Store only the fields we need. Never keep or expose the raw
        // device_token (it arrives in hello but must not leak into /health).
        slot.info = {
          device_id: hello.device_id,
          platform: hello.platform,
          interaction_mode: hello.interaction_mode,
          capabilities: Array.isArray(hello.capabilities) ? hello.capabilities.slice(0, 100).filter(capability => typeof capability === 'string') : [],
          providers: Array.isArray(hello.providers) ? hello.providers.slice(0, 100).filter(provider => provider && typeof provider.id === 'string' && typeof provider.name === 'string') : [],
        };
        socketDeviceId = hello.device_id;
        slot.deviceId = hello.device_id;
        const device = devices.get(slot.deviceId) ?? { name: readRuntimeConfig().deviceName, platform: hello.platform, online: true };
        device.platform = hello.platform;
        device.online = true;
        devices.set(slot.deviceId, device);
        if (upgraded) {
          app.log.info({ device_id: hello.device_id }, 'device upgraded from bearer token to Ed25519 device key');
        }
        app.log.info({ device_id: hello.device_id, authenticated: socketAuthenticated, auth_mode: slot.authMode }, 'agent handshake passed');
        if (isAgentBound() && slot.info.capabilities.includes(TASK_RECEIPTS)) reconcileAgent(socket);
        return;
      }
      // Every message type other than agent.hello requires a completed,
      // authenticated handshake. Unbound devices still cannot issue tasks.
      if (!handshakePassed || !socketAuthenticated || slot.agent !== socket || !isAgentBound()) {
        socket.close(1008, 'handshake_required');
        return;
      }
      if (event.type === 'session.event') {
        const sessionEvent = event.payload as SessionEvent;
        const pending = event.request_id ? pendingCommands.get(event.request_id) : undefined;
        if (pending?.socket === socket && (sessionEvent.action === 'failed' || (
          sessionEvent.action === pending.action && sessionEvent.session?.id === pending.sessionId &&
          sessionEvent.session.provider_id === pending.providerId && typeof sessionEvent.session.title === 'string' &&
          typeof sessionEvent.session.created_at === 'string' && typeof sessionEvent.session.updated_at === 'string'
        ))) {
          pendingCommands.delete(event.request_id);
          clearTimeout(pending.timer);
          pending.resolve(sessionEvent);
        }
      } else if (event.type === 'agent.status' && slot.info?.capabilities.includes(TASK_RECEIPTS)) {
        const status = event.payload as { queue_paused?: unknown };
        if (typeof status.queue_paused === 'boolean') slot.queuePaused = status.queue_paused;
      } else if (event.type === 'task.event') recordTaskReport(socket, event.payload as TaskReport);
      else if (event.type === 'task.missing') reportMissingTask(socket, event.payload as TaskRef);
      app.log.debug({ event_type: event.type }, 'agent event');
    } catch (error) {
      if (error instanceof StateWriteError) app.log.error('Task report could not be persisted; no acknowledgement sent');
      else app.log.warn('ignored malformed agent message');
    }
  });
  socket.on('close', () => {
    onAgentDisconnected(socket);
    clearTimeout(handshakeTimer);
    for (const [code, pairing] of pairings) {
      if (pairing.socket !== socket) continue;
      pairings.delete(code);
      const device = devices.get(pairing.deviceId);
      if (device?.pairing === code) device.pairing = undefined;
    }
    // Only the socket that currently holds the slot may clear slot state: a
    // socket superseded by a newer one must not mark the device offline or
    // blank its successor's authorization.
    if (slot.agent === socket) {
      const deviceId = socketDeviceId ?? slot.deviceId;
      const device = deviceId ? devices.get(deviceId) : undefined;
      if (device) device.online = false;
      slot.agent = undefined;
      slot.info = undefined;
      slot.deviceId = undefined;
      slot.authenticated = false;
      slot.local = false;
      slot.publicKey = undefined;
      slot.authMode = 'unbound';
      slot.queuePaused = false;
    }
    for (const [requestId, pending] of pendingCommands) {
      if (pending.socket !== socket) continue;
      clearTimeout(pending.timer);
      pending.reject(new Error('agent_disconnected'));
      pendingCommands.delete(requestId);
    }
    app.log.info('agent disconnected');
  });
});
console.log(`Gateway listening on http://${host}:${port}`);
