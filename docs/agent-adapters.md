# 通用 Agent Provider 与会话模型

Remote Agent Bridge 不绑定某一个 Agent 产品。WorkBuddy、Claude Code、OpenClaw、自研 Agent 或其他工具，都通过 Provider Adapter 接入。当前 Windows 版已内置 WorkBuddy CLI Adapter：它调用 WorkBuddy 安装目录中自带的 CodeBuddy 无头 CLI，不模拟鼠标键盘，不切换前台窗口。

## Provider 类型

当前协议预留以下传输类型：

- `local`：Agent 内置执行器，用于本地能力和开发测试。
- `cli`：启动并管理 CLI 子进程。
- `http`：调用外部 HTTP Agent API。
- `websocket`：连接外部 WebSocket Agent。
- `mcp`：通过 MCP Client 调用工具或 Agent。
- `gui`：只能通过桌面 UI Automation 操作的 Agent。

## WorkBuddy（Windows）

WorkBuddy 桌面安装包自带 `resources/app.asar.unpacked/cli/bin/codebuddy`。配置页的“自动检测”会找到 WorkBuddy 安装目录，并保存一个 `cli` Provider。Agent 会以后台子进程执行：

- `--print --output-format stream-json`：手机消息完成后返回最终文本。
- `--resume`：同一个 Remote Agent Bridge 会话映射到 WorkBuddy 会话，重启后继续上下文。
- `--permission-mode`：在配置页选择 `auto`、`acceptEdits`、`dontAsk` 或完全无人值守模式。
- `windowsHide: true` 和独立子进程：不抢占当前桌面焦点。

保存后需要重启 Remote Agent Bridge。手机端创建新会话时会优先选择 WorkBuddy；已有会话仍保持原 Provider。

Provider 必须声明自己的能力和允许的交互模式。手机端只展示声明支持的功能，不假设所有 Provider 都拥有相同能力。

CLI Provider 还应声明 `adapter`。例如 WorkBuddy 使用 `adapter: "workbuddy"`。未知的 CLI Adapter 不会被当成 WorkBuddy 启动，避免错误使用不兼容的命令参数。Codex CLI 使用独立的 `codex` Adapter，因此新增其他 CLI 时也不需要修改 Gateway、手机页面或会话协议。

Codex CLI 使用 `adapter: "codex"`。它通过 `codex exec --json` 启动非交互任务，通过 `codex exec resume <thread_id> --json` 恢复上下文；`sandboxMode` 可选 `read-only`、`workspace-write` 或 `danger-full-access`，默认只读。Codex 桌面 UI 不属于当前 Adapter 的控制范围。

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
  switchSession(sessionId: string): Promise<AgentSession>;
  sendMessage(input: SendMessageInput): Promise<AdapterResult>;
  cancelTask(taskId: string): Promise<void>;
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

Agent 用两个时钟约束每个任务：总时长预算（默认 15 分钟，单任务可用 `timeout_ms` 覆盖，上限 2 小时）和静默预算（默认 10 分钟没有任何输出即视为挂起）。任何一个到期都会调用 `cancelTask`。因此 Adapter 必须做到：

- **报告进展**：`sendMessage` 会在 `input.onActivity` 上给出一个回调，Provider 每次有进展（例如子进程产生输出）都要调用它。不报告进展的 Adapter 和挂死的 Adapter 无法区分，会被静默预算终止。
- **终止整棵进程树**：`cancelTask` 不能只调 `child.kill()`。可直接复用 `services/agent/src/process-control.ts` 的 `terminateProcessTree`，它会在 Windows 上用 `taskkill /PID <pid> /T /F`（必须在父进程还活着时执行，否则子进程会被重新挂到别的父进程下而无法按 PID 枚举），在 POSIX 上用 `spawn(..., { detached: true })` 配合对进程组发 `SIGTERM`，超时后升级为 `SIGKILL`。只杀直接子进程会留下继续消耗 CPU 和额度的后台进程；而 Agent 一次只执行一个任务，残留进程会和下一个任务重叠。

`terminateProcessTree` 会等到子进程真正退出才返回，因此 `cancelTask` 返回后可以认为进程树已经清理干净。

## GUI Provider 规则

GUI Provider 必须使用 `isolated-gui`，并且不能默认操作用户当前桌面。推荐顺序：

1. 独立后台实例或 headless 模式。
2. 独立 Windows 用户会话。
3. 独立虚拟机或容器中的 GUI。
4. 最后才考虑前台桌面操作，并要求明确确认。

如果无法隔离，Provider 必须拒绝任务，而不是偷偷抢占鼠标、键盘或焦点。
