import { randomUUID } from 'node:crypto';
import { type SessionCreate } from '@rab/protocol';
import { app } from '../app.js';
import { requireAgent, sendSessionCommand } from '../agent-slot.js';
import { auth } from '../security.js';
import { pendingSessionOwners, persistState, sessions } from '../state.js';
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
  sessions.delete(request.params.id);
  pendingSessionOwners.delete(request.params.id);
  persistState();
  return { deleted: true };
});

app.post<{ Body: { provider_id: string; title?: string } }>('/api/sessions', async (request, reply) => {
  const user = auth(request);
  if (!user) return reply.code(401).send({ error: 'unauthorized' });
  if (!requireAgent(reply)) return;
  const sessionId = `session_${randomUUID().slice(0, 8)}`;
  const payload: SessionCreate = { session_id: sessionId, provider_id: request.body?.provider_id ?? 'local', title: request.body?.title };
  pendingSessionOwners.set(sessionId, user);
  const requestId = randomUUID();
  try {
    const event = await sendSessionCommand(requestId, 'session.create', payload);
    if (event.action === 'failed' || !event.session) return reply.code(400).send({ error: event.error ?? 'session_create_failed' });
    persistState();
    return { session: event.session };
  } catch (error) {
    pendingSessionOwners.delete(sessionId);
    return reply.code(503).send({ error: error instanceof Error ? error.message : 'session_create_failed' });
  }
});

app.post<{ Params: { id: string }; Body: { provider_id: string } }>('/api/sessions/:id/switch', async (request, reply) => {
  const user = auth(request);
  const record = sessions.get(request.params.id);
  if (!user || !record || record.owner !== user) return reply.code(404).send({ error: 'session_not_found' });
  if (!requireAgent(reply)) return;
  try {
    const event = await sendSessionCommand(randomUUID(), 'session.switch', { session_id: request.params.id, provider_id: request.body?.provider_id ?? record.session.provider_id });
    if (event.action === 'failed' || !event.session) return reply.code(400).send({ error: event.error ?? 'session_switch_failed' });
    const existing = sessions.get(event.session.id);
    sessions.set(event.session.id, { session: event.session, owner: user, messages: existing?.messages ?? [] });
    persistState();
    return { session: event.session };
  } catch (error) {
    return reply.code(503).send({ error: error instanceof Error ? error.message : 'session_switch_failed' });
  }
});
