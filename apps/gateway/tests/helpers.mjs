// Shared test harness: boots a real Gateway on a free port with an isolated
// RAB_DATA_DIR, plus a fake Agent that speaks the WS protocol.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { once } from 'node:events';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const here = dirname(fileURLToPath(import.meta.url));
const gatewayEntry = join(here, '..', 'dist', 'index.js');

export function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/**
 * Polls until the predicate is truthy.
 *
 * The budget is deliberately generous and uniform. `node --test` runs test
 * files concurrently (one per CPU by default) and every file here boots a real
 * Gateway, so an operation that normally round-trips in milliseconds can wait
 * seconds behind a dozen sibling processes. The old 5s budgets were flaky under
 * exactly that load — which is also what a shared CI runner looks like — so
 * every wait is 15s now.
 */
export async function waitFor(predicate, timeoutMs = 15_000, intervalMs = 100) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
}

/**
 * Waits until the Gateway has processed the agent's `hello`.
 *
 * `connect()` resolves on the client's socket `open` event, which says nothing
 * about whether the server has read the handshake frame yet. Until it has,
 * `connectionDeviceId` is unset and `/api/setup/pairing/renew` answers 503
 * `agent_offline`. The two can land in the same poll iteration with no ordering
 * guarantee, so any test that connects an agent and immediately depends on it
 * must wait here first.
 *
 * Online is a sufficient signal because the Gateway sets `agent` and
 * `connectionDeviceId` in the same synchronous block, with no await between.
 */
export async function waitForAgentReady(gateway, timeoutMs = 15_000) {
  return waitFor(async () => {
    const health = await api(gateway.base, '/health');
    return health.data?.agentOnline === true ? true : undefined;
  }, timeoutMs, 'the gateway to accept the agent handshake');
}

/**
 * Waits until the Gateway reports that no agent holds the single agent slot.
 *
 * The slot is released when the Gateway processes the previous socket's close,
 * and that is not ordered with respect to whatever the next test does. A
 * connection attempted while the slot is still held is refused with 1008 — and
 * worse, a pairing code can be minted against the dying socket, so the device
 * token is handed to nobody and the new agent waits for something that cannot
 * arrive. Any deliberate handoff between agents must wait here first.
 */
export async function waitForAgentSlotFree(gateway, timeoutMs = 15_000) {
  return waitFor(async () => {
    const health = await api(gateway.base, '/health');
    return health.data?.agentOnline === false ? true : undefined;
  }, timeoutMs, 'the agent slot to be released');
}

/**
 * Waits for an agent to receive its device token, failing fast with the close
 * reason if the socket died first. Waiting on the token alone turns a refused
 * or superseded connection into a bare timeout that says nothing about why,
 * which is exactly how the shared-slot race below stayed invisible.
 */
export async function waitForDeviceToken(agent, timeoutMs = 15_000) {
  return waitFor(() => {
    if (agent.deviceToken) return agent.deviceToken;
    if (agent.closed) throw new Error(`agent socket closed before it was bound: ${agent.closed.code} ${agent.closed.reason}`);
    return undefined;
  }, timeoutMs, 'the agent to receive its device token');
}

/**
 * Boots a Gateway on a free port with an isolated RAB_DATA_DIR.
 * Pass an existing `dataDir` to restart against the same state.
 */
