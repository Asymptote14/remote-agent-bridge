// Security regression tests: these lock in the behaviours added during the
// 2026-09-17 / 2026-09-21 hardening rounds.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { api, FakeAgent, registerUser, startGateway, waitFor } from './helpers.mjs';

describe('gateway security surface', () => {
  let gateway;
  let token;

  before(async () => {
    gateway = await startGateway();
    token = await registerUser(gateway.base, 'security@test.local');
  });

  after(async () => {
    if (gateway) await gateway.stop();
  });

  it('sets hardening headers on every response', async () => {
    const { headers } = await api(gateway.base, '/health');
    assert.match(headers.get('content-security-policy') ?? '', /default-src 'self'/);
    assert.equal(headers.get('x-content-type-options'), 'nosniff');
    assert.equal(headers.get('x-frame-options'), 'DENY');
    assert.equal(headers.get('referrer-policy'), 'no-referrer');
  });

  it('rejects unauthenticated API calls with 401', async () => {
    for (const path of ['/api/sessions', '/api/devices', '/api/providers']) {
      const response = await api(gateway.base, path);
      assert.equal(response.status, 401, `${path} should require auth`);
    }
  });

  it('returns 404 for unknown task events instead of an empty list', async () => {
    const response = await api(gateway.base, '/api/tasks/does-not-exist/events', { token });
    assert.equal(response.status, 404);
    assert.equal(response.data.error, 'task_not_found');
  });

  it('closes sockets that send a hello without a device id', async () => {
    const agent = new FakeAgent(gateway.wsUrl, { deviceId: '' });
    await agent.connect();
    const closed = await waitFor(() => agent.closed, 5_000);
    assert.equal(closed.code, 1008);
    assert.match(closed.reason, /device_identity_invalid/);
  });

  it('keeps an unbound agent blind and refuses to route work to it', async () => {
    // A peer that cannot read this machine's data dir is refused outright.
    const agent = await new FakeAgent(gateway.wsUrl, { deviceId: 'unbound-agent', localProof: gateway.setupToken }).connect();
    try {
      // The gateway must not push session commands or tasks to an unbound peer,
      // and user-facing calls must fail loudly rather than silently queuing.
      const session = await api(gateway.base, '/api/sessions', { method: 'POST', token, body: { provider_id: 'local' } });
      assert.equal(session.status, 503);
      assert.equal(session.data.error, 'agent_offline');

      await new Promise(resolve => setTimeout(resolve, 800));
      assert.deepEqual(agent.inbound(), [], 'unbound agent received data from the gateway');
    } finally {
      agent.close();
    }
  });
});
