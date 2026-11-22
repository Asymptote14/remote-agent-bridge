// Ed25519 device identity: a device proves itself by signing a per-connection
// nonce, and the Gateway stores only the public half.
//
// The three properties worth locking down here are:
//   1. pairing binds the public key the device *proved* it holds, and nothing
//      secret is sent back over the wire;
//   2. a different key claiming the same device id is refused, and so is a
//      signature captured from an earlier connection (replay);
//   3. a device bound the old way (bearer token) upgrades itself on the next
//      handshake, after which the token no longer works.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { api, agentOnline, DeviceClient, newKeyPair, registerUser, startGateway, waitFor } from './support.mjs';

describe('Ed25519 device identity', () => {
  let gateway;
  let userToken;
  const deviceId = 'key-agent';
  const keyPair = newKeyPair();
  let rawToken; // legacy token, only created by the migration test

  before(async () => {
    gateway = await startGateway();
    userToken = await registerUser(gateway.base, 'keys@test.local');
  });

  after(async () => {
    if (gateway) await gateway.stop();
  });

  it('accepts an unbound agent that proves its key and locality', async () => {
    const client = await new DeviceClient(gateway.wsUrl, { deviceId, keyPair }).connect();
    await client.handshake({ localProof: gateway.setupToken });
    await waitFor(() => agentOnline(gateway, deviceId), 5_000, 'agent online');
    const status = await api(gateway.base, '/api/setup/status', { setupToken: gateway.setupToken });
    assert.equal(status.data.agent.auth_mode, 'unbound');
    assert.equal(status.data.agent.key_bound, false);
    client.close();
  });

  it('binds the device to the public key and sends no secret back', async () => {
    const client = await new DeviceClient(gateway.wsUrl, { deviceId, keyPair }).connect();
    await client.handshake({ localProof: gateway.setupToken });
    await waitFor(() => agentOnline(gateway, deviceId), 5_000, 'agent online');

    const renewed = await api(gateway.base, '/api/setup/pairing/renew', { method: 'POST', setupToken: gateway.setupToken });
    assert.equal(renewed.status, 200);
    const authorized = await api(gateway.base, '/api/pairings/authorize', { method: 'POST', token: userToken, body: { code: renewed.data.code } });
    assert.equal(authorized.status, 200);
    assert.equal(authorized.data.auth_mode, 'device_key');

    const bound = await client.waitFor('device.bound');
    assert.equal(bound.payload.key_bound, true);
    assert.equal(bound.payload.token, undefined, 'pairing must not hand a bearer token to a key-bound device');

    const device = gateway.state().devices.find(([id]) => id === deviceId)[1];
    assert.equal(device.auth_public_key, keyPair.publicKey);
    assert.equal(device.auth_token_hash, undefined, 'a key-bound device must not keep a token hash');
    client.close();
  });

  it('authenticates a bound device on a fresh connection with only a signature', async () => {
    const client = await new DeviceClient(gateway.wsUrl, { deviceId, keyPair }).connect();
    // Deliberately no local_proof and no token: the key alone must be enough.
    await client.handshake({});
    await waitFor(() => agentOnline(gateway, deviceId), 5_000, 'key-only handshake accepted');
    const status = await api(gateway.base, '/api/setup/status', { setupToken: gateway.setupToken });
    assert.equal(status.data.agent.auth_mode, 'device_key');
    assert.equal(status.data.agent.key_bound, true);
    client.close();
  });

  it('refuses a different key claiming the same device id', async () => {
    const impostor = await new DeviceClient(gateway.wsUrl, { deviceId, keyPair: newKeyPair() }).connect();
    await impostor.handshake({});
    const closed = await impostor.closed;
    assert.equal(closed.code, 1008);
    assert.equal(closed.reason, 'device_identity_invalid');
  });

  it('refuses a signature replayed from an earlier connection', async () => {
    const first = await new DeviceClient(gateway.wsUrl, { deviceId, keyPair }).connect();
    await first.handshake({});
    await waitFor(() => agentOnline(gateway, deviceId), 5_000, 'agent online');

    // Reuse the captured signature against a *new* nonce: the Gateway must
    // reject it, which is what makes a recorded handshake worthless.
    const replay = await new DeviceClient(gateway.wsUrl, { deviceId, keyPair }).connect();
    replay.send('agent.challenge', {});
    await replay.waitFor('server.hello');
    replay.send('agent.hello', {
      device_id: deviceId,
      platform: 'win32',
      interaction_mode: 'isolated',
      capabilities: ['sessions'],
      public_key: keyPair.publicKey,
      signature: first.lastSignature,
      local_proof: gateway.setupToken,
    });
    const closed = await replay.closed;
    assert.equal(closed.code, 1008);
    assert.equal(closed.reason, 'device_identity_invalid');
    first.close();
  });

  it('upgrades a legacy token-bound device to a key, after which the token fails', async () => {
    const legacyId = 'legacy-agent';
    const legacy = await new DeviceClient(gateway.wsUrl, { deviceId: legacyId }).connect();
    // No key at all: this is the pre-Ed25519 agent, which still gets a token.
    legacy.send('agent.challenge', {});
    await legacy.waitFor('server.hello');
    legacy.send('agent.hello', {
      device_id: legacyId,
      platform: 'win32',
      interaction_mode: 'isolated',
      capabilities: ['sessions'],
      local_proof: gateway.setupToken,
    });
    await waitFor(async () => (await api(gateway.base, '/health')).data.agent?.device_id === legacyId, 5_000, 'legacy agent online');

    const renewed = await api(gateway.base, '/api/setup/pairing/renew', { method: 'POST', setupToken: gateway.setupToken });
    const authorized = await api(gateway.base, '/api/pairings/authorize', { method: 'POST', token: userToken, body: { code: renewed.data.code } });
    assert.equal(authorized.data.auth_mode, 'token');
    const bound = await legacy.waitFor('device.bound');
    rawToken = bound.payload.token;
    assert.match(rawToken, /^[0-9a-f]{64}$/, 'a keyless device still needs the legacy token to bind');
    legacy.close();

    // The same device, now with a key and its old token, upgrades on handshake.
    const upgradedPair = newKeyPair();
    const upgrading = await new DeviceClient(gateway.wsUrl, { deviceId: legacyId, keyPair: upgradedPair }).connect();
    await upgrading.handshake({ token: rawToken });
    await waitFor(() => agentOnline(gateway, legacyId), 5_000, 'upgraded agent online');
    const record = gateway.state().devices.find(([id]) => id === legacyId)[1];
    assert.equal(record.auth_public_key, upgradedPair.publicKey);
    assert.equal(record.auth_token_hash, undefined, 'the legacy token hash must be dropped on upgrade');
    upgrading.close();

    // The old token alone must now be useless.
    const staleToken = await new DeviceClient(gateway.wsUrl, { deviceId: legacyId }).connect();
    staleToken.send('agent.challenge', {});
    await staleToken.waitFor('server.hello');
    staleToken.send('agent.hello', { device_id: legacyId, platform: 'win32', interaction_mode: 'isolated', capabilities: ['sessions'], device_token: rawToken });
    const closed = await staleToken.closed;
    assert.equal(closed.code, 1008);
    assert.equal(closed.reason, 'device_identity_invalid');
  });
});
