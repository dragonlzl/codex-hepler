# Codex 中转站配置页面

本地网页界面，用来管理 Codex 的多个中转站（relay）：保存一组「名称 + API Key + Base URL」，在多个中转站之间切换，并可选择让 Codex 走本机转发代理。

所有服务只绑定 `127.0.0.1`，不对局域网或公网开放。

## 启动

项目包含三个脚本，前两个读写同一个 `key_config.json`：

| 脚本 | macOS | Windows | 作用 |
| --- | --- | --- | --- |
| 管理服务（推荐） | `sh start-managed-relay.sh` | `start-managed-relay.cmd` | 管理页面（3790）+ 本地转发代理（3211），可接入／恢复 Codex 配置 |
| 配置页面（基础版） | `npm start` | `npm start` | 只管理中转站列表，页面在 3789，不启动代理 |
| Codex 启动入口 | `sh start-codex-local.sh` | `start-codex-local.cmd` | 给 Codex 进程注入本机代理绕过规则，仅接入本地代理后需要 |

**依赖**：都需要 Node.js 22.13 或更高版本，从 <https://nodejs.org> 安装 LTS 版。

- `start-managed-relay.*` 需要 npm 依赖，首次运行会自动执行 `npm ci`。
- `start-codex-local.*` 只用 Node 内置模块，**不需要任何 npm 包**。
- `npm start`（基础版）无第三方依赖。

管理服务的行为见 [MANAGED-RELAY-README.md](MANAGED-RELAY-README.md)，Codex 启动入口见 [CODEX-LOCAL-NETWORK.md](CODEX-LOCAL-NETWORK.md)，故障排查见 [START-HOWTO.md](START-HOWTO.md)。

## 项目配置文件 `codex-relay.config.json`

把工具复制到其他项目使用时，不必每次重新填写路径。在**项目根目录**放一个 `codex-relay.config.json`（模板见 [`codex-relay.config.example.json`](codex-relay.config.example.json)）：

```json
{
  "codexAppPath": "C:\\Users\\you\\AppData\\Local\\Programs\\Codex\\Codex.exe",
  "codexHome": "C:\\Users\\you\\.codex"
}
```

- `codexAppPath`：Codex 桌面应用位置，解决「未找到 Codex 桌面应用」并让 `start-codex-local.*` 能找到应用。Windows 填 `Codex.exe` 或它所在目录，macOS 填 `.app` 目录。
- `codexHome`：Codex 配置目录（含 `config.toml`、`key_config.json`），等价于在页面上保存「CODEX 目录」，但随项目分发。
- 两个字段都可以省略，环境变量 `CODEX_APP_PATH` / `CODEX_HOME` 仍优先于它们；留空时按各自平台自动探测。
- 本机的 `codex-relay.config.json` 已在 `.gitignore` 中忽略，**只有 `codex-relay.config.example.json` 会进版本库**。

