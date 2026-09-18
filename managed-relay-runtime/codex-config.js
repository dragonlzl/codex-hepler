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

// ------------------------------------------------------- Windows 路径容错
//
// 从资源管理器地址栏复制出来的 Windows 路径是单反斜杠的（C:\Users\you\.codex）。
// 直接粘进 JSON 会踩两个坑：
//   1. \U 不是合法转义，JSON.parse 直接抛错；
//   2. \t、\n 是合法转义，会被悄悄解析成制表符／换行（C:\temp 变成 "C:<TAB>emp"），更难发现。
// 容错只作用于顶层路径字段。推荐仍用 / 或 JSON 标准的 \\，避免歧义。

// 配置文件里只认路径字段，修复范围仅限这些字段的值。
const FIELD_NAMES = ['codexAppPath', 'codex_app_path', 'codexHome', 'codex_home', 'codexCliPath'];

function stringEnd(text, start, allowTrailingSlash = false) {
  for (let index = start + 1; index < text.length; index += 1) {
    if (text[index] === '"') return index;
    if (text[index] !== '\\') continue;
    // Windows 目录末尾的单 \ 会吃掉闭引号；仅在后面是字段分隔符时恢复它。
    if (allowTrailingSlash && text[index + 1] === '"' && /^\s*[,}]/.test(text.slice(index + 2))) return index + 1;
    index += 1;
  }
  return -1;
}

// 按字符串边界和嵌套层级扫描，避免把注释文本、嵌套对象里的同名字段当成路径。
function fieldValueSpans(text) {
  const spans = new Map();
  let depth = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '{' || char === '[') depth += 1;
    else if (char === '}' || char === ']') depth -= 1;
    else if (char === '"') {
      const end = stringEnd(text, index);
      if (end < 0) break;
      let name;
      try { name = JSON.parse(text.slice(index, end + 1)); } catch { /* 留给最终 JSON.parse 报错。 */ }
      index = end;
      if (depth !== 1 || !FIELD_NAMES.includes(name)) continue;
      const colon = /^\s*:\s*"/.exec(text.slice(end + 1));
      if (!colon) continue;
      const start = end + colon[0].length;
      const windowsPath = /^(?:[A-Za-z]:[\\/]|\\\\|%[^%]+%[\\/]|~[\\/]|\.\.?[\\/])/.test(text.slice(start + 1).trimStart());
      const valueEnd = stringEnd(text, start, windowsPath);
      if (valueEnd < 0) break;
      spans.set(start, { start: start + 1, end: valueEnd });
      index = valueEnd;
    }
  }
  return spans;
}

// 已配对的 \\、标准的 \/ 保持原样，其余单 \ 不受前一个字符（中文、空格等）影响。
// 容错时保留直接粘贴的 UNC 前缀 \\，不能按 JSON 转义把它缩成单个 \。
function doublePathBackslashes(value) {
  const trimmed = value.trimStart();
  const pastedUnc = /^\\\\[^\\]/.test(trimmed);
  const prefixOffset = value.length - trimmed.length;
  return value.replace(/\\\\|\\\/|\\/g, (match, offset) => (
    match.length === 1 || (pastedUnc && offset === prefixOffset) ? match + match : match
  ));
}

function hasControlChars(value) {
  return typeof value === 'string' && /[\u0000-\u001F]/.test(value);
}

// 每个字段独立判断，修复一个路径不能改变另一个已正确转义的路径或 $comment。
// C:\u0061 等单分隔符前缀明确按粘贴路径处理；已转义路径仍遵循标准 JSON。
function parseLooseJson(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  for (const { start, end } of [...fieldValueSpans(text).values()].reverse()) {
    const value = text.slice(start, end);
    const trimmed = value.trimStart();
    const singleRoot = /^(?:[A-Za-z]:|%[^%]+%|~|\.\.?)\\(?![\\/])/.test(trimmed);
    const pastedUnc = /^\\\\[^\\]/.test(trimmed) && trimmed.replace(/\\\\|\\\//g, '').includes('\\');
    try {
      const decoded = JSON.parse(`"${value}"`);
      if (!hasControlChars(decoded) && !singleRoot && !pastedUnc) continue;
    } catch { /* 仅修复这个路径字段中的反斜杠。 */ }
    text = text.slice(0, start) + doublePathBackslashes(value) + text.slice(end);
  }
  let parsed;
  try { parsed = JSON.parse(text); } catch { return null; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  if (FIELD_NAMES.some(name => hasControlChars(parsed[name]))) return null;
  return parsed;
}

// 字符串字段：去掉首尾空白，空串一律当作未设置。
function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

// 读取配置。文件缺失、JSON 损坏或字段类型不对时都回退到空配置，
// 让启动入口退回到自动探测，而不是因为一个坏文件直接失败。
function readCodexConfig(file = configPath()) {
  let source;
  try {
    source = fs.readFileSync(file, 'utf8');
  } catch {
    return { config: {}, file, present: false };
  }
  const raw = parseLooseJson(source);
  if (!raw) return { config: {}, file, present: true };
  const appPath = text(raw.codexAppPath) || text(raw.codex_app_path);
  const home = text(raw.codexHome) || text(raw.codex_home);
  const cliPath = text(raw.codexCliPath);
  return {
    file,
    present: true,
    config: {
      ...(appPath ? { codexAppPath: appPath } : {}),
      ...(home ? { codexHome: home } : {}),
      ...(cliPath ? { codexCliPath: cliPath } : {}),
    },
  };
}

function loadCodexConfig(file = configPath()) {
  return readCodexConfig(file).config;
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
// codexAppPath 指桌面应用（macOS 的 .app、Windows 的 ChatGPT.exe / Codex.exe 或所在目录）；
// codexHome 指配置目录，包含 config.toml 和 key_config.json。
// config 传 null 时读磁盘上的文件；传入对象（含空对象）则以传入的为准。
function resolveCodexPaths({ env = process.env, config = null, file = configPath(env) } = {}) {
  const values = config !== null ? config : loadCodexConfig(file);
  const appFromEnv = expandPath(env.CODEX_APP_PATH, env);
  const appFromConfig = expandPath(values.codexAppPath, env);
  const homeFromEnv = expandPath(env.CODEX_HOME, env);
  const homeFromConfig = expandPath(values.codexHome, env);
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

module.exports = {
  CONFIG_FILENAME, configPath, readCodexConfig, loadCodexConfig, resolveCodexPaths, expandPath, configHint,
  parseLooseJson, fieldValueSpans, doublePathBackslashes,
};
