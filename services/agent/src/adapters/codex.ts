import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AgentAdapter, AdapterResult, CreateSessionInput, SendMessageInput } from '@rab/adapter-sdk';
import type { AgentProviderInfo, AgentSession } from '@rab/protocol';
import { dataDir, type ProviderConfig } from '@rab/config';
import { terminateProcessTree } from '../process-control.js';

type CodexState = { externalThreadId: string; updatedAt: string };
type JsonEvent = {
  type?: string;
  thread_id?: string;
  message?: unknown;
  item?: unknown;
  result?: unknown;
  error?: unknown;
};
type JsonItem = {
  type?: string;
  text?: unknown;
  content?: unknown;
  output_text?: unknown;
  message?: unknown;
  result?: unknown;
};

/**
 * Runs the installed Codex CLI in non-interactive JSON mode. The adapter never
 * launches the desktop app or sends input to the user's foreground window.
 */
export class CodexAdapter implements AgentAdapter {
  readonly provider: AgentProviderInfo;
  private readonly config: ProviderConfig;
  private readonly sessions = new Map<string, AgentSession>();
  private readonly externalThreadIds = new Map<string, string>();
  private readonly running = new Map<string, ChildProcessWithoutNullStreams>();
  private readonly statePath = join(dataDir, 'codex-sessions.json');

  constructor(config: ProviderConfig) {
    this.config = config;
    this.provider = {
      id: config.id,
      name: config.name || 'Codex',
      transport: 'cli',
      capabilities: [
        'sessions',
        'create_session',
        'switch_session',
        'conversation_context',
        'background_tasks',
        'codex.headless',
      ],
      interaction_modes: ['isolated'],
    };
    this.loadState();
  }

  private loadState() {
    if (!existsSync(this.statePath)) return;
    try {
      const data = JSON.parse(readFileSync(this.statePath, 'utf8')) as Record<string, CodexState>;
      for (const [sessionId, item] of Object.entries(data)) {
        if (item?.externalThreadId) this.externalThreadIds.set(sessionId, item.externalThreadId);
      }
    } catch {
      // The mapping is disposable; the next message starts a new Codex thread.
    }
  }

  private persistState() {
    mkdirSync(dirname(this.statePath), { recursive: true });
    const data: Record<string, CodexState> = {};
    for (const [sessionId, externalThreadId] of this.externalThreadIds) {
      data[sessionId] = { externalThreadId, updatedAt: new Date().toISOString() };
    }
    writeFileSync(this.statePath, JSON.stringify(data, null, 2), 'utf8');
  }

  private session(sessionId: string, title = 'Codex 会话'): AgentSession {
    const current = this.sessions.get(sessionId);
    if (current) return current;
    const now = new Date().toISOString();
    const created: AgentSession = { id: sessionId, provider_id: this.provider.id, title, created_at: now, updated_at: now };
    this.sessions.set(sessionId, created);
    return created;
  }

  async listSessions(): Promise<AgentSession[]> { return [...this.sessions.values()]; }

  async createSession(input: CreateSessionInput): Promise<AgentSession> {
    return this.session(input.sessionId, input.title?.trim() || 'Codex 会话');
  }

  async switchSession(sessionId: string): Promise<AgentSession> {
    return this.session(sessionId);
  }

  private command(): { file: string; argsPrefix: string[] } {
    const configured = this.config.executable?.trim();
    if (!configured) throw new Error('codex_cli_path_required');
    const extension = extname(configured).toLowerCase();
    if (extension === '.cmd' || extension === '.bat') {
      return { file: process.env.ComSpec || 'cmd.exe', argsPrefix: ['/d', '/s', '/c', configured] };
    }
    if (extension === '.js') return { file: this.config.runtime?.trim() || process.execPath, argsPrefix: [configured] };
    return { file: configured, argsPrefix: [] };
  }

  private extractText(value: unknown): string {
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return value.map(item => this.extractText(item)).filter(Boolean).join('\n');
    if (value && typeof value === 'object') {
      const item = value as Record<string, unknown>;
      return this.extractText(item.text ?? item.output_text ?? item.result ?? item.content ?? item.message);
    }
    return '';
  }

  private completedMessage(events: JsonEvent[]): string {
    // Codex emits tool/reasoning items alongside the final agent_message. Only
    // use the latter as the answer so progress events never leak to the phone.
    const finalMessages = events
      .filter(event => event.type === 'item.completed')
      .map(event => event.item)
      .filter(item => item && typeof item === 'object' && (item as JsonItem).type === 'agent_message')
      .map(item => this.extractText(item))
      .filter(Boolean);
    if (finalMessages.length > 0) return finalMessages[finalMessages.length - 1];

    const directMessages = events
      .filter(event => event.type === 'message')
      .map(event => this.extractText(event.message))
      .filter(Boolean);
    return directMessages[directMessages.length - 1] || '';
  }

