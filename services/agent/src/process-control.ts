import { execFile, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';

/**
 * Killing a spawned CLI is not the same as stopping its work.
 *
 * `codex` and `codebuddy` are not launched as a bare executable on Windows:
 * they are reached through `cmd.exe /c <script>.cmd`, and that shim starts the
 * real agent as a grandchild. `child.kill()` terminates only the direct child,
 * so the process that actually holds the model connection, writes files and
 * burns quota keeps running after the task has already been reported as
 * cancelled. Measured on Windows: after `child.kill()` the `cmd.exe` launcher is
 * gone while the node process it started is still alive and still parented to
 * the dead PID.
 *
 * The failure is easy to miss, because whether a surviving grandchild is reaped
 * depends on the launcher. When the direct child is itself a Node process,
 * libuv's job object happens to take the descendants down with it, so a test
 * built on a node launcher passes even with a broken implementation. Only the
 * `cmd.exe` shape — the one the adapters actually spawn — reproduces it, which
 * is why the regression test insists on that shape.
 *
 * Windows has no process-group signal, and `taskkill /T` can only walk the
 * descendant set while the parent is still alive — once the parent exits its
 * children are reparented and become unreachable by PID. The tree therefore has
 * to be swept in one pass, before anything in it is signalled individually.
 *
 * POSIX has the primitive Windows lacks, but only if the child was spawned as a
 * process-group leader (`detached: true`), which is why both CLI adapters set
 * that flag on non-Windows platforms.
 */

const DEFAULT_GRACE_MS = 3_000;

export type TerminateOutcome =
  /** Already gone before we tried; nothing to do. */
  | 'exited'
  /** Exited within the grace period after a polite signal (POSIX only). */
  | 'graceful'
  /** Needed force: `taskkill /T /F` on Windows, `SIGKILL` to the group elsewhere. */
  | 'forced';

/** Whether a PID currently exists. `EPERM` still means the process is there. */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function taskkillExecutable(): string {
  const root = process.env.SystemRoot || process.env.windir;
  return root ? join(root, 'System32', 'taskkill.exe') : 'taskkill';
}

/**
 * `taskkill /T /F` is deliberately forceful and runs before anything else on
 * Windows: a graceful single-process kill would take the parent down first and
 * orphan the descendants we are actually trying to reach.
 */
function taskkillTree(pid: number): Promise<void> {
  return new Promise(resolve => {
    execFile(
      taskkillExecutable(),
      ['/PID', String(pid), '/T', '/F'],
      { windowsHide: true },
      // A non-zero exit just means the tree was already gone.
      () => resolve(),
    );
  });
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try { process.kill(-pid, signal); } catch { /* The group may already be gone. */ }
  try { process.kill(pid, signal); } catch { /* The leader may already be gone. */ }
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise(resolve => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      child.off('close', onExit);
      child.off('exit', onExit);
      resolve(value);
    };
    const onExit = () => finish(true);
    child.once('close', onExit);
    child.once('exit', onExit);
    timer = setTimeout(() => finish(false), timeoutMs);
  });
}

/**
 * Terminates a child and every process it spawned, and resolves only once the
 * child has actually exited. The Agent runs one task at a time and starts the
 * next as soon as cancellation resolves, so a surviving grandchild would
 * overlap with the following task rather than merely linger.
 */
export async function terminateProcessTree(
  child: ChildProcess,
  options: { graceMs?: number } = {},
): Promise<TerminateOutcome> {
  const graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
  const pid = child.pid;
  if (typeof pid !== 'number' || child.exitCode !== null || child.signalCode !== null) return 'exited';
  if (!isProcessAlive(pid)) return 'exited';

  if (process.platform === 'win32') {
    await taskkillTree(pid);
    if (await waitForExit(child, graceMs)) return 'forced';
    // taskkill refused to take something down (elevated or otherwise protected).
    try { child.kill('SIGKILL'); } catch { /* Already gone. */ }
    await waitForExit(child, graceMs);
    return 'forced';
  }

  signalGroup(pid, 'SIGTERM');
  if (await waitForExit(child, graceMs)) return 'graceful';

  signalGroup(pid, 'SIGKILL');
  await waitForExit(child, graceMs);
  return 'forced';
}
