# Remote Agent Bridge

在手机上给自己的电脑提交任务、查看状态和结果。Gateway 和 Agent 都跑在同一台电脑；项目不提供云端账号、云端 Gateway 或公网中继。内置 Local 可以离线工作，第三方执行器是否联网取决于它自己的配置。

## 当前状态

这是 **v0.1 私网试用版**，定位为单操作者、单电脑、单实例。已实现账号登录、设备配对、会话历史、手机工作台和可恢复的任务记录。适合先用内置只读执行器验证流程；不是公开网络部署版，也未完成真机兼容与发布验收。开发顺序见 [实施路线图](docs/roadmap.md)，升级、恢复和试用步骤见 [运维与验收手册](docs/operations.md)。

Agent 默认在后台队列工作，不接管鼠标、键盘或前台窗口。**后台执行不是安全沙箱，任务确认也不是权限提升或权限检查。** 第三方执行器仍受其自身实际权限约束。设计细节见 [非干扰执行](docs/non-interference.md)。

项目采用通用 Provider Adapter 和 Session 模型。当前实际实现的适配器只有四个：内置的 `local`（只读系统查询）、`http`、WorkBuddy 无头 CLI（Windows 上可在配置页自动发现 WorkBuddy，用其自带的 CodeBuddy CLI 执行）和 Codex CLI。协议里为 `websocket`、`mcp`、`gui` 预留了传输类型，但**这三种适配器尚未实现**，配置页也接不进它们。适配器规范见 `docs/agent-adapters.md`。

推荐先在本机验证，再配置 [可信私网访问](docs/network-access.md)。Gateway 直接提供工作台，页面使用相同来源的 API。会话、消息和任务记录保存在 `.rab/state.json`，设备身份和 Agent 回执分别在 `.rab/agent-identity.json`、`.rab/agent-task-receipts.json`。两端默认共用工作区根目录下的 `.rab/`，可以用 `RAB_DATA_DIR` 覆盖；备份应同时保留两端状态。

Provider 定义默认保存在 `.rab/providers.json`，也可以在本机配置页中修改文件路径，或设置 `RAB_PROVIDERS_FILE` 环境变量覆盖。仓库提供了不含个人路径和 Token 的 `providers.example.json`。

Codex 使用已安装的 `codex exec --json`，后续消息通过 `codex exec resume` 恢复上下文，默认请求 `read-only` 沙箱。配置页支持自动发现；启用前需在本机完成登录并验证版本兼容性。Codex 与 WorkBuddy 都不再接受 `.cmd` / `.bat` 转发器，改选直接可执行文件或实际 Node 入口。

## 任务状态与恢复

- Gateway 先保存任务，再派发。保留窗口内，同账号以相同 `task_id` 和相同内容重试只会查询原任务；新格式中同编号不同内容会返回冲突。任务留存约 24 小时、最多接收 200 条未清理记录；达到上限时拒绝新任务，不提前挤掉旧记录。
- 手机刷新后从服务端恢复消息、待确认、排队、执行和终态。提交回执丢失时，可以先查记录，或在同一标签页显式使用原编号重试；页面不自动重发。
- 两端升级后，排队任务可取消，执行中的任务先显示「等待确认」。停止不可证实时显示「结果未知」并暂停队列；取消不回滚已发生的操作。断线对账只回放回执，不自动重发执行指令。
- 从会话准备开始计算总时长（默认 15 分钟，上限 2 小时）与静默预算（默认 10 分钟），分别支持 `timeout_ms` / `RAB_TASK_TIMEOUT_MS` 和 `idle_timeout_ms` / `RAB_IDLE_TIMEOUT_MS`。Codex 等能提供动作记录的执行器会显示「执行记录」；没有轨迹并不等于什么都没做。

## 本机上手

使用 Node.js 22 或 24 和 pnpm。在项目根目录安装依赖后，Windows 上运行 `pnpm setup`，启动后台进程并打开配置页。生成配对码，打开本机工作台，注册或登录、输入配对码；看到「电脑在线」后新建 Local 会话并发送「现在几点」。已有安装请先阅读 [升级步骤](docs/operations.md#升级与回退)，不要在任务执行中重启。

```bash
pnpm install
pnpm setup
```

Windows 后台启动/关闭：

```bash
pnpm start     # 编译并启动
pnpm status    # 看 Gateway / Agent 是否在线
pnpm restart
pnpm stop
pnpm setup     # 启动服务并打开配置页（自动带 setup token）
```

没有托盘图标或默认开机自启。正在开发时可用 `pnpm dev` 前台启动，不要与后台实例共用数据目录。配置页面调用的 `/api/setup/*` 要求本机 setup token，优先用 `pnpm setup` 打开，不转发含 token 的地址。当前 Windows 启动器以默认端口和数据目录为基线；非默认部署的注意事项见运维手册。

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

自动化覆盖配对与设备归属、旧凭据迁移、任务确认、同编号提交、写入故障、取消、断线对账、只读工作区和受管进程树清理。

```bash
npm test
```

本机没有 pnpm 时可以直接跑：

```bash
node node_modules/typescript/bin/tsc --build --pretty false
node --test "apps/gateway/tests/*.test.mjs" "apps/web/tests/*.test.mjs" "services/agent/tests/*.test.mjs"
```

CI 配置为 Windows / Ubuntu 与 Node 22 / 24 矩阵。Windows 走 `taskkill /T /F`，Linux 走进程组信号，两种进程清理需要分别验收。

Gateway 的用例会各自启动一个真实的 Gateway 子进程：端口自动选空闲端口，数据目录指向系统临时目录（不会读写 `.rab/`，可以和安全运行中的实例共存）。Agent 侧的用例则真实启动子进程树，用来验证超时与取消是否真的把整棵树杀掉。

带真实 Agent 的端到端冒烟（配对 → Agent 自动重连认证 → 建会话 → 跑任务）：

```bash
node apps/gateway/tests/live-smoke.mjs
```

另有独立的 Chromium 手机尺寸回归 `node apps/web/tests/browser-smoke.mjs`，需要 Playwright 和 Chromium，配置见运维手册。模拟视口不代替真实 iOS / Android 验收。

**安全边界：** 仅绑定且认证的设备能接任务，聊天与任务按账号隔离。管理接口同时要求回环来源及 setup token；设备通过 Ed25519 一次性挑战认证。配对码 60 秒有效，命中风险规则的任务需要另行确认，关键词规则不是安全边界。当前没有服务端注销、MFA、完整审计或公网发布验收，不要把 Gateway 直接暴露到公网。