  private errorText(events: JsonEvent[], stderr: string): string {
    const eventError = [...events].reverse()
      .map(event => event.type === 'error' ? event.message : event.error ?? (event.item && this.extractText(event.item)))
      .map(value => this.extractText(value))
      .find(Boolean);
    return eventError || stderr.trim();
  }

  private async run(input: SendMessageInput, externalThreadId?: string): Promise<{ message: string; externalThreadId?: string }> {
    const command = this.command();
    const sandbox = this.config.sandboxMode || 'read-only';
    const bypass = this.config.permissionMode === 'bypassPermissions' || sandbox === 'danger-full-access';
    const args = externalThreadId
      ? [...command.argsPrefix, 'exec', 'resume', externalThreadId, '--json', '--skip-git-repo-check', ...(bypass ? ['--dangerously-bypass-approvals-and-sandbox'] : []), input.text]
      : [...command.argsPrefix, 'exec', '--json', '--skip-git-repo-check', '--sandbox', sandbox, ...(bypass ? ['--dangerously-bypass-approvals-and-sandbox'] : []), input.text];

    const cwd = resolve(this.config.cwd?.trim() || process.env.RAB_WORKSPACE || process.cwd());
    const child = spawn(command.file, args, {
      cwd,
      windowsHide: true,
      // Making the child a process-group leader is what allows the whole tree
      // to be signalled on POSIX. Windows has no equivalent and uses taskkill.
      detached: process.platform !== 'win32',
      env: { ...process.env, FORCE_COLOR: '0' },
    });
    this.running.set(input.taskId, child);
    // The prompt is passed as an argument. Closing stdin prevents Codex from
    // waiting for an optional extra prompt in a long-lived Agent process.
    child.stdin.end();

    return new Promise((resolveResult, reject) => {
      let stdout = '';
      let stderr = '';
      let settled = false;
      const finish = (error?: Error, result?: { message: string; externalThreadId?: string }) => {
        if (settled) return;
        settled = true;
        this.running.delete(input.taskId);
        if (error) reject(error);
        else resolveResult(result!);
      };
      const append = (target: 'stdout' | 'stderr', chunk: Buffer | string) => {
        const value = chunk.toString();
        if (target === 'stdout') stdout = (stdout + value).slice(-2_000_000);
        else stderr = (stderr + value).slice(-100_000);
        // Any output at all is proof the CLI is still working, which is what
        // keeps a long but healthy run from tripping the idle timeout.
        input.onActivity?.();
      };
      child.stdout.on('data', chunk => append('stdout', chunk));
      child.stderr.on('data', chunk => append('stderr', chunk));
      child.on('error', error => finish(new Error(`codex_start_failed: ${error.message}`)));
      child.on('close', code => {
        const events: JsonEvent[] = [];
        for (const line of stdout.split(/\r?\n/).map(item => item.trim()).filter(Boolean)) {
          try { events.push(JSON.parse(line) as JsonEvent); } catch { /* diagnostics may share stdout */ }
        }
        const thread = events.find(event => event.type === 'thread.started' && event.thread_id)?.thread_id
          || events.find(event => event.thread_id)?.thread_id;
        const message = this.completedMessage(events) || this.extractText(events[events.length - 1]?.result);
        if (code !== 0) finish(new Error(this.errorText(events, stderr) || `codex_exit_${code}`));
        else if (!message) finish(new Error(this.errorText(events, stderr) || 'codex_empty_response'));
        else finish(undefined, { message, externalThreadId: thread });
      });
    });
  }

  async sendMessage(input: SendMessageInput): Promise<AdapterResult> {
    if (input.mode !== 'isolated') throw new Error('codex_foreground_mode_disabled');
    const session = await this.switchSession(input.sessionId);
    const externalThreadId = this.externalThreadIds.get(input.sessionId);
    const result = await this.run(input, externalThreadId);
    if (result.externalThreadId && result.externalThreadId !== externalThreadId) {
      this.externalThreadIds.set(input.sessionId, result.externalThreadId);
      this.persistState();
    }
    session.updated_at = new Date().toISOString();
    return { session, message: result.message };
  }

  async cancelTask(taskId: string): Promise<void> {
    const child = this.running.get(taskId);
    if (!child) return;
    // `child.kill()` would only take down the launcher and leave the real
    // Codex process running; see process-control.ts.
    await terminateProcessTree(child);
  }
}