export async function startGateway({ dataDir: existingDataDir } = {}) {
  const dataDir = existingDataDir ?? mkdtempSync(join(tmpdir(), 'rab-test-'));
  const port = await freePort();
  const child = spawn(process.execPath, [gatewayEntry], {
    env: { ...process.env, RAB_DATA_DIR: dataDir, GATEWAY_PORT: String(port), GATEWAY_HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.resume();
  child.stderr.resume();
  const base = `http://127.0.0.1:${port}`;
  await waitFor(async () => {
    try { return (await fetch(`${base}/health`)).ok; } catch { return false; }
  }, 15_000);
  // The privileged setup API requires the operator's setup token, which the
  // gateway writes to the data directory on boot. Read it the same way the
  // real launcher does before opening the setup page.
  const setupTokenPath = join(dataDir, 'setup-token');
  const setupToken = await waitFor(() => {
    try {
      const value = readFileSync(setupTokenPath, 'utf8').trim();
      return value.length >= 32 ? value : undefined;
    } catch { return undefined; }
  }, 15_000);
  return {
    base,
    port,
    dataDir,
    setupToken,
    wsUrl: `ws://127.0.0.1:${port}/agent`,
    async stop({ keepDataDir = false } = {}) {
      if (child.exitCode === null) {
        child.kill();
        await once(child, 'exit').catch(() => {});
      }
      if (!keepDataDir) rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

/** Minimal HTTP helper that never throws on non-2xx. */
export async function api(base, path, { method = 'GET', token, body, headers = {}, setupToken } = {}) {
  const response = await fetch(base + path, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(setupToken ? { 'x-rab-setup-token': setupToken } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: response.status, data, headers: response.headers };
}

export async function registerUser(base, email, password = 'password123') {
  const registered = await api(base, '/api/auth/register', { method: 'POST', body: { email, password } });
  if (registered.status === 201 || registered.status === 200) return registered.data.token;
  const loggedIn = await api(base, '/api/auth/login', { method: 'POST', body: { email, password } });
  return loggedIn.data.token;
}

/**
 * Fake Agent: completes the handshake, answers session commands, and emits a
 * queued -> succeeded task event pair. Records everything it receives so tests
 * can assert a blind (unbound) agent never gets data.
 */
export class FakeAgent {
  constructor(url, { deviceId = 'test-agent', token, localProof, autoReconnectOnBind = true, completeTasks = true } = {}) {
    this.url = url;
    this.deviceId = deviceId;
    this.token = token;
    // The real Agent runs on the Gateway's machine and proves it by presenting
    // the setup token. Tests pass it the same way; omit it to model a peer
    // that reached the Gateway across a tunnel.
    this.localProof = localProof;
    this.autoReconnectOnBind = autoReconnectOnBind;
    // Set false to model a task that is still running: the agent reports
    // progress and then never reaches a terminal state.
    this.completeTasks = completeTasks;
    this.received = [];
    this.deviceToken = undefined;
    this.closed = undefined;
    this.reconnectCount = 0;
  }

  get messages() {
    return this.received.map(raw => JSON.parse(raw.toString()));
  }

  async connect() {
    this.socket = new WebSocket(this.url);
    await once(this.socket, 'open');
    this.socket.on('message', raw => {
      this.received.push(raw);
      let message;
      try { message = JSON.parse(raw.toString()); } catch { return; }
      this.#handle(message, raw);
    });
    this.socket.on('close', (code, reason) => {
      this.closed = { code, reason: String(reason) };
      if (String(reason) === 'device_bound_reconnect' && this.autoReconnectOnBind) {
        // Mirror the real agent: a freshly bound device reconnects at once so
        // the token it just received is what the next handshake proves.
        this.closed = undefined;
        this.token = this.deviceToken;
        setTimeout(() => {
          this.reconnectCount += 1;
          void this.connect().catch(() => {});
        }, 100);
      }
    });
    this.socket.on('error', () => {});
    this.socket.send(JSON.stringify({
      version: 1,
      type: 'agent.hello',
      request_id: 'hello',
      payload: {
        device_id: this.deviceId,
        device_token: this.token,
        local_proof: this.localProof,
        platform: 'win32',
        interaction_mode: 'isolated',
        capabilities: ['sessions', 'create_session', 'switch_session', 'background_tasks'],
        providers: [{ id: 'local', name: 'Local Computer Agent', transport: 'local', capabilities: ['sessions'], interaction_modes: ['isolated'] }],
      },
    }));
    return this;
  }

  #handle(message, raw) {
    if (message.type === 'device.bound') {
      this.deviceToken = message.payload?.token;
      // Same as the real agent: the token just arrived, so drop this
      // unauthenticated socket and reconnect proving possession of it.
      if (this.autoReconnectOnBind && this.deviceToken) this.socket.close(1000, 'device_bound_reconnect');
      return;
    }
    if (message.type === 'session.create' || message.type === 'session.switch') {
      const payload = message.payload;
      this.socket.send(JSON.stringify({
        version: 1,
        type: 'session.event',
        request_id: message.request_id,
        payload: {
          action: message.type === 'session.create' ? 'created' : 'switched',
          session: {
            id: payload.session_id,
            provider_id: payload.provider_id,
            title: payload.title ?? 'test session',
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          },
        },
      }));
      return;
    }
    if (message.type === 'agent.task') {
      const task = message.payload;
      const send = (state, text) => this.socket.send(JSON.stringify({
        version: 1,
        type: 'task.event',
        request_id: `evt-${state}`,
        payload: { task_id: task.task_id, state, message: text, provider_id: task.provider_id ?? 'local', session_id: task.session_id },
      }));
      send('queued', '已排队');
      send('running', '执行中');
      if (this.completeTasks) send('succeeded', `echo: ${task.input}`);
    }
  }

  /** Messages the gateway sent beyond the handshake reply. */
  inbound() {
    return this.messages.filter(message => message.type !== 'agent.hello');
  }

  close() {
    try { this.socket?.close(); } catch { /* already closed */ }
  }
}
