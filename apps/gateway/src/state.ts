import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir } from '@rab/config';
import { TASK_RETENTION_MS, terminalTaskState, type AgentSession, type ConversationMessage, type SessionEvent, type TaskCreate, type TaskEvent } from '@rab/protocol';
import type { WebSocket } from 'ws';
import { hash } from './hashing.js';

/**
 * Every piece of mutable Gateway state, plus the JSON file it is persisted to.
 *
 * The maps are exported directly rather than hidden behind accessors: the route
 * handlers and the agent socket already mutate them in place, and wrapping them
 * would be a larger behavioural change than this split is meant to make.
 */

export type DeviceRecord = {
  name: string;
  platform: string;
  online: boolean;
  owner?: string;
  pairing?: string;
  binding_id?: string;
  /** Ed25519 public key the device must sign a nonce with to authenticate. */
  auth_public_key?: string;
  /** Legacy bearer token hash, only kept for a device bound before device keys existed. */
  auth_token_hash?: string;
};
export type SessionRecord = { session: AgentSession; owner: string; messages: ConversationMessage[] };
export type UserRecord = { password: string; tokenHash: string };
export type PersistedUser = { password: string; token_hash?: string; token?: string };
export type TaskRecord = {
  owner: string;
  device_id?: string;
  binding_id?: string;
  provider_id?: string;
  session_id?: string;
  dispatch_id?: string;
  sequence?: number;
  request_hash?: string;
  created_at: number;
  updated_at: number;
  events: TaskEvent[];
  /**
   * A high-risk task is held here, undispatched, until the user confirms it.
   * Nothing about it reaches the Agent before that.
   */
  pending?: TaskCreate;
};
export type PersistedState = {
  users: Array<[string, PersistedUser]>;
  devices: Array<[string, DeviceRecord]>;
  sessions: Array<[string, SessionRecord]>;
  tasks?: Array<[string, TaskRecord]>;
};

const statePath = join(dataDir, 'state.json');
export const users = new Map<string, UserRecord>();
export const devices = new Map<string, DeviceRecord>();
export const pairings = new Map<string, { deviceId: string; socket: WebSocket; expires: number }>();
export const pairingAttempts = new Map<string, { count: number; resetAt: number }>();
export const sessions = new Map<string, SessionRecord>();

/** Session/operation responses are correlated by the envelope request_id. */
export type PendingCommand = {
  socket: WebSocket;
  sessionId: string;
  providerId: string;
  action: 'created' | 'switched';
  resolve: (event: SessionEvent) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};
export const pendingCommands = new Map<string, PendingCommand>();

/**
 * Task records are persisted rather than held in memory only. The phone polls
 * `/api/tasks/:id/events` for a result, so losing these on restart turned every
 * in-flight task into a 404 the client could never resolve.
 */
export const tasks = new Map<string, TaskRecord>();
/**
 * How long a high-risk task waits for the phone to confirm it. Long enough to
 * read the prompt and decide, short enough that a forgotten prompt cannot fire
 * hours later on a stale instruction.
 */
export const TASK_CONFIRMATION_TTL_MS = 5 * 60_000;
/**
 * Backstop for a task the Agent never reports on at all — it crashed, or the
 * device was revoked mid-run. Without this the phone polls forever. The Agent
 * caps a single task at two hours, so six is comfortably past any live task.
 */
const TASK_ABANDONED_MS = 6 * 60 * 60_000;
const PAIRING_ATTEMPT_TTL_MS = 10 * 60_000;

export const lastTaskEvent = (record: TaskRecord): TaskEvent | undefined => record.events[record.events.length - 1];
export const isTaskFinished = (record: TaskRecord): boolean => terminalTaskState(lastTaskEvent(record)?.state);

export function appendTaskEvent(record: TaskRecord, event: TaskEvent): TaskRecord {
  return { ...record, updated_at: Date.now(), events: [...record.events.slice(-19), event] };
}

export class StateWriteError extends Error {
  constructor(cause: unknown) { super('state_write_failed', { cause }); }
}

export function saveSession(sessionId: string, record?: SessionRecord) {
  const old = sessions.get(sessionId);
  if (record) sessions.set(sessionId, record);
  else sessions.delete(sessionId);
  try { persistState(); }
  catch (error) {
    if (old) sessions.set(sessionId, old);
    else sessions.delete(sessionId);
    throw new StateWriteError(error);
  }
}

export function saveTask(taskId: string, record: TaskRecord, nextSession?: SessionRecord) {
  const oldTask = tasks.get(taskId);
  const sessionId = nextSession?.session.id;
  const oldSession = sessionId && sessions.get(sessionId);
  tasks.set(taskId, record);
  if (sessionId && nextSession) sessions.set(sessionId, nextSession);
  try { persistState(); }
  catch (error) {
    if (oldTask) tasks.set(taskId, oldTask);
    else tasks.delete(taskId);
    if (sessionId) {
      if (oldSession) sessions.set(sessionId, oldSession);
      else sessions.delete(sessionId);
    }
    throw new StateWriteError(error);
  }
}

