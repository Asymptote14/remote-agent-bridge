import type { TaskCreate, TaskRisk } from '@rab/protocol';

/**
 * Risk classification for incoming tasks.
 *
 * This is deliberately a heuristic over the user's own sentence, not a
 * sandbox: it decides whether the phone should be asked before the task is
 * dispatched at all. Anything that can destroy data, change the machine's
 * configuration, run code fetched from the network, or hand over privileges
 * is treated as high risk and stops at `awaiting_confirmation`.
 *
 * It over-triggers on purpose. A confirmation tap is cheap; a wiped directory
 * is not.
 */
type Rule = { pattern: RegExp; reason: string };

const RULES: Rule[] = [
  // Irreversible data loss.
  { pattern: /\brm\s+(-[a-z]*[rf][a-z]*\s+)+/i, reason: '递归或强制删除文件' },
  { pattern: /\b(del|erase)\s+\/[a-z]*[sfq]/i, reason: '强制删除文件' },
  { pattern: /\b(rmdir|rd)\s+\/s/i, reason: '递归删除目录' },
  { pattern: /Remove-Item[\s\S]*-(Recurse|Force)/i, reason: '递归或强制删除文件' },
  { pattern: /\bformat\s+[a-z]:/i, reason: '格式化磁盘' },
  { pattern: /删除|删掉|清空|抹掉|格式化|销毁|卸载|uninstall/i, reason: '删除或卸载数据、程序' },
  { pattern: /\bgit\s+(reset\s+--hard|clean\s+-[a-z]*f|push\s+(-f|--force))/i, reason: '丢弃提交历史或强制推送' },
  { pattern: /\b(drop\s+(table|database)|truncate\s+table)\b/i, reason: '删除数据库对象' },

  // Machine availability.
  { pattern: /关机|重启|注销|shutdown|reboot|poweroff|Restart-Computer|Stop-Computer/i, reason: '关机或重启电脑' },
  { pattern: /\b(taskkill|pkill|killall|kill\s+-9)\b|Stop-Process|结束进程|杀进程/i, reason: '强制结束进程' },

  // Privilege and policy changes.
  { pattern: /\bsudo\b|\brunas\b|管理员权限|Set-ExecutionPolicy|\bchmod\s+777\b|\btakeown\b/i, reason: '提升权限或修改安全策略' },
  { pattern: /\breg\s+(add|delete)\b|注册表/i, reason: '修改注册表' },
  { pattern: /\bnetsh\s+advfirewall\b|\biptables\b|\bufw\s+/i, reason: '修改防火墙规则' },

  // Code from the network, executed immediately.
  { pattern: /(curl|wget)[^\n|]*\|\s*(ba)?sh|iwr[^\n|]*\|\s*iex|Invoke-Expression|\biex\s*\(/i, reason: '执行从网络下载的代码' },

  // Installing software changes the machine outside the workspace.
  { pattern: /(apt|apt-get|brew|choco|winget|scoop)\s+(install|uninstall|remove)|npm\s+(i|install)\s+-g|pnpm\s+add\s+-g|pip\s+install|安装软件|安装包/i, reason: '安装或卸载软件' },
];

const MAX_REASONS = 4;

export function classifyTask(task: Pick<TaskCreate, 'input' | 'kind'>): { risk: TaskRisk; reasons: string[] } {
  const text = String(task.input ?? '');
  const reasons: string[] = [];
  for (const rule of RULES) {
    if (!rule.pattern.test(text)) continue;
    if (!reasons.includes(rule.reason)) reasons.push(rule.reason);
    if (reasons.length >= MAX_REASONS) break;
  }
  // A task the client explicitly declares as a shell command is arbitrary
  // execution by definition, whatever the wording.
  if (task.kind === 'shell' && !reasons.includes('执行任意命令')) reasons.unshift('执行任意命令');
  return { risk: reasons.length > 0 ? 'high' : 'low', reasons: reasons.slice(0, MAX_REASONS) };
}
