import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, basename, dirname, extname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { AgentAdapter, AdapterResult, CreateSessionInput, SendMessageInput } from '@rab/adapter-sdk';
import type { AgentProviderInfo, AgentSession } from '@rab/protocol';
import { dataDir, type ProviderConfig } from '@rab/config';
import { terminateProcessTree } from '../process-control.js';

type WorkBuddyState = { externalSessionId: string; updatedAt: string };
type StreamEvent = {
  type?: string;
  subtype?: string;
  session_id?: string;
  result?: string;
  message?: unknown;
  content?: unknown;
  error?: unknown;
};

/**
 * WorkBuddy ships the CodeBuddy CLI in its installation directory. This
 * adapter uses the CLI's headless stream-json mode instead of UI automation,
 * so the user's current foreground application is never focused or disturbed.
 */
export class WorkBuddyAdapter implements AgentAdapter {
  readonly provider: AgentProviderInfo;
  private readonly sessions = new Map<string, AgentSession>();
  private readonly externalSessionIds = new Map<string, string>();
  private readonly running = new Map<string, ChildProcessWithoutNullStreams>();
  private readonly statePath = join(dataDir, 'workbuddy-sessions.json');
  private readonly config: ProviderConfig;

  constructor(config: ProviderConfig) {
    this.config = config;
    this.provider = {
      id: config.id,
      name: config.name || 'WorkBuddy',
      transport: 'cli',
      capabilities: [
        'sessions',
        'create_session',
        'switch_session',
        'conversation_context',
        'background_tasks',
        'workbuddy.headless',
      ],
      interaction_modes: ['isolated'],
    };
    this.loadState();
  }

  private loadState() {
    if (!existsSync(this.statePath)) return;
    try {
      const data = JSON.parse(readFileSync(this.statePath, 'utf8')) as Record<string, WorkBuddyState>;
      for (const [sessionId, item] of Object.entries(data)) {
        if (item?.externalSessionId) this.externalSessionIds.set(sessionId, item.externalSessionId);
      }
    } catch {
      // A damaged mapping is recoverable; the next message creates a new CLI session.
    }
  }

  private persistState() {
    mkdirSync(dirname(this.statePath), { recursive: true });
    const data: Record<string, WorkBuddyState> = {};
    for (const [sessionId, externalSessionId] of this.externalSessionIds) {
      data[sessionId] = { externalSessionId, updatedAt: new Date().toISOString() };
    }
    writeFileSync(this.statePath, JSON.stringify(data, null, 2), 'utf8');
  }

  private session(sessionId: string, title = 'WorkBuddy 会话'): AgentSession {
    const current = this.sessions.get(sessionId);
    if (current) return current;
    const now = new Date().toISOString();
    const created: AgentSession = { id: sessionId, provider_id: this.provider.id, title, created_at: now, updated_at: now };
    this.sessions.set(sessionId, created);
    return created;
  }

  async listSessions(): Promise<AgentSession[]> { return [...this.sessions.values()]; }

  async createSession(input: CreateSessionInput): Promise<AgentSession> {
    return this.session(input.sessionId, input.title?.trim() || 'WorkBuddy 会话');
  }

  async switchSession(sessionId: string): Promise<AgentSession> {
    return this.session(sessionId);
  }

  private cliScript(): string {
    const configured = this.config.executable?.trim();
    if (!configured) throw new Error('workbuddy_cli_path_required');
    const lower = configured.toLowerCase();
    if (lower.endsWith('workbuddy.exe')) {
      return join(dirname(configured), 'resources', 'app.asar.unpacked', 'cli', 'bin', 'codebuddy');
    }
    return configured;
  }

  private command(): { file: string; argsPrefix: string[] } {
    const script = this.cliScript();
    const extension = extname(script).toLowerCase();
    if (extension === '.cmd' || extension === '.bat') {
      return { file: process.env.ComSpec || 'cmd.exe', argsPrefix: ['/d', '/s', '/c', script] };
    }
    if (extension === '.js' || basename(script).toLowerCase() === 'codebuddy') {
      return { file: this.config.runtime?.trim() || process.execPath, argsPrefix: [script] };
    }
    return { file: script, argsPrefix: [] };
  }

  private extractText(value: unknown): string {
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return value.map(item => this.extractText(item)).filter(Boolean).join('\n');
    if (value && typeof value === 'object') {
      const item = value as Record<string, unknown>;
      return this.extractText(item.text ?? item.content ?? item.message ?? item.result);
    }
    return '';
  }

