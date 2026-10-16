# Remote Agent Bridge

通过手机聊天控制自己的电脑 Agent。项目是自托管模式，不依赖云端账号、云端 Gateway 或公网中继；手机和电脑之间的局域网、虚拟局域网或隧道由用户自行提供。

## 当前状态

这是 v0.1 MVP，已实现本地账号认证、设备配对、持久化会话/消息、移动端 Web 页面、本地 Provider、WorkBuddy 无头 Provider、Codex CLI Provider 和任务闭环：Gateway 接收任务并转发给 Agent，Agent 返回排队、运行和完成事件。

默认执行模式是隔离模式：Agent 在后台队列中处理任务，不主动抢占用户当前的鼠标、键盘或前台窗口。需要 GUI 前台控制的任务会被当前版本拒绝，避免打断用户正在进行的游戏或工作。设计细节见 `docs/non-interference.md`。

项目采用通用 Provider Adapter 和 Session 模型。当前实际实现的适配器只有四个：内置的 `local`（只读系统查询）、`http`、WorkBuddy 无头 CLI（Windows 上可在配置页自动发现 WorkBuddy，用其自带的 CodeBuddy CLI 执行）和 Codex CLI。协议里为 `websocket`、`mcp`、`gui` 预留了传输类型，但**这三种适配器尚未实现**，配置页也接不进它们。适配器规范见 `docs/agent-adapters.md`。

网络访问配置见 `docs/network-access.md`。支持通过樱花内网穿透或 Tailscale/ZeroTier 等虚拟局域网访问；Gateway 会直接提供手机 Web 页面，页面会自动使用当前访问地址。会话、消息和任务记录保存在 `.rab/state.json`（任务记录保留 24 小时、最多 200 条），设备身份保存在 `.rab/agent-identity.json`。`.rab/` 统一放在工作区根目录，Gateway 和 Agent 共用同一份。同一 `task_id` 重复提交是幂等的：重复请求只返回已有结果，不会再次派发给 Agent，也不会重复写入会话消息。

Provider 定义默认保存在 `.rab/providers.json`，也可以在本机配置页中修改文件路径，或设置 `RAB_PROVIDERS_FILE` 环境变量覆盖。仓库提供了不含个人路径和 Token 的 `providers.example.json`。

Codex Provider 使用本机已安装的 `codex exec --json`，新会话创建线程，后续消息使用 `codex exec resume` 恢复上下文；默认是 `read-only` 沙箱。配置页支持自动发现 Codex CLI，启用前请先在本机完成 Codex 登录。

每个任务受两个独立时钟约束：总时长默认 15 分钟（`timeout_ms` 或 `RAB_TASK_TIMEOUT_MS` 覆盖，上限 2 小时），连续 10 分钟没有任何输出则判定为挂起（`idle_timeout_ms` 或 `RAB_IDLE_TIMEOUT_MS` 覆盖）。超时和取消都会终止整棵 Provider 进程树，不会留下继续运行的无头 CLI 进程；这很重要，因为 Agent 一次只执行一个任务，残留进程会和下一个任务重叠。

## 开发

```bash
pnpm install
pnpm dev
```

Windows 后台启动/关闭：

```bash
pnpm start
pnpm setup
pnpm status
pnpm run relaunch
pnpm stop
```

也可以双击根目录的 `start.cmd`、`setup.cmd`、`relaunch.cmd` 或 `stop.cmd`。这些 Windows 入口不依赖系统 PATH 中存在 `pnpm`。配置页面是 `http://127.0.0.1:8787/setup`，但它调用的 `/api/setup/*` 需要本机 setup token，所以**请用 `setup.cmd`（或 `pnpm setup`）打开**——它会自动带上 `?token=...`；直接在浏览器里手输这个网址只能看到页面框架，接口会返回 `setup_token_required`。页面里可以选择樱花内网/虚拟局域网模式、保存端口、手机访问地址、电脑名称、Provider 文件路径和重新生成配对码。后台进程状态和日志保存在 `.rab/`，停止命令只处理本项目启动并记录的 Gateway/Agent 进程。

本机页面：`http://127.0.0.1:8787/`；健康检查：`GET http://127.0.0.1:8787/health`

用 API 手动发任务（可选，日常用手机页面即可）。这个接口要求登录态，并且需要一台已配对且在线的电脑；缺前者返回 401，缺后者返回 503 `agent_offline`：

```bash
# token 来自 POST /api/auth/login 或 POST /api/auth/register 的返回
curl -X POST http://127.0.0.1:8787/api/tasks \
  -H "content-type: application/json" \
  -H "authorization: Bearer $TOKEN" \
  -d '{"task_id":"demo-1","input":"现在几点","provider_id":"local","mode":"isolated"}'
```

## 测试

关键链路有自动化回归测试：配对与设备绑定、未绑定 Agent 收不到任何数据、任务事件属主隔离、任务提交幂等、任务记录跨重启、登录与配对限流、任务闭环，以及 Agent 侧的任务超时与进程树终止（含前端内联脚本的语法校验）。共 53 个用例。

```bash
npm test
```

本机没有 pnpm 时可以直接跑：

```bash
node node_modules/typescript/bin/tsc --build --pretty false
node --test "apps/gateway/tests/*.test.mjs" "apps/web/tests/*.test.mjs" "services/agent/tests/*.test.mjs"
```

CI 配置在 `.github/workflows/ci.yml`，跑的就是上面这条 `pnpm test`，没有任何 CI 专属步骤。矩阵覆盖 ubuntu 与 windows、Node 22 与 24：Windows 走 `taskkill /T /F`，Linux 走进程组信号，两条进程终止路径只能在各自的平台上验证。

Gateway 的用例会各自启动一个真实的 Gateway 子进程：端口自动选空闲端口，数据目录指向系统临时目录（不会读写 `.rab/`，可以和安全运行中的实例共存）。Agent 侧的用例则真实启动子进程树，用来验证超时与取消是否真的把整棵树杀掉。

带真实 Agent 的端到端冒烟（配对 → Agent 自动重连认证 → 建会话 → 跑任务）：

```bash
node apps/gateway/tests/live-smoke.mjs
```

安全说明：这是自托管测试版。`/agent` WebSocket 端点强制握手，连接必须出示设备 Token，或证明自己运行在本机，否则立即断开；只有已绑定（配对成功）的设备才会收到任务和会话命令。**回环来源不等于本机**——隧道客户端都是从 `127.0.0.1` 转发进来的，所以 `/api/setup/*` 在回环之外还要求 setup token（`.rab/setup-token`，请求头 `x-rab-setup-token`），只有能读到本机数据目录的进程才拿得到；配对码也只会签发给已认证或已证明本机的连接。用户会话 Token 只保存哈希，登录接口按 IP 限流（5 次失败锁定 10 分钟），配对码 60 秒有效、一次性并受失败限流保护；任务事件只有创建者可读；浏览器 Origin 和 WebSocket Origin 也会校验，樱花模式强制使用 HTTPS 公网地址，所有响应带基础安全头（CSP/nosniff/frame-deny）。仍未实现 MFA、数据库级加密和完整生产级审计。请只在你自己控制的局域网、虚拟局域网或可信隧道中使用，不要直接把端口暴露到公网。规划与当前实现的差异对照见 `remote-agent-bridge-规划.md` 第 0 节。
