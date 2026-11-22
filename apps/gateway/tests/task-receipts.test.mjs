import assert from 'node:assert/strict';
import { mkdirSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { api, DeviceClient, newKeyPair, pairDevice, registerUser, startGateway, waitFor } from './support.mjs';

async function fixture(context) {
  const current = { gateway: await startGateway(), agent: undefined };
  context.after(async () => {
    current.agent?.close();
    await current.gateway.stop();
  });
  const options = { deviceId: 'receipt-agent', keyPair: newKeyPair(), receipts: true };
  const owner = await registerUser(current.gateway.base, 'receipt-owner@test.local');
  ({ agent: current.agent } = await pairDevice(current.gateway, owner, options));
  await current.agent.waitFor('agent.ready');
  const request = (path, init) => api(current.gateway.base, path, { token: owner, ...init });
  const created = await request('/api/sessions', { method: 'POST', body: { provider_id: 'local', title: '测试柜台' } });
  assert.equal(created.status, 200);
  const sessionId = created.data.session.id;
  return Object.assign(current, {
    options, sessionId, request,
    body: taskId => ({ task_id: taskId, session_id: sessionId, provider_id: 'local', input: '现在几点' }),
    submit: body => request('/api/tasks', { method: 'POST', body }),
    async state(taskId) { return (await request(`/api/tasks/${taskId}`)).data.state; },
    async restartGateway() {
      const dir = current.gateway.dir;
      current.agent.close();
      await current.gateway.stop({ keepData: true });
      current.gateway = await startGateway({ dir });
      current.agent = await new DeviceClient(current.gateway.wsUrl, options).connect();
      await current.agent.handshake();
      return (await current.agent.waitFor('agent.ready')).payload;
    },
  });
}

function findAck(current, id, sequence) {
  return current.agent.messages.find(frame => frame.type === 'task.ack' && frame.payload.task_id === id && frame.payload.sequence === sequence);
}

test('does not dispatch or acknowledge a change that could not be saved', async context => {
  const current = await fixture(context);
  const id = 'write-failure';
  const body = current.body(id);
  const temporary = join(current.gateway.dir, 'state.json.tmp');
  mkdirSync(temporary);
  try {
    const rejected = await current.submit(body);
    assert.equal(rejected.status, 503);
    assert.equal(rejected.data.error, 'state_write_failed');
    assert.equal((await current.request(`/api/tasks/${id}`)).status, 404);
    assert.equal(current.agent.tasks.length, 0);
    assert.deepEqual((await current.request(`/api/sessions/${current.sessionId}/messages`)).data, []);
  } finally { rmdirSync(temporary); }

  assert.equal((await current.submit(body)).status, 200);
  const task = await waitFor(() => current.agent.tasks.find(item => item.task_id === id));
  await waitFor(() => findAck(current, id, 1));
  const conflict = await current.submit({ ...body, input: '系统信息' });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.data.error, 'task_id_conflict');
  assert.equal(current.agent.tasks.length, 1);

  mkdirSync(temporary);
  try {
    current.agent.report(task, 'succeeded', '已完成', 2);
    await waitFor(() => current.gateway.output.includes('no acknowledgement sent'));
    assert.equal(findAck(current, id, 2), undefined);
    assert.equal(await current.state(id), 'queued');
  } finally { rmdirSync(temporary); }
  current.agent.report(task, 'succeeded', '已完成', 2);
  await waitFor(() => findAck(current, id, 2));
  assert.equal((await current.submit(body)).data.duplicate, true);
  assert.equal(current.agent.tasks.length, 1);
  const dashboard = (await current.request('/api/dashboard')).data;
  assert.deepEqual(dashboard.selected.messages.map(message => [message.role, message.task_id]), [['user', id], ['assistant', id]]);
  assert.equal(dashboard.selected.tasks[0].message, '', 'dashboard does not repeat the assistant message in its task card');
});

