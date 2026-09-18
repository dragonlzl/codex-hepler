# Codex 本机连接入口

中转管理服务的出站代理和 Codex 到本地服务的连接是两段独立网络。上游检查经过 FlyingBird 返回 HTTP 200，只证明模型列表接口的网络可达，不证明 Codex 请求已到达本地服务或推理成功。

`start-codex-local.sh`（macOS）和 `start-codex-local.cmd`（Windows）为**新启动的** Codex 进程注入 `NO_PROXY` 和 `no_proxy`，包含 `127.0.0.1,localhost,::1`，并保留已有的绕过规则。它不会设置 HTTP_PROXY，不会修改 Codex 配置、系统代理或系统环境变量，也不会退出正在运行的 Codex。

## 直接启动 Codex 和使用本入口的区别

| | 直接启动（双击图标 / 开始菜单 / Dock） | 使用本入口启动 |
| --- | --- | --- |
| Codex 进程的 `NO_PROXY` | 不设置，沿用系统原有环境 | 注入 `127.0.0.1,localhost,::1` 及已有绕过规则 |
| 访问本地代理 `127.0.0.1:3211` | 可能被系统代理或 VPN 接管，请求发不出去 | 回环地址直连，绕过代理 |
| 生效范围 | — | 只作用于本次启动的进程，退出后失效 |
| 是否改动系统设置 | — | 不改动，只影响这一个子进程的环境 |

**为什么需要它**：接入本地代理后，Codex 要访问的是 `127.0.0.1:3211`。如果系统代理、或 VPN 的 TUN／全局模式也接管回环地址，这个请求会被送去代理，Codex 就始终连不上本地服务。注入 `NO_PROXY` 让回环流量绕过代理。

**用直连模式时不需要这个入口**——普通方式启动 Codex 即可。本入口检测到尚未接入本地代理时会拒绝启动。

## 使用

1. 保持中转服务运行，并在管理页面接入本地代理。
2. 当前 Codex 回复结束后，**完全退出** Codex：macOS 用 Cmd+Q，Windows 从托盘退出。
3. 在项目目录运行对应平台的脚本。

### macOS

```sh
sh start-codex-local.sh
```

### Windows

在 PowerShell 或 CMD 中运行，也可以直接双击：

```bat
start-codex-local.cmd
```

脚本结束前会 `pause`：无论成功还是报错（例如找不到 Codex 应用），窗口都会停住等你看完再按键关闭。自动化调用时可先设置 `RELAY_NO_PAUSE=1` 跳过。

脚本会把控制台切到 UTF-8 代码页（`chcp 65001`），中文提示不会显示成乱码。

### 只检查、不启动

```sh
sh start-codex-local.sh --check      # macOS
start-codex-local.cmd --check        # Windows
```

### 应用不在默认位置

按下面的顺序生效：

1. 环境变量 `CODEX_APP_PATH`
2. 项目根目录 `codex-relay.config.json` 里的 `codexAppPath`
3. 各平台自动探测的常见位置

`CODEX_APP_PATH` 的写法：

- macOS：指向 `.app` 目录（例如 `/Applications/ChatGPT.app`）
- Windows：指向 `ChatGPT.exe`、`Codex.exe` 的完整路径，或它所在的目录

也可以在管理页面的「目录与应用 → ChatGPT 应用」中直接填写并保存；页面会将路径写入下述 JSON 配置，并在下次使用启动脚本时生效。留空保存可恢复自动查找；存在 `CODEX_APP_PATH` 环境变量时，页面显示该来源并锁定应用路径。

没有环境变量时，把路径写进项目根目录的 JSON 配置文件，换项目、换机器时都不用再设环境变量：

```json
{
  "codexAppPath": "C:/Tools/Codex/app/ChatGPT.exe"
}
```

填写目录时，脚本优先查找 `ChatGPT.exe`，找不到再使用旧版 `Codex.exe`。填写完整文件路径时，使用指定文件。WindowsApps 安装包中的 `app/ChatGPT.exe` 同样可以直接指定；建议使用 `/` 分隔目录，避免 JSON 反斜杠转义。

**WindowsApps 更新无需重填路径**：继续保存某次安装的完整目录即可。启动时先检查原路径；原路径失效后，会在同一安装位置按包名特征查找新版。例如 `C:/Program Files/WindowsApps/OpenAI.Codex_26.908.9136.0_x64__2p2nqsd0c76g0/app` 会匹配同一 WindowsApps 目录下的 `OpenAI.Codex_*/app`。也兼容 `C:/Program Files/WindowsApps/OpenAI.Codex/_26.908.9136.0/_x64/_/_2p2nqsd0c76g0/app` 这种分层路径，只替换版本目录，其余层级保持一致。

