// End-to-end happy path plus the task-event ownership rule:
// pair -> bind -> create session -> run task -> read events.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { api, FakeAgent, registerUser, startGateway, waitFor } from './helpers.mjs';

describe('pairing and task loop', () => {
  let gateway;
  let agent;
  let ownerToken;
  let otherToken;

  before(async () => {
    gateway = await startGateway();
    ownerToken = await registerUser(gateway.base, 'owner@test.local');
    otherToken = await registerUser(gateway.base, 'intruder@test.local');
    agent = await new FakeAgent(gateway.wsUrl, { deviceId: 'paired-agent', localProof: gateway.setupToken }).connect();
  });

  after(async () => {
    agent?.close();
    if (gateway) await gateway.stop();
  });

  it('issues a pairing code from the local setup API only', async () => {
    const status = await api(gateway.base, '/api/setup/status', { setupToken: gateway.setupToken });
    assert.equal(status.status, 200);
    assert.equal(status.data.agent.online, true);
    assert.equal(status.data.pairing, undefined, 'no code should exist before renewal');

    const renewed = await api(gateway.base, '/api/setup/pairing/renew', { method: 'POST', setupToken: gateway.setupToken });
    assert.equal(renewed.status, 200);
    assert.match(String(renewed.data.code), /^\d{6}$/);
    assert.equal(renewed.data.expires_in, 60);
  });

  it('binds the device and hands the token to the connected agent', async () => {
    const code = (await api(gateway.base, '/api/setup/status', { setupToken: gateway.setupToken })).data.pairing.code;
    const authorized = await api(gateway.base, '/api/pairings/authorize', { method: 'POST', token: ownerToken, body: { code } });
    assert.equal(authorized.status, 200);
    assert.equal(authorized.data.authorized, true);
    assert.equal(authorized.data.device.id, 'paired-agent');

    const token = await waitFor(() => agent.deviceToken, 15_000);
    assert.match(token, /^[0-9a-f]{64}$/, 'agent should receive a fresh device token');

    // A bound agent must reconnect with the token before it can be trusted.
    await waitFor(() => agent.reconnectCount > 0 && agent.socket?.readyState === 1, 15_000);
    await new Promise(resolve => setTimeout(resolve, 200));

    // Pairing codes are single use.
    const replay = await api(gateway.base, '/api/pairings/authorize', { method: 'POST', token: ownerToken, body: { code } });
    assert.equal(replay.status, 401);

    const devices = await api(gateway.base, '/api/devices', { token: ownerToken });
    assert.equal(devices.data.length, 1);
    assert.equal(devices.data[0].online, true);
  });

  it('runs a task through to success and records it in the session', async () => {
    const session = await api(gateway.base, '/api/sessions', { method: 'POST', token: ownerToken, body: { provider_id: 'local', title: 'smoke' } });
    assert.equal(session.status, 200);
    const sessionId = session.data.session.id;

    const taskId = 'task-e2e-1';
    const accepted = await api(gateway.base, '/api/tasks', {
      method: 'POST',
      token: ownerToken,
      body: { task_id: taskId, input: '现在几点', provider_id: 'local', session_id: sessionId, mode: 'isolated' },
    });
    assert.equal(accepted.status, 200);
    assert.equal(accepted.data.accepted, true);

    const events = await waitFor(async () => {
      const response = await api(gateway.base, `/api/tasks/${taskId}/events`, { token: ownerToken });
      return response.data?.some(event => event.state === 'succeeded') ? response.data : undefined;
    }, 10_000);
    assert.deepEqual(events.map(event => event.state), ['queued', 'running', 'succeeded']);

    const messages = await api(gateway.base, `/api/sessions/${sessionId}/messages`, { token: ownerToken });
    assert.equal(messages.data.length, 2);
    assert.equal(messages.data[0].role, 'user');
    assert.equal(messages.data[1].role, 'assistant');
    assert.match(messages.data[1].content, /echo: 现在几点/);
  });

  it('hides task events from other users', async () => {
    const forbidden = await api(gateway.base, '/api/tasks/task-e2e-1/events', { token: otherToken });
    assert.equal(forbidden.status, 403);
    assert.equal(forbidden.data.error, 'forbidden');
  });
});
