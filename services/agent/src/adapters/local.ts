import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { dataDir, getProviderConfigPath, runtimeConfigPath } from '@rab/config';
import type { AgentAdapter, AdapterResult, CreateSessionInput, SendMessageInput } from '@rab/adapter-sdk';
import type { AgentProviderInfo, AgentSession } from '@rab/protocol';
import { LocalWorkspace } from '../local-workspace.js';

const execFileAsync = promisify(execFile);
const unquote = (value = '') => value.trim().replace(/^(?:"([^"]*)"|'([^']*)')$/u, (_match, doubleQuoted, singleQuoted) => doubleQuoted ?? singleQuoted);

export class LocalAdapter implements AgentAdapter {
  readonly provider: AgentProviderInfo = {
    id: 'local',
    name: 'Local Computer Agent',
    transport: 'local',
    capabilities: ['sessions', 'create_session', 'switch_session', 'conversation_context', 'system.info', 'process.list', 'file.list', 'file.read', 'background_tasks'],
    interaction_modes: ['isolated'],
  };

  private readonly sessions = new Map<string, AgentSession>();

  constructor(private readonly workspace = new LocalWorkspace(process.env.RAB_WORKSPACE || process.cwd(), () => [dataDir, runtimeConfigPath, getProviderConfigPath()])) {}

  async listSessions(): Promise<AgentSession[]> { return [...this.sessions.values()]; }

  async createSession(input: CreateSessionInput): Promise<AgentSession> {
    input.signal?.throwIfAborted();
    const now = new Date().toISOString();
    const session: AgentSession = { id: input.sessionId || `session_${randomUUID().slice(0, 8)}`, provider_id: this.provider.id, title: input.title?.trim() || '新会话', created_at: now, updated_at: now };
    this.sessions.set(session.id, session);
    return session;
  }

  async switchSession(sessionId: string, signal?: AbortSignal): Promise<AgentSession> {
    signal?.throwIfAborted();
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error('session_not_found');
    session.updated_at = new Date().toISOString();
    return session;
  }

  private async actualLocalAction(text: string, signal?: AbortSignal): Promise<string | undefined> {
    const input = text.trim();
    const readMatch = input.match(/^(?:读取(?:文件)?|查看文件(?!夹|列表))\s*[：:]?\s*(.+)$/u);
    if (readMatch) return this.workspace.readText(unquote(readMatch[1]), signal);
    const listMatch = input.match(/^(?:列出|查看|显示)(?:(?:当前)?工作目录(?:的文件)?|文件夹|文件列表|目录|文件)\s*[：:]?\s*(.*)$/u);
    if (listMatch) return this.workspace.list(unquote(listMatch[1]) || '.', signal);
    if (/时间|日期|现在几点|当前时间/i.test(text)) return `电脑当前时间：${new Date().toLocaleString()}`;
    if (/系统信息|电脑信息|运行环境/i.test(text)) return `系统：${process.platform} ${process.arch}\nNode：${process.version}`;
    if (/进程|任务管理|运行中的程序/i.test(text)) {
      const file = process.platform === 'win32' ? join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tasklist.exe') : 'ps';
      const args = process.platform === 'win32' ? ['/fo', 'csv', '/nh'] : ['-eo', 'pid,comm,%cpu,%mem'];
      try {
        const result = await execFileAsync(file, args, { windowsHide: true, maxBuffer: 512 * 1024, timeout: 3_000, signal });
        return result.stdout.split(/\r?\n/).slice(0, 16).join('\n');
      } catch { throw new Error('process_list_unavailable'); }
    }
    if (/打开|启动|点击|鼠标|键盘|截图|浏览器|Chrome|Edge/i.test(text)) {
      throw new Error('gui_action_requires_dedicated_adapter');
    }
    return undefined;
  }

  async sendMessage(input: SendMessageInput): Promise<AdapterResult> {
    if (input.mode !== 'isolated') throw new Error('provider_mode_not_supported');
    input.signal?.throwIfAborted();
    const session = await this.switchSession(input.sessionId);
    input.signal?.throwIfAborted();
    const action = await this.actualLocalAction(input.text, input.signal);
    input.signal?.throwIfAborted();
    const context = input.history?.length ? `（已读取本会话最近 ${input.history.length} 条消息作为上下文）` : '';
    return { session, message: action ? `${action}${context}` : `本地 Agent 已收到消息${context}。当前可执行：时间/系统信息、进程列表、工作目录文件列表和安全文件读取。` };
  }

  async cancelTask(_taskId: string): Promise<never> { throw new Error('local_cancellation_unconfirmed'); }
}
