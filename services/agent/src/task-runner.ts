import { randomUUID } from 'node:crypto';
import { AdapterTaskError, ExecutionUnconfirmedError, type AgentAdapter } from '@rab/adapter-sdk';
import { MAX_ACTIVE_TASKS, terminalTaskState, type AgentReady, type TaskAck, type TaskDispatch, type TaskEvent, type TaskRef } from '@rab/protocol';
import type { TaskJournal } from './task-journal.js';
import { resolveIdleTimeout, resolveTaskTimeout, runWithTimeouts, TaskTimeoutError } from './task-timeouts.js';

type Job = { task: TaskDispatch; bindingId?: string };
type Sender = (type: 'task.event' | 'task.missing', payload: TaskRef) => void;
const PAUSED_MESSAGE = '[queue_paused] 未执行：上一个任务的清理结果未知，请在电脑上检查。';
const CANCELLED_BEFORE_START = '已取消，任务未开始执行。';
const cancelReason = new Error('task_cancelled');
const STOP_WAIT_MS = 10_000;

async function stopWithin(stop: Promise<boolean>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      stop.catch(() => false),
      new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), STOP_WAIT_MS); }),
    ]);
  } finally { clearTimeout(timer); }
}

const refOf = ({ task }: Job): TaskRef => ({ task_id: task.task_id, dispatch_id: task.dispatch_id });

export class TaskRunner {
  private queue: Job[] = [];
  private active?: { job: Job; controller: AbortController };
  private send?: Sender;
  private canRun = () => false;
  private bindingId?: string;
  private readonly wanted = new Map<string, TaskRef>();
  private readonly acknowledged = new Map<string, number>();

  constructor(private readonly adapters: Map<string, AgentAdapter>, private readonly journal: TaskJournal) {}

  reconnect(ready: AgentReady, send: Sender, isAvailable: () => boolean = () => true) {
    this.send = undefined;
    this.bindingId = ready.binding_id;
    this.wanted.clear();
    this.acknowledged.clear();
    for (const ref of ready.tasks) this.wanted.set(ref.dispatch_id, ref);

    const current = (job: Job) => job.bindingId === this.bindingId && this.wanted.get(job.task.dispatch_id)?.task_id === job.task.task_id;
    for (const job of this.queue.filter(job => !current(job))) this.report(job, 'cancelled', '[authorization_changed] 任务未开始，已从队列移除。');
    this.queue = this.queue.filter(current);
    if (this.active && !current(this.active.job)) this.active.controller.abort(cancelReason);
    for (const ref of ready.tasks) {
      if (ref.cancel_requested) this.cancel(ref);
    }
    this.send = send;
    this.canRun = isAvailable;
    this.tick();
  }

  disconnect(revoked = false) {
    this.send = undefined;
    if (revoked) {
      for (const job of this.queue.splice(0)) this.report(job, 'cancelled', '[device_revoked] 任务未开始，设备授权已撤销。');
      this.active?.controller.abort(cancelReason);
    }
  }

  accept(task: TaskDispatch) {
    if (!this.send || !this.canRun()) return;
    const job = { task, bindingId: this.bindingId };
    const ref = refOf(job);
    this.wanted.set(ref.dispatch_id, ref);
    if (this.journal.get(ref, this.bindingId)) { this.publish(ref); return; }
    if (!this.journal.hasCapacity || !this.journal.flush()) { this.publish(ref); return; }
    if (this.journal.isPaused) { this.report(job, 'failed', PAUSED_MESSAGE); return; }
    if (Date.now() >= task.queue_expires_at) { this.report(job, 'cancelled', '[queue_expired] 排队已超时，任务未执行。'); return; }
    const provider = this.adapters.get(task.provider_id ?? 'local');
    if (task.mode !== 'isolated' || !provider?.provider.interaction_modes.includes('isolated') ||
        (task.kind !== undefined && task.kind !== 'file' && task.kind !== 'process')) {
      this.report(job, 'failed', '[capability_not_available] 此执行模式或任务类型不可用。');
      return;
    }
    if (this.queue.length + Number(Boolean(this.active)) >= MAX_ACTIVE_TASKS) {
      this.report(job, 'failed', '[queue_full] 电脑队列已满，任务未执行。');
      return;
    }
    if (!this.report(job, 'queued', '电脑已接单，等待执行。')) {
      this.report(job, 'failed', '[receipt_write_failed] 无法保存接单回执，任务未执行。');
      return;
    }
    this.queue.push(job);
    void this.runNext();
  }

  cancel(ref: TaskRef) {
    if (this.wanted.get(ref.dispatch_id)?.task_id !== ref.task_id) return;
    const index = this.queue.findIndex(job => job.bindingId === this.bindingId && job.task.dispatch_id === ref.dispatch_id && job.task.task_id === ref.task_id);
    if (index >= 0) this.report(this.queue.splice(index, 1)[0], 'cancelled', CANCELLED_BEFORE_START);
    else if (this.active?.job.bindingId === this.bindingId && this.active?.job.task.dispatch_id === ref.dispatch_id && this.active.job.task.task_id === ref.task_id) {
      this.active.controller.abort(cancelReason);
    } else this.publish(ref);
  }

  acknowledge(ack: TaskAck) {
    const ref = this.wanted.get(ack.dispatch_id);
    if (ref?.task_id !== ack.task_id || !Number.isSafeInteger(ack.sequence)) return;
    const receipt = this.journal.get(ref, this.bindingId);
    if ((!receipt && ack.sequence === 0) || (receipt && terminalTaskState(receipt.report.state) && ack.sequence === receipt.report.sequence)) {
      this.wanted.delete(ref.dispatch_id);
      this.acknowledged.delete(ref.dispatch_id);
    } else if (receipt && ack.sequence > 0 && ack.sequence <= receipt.report.sequence) {
      this.acknowledged.set(ref.dispatch_id, Math.max(this.acknowledged.get(ref.dispatch_id) ?? 0, ack.sequence));
    }
  }

