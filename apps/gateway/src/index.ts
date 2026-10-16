import Fastify from 'fastify';
import { WebSocketServer, WebSocket } from 'ws';
import {
  envelope,
  type AgentProviderInfo,
  type AgentSession,
  type Envelope,
  type SessionCreate,
  type SessionEvent,
  type SessionSwitch,
  type ConversationMessage,
  type TaskEvent,
  type TaskCreate,
  type TaskState,
} from '@rab/protocol';
import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { getProviderConfigPath, readProviderConfigs, readRuntimeConfig, writeProviderConfigs, writeRuntimeConfig, dataDir, readSetupToken, validSetupToken, type ProviderConfig, type RuntimeConfig } from '@rab/config';

const savedConfig = readRuntimeConfig();
const port = Number(process.env.GATEWAY_PORT ?? savedConfig.port);
const host = process.env.GATEWAY_HOST ?? savedConfig.host;
const app = Fastify({ logger: true });
let agent: WebSocket | undefined;
let agentInfo: {
  device_id: string;
  platform: string;
  interaction_mode: string;
  capabilities: string[];
  providers: AgentProviderInfo[];
} | undefined;
let connectionDeviceId: string | undefined;
/** Whether the socket currently holding the agent slot proved its device token. */
let connectionAuthenticated = false;
/** Whether the socket holding the agent slot proved it runs on this machine. */
let connectionLocal = false;

type DeviceRecord = { name: string; platform: string; online: boolean; owner?: string; pairing?: string; auth_token_hash?: string };
type SessionRecord = { session: AgentSession; owner: string; messages: ConversationMessage[] };
type UserRecord = { password: string; tokenHash: string };
type PersistedUser = { password: string; token_hash?: string; token?: string };
type TaskRecord = {
  owner: string;
  session_id?: string;
  created_at: number;
  updated_at: number;
  events: TaskEvent[];
};
type PersistedState = {
  users: Array<[string, PersistedUser]>;
  devices: Array<[string, DeviceRecord]>;
  sessions: Array<[string, SessionRecord]>;
  tasks?: Array<[string, TaskRecord]>;
};
const statePath = join(dataDir, 'state.json');
const users = new Map<string, UserRecord>();
const devices = new Map<string, DeviceRecord>();
const pairings = new Map<string, { deviceId: string; expires: number }>();
const pairingAttempts = new Map<string, { count: number; resetAt: number }>();
const sessions = new Map<string, SessionRecord>();
const pendingSessionOwners = new Map<string, string>();
/** Session/operation responses are correlated by the envelope request_id. */
type PendingCommand = {
  resolve: (event: SessionEvent) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};
const pendingCommands = new Map<string, PendingCommand>();
/**
 * Task records are persisted rather than held in memory only. The phone polls
 * `/api/tasks/:id/events` for a result, so losing these on restart turned every
 * in-flight task into a 404 the client could never resolve.
 */
const tasks = new Map<string, TaskRecord>();
const TERMINAL_TASK_STATES: TaskState[] = ['succeeded', 'failed', 'cancelled'];
/** Terminal tasks stay readable long enough for a phone to collect the result. */
const TASK_EVENT_TTL_MS = 24 * 60 * 60_000;
/**
 * Backstop for a task the Agent never reports on at all — it crashed, or the
 * device was revoked mid-run. Without this the phone polls forever. The Agent
 * caps a single task at two hours, so six is comfortably past any live task.
 */
const TASK_ABANDONED_MS = 6 * 60 * 60_000;
/** Bound the persisted history so the state file cannot grow without limit. */
const MAX_PERSISTED_TASKS = 200;
const PAIRING_ATTEMPT_TTL_MS = 10 * 60_000;

const lastTaskEvent = (record: TaskRecord): TaskEvent | undefined => record.events[record.events.length - 1];
const isTaskFinished = (record: TaskRecord): boolean => {
  const last = lastTaskEvent(record);
  return !!last && TERMINAL_TASK_STATES.includes(last.state);
};

