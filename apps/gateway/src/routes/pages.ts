import { readFile } from 'node:fs/promises';
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
  return reply.type('text/html; charset=utf-8').header('content-security-policy', "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'")
    .send(await readFile(new URL('../../../web/index.html', import.meta.url), 'utf8'));
});
app.get('/setup', async (_request, reply) => {
  return reply.type('text/html; charset=utf-8').send(await readFile(new URL('../../../web/setup.html', import.meta.url), 'utf8'));
});

for (const [file, contentType] of [['chat.js', 'text/javascript'], ['chat.css', 'text/css']]) {
  app.get(`/assets/${file}`, async (_request, reply) => {
    return reply.type(`${contentType}; charset=utf-8`).send(await readFile(new URL(`../../../web/${file}`, import.meta.url), 'utf8'));
  });
}