function sweepExpired() {
  const now = Date.now();
  const prior = new Map(tasks);
  let changed = false;
  for (const [taskId, entry] of tasks) {
    if (isTaskFinished(entry)) {
      // Reclaim only once the result has had time to be collected.
      if (now - entry.updated_at > TASK_RETENTION_MS) changed = tasks.delete(taskId) || changed;
      continue;
    }
    // A high-risk task that nobody confirmed must not fire later.
    if (lastTaskEvent(entry)?.state === 'awaiting_confirmation') {
      if (now - entry.updated_at > TASK_CONFIRMATION_TTL_MS) {
        tasks.set(taskId, { ...appendTaskEvent(entry, {
          task_id: taskId,
          state: 'cancelled',
          message: '[confirmation_expired] 高风险操作在 5 分钟内未被确认，已取消执行。',
          session_id: entry.session_id,
        }), pending: undefined });
        changed = true;
      }
      continue;
    }
    // Still in flight: never reclaim it on age alone, because its terminal
    // event is what releases the phone's pending entry. Close it out instead if
    // nothing has reported on it for long enough that nothing ever will.
    if (now - entry.created_at > TASK_ABANDONED_MS) {
      tasks.set(taskId, appendTaskEvent(entry, {
        task_id: taskId,
        state: 'outcome_unknown',
        message: '[task_abandoned] 超过 6 小时没有收到任务结果，请在电脑上核对。',
        session_id: entry.session_id,
      }));
      changed = true;
    }
  }
  for (const [key, entry] of pairingAttempts) {
    if (entry.resetAt < now - PAIRING_ATTEMPT_TTL_MS) pairingAttempts.delete(key);
  }
  for (const [code, pairing] of pairings) {
    if (pairing.expires < now - 60_000) pairings.delete(code);
  }
  if (changed) {
    try { persistState(); }
    catch (error) {
      tasks.clear();
      for (const [id, entry] of prior) tasks.set(id, entry);
      console.error('State cleanup could not be persisted:', (error as NodeJS.ErrnoException).code ?? 'unknown');
    }
  }
}
setInterval(sweepExpired, 60_000).unref();

let stateDirty = false;

if (existsSync(statePath)) {
  try {
    const state = JSON.parse(readFileSync(statePath, 'utf8')) as Partial<PersistedState>;
    if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('invalid_state');
    for (const entries of [state.users, state.devices, state.sessions, state.tasks]) {
      if (entries !== undefined && (!Array.isArray(entries) || entries.some(entry => !Array.isArray(entry) ||
        typeof entry[0] !== 'string' || !entry[1] || typeof entry[1] !== 'object' || Array.isArray(entry[1])))) throw new Error('invalid_state_entries');
    }
    for (const [id, user] of state.users ?? []) {
      const tokenHash = user.token_hash || (user.token ? hash(user.token) : '');
      if (user.password && tokenHash) {
        users.set(id, { password: user.password, tokenHash });
        if (!user.token_hash) stateDirty = true;
      }
    }
    for (const [id, device] of state.devices ?? []) devices.set(id, { ...device, online: false, pairing: undefined });
    for (const [id, session] of state.sessions ?? []) {
      if (typeof session.owner !== 'string' || session.session?.id !== id || !Array.isArray(session.messages ?? [])) throw new Error('invalid_session_state');
      sessions.set(id, { ...session, messages: session.messages ?? [] });
    }
    for (const [id, record] of state.tasks ?? []) {
      if (typeof record.owner !== 'string' || !Array.isArray(record.events)) throw new Error('invalid_task_state');
      const createdAt = Number(record.created_at) || Date.now();
      tasks.set(id, {
        owner: record.owner,
        device_id: record.device_id,
        binding_id: record.binding_id,
        provider_id: record.provider_id,
        session_id: record.session_id,
        dispatch_id: record.dispatch_id,
        sequence: record.sequence,
        request_hash: record.request_hash,
        created_at: createdAt,
        updated_at: Number(record.updated_at) || createdAt,
        events: Array.isArray(record.events) ? record.events.slice(-20) : [],
        // A task still waiting for confirmation survives a restart: the user
        // may simply have reloaded the page, and it has not run yet.
        pending: record.pending,
      });
    }
  } catch (error) {
    throw new Error('state_unreadable: gateway data was not changed; inspect or restore state.json before starting', { cause: error });
  }
}

for (const [id, record] of tasks) {
  if (isTaskFinished(record)) continue;
  if (record.dispatch_id || lastTaskEvent(record)?.state === 'awaiting_confirmation') continue;
  record.events.push({
    task_id: id,
    state: 'outcome_unknown',
    message: '[gateway_restart] Gateway 在任务执行期间重启，任务结果未知。',
    session_id: record.session_id,
  });
  record.events = record.events.slice(-20);
  record.updated_at = Date.now();
  stateDirty = true;
}

export function persistState() {
  mkdirSync(dataDir, { recursive: true });
  const persistedTasks = [...tasks.entries()]
    .sort(([, a], [, b]) => b.updated_at - a.updated_at);
  const state: PersistedState = {
    users: [...users.entries()].map(([id, user]) => [id, { password: user.password, token_hash: user.tokenHash }]),
    devices: [...devices.entries()].map(([id, device]) => [id, { ...device, online: false, pairing: undefined }]),
    sessions: [...sessions.entries()],
    tasks: persistedTasks,
  };
  const temporaryPath = `${statePath}.tmp`;
  writeFileSync(temporaryPath, JSON.stringify(state, null, 2), { encoding: 'utf8', mode: 0o600, flush: true });
  try { chmodSync(temporaryPath, 0o600); } catch { /* Windows may ignore POSIX file modes. */ }
  renameSync(temporaryPath, statePath);
}
if (stateDirty) persistState();

export function publicDevice(id: string, device: DeviceRecord) {
  return { id, name: device.name, platform: device.platform, online: device.online, owner: device.owner };
}
