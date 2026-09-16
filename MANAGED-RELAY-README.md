# Managed Relay UI

独立于原有页面的管理入口，同时运行页面与本地代理。需要 Node.js 22.13+ 和 npm。

## 启动

```bash
sh start-managed-relay.sh
```

首次启动脚本会安装独立运行目录中的 TOML 解析依赖。原有 package.json、server.js 和 public 目录保持不变。

- 页面：http://127.0.0.1:3790
- 代理：http://127.0.0.1:3211/v1
- 环境变量：RELAY_UI_PORT、RELAY_PROXY_PORT；CODEX_HOME 可指定隔离配置目录。
- 服务只绑定 127.0.0.1。保持启动终端运行；关闭浏览器不会停止服务。
- 启动不修改 Codex 配置。端口被占用时退出，不残留只启动一半的服务。

## Codex 目录

不同设备的 Codex 配置目录可能不同。页面「CODEX 目录」用来指定和查看当前使用的目录。

目录优先级：**启动参数 > `CODEX_HOME` 环境变量 > 项目 JSON 配置文件 > 页面保存的目录 > 默认 `~/.codex`**。前三种属于外部显式指定，此时页面输入框锁定为只读，也**不会**读写设置文件。同理，只用 `options.home` 或 `CODEX_HOME` 时不影响页面上保存过的设置。

- **立即生效**：保存后当前进程内的中转站列表、provider 身份、出站设置全部切到新目录，无需重启服务；已建立的 SSE/WebSocket 连接不受影响。
- **持久保存**：设置写在 `~/.config/codex-relay-ui/settings.json`（Windows 为 `%APPDATA%\codex-relay-ui\settings.json`），权限 `0600`，只存路径。刷新页面、重启服务后仍然生效。
- **设置文件不放 Codex 目录内部**：它记录的就是 Codex 目录的位置，放进去会形成循环依赖。可用 `RELAY_UI_SETTINGS` 环境变量改到别处，隔离测试时有用。
- **保存前校验**：目标必须是存在的目录，且包含 `config.toml`。校验不通过会拒绝并说明原因，**当前状态不受影响**（先构建并验证新目录确实可用，再落盘，最后才替换）。
- **页面只显示 `~`**：当前目录、设置文件位置和各类报错都会把当前用户的主目录折叠成 `~`（例如 `~/.codex`），响应体里不出现真实用户名，便于截图和排障分享。主目录之外的路径（如外置盘）保持原样。内部逻辑仍使用绝对路径，输入框里写 `~` 也会被正确展开。
- **缺失的 `key_config.json` 会自动补一个空列表**，新设备上可以直接开始使用；创建结果会在页面提示中说明。

切换目录会让本地代理改为读取新目录下选中的中转站。如果 Codex 已经接入本地代理，切换前请确认新目录里的路由符合预期。

## 项目配置文件 codex-relay.config.json

把本工具复制到另一个项目或另一台机器时，不必再改环境变量：在**项目根目录**放一个 `codex-relay.config.json`，把 Codex 的位置写进去。管理服务和 `start-codex-local.*` 都读同一个文件。

```json
{
  "codexAppPath": "C:\\Users\\you\\AppData\\Local\\Programs\\Codex\\Codex.exe",
  "codexHome": "C:\\Users\\you\\.codex"
}
```

| 字段 | 含义 | 留空时 |
| --- | --- | --- |
| `codexAppPath` | Codex **桌面应用**位置：Windows 填 `Codex.exe` 或它所在目录，macOS 填 `.app` 目录 | 按平台自动探测常见安装位置 |
| `codexHome` | Codex **配置目录**（含 `config.toml`、`key_config.json`） | 用页面保存的目录，再回退到 `~/.codex` |

