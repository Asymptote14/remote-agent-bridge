import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { MAX_TRACKED_TASKS, TASK_RETENTION_MS, terminalTaskState, type TaskRef, type TaskReport } from '@rab/protocol';

export type Receipt = {
  bindingId?: string;
  updatedAt: number;
  report: TaskReport & TaskRef & { sequence: number };
};

const receiptStates = new Set(['queued', 'running', 'succeeded', 'failed', 'cancelled', 'outcome_unknown']);

export class TaskJournal {
  private readonly receipts = new Map<string, Receipt>();
  private dirty = false;
  private paused = false;

  constructor(private readonly path: string) {
    try {
      const value = JSON.parse(readFileSync(path, 'utf8')) as { version: number; paused: boolean; receipts: Receipt[] };
      if (value.version !== 1 || typeof value.paused !== 'boolean' || !Array.isArray(value.receipts)) throw new Error('invalid_receipt_journal');
      this.paused = value.paused;
      for (const receipt of value.receipts) {
        const report = receipt?.report;
        if (!report || typeof report.task_id !== 'string' || typeof report.dispatch_id !== 'string' ||
            !Number.isSafeInteger(report.sequence) || report.sequence < 1 || !receiptStates.has(report.state) ||
            typeof report.message !== 'string' || !Number.isFinite(receipt.updatedAt) ||
            (receipt.bindingId !== undefined && typeof receipt.bindingId !== 'string') || this.receipts.has(report.dispatch_id)) {
          throw new Error('invalid_task_receipt');
        }
        this.receipts.set(report.dispatch_id, receipt);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new Error('receipt_journal_unreadable: inspect agent-task-receipts.json before starting', { cause: error });
      }
    }

    for (const receipt of this.receipts.values()) {
      const report = receipt.report;
      if (terminalTaskState(report.state)) continue;
      const started = report.state === 'running';
      this.paused ||= started;
      this.receipts.set(report.dispatch_id, { ...receipt, updatedAt: Date.now(), report: {
        ...report, sequence: report.sequence + 1,
        state: started ? 'outcome_unknown' : 'cancelled',
        message: started ? '[agent_restart] Agent 重启前已开始执行，请在电脑上确认任务与进程状态。' : '[agent_restart] 排队期间 Agent 重启，任务未执行。',
      } });
      this.dirty = true;
    }
    this.prune();
    if (!this.flush()) throw new Error('receipt_journal_write_failed');
  }

  get isPaused() { return this.paused; }

  get(ref: TaskRef, bindingId?: string) {
    const receipt = this.receipts.get(ref.dispatch_id);
    return receipt?.report.task_id === ref.task_id && receipt.bindingId === bindingId ? receipt : undefined;
  }

  get hasCapacity() {
    this.prune();
    return this.receipts.size < MAX_TRACKED_TASKS;
  }

  private prune() {
    const cutoff = Date.now() - TASK_RETENTION_MS;
    for (const [id, receipt] of this.receipts) {
      if (terminalTaskState(receipt.report.state) && receipt.updatedAt < cutoff) {
        this.receipts.delete(id);
        this.dirty = true;
      }
    }
  }

  save(receipt: Receipt, pause = false) {
    this.receipts.set(receipt.report.dispatch_id, receipt);
    this.paused ||= pause;
    this.dirty = true;
    return this.flush();
  }

  acknowledgeStopped() {
    this.paused = false;
    this.dirty = true;
    if (!this.flush()) throw new Error('receipt_journal_write_failed');
  }

  flush() {
    if (!this.dirty) return true;
    try {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      const temporary = `${this.path}.tmp`;
      writeFileSync(temporary, JSON.stringify({ version: 1, paused: this.paused, receipts: [...this.receipts.values()] }), { encoding: 'utf8', mode: 0o600, flush: true });
      renameSync(temporary, this.path);
      this.dirty = false;
      return true;
    } catch { return false; }
  }
}
