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

双击运行时窗口会闪退，属正常现象（脚本只负责启动 Codex 后退出）。

### 只检查、不启动

```sh
sh start-codex-local.sh --check      # macOS
start-codex-local.cmd --check        # Windows
```

### 应用不在默认位置

用 `CODEX_APP_PATH` 指定：

- macOS：指向 `.app` 目录（例如 `/Applications/ChatGPT.app`）
- Windows：指向 `Codex.exe`，或它所在的目录

Windows 上会先自动探测以下位置，都找不到才需要设置：

```
%LOCALAPPDATA%\Programs\Codex\Codex.exe
%LOCALAPPDATA%\Programs\ChatGPT\ChatGPT.exe
%LOCALAPPDATA%\Codex\Codex.exe
%LOCALAPPDATA%\ChatGPT\ChatGPT.exe
%PROGRAMFILES%\Codex\Codex.exe
%PROGRAMFILES%\ChatGPT\ChatGPT.exe
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

本入口直接运行 `managed-relay-runtime/codex-launch.js`，它只使用 Node 内置模块（`node:fs`、`node:path`、`node:http`、`node:child_process`、`node:util`），**不依赖 `node_modules`**。所以即使从未执行过 `npm ci`，这个入口也能正常工作。

安装 Node.js：从 <https://nodejs.org> 下载 LTS 安装包。装完**新开一个终端**（PATH 只在新窗口生效），确认：

```sh
node --version     # 应输出 v22.13.0 或更高
```

> 注意与中转服务的区别：`start-managed-relay.sh` / `start-managed-relay.cmd` 需要 npm 依赖，首次运行会自动执行 `npm ci` 安装。两个入口的依赖要求不同。

## 其他

此处重启一次 Codex 是为了让其继承进程级绕过规则。之后在本地代理模式切换中转无需重启。规则只随本次启动生效；完全退出后从 Dock 或开始菜单普通启动不会带有这些规则，可再次使用本入口启动。

## 验证范围

已使用本机 Codex 二进制、隔离 CODEX_HOME、模拟 HTTP 代理和模拟上游验证：不设置 NO_PROXY 时，本机模型请求进入模拟代理；设置后直达本机上游。没有开启 FlyingBird。真实 macOS 系统代理与 FlyingBird 场景仍需现场验证。

**Windows 分支尚未在真实 Windows 上实测。** 已在本机验证平台分发、`CODEX_APP_PATH` 的文件／目录两种形式和候选路径探测；`tasklist` 进程检测、`reg query` 环境读取和实际启动行为需要到 Windows 上确认。首次使用请先运行 `--check`。

检查日志应出现 `relay_request_started`；如果有开始记录，再根据对应结束记录的 `outbound`、`upstreamStatus` 和 `responseBytes` 判断上游路径。顶部网络状态是当前路由，下方带时间的检查结果是历史检查，关闭 VPN 后两者可能不同。
