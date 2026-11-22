export type TaskState = 'awaiting_confirmation' | 'dispatch_pending' | 'queued' | 'running' | 'cancel_requested' | 'succeeded' | 'failed' | 'cancelled' | 'outcome_unknown';
export const TASK_RECEIPTS = 'task_receipts_v1';
export const MAX_ACTIVE_TASKS = 21;
export const MAX_TRACKED_TASKS = 200;
export const TASK_RETENTION_MS = 24 * 60 * 60_000;
export const TASK_QUEUE_TTL_MS = 30 * 60_000;
export const terminalTaskState = (state: TaskState | undefined) => state === 'succeeded' || state === 'failed' || state === 'cancelled' || state === 'outcome_unknown';
export type InteractionMode = 'isolated' | 'isolated-gui' | 'foreground';
export type TaskKind = 'browser' | 'file' | 'process' | 'screenshot' | 'shell' | 'gui';
/**
 * How dangerous the Gateway judged a task to be from its text.
 *
 * `high` tasks are not dispatched at all until the phone confirms them, which
 * keeps an irreversible action (delete, format, shutdown, remote code) from
 * being one mistyped sentence away from happening unattended.
 */
export type TaskRisk = 'low' | 'high';

export type Envelope<T = unknown> = {
  version: 1;
  type: string;
  request_id: string;
  payload: T;
};

export type TaskCreate = {
  task_id: string;
  input: string;
  provider_id?: string;
  session_id?: string;
  kind?: TaskKind;
  mode?: InteractionMode;
  /** Total budget for the task. Defaults to 15 minutes, capped at 2 hours. */
  timeout_ms?: number;
  /**
   * Abort when the provider produces no output for this long. Separate from
   * `timeout_ms` so a slow-but-working agent is not mistaken for a hung one.
   */
  idle_timeout_ms?: number;
  history?: ConversationMessage[];
};
export type TaskRef = { task_id: string; dispatch_id: string };
export type TaskDispatch = TaskCreate & TaskRef & { queue_expires_at: number };
export type AgentReady = { device_id: string; binding_id?: string; tasks: Array<TaskRef & { cancel_requested: boolean }> };
export type TaskAck = TaskRef & { sequence: number };
export type ConversationMessage = {
  id: string;
  task_id?: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  created_at: string;
};
/**
 * Gateway → Agent: the nonce this connection must sign.
 *
 * A fresh nonce per connection is what makes the device signature
 * un-replayable: a signature captured from one connection is useless on the
 * next one, even though the device key itself never changes.
 */
export type ServerHello = { nonce: string; expires_at: number };

/** Agent → Gateway: who this device claims to be, and proof of that claim. */
export type AgentHello = {
  device_id: string;
  platform: string;
  interaction_mode: string;
  capabilities: string[];
  providers?: AgentProviderInfo[];
  /** Base64 (SPKI DER) Ed25519 public key. The Gateway stores only this half. */
  public_key?: string;
  /** Base64 Ed25519 signature over the Gateway's nonce. */
  signature?: string;
  /**
   * Legacy bearer token. Only accepted to migrate a device that was bound
   * before device keys existed; a key-bound device is never sent one again.
   */
  device_token?: string;
  /** Proves the peer can read this machine's data directory. */
  local_proof?: string;
};
export type AgentProviderInfo = {
  id: string;
  name: string;
  transport: 'local' | 'cli' | 'http' | 'websocket' | 'mcp' | 'gui';
  capabilities: string[];
  interaction_modes: InteractionMode[];
};

export type AgentSession = {
  id: string;
  provider_id: string;
  title: string;
  created_at: string;
  updated_at: string;
};

export type SessionCreate = { session_id: string; provider_id: string; title?: string };
export type SessionSwitch = { session_id: string; provider_id: string };
export type SessionEvent = {
  action: 'created' | 'switched' | 'failed';
  session?: AgentSession;
  error?: string;
};
/**
 * One thing the provider actually did, as opposed to what it said about it.
 *
 * The phone gets the agent's own summary as the message; these are the trace
 * behind it. `detail` is already truncated for a small screen — full command
 * output stays in the logs, not in the protocol.
 */
export type TaskActionKind = 'command' | 'file' | 'error';
export type TaskAction = {
  kind: TaskActionKind;
  detail: string;
  exit_code?: number | null;
  status?: string;
};

export type TaskEvent = {
  task_id: string;
  state: TaskState;
  message: string;
  provider_id?: string;
  session_id?: string;
  /** What was done, carried on the terminal event. */
  actions?: TaskAction[];
  /** Set on the `awaiting_confirmation` event so the phone can show why. */
  risk?: TaskRisk;
  reasons?: string[];
};

export type TaskReport = TaskEvent & { dispatch_id?: string; sequence?: number };

export function envelope<T>(type: string, payload: T, requestId: string = crypto.randomUUID()): Envelope<T> {
  return { version: 1, type, request_id: requestId, payload };
}
