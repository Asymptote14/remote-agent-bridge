import type { AgentAdapter, AdapterResult, CreateSessionInput, SendMessageInput } from '@rab/adapter-sdk';
import type { AgentProviderInfo, AgentSession } from '@rab/protocol';
import type { ProviderConfig } from '@rab/config';

type RemoteResponse = { session?: AgentSession; message?: string; sessions?: AgentSession[]; error?: string };

export class HttpAdapter implements AgentAdapter {
  readonly provider: AgentProviderInfo;
  constructor(private readonly config: ProviderConfig) {
    this.provider = { id: config.id, name: config.name, transport: 'http', capabilities: ['sessions', 'create_session', 'switch_session', 'conversation_context'], interaction_modes: ['isolated'] };
  }
  private async request(path: string, init: RequestInit = {}): Promise<RemoteResponse> {
    const response = await fetch(new URL(path, this.config.endpoint || ''), { ...init, headers: { 'content-type': 'application/json', ...(this.config.token ? { authorization: `Bearer ${this.config.token}` } : {}), ...(init.headers ?? {}) } });
    const data = await response.json() as RemoteResponse;
    if (!response.ok) throw new Error(data.error || `remote_provider_http_${response.status}`);
    return data;
  }
  async listSessions(): Promise<AgentSession[]> { return (await this.request('/sessions')).sessions ?? []; }
  async createSession(input: CreateSessionInput): Promise<AgentSession> { const data = await this.request('/sessions', { method: 'POST', body: JSON.stringify(input) }); if (!data.session) throw new Error('remote_session_missing'); return data.session; }
  async switchSession(sessionId: string): Promise<AgentSession> { const data = await this.request(`/sessions/${encodeURIComponent(sessionId)}/switch`, { method: 'POST' }); if (!data.session) throw new Error('remote_session_missing'); return data.session; }
  async sendMessage(input: SendMessageInput): Promise<AdapterResult> { if (input.mode !== 'isolated') throw new Error('provider_mode_not_supported'); const data = await this.request(`/sessions/${encodeURIComponent(input.sessionId)}/messages`, { method: 'POST', body: JSON.stringify(input) }); if (!data.session || !data.message) throw new Error('remote_message_missing'); return { session: data.session, message: data.message }; }
  async cancelTask(taskId: string): Promise<void> { await this.request(`/tasks/${encodeURIComponent(taskId)}/cancel`, { method: 'POST' }); }
}
