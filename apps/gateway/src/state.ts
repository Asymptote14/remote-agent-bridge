import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir } from '@rab/config';
import type { AgentSession, ConversationMessage, SessionEvent, TaskEvent, TaskState } from '@rab/protocol';
import { hash } from './hashing.js';

/**
 * Every piece of mutable Gateway state, plus the JSON file it is persisted to.
 *
 * The maps are exported directly rather than hidden behind accessors: the route
 * handlers and the agent socket already mutate them in place, and wrapping them
 * would be a larger behavioural change than this split is meant to make.
 */

export type DeviceRecord = { name: string; platform: string; online: boolean; owner?: string; pairing?: string; auth_token_hash?: string };
export type SessionRecord = { session: AgentSession; owner: string; messages: ConversationMessage[] };
export type UserRecord = { password: string; tokenHash: string };
export type PersistedUser = { password: string; token_hash?: string; token?: string };
export type TaskRecord = {
  owner: string;
  session_id?: string;
  created_at: number;
  updated_at: number;
  events: TaskEvent[];
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
export const pairings = new Map<string, { deviceId: string; expires: number }>();
export const pairingAttempts = new Map<string, { count: number; resetAt: number }>();
export const sessions = new Map<string, SessionRecord>();
export const pendingSessionOwners = new Map<string, string>();

/** Session/operation responses are correlated by the envelope request_id. */
export type PendingCommand = {
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

export const lastTaskEvent = (record: TaskRecord): TaskEvent | undefined => record.events[record.events.length - 1];
export const isTaskFinished = (record: TaskRecord): boolean => {
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

export function persistState() {
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

export function publicDevice(id: string, device: DeviceRecord) {
  return { id, name: device.name, platform: device.platform, online: device.online, owner: device.owner };
}