- 两个字段都可以省略，文件也可以完全不存在。也支持 `codex_app_path` / `codex_home` 这种下划线写法，值里的 `~` 和 `%LOCALAPPDATA%` 会自动展开。
- 查找顺序：`CODEX_TOOL_CONFIG` 指定的路径 > 项目根目录 > `~/.config/codex-relay-ui/`（Windows 为 `%APPDATA%\codex-relay-ui\`）。
- 优先级：`CODEX_APP_PATH` / `CODEX_HOME` 环境变量仍然高于配置文件，方便临时覆盖。
- `codexHome` 生效时页面输入框锁定，并提示「由 JSON 配置文件指定」；要改目录请编辑这个文件。
- 文件损坏或字段类型不对时会静默回退到自动探测，不会让服务起不来。
- **仓库里只提交 `codex-relay.config.example.json`**，本机的 `codex-relay.config.json` 已在 `.gitignore` 中忽略，避免把本机用户名和路径带进版本库。

## 接入和恢复

1. 页面选择“本地代理”，再选择中转站。这一步只准备路由，不修改 Codex 的地址。
2. 点击“接入本地代理”。接入成功后完整重启一次 Codex。
3. 接下来在页面换站，后续代理请求读取新的中转 URL 和 API Key，无需重启 Codex。
4. 点击“恢复接入前的直连配置”或“直接配置”，恢复本次接入前的地址，然后完整重启 Codex。
5. 在直连模式选择不同中转，会修改当前 provider 的地址和 API Key，仍需重启 Codex。

只编辑当前生效 provider 的 base_url，保留其标识、name、模型、功能设置、注释和其他配置。代理接入不修改 auth.json。切回直连恢复本次接入前的配置；如果期间修改了其他设置，只恢复代理地址，保留其他修改和认证。

当前需已有显式 base_url 的 provider。直连换站仅支持 auth.json API Key 认证；环境变量、固定认证头、ChatGPT 登录不会被静默替换。

## 状态和故障

### VPN 和出站网络

页面“上游网络”控制的是本地转发服务访问中转站的方式，与“Codex 直连/接入本地代理”是两个独立设置。

- 默认“自动跟随系统代理”：macOS 使用 SystemConfiguration 的只读接口读取当前 HTTP、HTTPS、SOCKS 或 PAC 设置，缓存最多 2 秒；没有启用系统代理时，读取 HTTP_PROXY/HTTPS_PROXY/ALL_PROXY 与 NO_PROXY 环境变量。macOS 系统代理启用时，其设置及绕过规则优先。
- FlyingBird-Lite 若在智能连接时公布系统代理或 PAC，工具通过这个入口转发；如果系统代理状态没有公布，工具会只读确认 FlyingBirdCore 正在运行且由它监听 `127.0.0.1:7892`，再自动使用该 mixed-port，由 FlyingBird 决定域名分流，不需要逐个中转标记。
- “指定代理”：填写 VPN 客户端实际提供的 HTTP(S) 或 SOCKS 地址和端口。不要把本工具的 3211 或 3790 端口填作出站代理。界面不支持带账号密码的代理 URL。
- “直连”：不显式使用 HTTP/SOCKS 代理；如果系统启用 TUN，流量仍受系统网络路由控制。
- 127.0.0.1、localhost 和 ::1 等回环目标始终直连，避免本工具自己循环代理。
- “检查所选中转连接”只执行 GET /models，报告网络路径和 HTTP 状态，不发送模型生成请求。HTTP 200 表示收到成功响应，不代表模型推理必然成功。
- 设置保存在 CODEX_HOME/relay-ui-runtime/network.json，不修改 FlyingBird 的配置、节点、开关、规则或 Codex 认证；FlyingBird 探测只执行 `pgrep`/`lsof` 只读检查。
- 更改出站设置对新请求生效；已有 SSE/WebSocket 连接保持原路径。代理失败不会自动将模型请求切到直连重发。
- 若仅启用 WPAD 自动发现且没有可用代理地址，显示明确错误，请手动指定 VPN 的代理入口。

升级到带网络功能的版本需要重启本工具一次，以加载新增依赖和后端；之后保存出站设置或系统代理切换不需要重启 Codex。正在用本工具进行 Codex 对话时，请在当前回复结束后再停止/启动服务。

日志中的 outbound/outboundSource 表示出站路径，phase 表示连接阶段，errorCode/causeCodes 记录脱敏错误码。CONNECT_TIMEOUT 表示代理/TCP/TLS 建连超时；HEADERS_TIMEOUT 表示等待响应头超时；PROXY_CONNECT_REJECTED 及 proxyConnectStatus 表示代理拒绝 CONNECT；499 + CLIENT_DISCONNECTED 表示客户端断开，不是上游返回 499。

收到请求立即记录 `relay_request_started`，结束时记录同一 `requestId` 的 `relay_request`。`upstreamStatus` 是上游实际 HTTP 状态，`responseBytes` 是已收到的响应字节数，`responseComplete` 只表示 HTTP 响应体是否完整结束。流式客户端可能在收到结束事件后主动断开，所以 499 本身不能判断模型调用失败，字节数也不证明模型成功。

页面连接检查单独记录为 `relay_diagnostic`，包含检查时间、出口和结果，本次服务运行期间刷新页面后仍可查看。请求与诊断元数据自动保存到 `CODEX_HOME/relay-ui-runtime/requests.jsonl`，权限为 0600；文件达到 1 MiB 时轮转，保留当前文件和上一份 `.1`。不保存密钥、对话正文、完整请求 URL 或请求头。`GET /api/diagnostics` 返回本次进程最近 100 条元数据和日志写入错误状态。

排查 VPN 时先在本轮 Codex 对话结束后重启中转服务加载更新，再手动开启 VPN 并执行页面连接检查。如果页面上游检查成功，但 Codex 发起请求时没有 `relay_request_started`，应排查 Codex 到本地代理这一段；如果有到达记录，则根据后续出口、状态和字节数继续排查。工具不会自行启停 FlyingBird，也不会通过重启服务打断正在进行的 Codex 对话。

自动代理已在模拟系统代理开关、HTTP、TLS CONNECT、SOCKS5h、PAC 和 WebSocket 环境测试。FlyingBird 智能连接开启时的现场网络仍需用户自行验证，工具不会自行切换 VPN 来测试，也不会在调试期间启停 FlyingBird。

- 模式根据 Codex 当前选中的 provider 地址判断，持久化的旧 mode 字段不作为依据。
- “配置选中”不等于运行中的 Codex 已加载配置；首次接入、恢复直连需要重启 Codex。
- 页面显示最近实际经过代理的中转、HTTP 状态和时间，终端输出相同的请求元数据，不记录密钥或对话正文。
- 已发出的 SSE 请求和已有 WebSocket 连接保持原上游；换站对后续请求/新连接生效。
- 中文名称在 x-relay-ui-provider 响应头中使用 UTF-8 百分号编码；上游异常不会因该名称导致 Node 进程退出。
- 本工具是透明转发代理，不包含 codex-helper 的全部模型能力、账号状态和压缩兼容处理。不同上游账号的有状态响应/压缩数据是否兼容取决于上游。

每次配置修改保留独立的 0600 备份，位于 CODEX_HOME/relay-ui-runtime。写入失败会回滚已完成的本次修改。进程异常终止留下 pending-write.json 时，暂停进一步写入，避免覆盖用户后续恢复的配置。

旧版 relay_ui_proxy 没有可信的本次接入记录时，不猜测恢复历史备份；请先手动恢复原配置后再接入新版。修改配置不会更改 Codex 应用图标文件，provider 身份与界面外观的关系未作真实客户端验证。

## 验证

```bash
npm test --prefix managed-relay-runtime
```

回归覆盖中文/特殊符号响应头、SSE 换站、WebSocket 转发、gzip 字节保留、上游中断与超时、配置身份保留、逐字恢复、手动修改保留、失败回滚、并发新增和端口占用清理。全部使用隔离目录与本地模拟上游。