完整字段说明和查找顺序见 [MANAGED-RELAY-README.md](MANAGED-RELAY-README.md#项目配置文件-codex-relayconfigjson)。

> Windows 上两个 `.cmd` 会先把控制台切到 UTF-8（`chcp 65001`）并在结束前 `pause`，中文不再乱码，报错也不会一闪而过。自动化调用时先设 `RELAY_NO_PAUSE=1` 可跳过等待。

---

# `key_config.json` 使用须知

## 这个文件是什么

它是本工具**唯一的中转站数据文件**，保存你所有中转站的名称、API Key 和接口地址。两个入口都从这里读、也写回这里。**其中 API Key 是明文存储的。**

## 放在哪里

| 入口 | 读取路径 | 能否自定义 |
| --- | --- | --- |
| 完整版 | 优先 `CODEX_HOME`，其次项目配置文件里的 `codexHome`，否则用页面保存的目录，都没有时回退到 `~/.codex` | 可以：**在页面的「CODEX 目录」里填写并保存**，或在 `codex-relay.config.json` 里填 `codexHome`，或设 `CODEX_HOME` 环境变量 |
| 基础版 | 优先 `CODEX_HOME`，否则 `~/.codex/key_config.json` | 只能设 `CODEX_HOME` 环境变量，页面上不能改 |

> 基础版没有页面设置目录的功能，也不读取页面保存的目录和项目配置文件。**跨机器使用请用完整版。**

### 在页面上切换 Codex 目录

完整版页面里有一块「**CODEX 目录**」：

- 显示当前正在使用的目录，以及这个设置是从哪来的（页面保存／环境变量／默认位置）。
- 页面上的路径**一律用 `~` 表示当前用户的主目录**（例如 `~/.codex`），不会把真实的用户名显示出来，方便截图分享。输入框里也可以直接写 `~/.codex`，保存时会自动展开。
- 填入新路径点「保存目录」**立即生效，不需要重启服务**：中转站列表、provider 信息、出站设置都会切换到新目录。
- 路径会**持久保存**，刷新页面或重启服务都不会丢。保存位置按平台决定：

  | 平台 | 设置文件 |
  | --- | --- |
  | macOS / Linux | `~/.config/codex-relay-ui/settings.json`（或 `$XDG_CONFIG_HOME`） |
  | Windows | `%APPDATA%\codex-relay-ui\settings.json` |

  设置文件**故意放在 Codex 目录之外**——它记录的就是 Codex 目录的位置，存进去会变成死循环。它只有 `0600` 权限，且只存路径，不存任何密钥。

- 目录优先级：**启动参数 > `CODEX_HOME` 环境变量 > `codex-relay.config.json` 的 `codexHome` > 页面保存的目录 > 默认 `~/.codex`**。用前三种方式指定时，页面上的输入框会被锁定（避免多处设置互相打架），页面上会标注来源。
- 保存前会校验目标目录：必须存在，且包含 `config.toml`（否则拒绝并给出原因）。**如果目标目录缺少 `key_config.json`，会自动创建一个空的**，方便在新设备上直接开始使用。
- 需要用独立目录做测试时，可以设 `RELAY_UI_SETTINGS` 环境变量把设置文件指到别处。

macOS 上的默认目标就是：

```
~/.codex/key_config.json
```

## 必须先创建，否则启动失败

完整版启动时会读取这个文件，**文件不存在会直接启动失败**，不会自动创建，也不会有友好提示：

```
ENOENT: no such file or directory, open '.../.codex/key_config.json'
```

所以在**新机器上，第一步必须手动把这个文件创建出来**。三种方式任选：

**方式一：放一个空壳（推荐，密钥不跨机器流动）**

```bash
mkdir -p ~/.codex
echo '{"keys":[]}' > ~/.codex/key_config.json
chmod 600 ~/.codex/key_config.json
```

启动后在页面上逐个添加中转站即可。这是新机器上最干净的起点。

**方式二：复制范例再改**

```bash
cp key_config.example.json ~/.codex/key_config.json
chmod 600 ~/.codex/key_config.json
```

然后把里面的占位值改成你自己的。

**方式三：从旧机器整体搬过来**

直接把旧机器的 `~/.codex/key_config.json` 复制过去，中转站列表和密钥会一并带过去。

> 只搬这一个文件就够。`~/.codex` 下其他文件要么是 Codex 自带的，要么由本工具自动生成（如 `relay-ui-runtime/`），都不需要搬。特别注意**不要搬 `config.toml`**——里面记着旧机器的绝对路径和本地代理端口，搬过去会让 Codex 连不上。

## 文件结构

```json
{
  "keys": [
    {
      "name": "中转站 A",
      "value": "sk-REPLACE-WITH-YOUR-API-KEY",
      "baseurl": "https://api.example.com/v1"
    },
    {
      "name": "中转站 B",
      "value": "sk-REPLACE-WITH-ANOTHER-API-KEY",
      "baseurl": "https://relay.example.net/v1"
    }
  ]
}
```

顶层必须有 `keys` 数组，**数组为空也是合法的**（`{"keys":[]}` 可以正常启动）。完整可用的范例见项目根目录的 [`key_config.example.json`](key_config.example.json)。

## 该填什么

每个数组元素是一条中转站，三个字段都必填：

| 字段 | 含义 | 约束 |
| --- | --- | --- |
| `name` | 中转站名称，页面上显示的名字 | 非空字符串，≤ 2000 字符，**列表内不能重名**。可以包含中文、空格和 emoji（例如 `备用线路✨`） |
| `value` | API Key | 非空字符串，≤ 2000 字符，**内部不能有空白或非 ASCII 字符**（首尾空白会被自动去掉） |
| `baseurl` | 接口地址 | 必须是 `http://` 或 `https://` 开头的合法地址，**不能带账号密码、查询参数（`?`）或片段（`#`）**；结尾的 `/` 会被自动去掉 |

### 其他字段

条目里可以额外带上你自己的字段（例如 `"note": "备注"`），页面编辑时会原样保留，不会被删掉。顶层同理——历史版本可能写过 `target_file` 之类的字段，当前代码不读取它们，但也**不会清除**，留着无害。

## 权限和安全

- **文件权限务必设为 `600`**：`chmod 600 ~/.codex/key_config.json`。本工具自己写文件时用的是 `0600`，但你手动创建的文件会跟随系统 umask，在 macOS 上默认是 `644`（同机其他用户可读）。
- 文件里是**明文 API Key**，不要提交到 Git、不要放进云同步目录、不要随截图或日志外发。
- 本项目的 `.gitignore` 已经忽略了 `key_config.json`，但范例文件 `key_config.example.json` 是故意保留的（里面只有占位符）。
- 每次通过页面修改配置，工具都会在 `$CODEX_HOME/relay-ui-runtime/backup-*.json` 留一份 `0600` 的备份，其中**含明文密钥**，且目前**不会自动清理**，长期使用会持续累积，请自行留意清理。

## 一个前置条件

`key_config.json` 准备好之后，**能不能"接入本地代理"还取决于当前 `config.toml`**：其中必须已经存在一个带显式 `base_url` 的 provider，否则页面会提示：

```
当前 provider 没有可编辑的 base_url。请先配置一个中转 provider。
```

如果新机器上的 Codex 只用 ChatGPT 登录、从没配过 API Key provider，先往 `~/.codex/config.toml` 加上这样一段骨架即可（`base_url` 填什么无所谓，接入时会被覆盖）：

```toml
model_provider = "relay"

[model_providers.relay]
name = "relay"
base_url = "https://api.openai.com/v1"
wire_api = "responses"
```

## 测试

```bash
npm test --prefix managed-relay-runtime
```
