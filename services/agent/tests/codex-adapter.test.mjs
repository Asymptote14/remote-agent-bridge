import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The adapter resolves its state directory from @rab/config at import time, so
// the data directory has to be redirected before the module is loaded.
process.env.RAB_DATA_DIR = mkdtempSync(join(tmpdir(), 'rab-agent-data-'));

const { CodexAdapter } = await import('../dist/adapters/codex.js');
const { runWithTimeouts } = await import('../dist/task-timeouts.js');
const { isProcessAlive } = await import('../dist/process-control.js');

const tmp = mkdtempSync(join(tmpdir(), 'rab-codex-adapter-'));
const isWindows = process.platform === 'win32';

/**
 * The CLI is reached the way Codex is really installed on Windows: through a
 * `.cmd` shim that `cmd.exe` runs, which then starts the actual node process.
 * Testing against the bare `.js` would skip the launcher layer that the
 * process-tree fix exists for.
 */
function installCli(name, source) {
  const script = join(tmp, `${name}.js`);
  writeFileSync(script, source, 'utf8');
  if (!isWindows) return script;
  const shim = join(tmp, `${name}.cmd`);
  writeFileSync(shim, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`, 'utf8');
  return shim;
}

/** A well-behaved CLI: emits the JSON shape the adapter parses, then exits 0. */
const okCli = installCli('fake-codex-ok', [
  "console.log(JSON.stringify({ type: 'thread.started', thread_id: 'thread-fake-1' }));",
  "console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'fake codex finished the job' } }));",
].join('\n'));

/**
 * A CLI that looks alive once and then goes silent forever, while a grandchild
 * process — standing in for the real Codex process behind the launcher — keeps
 * running. The last argument is the task text, which the adapter forwards
 * verbatim, so it doubles as the path to write both PIDs to: the test needs
 * them to guarantee it can clean up even when the assertion is about to fail.
 */
const hangCli = installCli('fake-codex-hang', [
  "const { spawn } = require('node:child_process');",
  "const { writeFileSync } = require('node:fs');",
  'const pidFile = process.argv[process.argv.length - 1];',
  "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
  'writeFileSync(pidFile, JSON.stringify({ self: process.pid, grandchild: child.pid }));',
  "console.log(JSON.stringify({ type: 'thread.started', thread_id: 'thread-hang' }));",
  'setInterval(() => {}, 1000);',
].join('\n'));

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitForPids(file, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const value = JSON.parse(readFileSync(file, 'utf8'));
      if (value?.self && value?.grandchild) return value;
    } catch { /* not written yet */ }
    if (Date.now() > deadline) throw new Error(`PID file was never written: ${file}`);
    await sleep(25);
  }
}

async function waitForDeath(pid, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true;
    await sleep(25);
  }
  return !isProcessAlive(pid);
}

/**
 * Last-resort cleanup. A surviving fixture keeps the CLI's stdout pipe open,
 * which hangs the test runner instead of reporting the failure it just found.
 */
function forceKill(pid) {
  if (!pid) return;
  try { process.kill(pid, 'SIGKILL'); } catch { /* Already gone. */ }
}

function codexAdapter(executable, id) {
  return new CodexAdapter({ id, name: 'Fake Codex', transport: 'cli', executable, enabled: true });
}

test('the codex adapter turns CLI JSON output into a task result', async () => {
  const adapter = codexAdapter(okCli, 'codex-ok');
  const session = await adapter.createSession({ sessionId: 'session-ok' });
  const result = await adapter.sendMessage({
    taskId: 'task-ok',
    sessionId: session.id,
    text: 'summarise the repository',
    mode: 'isolated',
    timeoutMs: 30_000,
  });
  assert.equal(result.message, 'fake codex finished the job');
});

test('the adapter refuses to run a task outside isolated mode', async () => {
  const adapter = codexAdapter(okCli, 'codex-ok-mode');
  const session = await adapter.createSession({ sessionId: 'session-mode' });
  let caught;
  try {
    await adapter.sendMessage({ taskId: 'task-mode', sessionId: session.id, text: 'hi', mode: 'foreground', timeoutMs: 10_000 });
  } catch (error) {
    caught = error;
  }
  assert.equal(caught?.message, 'codex_foreground_mode_disabled');
});

test('a silent CLI is ended by the idle budget and its process tree is killed', async () => {
  const pidFile = join(tmp, 'hang-grandchild.pid');
  const adapter = codexAdapter(hangCli, 'codex-hang');
  const session = await adapter.createSession({ sessionId: 'session-hang' });

  const raced = runWithTimeouts(
    onActivity => adapter.sendMessage({
      taskId: 'task-hang',
      sessionId: session.id,
      text: pidFile,
      mode: 'isolated',
      timeoutMs: 10 * 60_000,
      onActivity,
    }),
    { totalMs: 10 * 60_000, idleMs: 800 },
  );

  let caught;
  let outcome;
  try {
    await raced;
  } catch (error) {
    caught = error;
  } finally {
    // The grandchild is what actually does the work, so it is what must be gone.
    const pids = await waitForPids(pidFile);
    assert.ok(isProcessAlive(pids.grandchild), 'the fake Codex process should have started');
    await adapter.cancelTask('task-hang');
    outcome = { pids, grandchildGone: await waitForDeath(pids.grandchild) };
    forceKill(pids.grandchild);
    forceKill(pids.self);
  }

  assert.equal(caught?.kind, 'task_idle_timeout', `expected an idle timeout, got ${caught}`);
  assert.ok(outcome.grandchildGone, `grandchild ${outcome.pids.grandchild} survived cancellation`);
});

test('cancelTask on an unknown task is a no-op', async () => {
  const adapter = codexAdapter(okCli, 'codex-idle');
  await adapter.cancelTask('never-started');
});