只有找到唯一可用安装才会启动；填写目录时优先 `ChatGPT.exe`，填写完整文件路径时保留该文件名。多个安装同时可用时会列出候选并提示选择；没有匹配或安装目录不可读时会给出错误提示。此规则同时适用于 JSON 配置和 `CODEX_APP_PATH`，不会改写原配置，连续更新后仍可复用。启动和 `--check` 会打印实际定位到的应用路径。

同目录的 `codex-relay.config.example.json` 是模板；本机的 `codex-relay.config.json` 不会进版本库。字段说明见 [MANAGED-RELAY-README.md](MANAGED-RELAY-README.md#项目配置文件-codex-relayconfigjson)。

Windows 上会先按以下目录顺序查找 `ChatGPT.exe`，全部找不到再按同样顺序查找 `Codex.exe`。ChatGPT 安装目录优先于旧 Codex 安装目录；都找不到时需要手动设置：

```
%LOCALAPPDATA%\Programs\ChatGPT
%LOCALAPPDATA%\ChatGPT
%PROGRAMFILES%\ChatGPT
%LOCALAPPDATA%\Programs\Codex
%LOCALAPPDATA%\Codex
%PROGRAMFILES%\Codex
```

使用非默认管理端口时传入 `RELAY_UI_PORT`。

### 如果你用的是 Codex CLI

本入口是为**桌面应用**准备的。Codex CLI 不需要它——在启动 `codex` 的同一个终端里设置环境变量即可，子进程会自动继承：

PowerShell：

```powershell
$env:NO_PROXY = "127.0.0.1,localhost,::1"
codex
```

CMD：

```bat
set NO_PROXY=127.0.0.1,localhost,::1
codex
```

## 依赖

**只需要 Node.js 22.13 或更高版本，不需要安装任何 npm 包。**

本入口直接运行 `managed-relay-runtime/codex-launch.js`，它只使用 Node 内置模块（`node:fs`、`node:path`、`node:http`、`node:child_process`、`node:util`），读取 JSON 配置文件用的 `codex-config.js` 同样只用内置模块，**不依赖 `node_modules`**。所以即使从未执行过 `npm ci`，这个入口也能正常工作。

安装 Node.js：从 <https://nodejs.org> 下载 LTS 安装包。装完**新开一个终端**（PATH 只在新窗口生效），确认：

```sh
node --version     # 应输出 v22.13.0 或更高
```

> 注意与中转服务的区别：`start-managed-relay.sh` / `start-managed-relay.cmd` 需要 npm 依赖，首次运行会自动执行 `npm ci` 安装。两个入口的依赖要求不同。

## 其他

此处重启一次 Codex 是为了让其继承进程级绕过规则。之后在本地代理模式切换中转无需重启。规则只随本次启动生效；完全退出后从 Dock 或开始菜单普通启动不会带有这些规则，可再次使用本入口启动。

用 `--check` 时若读到了 JSON 配置文件，会先打印一行来源说明，例如：

```
配置文件 C:\Tools\codex-relay.config.json：codexAppPath=C:\Tools\Codex\Codex.exe（来自配置文件）
```

## 常见报错

- **未找到 Codex 桌面应用**：先确认路径写对，再按上面的顺序设置 `CODEX_APP_PATH` 或 `codexAppPath`。报错信息里会带上实际读取的配置文件路径，照着改即可。
- **指定的 Codex 应用不可用**：环境变量或配置文件里的路径不存在或不可访问，或者目录中没有 `ChatGPT.exe` / `Codex.exe`（macOS 需要有效的 Codex `.app`）。
- **Codex 尚未接入本地代理**：先在管理页面点击「接入本地代理」，再运行本入口。
- **中转服务未响应**：管理服务没在运行，或端口被 `RELAY_UI_PORT` 改过而这里没同步。

## 验证范围

已使用本机 Codex 二进制、隔离 CODEX_HOME、模拟 HTTP 代理和模拟上游验证：不设置 NO_PROXY 时，本机模型请求进入模拟代理；设置后直达本机上游。没有开启 FlyingBird。真实 macOS 系统代理与 FlyingBird 场景仍需现场验证。

**Windows 分支尚未在真实 Windows 上实测。** 已在本机验证平台分发、`CODEX_APP_PATH`／配置文件两种来源的文件与目录形式、候选路径探测、路径错误时的提示文案，以及 `.cmd` 的 `chcp 65001` + `pause` 文本；`tasklist` 进程检测、`reg query` 环境读取和实际启动行为需要到 Windows 上确认。首次使用请先运行 `--check`。

检查日志应出现 `relay_request_started`；如果有开始记录，再根据对应结束记录的 `outbound`、`upstreamStatus` 和 `responseBytes` 判断上游路径。顶部网络状态是当前路由，下方带时间的检查结果是历史检查，关闭 VPN 后两者可能不同。
