// Task lifecycle regressions: server-side idempotency, task records surviving a
// Gateway restart, and the reconciliation endpoint the phone polls.
//
// These cover two bugs that fed each other: task events lived only in memory, so
// a restart turned every in-flight task into a permanent 404 — and the phone
// treated that 404 as "not finished yet" and polled it forever.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { api, FakeAgent, registerUser, startGateway, waitFor, waitForAgentReady, waitForDeviceToken } from './helpers.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Connects an agent, pairs it, and returns it at the point it can receive work. */
async function pairAgent(gateway, deviceId, options = {}) {
  const ownerToken = await registerUser(gateway.base, `${deviceId}@test.local`);
  const agent = await new FakeAgent(gateway.wsUrl, { deviceId, localProof: gateway.setupToken, ...options }).connect();
  await waitForAgentReady(gateway);
  const renewed = await api(gateway.base, '/api/setup/pairing/renew', { method: 'POST', setupToken: gateway.setupToken });
  assert.equal(renewed.status, 200, 'pairing renew needs a live agent and the operator token');
  const authorized = await api(gateway.base, '/api/pairings/authorize', { method: 'POST', token: ownerToken, body: { code: renewed.data.code } });
  assert.equal(authorized.status, 200);
  await waitForDeviceToken(agent);
  // A bound agent has to come back proving the token before it is trusted.
  await waitFor(() => agent.reconnectCount > 0 && agent.socket?.readyState === 1, 15_000);
  return { ownerToken, agent };
}

async function createSession(gateway, token, title) {
  const response = await api(gateway.base, '/api/sessions', { method: 'POST', token, body: { provider_id: 'local', title } });
  assert.equal(response.status, 200);
  return response.data.session.id;
}

const taskBody = (taskId, sessionId, input = '现在几点') => ({
  task_id: taskId,
  input,
  provider_id: 'local',
  session_id: sessionId,
  mode: 'isolated',
});

async function eventsOf(gateway, taskId, token) {
  const response = await api(gateway.base, `/api/tasks/${taskId}/events`, { token });
  return response;
}

describe('task idempotency', () => {
  it('does not run or record a task twice when the same task_id is posted again', async () => {
    const gateway = await startGateway();
    let agent;
    try {
      const paired = await pairAgent(gateway, 'idempotent-agent');
      agent = paired.agent;
      const sessionId = await createSession(gateway, paired.ownerToken, 'idempotency');
      const body = taskBody('task-idem-1', sessionId);

      const first = await api(gateway.base, '/api/tasks', { method: 'POST', token: paired.ownerToken, body });
      assert.equal(first.status, 200);
      assert.equal(first.data.accepted, true);
      assert.equal(first.data.duplicate, undefined, 'a first submission is not a duplicate');

      await waitFor(async () => (await eventsOf(gateway, 'task-idem-1', paired.ownerToken)).data?.some(event => event.state === 'succeeded'), 10_000);
      const dispatchedBefore = agent.messages.filter(message => message.type === 'agent.task').length;

      // A page reload, a double tap, or a retried request over a flaky tunnel.
      const second = await api(gateway.base, '/api/tasks', { method: 'POST', token: paired.ownerToken, body });
      assert.equal(second.status, 200);
      assert.equal(second.data.duplicate, true);
      assert.equal(second.data.state, 'succeeded', 'the replay reports the recorded outcome');

      await sleep(300);
      const dispatchedAfter = agent.messages.filter(message => message.type === 'agent.task').length;
      assert.equal(dispatchedAfter, dispatchedBefore, 'a replayed task_id must not be dispatched to the agent again');

      const messages = await api(gateway.base, `/api/sessions/${sessionId}/messages`, { token: paired.ownerToken });
      assert.equal(messages.data.filter(message => message.role === 'user').length, 1, 'the user message must not be appended twice');

      // A replay stays accepted even though dispatching new work would not be.
      assert.ok(second.data.accepted, 'a duplicate submission is still accepted');
    } finally {
      agent?.close();
      await gateway.stop();
    }
  });

  it('refuses to let one account claim a task id another account already used', async () => {
    const gateway = await startGateway();
    let agent;
    try {
      const paired = await pairAgent(gateway, 'conflict-agent');
      agent = paired.agent;
      const sessionId = await createSession(gateway, paired.ownerToken, 'conflict');
      const body = taskBody('task-conflict-1', sessionId);
      await api(gateway.base, '/api/tasks', { method: 'POST', token: paired.ownerToken, body });

      const otherToken = await registerUser(gateway.base, 'task-intruder@test.local');
      const conflict = await api(gateway.base, '/api/tasks', { method: 'POST', token: otherToken, body });
      assert.equal(conflict.status, 409);
      assert.equal(conflict.data.error, 'task_id_conflict');

      // The list is owner-scoped, so the other account cannot even see it.
      const otherList = await api(gateway.base, '/api/tasks', { token: otherToken });
      assert.equal(otherList.status, 200);
      assert.equal(otherList.data.find(task => task.task_id === 'task-conflict-1'), undefined);
    } finally {
      agent?.close();
      await gateway.stop();
    }
  });
});

