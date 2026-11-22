// High-risk tasks stop at the Gateway and wait for the phone.
//
// The property that matters: between "user typed it" and "user confirmed it",
// the Agent receives nothing at all. A task that is denied, or that times out,
// must never have been dispatched.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { api, DeviceClient, newKeyPair, pairDevice, registerUser, startGateway, waitFor } from './support.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

describe('high-risk task confirmation', () => {
  let gateway;
  let ownerToken;
  let otherToken;
  let agent;
  let sessionId;

  const submit = (text, { id = randomUUID(), token = ownerToken, session = sessionId } = {}) => api(gateway.base, '/api/tasks', {
    method: 'POST',
    token,
    body: { task_id: id, input: text, provider_id: 'local', session_id: session, mode: 'isolated' },
  });
  const events = async (id, token = ownerToken) => (await api(gateway.base, `/api/tasks/${id}/events`, { token })).data;
  const dispatched = id => agent.tasks.some(task => task.task_id === id);

  before(async () => {
    gateway = await startGateway();
    ownerToken = await registerUser(gateway.base, 'owner@confirm.test');
    otherToken = await registerUser(gateway.base, 'other@confirm.test');
    const paired = await pairDevice(gateway, ownerToken, { deviceId: 'confirm-agent', keyPair: newKeyPair() });
    agent = paired.agent;
    const created = await api(gateway.base, '/api/sessions', { method: 'POST', token: ownerToken, body: { provider_id: 'local' } });
    assert.equal(created.status, 200);
    sessionId = created.data.session.id;
  });

  after(async () => {
    agent?.close();
    if (gateway) await gateway.stop();
  });

  it('holds a destructive task instead of dispatching it', async () => {
    const id = randomUUID();
    const posted = await submit('帮我删除 D 盘上的所有文件，然后清空回收站', { id });
    assert.equal(posted.status, 200);
    assert.equal(posted.data.requires_confirmation, true);
    assert.equal(posted.data.state, 'awaiting_confirmation');
    assert.ok(posted.data.reasons.some(reason => reason.includes('删除')), 'the reason must name the danger');

    const held = await events(id);
    assert.equal(held.length, 1);
    assert.equal(held[0].state, 'awaiting_confirmation');
    assert.equal(held[0].risk, 'high');

    // The load-bearing assertion: the Agent never saw it.
    await sleep(400);
    assert.equal(dispatched(id), false, 'an unconfirmed task must not reach the Agent');

    const summary = await api(gateway.base, '/api/tasks', { token: ownerToken });
    assert.equal(summary.data.find(task => task.task_id === id).state, 'awaiting_confirmation');

    // And the user's message is not in the session yet, because nothing ran.
    const messages = await api(gateway.base, `/api/sessions/${sessionId}/messages`, { token: ownerToken });
    assert.equal(messages.data.some(message => message.content.includes('删除 D 盘')), false);
  });

  it('does not treat a retried POST as an approval', async () => {
    const id = randomUUID();
    await submit('格式化这台电脑的系统盘', { id });
    const retry = await submit('格式化这台电脑的系统盘', { id });
    assert.equal(retry.data.duplicate, true);
    assert.equal(retry.data.requires_confirmation, true);
    await sleep(300);
    assert.equal(dispatched(id), false);
  });

  it('dispatches only after the owner confirms, then records the result', async () => {
    const id = randomUUID();
    const text = '卸载这台电脑上的杀毒软件';
    const posted = await submit(text, { id });
    assert.equal(posted.data.requires_confirmation, true);
    assert.equal(dispatched(id), false);

    const confirmed = await api(gateway.base, `/api/tasks/${id}/confirm`, { method: 'POST', token: ownerToken });
    assert.equal(confirmed.status, 200);
    assert.equal(confirmed.data.confirmed, true);

    await waitFor(() => dispatched(id), 5_000, 'task dispatched after confirmation');
    // The user's turn is appended at dispatch time, exactly once.
    const messages = await api(gateway.base, `/api/sessions/${sessionId}/messages`, { token: ownerToken });
    assert.equal(messages.data.filter(message => message.content === text).length, 1);

    agent.send('task.event', { task_id: id, state: 'succeeded', message: '已完成（测试）', provider_id: 'local', session_id: sessionId });
    await waitFor(async () => (await events(id)).at(-1)?.state === 'succeeded', 5_000, 'task succeeded');

    // A second confirmation is a conflict, not a second run.
    const again = await api(gateway.base, `/api/tasks/${id}/confirm`, { method: 'POST', token: ownerToken });
    assert.equal(again.status, 409);
  });

  it('cancels on deny without ever dispatching', async () => {
    const id = randomUUID();
    const posted = await submit('把这台电脑关机', { id });
    assert.equal(posted.data.requires_confirmation, true);

    const denied = await api(gateway.base, `/api/tasks/${id}/deny`, { method: 'POST', token: ownerToken });
    assert.equal(denied.status, 200);
    assert.equal(denied.data.state, 'cancelled');

    const last = (await events(id)).at(-1);
    assert.equal(last.state, 'cancelled');
    await sleep(300);
    assert.equal(dispatched(id), false);
  });

  it('lets only the task owner confirm it', async () => {
    const id = randomUUID();
    // No session id: the other account has no access to the owner's session.
    const posted = await submit('删除整个项目目录', { id, session: undefined });
    assert.equal(posted.data.requires_confirmation, true);

    const strangerConfirm = await api(gateway.base, `/api/tasks/${id}/confirm`, { method: 'POST', token: otherToken });
    assert.equal(strangerConfirm.status, 403);
    const strangerDeny = await api(gateway.base, `/api/tasks/${id}/deny`, { method: 'POST', token: otherToken });
    assert.equal(strangerDeny.status, 403);
    const strangerEvents = await api(gateway.base, `/api/tasks/${id}/events`, { token: otherToken });
    assert.equal(strangerEvents.status, 403);

    // Still held, still not dispatched.
    assert.equal(dispatched(id), false);
  });

  it('dispatches an ordinary task without asking', async () => {
    const id = randomUUID();
    const posted = await submit('看一下当前工作目录有哪些文件', { id });
    assert.equal(posted.status, 200);
    assert.equal(posted.data.requires_confirmation, undefined);
    await waitFor(() => dispatched(id), 5_000, 'low-risk task dispatched immediately');
  });
});