function sweepExpired() {
  const now = Date.now();
  for (const [taskId, entry] of tasks) {
    if (isTaskFinished(entry)) {
      // Reclaim only once the result has had time to be collected.
      if (now - entry.updated_at > TASK_EVENT_TTL_MS) tasks.delete(taskId);
      continue;
    }
    // Still in flight: never reclaim it on age alone, because its terminal
    // event is what releases the phone's pending entry. Close it out instead if
    // nothing has reported on it for long enough that nothing ever will.
    if (now - entry.created_at > TASK_ABANDONED_MS) {
      entry.events.push({
        task_id: taskId,
        state: 'failed',
        message: '[task_abandoned] 超过 6 小时没有收到任何结果，判定任务已丢失（Agent 可能已退出或设备被撤销）。',
        session_id: entry.session_id,
      });
      entry.events = entry.events.slice(-20);
      entry.updated_at = now;
    }
  }
  for (const [key, entry] of pairingAttempts) {
    if (entry.resetAt < now - PAIRING_ATTEMPT_TTL_MS) pairingAttempts.delete(key);
  }
  for (const [code, pairing] of pairings) {
    if (pairing.expires < now - 60_000) pairings.delete(code);
  }
}
setInterval(sweepExpired, 60_000).unref();

// Create the setup token eagerly so the operator (and the launcher, which reads
// it from the data directory) can obtain it without a privileged request first.
readSetupToken();

const hash = (value: string, salt = randomBytes(16).toString('hex')) => `${salt}:${scryptSync(value, salt, 32).toString('hex')}`;
/** Per-IP failure tracking for the login endpoint (5 failures / 5 minutes). */
const loginAttempts = new Map<string, { count: number; resetAt: number }>();
const loginLocks = new Map<string, number>();
const LOGIN_MAX_FAILURES = 5;
const LOGIN_WINDOW_MS = 5 * 60_000;
const LOGIN_LOCK_MS = 10 * 60_000;

function loginKey(request: { ip?: string }): string {
  return request.ip || 'unknown';
}
function loginBlocked(request: { ip?: string }): { blocked: boolean; retryAfter?: number } {
  const key = loginKey(request);
  const lockedUntil = loginLocks.get(key);
  const now = Date.now();
  if (lockedUntil && lockedUntil > now) return { blocked: true, retryAfter: Math.ceil((lockedUntil - now) / 1000) };
  if (lockedUntil) loginLocks.delete(key);
  return { blocked: false };
}
function recordLoginFailure(request: { ip?: string }) {
  const key = loginKey(request);
  const now = Date.now();
  const current = loginAttempts.get(key);
  if (!current || current.resetAt <= now) loginAttempts.set(key, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
  else current.count += 1;
  if (current && current.count >= LOGIN_MAX_FAILURES) {
    loginLocks.set(key, now + LOGIN_LOCK_MS);
    loginAttempts.delete(key);
  }
}
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of loginAttempts) if (entry.resetAt < now) loginAttempts.delete(key);
  for (const [key, until] of loginLocks) if (until < now) loginLocks.delete(key);
}, 60_000).unref();
const valid = (value: string, stored: string) => {
  const [salt, digest] = stored.split(':');
  if (!salt || !digest || !/^[0-9a-f]+$/i.test(digest) || digest.length % 2 !== 0) return false;
  const expected = Buffer.from(digest, 'hex');
  const actual = scryptSync(value, salt, expected.length);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
};
let stateDirty = false;

if (existsSync(statePath)) {
  try {
    const state = JSON.parse(readFileSync(statePath, 'utf8')) as Partial<PersistedState>;
    for (const [id, user] of state.users ?? []) {
      const tokenHash = user.token_hash || (user.token ? hash(user.token) : '');
      if (user.password && tokenHash) {
        users.set(id, { password: user.password, tokenHash });
        if (!user.token_hash) stateDirty = true;
      }
    }
    for (const [id, device] of state.devices ?? []) devices.set(id, { ...device, online: false, pairing: undefined });
    for (const [id, session] of state.sessions ?? []) sessions.set(id, { ...session, messages: session.messages ?? [] });
    for (const [id, record] of state.tasks ?? []) {
      if (!record || typeof record.owner !== 'string') continue;
      const createdAt = Number(record.created_at) || Date.now();
      tasks.set(id, {
        owner: record.owner,
        session_id: record.session_id,
        created_at: createdAt,
        updated_at: Number(record.updated_at) || createdAt,
        events: Array.isArray(record.events) ? record.events.slice(-20) : [],
      });
    }
  } catch { /* Start with an empty state if the local file is damaged. */ }
}

// A task that was still in flight when this process stopped will never be
// reported on: the Agent's queue and its running child process live in the
// Agent's own memory, and a restarted Agent has no idea the task existed.
// Close these out so the phone stops polling for a result that cannot arrive.
for (const [id, record] of tasks) {
  if (isTaskFinished(record)) continue;
  record.events.push({
    task_id: id,
    state: 'failed',
    message: '[gateway_restart] Gateway 在任务执行期间重启，任务结果未知。',
    session_id: record.session_id,
  });
  record.events = record.events.slice(-20);
  record.updated_at = Date.now();
  stateDirty = true;
}

