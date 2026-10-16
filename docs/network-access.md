# 通过虚拟网络或樱花内网访问

项目采用“手机访问 Gateway，Gateway 再连接本机 Agent”的方式。项目不提供云端中继，手机和电脑之间的网络连通性由部署者自行解决。不要把 Agent 的 `/agent` WebSocket 端口直接暴露给手机或公网，只访问 Gateway 的 HTTP 页面。

## 方案 A：樱花隧道

推荐让樱花内网穿透只转发电脑上的 Gateway HTTP 端口：

```text
手机浏览器
  ↓ HTTPS/WSS（樱花公网地址）
樱花隧道
  ↓ 127.0.0.1:8787
电脑 Gateway
  ↓ ws://127.0.0.1:8787/agent
电脑 Agent
```

配置原则：

1. 本项目保持 `GATEWAY_HOST=127.0.0.1`，Gateway 只接受本机隧道转发。
2. 樱花客户端把 HTTP/HTTPS 隧道目标设置为 `127.0.0.1:8787`。
3. 手机上打开樱花分配的 HTTPS 地址，不要打开 `127.0.0.1:8787`。
4. 隧道必须支持 WebSocket Upgrade；如果 HTTP 隧道不支持，使用支持 WebSocket 的 HTTPS/HTTP 隧道类型。
5. **樱花模式强制 HTTPS**：在 `/setup` 页面保存樱花模式的“手机访问地址”时，Gateway 会拒绝 `http://` 开头的地址（错误码 `sakura_public_url_must_use_https`）。已保存的非 HTTPS 地址也会被忽略，`/setup` 页面会显示警告。原因：隧道流量走公网，明文 HTTP 会暴露登录 Token、密码和所有聊天内容。

启动电脑服务：

```powershell
pnpm start
```

然后启动樱花客户端，访问：

```text
https://你的樱花地址/
```

Gateway 现在会直接提供手机 Web 页面，页面 API 自动使用当前访问地址，不再写死 `127.0.0.1`。

## 方案 B：Tailscale / ZeroTier / 樱花虚拟局域网

如果手机和电脑加入同一个虚拟局域网，在配置页选择“虚拟局域网”，或者设置：

```powershell
$env:GATEWAY_HOST='0.0.0.0'
pnpm start
```

然后使用电脑的虚拟网卡 IP：

```text
http://100.x.x.x:8787/
```

更安全的做法是把 `GATEWAY_HOST` 设置为电脑的虚拟网卡 IP，而不是 `0.0.0.0`。Windows 防火墙只放行虚拟网卡对应的专用网络范围。

配置页会列出当前电脑发现的 IPv4 地址。手机访问虚拟网卡地址，例如：

```text
http://100.x.x.x:8787/
```

这里的 `100.x.x.x` 只是示例，实际地址以你的虚拟网卡显示为准。

## 当前限制

- 当前使用 `.rab/state.json` 做本地 JSON 持久化，适合单机 MVP；多人或高并发部署应迁移 PostgreSQL。
- Local Provider 已支持时间、系统信息、进程列表、工作目录文件列表和安全文件读取；浏览器、GUI、Shell 等能力仍需要对应 Adapter。
- 配对码只在电脑本机的 `/setup` 页面显示和重新生成，且只会签发给已认证或已证明运行在本机的 Agent 连接；Agent WebSocket 连接不会收到配对码，未通过握手的连接也不会收到任何消息。
- 回环来源不等于本机：隧道客户端是从 `127.0.0.1` 转发进来的，所以 `/api/setup/*` 在回环之外还要求 setup token（`.rab/setup-token`，请求头 `x-rab-setup-token`）。详见 `docs/persistence-and-binding.md`。
- 公开网络使用前仍需要补上更严格的生产级 Token 轮换、限流、MFA、审计和 Origin 策略。

## Provider 文件路径

Provider 配置默认是项目目录下的 `.rab/providers.json`。可以在本机 `/setup` 页面直接修改路径，也可以通过环境变量覆盖：

```powershell
$env:RAB_PROVIDERS_FILE='C:\Users\you\remote-agent-providers.json'
pnpm start
```

环境变量优先级高于配置页面，适合脚本、便携目录和多套 Provider 配置。文件只在电脑本地读取，不会由手机端 API 修改路径。
