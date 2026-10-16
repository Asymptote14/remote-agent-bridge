import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { isProcessAlive, terminateProcessTree } from '../dist/process-control.js';

const tmp = mkdtempSync(join(tmpdir(), 'rab-process-control-'));
const isWindows = process.platform === 'win32';

// Stands in for the real Codex/CodeBuddy process: it records its own PID and
// then idles forever. `stdio: 'ignore'` matters, because anything holding the
// launcher's pipes open would outlive the launcher by itself and mask a broken
// tree kill.
const grandchildPath = join(tmp, 'grandchild.mjs');
writeFileSync(grandchildPath, [
  "import { writeFileSync } from 'node:fs';",
  'writeFileSync(process.argv[2], String(process.pid));',
  'setInterval(() => {}, 1000);',
].join('\n'), 'utf8');

// The launcher must reproduce the shape the CLI adapters actually spawn, not a
// convenient one. On Windows that is `cmd.exe /d /s /c <script>.cmd`, because
// `codex.cmd` and `codebuddy.cmd` are command shims: killing cmd.exe does NOT
// take down the node process it started, which is the whole reason this module
// exists. Spawning the grandchild from a node launcher instead would silently
// pass even with a broken implementation, since libuv's job object happens to
// reap that tree.
const launcherCmd = join(tmp, 'launcher.cmd');
writeFileSync(launcherCmd, `@echo off\r\n"${process.execPath}" "${grandchildPath}" "%~1"\r\n`, 'utf8');

const launcherNode = join(tmp, 'launcher.mjs');
writeFileSync(launcherNode, [
  "import { spawn } from 'node:child_process';",
  "spawn(process.execPath, [process.argv[2], process.argv[3]], { stdio: 'ignore' });",
  'setInterval(() => {}, 1000);',
].join('\n'), 'utf8');

function launchTree(pidFile) {
  if (isWindows) {
    return spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', launcherCmd, pidFile], {
      stdio: 'ignore',
      windowsHide: true,
    });
  }
  return spawn(process.execPath, [launcherNode, grandchildPath, pidFile], {
    stdio: 'ignore',
    windowsHide: true,
    // Matches the adapters: a process-group leader is what makes the whole
    // tree addressable by a single negative-PID signal.
    detached: true,
  });
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitForPidFile(file, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const value = Number(readFileSync(file, 'utf8'));
      if (Number.isFinite(value) && value > 0) return value;
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

test('terminateProcessTree removes the launcher and the process it spawned', async () => {
  const pidFile = join(tmp, 'grandchild-a.pid');
  const launcher = launchTree(pidFile);

  const grandchildPid = await waitForPidFile(pidFile);
  assert.ok(isProcessAlive(grandchildPid), 'the fake Codex process should be running first');

  const outcome = await terminateProcessTree(launcher);
  assert.notEqual(outcome, 'exited', 'a live tree should not report as already exited');

  assert.ok(await waitForDeath(grandchildPid), `grandchild ${grandchildPid} survived the tree kill`);
  assert.equal(launcher.exitCode === null && launcher.signalCode === null, false, 'the launcher should have exited');
});

test('the killed tree leaves nothing behind to overlap the next task', async () => {
  const pidFile = join(tmp, 'grandchild-b.pid');
  const launcher = launchTree(pidFile);

  const grandchildPid = await waitForPidFile(pidFile);
  await terminateProcessTree(launcher);

  // The Agent runs one task at a time and starts the next the moment
  // cancellation resolves, so a survivor here is a real overlap, not litter.
  await sleep(500);
  assert.equal(isProcessAlive(grandchildPid), false, `grandchild ${grandchildPid} was still running`);
});

test('an already-exited child is reported as exited and is safe to terminate twice', async () => {
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore', windowsHide: true });
  await once(child, 'close');
  assert.equal(await terminateProcessTree(child), 'exited');
  assert.equal(await terminateProcessTree(child), 'exited');
});

test('terminating a child that never spawned a process is safe', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
  const outcome = await terminateProcessTree(child);
  assert.ok(['graceful', 'forced'].includes(outcome), `unexpected outcome: ${outcome}`);
  assert.ok(await waitForDeath(child.pid));
});
