# Codex 中转工具启动与使用

项目里有两个脚本，职责不同：

| 脚本 | 作用 | 什么时候运行 |
| --- | --- | --- |
| `start-managed-relay.sh`（macOS）<br>`start-managed-relay.cmd`（Windows） | 启动管理页面和本地转发服务 | 每次使用中转工具前先运行，终端保持打开 |
| `start-codex-local.sh`（macOS）<br>`start-codex-local.cmd`（Windows） | 启动带本机代理绕过规则的 Codex | Codex 已接入本地代理后，首次接入或重新启动 Codex 时运行 |

两者依赖不同：管理服务首次运行会自动安装 npm 依赖；Codex 启动入口只用 Node 内置模块，不需要任何 npm 包。都要求 Node.js 22.13 或更高版本。详见 [CODEX-LOCAL-NETWORK.md](CODEX-LOCAL-NETWORK.md)。下文示例命令若写作 `.sh`，Windows 上请换用同名 `.cmd`。

管理页面地址：<http://127.0.0.1:3790>

本地代理地址：<http://127.0.0.1:3211/v1>

## 页面操作顺序

页面顶部按操作顺序排列：

1. 点击“直接配置”或“本地代理”。
2. 使用“本地代理”时，点击紧邻的“接入本地代理”；使用“直接配置”时，点击“恢复接入前的直连配置”。
3. 在“上游网络”选择“自动跟随系统代理”“直连”或“指定代理”，点击“保存网络设置”。需要确认中转可达时，再点击“检查所选中转连接”。
4. 在“中转站列表”中点击对应中转的“切换”。需要调整显示顺序时，拖动每行左侧的手柄；排序会自动保存。

列表每行右侧的图钉按钮用于“置顶”，再次点击可“取消置顶”。置顶项集中显示在顶部，多个置顶项之间、未置顶项之间均可拖拽排序；跨组移动使用图钉按钮。仅置顶再取消不会改变原排序位置；组内拖拽则更新相应组的排序。置顶和排序自动保存，刷新、换站及重新接入代理后保留，不会切换当前中转或修改密钥配置。

本地代理模式下，推荐先完成第 1、2 步，再设置上游网络和中转站。直连模式下，先完成第 1 步，再按第 3、4 步选择中转；写入直连配置后重启 Codex。

## 编辑已保存的中转

1. 点击目标中转右侧的铅笔图标（“编辑”）。
2. 在弹窗中修改名称、Base URL 或 API Key；API Key 留空保留原密钥，填写新值则替换。原密钥不会回填到页面。
3. 点击“保存修改”；不保存时点击“取消”或按 Esc。失败时弹窗保留输入并显示原因。

重命名会保留置顶、排序以及本地代理选中的中转。修改正在使用的本地代理中转后，新请求使用新地址和密钥，已经开始的请求保持原配置。直连模式保存只更新列表，不修改 Codex 当前配置；要应用新的地址或密钥，需再点击该中转的“切换”，然后重启 Codex。其他窗口已修改同一条记录时，会拒绝过期保存，关闭弹窗并刷新后重新编辑。

## 第一次使用本地代理

先确认页面上的「CODEX 目录」指向你的 Codex 配置目录（默认 `~/.codex`）。如果不是，填入正确路径后点「保存目录」；这个设置会持久保存，之后不用再改。详见 [MANAGED-RELAY-README.md](MANAGED-RELAY-README.md)。

