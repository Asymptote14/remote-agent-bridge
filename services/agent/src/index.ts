import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import WebSocket from 'ws';
import { MAX_ACTIVE_TASKS, TASK_RECEIPTS, envelope, type AgentReady, type Envelope, type SessionCreate, type SessionSwitch, type TaskAck, type TaskDispatch, type TaskRef } from '@rab/protocol';
import type { AgentAdapter } from '@rab/adapter-sdk';
import { dataDir, readProviderConfigs, readRuntimeConfig, setupTokenPath } from '@rab/config';
import { LocalAdapter } from './adapters/local.js';
import { HttpAdapter } from './adapters/http.js';
import { WorkBuddyAdapter } from './adapters/workbuddy.js';
import { CodexAdapter } from './adapters/codex.js';
import { loadIdentity, saveIdentity, signChallenge } from './identity.js';
import { TaskJournal } from './task-journal.js';
import { TaskRunner } from './task-runner.js';

const isRecovery = process.argv[2] === '--acknowledge-stopped';
if (isRecovery && process.argv[3] !== '--confirm-local-cleanup') {
  throw new Error('Stop both services and verify the old task and its managed processes have stopped. Then pass --confirm-local-cleanup.');
}
const journal = new TaskJournal(join(dataDir, 'agent-task-receipts.json'));

if (isRecovery) {
  journal.acknowledgeStopped();
  console.log('Cleanup acknowledged. Start the services to accept new tasks.');
  process.exit(0);
}

const runtimeConfig = readRuntimeConfig();
const url = new URL(process.env.GATEWAY_URL ?? `ws://127.0.0.1:${process.env.GATEWAY_PORT ?? runtimeConfig.port}/agent`);
const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
if (url.protocol !== 'wss:' && (url.protocol !== 'ws:' || !loopback)) throw new Error('agent_gateway_tls_required');
const deviceId = process.env.DEVICE_ID ?? 'local-agent';
const identity = loadIdentity(deviceId);
let deviceToken = process.env.DEVICE_TOKEN ?? identity.token ?? '';

const adapters = new Map<string, AgentAdapter>([['local', new LocalAdapter()]]);
for (const config of readProviderConfigs().filter(item => item.enabled)) {
  if (adapters.has(config.id)) { console.warn(`Ignoring duplicate Provider: ${config.id}`); continue; }
  try {
    if (config.transport === 'http' && config.endpoint) adapters.set(config.id, new HttpAdapter(config));
    else if (config.transport === 'cli' && typeof config.executable === 'string' && /\.(cmd|bat)$/iu.test(config.executable.trim())) {
      console.warn(`Provider ${config.id}: cli_shell_wrapper_unsupported`);
    } else if (config.transport === 'cli' && config.executable && (config.adapter === 'workbuddy' || config.id === 'workbuddy')) {
      adapters.set(config.id, new WorkBuddyAdapter(config));
    } else if (config.transport === 'cli' && config.executable && (config.adapter === 'codex' || config.id === 'codex')) {
      adapters.set(config.id, new CodexAdapter(config));
    } else console.warn(`Provider ${config.id} does not have a supported configuration`);
  } catch { console.warn(`Provider ${config.id}: invalid_provider_configuration`); }
}

const runner = new TaskRunner(adapters, journal);
let reconnectDelay = 500;
let publishStatus: (() => void) | undefined;

function send(socket: WebSocket, type: string, payload: unknown, requestId?: string) {
  if (socket.readyState !== WebSocket.OPEN) return;
  if (socket.bufferedAmount > 1024 * 1024) { socket.terminate(); return; }
  socket.send(JSON.stringify(envelope(type, payload, requestId)), error => { if (error) socket.terminate(); });
}

async function handleSession(socket: WebSocket, type: 'session.create' | 'session.switch', payload: SessionCreate | SessionSwitch, requestId: string, connectionSignal: AbortSignal) {
  const provider = adapters.get(payload.provider_id);
  if (!provider) return send(socket, 'session.event', { action: 'failed', error: 'provider_not_found' }, requestId);
  const signal = AbortSignal.any([connectionSignal, AbortSignal.timeout(4_000)]);
  try {
    const session = type === 'session.create'
      ? await provider.createSession({ sessionId: payload.session_id, title: 'title' in payload ? payload.title : undefined, signal })
      : await provider.switchSession(payload.session_id, signal);
    send(socket, 'session.event', { action: type === 'session.create' ? 'created' : 'switched', session }, requestId);
  } catch (error) {
    send(socket, 'session.event', { action: 'failed', error: error instanceof Error ? error.message.slice(0, 256) : 'session_operation_failed' }, requestId);
  }
}

function sendHello(socket: WebSocket, nonce: string) {
  let localProof: string | undefined;
  if (loopback) {
    try { localProof = readFileSync(setupTokenPath, 'utf8').trim(); } catch { localProof = undefined; }
  }
  send(socket, 'agent.hello', {
    device_id: deviceId, public_key: identity.public_key, signature: signChallenge(identity, nonce),
    device_token: deviceToken || undefined, local_proof: localProof,
    platform: process.platform, interaction_mode: 'isolated',
    capabilities: ['sessions', 'create_session', 'switch_session', 'background_tasks', TASK_RECEIPTS],
    providers: [...adapters.values()].map(adapter => adapter.provider),
  });
}

