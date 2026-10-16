# 会话记忆与设备身份绑定

## 会话历史

Gateway 将用户、设备、会话和最近消息保存到项目目录的 `.rab/state.json`。Gateway 重启后会重新加载这些数据，手机打开某个会话时通过 `GET /api/sessions/:id/messages` 读取历史。

用户密码和登录会话 Token 只以带随机盐的 scrypt 哈希保存。旧版本中曾保存的明文会话 Token 会在 Gateway 首次启动时自动迁移为 `token_hash`；现有浏览器 Token 仍然有效，重新登录后会生成新的随机 Token。

发送新消息时，Gateway 会把该会话最近 20 条消息放进任务的 `history` 字段；Agent Provider 可以用这些上下文继续工作。当前 Local Provider 会报告读取了多少条上下文，后续 CLI/HTTP/MCP/GUI Provider 由各自适配器决定如何映射。

当前消息保留上限是每个会话 100 条，后续可以改为数据库分页和可配置保留期。不要把 `.rab/state.json` 提交到 Git，它已经被 `.gitignore` 忽略。

## 一次配对，长期绑定

1. Agent 使用稳定 `DEVICE_ID` 连接 Gateway，并在 `agent.hello` 中带上本地保存的设备 Token 和本机证明（`local_proof`，即 setup token，见下文）。
2. Gateway 先完成握手：连接必须**要么**出示匹配的设备 Token，**要么**证明自己运行在本机，否则连接被拒绝（`local_proof_required`）。未绑定但通过本机证明的连接可以留在槽位上，但在绑定完成前不会收到任何消息（包括配对码）。
3. 配对码只显示在电脑本机的 `/setup` 页面（`GET /api/setup/status`），60 秒有效、一次性；手机登录后提交配对码完成授权。
4. Gateway 生成长期随机设备 Token，只保存它的哈希，并在授权成功的那一刻通过当前连接发给 Agent。
5. Agent 保存 Token 到 `.rab/agent-identity.json`。
6. 以后 Agent 重启时在 `agent.hello` 中带上 Token，Gateway 校验通过后自动恢复绑定，不再要求配对码。

### 为什么需要本机证明（setup token）

回环地址**不是**本机证明。本项目支持的隧道客户端（樱花 / frp 一类的转发，以及多数反向代理）都是先从 `127.0.0.1` 连到 Gateway 再转发流量，所以**每一个穿过隧道的请求在 Gateway 眼里都来自本机**。如果只按来源 IP 判断，攻击者只要够到隧道地址就能：

- 自己签发配对码，把用户电脑绑定到攻击者账号；
- 抢先占住唯一的 Agent 槽位，让操作者随后在配置页签发的配对码发给**攻击者的连接**，从而拿到设备 Token。

因此所有特权操作（`/api/setup/*`）除了要求回环来源，还必须带上存在 `.rab/setup-token` 的本机密钥（请求头 `x-rab-setup-token`）；只有能读到本机数据目录的进程才拿得到它。Agent 走同一条路径：它跑在本机，能读到该文件，因此在 `agent.hello` 里用 `local_proof` 证明；穿隧道过来的对端读不到，无法冒充。

配置页通过 `scripts/rab.ps1 open` 启动时会把 `?token=…` 带进 URL，页面取出后存入 `sessionStorage` 并立即从地址栏清除。

安全属性：

- 握手未通过（既无设备 Token、也无本机证明）的 Agent 连接会被立刻关闭，收不到任何数据，也不能发送除 `agent.hello` 以外的消息。
- 槽位仲裁：已认证设备始终优先；本机 Agent 可以顶掉**未认证**的占用者（这样重启后的本地 Agent 不会被残留连接挡住）；已认证的占用者不会被其他设备 id 顶掉，防止连接抢占。
- 只有已认证、或已证明本机的连接才会被签发配对码（否则返回 `agent_not_trusted`）。
- 撤销设备会清除服务端设备 Token 哈希并立即断开该设备的连接，需要重新清理本地身份并重新配对。
- 配对码只用于第一次绑定或用户主动重新绑定，不是日常登录凭证。
- 配对授权接口要求 6 位数字验证码，并按来源 IP 限制失败次数；连续失败后需要等待窗口结束。
- HTTP API 只接受当前 Gateway 地址、配置的 HTTPS 地址或本机地址作为浏览器 Origin；Agent WebSocket 也执行同样的来源检查。
- `state.json`、Provider 配置、Agent 身份文件和 setup token 尝试使用仅所有者可读写的文件权限；Windows 上仍应依靠用户账户 ACL 保护 `.rab` 目录。

### 数据目录

`.rab/` 统一锚定在**工作区根目录**（包含 `pnpm-workspace.yaml` 的那一层），不再按 `process.cwd()` 解析。否则 `pnpm dev` 会让 Gateway 和 Agent 各自在包目录下解析出不同的数据目录，从而拿到不同的 setup token、读写不同的身份文件。可以用 `RAB_DATA_DIR` 覆盖。

## 第三方 Agent

配置页支持添加 HTTP Provider，保存到 `.rab/providers.json`，重启后 Agent 会加载。CLI、MCP、WebSocket 和 GUI Agent 继续按照 `@rab/adapter-sdk` 实现对应 Adapter，不需要修改手机端协议。
