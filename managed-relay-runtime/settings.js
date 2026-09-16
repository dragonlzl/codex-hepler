const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { atomicWrite, problem } = require('./config-store');

// 目录设置必须存在 CODEX_HOME 之外：它记录的正是 CODEX_HOME 的位置，
// 存进去会变成先有鸡还是先有蛋。这里按平台放到用户的配置目录。
function settingsPath(env = process.env) {
  if (env.RELAY_UI_SETTINGS) return path.resolve(env.RELAY_UI_SETTINGS);
  if (process.platform === 'win32') {
    const base = env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(base, 'codex-relay-ui', 'settings.json');
  }
  const base = env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'codex-relay-ui', 'settings.json');
}

async function readSettings(env = process.env) {
  try {
    const raw = JSON.parse(await fs.readFile(settingsPath(env), 'utf8'));
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch {
    // 设置文件缺失或损坏都不应阻止启动，回退到默认目录。
    return {};
  }
}

async function writeSettings(patch, env = process.env) {
  const file = settingsPath(env);
  const next = { ...(await readSettings(env)), ...patch };
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await atomicWrite(file, `${JSON.stringify(next, null, 2)}\n`);
  return file;
}

const isDirectory = async target => fs.stat(target).then(stat => stat.isDirectory(), () => false);
const exists = async target => fs.access(target).then(() => true, () => false);

// 展示用路径：把当前用户的主目录前缀折叠成 ~，避免页面、报错和截图暴露真实用户名。
// 只影响展示，内部逻辑一律使用绝对路径。同时兼容 / 与 \ 两种分隔符。
function displayPath(value, home = os.homedir()) {
  if (typeof value !== 'string' || !home || !value.startsWith(home)) return value;
  const rest = value.slice(home.length);
  if (rest === '') return '~';
  return /^[\\/]/.test(rest) ? '~' + rest : value;
}

// 校验目标目录能否当作 Codex 配置目录使用。
// 返回规范化后的绝对路径；必要时补齐缺失的 key_config.json。
async function resolveHome(target) {
  if (typeof target !== 'string' || !target.trim()) throw problem('请填写 Codex 目录。', 400);
  if (target.includes('\0')) throw problem('目录路径无效。', 400);
  const resolved = path.resolve(target.trim().replace(/^~(?=[\\/]|$)/, os.homedir()));
  if (!(await isDirectory(resolved))) throw problem(`目录不存在或不是文件夹：${displayPath(resolved)}`, 400);
  // config.toml 是 Codex 配置目录的标志，也是本工具读取 provider 的前提。
  if (!(await exists(path.join(resolved, 'config.toml')))) {
    throw problem(`该目录下没有 config.toml，看起来不是 Codex 配置目录：${displayPath(resolved)}`, 400);
  }
  let created = false;
  if (!(await exists(path.join(resolved, 'key_config.json')))) {
    // 新设备上首次使用时会缺这个文件，缺失会让服务无法启动，这里补一个空列表。
    await atomicWrite(path.join(resolved, 'key_config.json'), '{\n  "keys": []\n}\n');
    created = true;
  }
  return { home: resolved, created };
}

module.exports = { settingsPath, readSettings, writeSettings, resolveHome, displayPath };
