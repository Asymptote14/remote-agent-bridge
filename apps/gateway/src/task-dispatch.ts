import { randomUUID } from 'node:crypto';
import { TASK_QUEUE_TTL_MS, TASK_RECEIPTS, envelope, terminalTaskState, type AgentReady, type TaskCreate, type TaskEvent, type TaskRef, type TaskReport } from '@rab/protocol';
import type { WebSocket } from 'ws';
import { agentOwner, slot } from './agent-slot.js';
import { app } from './app.js';
import { appendTaskEvent, devices, isTaskFinished, lastTaskEvent, saveTask, sessions, tasks, TASK_CONFIRMATION_TTL_MS, type SessionRecord, type TaskRecord } from './state.js';

const legacyDispatches = new Map<string, WebSocket>();
const taskProvider = (entry: TaskRecord) => entry.provider_id ?? 'local';

function isCurrentTarget(entry: TaskRecord) {
  return entry.owner === agentOwner() && entry.device_id === slot.deviceId && entry.binding_id === devices.get(slot.deviceId ?? '')?.binding_id;
}

function taskRef(taskId: string, entry: TaskRecord): TaskRef | undefined {
  return entry.dispatch_id ? { task_id: taskId, dispatch_id: entry.dispatch_id } : undefined;
}

function stateEvent(taskId: string, entry: TaskRecord, state: TaskEvent['state'], message: string): TaskEvent {
  return { task_id: taskId, state, message, provider_id: taskProvider(entry), session_id: entry.session_id };
}

function recentContext(session: SessionRecord) {
  const history = [];
  let bytes = 0;
  for (const message of session.messages.slice(-20).reverse()) {
    bytes += Buffer.byteLength(JSON.stringify(message));
    if (bytes > 200 * 1024) break;
    history.unshift(message);
  }
  return history;
}

export function dispatchTask(task: TaskCreate, entry: TaskRecord) {
  const socket = slot.agent!;
  const dispatchId = slot.info?.capabilities.includes(TASK_RECEIPTS) ? randomUUID() : undefined;
  const updated = {
    ...appendTaskEvent(entry, stateEvent(task.task_id, entry, 'dispatch_pending', 'Gateway 已记录，等待电脑接单。')),
    pending: undefined,
    dispatch_id: dispatchId,
  };
  const session = entry.session_id ? sessions.get(entry.session_id) : undefined;
  const now = new Date().toISOString();
  const nextSession = session?.owner === entry.owner ? {
    ...session,
    session: { ...session.session, updated_at: now },
    messages: [...session.messages.slice(-99), { id: randomUUID(), role: 'user' as const, task_id: task.task_id, content: task.input, created_at: now }],
  } : undefined;
  const serialized = JSON.stringify(envelope('agent.task', {
    ...task, provider_id: taskProvider(entry), dispatch_id: dispatchId,
    queue_expires_at: dispatchId ? Date.now() + TASK_QUEUE_TTL_MS : undefined,
    history: nextSession ? recentContext(nextSession) : undefined,
  }));
  saveTask(task.task_id, updated, nextSession);
  if (!dispatchId) legacyDispatches.set(task.task_id, socket);
  const sendFailed = () => {
    if (dispatchId) socket.terminate();
    else markUnknown(task.task_id, updated, '[dispatch_unconfirmed] 无法确认电脑是否收到请求，请核对后再提交。');
  };
  try { socket.send(serialized, error => { if (error) sendFailed(); }); }
  catch { sendFailed(); }
}

function markUnknown(taskId: string, expected: TaskRecord, message: string) {
  if (tasks.get(taskId) !== expected || isTaskFinished(expected)) return false;
  try {
    saveTask(taskId, appendTaskEvent(expected, stateEvent(taskId, expected, 'outcome_unknown', message)));
    legacyDispatches.delete(taskId);
    return true;
  } catch {
    app.log.error({ task_id: taskId }, 'Unexpected task outcome could not be persisted');
    return false;
  }
}

export function reconcileAgent(socket: WebSocket) {
  const ready: AgentReady = {
    device_id: slot.deviceId!,
    binding_id: devices.get(slot.deviceId!)?.binding_id,
    tasks: [...tasks].flatMap(([taskId, entry]) => {
      const ref = taskRef(taskId, entry);
      return ref && !isTaskFinished(entry) && isCurrentTarget(entry) ? [{ ...ref, cancel_requested: lastTaskEvent(entry)?.state === 'cancel_requested' }] : [];
    }),
  };
  socket.send(JSON.stringify(envelope('agent.ready', ready)));
}

export function onAgentDisconnected(socket: WebSocket) {
  for (const [taskId, dispatchedSocket] of legacyDispatches) {
    if (dispatchedSocket !== socket) continue;
    const entry = tasks.get(taskId);
    if (entry) markUnknown(taskId, entry, '[agent_disconnected] 旧版 Agent 无法补报任务结果，请在电脑上核对。');
    legacyDispatches.delete(taskId);
  }
}

export function reportMissingTask(socket: WebSocket, ref: TaskRef) {
  if (typeof ref.task_id !== 'string' || !ref.task_id || ref.task_id.length > 128 ||
      typeof ref.dispatch_id !== 'string' || !ref.dispatch_id || ref.dispatch_id.length > 128) return;
  const entry = tasks.get(ref.task_id);
  if (!entry || entry.dispatch_id !== ref.dispatch_id || !isCurrentTarget(entry)) return;
  if (isTaskFinished(entry) || markUnknown(ref.task_id, entry, '[agent_receipt_missing] 电脑没有保留这次执行的回执，未自动重试。请在电脑上核对。')) {
    socket.send(JSON.stringify(envelope('task.ack', { task_id: ref.task_id, dispatch_id: ref.dispatch_id, sequence: 0 })));
  }
}

