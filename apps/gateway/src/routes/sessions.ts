import { randomUUID } from 'node:crypto';
import { type SessionCreate } from '@rab/protocol';
import { app } from '../app.js';
import { agentOwner, requireAgent, sendSessionCommand, slot } from '../agent-slot.js';
import { auth } from '../security.js';
import { isTaskFinished, saveSession, sessions, StateWriteError, tasks } from '../state.js';

const hasActiveTasks = (sessionId: string) => [...tasks.values()].some(task => task.session_id === sessionId && !isTaskFinished(task));

app.get('/api/sessions', async (request, reply) => {
  const user = auth(request);
  if (!user) return reply.code(401).send({ error: 'unauthorized' });
  return [...sessions.values()]
    .filter(record => record.owner === user)
    .map(record => record.session)
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
});

app.get<{ Params: { id: string } }>('/api/sessions/:id/messages', async (request, reply) => {
  const user = auth(request);
  const record = sessions.get(request.params.id);
  if (!user || !record || record.owner !== user) return reply.code(404).send({ error: 'session_not_found' });
  return record.messages;
});

app.delete<{ Params: { id: string } }>('/api/sessions/:id', async (request, reply) => {
  const user = auth(request);
  const record = sessions.get(request.params.id);
  if (!user || !record || record.owner !== user) return reply.code(404).send({ error: 'session_not_found' });
  if (hasActiveTasks(request.params.id)) return reply.code(409).send({ error: 'session_has_active_tasks' });
  try { saveSession(request.params.id); }
  catch (error) {
    if (!(error instanceof StateWriteError)) throw error;
    return reply.code(503).send({ error: error.message });
  }
  return { deleted: true };
});

app.post<{ Body: { provider_id: string; title?: string } }>('/api/sessions', async (request, reply) => {
  const user = auth(request);
  if (!user) return reply.code(401).send({ error: 'unauthorized' });
  if (!requireAgent(reply, user)) return;
  const providerId = request.body?.provider_id ?? 'local';
  if (typeof providerId !== 'string' || !slot.info?.providers.some(provider => provider.id === providerId)) return reply.code(400).send({ error: 'provider_not_found' });
  const title = request.body?.title;
  if (title !== undefined && (typeof title !== 'string' || title.length > 160)) return reply.code(400).send({ error: 'invalid_session_title' });
  const sessionId = `session_${randomUUID()}`;
  const payload: SessionCreate = { session_id: sessionId, provider_id: providerId, title };
  const requestId = randomUUID();
  const socket = slot.agent;
  try {
    const event = await sendSessionCommand(requestId, 'session.create', payload);
    if (event.action === 'failed' || !event.session) return reply.code(400).send({ error: event.error ?? 'session_create_failed' });
    if (socket !== slot.agent || agentOwner() !== user) return reply.code(503).send({ error: 'agent_disconnected' });
    saveSession(sessionId, { session: event.session, owner: user, messages: [] });
    return { session: event.session };
  } catch (error) {
    return reply.code(503).send({ error: error instanceof Error ? error.message : 'session_create_failed' });
  }
});

app.post<{ Params: { id: string }; Body: { provider_id: string } }>('/api/sessions/:id/switch', async (request, reply) => {
  const user = auth(request);
  const record = sessions.get(request.params.id);
  if (!user || !record || record.owner !== user) return reply.code(404).send({ error: 'session_not_found' });
  if (!requireAgent(reply, user)) return;
  if (hasActiveTasks(request.params.id)) return reply.code(409).send({ error: 'session_has_active_tasks' });
  const providerId = request.body?.provider_id ?? record.session.provider_id;
  if (typeof providerId !== 'string' || !slot.info?.providers.some(provider => provider.id === providerId)) return reply.code(400).send({ error: 'provider_not_found' });
  const socket = slot.agent;
  try {
    const event = await sendSessionCommand(randomUUID(), 'session.switch', { session_id: request.params.id, provider_id: providerId });
    if (event.action === 'failed' || !event.session) return reply.code(400).send({ error: event.error ?? 'session_switch_failed' });
    if (socket !== slot.agent || agentOwner() !== user) return reply.code(503).send({ error: 'agent_disconnected' });
    const existing = sessions.get(event.session.id);
    if (existing?.owner !== user) return reply.code(404).send({ error: 'session_not_found' });
    if (hasActiveTasks(event.session.id)) return reply.code(409).send({ error: 'session_has_active_tasks' });
    saveSession(event.session.id, { ...existing, session: event.session });
    return { session: event.session };
  } catch (error) {
    return reply.code(503).send({ error: error instanceof Error ? error.message : 'session_switch_failed' });
  }
});
