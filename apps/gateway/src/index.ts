import { WebSocketServer } from 'ws';
import {
  envelope,
  type AgentProviderInfo,
  type Envelope,
  type SessionEvent,
  type TaskEvent,
} from '@rab/protocol';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { readRuntimeConfig, readSetupToken, validSetupToken } from '@rab/config';
import { app } from './app.js';
import { slot } from './agent-slot.js';
import { valid } from './hashing.js';
import { isAllowedOrigin, originFor } from './security.js';
import { host, port } from './runtime.js';
import {
  devices,
  pendingCommands,
  pendingSessionOwners,
  persistState,
  sessions,
  tasks,
} from './state.js';

// Each route module registers its handlers against the shared instance above.
import './routes/pages.js';
import './routes/setup.js';
import './routes/auth.js';
import './routes/providers.js';
import './routes/devices.js';
import './routes/sessions.js';
import './routes/tasks.js';


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
  if (origin) {
    reply.header('access-control-allow-origin', origin);
    reply.header('vary', 'Origin');
    reply.header('access-control-allow-headers', 'content-type, authorization, x-rab-setup-token');
    reply.header('access-control-allow-methods', 'GET,POST,DELETE,OPTIONS');
  }
  if (request.method === 'OPTIONS') return reply.code(204).send();
});