test('reconciles by reference after a restart and never re-dispatches the payload', async context => {
  const current = await fixture(context);
  const id = 'running-before-restart';
  const body = current.body(id);
  await current.submit(body);
  const task = await waitFor(() => current.agent.tasks.find(item => item.task_id === id));
  current.agent.report(task, 'running', '正在运行', 2);
  await waitFor(() => findAck(current, id, 2));
  const ready = await current.restartGateway();
  assert.deepEqual(ready.tasks, [{ task_id: id, dispatch_id: task.dispatch_id, cancel_requested: false }]);
  assert.equal(await current.state(id), 'running');

  current.agent.report({ ...task, dispatch_id: 'unrelated-dispatch' }, 'succeeded', '无关结果', 3);
  current.agent.report(task, 'queued', '旧状态', 1);
  await waitFor(() => findAck(current, id, 1));
  assert.equal(await current.state(id), 'running');
  assert.equal(findAck(current, id, 3), undefined);

  current.agent.report(task, 'succeeded', '电脑已完成', 3);
  current.agent.report(task, 'succeeded', '电脑已完成', 3);
  current.agent.report(task, 'running', '迟到的状态', 4);
  await waitFor(() => findAck(current, id, 4));
  assert.equal((await current.submit(body)).data.state, 'succeeded');
  assert.equal(current.agent.tasks.length, 0);
  const history = (await current.request(`/api/sessions/${current.sessionId}/messages`)).data;
  assert.deepEqual(history.map(message => message.content), [body.input, '电脑已完成']);
});

test('keeps cancellation across reconnect and records a missing receipt as unknown', async context => {
  const current = await fixture(context);
  const other = await registerUser(current.gateway.base, 'receipt-other@test.local');
  const id = 'missing-after-reconnect';
  await current.submit(current.body(id));
  const task = await waitFor(() => current.agent.tasks.find(item => item.task_id === id));
  assert.equal((await current.request(`/api/sessions/${current.sessionId}`, { method: 'DELETE' })).status, 409);
  const path = `/api/tasks/${id}/cancel`;
  assert.equal((await current.request(path, { method: 'POST', token: other })).status, 403);
  assert.equal((await current.request(path, { method: 'POST' })).data.state, 'cancel_requested');
  await current.agent.waitFor('agent.task.cancel');
  const ready = await current.restartGateway();
  const ref = { task_id: id, dispatch_id: task.dispatch_id };
  assert.deepEqual(ready.tasks, [{ ...ref, cancel_requested: true }]);
  current.agent.send('task.missing', ref);
  await waitFor(() => findAck(current, id, 0));
  assert.equal((await current.request(path, { method: 'POST' })).data.state, 'outcome_unknown');
  assert.equal(current.agent.tasks.length, 0);
});

test('returns one owner-scoped, conditional dashboard snapshot with recoverable confirmations', async context => {
  const current = await fixture(context);
  const other = await registerUser(current.gateway.base, 'dashboard-other@test.local');
  const body = { ...current.body('held-for-confirmation'), kind: 'shell', input: '仅为确认流程的测试文本' };
  assert.equal((await current.submit(body)).data.state, 'awaiting_confirmation');
  const dashboard = await current.request('/api/dashboard');
  assert.equal(dashboard.data.device.status, 'online');
  assert.equal(dashboard.data.device.id, current.options.deviceId);
  assert.equal(dashboard.data.sessions[0].awaiting, 1);
  assert.equal(dashboard.data.selected.tasks[0].confirmation_input, body.input);
  assert.ok(dashboard.data.selected.tasks[0].confirmation_expires_at > Date.now());
  assert.equal(dashboard.headers.get('cache-control'), 'no-store');
  const headers = { 'if-none-match': dashboard.headers.get('etag') };
  assert.equal((await current.request('/api/dashboard', { headers })).status, 304);
  assert.equal((await current.request('/api/dashboard', { headers, token: '' })).status, 401);
  const isolated = await current.request(`/api/dashboard?session_id=${current.sessionId}`, { headers, token: other });
  assert.equal(isolated.data.selected, null);
  assert.deepEqual(isolated.data.device, { status: 'unpaired' });
  assert.deepEqual(isolated.data.sessions, []);
  assert.deepEqual(isolated.data.providers, []);
  assert.equal((await current.request(`/api/tasks/${body.task_id}/deny`, { method: 'POST' })).data.state, 'cancelled');
  const denied = await current.request('/api/dashboard', { headers });
  assert.equal(denied.status, 200);
  assert.equal(denied.data.selected.tasks[0].state, 'cancelled');
  assert.equal(denied.data.selected.tasks[0].confirmation_input, undefined);
  assert.equal(current.agent.tasks.length, 0);
});

test('does not write the setup URL query to Gateway logs', async context => {
  const gateway = await startGateway();
  context.after(() => gateway.stop());
  const response = await api(gateway.base, '/setup?token=fixture-query-must-not-be-logged');
  assert.equal(response.status, 200);
  await waitFor(() => gateway.output.includes('"path":"/setup"'));
  assert.doesNotMatch(gateway.output, /fixture-query-must-not-be-logged/);
});
