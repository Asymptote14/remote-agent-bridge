import { createHash } from 'node:crypto';
import { agentOwner, slot } from '../agent-slot.js';
import { app } from '../app.js';
import { auth } from '../security.js';
import { devices, isTaskFinished, lastTaskEvent, sessions, tasks } from '../state.js';
import { listTaskSummaries } from './tasks.js';

app.get<{ Querystring: { session_id?: string } }>('/api/dashboard', async (request, reply) => {
  const owner = auth(request);
  if (!owner) return reply.code(401).send({ error: 'unauthorized' });
  const online = agentOwner() === owner;
  const deviceId = online ? slot.deviceId : [...devices].find(([, record]) => record.owner === owner)?.[0];
  const device = deviceId ? devices.get(deviceId) : undefined;
  const activity = new Map<string, { active: number; awaiting: number }>();
  for (const task of tasks.values()) {
    if (task.owner !== owner || !task.session_id || isTaskFinished(task)) continue;
    const counts = activity.get(task.session_id) ?? { active: 0, awaiting: 0 };
    counts.active += 1;
    if (lastTaskEvent(task)?.state === 'awaiting_confirmation') counts.awaiting += 1;
    activity.set(task.session_id, counts);
  }
  const owned = [...sessions.values()].filter(record => record.owner === owner)
    .sort((left, right) => right.session.updated_at.localeCompare(left.session.updated_at));
  const selected = owned.find(record => record.session.id === request.query.session_id) ?? owned[0];
  const messages = selected?.messages ?? [];
  const assistantTasks = new Set(messages.filter(message => message.role === 'assistant').map(message => message.task_id));
  const summaries = selected ? listTaskSummaries(owner, selected.session.id).map(task => (
    task.state === 'succeeded' && assistantTasks.has(task.task_id) ? { ...task, message: '' } : task
  )) : [];
  const body = JSON.stringify({
    device: { status: online ? (slot.queuePaused ? 'paused' : 'online') : device ? 'offline' : 'unpaired', id: deviceId, name: device?.name },
    providers: online ? slot.info?.providers ?? [] : [],
    sessions: owned.map(({ session }) => ({ ...session, ...activity.get(session.id) })),
    selected: selected ? { session_id: selected.session.id, messages, tasks: summaries } : null,
  });
  const etag = `"${createHash('sha256').update(body).digest('base64url')}"`;
  reply.header('etag', etag).header('vary', 'Origin, Authorization');
  if (request.headers['if-none-match'] === etag) return reply.code(304).send();
  return reply.type('application/json; charset=utf-8').send(body);
});
