import { createHash } from 'node:crypto';
import type { FastifyReply } from 'fastify';
import { MAX_ACTIVE_TASKS, MAX_TRACKED_TASKS, type TaskCreate } from '@rab/protocol';
import { app } from '../app.js';
import { requireAgent, slot } from '../agent-slot.js';
import { auth } from '../security.js';
import { appendTaskEvent, devices, isTaskFinished, lastTaskEvent, saveTask, sessions, StateWriteError, tasks, TASK_CONFIRMATION_TTL_MS, type TaskRecord } from '../state.js';
import { askAgentToCancel, cancelTaskRecord, dispatchTask, taskSummary } from '../task-dispatch.js';
import { classifyTask } from '../task-risk.js';

const identifier = /^[a-z0-9][a-z0-9_.-]{0,127}$/i;
const kinds = new Set(['browser', 'file', 'process', 'screenshot', 'shell', 'gui']);
const validBudget = (value: unknown) => value === undefined || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 1_000 && value <= 7_200_000);
const validId = (value: unknown) => value === undefined || (typeof value === 'string' && value.trim() !== '' && value.length <= 128 && !/[\u0000-\u001f]/u.test(value));

function writeResponse<T>(reply: FastifyReply, action: () => T) {
  try { return action(); }
  catch (error) {
    if (!(error instanceof StateWriteError)) throw error;
    app.log.error('Task update could not be persisted');
    return reply.code(503).send({ error: error.message });
  }
}

function ownedTask(reply: FastifyReply, taskId: string, user: string | undefined) {
  if (!user) { reply.code(401).send({ error: 'unauthorized' }); return; }
  const entry = tasks.get(taskId);
  if (!entry) { reply.code(404).send({ error: 'task_not_found' }); return; }
  if (entry.owner !== user) { reply.code(403).send({ error: 'forbidden' }); return; }
  return entry;
}

app.post<{ Body: TaskCreate }>('/api/tasks', async (request, reply) => {
  const user = auth(request);
  if (!user) return reply.code(401).send({ error: 'unauthorized' });
  const body = request.body;
  if (typeof body?.task_id !== 'string' || !identifier.test(body.task_id) || typeof body.input !== 'string' || !body.input.trim() || body.input.length > 32_768) {
    return reply.code(400).send({ error: 'task_requires_task_id_and_input' });
  }
  if (!validId(body.session_id) || !validId(body.provider_id) ||
      (body.kind !== undefined && !kinds.has(body.kind)) || (body.mode !== undefined && body.mode !== 'isolated') ||
      !validBudget(body.timeout_ms) || !validBudget(body.idle_timeout_ms)) {
    return reply.code(400).send({ error: 'invalid_task_options' });
  }

  const { task_id, input, provider_id, session_id, kind, timeout_ms, idle_timeout_ms } = body;
  const task: TaskCreate = { task_id, input, provider_id, session_id, kind, timeout_ms, idle_timeout_ms, mode: 'isolated' };
  const requestHash = createHash('sha256').update(JSON.stringify(task)).digest('hex');
  const existing = tasks.get(task_id);
  if (existing) {
    if (existing.owner !== user || (existing.request_hash && existing.request_hash !== requestHash)) {
      return reply.code(409).send({ error: 'task_id_conflict' });
    }
    const summary = taskSummary(task_id, existing);
    return { ...summary, accepted: true, duplicate: true, requires_confirmation: summary.state === 'awaiting_confirmation' };
  }

  if (session_id) {
    const record = sessions.get(session_id);
    if (!record || record.owner !== user) return reply.code(404).send({ error: 'session_not_found' });
    if (provider_id && provider_id !== record.session.provider_id) return reply.code(400).send({ error: 'provider_session_mismatch' });
    task.provider_id = record.session.provider_id;
  }

  if (!requireAgent(reply, user)) return;
  if (slot.queuePaused) return reply.code(503).send({ error: 'agent_queue_paused' });
  const deviceId = slot.deviceId!;
  task.provider_id ??= 'local';
  if (!slot.info?.providers.some(provider => provider.id === task.provider_id)) return reply.code(400).send({ error: 'provider_not_found' });
  if ([...tasks.values()].filter(entry => !isTaskFinished(entry)).length >= MAX_ACTIVE_TASKS) {
    return reply.code(429).header('retry-after', '3').send({ error: 'task_queue_full' });
  }
  if (tasks.size >= MAX_TRACKED_TASKS) return reply.code(429).send({ error: 'task_history_full' });

  const risk = classifyTask(task);
  const now = Date.now();
  const entry: TaskRecord = { device_id: deviceId, binding_id: devices.get(deviceId)?.binding_id,
    owner: user, provider_id: task.provider_id, session_id, created_at: now, updated_at: now, request_hash: requestHash, events: [] };

  return writeResponse(reply, () => {
    if (risk.risk === 'high') {
      const waiting = appendTaskEvent({ ...entry, pending: task }, {
        task_id, session_id, provider_id: task.provider_id, state: 'awaiting_confirmation',
        message: `等待你在手机上确认：${risk.reasons.join('、')}`,
        risk: 'high', reasons: risk.reasons,
      });
      saveTask(task_id, waiting);
      return { ...taskSummary(task_id, waiting), accepted: true, requires_confirmation: true };
    }

    dispatchTask(task, entry);
    return { accepted: true, task_id, session_id, risk: risk.risk, state: 'dispatch_pending' };
  });
});

