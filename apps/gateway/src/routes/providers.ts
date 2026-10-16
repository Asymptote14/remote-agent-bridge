import { app } from '../app.js';
import { auth } from '../security.js';
import { slot } from '../agent-slot.js';
app.get('/api/providers', async (request, reply) => {
  if (!auth(request)) return reply.code(401).send({ error: 'unauthorized' });
  return slot.info?.providers ?? [];
});
