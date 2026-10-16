// Account, device-binding and persistence coverage.
//
// These cases came from apps/gateway/test/security.test.mjs, a directory the
// `node --test "apps/gateway/tests/*.test.mjs"` glob never matched, so none of
// it ever ran. The assertions here were re-checked against current gateway
// behaviour; the stale ones from that file were corrected rather than copied.
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { api, FakeAgent, registerUser, startGateway, waitFor } from './helpers.mjs';

describe('account endpoints', () => {
  let gateway;

  before(async () => { gateway = await startGateway(); });
  after(async () => { if (gateway) await gateway.stop(); });

  it('issues a working bearer token and rejects a duplicate registration', async () => {
    const registered = await api(gateway.base, '/api/auth/register', {
      method: 'POST',
      body: { email: 'a@test.local', password: 'password123' },
    });
    assert.equal(registered.status, 200);
    assert.ok(registered.data.token);

    const duplicate = await api(gateway.base, '/api/auth/register', {
      method: 'POST',
      body: { email: 'a@test.local', password: 'password123' },
    });
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.data.error, 'user_exists');
  });

  it('rejects a wrong password and accepts the right one', async () => {
    await registerUser(gateway.base, 'b@test.local', 'password123');

    const bad = await api(gateway.base, '/api/auth/login', {
      method: 'POST',
      body: { email: 'b@test.local', password: 'wrongpassword' },
    });
    assert.equal(bad.status, 401);
    assert.equal(bad.data.error, 'invalid_credentials');

    const good = await api(gateway.base, '/api/auth/login', {
      method: 'POST',
      body: { email: 'b@test.local', password: 'password123' },
    });
    assert.equal(good.status, 200);
    assert.ok(good.data.token);
  });

  it('requires a password of at least 8 characters', async () => {
    const short = await api(gateway.base, '/api/auth/register', {
      method: 'POST',
      body: { email: 'short@test.local', password: 'short' },
    });
    assert.equal(short.status, 400);
  });

  it('rejects unauthenticated reads of every user-scoped collection', async () => {
    for (const path of ['/api/sessions', '/api/devices', '/api/providers', '/api/tasks/x/events']) {
      const response = await api(gateway.base, path);
      assert.equal(response.status, 401, `${path} must require auth`);
    }
  });
});

describe('device binding lifecycle', () => {
  let gateway;

  // A fresh gateway per case: these tests all contend for the single agent
  // slot, so sharing one instance would let a previous case's socket decide
  // whether the next case is admitted.
  beforeEach(async () => { gateway = await startGateway(); });
  afterEach(async () => { if (gateway) await gateway.stop(); });

  /** Connects, pairs, and returns the device token the gateway handed over. */
  async function pairDevice(deviceId) {
    const owner = await registerUser(gateway.base, `${deviceId}@test.local`);
    const first = await new FakeAgent(gateway.wsUrl, { deviceId, localProof: gateway.setupToken, autoReconnectOnBind: false }).connect();
    const renewed = await api(gateway.base, '/api/setup/pairing/renew', { method: 'POST', setupToken: gateway.setupToken });
    assert.equal(renewed.status, 200, 'pairing renew needs a live agent and the operator token');

    const authorized = await api(gateway.base, '/api/pairings/authorize', {
      method: 'POST',
      token: owner,
      body: { code: renewed.data.code },
    });
    assert.equal(authorized.status, 200);

    const deviceToken = await waitFor(() => first.deviceToken, 5_000);
    first.close();
    return { owner, first, deviceToken };
  }

  it('accepts the bound token on reconnect and rejects a wrong one', async () => {
    const { deviceToken } = await pairDevice('reconnect-agent');

    const ok = await new FakeAgent(gateway.wsUrl, { deviceId: 'reconnect-agent', token: deviceToken }).connect();
    try {
      await new Promise(resolve => setTimeout(resolve, 300));
      assert.equal(ok.socket.readyState, 1, 'correct token stays connected');
      assert.equal(ok.closed, undefined);
    } finally {
      ok.close();
    }

    const bad = await new FakeAgent(gateway.wsUrl, { deviceId: 'reconnect-agent', token: 'deadbeef'.repeat(8) }).connect();
    const closed = await waitFor(() => bad.closed, 5_000);
    assert.equal(closed.code, 1008);
    assert.match(closed.reason, /device_identity_invalid/);
  });

  it('supersedes the previous connection when the same device proves its token', async () => {
    await pairDevice('supersede-agent');
    // pairDevice closed the first socket; bind again for a live authenticated peer.
    const owner = await registerUser(gateway.base, 'supersede-2@test.local');
    const seed = await new FakeAgent(gateway.wsUrl, { deviceId: 'supersede-2', localProof: gateway.setupToken, autoReconnectOnBind: false }).connect();
    const renewed = await api(gateway.base, '/api/setup/pairing/renew', { method: 'POST', setupToken: gateway.setupToken });
    await api(gateway.base, '/api/pairings/authorize', { method: 'POST', token: owner, body: { code: renewed.data.code } });
    const deviceToken = await waitFor(() => seed.deviceToken, 5_000);

    const live = await new FakeAgent(gateway.wsUrl, { deviceId: 'supersede-2', token: deviceToken }).connect();
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(live.closed, undefined, 'authenticated peer is live');

    const replacement = await new FakeAgent(gateway.wsUrl, { deviceId: 'supersede-2', token: deviceToken }).connect();
    const superseded = await waitFor(() => live.closed, 5_000);
    assert.equal(superseded.code, 1000);
    assert.match(superseded.reason, /superseded_by_reconnect/);
    assert.equal(replacement.closed, undefined);

    seed.close();
    replacement.close();
  });

  it('refuses a different device id while another agent is live', async () => {
    await pairDevice('holder-agent');
    const owner = await registerUser(gateway.base, 'holder-2@test.local');
    const seed = await new FakeAgent(gateway.wsUrl, { deviceId: 'holder-2', localProof: gateway.setupToken, autoReconnectOnBind: false }).connect();
    const renewed = await api(gateway.base, '/api/setup/pairing/renew', { method: 'POST', setupToken: gateway.setupToken });
    await api(gateway.base, '/api/pairings/authorize', { method: 'POST', token: owner, body: { code: renewed.data.code } });
    const deviceToken = await waitFor(() => seed.deviceToken, 5_000);

    const live = await new FakeAgent(gateway.wsUrl, { deviceId: 'holder-2', token: deviceToken }).connect();
    await new Promise(resolve => setTimeout(resolve, 300));

    // A second, different device may NOT displace the authenticated agent,
    // even when it proves it runs locally.
    const intruder = await new FakeAgent(gateway.wsUrl, { deviceId: 'other-agent', localProof: gateway.setupToken }).connect();
    const refused = await waitFor(() => intruder.closed, 5_000);
    assert.equal(refused.code, 1008);
    assert.match(refused.reason, /agent_already_connected/);
    assert.equal(live.closed, undefined, 'the authenticated agent survives');

    seed.close();
    live.close();
  });

  it('disconnects a revoked device and invalidates its token', async () => {
    const { owner, deviceToken } = await pairDevice('revoke-agent');
    const live = await new FakeAgent(gateway.wsUrl, { deviceId: 'revoke-agent', token: deviceToken }).connect();
    await new Promise(resolve => setTimeout(resolve, 300));

    const devices = await api(gateway.base, '/api/devices', { token: owner });
    const device = devices.data.find(item => item.id === 'revoke-agent');
    assert.ok(device, 'the owner sees the bound device');
    assert.equal(device.online, true);

    const revoked = await api(gateway.base, `/api/devices/${device.id}/revoke`, { method: 'POST', token: owner });
    assert.equal(revoked.status, 200);

    const closed = await waitFor(() => live.closed, 5_000);
    assert.equal(closed.code, 1008, 'a revoked agent is dropped immediately');
    assert.match(closed.reason, /device_revoked/);

    const reuse = await new FakeAgent(gateway.wsUrl, { deviceId: 'revoke-agent', token: deviceToken }).connect();
    const refused = await waitFor(() => reuse.closed, 5_000);
    assert.equal(refused.code, 1008, 'the revoked token no longer authenticates');
  });
});