app.post<{ Params: { id: string } }>('/api/tasks/:id/confirm', async (request, reply) => {
  const { id } = request.params;
  const entry = ownedTask(reply, id, auth(request));
  if (!entry) return;
  const last = lastTaskEvent(entry);
  if (last?.state !== 'awaiting_confirmation' || !entry.pending) {
    return reply.code(409).send({ error: 'task_not_awaiting_confirmation', state: last?.state });
  }
  if (Date.now() - entry.updated_at >= TASK_CONFIRMATION_TTL_MS) {
    return writeResponse(reply, () => {
      cancelTaskRecord(id, entry, '[confirmation_expired] 高风险操作在 5 分钟内未被确认，未执行。');
      return reply.code(410).send({ error: 'confirmation_expired' });
    });
  }
  if (!requireAgent(reply, entry.owner)) return;
  if (slot.queuePaused) return reply.code(503).send({ error: 'agent_queue_paused' });
  if (entry.device_id !== slot.deviceId || entry.binding_id !== devices.get(slot.deviceId!)?.binding_id) {
    return reply.code(409).send({ error: 'task_device_binding_changed' });
  }
  if (entry.session_id && sessions.get(entry.session_id)?.owner !== entry.owner) return reply.code(409).send({ error: 'session_not_found' });
  if (!slot.info?.providers.some(provider => provider.id === entry.provider_id)) return reply.code(409).send({ error: 'provider_not_found' });
  const pending = entry.pending;
  return writeResponse(reply, () => {
    dispatchTask(pending, entry);
    return { confirmed: true, task_id: id, accepted: true, state: 'dispatch_pending' };
  });
});

app.post<{ Params: { id: string } }>('/api/tasks/:id/deny', async (request, reply) => {
  const { id } = request.params;
  const entry = ownedTask(reply, id, auth(request));
  if (!entry) return;
  if (lastTaskEvent(entry)?.state !== 'awaiting_confirmation' || !entry.pending) {
    return reply.code(409).send({ error: 'task_not_awaiting_confirmation', state: lastTaskEvent(entry)?.state });
  }
  return writeResponse(reply, () => {
    const cancelled = cancelTaskRecord(id, entry, '已拒绝，任务未执行。');
    return { ...taskSummary(id, cancelled), denied: true };
  });
});

app.post<{ Params: { id: string } }>('/api/tasks/:id/cancel', async (request, reply) => {
  const { id } = request.params;
  const entry = ownedTask(reply, id, auth(request));
  if (!entry) return;
  if (isTaskFinished(entry)) return taskSummary(id, entry);
  if (entry.pending) return writeResponse(reply, () => taskSummary(id, cancelTaskRecord(id, entry, '已取消，任务未执行。')));
  if (!entry.dispatch_id) return reply.code(409).send({ error: 'task_cancellation_unsupported' });

  return writeResponse(reply, () => {
    const next = lastTaskEvent(entry)?.state === 'cancel_requested' ? entry : appendTaskEvent(entry, {
      task_id: id, session_id: entry.session_id, provider_id: entry.provider_id,
      state: 'cancel_requested', message: '已请求取消，等待电脑确认是否停止。',
    });
    if (next !== entry) saveTask(id, next);
    askAgentToCancel(id, next);
    return taskSummary(id, next);
  });
});

export function listTaskSummaries(user: string, sessionId?: string) {
  return [...tasks.entries()]
    .filter(([, entry]) => entry.owner === user && (!sessionId || entry.session_id === sessionId))
    .sort(([, left], [, right]) => Number(isTaskFinished(left)) - Number(isTaskFinished(right)) || right.updated_at - left.updated_at)
    .slice(0, 100)
    .map(([id, entry]) => taskSummary(id, entry));
}

app.get<{ Querystring: { session_id?: string } }>('/api/tasks', async (request, reply) => {
  const user = auth(request);
  if (!user) return reply.code(401).send({ error: 'unauthorized' });
  return listTaskSummaries(user, request.query?.session_id);
});

app.get<{ Params: { id: string } }>('/api/tasks/:id', async (request, reply) => {
  const entry = ownedTask(reply, request.params.id, auth(request));
  if (entry) return taskSummary(request.params.id, entry);
});

app.get<{ Params: { id: string } }>('/api/tasks/:id/events', async (request, reply) => {
  return ownedTask(reply, request.params.id, auth(request))?.events;
});
