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

不同设备的 Codex 配置目录可能不同。页面「必要设置」用来分别查看和修改 Codex 配置目录、ChatGPT 应用路径。

目录优先级：**启动参数 > `CODEX_HOME` 环境变量 > 项目 JSON 配置文件 > 页面保存的目录 > 默认 `~/.codex`**。只有前两种属于外部显式指定，页面输入框锁定为只读，也**不会**读写设置文件。JSON 提供的目录可直接在页面修改，保存会写回该 JSON 文件的 `codexHome`，重启后继续生效。

- **立即生效**：保存后当前进程内的中转站列表、provider 身份、出站设置全部切到新目录，无需重启服务；已建立的 SSE/WebSocket 连接不受影响。
- **持久保存**：当前目录来自项目 JSON 时，修改写回同一文件，并保留应用路径、注释和其它字段；单反斜杠路径会保存为标准 JSON 转义。其它可编辑来源写在 `~/.config/codex-relay-ui/settings.json`（Windows 为 `%APPDATA%\codex-relay-ui\settings.json`），权限 `0600`，只存路径。刷新页面、重启服务后仍然生效，页面会标出对应保存位置。
- **设置文件不放 Codex 目录内部**：它记录的就是 Codex 目录的位置，放进去会形成循环依赖。可用 `RELAY_UI_SETTINGS` 环境变量改到别处，隔离测试时有用。
- **保存前校验**：目标必须是存在的目录，且包含 `config.toml`。校验不通过会拒绝并说明原因，**当前状态不受影响**（先构建并验证新目录确实可用，再落盘，最后才替换）。
- **默认引导与实际填写分开显示**：默认位置和输入提示使用 `~/.codex` 这类通用写法；在 JSON 或页面中填写并保存后，当前目录与输入框展示完整路径，便于核对。自动生成的设置文件位置和报错提示仍可缩写用户主目录。内部始终使用实际路径，输入框填写的 `~` 会自动展开。
- **缺失的 `key_config.json` 会自动补一个空列表**，新设备上可以直接开始使用；创建结果会在页面提示中说明。

切换目录会让本地代理改为读取新目录下选中的中转站。如果 Codex 已经接入本地代理，切换前请确认新目录里的路由符合预期。

ChatGPT 应用路径在下面的独立输入区保存：Windows 可填写 `ChatGPT.exe`、`Codex.exe` 的完整路径或所在目录，macOS 填 `.app` 目录；保存前检查路径存在且为文件或目录。WindowsApps 中的 OpenAI.Codex 旧路径如果已不存在，但能找到唯一可用的新版，也允许保存。保存写入当前工具配置的 `codexAppPath`，不会改动 `.codex` 目录或立即启动应用，下次通过启动脚本启动时生效。留空保存会恢复自动查找，优先 ChatGPT。设置了 `CODEX_APP_PATH` 环境变量时，该输入区只读并标注来源。

## 项目配置文件 codex-relay.config.json

把本工具复制到另一个项目或另一台机器时，不必再改环境变量：在**项目根目录**放一个 `codex-relay.config.json`，把 Codex 的位置写进去。管理服务和 `start-codex-local.*` 都读同一个文件。

```json
{
  "codexAppPath": "C:/Users/you/AppData/Local/Programs/Codex/Codex.exe",
  "codexHome": "C:/Users/you/.codex"
}
```

