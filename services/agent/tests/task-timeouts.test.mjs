import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_IDLE_TIMEOUT_MS,
  DEFAULT_TASK_TIMEOUT_MS,
  resolveIdleTimeout,
  resolveTaskTimeout,
  runWithTimeouts,
} from '../dist/task-timeouts.js';

const MINUTE = 60_000;

test('the default budget is no longer the 30 second value that killed every CLI task', () => {
  // Regression guard: a headless coding agent needs minutes, not seconds.
  assert.ok(DEFAULT_TASK_TIMEOUT_MS >= 5 * MINUTE, `total budget too small: ${DEFAULT_TASK_TIMEOUT_MS}`);
  assert.ok(DEFAULT_IDLE_TIMEOUT_MS >= 5 * MINUTE, `idle budget too small: ${DEFAULT_IDLE_TIMEOUT_MS}`);
});

test('an explicit budget above the old two minute cap is honoured', () => {
  assert.equal(resolveTaskTimeout(5_000), 5_000);
  assert.equal(resolveTaskTimeout(20 * MINUTE), 20 * MINUTE);
});

test('budgets are clamped to a sane floor and ceiling', () => {
  assert.equal(resolveTaskTimeout(1), 1_000);
  assert.equal(resolveTaskTimeout(99 * 60 * MINUTE), 2 * 60 * MINUTE);
  assert.equal(resolveTaskTimeout(undefined), DEFAULT_TASK_TIMEOUT_MS);
  assert.equal(resolveTaskTimeout(Number.NaN), DEFAULT_TASK_TIMEOUT_MS);
  assert.equal(resolveIdleTimeout(undefined), DEFAULT_IDLE_TIMEOUT_MS);
});

test('a provider that finishes in time resolves normally', async () => {
  const value = await runWithTimeouts(async () => 'finished', { totalMs: 5_000, idleMs: 5_000 });
  assert.equal(value, 'finished');
});

test('a provider that throws before returning a promise rejects with that error', async () => {
  let caught;
  try {
    await runWithTimeouts(() => { throw new Error('boom'); }, { totalMs: 1_000, idleMs: 1_000 });
  } catch (error) {
    caught = error;
  }
  assert.equal(caught?.message, 'boom');
});

test('a silent provider is ended by the idle budget, not the total budget', async () => {
  const started = Date.now();
  let caught;
  try {
    // Never settles and holds no handles: only the clocks can end this task.
    await runWithTimeouts(() => new Promise(() => {}), { totalMs: 10 * MINUTE, idleMs: 200 });
  } catch (error) {
    caught = error;
  }
  assert.equal(caught?.kind, 'task_idle_timeout');
  assert.ok(Date.now() - started < 5_000, 'should not have waited for the total budget');
});

test('a slow but active provider still ends at the total budget', async () => {
  let ticks = 0;
  let ticker;
  const raced = runWithTimeouts(onActivity => {
    ticker = setInterval(() => { ticks += 1; onActivity(); }, 20);
    // Keep the heartbeat from holding the process open if the test unwinds early.
    ticker.unref?.();
    return new Promise(() => {});
  }, { totalMs: 400, idleMs: 250 });

  let caught;
  try {
    await raced;
  } catch (error) {
    caught = error;
  } finally {
    clearInterval(ticker);
  }

  assert.equal(caught?.kind, 'task_timeout');
  assert.ok(ticks > 3, `the idle clock should have been reset repeatedly, saw ${ticks} ticks`);
});

test('activity reported by the provider never overrides the total budget', async () => {
  // The same shape as the previous test but with activity far faster than the
  // idle budget: proving the two clocks are independent, not one shared timer.
  const raced = runWithTimeouts(onActivity => {
    const ticker = setInterval(onActivity, 5);
    ticker.unref?.();
    return new Promise(() => {});
  }, { totalMs: 300, idleMs: 100 });
  let caught;
  try {
    await raced;
  } catch (error) {
    caught = error;
  }
  assert.equal(caught?.kind, 'task_timeout');
});