function persistState() {
  mkdirSync(dataDir, { recursive: true });
  // Newest first, then bounded, so the persisted history stays a fixed size
  // however long the Gateway runs.
  const persistedTasks = [...tasks.entries()]
    .sort(([, a], [, b]) => b.updated_at - a.updated_at)
    .slice(0, MAX_PERSISTED_TASKS);
  const state: PersistedState = {
    users: [...users.entries()].map(([id, user]) => [id, { password: user.password, token_hash: user.tokenHash }]),
    devices: [...devices.entries()].map(([id, device]) => [id, { ...device, online: false, pairing: undefined }]),
    sessions: [...sessions.entries()],
    tasks: persistedTasks,
  };
  const temporaryPath = `${statePath}.tmp`;
  writeFileSync(temporaryPath, JSON.stringify(state, null, 2), 'utf8');
  try { chmodSync(temporaryPath, 0o600); } catch { /* Windows may ignore POSIX file modes. */ }
  renameSync(temporaryPath, statePath);
}
if (stateDirty) persistState();
const auth = (request: { headers: Record<string, string | string[] | undefined> }) => {
  const token = String(request.headers.authorization ?? '').replace(/^Bearer /, '');
  return [...users.entries()].find(([, user]) => valid(token, user.tokenHash))?.[0];
};
function publicDevice(id: string, device: DeviceRecord) {
  return { id, name: device.name, platform: device.platform, online: device.online, owner: device.owner };
}
const isLoopback = (request: { ip?: string }) => request.ip === '127.0.0.1' || request.ip === '::1' || request.ip === '::ffff:127.0.0.1';

/**
 * Loopback alone does NOT prove locality, because the tunnel clients this
 * project supports forward to 127.0.0.1 — so every request that crosses a
 * tunnel arrives looking local. Privileged setup endpoints (pairing, provider
 * file paths, network config) additionally require the setup token, which
 * only a process that can read the data directory on this machine has.
 * Browser requests carry it in `x-rab-setup-token`; the operator can read it
 * from `<dataDir>/setup-token` or see it on the local setup page.
 */
function requireLocalOperator(request: { ip?: string; headers: Record<string, string | string[] | undefined> }, reply: { code: (status: number) => { send: (body: unknown) => unknown } }): boolean {
  if (!isLoopback(request)) {
    reply.code(403).send({ error: 'setup_is_local_only' });
    return false;
  }
  const presented = String(request.headers['x-rab-setup-token'] ?? '').trim();
  if (!validSetupToken(presented)) {
    reply.code(403).send({ error: 'setup_token_required', hint: `Open http://127.0.0.1:${port}/setup on this computer to load the setup token, or send it in the x-rab-setup-token header.` });
    return false;
  }
  return true;
}

/** Loopback check only. Never a security boundary on its own — see requireLocalOperator. */
const localOnly = isLoopback;

function lanAccessUrls(): string[] {
  const addresses = new Set<string>();
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) addresses.add(`http://${entry.address}:${port}`);
    }
  }
  return [...addresses].sort();
}

/** Sakura tunnel traffic crosses the public internet, so plain HTTP is never accepted. */
const publicUrlHttpsEnforced = true;