  tick() {
    if (!this.journal.flush()) return;
    for (const ref of this.wanted.values()) this.publish(ref);
    void this.runNext();
  }

  private publish(ref: TaskRef) {
    if (!this.send || this.wanted.get(ref.dispatch_id)?.task_id !== ref.task_id) return;
    const receipt = this.journal.get(ref, this.bindingId);
    if (!receipt) this.send('task.missing', ref);
    else if (this.journal.flush() && (this.acknowledged.get(ref.dispatch_id) ?? 0) < receipt.report.sequence) {
      this.send('task.event', receipt.report);
    }
  }

  private report(job: Job, state: TaskEvent['state'], message: string, actions?: TaskEvent['actions'], pause = false) {
    const ref = refOf(job);
    const previous = this.journal.get(ref, job.bindingId)?.report;
    const saved = this.journal.save({ bindingId: job.bindingId, updatedAt: Date.now(), report: {
      ...ref, sequence: (previous?.sequence ?? 0) + 1,
      session_id: job.task.session_id, provider_id: job.task.provider_id ?? 'local', state,
      message: message.length > 32_768 ? `${message.slice(0, 32_767)}…` : message,
      actions: actions?.slice(-50).map(action => ({ ...action, detail: action.detail.slice(0, 300), status: action.status?.slice(0, 40) })),
    } }, pause);
    if (saved && job.bindingId === this.bindingId) this.publish(ref);
    return saved;
  }

  private async runNext() {
    if (this.active || !this.send || !this.canRun() || this.journal.isPaused || !this.journal.flush()) return;
    const job = this.queue.shift();
    if (!job) return;
    const { task } = job;
    const provider = this.adapters.get(task.provider_id ?? 'local')!;
    if (Date.now() >= task.queue_expires_at) {
      this.report(job, 'cancelled', '[queue_expired] 排队已超时，任务未执行。');
      queueMicrotask(() => void this.runNext());
      return;
    }

    const controller = new AbortController();
    this.active = { job, controller };
    let enteredProvider = false;
    let work: Promise<Awaited<ReturnType<AgentAdapter['sendMessage']>>> | undefined;
    try {
      if (!this.report(job, 'running', '电脑正在准备或执行任务。')) {
        this.report(job, 'failed', '[receipt_write_failed] 无法保存执行回执，任务未执行。');
        return;
      }
      const totalMs = resolveTaskTimeout(task.timeout_ms);
      const idleMs = resolveIdleTimeout(task.idle_timeout_ms);
      const signal = controller.signal;
      const result = await runWithTimeouts(onActivity => {
        work = (async () => {
          const sessionId = task.session_id ?? `session_${randomUUID()}`;
          let session;
          if (task.session_id) {
            try { session = await provider.switchSession(sessionId, signal); }
            catch (error) {
              signal.throwIfAborted();
              if (!(error instanceof Error) || error.message !== 'session_not_found') throw error;
            }
          }
          signal.throwIfAborted();
          session ??= await provider.createSession({ sessionId, signal });
          signal.throwIfAborted();
          if (!this.send || !this.canRun() || job.bindingId !== this.bindingId ||
              this.wanted.get(task.dispatch_id)?.task_id !== task.task_id) {
            throw new Error('[agent_connection_changed] 执行前失去授权连接，未发送执行请求。');
          }
          onActivity();
          enteredProvider = true;
          return provider.sendMessage({ taskId: task.task_id, sessionId: session.id, text: task.input,
            mode: 'isolated', timeoutMs: totalMs, history: task.history, onActivity, signal });
        })();
        return work;
      }, { totalMs, idleMs, signal });
      this.report(job, 'succeeded', result.message, result.actions);
    } catch (error) {
      const cancelled = error === cancelReason;
      const timedOut = error instanceof TaskTimeoutError;
      const message = error instanceof Error ? error.message : 'provider_execution_failed';
      const actions = error instanceof AdapterTaskError ? error.actions : undefined;
      if (cancelled || timedOut || error instanceof ExecutionUnconfirmedError) {
        controller.abort(error);
        const settled = work?.then(() => true, () => true) ?? Promise.resolve(true);
        const cleanup = !enteredProvider || provider.provider.transport === 'local'
          ? settled
          : Promise.resolve().then(() => provider.cancelTask(task.task_id)).then(outcome => outcome === 'stopped' && settled);
        const stopped = await stopWithin(cleanup);
        if (!stopped) {
          this.report(job, 'outcome_unknown', '[cleanup_unconfirmed] 无法确认任务已停止，已暂停队列。请在电脑上核对。', actions, true);
          console.error('Task cleanup unconfirmed; queue paused');
          for (const queued of this.queue.splice(0)) this.report(queued, 'failed', PAUSED_MESSAGE);
        } else if (error instanceof ExecutionUnconfirmedError) {
          this.report(job, 'outcome_unknown', `[${message}] Provider 已确认停止，但未收到最终执行结果。请在电脑上核对。`, actions);
        } else if (cancelled) {
          this.report(job, 'cancelled', enteredProvider ? '任务已停止；此前发生的操作不会自动撤销。' : CANCELLED_BEFORE_START, actions);
        } else {
          this.report(job, 'failed', enteredProvider ? `${message}；Provider 已停止。` : `${message}；未发送执行请求。`, actions);
        }
      } else this.report(job, 'failed', message, actions);
    } finally {
      this.active = undefined;
      void this.runNext();
    }
  }
}
