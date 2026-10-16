import type { AgentProviderInfo, AgentSession, ConversationMessage, InteractionMode } from '@rab/protocol';

export type CreateSessionInput = { sessionId: string; title?: string };
export type SendMessageInput = {
  taskId: string;
  sessionId: string;
  text: string;
  mode: InteractionMode;
  timeoutMs: number;
  history?: ConversationMessage[];
  /**
   * Adapters must call this whenever the provider shows progress (for example
   * on each chunk of child process output). The Agent treats prolonged silence
   * as a hang and terminates the task, so a provider that never reports
   * activity is indistinguishable from a stuck one.
   */
  onActivity?: () => void;
};

export type AdapterResult = { message: string; session: AgentSession };

export interface AgentAdapter {
  readonly provider: AgentProviderInfo;
  listSessions(): Promise<AgentSession[]>;
  createSession(input: CreateSessionInput): Promise<AgentSession>;
  switchSession(sessionId: string): Promise<AgentSession>;
  sendMessage(input: SendMessageInput): Promise<AdapterResult>;
  cancelTask(taskId: string): Promise<void>;
}
