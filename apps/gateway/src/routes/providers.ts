import { app } from '../app.js';
import { auth } from '../security.js';
import { agentOwner, slot } from '../agent-slot.js';
app.get('/api/providers', async (request, reply) => {
  const user = auth(request);
  if (!user) return reply.code(401).send({ error: 'unauthorized' });
  return agentOwner() === user ? slot.info?.providers ?? [] : [];
});
