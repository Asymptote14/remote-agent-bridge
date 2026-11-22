// Shared test harness: a real Gateway child process on a free port with an
// isolated data directory, plus a minimal Agent that speaks the handshake and
// answers session/task traffic the way the real one does.
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import WebSocket from 'ws';

export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const gatewayEntry = join(repoRoot, 'apps', 'gateway', 'dist', 'index.js');

export function newKeyPair() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privateKey,
    publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    signatureFor(nonce) {
      return sign(null, Buffer.from(nonce, 'utf8'), privateKey).toString('base64');
    },
  };
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

export async function startGateway({ dir: existingDir, cwd = repoRoot } = {}) {
  const dir = existingDir ?? mkdtempSync(join(tmpdir(), 'rab-test-'));
  const port = await freePort();
  const child = spawn(process.execPath, [gatewayEntry], {
    cwd,
    env: {
      ...process.env, RAB_DATA_DIR: dir, RAB_CONFIG_FILE: join(dir, 'config.json'), RAB_PROVIDERS_FILE: join(dir, 'providers.json'),
      GATEWAY_HOST: '127.0.0.1', GATEWAY_PORT: String(port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`${base}/health`);
      if (response.ok) {
        return {
          dir,
          base,
          port,
          wsUrl: `ws://127.0.0.1:${port}/agent`,
          get output() { return output; },
          setupToken: readFileSync(join(dir, 'setup-token'), 'utf8').trim(),
          state: () => JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')),
          async stop({ keepData = false } = {}) {
            if (child.exitCode === null && child.signalCode === null) {
              const exited = once(child, 'exit');
              child.kill();
              await exited;
            }
            if (!keepData) rmSync(dir, { recursive: true, force: true });
          },
        };
      }
    } catch { /* not listening yet */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  child.kill();
  throw new Error(`gateway did not start: ${output}`);
}

export async function api(base, path, { method = 'GET', body, token, setupToken, headers: customHeaders } = {}) {
  const headers = { ...customHeaders };
  if (body) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  if (setupToken) headers['x-rab-setup-token'] = setupToken;
  const response = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: response.status, data, headers: response.headers };
}

export async function waitFor(predicate, timeout = 5_000, label = 'condition') {
  const started = Date.now();
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() - started > timeout) throw new Error(`timed out waiting for ${label}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

/**
 * A minimal Agent. It performs the same challenge/signature handshake as the
 * real one, records what the Gateway pushes to it, and answers session
 * commands so the HTTP layer can complete.
 */
export class DeviceClient {
  constructor(wsUrl, { deviceId, keyPair, receipts = false } = {}) {
    this.wsUrl = wsUrl;
    this.deviceId = deviceId;
    this.keyPair = keyPair;
    this.receipts = receipts;
    this.messages = [];
    this.waiters = [];
    this.tasks = [];
    this.bound = [];
    this.sessions = [];
    this.lastNonce = undefined;
    this.lastSignature = undefined;
    this.closed = new Promise(resolve => { this.resolveClosed = resolve; });
  }

  async connect() {
    this.socket = new WebSocket(this.wsUrl);
    this.socket.on('message', raw => {
      let message;
      try { message = JSON.parse(raw.toString()); } catch { return; }
      this.messages.push(message);
      for (const waiter of [...this.waiters]) {
        if (waiter.type !== message.type) continue;
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        waiter.resolve(message);
      }
      this.#react(message);
    });
    this.socket.on('close', (code, reason) => this.resolveClosed({ code, reason: String(reason) }));
    this.socket.on('error', () => {});
    await once(this.socket, 'open');
    return this;
  }

  #react(message) {
    if (message.type === 'device.bound') {
      this.bound.push(message.payload);
      return;
    }
    if (message.type === 'session.create' || message.type === 'session.switch') {
      const now = new Date().toISOString();
      const session = { id: message.payload.session_id, provider_id: message.payload.provider_id, title: message.payload.title ?? 'test session', created_at: now, updated_at: now };
      this.sessions.push(session);
      this.sendWithId('session.event', { action: message.type === 'session.create' ? 'created' : 'switched', session }, message.request_id);
      return;
    }
    if (message.type === 'agent.task') {
      this.tasks.push(message.payload);
      this.report(message.payload, 'queued', '已排队', 1);
    }
  }

  report(task, state, message, sequence) {
    this.send('task.event', {
      task_id: task.task_id, state, message, provider_id: task.provider_id ?? 'local', session_id: task.session_id,
      ...(task.dispatch_id ? { dispatch_id: task.dispatch_id, sequence } : {}),
    });
  }

  waitFor(type, timeout = 5_000) {
    const existing = this.messages.find(message => message.type === type);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const waiter = { type, resolve: value => { clearTimeout(timer); resolve(value); } };
      this.waiters.push(waiter);
      const timer = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        reject(new Error(`timed out waiting for ${type}`));
      }, timeout).unref?.();
    });
  }

  sendWithId(type, payload, requestId) {
    this.socket.send(JSON.stringify({ version: 1, type, request_id: requestId, payload }));
  }

  send(type, payload) {
    this.sendWithId(type, payload, randomUUID());
  }

  /** Ask for the nonce, then answer it (signed with our key when we have one). */
  async handshake({ localProof, token, signature, publicKey } = {}) {
    this.send('agent.challenge', {});
    const serverHello = await this.waitFor('server.hello');
    this.lastNonce = serverHello.payload.nonce;
    this.lastSignature = signature ?? this.keyPair?.signatureFor(this.lastNonce);
    this.send('agent.hello', {
      device_id: this.deviceId,
      platform: 'win32',
      interaction_mode: 'isolated',
      capabilities: ['sessions', 'create_session', 'switch_session', 'background_tasks', ...(this.receipts ? ['task_receipts_v1'] : [])],
      providers: [{ id: 'local', name: 'Local', transport: 'local', capabilities: ['sessions'], interaction_modes: ['isolated'] }],
      public_key: publicKey ?? this.keyPair?.publicKey,
      signature: this.lastSignature,
      device_token: token,
      local_proof: localProof,
    });
    return this;
  }

  close() {
    try { this.socket?.close(); } catch { /* already closed */ }
  }
}

/** Register a fresh account and return its bearer token. */
export async function registerUser(base, email) {
  const created = await api(base, '/api/auth/register', { method: 'POST', body: { email, password: 'password123' } });
  if (created.status !== 200) throw new Error(`register failed: ${JSON.stringify(created.data)}`);
  return created.data.token;
}

export async function agentOnline(gateway, deviceId) {
  const health = await api(gateway.base, '/health');
  return health.data.agentOnline && health.data.agent?.device_id === deviceId;
}

/** Connect, prove locality, pair, then reconnect with the device key only. */
export async function pairDevice(gateway, ownerToken, options) {
  const { deviceId } = options;
  const first = await new DeviceClient(gateway.wsUrl, options).connect();
  await first.handshake({ localProof: gateway.setupToken });
  await waitFor(() => agentOnline(gateway, deviceId), 5_000, 'agent online');

  const renewed = await api(gateway.base, '/api/setup/pairing/renew', { method: 'POST', setupToken: gateway.setupToken });
  if (renewed.status !== 200) throw new Error(`pairing renew failed: ${JSON.stringify(renewed.data)}`);
  const authorized = await api(gateway.base, '/api/pairings/authorize', { method: 'POST', token: ownerToken, body: { code: renewed.data.code } });
  if (authorized.status !== 200) throw new Error(`pairing authorize failed: ${JSON.stringify(authorized.data)}`);
  first.close();

  const bound = await new DeviceClient(gateway.wsUrl, options).connect();
  await bound.handshake({});
  await waitFor(() => agentOnline(gateway, deviceId), 5_000, 'bound agent online');
  return { agent: bound, first, authorized };
}
