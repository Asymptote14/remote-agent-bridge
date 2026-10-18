import WebSocket from 'ws';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { envelope, type AgentSession, type Envelope, type SessionCreate, type SessionSwitch, type TaskCreate, type TaskEvent } from '@rab/protocol';
import type { AgentAdapter } from '@rab/adapter-sdk';
import { AdapterTaskError } from '@rab/adapter-sdk';
import { LocalAdapter } from './adapters/local.js';
import { HttpAdapter } from './adapters/http.js';
import { WorkBuddyAdapter } from './adapters/workbuddy.js';
import { CodexAdapter } from './adapters/codex.js';
import { readProviderConfigs, readRuntimeConfig, dataDir, readSetupToken } from '@rab/config';
import { resolveIdleTimeout, resolveTaskTimeout, runWithTimeouts, TaskTimeoutError } from './task-timeouts.js';

const runtimeConfig = readRuntimeConfig();
const url = process.env.GATEWAY_URL ?? `ws://127.0.0.1:${runtimeConfig.port}/agent`;
const deviceId = process.env.DEVICE_ID ?? 'local-agent';
const identityPath = join(dataDir, 'agent-identity.json');
mkdirSync(dataDir, { recursive: true });
try { if (existsSync(identityPath)) chmodSync(identityPath, 0o600); } catch { /* Windows may ignore POSIX file modes. */ }
let deviceToken = process.env.DEVICE_TOKEN ?? '';
if (!deviceToken && existsSync(identityPath)) {
  try { deviceToken = (JSON.parse(readFileSync(identityPath, 'utf8')) as { token?: string }).token ?? ''; } catch { deviceToken = ''; }
}
const adapters = new Map<string, AgentAdapter>([['local', new LocalAdapter()]]);
for (const config of readProviderConfigs().filter(item => item.enabled)) {
  if (config.transport === 'http' && config.endpoint) adapters.set(config.id, new HttpAdapter(config));
  if (config.transport === 'cli' && config.executable && (config.adapter === 'workbuddy' || config.id === 'workbuddy')) {
    adapters.set(config.id, new WorkBuddyAdapter(config));
  } else if (config.transport === 'cli' && config.executable && (config.adapter === 'codex' || config.id === 'codex')) {
    adapters.set(config.id, new CodexAdapter(config));
  } else if (config.transport === 'cli' && config.executable) {
    console.warn(`Provider ${config.id} is configured as CLI but has no installed adapter: ${config.adapter || 'unknown'}`);
  }
}
// The Agent runs on the same machine as the Gateway, so it can read the setup
// token from the data directory and prove locality in its handshake. A remote
// peer that reaches the Gateway through a tunnel cannot do this, which stops it
// from holding the agent slot and being the device the operator pairs.
let localProof = '';
try { localProof = readSetupToken(); } catch { localProof = ''; }
const taskQueue: TaskCreate[] = [];
let running = false;
let activeSocket: WebSocket | undefined;

function emit(type: string, payload: unknown, requestId?: string) {
  if (activeSocket?.readyState === WebSocket.OPEN) activeSocket.send(JSON.stringify(envelope(type, payload, requestId)));
}

function emitTask(event: TaskEvent) {
  emit('task.event', event);
}

async function handleSession(type: 'session.create' | 'session.switch', payload: SessionCreate | SessionSwitch, requestId?: string) {
  const provider = adapters.get(payload.provider_id);
  if (!provider) return emit('session.event', { action: 'failed', error: 'provider_not_found' }, requestId);
  try {
    const session = type === 'session.create'
      ? await provider.createSession({ sessionId: payload.session_id, title: 'title' in payload ? payload.title : undefined })
      : await provider.switchSession(payload.session_id);
    emit('session.event', { action: type === 'session.create' ? 'created' : 'switched', session }, requestId);
  } catch (error) {
    emit('session.event', { action: 'failed', error: error instanceof Error ? error.message : 'session_operation_failed' }, requestId);
  }
}

async function ensureSession(provider: AgentAdapter, sessionId?: string): Promise<AgentSession> {
  if (sessionId) {
    try { return await provider.switchSession(sessionId); } catch { /* create below */ }
  }
  return provider.createSession({ sessionId: sessionId ?? `session_${crypto.randomUUID().slice(0, 8)}` });
}

