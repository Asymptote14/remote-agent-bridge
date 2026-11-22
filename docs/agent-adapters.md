# 通用 Agent Provider 与会话模型

Remote Agent Bridge 通过 Adapter 对接执行器。当前实现 Local、HTTP、WorkBuddy 无头 CLI 和 Codex CLI；并未实现 Claude Code 或 OpenClaw 专用 Adapter。`websocket`、`mcp` 和 `gui` 目前仅有协议类型。

## Provider 类型

当前协议预留以下传输类型：

- `local`：Agent 内置执行器，用于本地能力和开发测试。
- `cli`：启动并管理 CLI 子进程。
- `http`：调用外部 HTTP Agent API。
- `websocket`：连接外部 WebSocket Agent。
- `mcp`：通过 MCP Client 调用工具或 Agent。
- `gui`：只能通过桌面 UI Automation 操作的 Agent。

## Local（默认）

支持当前时间、系统信息、进程列表和工作区目录/文本读取。部署时用 `RAB_WORKSPACE` 明确指定允许读的绝对路径；未配置时使用 Agent 的启动目录。路径必须相对，不允许越界、链接、硬链接（读取时）、配置数据目录或受保护名称。文本要求 UTF‑8，最多读取 16 KiB 加截断判断；目录最多检查 500 项、显示 100 项。这些是应用层只读限制，不等同于针对恶意本地进程或机密文件的操作系统沙箱。不要将保密内容放进允许远程读取的目录。

## WorkBuddy（Windows）

WorkBuddy 桌面安装包自带 `resources/app.asar.unpacked/cli/bin/codebuddy`。配置页的“自动检测”会找到 WorkBuddy 安装目录，并保存一个 `cli` Provider。Agent 会以后台子进程执行：

- `--print --output-format stream-json`：手机消息完成后返回最终文本。
- `--resume`：同一个 Remote Agent Bridge 会话映射到 WorkBuddy 会话，重启后继续上下文。
- `--permission-mode`：在配置页选择 `auto`、`acceptEdits`、`dontAsk` 或完全无人值守模式。
- `windowsHide: true` 和独立子进程：不抢占当前桌面焦点。

保存后需要重启 Remote Agent Bridge。新会话默认优先选择 Local；手动选择已上线的 WorkBuddy。已有会话仍保持原 Provider。

Provider 必须声明自己的能力和允许的交互模式。手机端只展示声明支持的功能，不假设所有 Provider 都拥有相同能力。

CLI Provider 还应声明 `adapter`。例如 WorkBuddy 使用 `adapter: "workbuddy"`。未知的 CLI Adapter 不会被当成 WorkBuddy 启动，避免错误使用不兼容的命令参数。Codex CLI 使用独立的 `codex` Adapter，因此新增其他 CLI 时也不需要修改 Gateway、手机页面或会话协议。

Codex CLI 使用 `adapter: "codex"`。它通过 `codex exec --json` 启动非交互任务，通过 `codex exec resume` 恢复上下文；提示词走 stdin，启动和恢复都显式传递配置中的沙箱模式，默认只读。仍需用受支持的实际 CLI 和受控工作区验证；后台模式与手机确认不会提升权限，也不能代替沙箱验证。

Windows 上不支持 `.cmd` / `.bat` 包装器：请选择原生可执行文件或实际的 `.js` / `.mjs` / `.cjs` Node 入口。WorkBuddy 也可指向 `WorkBuddy.exe`，由 Adapter 直接定位它带的 Node 启动器，不执行界面程序。

## 会话模型

手机会话和外部 Agent 会话通过 `session_id` 关联：

```text
手机会话
  ├─ provider_id
  ├─ session_id
  └─ 消息历史
          ↓
Provider Adapter
          ↓
外部 Agent 会话 / CLI 进程 / GUI 会话
```

支持的通用操作：

- 列出会话
- 新建会话
- 切换会话
- 向当前会话发送消息
- 取消任务

如果外部 Agent 原生支持会话，Adapter 直接映射它的会话 ID；如果不支持，Adapter 可以通过独立进程、工作目录、上下文文件或独立 GUI 实例模拟会话。

