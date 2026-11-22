import { ExecutionUnconfirmedError, type AgentAdapter, type AdapterResult, type CancelOutcome, type CreateSessionInput, type SendMessageInput } from '@rab/adapter-sdk';
import type { AgentProviderInfo, AgentSession } from '@rab/protocol';
import type { ProviderConfig } from '@rab/config';

const SESSION_TIMEOUT_MS = 4_000;
const CANCEL_TIMEOUT_MS = 8_000;
const MAX_RESPONSE_BYTES = 256 * 1024;

async function readResponse(response: Response, onActivity?: () => void): Promise<Record<string, unknown>> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('remote_response_invalid');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new Error('remote_response_too_large');
      chunks.push(value);
      onActivity?.();
    }
    const result: unknown = JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('remote_response_invalid');
    return result as Record<string, unknown>;
  } finally {
    void reader.cancel().catch(() => {});
  }
}

export class HttpAdapter implements AgentAdapter {
  readonly provider: AgentProviderInfo;
  private readonly endpoint: URL;

  constructor(private readonly config: ProviderConfig) {
    this.endpoint = new URL(config.endpoint ?? '');
    if (!['http:', 'https:'].includes(this.endpoint.protocol) || this.endpoint.username || this.endpoint.password) {
      throw new Error('remote_provider_endpoint_invalid');
    }
    this.provider = { id: config.id, name: config.name, transport: 'http', capabilities: ['sessions', 'create_session', 'switch_session', 'conversation_context'], interaction_modes: ['isolated'] };
  }

  private async request(path: string, options: { signal?: AbortSignal; timeoutMs: number; post?: boolean; body?: object; sessionLookup?: boolean; onActivity?: () => void }) {
    const deadline = AbortSignal.timeout(options.timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
    signal.throwIfAborted();
    const response = await fetch(new URL(path, this.endpoint), {
      method: options.post ? 'POST' : 'GET', signal, redirect: 'error',
      headers: { ...(options.body ? { 'content-type': 'application/json' } : {}), ...(this.config.token ? { authorization: `Bearer ${this.config.token}` } : {}) },
      body: options.body && JSON.stringify(options.body),
    });
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      if (options.sessionLookup && response.status === 404) throw new Error('session_not_found');
      throw new Error(`remote_provider_http_${response.status}`);
    }
    options.onActivity?.();
    return readResponse(response, options.onActivity);
  }

  private session(value: unknown, id?: string): AgentSession {
    const session = value as Partial<AgentSession> | undefined | null;
    if (typeof session?.id !== 'string' || !session.id || session.id.length > 128 || (id !== undefined && session.id !== id) ||
        typeof session.title !== 'string' || session.title.length > 160 ||
        typeof session.created_at !== 'string' || !Number.isFinite(Date.parse(session.created_at)) ||
        typeof session.updated_at !== 'string' || !Number.isFinite(Date.parse(session.updated_at))) throw new Error('remote_session_invalid');
    return { id: session.id, provider_id: this.provider.id, title: session.title, created_at: session.created_at, updated_at: session.updated_at };
  }

  async listSessions(): Promise<AgentSession[]> {
    const data = await this.request('/sessions', { timeoutMs: SESSION_TIMEOUT_MS });
    if (!Array.isArray(data.sessions)) throw new Error('remote_session_list_invalid');
    return data.sessions.slice(0, 200).map(session => this.session(session));
  }

  async createSession({ sessionId, title, signal }: CreateSessionInput): Promise<AgentSession> {
    const data = await this.request('/sessions', { post: true, signal, timeoutMs: SESSION_TIMEOUT_MS, body: { sessionId, title } });
    return this.session(data.session, sessionId);
  }

  async switchSession(sessionId: string, signal?: AbortSignal): Promise<AgentSession> {
    const data = await this.request(`/sessions/${encodeURIComponent(sessionId)}/switch`, { post: true, signal, timeoutMs: SESSION_TIMEOUT_MS, sessionLookup: true });
    return this.session(data.session, sessionId);
  }

  async sendMessage({ taskId, sessionId, text, mode, timeoutMs, history, signal, onActivity }: SendMessageInput): Promise<AdapterResult> {
    if (mode !== 'isolated') throw new Error('provider_mode_not_supported');
    signal?.throwIfAborted();
    try {
      const data = await this.request(`/sessions/${encodeURIComponent(sessionId)}/messages`, {
        post: true, signal, timeoutMs, onActivity, body: { taskId, sessionId, text, mode, timeoutMs, history },
      });
      if (typeof data.message !== 'string') throw new Error('remote_message_missing');
      return { session: this.session(data.session, sessionId), message: data.message };
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (error instanceof Error && error.message === 'remote_response_too_large') throw new ExecutionUnconfirmedError('remote_response_too_large');
      throw new ExecutionUnconfirmedError('remote_execution_unconfirmed');
    }
  }

  async cancelTask(taskId: string): Promise<CancelOutcome> {
    const data = await this.request(`/tasks/${encodeURIComponent(taskId)}/cancel`, { post: true, timeoutMs: CANCEL_TIMEOUT_MS });
    if (data.cancelled !== true) throw new Error('remote_cancellation_unconfirmed');
    return 'stopped';
  }
}