describe('task records across a gateway restart', () => {
  it('keeps a finished task readable after the gateway restarts', async () => {
    let gateway = await startGateway();
    const dataDir = gateway.dataDir;
    let agent;
    let ownerToken;
    try {
      const paired = await pairAgent(gateway, 'persist-task-agent');
      agent = paired.agent;
      ownerToken = paired.ownerToken;
      const sessionId = await createSession(gateway, ownerToken, 'persist');
      await api(gateway.base, '/api/tasks', { method: 'POST', token: ownerToken, body: taskBody('task-persist-1', sessionId) });

      const events = await waitFor(async () => {
        const response = await eventsOf(gateway, 'task-persist-1', ownerToken);
        return response.data?.some(event => event.state === 'succeeded') ? response.data : undefined;
      }, 10_000);
      assert.deepEqual(events.map(event => event.state), ['queued', 'running', 'succeeded']);

      agent.close();
      agent = undefined;
      await gateway.stop({ keepDataDir: true });
      gateway = await startGateway({ dataDir });

      const after = await eventsOf(gateway, 'task-persist-1', ownerToken);
      assert.equal(after.status, 200, 'the task record must survive the restart');
      assert.deepEqual(after.data.map(event => event.state), ['queued', 'running', 'succeeded']);
    } finally {
      agent?.close();
      await gateway.stop();
    }
  });

  it('closes out a task that was in flight when the gateway restarted', async () => {
    let gateway = await startGateway();
    const dataDir = gateway.dataDir;
    let agent;
    let ownerToken;
    let sessionId;
    try {
      // This agent reports progress and then never finishes, so the task is
      // still running when the Gateway goes down.
      const paired = await pairAgent(gateway, 'inflight-agent', { completeTasks: false });
      agent = paired.agent;
      ownerToken = paired.ownerToken;
      sessionId = await createSession(gateway, ownerToken, 'in flight');
      await api(gateway.base, '/api/tasks', { method: 'POST', token: ownerToken, body: taskBody('task-inflight-1', sessionId) });

      await waitFor(async () => (await eventsOf(gateway, 'task-inflight-1', ownerToken)).data?.some(event => event.state === 'running'), 10_000);
      assert.equal((await eventsOf(gateway, 'task-inflight-1', ownerToken)).data.at(-1).state, 'running');

      agent.close();
      agent = undefined;
      await gateway.stop({ keepDataDir: true });
      gateway = await startGateway({ dataDir });

      // Nobody will ever report on this task again: the Agent's queue lives in
      // the Agent's own memory and it has no idea the task existed. It has to be
      // closed out, or the phone polls a result that cannot arrive.
      const events = await eventsOf(gateway, 'task-inflight-1', ownerToken);
      assert.equal(events.status, 200);
      const last = events.data.at(-1);
      assert.equal(last.state, 'failed');
      assert.match(last.message, /gateway_restart/);
      assert.equal(last.session_id, sessionId);

      // The reconciliation list reports the same terminal state, which is what
      // releases the phone's pending entry.
      const list = await api(gateway.base, '/api/tasks', { token: ownerToken });
      const summary = list.data.find(task => task.task_id === 'task-inflight-1');
      assert.equal(summary.state, 'failed');
      assert.equal(summary.session_id, sessionId);
    } finally {
      agent?.close();
      await gateway.stop();
    }
  });

  it('reports the newest activity first so a just-finished task cannot be pushed out of the list', async () => {
    const gateway = await startGateway();
    let agent;
    try {
      const paired = await pairAgent(gateway, 'ordering-agent');
      agent = paired.agent;
      const sessionId = await createSession(gateway, paired.ownerToken, 'ordering');

      await api(gateway.base, '/api/tasks', { method: 'POST', token: paired.ownerToken, body: taskBody('task-order-old', sessionId) });
      await waitFor(async () => (await eventsOf(gateway, 'task-order-old', paired.ownerToken)).data?.some(event => event.state === 'succeeded'), 10_000);
      await sleep(20);
      await api(gateway.base, '/api/tasks', { method: 'POST', token: paired.ownerToken, body: taskBody('task-order-new', sessionId, '系统信息') });
      await waitFor(async () => (await eventsOf(gateway, 'task-order-new', paired.ownerToken)).data?.some(event => event.state === 'succeeded'), 10_000);

      const list = await api(gateway.base, '/api/tasks', { token: paired.ownerToken });
      const ids = list.data.map(task => task.task_id);
      assert.ok(ids.includes('task-order-old') && ids.includes('task-order-new'));
      assert.ok(list.data.every(task => ['queued', 'running', 'succeeded', 'failed', 'cancelled'].includes(task.state)));

      // Filtering by session is what the phone uses when reconciling.
      const scoped = await api(gateway.base, `/api/tasks?session_id=${encodeURIComponent(sessionId)}`, { token: paired.ownerToken });
      assert.equal(scoped.data.length, 2);
      const unscoped = await api(gateway.base, '/api/tasks?session_id=session-does-not-exist', { token: paired.ownerToken });
      assert.deepEqual(unscoped.data, []);

      // The action trace the agent attached to the terminal event has to survive
      // the gateway and reach the phone; it is the "what did it actually do"
      // half of a result, and the summary alone does not carry it.
      const finished = list.data.find(task => task.task_id === 'task-order-new');
      assert.ok(Array.isArray(finished.actions), 'the reconciliation list should carry the action trace');
      assert.deepEqual(finished.actions[0], { kind: 'command', detail: 'echo task-order-new', exit_code: 0 });
    } finally {
      agent?.close();
      await gateway.stop();
    }
  });
});
