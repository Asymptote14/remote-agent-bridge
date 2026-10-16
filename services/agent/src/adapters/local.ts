import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readdir, readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AgentAdapter, AdapterResult, CreateSessionInput, SendMessageInput } from '@rab/adapter-sdk';
import type { AgentProviderInfo, AgentSession } from '@rab/protocol';

const execFileAsync = promisify(execFile);
const workspaceRoot = resolve(process.env.RAB_WORKSPACE ?? process.cwd());

function insideWorkspace(candidate: string) {
  const target = resolve(workspaceRoot, candidate);
  const relativePath = relative(workspaceRoot, target);
  return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath)) ? target : undefined;
}

export class LocalAdapter implements AgentAdapter {
  readonly provider: AgentProviderInfo = {
    id: 'local',
    name: 'Local Computer Agent',
    transport: 'local',
    capabilities: ['sessions', 'create_session', 'switch_session', 'conversation_context', 'system.info', 'process.list', 'file.list', 'file.read', 'background_tasks'],
    interaction_modes: ['isolated'],
  };

  private readonly sessions = new Map<string, AgentSession>();

  async listSessions(): Promise<AgentSession[]> { return [...this.sessions.values()]; }

  async createSession(input: CreateSessionInput): Promise<AgentSession> {
    const now = new Date().toISOString();
    const session: AgentSession = { id: input.sessionId || `session_${randomUUID().slice(0, 8)}`, provider_id: this.provider.id, title: input.title?.trim() || '新会话', created_at: now, updated_at: now };
    this.sessions.set(session.id, session);
    return session;
  }

  async switchSession(sessionId: string): Promise<AgentSession> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error('session_not_found');
    session.updated_at = new Date().toISOString();
    return session;
  }

  private async actualLocalAction(text: string): Promise<string | undefined> {
    if (/时间|日期|现在几点|当前时间/i.test(text)) return `电脑当前时间：${new Date().toLocaleString()}`;
    if (/系统信息|电脑信息|运行环境/i.test(text)) return `系统：${process.platform} ${process.arch}\nNode：${process.version}\n工作目录：${workspaceRoot}`;
    if (/进程|任务管理|运行中的程序/i.test(text)) {
      const file = process.platform === 'win32' ? 'tasklist' : 'ps';
      const args = process.platform === 'win32' ? ['/fo', 'csv', '/nh'] : ['-eo', 'pid,comm,%cpu,%mem'];
      const result = await execFileAsync(file, args, { windowsHide: true, maxBuffer: 512 * 1024 });
      return result.stdout.split(/\r?\n/).slice(0, 16).join('\n');
    }
    const listMatch = text.match(/(?:列出|查看|显示)(?:目录|文件夹)?\s*[：:]?\s*(.*)/);
    if (listMatch && /文件|目录|文件夹/.test(text)) {
      const target = insideWorkspace(listMatch[1].trim() || '.');
      if (!target) throw new Error('path_outside_workspace');
      const items = await readdir(target, { withFileTypes: true });
      return items.slice(0, 100).map(item => `${item.isDirectory() ? '[目录]' : '[文件]'} ${item.name}`).join('\n') || '目录为空';
    }
    const readMatch = text.match(/(?:读取|查看文件)\s*[：:]?\s*(\S+)/);
    if (readMatch) {
      const target = insideWorkspace(readMatch[1]);
      if (!target) throw new Error('path_outside_workspace');
      const content = await readFile(target, 'utf8');
      return content.slice(0, 12_000) + (content.length > 12_000 ? '\n…（内容已截断）' : '');
    }
    if (/打开|启动|点击|鼠标|键盘|截图|浏览器|Chrome|Edge/i.test(text)) {
      throw new Error('gui_action_requires_dedicated_adapter');
    }
    return undefined;
  }

  async sendMessage(input: SendMessageInput): Promise<AdapterResult> {
    if (input.mode !== 'isolated') throw new Error('provider_mode_not_supported');
    const session = await this.switchSession(input.sessionId);
    const action = await this.actualLocalAction(input.text);
    const context = input.history?.length ? `（已读取本会话最近 ${input.history.length} 条消息作为上下文）` : '';
    return { session, message: action ? `${action}${context}` : `本地 Agent 已收到消息${context}。当前可执行：时间/系统信息、进程列表、工作目录文件列表和安全文件读取。` };
  }

  async cancelTask(_taskId: string): Promise<void> {}
}
