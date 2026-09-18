const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { atomicWrite, problem } = require('./config-store');
const { parseLooseJson, expandPath } = require('./codex-config');
const { findUpdatedWinApp } = require('./codex-launch');

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

// JSON 提供目录时，页面修改写回同一份配置，避免重启后被旧 codexHome 覆盖。
// 每次读取最新内容，保留应用路径、注释及未知字段；损坏的文件不能被空配置覆盖。
async function writeToolConfig(file, patch, { create = false } = {}) {
  let source;
  try { source = await fs.readFile(file, 'utf8'); }
  catch (error) {
    if (create && error.code === 'ENOENT') source = '{}';
    else throw problem('无法读取 JSON 配置，请检查文件是否存在及访问权限。');
  }
  const config = parseLooseJson(source);
  if (!config) throw problem('JSON 配置已损坏，未进行修改。请先修正配置文件。');
  Object.assign(config, patch);
  for (const [name, alias] of [['codexHome', 'codex_home'], ['codexAppPath', 'codex_app_path']]) {
    if (Object.hasOwn(patch, name) && Object.hasOwn(config, alias)) config[alias] = patch[name];
  }
  try {
    if (create) await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await atomicWrite(file, `${JSON.stringify(config, null, 2)}\n`);
  } catch { throw problem('无法保存 JSON 配置，请检查配置文件及所在目录的写入权限。', 500); }
}

const writeConfigHome = (file, home) => writeToolConfig(file, { codexHome: home });
const writeConfigAppPath = (file, appPath) => writeToolConfig(file, { codexAppPath: appPath }, { create: true });

async function resolveAppPath(target, { platform = process.platform, stat = fs.stat, access = fs.access, readdir = fs.readdir } = {}) {
  if (typeof target !== 'string' || target.includes('\0')) throw problem('请填写有效的 ChatGPT 应用路径。', 400);
  const resolved = expandPath(target);
  if (!resolved) return null;
  const info = await stat(resolved).catch(() => null);
  if (!info || (!info.isFile() && !info.isDirectory())) {
    // 更新后重新保存旧路径也可通过校验；保留原值作为以后启动时的查找依据。
    if (platform === 'win32') {
      try { if (await findUpdatedWinApp(resolved, { stat, access, readdir })) return resolved; }
      catch (error) { throw problem(error.message, 400); }
    }
    throw problem('应用路径不存在或不可访问，请填写可执行文件或应用所在目录。', 400);
  }
  return resolved;
}

const isDirectory = async target => fs.stat(target).then(stat => stat.isDirectory(), () => false);
const exists = async target => fs.access(target).then(() => true, () => false);

// 默认引导和报错用路径：把当前用户的主目录前缀折叠成 ~。
// 用户已配置的目录直接显示完整路径，便于核对；同时兼容 / 与 \ 两种分隔符。
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

module.exports = { settingsPath, readSettings, writeSettings, writeConfigHome, writeConfigAppPath, resolveAppPath, resolveHome, displayPath };
