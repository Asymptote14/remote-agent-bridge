// Live smoke test with the REAL agent binary: boots gateway + agent with an
// isolated RAB_DATA_DIR, then exercises pair -> bind -> reconnect -> task.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePort } from './helpers.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const dataDir = mkdtempSync(join(tmpdir(), 'rab-live-'));
// A hardcoded port made this fail whenever anything else held it.
const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const env = { ...process.env, RAB_DATA_DIR: dataDir };

const sleep = ms => new Promise(r => setTimeout(r, ms));
// Predicates may be sync or async, and may throw while the thing they wait for
// does not exist yet: awaiting a sync predicate and calling .catch on its
// result is what broke this script, so tolerate both shapes here.
async function waitFor(fn, timeout = 15_000, label = 'condition') {
  const deadline = Date.now() + timeout;
  for (;;) {
    let value;
    try { value = await fn(); } catch { value = undefined; }
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}`);
    await sleep(150);
  }
}
// Privileged setup endpoints require the operator's setup token, which lives
// in the data directory on this machine.
let setupToken = '';
async function api(path, { method = 'GET', token, body, setup = false } = {}) {
  const r = await fetch(base + path, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(setup && setupToken ? { 'x-rab-setup-token': setupToken } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, data: await r.json().catch(() => ({})) };
}

const gateway = spawn(process.execPath, [join(root, 'apps/gateway/dist/index.js')], {
  env: { ...env, GATEWAY_PORT: String(port), GATEWAY_HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'pipe'],
});
const agent = spawn(process.execPath, [join(root, 'services/agent/dist/index.js')], {
  env: { ...env, GATEWAY_URL: `ws://127.0.0.1:${port}/agent` }, stdio: ['ignore', 'pipe', 'pipe'],
});
let agentLog = '';
agent.stdout.on('data', d => { agentLog += d.toString(); });
agent.stderr.on('data', d => { agentLog += d.toString(); });
gateway.stdout.resume(); gateway.stderr.resume();

try {
  await waitFor(async () => (await fetch(`${base}/health`)).ok, 15_000, 'gateway up');
  await waitFor(async () => (await api('/health')).data.agentOnline, 15_000, 'agent online');
  console.log('1. agent connected                : OK');

  // Read the operator setup token the Gateway created in the data directory.
  setupToken = await waitFor(() => {
    try {
      const value = readFileSync(join(dataDir, 'setup-token'), 'utf8').trim();
      return value.length >= 32 ? value : undefined;
    } catch { return undefined; }
  }, 10_000, 'setup token');

  const reg = await api('/api/auth/register', { method: 'POST', body: { email: 'live@test.local', password: 'password123' } });
  const token = reg.data.token;
  console.log('2. user registered                :', reg.status === 200 || reg.status === 201 ? 'OK' : `FAIL ${reg.status}`);

  const renew = await api('/api/setup/pairing/renew', { method: 'POST', setup: true });
  if (renew.status !== 200) throw new Error(`pairing renew failed: ${renew.status} ${JSON.stringify(renew.data)}`);
  const auth = await api('/api/pairings/authorize', { method: 'POST', token, body: { code: renew.data.code } });
  console.log('3. pairing authorized             :', auth.data.authorized ? 'OK' : `FAIL ${JSON.stringify(auth.data)}`);

  // The real fix under test: the agent must come back authenticated on its own.
  await waitFor(async () => {
    const s = await api('/api/sessions', { method: 'POST', token, body: { provider_id: 'local', title: 'live' } });
    return s.status === 200 ? s.data.session : undefined;
  }, 15_000, 'agent reconnected and accepted a session');
  console.log('4. agent auto-reconnected (no restart): OK');

  const session = await api('/api/sessions', { method: 'POST', token, body: { provider_id: 'local', title: 'live' } });
  const taskId = 'live-task-1';
  await api('/api/tasks', { method: 'POST', token, body: { task_id: taskId, input: '现在几点', provider_id: 'local', session_id: session.data.session.id, mode: 'isolated' } });
  const events = await waitFor(async () => {
    const r = await api(`/api/tasks/${taskId}/events`, { token });
    return r.data?.some(e => e.state === 'succeeded') ? r.data : undefined;
  }, 20_000, 'task succeeded');
  console.log('5. task round trip                :', events.map(e => e.state).join(' -> '));
  console.log('   result                         :', events.at(-1).message.slice(0, 60));
  console.log('6. agent reconnect log            :', /Reconnecting to authenticate/.test(agentLog) ? 'OK' : 'MISSING');
} catch (error) {
  console.error('LIVE SMOKE FAILED:', error.message);
  console.error('--- agent log ---\n' + agentLog.slice(-1500));
  process.exitCode = 1;
} finally {
  agent.kill(); gateway.kill();
  await Promise.all([once(agent, 'exit').catch(() => {}), once(gateway, 'exit').catch(() => {})]);
  rmSync(dataDir, { recursive: true, force: true });
}
