import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { TaskJournal } from '../dist/task-journal.js';
import { TaskRunner } from '../dist/task-runner.js';

const binding = 'fixture-binding';
const ready = (tasks = [], bindingId = binding) => ({ device_id: 'fixture-computer', binding_id: bindingId, tasks });
const task = id => ({ task_id: id, dispatch_id: `dispatch-${id}`, input: 'fixture query', provider_id: 'fake', session_id: 'fixture-session', mode: 'isolated', queue_expires_at: Date.now() + 200_000 });
const ref = ({ task_id, dispatch_id }) => ({ task_id, dispatch_id });
const session = { id: 'fixture-session' };

function fixture(context, overrides = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'rab-runner-test-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'receipts.json');
  const journal = new TaskJournal(path);
  const events = [];
  const starts = [];
  const provider = {
    provider: { id: 'fake', transport: 'cli', interaction_modes: ['isolated'] },
    switchSession: async () => session,
    createSession: async () => session,
    async sendMessage(input) {
      starts.push(input.taskId);
      return overrides.sendMessage ? overrides.sendMessage(input) : { session, message: 'result' };
    },
    cancelTask: async () => 'not_found',
    ...Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== 'sendMessage')),
  };
  const adapters = new Map([[provider.provider.id, provider]]);
  const runner = new TaskRunner(adapters, journal);
  const send = (type, data) => events.push({ type, data });
  runner.reconnect(ready(), send);
  return { runner, journal, path, events, starts, adapters, send,
    latest: item => journal.get(ref(item), binding)?.report };
}

async function until(check) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const value = check();
    if (value) return value;
    await delay(10);
  }
  assert.fail('timed out waiting for the task fixture');
}

test('removes queued tasks without running them and waits for stop proof for the active task', async context => {
  const stop = Promise.withResolvers();
  const work = Promise.withResolvers();
  const abort = Promise.withResolvers();
  let stopCalls = 0;
  const state = fixture(context, {
    sendMessage(input) { input.signal.addEventListener('abort', () => abort.resolve(), { once: true }); return work.promise; },
    cancelTask() { stopCalls += 1; return stop.promise; },
  });
  const active = task('active');
  const queued = task('queued');
  state.runner.accept(active);
  await until(() => state.starts.includes(active.task_id));
  state.runner.accept(queued);
  state.runner.cancel(ref(queued));
  state.runner.cancel(ref(queued));
  assert.equal(state.latest(queued).state, 'cancelled');
  assert.match(state.latest(queued).message, /未开始/);
  state.runner.cancel(ref(active));
  state.runner.cancel(ref(active));
  await abort.promise;
  assert.equal(state.latest(active).state, 'running', 'an abort request is not stop proof');
  stop.resolve('stopped');
  work.resolve({ session, message: 'late result' });
  await until(() => state.latest(active)?.state === 'cancelled');
  assert.equal(stopCalls, 1);
  assert.deepEqual(state.starts, [active.task_id]);
  assert.match(state.latest(active).message, /不会自动撤销/);
});

test('persists a paused queue when cancellation cannot be confirmed', async context => {
  const work = Promise.withResolvers();
  const state = fixture(context, { sendMessage: () => work.promise, cancelTask: async () => 'not_found' });
  const active = task('uncertain');
  const queued = task('behind-uncertain');
  state.runner.accept(active);
  await until(() => state.starts.includes(active.task_id));
  state.runner.accept(queued);
  state.runner.cancel(ref(active));
  await until(() => state.latest(active)?.state === 'outcome_unknown');
  assert.equal(state.latest(queued).state, 'failed');
  assert.match(state.latest(queued).message, /未执行/);
  assert.deepEqual(state.starts, [active.task_id]);
  assert.equal(new TaskJournal(state.path).isPaused, true);
  assert.equal(JSON.parse(readFileSync(state.path, 'utf8')).paused, true);
  work.resolve({ session, message: 'too late' });
  await delay(0);
  assert.equal(state.latest(active).state, 'outcome_unknown');
});

test('does not start a queued task while offline and invalidates it when authorization changes', async context => {
  const work = Promise.withResolvers();
  const state = fixture(context, { sendMessage: () => work.promise });
  const active = task('before-disconnect');
  const queued = task('stale-queued');
  state.runner.accept(active);
  await until(() => state.starts.includes(active.task_id));
  state.runner.accept(queued);
  state.runner.disconnect();
  work.resolve({ session, message: 'offline result' });
  await until(() => state.latest(active)?.state === 'succeeded');
  assert.equal(state.latest(queued).state, 'queued');
  assert.deepEqual(state.starts, [active.task_id]);
  state.runner.reconnect(ready([], 'replacement-binding'), state.send);
  assert.equal(state.latest(queued).state, 'cancelled');
  assert.deepEqual(state.starts, [active.task_id]);
});

