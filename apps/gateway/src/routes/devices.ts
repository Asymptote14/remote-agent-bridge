import { randomBytes, randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { envelope } from '@rab/protocol';
import { app } from '../app.js';
import { slot } from '../agent-slot.js';
import { hash } from '../hashing.js';
import { canTryPairing, clearPairingFailures, recordPairingFailure } from '../pairing.js';
import { auth } from '../security.js';
import { devices, pairings, persistState, publicDevice } from '../state.js';
import { revokeTaskRecords } from '../task-dispatch.js';
app.get('/api/devices', async (request, reply) => {
  const user = auth(request);
  if (!user) return reply.code(401).send({ error: 'unauthorized' });
  return [...devices.entries()]
    .filter(([, device]) => device.owner === user)
    .map(([id, device]) => publicDevice(id, device));
});

app.post<{ Body: { code: string } }>('/api/pairings/authorize', async (request, reply) => {
  const rate = canTryPairing(request);
  if (!rate.allowed) {
    reply.header('retry-after', String(rate.retryAfter));
    return reply.code(429).send({ error: 'pairing_rate_limited', retry_after: rate.retryAfter });
  }
  const user = auth(request);
  if (!user) {
    recordPairingFailure(request);
    return reply.code(401).send({ error: 'unauthorized' });
  }
  const code = String(request.body?.code ?? '').trim();
  const pairing = /^\d{6}$/.test(code) ? pairings.get(code) : undefined;
  const device = pairing ? devices.get(pairing.deviceId) : undefined;
  if (!pairing || !device || device.owner || device.pairing !== code || pairing.expires <= Date.now() ||
      slot.agent !== pairing.socket || pairing.socket.readyState !== WebSocket.OPEN || slot.deviceId !== pairing.deviceId || !slot.local) {
    recordPairingFailure(request);
    return reply.code(401).send({ error: 'invalid_pairing' });
  }
  // Bind to the public key the connected Agent proved it holds. Nothing secret
  // travels: the private half never leaves the computer, so capturing this
  // response (or reading state.json later) does not let anyone impersonate it.
  // A legacy Agent that sent no key still gets a bearer token, which it will
  // upgrade away from on its next handshake.
  const boundKey = slot.deviceId === pairing.deviceId ? slot.publicKey : undefined;
  const deviceToken = boundKey ? undefined : randomBytes(32).toString('hex');
  const bound = { ...device, owner: user, binding_id: randomUUID(), pairing: undefined,
    auth_public_key: boundKey, auth_token_hash: deviceToken ? hash(deviceToken) : undefined };
  devices.set(pairing.deviceId, bound);
  try { persistState(); }
  catch {
    devices.set(pairing.deviceId, device);
    app.log.error('Device pairing could not be persisted');
    return reply.code(503).send({ error: 'state_write_failed' });
  }
  pairings.delete(code);
  clearPairingFailures(request);
  // Tell the connected Agent it is bound so it can reconnect and authenticate.
  if (slot.agent?.readyState === WebSocket.OPEN && slot.deviceId === pairing.deviceId) {
    slot.agent.send(JSON.stringify(envelope('device.bound', { device_id: pairing.deviceId, token: deviceToken, key_bound: Boolean(boundKey) })));
  }
  return { authorized: true, device: publicDevice(pairing.deviceId, bound), auth_mode: boundKey ? 'device_key' : 'token' };
});

app.post<{ Params: { id: string } }>('/api/devices/:id/revoke', async (request, reply) => {
  const user = auth(request);
  const device = devices.get(request.params.id);
  if (!user || !device || device.owner !== user) return reply.code(404).send({ error: 'device_not_found' });
  const previous = { ...device };
  const restoreTasks = revokeTaskRecords(request.params.id, device.binding_id, user);
  device.owner = undefined;
  device.binding_id = undefined;
  device.pairing = undefined;
  device.online = false;
  device.auth_token_hash = undefined;
  // Drop the key too: revocation must remove the credential, not just the owner.
  device.auth_public_key = undefined;
  try { persistState(); }
  catch {
    devices.set(request.params.id, previous);
    restoreTasks();
    app.log.error('Device revocation could not be persisted');
    return reply.code(503).send({ error: 'state_write_failed' });
  }
  if (previous.pairing) pairings.delete(previous.pairing);
  // Drop the live Agent connection so a revoked device cannot keep using it.
  // Clear the whole slot, not just the socket: a stale device id or key would
  // otherwise linger in /api/setup/status after the connection is gone.
  if (slot.agent?.readyState === WebSocket.OPEN && slot.deviceId === request.params.id) {
    slot.agent.close(1008, 'device_revoked');
    slot.agent = undefined;
    slot.info = undefined;
    slot.deviceId = undefined;
    slot.authenticated = false;
    slot.local = false;
    slot.publicKey = undefined;
    slot.authMode = 'unbound';
    slot.queuePaused = false;
  }
  return { revoked: true };
});
