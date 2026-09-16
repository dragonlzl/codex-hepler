const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 项目级 JSON 配置文件。放在仓库里，跟着项目一起复制到其他机器，
// 于是换项目／换设备时不需要再设置环境变量。
const CONFIG_FILENAME = 'codex-relay.config.json';
const PROJECT_ROOT = path.resolve(__dirname, '..');

// 只使用 Node 内置模块，保证 codex-launch.js 在没有 node_modules 时也能读配置。
// platform 默认取当前平台，测试里可以显式传入。
function configPath(env = process.env, platform = process.platform) {
  if (env.CODEX_TOOL_CONFIG) return path.resolve(env.CODEX_TOOL_CONFIG);
  // 1) 项目根目录：随项目分发，其他项目拷贝本工具时一起带上。
  const local = path.join(PROJECT_ROOT, CONFIG_FILENAME);
  if (fs.existsSync(local)) return local;
  // 2) 用户级目录：不随项目移动的个人设置，作为兜底。
  const base = platform === 'win32'
    ? env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
    : env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'codex-relay-ui', CONFIG_FILENAME);
}

// 字符串字段：去掉首尾空白，空串一律当作未设置。
function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

// 读取配置。文件缺失、JSON 损坏或字段类型不对时都回退到空配置，
// 让启动入口退回到自动探测，而不是因为一个坏文件直接失败。
function loadCodexConfig(file = configPath()) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const appPath = text(raw.codexAppPath) || text(raw.codex_app_path);
  const home = text(raw.codexHome) || text(raw.codex_home);
  return {
    ...(appPath ? { codexAppPath: appPath } : {}),
    ...(home ? { codexHome: home } : {}),
  };
}

// 把配置里的路径展开成绝对路径：兼容 ~，也兼容 Windows 环境变量写法（%LOCALAPPDATA%）。
function expandPath(value, env = process.env) {
  if (typeof value !== 'string' || !value.trim()) return null;
  let result = value.trim();
  if (result === '~') result = os.homedir();
  else if (/^~[\\/]/.test(result)) result = path.join(os.homedir(), result.slice(2));
  result = result.replace(/%([^%]+)%/g, (match, name) => env[name] ?? env[name.toUpperCase()] ?? match);
  // Windows 盘符／UNC 路径在其它平台上 path.resolve 会拼上工作目录；这里原样返回，
  // 让调用方按目标平台处理，而不是悄悄拼出一个错误的绝对路径。
  if (/^[A-Za-z]:[\\/]/.test(result) || /^\\\\/.test(result)) return result;
  return path.resolve(result);
}

// 返回 Codex 相关位置的解析结果与来源，供启动入口和诊断输出使用。
// 优先级：环境变量 CODEX_APP_PATH > 配置文件 codexAppPath > 各平台自动探测。
// codexAppPath 指桌面应用（macOS 的 .app、Windows 的 Codex.exe 或所在目录）；
// codexHome 指配置目录，包含 config.toml 和 key_config.json。
function resolveCodexPaths({ env = process.env, config = loadCodexConfig(), file = configPath(env) } = {}) {
  const appFromEnv = expandPath(env.CODEX_APP_PATH, env);
  const appFromConfig = expandPath(config.codexAppPath, env);
  const homeFromEnv = expandPath(env.CODEX_HOME, env);
  const homeFromConfig = expandPath(config.codexHome, env);
  return {
    configFile: file,
    appPath: appFromEnv || appFromConfig || null,
    appSource: appFromEnv ? 'env' : appFromConfig ? 'config' : null,
    home: homeFromEnv || homeFromConfig || null,
    homeSource: homeFromEnv ? 'env' : homeFromConfig ? 'config' : null,
  };
}

// 出错时提示用户该改哪个文件，避免只说“设置 CODEX_APP_PATH”却不知道去哪儿设置。
function configHint(env = process.env) {
  return `也可以编辑配置文件 ${configPath(env)}，填写 codexAppPath。`;
}

module.exports = { CONFIG_FILENAME, configPath, loadCodexConfig, resolveCodexPaths, expandPath, configHint };