Windows 接受 `/` 作为路径分隔符，推荐上述写法，包含空格也无需额外转义。使用反斜杠时，标准 JSON 要把每个 `\` 写成 `\\`；例如 `C:\\Users\\you\\.codex`。

本工具只对顶层的两个路径字段及其下划线别名做容错，可读取常见的单反斜杠路径，包括中文目录、UNC 网络路径和末尾分隔符。`C:\temp` 中的 `\t`、`C:\new` 中的 `\n` 会保留为路径；检测到 `C:\u0061` 这类单反斜杠 Windows 前缀时，也按原路径保留。正确使用 `\\` 转义的路径继续按标准 JSON 解析。该容错不会重写磁盘文件，也不会修复 `$comment` 等其他字段；为兼容其他 JSON 工具并避免转义歧义，仍请优先使用 `/` 或标准 `\\`。

| 字段 | 含义 | 留空时 |
| --- | --- | --- |
| `codexAppPath` | Codex **桌面应用**位置：Windows 填 `ChatGPT.exe`、`Codex.exe` 的完整路径或它所在目录，macOS 填 `.app` 目录 | 按平台自动探测常见安装位置 |
| `codexHome` | Codex **配置目录**（含 `config.toml`、`key_config.json`） | 用页面保存的目录，再回退到 `~/.codex` |

- 两个字段都可以省略，文件也可以完全不存在。也支持 `codex_app_path` / `codex_home` 这种下划线写法，值里的 `~` 和 `%LOCALAPPDATA%` 会自动展开。
- Windows 填写目录时优先 `ChatGPT.exe`，找不到再使用 `Codex.exe`。自动探测时也先在所有候选目录查找 `ChatGPT.exe`，再回退 `Codex.exe`。填写完整文件路径时保留指定的文件名，包括 WindowsApps 安装目录里的 `app/ChatGPT.exe`。
- **WindowsApps 更新后自动查找**：原路径仍可用时优先使用原路径；失效后，在同一 WindowsApps 安装位置查找 `OpenAI.Codex_*` 包中的 `app` 目录，也兼容 `OpenAI.Codex\_<版本>\_x64\_\_<发布者>\app` 分层形式（保留版本之后的目录结构）。只使用包含可访问可执行文件的唯一结果；多个可用结果会列出路径并提示重新选择，未找到或无法读取安装目录时会说明原因。配置文件和 `CODEX_APP_PATH` 都支持，无需填写通配符，也不会自动改写已保存的路径。
- 查找顺序：`CODEX_TOOL_CONFIG` 指定的路径 > 项目根目录 > `~/.config/codex-relay-ui/`（Windows 为 `%APPDATA%\codex-relay-ui\`）。
- 优先级：`CODEX_APP_PATH` / `CODEX_HOME` 环境变量仍然高于配置文件，方便临时覆盖。
- `codexHome` 生效时页面展示完整目录，并提示「来自 JSON 配置文件，保存会更新该文件」；可直接在页面修改并保存。
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

## 中转可用性

页面使用左侧导航切换「中转站」「运行与连接」「必要设置」，右侧内容区独立滚动。新增中转通过右上角按钮打开弹窗；当前使用显示为紧凑摘要，点击名称可展开并定位对应配置。

列表按规范化后的完整 Base URL 归组（忽略末尾斜杠，保留不同路径），每个中转商只显示一份模型可用性。默认收起并显示排序后的第一个配置，展开后展示全部名称及独立的置顶、编辑、切换按钮；展开状态按配置目录保存在浏览器。可拖动中转商手柄调整组序，组内手柄调整配置顺序；Alt + 上下方向键同样支持排序。置顶配置优先，其所属中转商随之提前。搜索可显示匹配的收起配置。

Krill 的普通、周卡、月卡入口是特殊情况：不同域名和路径统一归入「Krill」卡片，组内按完整 Base URL 标记线路并显示地址，共享一份模型和可用性。线路各自保留账号与余额；默认不同地址即使使用相同 Key 也不会合并授权，可通过「设为同一账号」手动绑定。

每个账号的配置和操作集中展示，余额与订阅紧跟该账号下方；两者都有时左侧余额、右侧订阅，只有一项时占满整行，窄屏自动上下排列。相同账号的多个配置共用一份额度信息，跨账号拖拽会连同该账号配置一起移动，账号内也可调整配置顺序。

同一 Base URL 下，完整 API Key 相同的配置共用一次账号登录、余额和订阅，不以脱敏字符串判断；未绑定时，不同 Key 的授权、二次验证和余额缓存相互隔离。账号改名保留授权；未绑定配置修改 Key 或 Base URL 后使用对应的新账号。旧版站点级授权没有 Key 归属，保留原文件但不会自动绑定，升级后需按账号重新登录。未适配站点仍展示配置和操作，但不提供自动余额。

多账号可点击「设为同一账号」，选中同一中转商下的其他账号。不同 Key、不同 Base URL 均可绑定；已适配站点按中转商品牌识别，其他站点按同一 origin 识别。绑定跨地址时会合并为同一中转商卡片。发起账号是共享信息来源：沿用它已有的登录授权，如果尚未登录，之后登录任意成员即可让整组共用。已有绑定组可继续合并其他账号。

绑定关系作为附加字段保存在当前目录的 `relay-ui-state.json`，不修改中转的名称、Key 或 URL。共享授权单独使用绑定账号标识保存，原独立账号授权保留。通过「管理绑定」可以逐个解绑或全部解绑；解绑成员恢复原有独立授权，其他成员保留共享授权。重命名或在同一中转商内修改 Key/URL 会保留手动绑定，切换到其他中转商会解除该配置的绑定。绑定保存失败会回滚授权与关系写入；多窗口过期操作会提示刷新，过期的二次验证不能用于新的绑定关系。

Packycode 每个子项独立选择余额来源，绑定后也保留各自的单选项，不累加余额。API Key 方式沿用共享信息来源配置的 Key；登录方式共享绑定账号的登录授权。解绑后恢复各 Key 的独立账号授权。

多渠道状态（如派大星、timiCC）按每行两个号池排列，超过两个自动换行；单号池占满一行，号池区域过窄时自动改为单列。

timiCC 的号池展示按子项独立选择并显示在各子项下方：默认「全部号池」同时显示 Team/Plus 和 Pro，也可选择「跟随 API Key」。即使多个子项共用登录，跟随模式仍使用各子项自己保存的 Key 匹配分组。选择随配置保存，重命名后保留；列表可用性筛选优先使用当前启用的 timiCC 子项，没有启用项时使用排序后的第一个子项。

列表支持「全部 / 当前可用 / 当前不可用」筛选，可与名称和地址搜索叠加。以当前所选模型检测条的最后一格为准：红格属于不可用，其他颜色属于可用；没有检测记录（包括全为空格）的中转只在「全部」中出现。筛选会随 15 秒刷新和模型切换更新，不以整段可用率或站点总状态替代最后一格。

中转站列表提供全局「可用性模型」选择：默认 `gpt-6-astra`，可切换为 `gpt-5.6-sol`，浏览器会记住选择。该选择只控制站点状态展示，不修改 Codex 的请求模型。

- 首个适配站点为 `ai.input.im`，按 Base URL 的域名自动识别，同站点的不同账号共用状态数据。
- INPUT 的余额与订阅需要单独登录：点击 INPUT 下的「账号授权」，输入站点账号或邮箱、密码，工具调用 `https://ai.input.im/api/v1/auth/login`；返回的 `access_token` 即站点 Local Storage 中的 `auth_token`，后续请求使用 Bearer 授权。启用二次验证时，在同一窗口输入 6 位验证码。密码、刷新令牌和二次验证临时令牌不落盘，访问令牌单独保存到当前 Codex 目录的 `relay-ui-runtime/input-<accountId>-monitor-auth.json`（权限 `0600`），与 code for me 的授权隔离。
- INPUT 同样支持手动授权：在窗口展开「无法登录？使用 auth_token 授权」，打开 `https://ai.input.im/` 并登录 → Chrome / Edge 开发者工具（F12；Mac 可用 ⌥⌘I）→ **Application（应用）** → **Local Storage（本地存储）** → `https://ai.input.im` → 复制 `auth_token` 的完整 **Value（值）** → 粘贴回工具并验证保存。只复制值，不含键名、引号或 Bearer 前缀。操作说明会随所选站点切换。
- INPUT 的「登录账号余额」读取 dashboard 使用的 `/api/v1/auth/me`；「登录账号订阅」读取 `/api/v1/subscriptions`，展示全部套餐分组、状态、到期时间，以及日／周／月额度的已用量、限额、剩余量和重置时间，金额均为美元。不将订阅额度与余额相加，也不按当前监控模型筛掉其他订阅。重置规则跟随源页的滚动 24 小时、7 天、30 天窗口；不超过一天的套餐，日额度随套餐到期。无订阅、未登录、刷新失败分别提示。
- INPUT 余额、订阅与公开监控随列表每 15 秒刷新，按中转账号和数据种类分别缓存，重复列表项及模型切换共用请求。账号授权失效不影响公开可用性展示；余额或订阅单独失败时保留对应上次数据并标注。清除或更换授权会清空该 Key 对应的旧账号数据。令牌仅发往 INPUT 固定的用户信息与订阅接口，绝不发送到公开的 `status.input.im` 或其他中转；只返回展示所需字段，不返回邮箱、用户信息或完整账号响应。
- `blackaicoding.com` / `www.blackaicoding.com`（code for me）改用主站 `/monitor` 的 V2 监控，不再读取旧的 `status.blackaicoding.com`。固定 `range=90m`、`platform=openai`、`group_id=2`、`group_by=platform_group_model`，并校验组名为「codex混合渠道--低价」。状态条沿用 `overall` 整体健康度和源站分格（目前 18 格、每格 5 分钟）；成功率按页面的 `1 - error_rate` 计算，缺失时段留灰，另显示平均首 Token 延迟、平均延迟和缓存率。
- code for me 的 `gpt-5.6-sol` 只取独立模型分类；`gpt-6-astra` 优先匹配独立分类，源站未单列时展示同分组的 `__other__`，明确标为「OpenAI · 其他模型（参考）」。该汇总不能证明 gpt6 的独立可用性；若精确分类存在但无数据，也不会回退混用其他模型。
- code for me 的 V2 接口需要登录访问令牌。点击该中转账号下的「登录账号」或「账号授权」后，优先填写站点账号和密码，工具会调用站点登录接口并自动验证监控权限；密码只在本次请求中使用，不保存。若账号开启二次验证，会在同一窗口输入身份验证器的 6 位验证码。成功后只保存访问令牌到当前 Codex 目录的 `relay-ui-runtime/blackaicoding-<accountId>-monitor-auth.json`（文件权限 `0600`，不入库），不保存刷新令牌或二次验证临时凭据。
- 登录接口暂时不可用时，可在授权窗口展开「无法登录？使用 auth_token 授权」：打开 `https://blackaicoding.com/` 登录，按 `F12` → **Application** → **Local Storage** → `https://blackaicoding.com`，找到键名 `auth_token`，复制值并粘贴到工具中验证保存。只向固定监控和账户信息接口发送该令牌，不跟随重定向、不向其他中转发送，也不使用中转 API Key。过期或 401/403 时显示授权提示，历史数据会变淡；可在同一窗口更新或清除授权。切换 Codex 目录时使用各目录独立的监控授权。
- code for me 授权后同时显示「登录账号余额」，读取 dashboard 使用的 `/api/v1/auth/me` 中的 `balance`，按美元显示两位小数。金额属于当前监控授权账号，同一 Base URL、相同 API Key 或手动绑定为同一账号的配置共享该余额；其余 Key 需分别登录对应账号。余额随可用性每 15 秒刷新，切换模型和重复列表项不会重复请求。余额和监控分别缓存及处理故障：余额刷新失败保留上次数值并注明，授权失效提示重新登录；清除或更换授权后清空旧余额。仅返回金额、币种和刷新状态，不返回账户资料，也不落盘缓存余额。
- `aixor.org` / `aixor.cc`（含 `www`）读取模型广场 `https://aixor.cc/pricing` 使用的公开性能接口，严格匹配所选官方模型 ID 和 `Premium-gpt` 分组。显示 24 个小时格、该分组 TPS、首 Token 延迟和平均延迟；缺失小时留灰，缺少分组时显示无数据。成功率与分组行一致：各小时成功率先保留两位小数，再对有数据的小时求平均，不使用其他分组或接口的总体成功率。沿用源页颜色阈值：90% 及以上绿、70% 至 90% 黄、低于 70% 红。小时数据按小时周期判断过期，额外宽限 3 分钟；请求按模型分别缓存，同一 Base URL 下多个账号共用。
- Aixor 钱包信息复用「账号授权」入口，但采用独立的 Cookie 会话协议。工具内输入账号密码、勾选站点用户协议后，通过 `https://aixor.cc/api/user/login?turnstile=` 登录，自动接收会话 Cookie 和用户 ID；若站点要求二次验证，在同一窗口输入验证码。登录会话 Cookie 与用户 ID 保存到当前 Codex 目录的 `relay-ui-runtime/aixor-<accountId>-monitor-auth.json`（权限 `0600`），不保存密码，临时二次验证会话仅在内存保留 5 分钟。源站不返回可确认的会话到期时间时，遇到 401/403 后提示重新登录。
- Aixor 手动授权：打开 `https://aixor.cc/wallet` 登录 → 开发者工具 **Network（网络）** → 刷新页面 → 搜索 `/api/user/self` → **Headers → Request Headers** → 将完整 **Cookie** 值（不含 `Cookie:` 前缀）及 **New-Api-User** 数字值分别填入工具。用户 ID 也可从 **Application → Local Storage → https://aixor.cc → uid** 获取。Aixor 不使用 INPUT/code for me 的 `auth_token`；手动步骤随站点切换显示。
- Aixor 当前余额取 `/api/user/self` 的 `quota`，订阅取 `/api/subscription/self`，套餐名取 `/api/subscription/plans`；按 `/api/status` 公布的 `quota_per_unit` 换算美元（当前为 500000），不将原始配额整数当作美元。每 15 秒随可用性刷新，重复列表项和模型切换共享账号数据。仅展示未过期且未取消的订阅，包含到期时间、套餐已用／总额度、剩余额度及下一次重置时间；额度为 0 的套餐按源站表示不限总额度。过期项目在缓存和刷新失败时也会过滤。余额、订阅与公开性能数据独立处理故障；会话只发送到 Aixor 固定的账户接口，登录成功自动关闭弹窗并显示中央 Toast，失败保留在弹窗。
- Packycode 使用 `https://www.packyapi.com/pricing` 对应的公开性能接口，只读取 `codex` 分组，适配 `packyapi.com`、`www.packyapi.com`、`cf.api.fan` 和 `codex-api.packycode.com`。与 Aixor 共用小时数据解析及展示，但保留 Packycode 的统计口径：成功率使用该分组的总体值，小时状态条按未舍入的原始成功率着色，99% 及以上绿、90% 至 99% 黄、低于 90% 红。`codex-sale`、`azure-officially` 等其他分组不会混入。
- Packycode 每个子项提供「API Key 限额 / 登录账号余额」二选一，默认保留 API Key 方式。选择保存在当前 Codex 目录的 `relay-ui-state.json` 的 `packyBalanceSources` 中，按子项名称存储，工具内重命名会同步迁移；相同 Key 的别名或绑定账号也可以选择不同来源。切换后只查询、展示所选来源，停止不再需要的 Key 重试，旧来源的并发响应不会覆盖新展示。
- API Key 方式直接使用该列表项在服务器保存的 API Key，不需要账号登录。默认 `GET https://slb-v1.api.fan/api/usage/token/`，以 `Authorization: Bearer <API Key>` 查询 Key 的额度，余额查询不会消耗模型调用额度。也识别 `slb-v1.api.fan` 中转入口。点击「余额设置」可更改查询基础地址、单次超时和自动查询间隔；配置地址保留原域名，移除末尾 `/`、`/api/usage/token/`、`/v1` 后追加 `/api/usage/token/`，不强制改为 `www.packyapi.com`，不跟随重定向。
- 登录账号方式读取 `https://www.packyapi.com/console` 的当前余额：后端调用 `/api/user/login`（可带腾讯验证 ticket/randstr），需要时接续 `/api/user/login/2fa`，保存登录 Cookie 和用户 ID；随后以 `Cookie`、`New-Api-User` 请求 `/api/user/self`，读取 `quota`，根据公开 `/api/status` 的 `quota_per_unit` 换算美元。余额随检测每 15 秒刷新，失败保留上次数据并显示重新登录或刷新失败；API Key 的 30 分钟设置不影响登录余额。
- Packycode 当前使用腾讯人机验证。点击「登录并授权」时，工具获取站点公开验证配置及加密 app ID，在页面内的隔离弹窗加载官方腾讯验证组件；用户完成验证后继续登录，无需跳转。组件不能读取工具内的账号密码；验证票据仅发送到固定 Packycode 登录接口，不保存。取消、超时或验证失败会保留登录弹窗；成功关闭并显示居中 Toast。若站点限制本地加载或更换验证方式，仍可展开手动授权：打开 Packycode 控制台并登录 → F12 / Mac ⌥⌘I → Network → 刷新 → `/api/user/self` → Headers → Request Headers，复制完整 `Cookie` 及 `New-Api-User` 数字；用户 ID 也可从 Application → Local Storage → `https://www.packyapi.com` → `user` 的 `id` 取得。工具弹窗内已提供相同步骤。
- Packycode 余额设置保存在当前 Codex 目录的 `relay-ui-runtime/packycode-balance.json`，只保存 `api_base_url`、`request_timeout_seconds`（默认 10）和 `refresh_interval_seconds`（默认 1800）。复用已有中转列表中的 Key，无需重复填写；真实 Key 不返回浏览器、不写入前端代码或日志。按「查询接口 + Key」缓存，不同 Key 分开，同 Key 的重复中转、不同模型和多个浏览器共用查询；更换 Key 不会继承旧 Key 的余额，切换 Codex 目录或查询地址会取消旧查询。
- Packycode 余额按 **500000 quota = 1 USD** 换算。当前余额直接取 `total_available`，最大金额取 `total_granted`，百分比为前者除以后者并限制在 0～100%；最大额度为 0 时显示「—」。支持 `data` 内或根对象、下划线／驼峰字段和有限非负数字字符串。`total_used` 不作为当前余额的减数，页面不将它标成「本期已用」。无限 Key 直接显示「无限额度」；实测无限模式会返回负数占位值，因此不转换无限模式的数字字段，有限模式仍拒绝负数和无效数据。
- Packycode 余额默认每 **30 分钟**查询，支持「刷新余额」；可用性仍每 15 秒刷新。首次失败后最多重试 3 次，默认等待 1／3／5 秒；HTTP 429 有正数 `Retry-After` 时优先使用，最多 60 秒。查询与重试在后台执行，页面只读取缓存，查询中会短暂轮询进度；不阻塞其他站点和可用性展示。失败保留上次成功余额及时间并标记未更新，首次失败显示未知，不显示为零。页面隐藏后暂停轮询，服务关闭、切换目录或更改查询地址会取消请求和重试。未迁移飞书通知、阈值或通知状态逻辑。
- 每 15 秒读取公开状态接口 `https://status.input.im/api/status`，展示所选模型最近 60 个样本、可用率和采样时间。绿色表示成功，红色表示失败，悬停可查看时间、延迟及错误。状态源目前约每分钟采样一次，页面刷新不会增加样本，也不消耗中转 API Key。
- 可用性状态条来自站点监控，不代表账号额度或密钥可用性。INPUT 的公开状态无需登录；INPUT 的余额、订阅，以及 code for me 的监控、余额，使用各自的本机账号授权。
- Krill 的登录内页 `/app/status` 与公开页 `https://www.krill-code.com/status` 共用 `/api/public/channel-status?hours=24`，无需账号、Cookie、token 或 API Key。适配 `krill-code.com`、`www.krill-code.com`、`api-slb.krill-code.net` 和 `api.cdn-krill-ai.com`，普通、周卡、月卡共享站点状态。只按官方模型 ID 匹配，24 小时分为 72 个 20 分钟格，同格按故障 > 降级 > 正常聚合，无数据留灰；当前状态单独取源站 `current_status`。显示首 Token 延迟、吞吐 P50 和缓存率，不将状态格换算成请求成功率。UTC 采样时间超过 5 分钟标为过期；源站固定状态会明确标注。源页首 Token 指标的 P90 文案与接口 `ttft_p99_ms` 命名不一致，因此仅标为首 Token 延迟，保留原值。
- Krill 个人账号的余额和套餐通过「账号授权」登录：`POST https://www.krill-code.com/api/auth/login` 接收邮箱和密码，返回的 `token` 即 Local Storage 中的 `krill_jwt`。若返回 `requires_totp`，继续调用 `/api/auth/login/totp`，传入暂存于服务内存的 `pending_token` 和 6 位验证码。访问令牌独立保存在当前 Codex 目录的 `relay-ui-runtime/krill-<accountId>-monitor-auth.json`（权限 `0600`），不保存密码，不向公开监控或中转 API 域名发送令牌。
- Krill 手动授权：登录 `https://www.krill-code.com/` → Chrome / Edge 开发者工具（F12；Mac：⌥⌘I）→ **Application → Local Storage → https://www.krill-code.com** → 复制 **krill_jwt** 的完整值 → 回到工具验证保存。不复制 `krill_user`，不带键名、引号或 Bearer 前缀。登录或手动授权成功后自动关闭弹窗并弹出中央 Toast；错误保留在弹窗。
- Krill 余额读取 `/api/credits` 的 `balance_usd`，套餐状态及当前额度读取 `/api/subscription`；套餐使用情况沿用 `/app/activity` 默认的 **最近 7 天**，只读请求 `POST /api/subscription/quota-usage`，参数为 `start_time` 和 `end_time`。显示套餐名称、状态（含冻结）、到期时间、当前额度与近 7 天用量，明确区分统计区间余量和实际套餐剩余额度。按次数和积分计费的套餐保留原单位，共享次数额度标明为账号共享；缺失值显示未知。默认读取个人账号，不带企业切换请求头，也不调用购买、冻结、重置或续费接口。
- Krill 余额、套餐和公开可用性随列表每 15 秒刷新，多个 Krill 入口和模型切换合并账号请求；过期或取消的套餐不再显示。余额及套餐读取失败分别保留上次数据并标注，账号授权失效不影响公开监控，清除授权会同时清空套餐及用量缓存。
- RC / Right Code 适配 `www.rightapi.ai`、`rightapi.ai`。模型状态读取 `/models/availability?upstream_prefix=%2Fcodex&window=24h`，只展示 **Codex** 端点的 `gpt-6-astra`、`gpt-5.6-sol`；通过 `/models/public` 核对模型是否启用。24 小时为 24 个小时格，可用率取源站 `availability` 的小时均值，不混用 `user_availability` 或 `first_attempt_availability`；90% 及以上绿、60% 至 90% 黄、低于 60% 红，柱高沿用站点的对数比例。无请求时段显示灰色，均值仍沿用源站口径；全部无请求时显示未知，停用模型明确显示不可用。公开状态不携带账号令牌。
- RC 余额读取 `https://www.rightapi.ai/dashboard` 使用的 `GET /auth/me` 中的 `balance`，直接按美元显示两位小数，不按 quota 换算。工具内通过 `POST /auth/login` 提交 `username`、`password`，保存返回的 `user_token` / `userToken`；RC 的授权是普通字符串，不强制按 JWT 解析或虚构到期时间。若返回 `otp_required`，在同一弹窗输入 6 位验证码，再向同一登录接口提交 `otp_code`；为满足该协议，账号密码仅在内存暂存至二次验证成功、取消、超时或服务关闭，最长 5 分钟，不写入磁盘。
- RC 手动授权：登录 `https://www.rightapi.ai/dashboard` → F12（Mac：⌥⌘I）→ **Application → Local Storage → https://www.rightapi.ai** → 复制 **userToken** 完整值 → 在工具内验证保存，不使用 API Key。账号授权按子项及既有绑定关系独立保存到 `relay-ui-runtime/rightcode-<accountId>-monitor-auth.json`（权限 `0600`），令牌只发送到固定的 `/auth/me`。余额与模型状态每 15 秒刷新；失败保留最后成功数据，授权失效可重新登录，成功后自动关闭弹窗并显示居中 Toast。网络不可达时明确提示使用 VPN 或可用代理。
- timiCC 适配 `timicc.com`、`www.timicc.com`。公开状态读取 `https://status.timicc.com/api/group/CodeX%20%E9%80%9A%E9%81%93?trendPeriod=7d`，只展示 **Codex Team/Plus号池** 和 **Codex Pro号池**。两个全局模型选项共用号池状态，页面明确标注站点当前使用的探测模型；各池独立显示最近 60 次检测、源站 7 天可用率、对话延迟及端点 PING，不将池状态当作逐模型实测结果。站点约 5 分钟检测，工具每 15 秒刷新；超过 15 分钟无新样本标为过期。维护状态单独显示，不读取官方上游健康状态替代该池检测。
- timiCC「跟随 API Key」通过登录授权分页读取固定 `/api/v1/keys?page=N&page_size=100`，在后端使用完整 Key 精确匹配，缓存只保留 Key 的哈希与分组名。`CodeX team/plus号池` 与 `Codex Pro号池` 分别对应两个公开号池；仅规范大小写、空格和全角字符，不猜测未知分组。分组查询随检测每 15 秒刷新，同一登录合并请求；授权过期、Key 不属于当前登录账号、未知分组或查询失败均明确提示，并停止显示无法确认的号池，可随时切回「全部号池」。全展示模式无需登录或查询 Key 列表。选择保存于 `relay-ui-state.json` 的 `timiccStatusModes`，独立于余额和账号绑定。
- timiCC 余额读取 `https://timicc.com/usage` 使用的 `GET /api/v1/auth/me` 中的 `balance`，直接显示美元，每 15 秒随检测刷新。工具内登录调用 `/api/v1/auth/login`，提交邮箱和密码，登录前需勾选站点条款；若要求二次验证，继续调用 `/api/v1/auth/login/2fa`，临时令牌只在内存保留。保存 `access_token`，不保存密码，授权按账号保存在 `relay-ui-runtime/timicc-<accountId>-monitor-auth.json`（权限 `0600`）。令牌仅发送到固定的余额和 Key 列表接口，公开监控不携带令牌。
- timiCC 手动授权：登录 `https://timicc.com/usage` → F12（Mac：⌥⌘I）→ **Application → Local Storage → https://timicc.com** → 复制 **auth_token** 完整值 → 回到工具验证保存，不复制 API Key，不带引号或 Bearer 前缀。登录成功关闭弹窗并显示居中 Toast，失败保留在弹窗；授权失效后重新登录即可。余额请求失败保留上次成功余额与时间并标记未更新，不显示为零。
- 派大星适配 `api.aigo0.com`，登录监控入口为 `https://api.aigo0.com/monitor`。余额读取登录后的 `/api/v1/auth/me`，状态读取同一监控页使用的 `/api/v1/channel-monitors`，两个全局模型选项共用六个指定号池状态：**CX009-PLUS、CX008、CX00035、CX012、CX009-BUG、CX015**。源站当前将 `CX00035` 显示为 `CX0035` 时也按同一号池识别。号池按名称前缀精确归类，显示最近检测、7 天可用率、对话延迟和端点 PING，工具每 15 秒刷新；状态失败或过期保留历史并明确标记。
- 派大星每个子项提供「全部号池 / 跟随 API Key」二选一，默认全部号池。全部号池默认收起显示 2 个，点击「展开全部号池」显示六个，再次点击收起；登录授权可识别当前 Key 所属号池，匹配项始终置顶。跟随模式只显示匹配的一个号池；Key 未找到、所属分组不在六个监测范围或授权失效时不猜测号池，并提示切换回全部号池。选择独立保存在 `relay-ui-state.json` 的 `aigoStatusModes`，同一登录下不同子项仍按各自 API Key 匹配。
- 派大星默认点击「在此页面登录」，弹窗内显示官网实时登录画面，可直接确认条款、输入账号密码、粘贴及完成人机验证。点击条款文档后在画面内阅读，使用「返回登录页」回到条款确认；支持滚轮、触屏滑动和辅助按键。验证实际运行在独立临时 Chrome 的派大星官网域名下，保留源站的条款与验证流程，不将受域名限制的 Cloudflare 组件搬到本地域名。成功读取 `auth_token` 并验证余额接口后，自动保存授权、关闭弹窗并显示中央 Toast。
- 页面内登录需要本机已安装 Google Chrome，使用后台浏览器与进程私有调试管道，不开放调试端口。画面仅在内存传输，不写截图文件；键盘输入仅转发到当前官网登录会话，不记录密码或验证码。临时画面接口只允许截图、有限的点击/滚动/键盘操作及返回登录页，不接受任意 URL、脚本或调试命令。取消、5 分钟超时、成功或服务退出后清理临时浏览器和配置目录；登录期间账号或 Key 变化时拒绝保存过时授权。若站点拒绝后台浏览器验证，可关闭弹窗后选择「改用独立 Chrome 窗口登录」，保留自动取得授权的流程。
- 派大星授权保存在 `relay-ui-runtime/aigo-<accountId>-monitor-auth.json`（权限 `0600`），状态、余额与 Key 列表缓存均按授权账号隔离，同账号别名共享请求。手动授权作为备选：登录派大星监控页 → F12（Mac：⌥⌘I）→ **Application → Local Storage → https://api.aigo0.com** → 复制 **auth_token** 完整值 → 回到工具验证保存，不带引号或 Bearer 前缀。成功关闭弹窗并显示居中 Toast，失败保留错误信息；授权失效后可重新打开浏览器登录，余额查询失败保留上次成功值。
- 未适配站点、缺少模型样本、状态源无法连接会分别标明。刷新失败会保留历史并标记过期；除上述按站点定义的采样周期外，最新样本超过 3 分钟也标记过期。
- 页面隐藏时暂停请求，返回时立即刷新；后端按中转商合并状态请求、按 Key 账号合并余额请求，并缓存 15 秒，遵循已有的上游网络设置。
- 新增站点时在 `managed-relay-runtime/availability.js` 的适配器表中登记精确域名、固定公开接口和解析函数，输出按官方模型 ID 归一化的样本；前端和刷新逻辑可复用。

升级代码后需重启管理服务以加载新增的状态接口，已有进程中的转发请求应在完成后再重启。
