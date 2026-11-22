import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { api, newKeyPair, pairDevice, registerUser, startGateway, waitFor } from './support.mjs';

describe('bound device authorization', () => {
  let gateway;
  let owner;
  let other;
  let agent;
  let sessionId;
  const keyPair = newKeyPair();
  const deviceId = 'authorization-agent';
  const req = (path, method, token = owner, body) => api(gateway.base, path, { method, token, body });

  before(async () => {
    gateway = await startGateway();
    owner = await registerUser(gateway.base, 'device-owner@test.local');
    other = await registerUser(gateway.base, 'other-account@test.local');
    ({ agent } = await pairDevice(gateway, owner, { deviceId, keyPair }));
    const created = await req('/api/sessions', 'POST', owner, { provider_id: 'local' });
    assert.equal(created.status, 200);
    sessionId = created.data.session.id;
  });

  after(async () => {
    agent?.close();
    await gateway?.stop();
  });

  it('keeps commands and the live Provider catalog scoped to the device owner', async () => {
    const before = agent.tasks.length;
    assert.equal((await req('/api/sessions', 'POST', other, { provider_id: 'local' })).status, 403);
    assert.equal((await req('/api/tasks', 'POST', other, { task_id: 'non-owner', input: '现在几点' })).status, 403);
    assert.deepEqual((await req('/api/providers', 'GET', other)).data, []);
    assert.equal((await req('/api/providers', 'GET')).data[0].id, 'local');
    assert.equal(agent.tasks.length, before);
    const renew = await api(gateway.base, '/api/setup/pairing/renew', { method: 'POST', setupToken: gateway.setupToken });
    assert.equal(renew.data.error, 'device_already_bound');
  });

  it('records one authorized completion and does not duplicate session messages', async () => {
    const taskId = 'single-completion';
    const response = await req('/api/tasks', 'POST', owner, { task_id: taskId, input: '现在几点', session_id: sessionId });
    assert.equal(response.status, 200);
    await waitFor(() => agent.tasks.some(task => task.task_id === taskId));
    const result = { task_id: taskId, session_id: sessionId, provider_id: 'local', state: 'succeeded', message: '任务完成（测试）' };
    agent.send('task.event', result);
    agent.send('task.event', result);
    await waitFor(async () => (await req(`/api/tasks/${taskId}/events`, 'GET')).data.at(-1)?.state === 'succeeded');
    assert.equal((await req(`/api/tasks/${taskId}/events`, 'GET')).data.filter(event => event.state === 'succeeded').length, 1);
    assert.equal((await req(`/api/sessions/${sessionId}/messages`, 'GET')).data.filter(message => message.role === 'assistant').length, 1);
  });

  it('does not allow an old confirmation to carry over into a new device binding', async () => {
    const taskId = 'held-before-revocation';
    const task = await req('/api/tasks', 'POST', owner, { task_id: taskId, kind: 'shell', input: '不执行的测试夹具', session_id: sessionId });
    assert.equal(task.data.requires_confirmation, true);
    assert.equal((await req(`/api/devices/${deviceId}/revoke`, 'POST')).status, 200);
    await agent.closed;
    ({ agent } = await pairDevice(gateway, owner, { deviceId, keyPair }));
    const confirmation = await req(`/api/tasks/${taskId}/confirm`, 'POST');
    assert.equal(confirmation.status, 409);
    const result = await req(`/api/tasks/${taskId}`, 'GET');
    assert.equal(result.data.state, 'cancelled');
    assert.match(result.data.message, /device_revoked/);
    assert.equal(agent.tasks.length, 0);
  });
});