describe('pairing codes and persistence', () => {
  let gateway;

  before(async () => { gateway = await startGateway(); });
  after(async () => { if (gateway) await gateway.stop(); });

  it('invalidates a superseded code and accepts the current one exactly once', async () => {
    const owner = await registerUser(gateway.base, 'expiry@test.local');
    const agent = await new FakeAgent(gateway.wsUrl, { deviceId: 'expiry-agent', localProof: gateway.setupToken }).connect();
    try {
      const first = (await api(gateway.base, '/api/setup/pairing/renew', { method: 'POST', setupToken: gateway.setupToken })).data.code;
      const second = (await api(gateway.base, '/api/setup/pairing/renew', { method: 'POST', setupToken: gateway.setupToken })).data.code;
      assert.notEqual(first, second);

      const stale = await api(gateway.base, '/api/pairings/authorize', { method: 'POST', token: owner, body: { code: first } });
      assert.equal(stale.status, 401, 'a superseded code must be rejected');

      const ok = await api(gateway.base, '/api/pairings/authorize', { method: 'POST', token: owner, body: { code: second } });
      assert.equal(ok.status, 200);

      const replay = await api(gateway.base, '/api/pairings/authorize', { method: 'POST', token: owner, body: { code: second } });
      assert.equal(replay.status, 401, 'pairing codes are single use');
    } finally {
      agent.close();
    }
  });

  it('keeps device identity across a gateway restart', async () => {
    const owner = await registerUser(gateway.base, 'persist@test.local');
    const first = await new FakeAgent(gateway.wsUrl, { deviceId: 'persist-agent', localProof: gateway.setupToken, autoReconnectOnBind: false }).connect();
    const renewed = await api(gateway.base, '/api/setup/pairing/renew', { method: 'POST', setupToken: gateway.setupToken });
    await api(gateway.base, '/api/pairings/authorize', { method: 'POST', token: owner, body: { code: renewed.data.code } });
    const deviceToken = await waitFor(() => first.deviceToken, 5_000);
    first.close();

    const statePath = join(gateway.dataDir, 'state.json');
    assert.ok(existsSync(statePath), 'state.json lives in the data directory');
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    assert.ok(state.devices.some(([id]) => id === 'persist-agent'));
    assert.ok(!JSON.stringify(state).includes(deviceToken), 'the raw device token is never persisted');

    // Restart against the same data directory.
    await gateway.stop({ keepDataDir: true });
    gateway = await startGateway({ dataDir: gateway.dataDir });

    const reconnected = await new FakeAgent(gateway.wsUrl, { deviceId: 'persist-agent', token: deviceToken }).connect();
    await new Promise(resolve => setTimeout(resolve, 400));
    assert.equal(reconnected.closed, undefined, 'device identity survives a restart');
    reconnected.close();
  });
});