## 如何新增 Provider

实现 `@rab/adapter-sdk` 的 `AgentAdapter`：

```ts
interface AgentAdapter {
  readonly provider: AgentProviderInfo;
  listSessions(): Promise<AgentSession[]>;
  createSession(input: CreateSessionInput): Promise<AgentSession>;
  switchSession(sessionId: string, signal?: AbortSignal): Promise<AgentSession>;
  sendMessage(input: SendMessageInput): Promise<AdapterResult>;
  cancelTask(taskId: string): Promise<'stopped' | 'not_found'>;
}
```

然后在 Agent 启动时注册：

```ts
const adapters = new Map([
  ['local', new LocalAdapter()],
  ['example-cli', new ExampleCliAdapter()],
]);
```

Gateway、手机 Web 和协议层不需要为具体产品增加分支。

### 超时与进程树

Agent 从会话准备阶段开始计时：总时长默认 15 分钟，上限 2 小时；静默默认 10 分钟。取消和超时会触发 `AbortSignal`；已进入外部 Provider 的执行还需要独立停止验证。因此 Adapter 必须做到：

- **协作停止和报告进展**：会话准备、执行和发出请求前检查 `signal`，避免取消后继续启动进程。`sendMessage` 发生实际进展时调用 `input.onActivity`；静默超过预算会被中止。
- **终止整棵进程树**：`cancelTask` 不能只调 `child.kill()`。可直接复用 `services/agent/src/process-control.ts` 的 `terminateProcessTree`，它会在 Windows 上用 `taskkill /PID <pid> /T /F`（必须在父进程还活着时执行，否则子进程会被重新挂到别的父进程下而无法按 PID 枚举），在 POSIX 上用 `spawn(..., { detached: true })` 配合对进程组发 `SIGTERM`，超时后升级为 `SIGKILL`。只杀直接子进程会留下继续消耗 CPU 和额度的后台进程；而 Agent 一次只执行一个任务，残留进程会和下一个任务重叠。

`cancelTask` 只在停止得到确认时返回 `stopped`；没有句柄返回 `not_found`，不能把它当作停止证据。Windows 检查终止工具及启动进程退出情况，POSIX 检查受管进程组。Agent 最多等待约 10 秒验证清理；证据不足，或执行仍未结束时标记「结果未知」并暂停队列。若只确认停止、未收到可靠最终结果，任务仍可为「结果未知」。取消不会撤销已经发生的操作，受管进程的停止不代表受管范围外的工作也停止。

### HTTP 接入约束

仅配置操作者信任的 HTTP(S) endpoint，跨主机使用实际验证的 HTTPS。请求不跟随重定向。各接口返回 JSON 对象，成功响应体最多 256 KiB：

| 接口 | 预期 |
|---|---|
| `GET /sessions` | `{ sessions: […] }` |
| `POST /sessions` | 接收 `{ sessionId, title }`，返回 `{ session }`，其 ID 等于 `sessionId` |
| `POST /sessions/:id/switch` | 返回对应 `{ session }`；不存在返回 HTTP 404 |
| `POST /sessions/:id/messages` | 接收 `{ taskId, sessionId, text, mode, timeoutMs, history }`，返回 `{ session, message }`；完成回复必须对应请求的会话 |
| `POST /tasks/:id/cancel` | 只有对端持有停止证据时返回 `{ "cancelled": true }`；仅接到请求不能这样回复 |

会话需提供 `id`、`title`、`created_at`、`updated_at`，时间为可解析的日期。会话接口约 4 秒截止，取消接口约 8 秒，消息同时受任务总预算和静默预算。请求本地中止或返回异常不证明远端未执行；请在对端结合任务编号核对。

## GUI Provider 规则

GUI Provider 必须使用 `isolated-gui`，并且不能默认操作用户当前桌面。推荐顺序：

1. 独立后台实例或 headless 模式。
2. 独立 Windows 用户会话。
3. 独立虚拟机或容器中的 GUI。
4. 最后才考虑前台桌面操作，并要求明确确认。

如果无法隔离，Provider 必须拒绝任务，而不是偷偷抢占鼠标、键盘或焦点。
