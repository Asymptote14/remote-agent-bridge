import { randomUUID } from 'node:crypto';
import { envelope, type ConversationMessage, type TaskCreate, type TaskEvent } from '@rab/protocol';
import { app } from '../app.js';
import { requireAgent, sendSessionCommand, slot } from '../agent-slot.js';
import { auth } from '../security.js';
import { lastTaskEvent, persistState, sessions, tasks } from '../state.js';
app.post<{ Body: TaskCreate }>('/api/tasks', async (request, reply) => {
  const user = auth(request);
  if (!user) return reply.code(401).send({ error: 'unauthorized' });
  const task = request.body;
  if (!task || !task.task_id || typeof task.input !== 'string') return reply.code(400).send({ error: 'task_requires_task_id_and_input' });

  // Idempotency. A retried POST — page reload, flaky tunnel, double tap — must
  // not run the work twice, and must not append the user's message to the
  // session a second time. The check therefore comes before the session write
  // and before the Agent is required to be online: a task that was already
  // accepted stays accepted even if the Agent has since gone away.
  const existing = tasks.get(task.task_id);
  if (existing) {
    if (existing.owner !== user) return reply.code(409).send({ error: 'task_id_conflict' });
    const last = lastTaskEvent(existing);
    return { accepted: true, duplicate: true, task_id: task.task_id, session_id: existing.session_id, state: last?.state ?? 'queued' };
  }

  if (!requireAgent(reply)) return;
  if (task.session_id) {
    const record = sessions.get(task.session_id);
    if (!record || record.owner !== user) return reply.code(404).send({ error: 'session_not_found' });
    if (task.provider_id && task.provider_id !== record.session.provider_id) return reply.code(400).send({ error: 'provider_session_mismatch' });
    const userMessage: ConversationMessage = { id: randomUUID(), role: 'user', content: task.input, created_at: new Date().toISOString() };
    record.messages.push(userMessage);
    record.messages = record.messages.slice(-100);
    record.session.updated_at = userMessage.created_at;
    task.history = record.messages.slice(-20);
  }
  const now = Date.now();
  tasks.set(task.task_id, { owner: user, session_id: task.session_id, created_at: now, updated_at: now, events: [] });
  persistState();
  slot.agent!.send(JSON.stringify(envelope('agent.task', { ...task, mode: task.mode ?? 'isolated' })));
  return { accepted: true, task_id: task.task_id, session_id: task.session_id };
});

/**
 * Recent task summaries for the signed-in user. The phone keeps a local list of
 * task ids it is still waiting on; this is the authoritative record it
 * reconciles against, so a task that was resolved — or lost to a restart —
 * cannot leave the client polling forever.
 */
app.get<{ Querystring: { session_id?: string } }>('/api/tasks', async (request, reply) => {
  const user = auth(request);
  if (!user) return reply.code(401).send({ error: 'unauthorized' });
  const sessionId = request.query?.session_id;
  return [...tasks.entries()]
    .filter(([, record]) => record.owner === user && (!sessionId || record.session_id === sessionId))
    // Newest activity first: a task that just finished must never be pushed out
    // of the window by a batch of older ones, because reaching a terminal state
    // is exactly what the client is reconciling for.
    .sort(([, a], [, b]) => b.updated_at - a.updated_at)
    .slice(0, 100)
    .map(([taskId, record]) => {
      const last = lastTaskEvent(record);
      return {
        task_id: taskId,
        state: last?.state ?? 'queued',
        message: last?.message ?? '',
        session_id: record.session_id,
        created_at: record.created_at,
        updated_at: record.updated_at,
      };
    });
});

app.get<{ Params: { id: string } }>('/api/tasks/:id/events', async (request, reply) => {
  const user = auth(request);
  if (!user) return reply.code(401).send({ error: 'unauthorized' });
  const entry = tasks.get(request.params.id);
  if (!entry) return reply.code(404).send({ error: 'task_not_found' });
  // Task events are only readable by the user that created the task.
  if (entry.owner !== user) return reply.code(403).send({ error: 'forbidden' });
  return entry.events;
});