function accessUrls(): string[] {
  const config = readRuntimeConfig();
  if (config.networkMode === 'local') return [`http://127.0.0.1:${port}`];
  if (config.networkMode === 'sakura' && config.publicUrl) {
    const normalized = config.publicUrl.replace(/\/$/, '');
    if (publicUrlHttpsEnforced && !/^https:\/\//i.test(normalized)) return [`http://127.0.0.1:${port}`];
    return [normalized];
  }
  if (config.networkMode === 'lan') return lanAccessUrls();
  return [`http://127.0.0.1:${port}`];
}

function workBuddyCandidates() {
  const roots = [
    process.env.WORKBUDDY_HOME,
    'C:\\workbuddy',
    'D:\\workbuddy',
    'E:\\workbuddy',
    'F:\\workbuddy',
    'G:\\workbuddy',
    join(process.env.LOCALAPPDATA || '', 'WorkBuddy'),
    join(process.env.LOCALAPPDATA || '', 'Programs', 'WorkBuddy'),
    join(process.env.ProgramFiles || '', 'WorkBuddy'),
  ].filter(Boolean) as string[];
  const result: Array<{ installPath: string; executable: string; runtime: string; version?: string }> = [];
  const seen = new Set<string>();
  for (const root of roots) {
    const installPath = root.replace(/[\\/]$/, '');
    const workbuddyExe = join(installPath, 'WorkBuddy.exe');
    const cli = join(installPath, 'resources', 'app.asar.unpacked', 'cli', 'bin', 'codebuddy');
    if (!existsSync(cli) || seen.has(cli.toLowerCase())) continue;
    seen.add(cli.toLowerCase());
    const versionPath = join(installPath, 'resources', 'app.asar.unpacked', 'cli', 'package.json');
    let version: string | undefined;
    try {
      const pkg = JSON.parse(readFileSync(versionPath, 'utf8')) as { publishConfig?: { customPackage?: { version?: string } }; version?: string };
      version = pkg.publishConfig?.customPackage?.version || pkg.version;
    } catch { /* Version is optional. */ }
    result.push({ installPath, executable: existsSync(workbuddyExe) ? workbuddyExe : cli, runtime: process.execPath, version });
  }
  return result;
}

function codexCandidates() {
  const configured = process.env.CODEX_CLI_PATH;
  const fixedCandidates = [
    configured,
    join(process.env.LOCALAPPDATA || '', 'OpenAI', 'Codex', 'bin', 'codex.exe'),
    'C:\\Program Files\\OpenAI\\Codex\\codex.exe',
  ].filter(Boolean) as string[];
  const versionedCandidates: string[] = [];
  const codexBin = join(process.env.LOCALAPPDATA || '', 'OpenAI', 'Codex', 'bin');
  try {
    for (const entry of readdirSync(codexBin, { withFileTypes: true })) {
      if (entry.isDirectory()) versionedCandidates.push(join(codexBin, entry.name, 'codex.exe'));
    }
  } catch { /* The installation directory may not exist. */ }
  const candidates = [...fixedCandidates, ...versionedCandidates];
  const seen = new Set<string>();
  return candidates.filter(executable => {
    const key = executable.toLowerCase();
    if (seen.has(key) || !existsSync(executable)) return false;
    seen.add(key);
    return true;
  }).map(executable => ({ executable, runtime: process.execPath }));
}

function issuePairing(deviceId: string): { code: string; expires_in: number } | undefined {
  const now = Date.now();
  for (const [code, pairing] of pairings) if (pairing.expires <= now) pairings.delete(code);
  const device = devices.get(deviceId);
  if (!device) return undefined;
  if (device.pairing) pairings.delete(device.pairing);
  const code = String(Math.floor(100000 + Math.random() * 900000));
  device.pairing = code;
  pairings.set(code, { deviceId, expires: Date.now() + 60_000 });
  // The pairing code is no longer pushed over the Agent WebSocket. It stays on
  // the Gateway until the operator fetches it from the local /setup page.
  app.log.info({ device_id: deviceId }, 'pairing code issued (visible on local /setup page only)');
  return { code, expires_in: 60 };
}

function originFor(request: { headers: Record<string, string | string[] | undefined> }): string {
  return String(request.headers.origin ?? '').replace(/\/$/, '');
}

function isAllowedOrigin(request: { headers: Record<string, string | string[] | undefined> }): boolean {
  const origin = originFor(request);
  if (!origin) return true;
  const hostHeader = String(request.headers.host ?? '').trim();
  const configured = readRuntimeConfig().publicUrl.trim().replace(/\/$/, '');
  return origin === `http://${hostHeader}` || origin === `https://${hostHeader}` ||
    (configured.length > 0 && origin === configured) ||
    origin === `http://127.0.0.1:${port}` || origin === `https://127.0.0.1:${port}` ||
    origin === `http://localhost:${port}` || origin === `https://localhost:${port}`;
}

function pairingAttemptKey(request: { ip?: string }): string {
  return request.ip || 'unknown';
}

function canTryPairing(request: { ip?: string }): { allowed: boolean; retryAfter?: number } {
  const now = Date.now();
  const key = pairingAttemptKey(request);
  const current = pairingAttempts.get(key);
  if (!current || current.resetAt <= now) {
    pairingAttempts.set(key, { count: 0, resetAt: now + 5 * 60_000 });
    return { allowed: true };
  }
  if (current.count >= 5) return { allowed: false, retryAfter: Math.ceil((current.resetAt - now) / 1000) };
  return { allowed: true };
}

function recordPairingFailure(request: { ip?: string }) {
  const now = Date.now();
  const key = pairingAttemptKey(request);
  const current = pairingAttempts.get(key);
  if (!current || current.resetAt <= now) pairingAttempts.set(key, { count: 1, resetAt: now + 5 * 60_000 });
  else current.count += 1;
}

app.addHook('onRequest', async (request, reply) => {
  const origin = originFor(request);
  if (origin && !isAllowedOrigin(request)) {
    if (request.method === 'OPTIONS') return reply.code(403).send({ error: 'origin_not_allowed' });
    return reply.code(403).send({ error: 'origin_not_allowed' });
  }
  // Minimal hardening headers for every browser-facing response.
  reply.header('x-content-type-options', 'nosniff');
  reply.header('referrer-policy', 'no-referrer');
  reply.header('x-frame-options', 'DENY');
  reply.header('content-security-policy', "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'");
  if (origin) {
    reply.header('access-control-allow-origin', origin);
    reply.header('vary', 'Origin');
    reply.header('access-control-allow-headers', 'content-type, authorization, x-rab-setup-token');
    reply.header('access-control-allow-methods', 'GET,POST,DELETE,OPTIONS');
  }
  if (request.method === 'OPTIONS') return reply.code(204).send();
});

/** Only a bound (paired) agent may receive commands or tasks. Unbound
 * connections stay blind: the plan requires they receive no data at all. */
function isAgentBound() {
  return Boolean(agent && agent.readyState === WebSocket.OPEN && connectionDeviceId && devices.get(connectionDeviceId)?.auth_token_hash);
}

function requireAgent(reply: { code: (status: number) => { send: (body: unknown) => unknown } }) {
  if (!isAgentBound()) {
    reply.code(503).send({ error: 'agent_offline' });
    return false;
  }
  return true;
}

function sendSessionCommand(requestId: string, type: 'session.create' | 'session.switch', payload: SessionCreate | SessionSwitch): Promise<SessionEvent> {
  return new Promise((resolve, reject) => {
    if (!isAgentBound()) {
      reject(new Error('agent_offline'));
      return;
    }
    const timer = setTimeout(() => {
      pendingCommands.delete(requestId);
      reject(new Error('session_operation_timeout'));
    }, 5_000);
    pendingCommands.set(requestId, { resolve, reject, timer });
    agent!.send(JSON.stringify(envelope(type, payload, requestId)));
  });
}

app.get('/health', async () => ({
  ok: true,
  agentOnline: agent?.readyState === WebSocket.OPEN,
  agent: agentInfo,
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
app.get('/api/setup/status', async (request, reply) => {
  if (!requireLocalOperator(request, reply)) return;
  const device = connectionDeviceId ? devices.get(connectionDeviceId) : undefined;
  const pairing = device?.pairing ? pairings.get(device.pairing) : undefined;
  return {
    config: { ...readRuntimeConfig(), port, host },
    gateway: { host, port, url: accessUrls()[0] ?? `http://127.0.0.1:${port}`, access_urls: accessUrls(), public_url_https_enforced: publicUrlHttpsEnforced },
    warnings: readRuntimeConfig().networkMode === 'sakura' && readRuntimeConfig().publicUrl && !/^https:\/\//i.test(readRuntimeConfig().publicUrl.replace(/\/$/, ''))
      ? ['sakura_public_url_must_use_https']
      : [],
    provider_config: { path: getProviderConfigPath(), environment_override: Boolean(process.env.RAB_PROVIDERS_FILE) },
    agent: { online: agent?.readyState === WebSocket.OPEN, device_id: connectionDeviceId, device_name: device?.name, platform: device?.platform },
    pairing: pairing && pairing.expires > Date.now() ? { code: device?.pairing, expires_at: pairing.expires } : undefined,
  };
});
app.post<{ Body: Partial<RuntimeConfig> }>('/api/setup/config', async (request, reply) => {
  if (!requireLocalOperator(request, reply)) return;
  const before = readRuntimeConfig();
  const previousProviders = readProviderConfigs();
  const submitted = request.body ?? {};
  // Sakura tunnels relay traffic over the public internet: reject plain http:// URLs.
  if ((submitted.networkMode ?? before.networkMode) === 'sakura' && typeof submitted.publicUrl === 'string' && submitted.publicUrl.trim() && !/^https:\/\//i.test(submitted.publicUrl.trim())) {
    return reply.code(400).send({ error: 'sakura_public_url_must_use_https' });
  }
  const next = writeRuntimeConfig(submitted);
  if (next.providersFile !== before.providersFile && !existsSync(next.providersFile)) {
    mkdirSync(join(next.providersFile, '..'), { recursive: true });
    writeFileSync(next.providersFile, JSON.stringify(previousProviders, null, 2), { encoding: 'utf8', mode: 0o600 });
    try { chmodSync(next.providersFile, 0o600); } catch { /* Windows may ignore POSIX file modes. */ }
  }
  if (connectionDeviceId) {
    const device = devices.get(connectionDeviceId);
    if (device) device.name = next.deviceName;
  }
  return { saved: true, restart_required: next.host !== host || next.port !== port || next.providersFile !== before.providersFile, config: next };
});
app.post('/api/setup/pairing/renew', async (request, reply) => {
  if (!requireLocalOperator(request, reply)) return;
  if (!agent || agent.readyState !== WebSocket.OPEN || !connectionDeviceId) return reply.code(503).send({ error: 'agent_offline' });
  // Only ever mint a code for a device that is either already authenticated or
  // proven to be this machine's own Agent. Otherwise a remote peer that holds
  // the slot would receive the pairing code that the operator then authorizes,
  // binding the operator's computer to the attacker.
  if (!connectionAuthenticated && !connectionLocal) {
    return reply.code(409).send({ error: 'agent_not_trusted', hint: 'The connected device has not proven it runs on this machine. Restart the local Agent.' });
  }
  return issuePairing(connectionDeviceId);
});

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
  loginAttempts.delete(loginKey(request));
  const token = randomBytes(32).toString('hex');
  user.tokenHash = hash(token);
  persistState();
  return { token };
});

app.get('/api/providers', async (request, reply) => {
  if (!auth(request)) return reply.code(401).send({ error: 'unauthorized' });
  return agentInfo?.providers ?? [];
});

app.get('/api/setup/providers', async (request, reply) => {
  if (!requireLocalOperator(request, reply)) return;
  return readProviderConfigs().map(item => ({ ...item, token: item.token ? '••••••••' : '' }));
});
app.get('/api/setup/workbuddy/detect', async (request, reply) => {
  if (!requireLocalOperator(request, reply)) return;
  return { detected: workBuddyCandidates(), runtime: process.execPath };
});
app.get('/api/setup/codex/detect', async (request, reply) => {
  if (!requireLocalOperator(request, reply)) return;
  return { detected: codexCandidates() };
});
app.post<{ Body: ProviderConfig }>('/api/setup/providers', async (request, reply) => {
  if (!requireLocalOperator(request, reply)) return;
  const input = request.body ?? {} as ProviderConfig;
  const transport = input.transport;
  if (!input.id || !input.name || !['http', 'cli'].includes(transport)) return reply.code(400).send({ error: 'provider_requires_id_name_and_supported_transport' });
  if (transport === 'http' && !input.endpoint) return reply.code(400).send({ error: 'http_provider_requires_endpoint' });
  if (transport === 'cli' && !input.executable) return reply.code(400).send({ error: 'cli_provider_requires_executable' });
  const items = readProviderConfigs().filter(item => item.id !== input.id);
  const old = readProviderConfigs().find(item => item.id === input.id);
  items.push({
    ...old,
    id: input.id.trim(),
    name: input.name.trim(),
    adapter: input.adapter?.trim() || old?.adapter || (input.id.trim() === 'workbuddy' ? 'workbuddy' : undefined),
    transport,
    endpoint: input.endpoint?.trim(),
    executable: input.executable?.trim(),
    runtime: input.runtime?.trim(),
    cwd: input.cwd?.trim(),
    permissionMode: input.permissionMode || 'auto',
    sandboxMode: input.sandboxMode || old?.sandboxMode,
    token: input.token?.replace(/^•+$/, '') || old?.token || undefined,
    enabled: input.enabled !== false,
  });
  writeProviderConfigs(items);
  return { saved: true, restart_required: true };
});
app.delete<{ Params: { id: string } }>('/api/setup/providers/:id', async (request, reply) => {
  if (!requireLocalOperator(request, reply)) return;
  writeProviderConfigs(readProviderConfigs().filter(item => item.id !== request.params.id));
  return { deleted: true, restart_required: true };
});

app.get('/api/devices', async (request, reply) => {
  const user = auth(request);
  if (!user) return reply.code(401).send({ error: 'unauthorized' });
  return [...devices.entries()]
    .filter(([, device]) => device.owner === user)
    .map(([id, device]) => publicDevice(id, device));
});

app.post<{ Body: { code: string } }>('/api/pairings/authorize', async (request, reply) => {
  const rate = canTryPairing(request);
  if (!rate.allowed) {
    reply.header('retry-after', String(rate.retryAfter));
    return reply.code(429).send({ error: 'pairing_rate_limited', retry_after: rate.retryAfter });
  }
  const user = auth(request);
  const code = String(request.body?.code ?? '').trim();
  const pairing = /^\d{6}$/.test(code) ? pairings.get(code) : undefined;
  if (!user || !pairing || pairing.expires < Date.now()) {
    recordPairingFailure(request);
    return reply.code(401).send({ error: 'invalid_pairing' });
  }
  const device = devices.get(pairing.deviceId)!;
  device.owner = user;
  device.pairing = undefined;
  const deviceToken = randomBytes(32).toString('hex');
  device.auth_token_hash = hash(deviceToken);
  pairings.delete(code);
  pairingAttempts.delete(pairingAttemptKey(request));
  persistState();
  // Hand the fresh device token to the connected Agent (if any) so binding
  // survives restarts. This is the only moment the raw token is transmitted.
  if (agent?.readyState === WebSocket.OPEN && connectionDeviceId === pairing.deviceId) {
    agent.send(JSON.stringify(envelope('device.bound', { device_id: pairing.deviceId, token: deviceToken })));
  }
  return { authorized: true, device: publicDevice(pairing.deviceId, device) };
});

app.post<{ Params: { id: string } }>('/api/devices/:id/revoke', async (request, reply) => {
  const user = auth(request);
  const device = devices.get(request.params.id);
  if (!user || !device || device.owner !== user) return reply.code(404).send({ error: 'device_not_found' });
  device.owner = undefined;
  device.online = false;
  device.auth_token_hash = undefined;
  // Drop the live Agent connection so a revoked device cannot keep using it.
  if (agent?.readyState === WebSocket.OPEN && connectionDeviceId === request.params.id) {
    agent.close(1008, 'device_revoked');
    agent = undefined;
    agentInfo = undefined;
  }
  persistState();
  return { revoked: true };
});

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
  agent!.send(JSON.stringify(envelope('agent.task', { ...task, mode: task.mode ?? 'isolated' })));
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

await app.listen({ port, host });
const wss = new WebSocketServer({ server: app.server, path: '/agent', verifyClient: (info: { origin: string; secure: boolean; req: IncomingMessage }) => {
  const origin = String(info.req.headers.origin ?? '');
  if (!origin) return true;
  const hostHeader = String(info.req.headers.host ?? '').trim();
  const configured = readRuntimeConfig().publicUrl.trim().replace(/\/$/, '');
  return origin === `http://${hostHeader}` || origin === `https://${hostHeader}` ||
    (configured.length > 0 && origin === configured) ||
    origin === `http://127.0.0.1:${port}` || origin === `https://127.0.0.1:${port}` ||
    origin === `http://localhost:${port}` || origin === `https://localhost:${port}`;
} });
wss.on('connection', socket => {
  // Handshake state: nothing is accepted from this socket until agent.hello
  // proves possession of the bound device token (or the device is brand new).
  let handshakePassed = false;
  let socketDeviceId: string | undefined;
  let socketAuthenticated = false;
  socket.on('message', data => {
    try {
      const event = JSON.parse(data.toString()) as Envelope<{
        device_id: string;
        platform: string;
        interaction_mode: string;
        capabilities: string[];
        providers?: AgentProviderInfo[];
        device_token?: string;
        /** Proves the peer can read this machine's data directory. */
        local_proof?: string;
      } | SessionEvent | TaskEvent>;
      if (event.type === 'agent.hello') {
        if (handshakePassed) return;
        const hello = event.payload as { device_id: string; device_token?: string; local_proof?: string; platform: string; interaction_mode: string; capabilities: string[]; providers?: AgentProviderInfo[] };
        if (!hello.device_id || typeof hello.device_id !== 'string') {
          socket.close(1008, 'device_identity_invalid');
          return;
        }
        const existingDevice = devices.get(hello.device_id);
        // A device that has already been bound MUST present the matching
        // token; anything else is rejected. An unbound device may connect but
        // stays unauthenticated: it never receives data until the local
        // operator binds it via the local /setup page.
        socketAuthenticated = Boolean(existingDevice?.auth_token_hash && hello.device_token && valid(hello.device_token, existingDevice.auth_token_hash));
        if (existingDevice?.auth_token_hash && !socketAuthenticated) {
          socket.close(1008, 'device_identity_invalid');
          return;
        }
        // The Agent always runs on this machine and can therefore read the
        // setup token from the data directory; a peer that reaches the Gateway
        // across a tunnel cannot. Without this check a remote peer could
        // connect first, hold the single agent slot, and be the device the
        // operator ends up pairing — handing it the device token.
        const localProof = String(hello.local_proof ?? '');
        const socketLocal = Boolean(localProof) && validSetupToken(localProof);
        if (!socketAuthenticated && !socketLocal) {
          socket.close(1008, 'local_proof_required');
          return;
        }
        // Slot arbitration. Every connection that got this far is either
        // authenticated (it proved a device token) or local (it proved it can
        // read this machine's data dir); a remote peer with neither was already
        // refused above. A newcomer may take the slot when:
        //   - it proved a device token, or
        //   - it is the local Agent and the incumbent is not authenticated.
        // The second case matters because a restarted Agent has no token yet on
        // first run, and it must still be able to reclaim the slot from an
        // unauthenticated peer. An authenticated incumbent is never displaced
        // by a different device id, so one device cannot shadow another.
        const replacesIncumbent = socketAuthenticated || (socketLocal && !connectionAuthenticated);
        if (agent && agent.readyState === WebSocket.OPEN) {
          const sameDevice = connectionDeviceId === hello.device_id;
          if (sameDevice || replacesIncumbent) {
            agent.close(1000, socketAuthenticated ? 'superseded_by_reconnect' : 'superseded_by_local_agent');
          } else {
            socket.close(1008, 'agent_already_connected');
            return;
          }
        }
        handshakePassed = true;
        connectionAuthenticated = socketAuthenticated;
        connectionLocal = socketLocal;
        agent = socket;
        // Store only the fields we need. Never keep or expose the raw
        // device_token (it arrives in hello but must not leak into /health).
        agentInfo = {
          device_id: hello.device_id,
          platform: hello.platform,
          interaction_mode: hello.interaction_mode,
          capabilities: hello.capabilities,
          providers: hello.providers ?? [],
        };
        socketDeviceId = hello.device_id;
        connectionDeviceId = hello.device_id;
        const device = existingDevice ?? { name: readRuntimeConfig().deviceName, platform: hello.platform, online: true };
        device.platform = hello.platform;
        device.online = true;
        devices.set(connectionDeviceId, device);
        app.log.info({ device_id: hello.device_id, authenticated: socketAuthenticated }, 'agent handshake passed');
        return;
      }
      // Every message type other than agent.hello requires a completed,
      // authenticated handshake. Unbound devices still cannot issue tasks.
      if (!handshakePassed || !socketAuthenticated) {
        socket.close(1008, 'handshake_required');
        return;
      }
      if (event.type === 'session.event') {
        const sessionEvent = event.payload as SessionEvent;
        if (sessionEvent.session) {
          const owner = pendingSessionOwners.get(sessionEvent.session.id) ?? sessions.get(sessionEvent.session.id)?.owner;
          if (owner) {
            sessions.set(sessionEvent.session.id, { session: sessionEvent.session, owner, messages: sessions.get(sessionEvent.session.id)?.messages ?? [] });
            pendingSessionOwners.delete(sessionEvent.session.id);
          }
        }
        // Correlate the response with the pending command via request_id.
        const pending = event.request_id ? pendingCommands.get(event.request_id) : undefined;
        if (pending) {
          pendingCommands.delete(event.request_id);
          clearTimeout(pending.timer);
          pending.resolve(sessionEvent);
        }
      } else if (event.type === 'task.event') {
        const taskEvent = event.payload as TaskEvent;
        let changed = false;
        const entry = tasks.get(taskEvent.task_id);
        if (entry) {
          entry.events.push(taskEvent);
          entry.events = entry.events.slice(-20);
          entry.updated_at = Date.now();
          if (taskEvent.session_id) entry.session_id = taskEvent.session_id;
          changed = true;
        }
        if (taskEvent.state === 'succeeded' && taskEvent.session_id && taskEvent.message) {
          const record = sessions.get(taskEvent.session_id);
          if (record) {
            record.messages.push({ id: randomUUID(), role: 'assistant', content: taskEvent.message, created_at: new Date().toISOString() });
            record.messages = record.messages.slice(-100);
            record.session.updated_at = new Date().toISOString();
            changed = true;
          }
        }
        if (changed) persistState();
      }
      app.log.debug({ event_type: event.type }, 'agent event');
    } catch { app.log.warn('ignored malformed agent message'); }
  });
  socket.on('close', () => {
    // Only the socket that currently holds the slot may clear slot state: a
    // socket superseded by a newer one must not mark the device offline or
    // blank its successor's authorization.
    if (agent === socket) {
      const deviceId = socketDeviceId ?? connectionDeviceId;
      const device = deviceId ? devices.get(deviceId) : undefined;
      if (device) device.online = false;
      agent = undefined;
      agentInfo = undefined;
      connectionDeviceId = undefined;
      connectionAuthenticated = false;
      connectionLocal = false;
    }
    for (const [requestId, pending] of pendingCommands) {
      clearTimeout(pending.timer);
      pending.reject(new Error('agent_disconnected'));
      pendingCommands.delete(requestId);
    }
    app.log.info('agent disconnected');
  });
});
console.log(`Gateway listening on http://${host}:${port}`);
