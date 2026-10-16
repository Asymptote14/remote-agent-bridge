/**
 * Task timeouts for CLI providers.
 *
 * The original policy capped every task at 120 seconds with a 30 second
 * default, which is far below what a headless coding agent needs: a single
 * `codex exec` run against a real repository routinely takes minutes, so every
 * such task was killed while it was still working and reported as a failure.
 *
 * Raising the ceiling alone would trade that bug for a worse one. The Agent
 * executes one task at a time, so a provider that hangs — waiting on a prompt,
 * a lock, or a dead socket — would now block the whole queue for the entire
 * task budget. Two separate clocks are needed:
 *
 * - the total budget, generous, because real work takes time;
 * - an idle budget, which fires when a provider produces no output at all and
 *   is the signal that actually distinguishes "slow" from "stuck".
 *
 * Providers prove liveness by calling `onActivity`, which adapters wire to
 * their child process output.
 */

const MIN_TASK_TIMEOUT_MS = 1_000;
const MAX_TASK_TIMEOUT_MS = 2 * 60 * 60_000;

function envMs(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

/** Long enough for a real headless coding run against a repository. */
export const DEFAULT_TASK_TIMEOUT_MS = envMs('RAB_TASK_TIMEOUT_MS', 15 * 60_000);
/** Long enough that only a genuinely silent provider is treated as stuck. */
export const DEFAULT_IDLE_TIMEOUT_MS = envMs('RAB_IDLE_TIMEOUT_MS', 10 * 60_000);

export type TimeoutKind = 'task_timeout' | 'task_idle_timeout';

export class TaskTimeoutError extends Error {
  readonly kind: TimeoutKind;
  constructor(kind: TimeoutKind, message: string) {
    super(message);
    this.name = 'TaskTimeoutError';
    this.kind = kind;
  }
}

function clampTimeout(value: unknown, fallback: number): number {
  const raw = Number(value);
  const chosen = Number.isFinite(raw) && raw > 0 ? raw : fallback;
  return Math.min(Math.max(chosen, MIN_TASK_TIMEOUT_MS), MAX_TASK_TIMEOUT_MS);
}

export function resolveTaskTimeout(requested?: number): number {
  return clampTimeout(requested, DEFAULT_TASK_TIMEOUT_MS);
}

export function resolveIdleTimeout(requested?: number): number {
  return clampTimeout(requested, DEFAULT_IDLE_TIMEOUT_MS);
}

function describe(ms: number): string {
  return ms >= 60_000 ? `${Math.round(ms / 60_000)} 分钟` : `${Math.round(ms / 1_000)} 秒`;
}

/**
 * Runs `start`, rejecting with a `TaskTimeoutError` if it exceeds the total
 * budget or goes silent for longer than the idle budget. `start` receives the
 * activity callback it must forward to whatever proves progress.
 */
export function runWithTimeouts<T>(
  start: (onActivity: () => void) => Promise<T>,
  options: { totalMs: number; idleMs: number },
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;

    const finish = (settle: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(totalTimer);
      if (idleTimer) clearTimeout(idleTimer);
      settle();
    };

    const totalTimer = setTimeout(() => {
      finish(() => reject(new TaskTimeoutError(
        'task_timeout',
        `[task_timeout] 任务超过 ${describe(options.totalMs)}仍未完成，已终止 Provider 进程树`,
      )));
    }, options.totalMs);

    const armIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        finish(() => reject(new TaskTimeoutError(
          'task_idle_timeout',
          `[task_idle_timeout] 任务连续 ${describe(options.idleMs)}没有任何输出，判定为挂起并已终止 Provider 进程树`,
        )));
      }, options.idleMs);
    };
    armIdle();

    const onActivity = () => {
      if (settled) return;
      armIdle();
    };

    let work: Promise<T>;
    try {
      work = start(onActivity);
    } catch (error) {
      finish(() => reject(error));
      return;
    }
    work.then(
      value => finish(() => resolve(value)),
      error => finish(() => reject(error)),
    );
  });
}
