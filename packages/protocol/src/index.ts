export type TaskState = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
export type InteractionMode = 'isolated' | 'isolated-gui' | 'foreground';
export type TaskKind = 'browser' | 'file' | 'process' | 'screenshot' | 'shell' | 'gui';

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
export type ConversationMessage = {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  created_at: string;
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
export type TaskEvent = {
  task_id: string;
  state: TaskState;
  message: string;
  provider_id?: string;
  session_id?: string;
};

export function envelope<T>(type: string, payload: T, requestId: string = crypto.randomUUID()): Envelope<T> {
  return { version: 1, type, request_id: requestId, payload };
}
