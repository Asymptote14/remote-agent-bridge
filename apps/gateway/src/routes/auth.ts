import { randomBytes } from 'node:crypto';
import { app } from '../app.js';
import { hash, valid } from '../hashing.js';
import { clearLoginFailures, loginBlocked, recordLoginFailure } from '../security.js';
import { persistState, users } from '../state.js';

// Account creation and sign-in. Sessions are bearer tokens; only their hash is
// stored, and failures are throttled per source address in security.ts.
app.post<{ Body: { email: string; password: string } }>('/api/auth/register', async (request, reply) => {
  const { email, password } = request.body ?? {};
  if (!email || !password || password.length < 8) return reply.code(400).send({ error: 'email_and_8_char_password_required' });
  if (users.has(email)) return reply.code(409).send({ error: 'user_exists' });
  const token = randomBytes(32).toString('hex');
  users.set(email, { password: hash(password), tokenHash: hash(token) });
  persistState();
  return { token };
});

app.post<{ Body: { email: string; password: string } }>('/api/auth/login', async (request, reply) => {
  const blocked = loginBlocked(request);
  if (blocked.blocked) {
    reply.header('retry-after', String(blocked.retryAfter));
    return reply.code(429).send({ error: 'login_rate_limited', retry_after: blocked.retryAfter });
  }
  const user = users.get(request.body?.email);
  if (!user || !valid(request.body?.password ?? '', user.password)) {
    recordLoginFailure(request);
    return reply.code(401).send({ error: 'invalid_credentials' });
  }
  clearLoginFailures(request);
  const token = randomBytes(32).toString('hex');
  user.tokenHash = hash(token);
  persistState();
  return { token };
});