> 把本工具复制到其他项目时，与其每次重填，不如在项目根目录的 `codex-relay.config.json` 里写死 `codexHome` 和 `codexAppPath`，两个入口都会读取它。详见 [项目配置文件](MANAGED-RELAY-README.md#项目配置文件-codex-relayconfigjson)。

1. 进入项目目录，在终端启动管理服务：

   macOS：

   ```sh
   sh start-managed-relay.sh
   ```

   Windows（PowerShell 或 CMD，也可直接双击）：

   ```bat
   start-managed-relay.cmd
   ```

   保持这个终端运行。关闭浏览器不会停止服务。

2. 打开管理页面，选择“本地代理”和要使用的中转站。

3. 点击页面顶部“本地代理”，再点击紧邻的“接入本地代理”。这会把 Codex 的 provider 地址改为本机代理地址。

4. 完全退出 Codex。首次接入必须重启一次，让 Codex 读取新的 provider 地址。macOS 用 Cmd+Q；Windows 从托盘退出。

5. 使用项目目录里的 Codex 启动脚本：

   macOS：

   ```sh
   sh start-codex-local.sh
   ```

   Windows：

   ```bat
   start-codex-local.cmd
   ```

   这个脚本只为新启动的 Codex 进程加入 `NO_PROXY` 和 `no_proxy`，确保 `127.0.0.1`、`localhost`、`::1` 直连；不会修改 FlyingBird 或系统代理。它只用 Node 内置模块，不需要安装 npm 依赖。

   Windows 上窗口会在脚本结束时停住（`pause`），报错信息不会一闪而过；自动化调用可先设 `RELAY_NO_PAUSE=1`。脚本同时会把控制台切到 UTF-8，中文提示不会变成乱码。

   如果提示「未找到 Codex 桌面应用」，见 [CODEX-LOCAL-NETWORK.md](CODEX-LOCAL-NETWORK.md#应用不在默认位置)：可以设 `CODEX_APP_PATH`，也可以直接在项目根目录的 `codex-relay.config.json` 里填 `codexAppPath`。

## 使用 FlyingBird 测试

1. 先保持管理服务运行，并让 Codex 通过 `start-codex-local.sh` 启动。
2. 开启 FlyingBird 的智能连接。
3. 在管理页面“上游网络”选择“自动跟随系统代理”。如果系统代理状态没有被识别，可选择“指定代理”，填写 `http://127.0.0.1:7892`，再点击“保存网络设置”。
4. 点击“检查所选中转连接”。看到 HTTP 200，只表示 `/models` 接口可达。
5. 再发送一条 Codex 测试消息。
6. 页面或日志中应看到实际请求的 `outbound` 为 `http://127.0.0.1:7892`，或看到 `outboundSource` 为 `system-https`、`system-http`、`flyingbird-auto`、`manual`。

在本地代理模式下，页面切换中转站对后续请求立即生效，不需要重启 Codex。已经开始的流式请求会继续使用原来的中转站。

## 切回直接配置

1. 在管理页面顶部点击“直接配置”；如果当前已经接入本地代理，则点击紧邻的“恢复接入前的直连配置”。
2. 完全退出当前 Codex，再重新启动。
3. 直连模式下使用普通方式双击 Codex App。`start-codex-local.sh` 专门用于本地代理模式，检测到直连配置时会拒绝启动。

直连模式会恢复为以前的行为：切换中转站会修改 Codex 配置，之后需要重启 Codex 才能加载新的中转站。这个过程不会修改 FlyingBird。

## 再次接入本地代理

1. 启动管理服务并打开页面。
2. 点击顶部“本地代理”，再点击“接入本地代理”；然后在列表中点击目标中转的“切换”。
3. 完全退出 Codex。
4. 再次使用 `start-codex-local.sh` 启动 Codex。

之后只需在页面切换中转站，不需要再次重启 Codex。

## 停止服务

在运行 `start-managed-relay.sh` 的终端按 `Ctrl+C`。这只停止管理页面和本地转发服务，不会停止 FlyingBird 或 Codex。

不要在 Codex 正在进行对话时停止管理服务；正在进行的请求会被中断。

## 常见状态

- 页面显示“服务已启动”：管理服务正常运行。
- 页面显示“Codex 配置已指向代理”：配置已经写入，但 Codex 可能还没有重启加载。
- 上游检查 HTTP 200，但 Codex 无法对话：先确认 Codex 是通过 `start-codex-local.sh` 启动的，再查看页面最近请求和 `relay-ui-runtime/requests.jsonl`。
- 页面显示 `ECONNREFUSED`：指定的代理端口当前没有监听，确认 FlyingBird 智能连接已开启，或改回自动模式。

完整网络诊断说明见 `CODEX-LOCAL-NETWORK.md` 和 `MANAGED-RELAY-README.md`。