test('never proceeds from session preparation to task execution on a closed connection', async context => {
  const preparation = Promise.withResolvers();
  let connected = true;
  const state = fixture(context, { switchSession: () => preparation.promise });
  const active = task('preparing');
  state.runner.reconnect(ready(), state.send, () => connected);
  state.runner.accept(active);
  assert.equal(state.latest(active).state, 'running');
  connected = false;
  preparation.resolve(session);
  await until(() => state.latest(active)?.state === 'failed');
  assert.match(state.latest(active).message, /未发送执行请求/);
  assert.deepEqual(state.starts, []);
});

test('replays only receipts after an Agent restart, never starts recorded jobs again', async context => {
  const state = fixture(context);
  const running = task('interrupted-running');
  const queued = task('interrupted-queued');
  const finished = task('already-finished');
  const absent = task('absent');
  for (const [item, status] of [[running, 'running'], [queued, 'queued'], [finished, 'succeeded']]) {
    assert.equal(state.journal.save({ bindingId: binding, updatedAt: Date.now(), report: { ...ref(item), sequence: 1, state: status, message: status } }), true);
  }
  const journal = new TaskJournal(state.path);
  const runner = new TaskRunner(state.adapters, journal);
  const events = [];
  const refs = [running, queued, finished, absent].map(item => ({ ...ref(item), cancel_requested: false }));
  runner.reconnect(ready(refs), (type, data) => events.push({ type, data }));
  assert.equal(journal.isPaused, true);
  assert.deepEqual(events.map(({ type, data }) => [type, data.task_id, data.state]), [
    ['task.event', running.task_id, 'outcome_unknown'],
    ['task.event', queued.task_id, 'cancelled'],
    ['task.event', finished.task_id, 'succeeded'],
    ['task.missing', absent.task_id, undefined],
  ]);
  runner.acknowledge({ ...ref(absent), sequence: 0 });
  runner.acknowledge({ ...ref(finished), sequence: 1 });
  runner.tick();
  assert.equal(events.filter(frame => frame.data.task_id === absent.task_id).length, 1);
  runner.accept(finished);
  assert.deepEqual(state.starts, []);
  assert.equal(journal.get(ref(finished), binding).report.sequence, 1);
  journal.acknowledgeStopped();
  assert.equal(new TaskJournal(state.path).isPaused, false);
});

test('does not start a task if the Agent cannot persist its receipt', async context => {
  const state = fixture(context);
  const item = task('disk-unavailable');
  const temporary = `${state.path}.tmp`;
  mkdirSync(temporary);
  try {
    state.runner.accept(item);
    state.runner.tick();
    assert.deepEqual(state.starts, []);
    assert.deepEqual(state.events, []);
  } finally { rmdirSync(temporary); }
  state.runner.tick();
  assert.equal(state.events.at(-1).data.state, 'failed');
  assert.match(state.events.at(-1).data.message, /未执行/);
  assert.deepEqual(state.starts, []);
});

test('local recovery requires explicit confirmation and preserves the old outcome', context => {
  const directory = mkdtempSync(join(tmpdir(), 'rab-agent-recovery-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'agent-task-receipts.json');
  const journal = new TaskJournal(path);
  const item = task('unknown-before-recovery');
  const receipt = { ...ref(item), sequence: 2, state: 'outcome_unknown', message: 'fixture result remains unknown' };
  assert.equal(journal.save({ bindingId: binding, updatedAt: Date.now(), report: receipt }, true), true);
  const entry = fileURLToPath(new URL('../dist/index.js', import.meta.url));
  const options = { env: { ...process.env, RAB_DATA_DIR: directory }, encoding: 'utf8', timeout: 5_000 };
  const refused = spawnSync(process.execPath, [entry, '--acknowledge-stopped'], options);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /Stop both services/);
  assert.equal(new TaskJournal(path).isPaused, true);
  const confirmed = spawnSync(process.execPath, [entry, '--acknowledge-stopped', '--confirm-local-cleanup'], options);
  assert.equal(confirmed.status, 0, confirmed.stderr);
  const recovered = new TaskJournal(path);
  assert.equal(recovered.isPaused, false);
  assert.deepEqual(recovered.get(ref(item), binding).report, receipt);
});