export function askAgentToCancel(taskId: string, entry: TaskRecord) {
  const ref = taskRef(taskId, entry);
  const socket = slot.agent;
  if (!ref || !socket || !isCurrentTarget(entry)) return;
  try { socket.send(JSON.stringify(envelope('agent.task.cancel', ref)), error => { if (error) socket.terminate(); }); }
  catch { socket.terminate(); }
}

export function cancelTaskRecord(taskId: string, entry: TaskRecord, message: string) {
  const next = { ...appendTaskEvent(entry, stateEvent(taskId, entry, 'cancelled', message)), pending: undefined };
  saveTask(taskId, next);
  return next;
}

export function taskSummary(taskId: string, entry: TaskRecord) {
  const last = lastTaskEvent(entry);
  return {
    task_id: taskId,
    state: last?.state ?? 'outcome_unknown',
    message: last?.message ?? '',
    actions: last?.actions,
    risk: last?.risk,
    reasons: last?.reasons,
    confirmation_input: entry.pending?.input,
    confirmation_expires_at: entry.pending ? entry.updated_at + TASK_CONFIRMATION_TTL_MS : undefined,
    can_cancel: Boolean(entry.pending || (entry.dispatch_id && !isTaskFinished(entry) && last?.state !== 'cancel_requested')),
    session_id: entry.session_id,
    provider_id: entry.provider_id,
    created_at: entry.created_at,
    updated_at: entry.updated_at,
  };
}

export function revokeTaskRecords(deviceId: string, bindingId: string | undefined, owner: string) {
  const previous = new Map<string, TaskRecord>();
  for (const [taskId, entry] of tasks) {
    if (entry.device_id !== deviceId || entry.binding_id !== bindingId || entry.owner !== owner || isTaskFinished(entry)) continue;
    previous.set(taskId, entry);
    const event = entry.pending
      ? stateEvent(taskId, entry, 'cancelled', '[device_revoked] 设备授权已撤销，待确认任务未执行。')
      : stateEvent(taskId, entry, 'outcome_unknown', '[device_revoked] 设备授权已撤销，无法确认已派发任务是否停止。');
    tasks.set(taskId, { ...appendTaskEvent(entry, event), pending: undefined });
  }
  return () => { for (const [taskId, entry] of previous) tasks.set(taskId, entry); };
}

const agentStates = ['queued', 'running', 'succeeded', 'failed', 'cancelled', 'outcome_unknown'];

export function recordTaskReport(socket: WebSocket, report: TaskReport) {
  if (typeof report.task_id !== 'string' || typeof report.message !== 'string' || report.message.length > 32_768 || !agentStates.includes(report.state)) return;
  const entry = tasks.get(report.task_id);
  if (!entry || entry.pending || !isCurrentTarget(entry) || taskProvider(entry) !== report.provider_id ||
      (entry.session_id && report.session_id !== entry.session_id)) return;

  const ref = taskRef(report.task_id, entry);
  const sequence = report.sequence;
  if (ref ? ref.dispatch_id !== report.dispatch_id || typeof sequence !== 'number' || !Number.isSafeInteger(sequence) || sequence < 1
    : legacyDispatches.get(report.task_id) !== socket || report.dispatch_id !== undefined) return;
  const ack = () => { if (ref) socket.send(JSON.stringify(envelope('task.ack', { ...ref, sequence }))); };
  if (isTaskFinished(entry) || (ref && sequence! <= (entry.sequence ?? 0))) { ack(); return; }

  const previous = lastTaskEvent(entry)?.state;
  if ((previous === 'cancel_requested' && !terminalTaskState(report.state)) || (previous === 'running' && report.state === 'queued')) {
    if (ref) saveTask(report.task_id, { ...entry, sequence });
    ack();
    return;
  }
  const actions = Array.isArray(report.actions) ? report.actions.slice(-50).flatMap(action => {
    if (!action || !['command', 'file', 'error'].includes(action.kind) || typeof action.detail !== 'string') return [];
    return [{ kind: action.kind, detail: action.detail.slice(0, 300),
      exit_code: typeof action.exit_code === 'number' && Number.isInteger(action.exit_code) || action.exit_code === null ? action.exit_code : undefined,
      status: typeof action.status === 'string' ? action.status.slice(0, 40) : undefined }];
  }) : undefined;
  const event: TaskEvent = { ...stateEvent(report.task_id, entry, report.state, report.message), actions };
  const next = { ...appendTaskEvent(entry, event), sequence };
  const session = entry.session_id ? sessions.get(entry.session_id) : undefined;
  const now = new Date().toISOString();
  const nextSession = event.state === 'succeeded' && event.message && session?.owner === entry.owner ? {
    ...session,
    session: { ...session.session, updated_at: now },
    messages: [...session.messages.slice(-99), { id: randomUUID(), role: 'assistant' as const, task_id: report.task_id, content: event.message, created_at: now }],
  } : undefined;
  saveTask(report.task_id, next, nextSession);
  if (isTaskFinished(next)) legacyDispatches.delete(report.task_id);
  ack();
}
