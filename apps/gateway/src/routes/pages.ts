import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { app } from '../app.js';
import { slot } from '../agent-slot.js';
import { sessions } from '../state.js';

// The two pages the phone and the operator open, plus the health probe the
// launcher polls.
app.get('/health', async () => ({
  ok: true,
  agentOnline: slot.agent?.readyState === WebSocket.OPEN,
  agent: slot.info,
  sessions: sessions.size,
}));

app.get('/', async (_request, reply) => {
  const html = await readFile(join(process.cwd(), 'apps', 'web', 'index.html'), 'utf8');
  return reply.type('text/html; charset=utf-8').send(html);
});
app.get('/setup', async (_request, reply) => {
  const html = await readFile(join(process.cwd(), 'apps', 'web', 'setup.html'), 'utf8');
  return reply.type('text/html; charset=utf-8').send(html);
});