async function runNext() {
  if (running || taskQueue.length === 0) return;
  const task = taskQueue.shift()!;
  running = true;
  const provider = adapters.get(task.provider_id ?? 'local');
  const providerId = provider?.provider.id ?? task.provider_id ?? 'local';
  emitTask({ task_id: task.task_id, state: 'running', message: '已进入 Provider 会话并开始执行', provider_id: providerId, session_id: task.session_id });

  try {
    if (!provider) throw new Error('provider_not_found');
    const mode = task.mode ?? 'isolated';
    // A headless coding agent runs for minutes, so the budget is generous and
    // the idle clock is what catches a provider that has actually stalled.
    const totalMs = resolveTaskTimeout(task.timeout_ms);
    const idleMs = resolveIdleTimeout(task.idle_timeout_ms);
    const session = await ensureSession(provider, task.session_id);
    const result = await runWithTimeouts(
      onActivity => provider.sendMessage({
        taskId: task.task_id,
        sessionId: session.id,
        text: task.input,
        mode,
        timeoutMs: totalMs,
        history: task.history,
        onActivity,
      }),
      { totalMs, idleMs },
    );
    emitTask({ task_id: task.task_id, state: 'succeeded', message: result.message, provider_id: providerId, session_id: result.session.id, actions: result.actions });
  } catch (error) {
    const timedOut = error instanceof TaskTimeoutError;
    if (timedOut && provider) {
      // Report why before the kill, which can take a moment on Windows.
      emitTask({ task_id: task.task_id, state: 'running', message: '任务超时，正在终止 Provider 进程树…', provider_id: providerId, session_id: task.session_id });
      try { await provider.cancelTask(task.task_id); } catch { /* The child may have exited while the timeout fired. */ }
    }
    // A failed task is exactly when "what it tried" matters, so the adapter's
    // trace rides along even here.
    const actions = error instanceof AdapterTaskError ? error.actions : undefined;
    emitTask({ task_id: task.task_id, state: 'failed', message: error instanceof Error ? error.message : 'provider_execution_failed', provider_id: providerId, session_id: task.session_id, actions });
  } finally {
    running = false;
    void runNext();
  }
}

function connect() {
  const socket = new WebSocket(url);
  activeSocket = socket;

  socket.on('open', () => {
    socket.send(JSON.stringify(envelope('agent.hello', {
      device_id: deviceId,
      device_token: deviceToken || undefined,
      local_proof: localProof || undefined,
      platform: process.platform,
      interaction_mode: 'isolated',
      capabilities: ['sessions', 'create_session', 'switch_session', 'background_tasks'],
      providers: [...adapters.values()].map(adapter => adapter.provider),
    })));
    console.log(`Agent ${deviceId} connected to ${url}`);
  });
  socket.on('message', raw => {
    try {
      const message = JSON.parse(raw.toString()) as Envelope<TaskCreate | SessionCreate | SessionSwitch>;
      if (message.type === 'device.bound') {
        const binding = message.payload as { device_id?: string; token?: string };
        if (binding.device_id === deviceId && binding.token) {
          deviceToken = binding.token;
          writeFileSync(identityPath, JSON.stringify({ device_id: deviceId, token: deviceToken }, null, 2), { encoding: 'utf8', mode: 0o600 });
          try { chmodSync(identityPath, 0o600); } catch { /* Windows may ignore POSIX file modes. */ }
          console.log('Device identity bound and saved locally. Reconnecting to authenticate...');
          // This socket connected without a token, so the Gateway still treats
          // it as unauthenticated and drops everything except agent.hello.
          // Reconnect immediately with the fresh token instead of waiting for
          // the next scheduled retry.
          socket.close(1000, 'device_bound_reconnect');
        }
        return;
      }
      if (message.type === 'agent.pairing') {
        // Pairing codes are no longer pushed to agents; they are shown on the
        // local /setup page only.
        return;
      }
      if (message.type === 'session.create' || message.type === 'session.switch') {
        // Echo the Gateway's request_id so concurrent session operations pair
        // with the correct response.
        void handleSession(message.type, message.payload as SessionCreate | SessionSwitch, message.request_id);
        return;
      }
      if (message.type !== 'agent.task') return;
      const task = { ...(message.payload as TaskCreate), mode: (message.payload as TaskCreate).mode ?? 'isolated' };
      taskQueue.push(task);
      emitTask({ task_id: task.task_id, state: 'queued', message: `已排队（前面还有 ${taskQueue.length - 1} 个任务）`, provider_id: task.provider_id ?? 'local', session_id: task.session_id });
      void runNext();
    } catch { console.error('Ignored malformed Gateway message'); }
  });
  socket.on('error', error => console.error('Agent connection error:', error.message));
  socket.on('close', (code, reason) => {
    if (activeSocket === socket) activeSocket = undefined;
    // Bound right now: retry fast so the device becomes usable within a second.
    const rebound = String(reason) === 'device_bound_reconnect';
    setTimeout(connect, rebound ? 300 : 3000);
  });
}

connect();
