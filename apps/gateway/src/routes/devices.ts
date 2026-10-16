import { randomBytes } from 'node:crypto';
import { WebSocket } from 'ws';
import { envelope } from '@rab/protocol';
import { app } from '../app.js';
import { slot } from '../agent-slot.js';
import { hash } from '../hashing.js';
import { canTryPairing, clearPairingFailures, recordPairingFailure } from '../pairing.js';
import { auth } from '../security.js';
import { devices, pairings, persistState, publicDevice } from '../state.js';
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
  const code = String(request.body?.code ?? '').trim();
  const pairing = /^\d{6}$/.test(code) ? pairings.get(code) : undefined;
  if (!user || !pairing || pairing.expires < Date.now()) {
    recordPairingFailure(request);
    return reply.code(401).send({ error: 'invalid_pairing' });
  }
  const device = devices.get(pairing.deviceId)!;
  device.owner = user;
  device.pairing = undefined;
  const deviceToken = randomBytes(32).toString('hex');
  device.auth_token_hash = hash(deviceToken);
  pairings.delete(code);
  clearPairingFailures(request);
  persistState();
  // Hand the fresh device token to the connected Agent (if any) so binding
  // survives restarts. This is the only moment the raw token is transmitted.
  if (slot.agent?.readyState === WebSocket.OPEN && slot.deviceId === pairing.deviceId) {
    slot.agent.send(JSON.stringify(envelope('device.bound', { device_id: pairing.deviceId, token: deviceToken })));
  }
  return { authorized: true, device: publicDevice(pairing.deviceId, device) };
});

app.post<{ Params: { id: string } }>('/api/devices/:id/revoke', async (request, reply) => {
  const user = auth(request);
  const device = devices.get(request.params.id);
  if (!user || !device || device.owner !== user) return reply.code(404).send({ error: 'device_not_found' });
  device.owner = undefined;
  device.online = false;
  device.auth_token_hash = undefined;
  // Drop the live Agent connection so a revoked device cannot keep using it.
  if (slot.agent?.readyState === WebSocket.OPEN && slot.deviceId === request.params.id) {
    slot.agent.close(1008, 'device_revoked');
    slot.agent = undefined;
    slot.info = undefined;
  }
  persistState();
  return { revoked: true };
});