  private async run(input: SendMessageInput, externalSessionId?: string): Promise<{ message: string; externalSessionId?: string }> {
    const command = this.command();
    const args = [
      ...command.argsPrefix,
      '-p',
      '--output-format', 'stream-json',
      '--max-turns', '20',
      '--permission-mode', this.config.permissionMode || 'auto',
    ];
    if (this.config.permissionMode === 'bypassPermissions') args.push('--dangerously-skip-permissions');
    if (externalSessionId) args.push('--resume', externalSessionId);
    args.push(input.text);

    const cwd = resolve(this.config.cwd?.trim() || process.env.RAB_WORKSPACE || process.cwd());
    const workbuddyConfigDir = process.env.WORKBUDDY_CONFIG_DIR || process.env.CODEBUDDY_CONFIG_DIR || join(homedir(), '.workbuddy');
    // The bundled CLI expects its per-project transcript directory to exist.
    // Desktop WorkBuddy normally creates it before spawning the sidecar; the
    // bridge launches the sidecar directly, so create the same safe directory.
    const projectKey = cwd.replace(/^[A-Za-z]:[\\/]/, match => `${match[0].toLowerCase()}-`).replace(/[\\/]/g, '-');
    mkdirSync(join(workbuddyConfigDir, 'projects', projectKey), { recursive: true });
    const child = spawn(command.file, args, {
      cwd,
      windowsHide: true,
      // Making the child a process-group leader is what allows the whole tree
      // to be signalled on POSIX. Windows has no equivalent and uses taskkill.
      detached: process.platform !== 'win32',
      env: {
        ...process.env,
        FORCE_COLOR: '0',
        CODEBUDDY_CODE_DISABLE_BACKGROUND_TASKS: '1',
        // WorkBuddy keeps its login, settings and transcript database here.
        // Reusing this directory is what makes the bundled CLI behave like the
        // desktop product instead of creating a separate unauthenticated CLI.
        CODEBUDDY_CONFIG_DIR: workbuddyConfigDir,
        WORKBUDDY_CONFIG_DIR: workbuddyConfigDir,
        CLIENT_INFO_PRODUCT_NAME: 'WorkBuddy',
      },
    });
    this.running.set(input.taskId, child);

    return new Promise((resolveResult, reject) => {
      let stdout = '';
      let stderr = '';
      let settled = false;
      const finish = (error?: Error, result?: { message: string; externalSessionId?: string }) => {
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
      child.on('error', error => finish(new Error(`workbuddy_start_failed: ${error.message}`)));
      child.on('close', code => {
        const events: StreamEvent[] = [];
        for (const line of stdout.split(/\r?\n/).map(item => item.trim()).filter(Boolean)) {
          try { events.push(JSON.parse(line) as StreamEvent); } catch { /* CLI diagnostics can share stdout. */ }
        }
        const init = events.find(event => event.type === 'system' && event.subtype === 'init' && event.session_id);
        const final = [...events].reverse().find(event => event.type === 'result');
        const assistant = events
          .filter(event => event.type === 'assistant')
          .map(event => this.extractText(event.message ?? event.content))
          .filter(Boolean)
          .join('\n');
        const message = this.extractText(final?.result ?? final?.message ?? final?.content) || assistant || stderr.trim();
        const external = init?.session_id || events.find(event => event.session_id)?.session_id;
        if (code !== 0) finish(new Error(message || `workbuddy_exit_${code}`));
        else if (!message) finish(new Error('workbuddy_empty_response'));
        else finish(undefined, { message, externalSessionId: external });
      });
    });
  }

  async sendMessage(input: SendMessageInput): Promise<AdapterResult> {
    if (input.mode !== 'isolated') throw new Error('workbuddy_foreground_mode_disabled');
    const session = await this.switchSession(input.sessionId);
    const external = this.externalSessionIds.get(input.sessionId);
    const result = await this.run(input, external);
    if (result.externalSessionId && result.externalSessionId !== external) {
      this.externalSessionIds.set(input.sessionId, result.externalSessionId);
      this.persistState();
    }
    session.updated_at = new Date().toISOString();
    return { session, message: result.message };
  }

  async cancelTask(taskId: string): Promise<void> {
    const child = this.running.get(taskId);
    if (!child) return;
    // `child.kill()` would only take down the launcher and leave the real
    // CodeBuddy process running; see process-control.ts.
    await terminateProcessTree(child);
  }
}