function validRef(value: unknown): value is TaskRef {
  const ref = value as Partial<TaskRef> | undefined | null;
  return typeof ref?.task_id === 'string' && ref.task_id.length > 0 && ref.task_id.length <= 128 &&
    typeof ref.dispatch_id === 'string' && ref.dispatch_id.length > 0 && ref.dispatch_id.length <= 128;
}

function connect() {
  const socket = new WebSocket(url, { handshakeTimeout: 5_000, maxPayload: 768 * 1024 });
  let helloSent = false;
  let ready = false;
  const connection = new AbortController();
  let lastSignal = Date.now();
  const challengeTimer = setTimeout(() => socket.terminate(), 10_000).unref();
  const heartbeatTimer = setInterval(() => {
    if (Date.now() - lastSignal > 45_000) socket.terminate();
  }, 10_000).unref();
  socket.on('ping', () => { lastSignal = Date.now(); });
  socket.on('open', () => send(socket, 'agent.challenge', {}));
  socket.on('message', raw => {
    lastSignal = Date.now();
    try {
      const message = JSON.parse(raw.toString()) as Envelope;
      if (!message || message.version !== 1 || typeof message.request_id !== 'string' ||
          !message.payload || typeof message.payload !== 'object' || Array.isArray(message.payload)) return socket.close(1008, 'invalid_envelope');
      if (message.type === 'server.hello' && !helloSent) {
        const { nonce, expires_at } = message.payload as { nonce?: string; expires_at?: number };
        if (typeof nonce !== 'string' || nonce.length > 128 || !nonce || typeof expires_at !== 'number' || expires_at < Date.now()) return socket.close(1008, 'invalid_challenge');
        clearTimeout(challengeTimer);
        helloSent = true;
        return sendHello(socket, nonce);
      }
      if (message.type === 'device.bound' && helloSent && !ready) {
        const binding = message.payload as { device_id?: string; token?: string };
        if (binding.device_id !== deviceId) return;
        if (binding.token && typeof binding.token === 'string') {
          deviceToken = binding.token;
          saveIdentity({ ...identity, token: deviceToken });
        }
        console.log('Device bound. Reconnecting to authenticate...');
        return socket.close(1000, 'device_bound_reconnect');
      }
      if (message.type === 'agent.ready' && helloSent && !ready) {
        const info = message.payload as AgentReady;
        if (info.device_id !== deviceId || !Array.isArray(info.tasks) || info.tasks.length > MAX_ACTIVE_TASKS || !info.tasks.every(validRef) ||
            (info.binding_id !== undefined && typeof info.binding_id !== 'string')) return socket.close(1008, 'invalid_agent_ready');
        ready = true;
        reconnectDelay = 500;
        let lastPaused: boolean | undefined;
        publishStatus = () => {
          if (lastPaused === journal.isPaused || socket.readyState !== WebSocket.OPEN) return;
          lastPaused = journal.isPaused;
          send(socket, 'agent.status', { queue_paused: lastPaused });
        };
        runner.reconnect(info, (type, payload) => send(socket, type, payload), () => socket.readyState === WebSocket.OPEN);
        publishStatus();
        console.log(`Agent ${deviceId} authenticated${journal.isPaused ? ' (queue paused)' : ''}`);
        return;
      }
      if (!ready) {
        if (message.type === 'agent.task' || message.type === 'session.create' || message.type === 'session.switch') {
          console.error('Gateway task receipt protocol unavailable; update Gateway and Agent together.');
          socket.close(1008, 'gateway_upgrade_required');
        }
        return;
      }
      if (message.type === 'session.create' || message.type === 'session.switch') {
        const payload = message.payload as SessionCreate;
        if (typeof payload.session_id !== 'string' || typeof payload.provider_id !== 'string' ||
            (payload.title !== undefined && typeof payload.title !== 'string')) return socket.close(1008, 'invalid_session_command');
        void handleSession(socket, message.type, payload, message.request_id, connection.signal);
      } else if (message.type === 'agent.task') {
        const task = message.payload as TaskDispatch;
        if (!validRef(task) || typeof task.input !== 'string' || task.input.length > 32_768 || !Number.isFinite(task.queue_expires_at)) {
          return socket.close(1008, 'invalid_task_dispatch');
        }
        runner.accept(task);
      } else if (message.type === 'agent.task.cancel' && validRef(message.payload)) runner.cancel(message.payload);
      else if (message.type === 'task.ack' && validRef(message.payload)) runner.acknowledge(message.payload as TaskAck);
    } catch { socket.close(1008, 'invalid_gateway_message'); }
  });
  socket.on('error', () => console.error('Agent connection unavailable'));
  socket.on('close', (_code, reason) => {
    connection.abort();
    publishStatus = undefined;
    clearTimeout(challengeTimer);
    clearInterval(heartbeatTimer);
    const detail = String(reason);
    runner.disconnect(detail === 'device_revoked' || detail === 'superseded_by_reconnect');
    if (detail === 'superseded_by_reconnect') return;
    const delay = detail === 'device_bound_reconnect' ? 200 : reconnectDelay + Math.floor(Math.random() * 250);
    reconnectDelay = Math.min(reconnectDelay * 2, 10_000);
    setTimeout(connect, delay);
  });
}

setInterval(() => { runner.tick(); publishStatus?.(); }, 1_000).unref();
connect();
