import type { AgentProviderInfo, AgentSession, ConversationMessage, InteractionMode, TaskAction } from '@rab/protocol';

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

export type AdapterResult = {
  message: string;
  session: AgentSession;
  /**
   * What the provider actually did, when it reports it. The message above is
   * the agent's own summary, which is not the same thing: a phone user needs
   * the commands that ran and whether they succeeded, not only the narration.
   */
  actions?: TaskAction[];
};

export interface AgentAdapter {
  readonly provider: AgentProviderInfo;
  listSessions(): Promise<AgentSession[]>;
  createSession(input: CreateSessionInput): Promise<AgentSession>;
  switchSession(sessionId: string): Promise<AgentSession>;
  sendMessage(input: SendMessageInput): Promise<AdapterResult>;
  cancelTask(taskId: string): Promise<void>;
}

/**
 * Thrown by an adapter when the task failed but the trace is still worth
 * showing. A rejected promise alone cannot carry it, and "what it tried before
 * failing" is usually the most useful thing the phone can display.
 */
export class AdapterTaskError extends Error {
  readonly actions?: TaskAction[];
  constructor(message: string, actions?: TaskAction[]) {
    super(message);
    this.name = 'AdapterTaskError';
    this.actions = actions;
  }
}