await app.listen({ port, host });
const wss = new WebSocketServer({ server: app.server, path: '/agent', verifyClient: (info: { origin: string; secure: boolean; req: IncomingMessage }) => {
  const origin = String(info.req.headers.origin ?? '');
  if (!origin) return true;
  const hostHeader = String(info.req.headers.host ?? '').trim();
  const configured = readRuntimeConfig().publicUrl.trim().replace(/\/$/, '');
  return origin === `http://${hostHeader}` || origin === `https://${hostHeader}` ||
    (configured.length > 0 && origin === configured) ||
    origin === `http://127.0.0.1:${port}` || origin === `https://127.0.0.1:${port}` ||
    origin === `http://localhost:${port}` || origin === `https://localhost:${port}`;
} });
wss.on('connection', socket => {
  // Handshake state: nothing is accepted from this socket until agent.hello
  // proves possession of the bound device token (or the device is brand new).
  let handshakePassed = false;
  let socketDeviceId: string | undefined;
  let socketAuthenticated = false;
  socket.on('message', data => {
    try {
      const event = JSON.parse(data.toString()) as Envelope<{
        device_id: string;
        platform: string;
        interaction_mode: string;
        capabilities: string[];
        providers?: AgentProviderInfo[];
        device_token?: string;
        /** Proves the peer can read this machine's data directory. */
        local_proof?: string;
      } | SessionEvent | TaskEvent>;
      if (event.type === 'agent.hello') {
        if (handshakePassed) return;
        const hello = event.payload as { device_id: string; device_token?: string; local_proof?: string; platform: string; interaction_mode: string; capabilities: string[]; providers?: AgentProviderInfo[] };
        if (!hello.device_id || typeof hello.device_id !== 'string') {
          socket.close(1008, 'device_identity_invalid');
          return;
        }
        const existingDevice = devices.get(hello.device_id);
        // A device that has already been bound MUST present the matching
        // token; anything else is rejected. An unbound device may connect but
        // stays unauthenticated: it never receives data until the local
        // operator binds it via the local /setup page.
        socketAuthenticated = Boolean(existingDevice?.auth_token_hash && hello.device_token && valid(hello.device_token, existingDevice.auth_token_hash));
        if (existingDevice?.auth_token_hash && !socketAuthenticated) {
          socket.close(1008, 'device_identity_invalid');
          return;
        }
        // The Agent always runs on this machine and can therefore read the
        // setup token from the data directory; a peer that reaches the Gateway
        // across a tunnel cannot. Without this check a remote peer could
        // connect first, hold the single agent slot, and be the device the
        // operator ends up pairing — handing it the device token.
        const localProof = String(hello.local_proof ?? '');
        const socketLocal = Boolean(localProof) && validSetupToken(localProof);
        if (!socketAuthenticated && !socketLocal) {
          socket.close(1008, 'local_proof_required');
          return;
        }
        // Slot arbitration. Every connection that got this far is either
        // authenticated (it proved a device token) or local (it proved it can
        // read this machine's data dir); a remote peer with neither was already
        // refused above. A newcomer may take the slot when:
        //   - it proved a device token, or
        //   - it is the local Agent and the incumbent is not authenticated.
        // The second case matters because a restarted Agent has no token yet on
        // first run, and it must still be able to reclaim the slot from an
        // unauthenticated peer. An authenticated incumbent is never displaced
        // by a different device id, so one device cannot shadow another.
        const replacesIncumbent = socketAuthenticated || (socketLocal && !slot.authenticated);
        if (slot.agent && slot.agent.readyState === WebSocket.OPEN) {
          const sameDevice = slot.deviceId === hello.device_id;
          if (sameDevice || replacesIncumbent) {
            slot.agent.close(1000, socketAuthenticated ? 'superseded_by_reconnect' : 'superseded_by_local_agent');
          } else {
            socket.close(1008, 'agent_already_connected');
            return;
          }
        }
        handshakePassed = true;
        slot.authenticated = socketAuthenticated;
        slot.local = socketLocal;
        slot.agent = socket;
        // Store only the fields we need. Never keep or expose the raw
        // device_token (it arrives in hello but must not leak into /health).
        slot.info = {
          device_id: hello.device_id,
          platform: hello.platform,
          interaction_mode: hello.interaction_mode,
          capabilities: hello.capabilities,
          providers: hello.providers ?? [],
        };
        socketDeviceId = hello.device_id;
        slot.deviceId = hello.device_id;
        const device = existingDevice ?? { name: readRuntimeConfig().deviceName, platform: hello.platform, online: true };
        device.platform = hello.platform;
        device.online = true;
        devices.set(slot.deviceId, device);
        app.log.info({ device_id: hello.device_id, authenticated: socketAuthenticated }, 'agent handshake passed');
        return;
      }
      // Every message type other than agent.hello requires a completed,
      // authenticated handshake. Unbound devices still cannot issue tasks.
      if (!handshakePassed || !socketAuthenticated) {
        socket.close(1008, 'handshake_required');
        return;
      }
      if (event.type === 'session.event') {
        const sessionEvent = event.payload as SessionEvent;
        if (sessionEvent.session) {
          const owner = pendingSessionOwners.get(sessionEvent.session.id) ?? sessions.get(sessionEvent.session.id)?.owner;
          if (owner) {
            sessions.set(sessionEvent.session.id, { session: sessionEvent.session, owner, messages: sessions.get(sessionEvent.session.id)?.messages ?? [] });
            pendingSessionOwners.delete(sessionEvent.session.id);
          }
        }
        // Correlate the response with the pending command via request_id.
        const pending = event.request_id ? pendingCommands.get(event.request_id) : undefined;
        if (pending) {
          pendingCommands.delete(event.request_id);
          clearTimeout(pending.timer);
          pending.resolve(sessionEvent);
        }
      } else if (event.type === 'task.event') {
        const taskEvent = event.payload as TaskEvent;
        let changed = false;
        const entry = tasks.get(taskEvent.task_id);
        if (entry) {
          entry.events.push(taskEvent);
          entry.events = entry.events.slice(-20);
          entry.updated_at = Date.now();
          if (taskEvent.session_id) entry.session_id = taskEvent.session_id;
          changed = true;
        }
        if (taskEvent.state === 'succeeded' && taskEvent.session_id && taskEvent.message) {
          const record = sessions.get(taskEvent.session_id);
          if (record) {
            record.messages.push({ id: randomUUID(), role: 'assistant', content: taskEvent.message, created_at: new Date().toISOString() });
            record.messages = record.messages.slice(-100);
            record.session.updated_at = new Date().toISOString();
            changed = true;
          }
        }
        if (changed) persistState();
      }
      app.log.debug({ event_type: event.type }, 'agent event');
    } catch { app.log.warn('ignored malformed agent message'); }
  });
  socket.on('close', () => {
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
    }
    for (const [requestId, pending] of pendingCommands) {
      clearTimeout(pending.timer);
      pending.reject(new Error('agent_disconnected'));
      pendingCommands.delete(requestId);
    }
    app.log.info('agent disconnected');
  });
});
console.log(`Gateway listening on http://${host}:${port}`);
