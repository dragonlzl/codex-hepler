const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const { configPath, loadCodexConfig, resolveCodexPaths, configHint, expandPath } = require('./codex-config');

const run = promisify(execFile);
const LOCAL_HOSTS = ['127.0.0.1', 'localhost', '::1'];

function bypassList(...values) {
  return [...new Set([...values.flatMap(value => (value || '').split(',').map(s => s.trim()).filter(Boolean)), ...LOCAL_HOSTS])].join(',');
}

function launchArguments(app, values, home) {
  const bypass = bypassList(...values);
  return ['-a', app, '--env', 'NO_PROXY=' + bypass, '--env', 'no_proxy=' + bypass,
    ...(home ? ['--env', 'CODEX_HOME=' + home] : [])];
}

// ---------------------------------------------------------------- macOS

const MAC_APP_CANDIDATES = ['/Applications/ChatGPT.app', '/Applications/Codex.app'];

async function macAppInfo(app) {
  const info = path.join(app, 'Contents', 'Info.plist');
  const id = (await run('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', info])).stdout.trim();
  if (id !== 'com.openai.codex') throw new Error('指定的应用不是 Codex。');
  const executable = (await run('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleExecutable', info])).stdout.trim();
  return { app, executable: path.join(app, 'Contents', 'MacOS', executable) };
}

// 路径写错时给一句人能看懂的提示，而不是 PlistBuddy／ENOENT 的原始报错。
async function macAppInfoOrExplain(app, env, config) {
  try {
    return await macAppInfo(app);
  } catch {
    const source = config && resolveCodexPaths({ env, config }).appSource === 'env'
      ? 'CODEX_APP_PATH 环境变量' : `配置文件 ${configPath(env)} 里的 codexAppPath`;
    throw new Error(`指定的 Codex 应用不可用：${app}。请确认该目录存在且是 Codex 的 .app（检查 ${source}）。`);
  }
}

// config 传入对象（可为空对象）时以它为准，传 null 才读磁盘上的 JSON 配置文件。
// 这样调用方和测试都能完全绕过配置文件。
async function findMacApp(options = {}) {
  const { env = process.env, config = null, access = fs.access } = options;
  const fileConfig = config !== null ? config : loadCodexConfig(configPath(env));
  const explicit = resolveCodexPaths({ env, config: fileConfig }).appPath;
  if (explicit) return macAppInfoOrExplain(explicit, env, fileConfig);
  for (const app of MAC_APP_CANDIDATES) {
    try { await access(app); return await macAppInfo(app); } catch { /* Try the other app name. */ }
  }
  throw new Error('未找到 Codex 应用。可使用 CODEX_APP_PATH 指定应用位置，' + configHint(env));
}

async function macAppRunning(executable) {
  const { stdout } = await run('/bin/ps', ['-axo', 'pid=,comm='], { timeout: 5000 });
  return stdout.split('\n').some(line => line.trim().replace(/^\d+\s+/, '') === executable);
}

async function macInheritedBypass() {
  const inherited = [];
  // Preserve GUI-session exclusions without changing launchd's environment.
  for (const key of ['NO_PROXY', 'no_proxy']) {
    try { inherited.push((await run('/bin/launchctl', ['getenv', key], { timeout: 2000 })).stdout.trim()); } catch { /* Unset variable. */ }
  }
  return inherited;
}

async function macLaunch(app, args) {
  await run('/usr/bin/open', args, { timeout: 10000 });
}

// -------------------------------------------------------------- Windows

// Codex 桌面应用在 Windows 上没有固定的公开安装位置，这里按常见布局探测。
// 也可以设置 CODEX_APP_PATH，或在项目 JSON 配置文件里填 codexAppPath，
// 指向 ChatGPT.exe、Codex.exe 本身或它所在的目录。
// 默认优先 ChatGPT.exe，兼容旧版 Codex.exe；完整文件路径保留指定的文件名。
const WIN_APP_NAMES = ['ChatGPT.exe', 'Codex.exe'];
const WIN_APP_DIRECTORIES = [
  ['LOCALAPPDATA', 'Programs', 'ChatGPT'],
  ['LOCALAPPDATA', 'ChatGPT'],
  ['PROGRAMFILES', 'ChatGPT'],
  ['LOCALAPPDATA', 'Programs', 'Codex'],
  ['LOCALAPPDATA', 'Codex'],
  ['PROGRAMFILES', 'Codex'],
];
const WIN_APPX_PACKAGE_NAME = 'OpenAI.Codex';

// 只替换 WindowsApps 中 OpenAI.Codex 的包目录，不递归扫描磁盘。
// 同时兼容 OpenAI.Codex_<版本>_x64__<发布者>\app 和分层的
// OpenAI.Codex\_<版本>\_x64\_\_<发布者>\app；后者保留版本之后的目录结构。
function winAppUpdatePattern(explicit) {
  const normalized = path.win32.normalize(explicit).replace(/\\+$/, '');
  const filename = path.win32.basename(normalized);
  const isExecutable = WIN_APP_NAMES.some(name => name.toLowerCase() === filename.toLowerCase());
  const directory = isExecutable ? path.win32.dirname(normalized) : normalized;
  if (path.win32.basename(directory).toLowerCase() !== 'app') return null;
  const segments = directory.split('\\');
  const windowsApps = segments.findIndex(segment => segment.toLowerCase() === 'windowsapps');
  if (windowsApps < 0) return null;
  let index = windowsApps + 1;
  let prefix = 'OpenAI.Codex_';
  if (segments[index]?.toLowerCase() === 'openai.codex') {
    index += 1;
    prefix = '_';
  }
  if (!segments[index]?.toLowerCase().startsWith(prefix.toLowerCase()) || segments[index].length <= prefix.length) return null;
  return {
    parent: segments.slice(0, index).join('\\'),
    prefix: prefix.toLowerCase(),
    suffix: segments.slice(index + 1),
    names: isExecutable ? [filename] : WIN_APP_NAMES,
  };
}

function normalizeWinPath(value) {
  return path.win32.normalize(value).replace(/\\+$/, '');
}

function registeredPackageCandidates(pattern, location) {
  const install = normalizeWinPath(location);
  const suffix = pattern.suffix;
  const basename = path.win32.basename(install).toLowerCase();
  if (basename !== 'app' && !basename.startsWith(pattern.prefix) && !basename.startsWith('_') && !basename.startsWith('openai.codex_')) return [];
  const candidates = [];
  if (basename === 'app') candidates.push(install);
  else if (basename.startsWith('_') && suffix.length) candidates.push(path.win32.join(install, ...suffix));
  // Get-AppxPackage normally reports the package root. Some OpenAI.Codex builds
  // report the app directory instead, so support both layouts without listing
  // WindowsApps itself. The registered package name is the identity check.
  candidates.push(path.win32.join(install, 'app'));
  if (suffix.length) candidates.push(path.win32.join(install, ...suffix));
  candidates.push(install);
  return [...new Set(candidates.flatMap(candidate => pattern.names.map(name => path.win32.join(candidate, name))))];
}

async function listRegisteredWinAppLocations({ platform = process.platform, runCommand = run } = {}) {
  if (platform !== 'win32') return [];
  const command = `$ErrorActionPreference='Stop'; Get-AppxPackage -Name '${WIN_APPX_PACKAGE_NAME}' | ForEach-Object { $_.InstallLocation }`;
  const { stdout } = await runCommand('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command,
  ], { timeout: 5000, windowsHide: true });
  return [...new Set(stdout.split(/\r?\n/).map(value => value.trim()).filter(Boolean))];
}

async function findRegisteredWinApp(explicit, { platform = process.platform, env = process.env, access = fs.access, stat = fs.stat, packageLocations, runCommand = run } = {}) {
  const pattern = winAppUpdatePattern(explicit);
  if (!pattern) return null;
  let locations;
  try {
    locations = packageLocations === undefined
      ? await listRegisteredWinAppLocations({ platform, runCommand })
      : typeof packageLocations === 'function' ? await packageLocations({ env, explicit, pattern }) : packageLocations;
  } catch {
    return null;
  }
  const matches = [];
  for (const location of locations || []) {
    for (const executable of registeredPackageCandidates(pattern, location)) {
      try {
        const info = await stat(executable);
        if (!info.isFile()) continue;
        await access(executable);
        matches.push({ app: executable, executable });
        break;
      } catch (error) {
        // WindowsApps may deny metadata access even though the registered package can be launched.
        // Trust the package registration for this specific EACCES/EPERM case.
        if (error && (error.code === 'EACCES' || error.code === 'EPERM')) {
          matches.push({ app: executable, executable });
          break;
        }
      }
    }
  }
  const unique = [...new Map(matches.map(match => [match.executable.toLowerCase(), match])).values()];
  if (unique.length > 1) {
    const candidates = unique.map(match => match.executable).sort().join('\n');
    throw new Error(`原应用路径已失效，但找到多个已注册的 WindowsApps 安装目录，请选择一个并更新应用路径：\n${candidates}`);
  }
  return unique[0] || null;
}

async function findUpdatedWinApp(explicit, { platform = process.platform, env = process.env, access = fs.access, stat = fs.stat, readdir = fs.readdir, packageLocations, runCommand = run } = {}) {
  const pattern = winAppUpdatePattern(explicit);
  if (!pattern) return null;
  const registered = await findRegisteredWinApp(explicit, { platform, env, access, stat, packageLocations, runCommand });
  if (registered) return registered;
  let entries;
  try { entries = await readdir(pattern.parent, { withFileTypes: true }); }
  catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
    throw new Error(`无法读取 WindowsApps 安装目录：${pattern.parent}。请检查访问权限。`);
  }
  const matches = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.toLowerCase().startsWith(pattern.prefix) || entry.name.length <= pattern.prefix.length) continue;
    for (const name of pattern.names) {
      const executable = path.win32.join(pattern.parent, entry.name, ...pattern.suffix, name);
      try {
        if (!(await stat(executable)).isFile()) continue;
        await access(executable);
        matches.push({ app: executable, executable });
        break;
      } catch { /* 更新残留或不可访问的安装包不能作为启动目标。 */ }
    }
  }
  if (matches.length > 1) {
    const candidates = matches.map(match => match.executable).sort().join('\n');
    throw new Error(`原应用路径已失效，但找到多个可用的 WindowsApps 安装目录，请选择一个并更新应用路径：\n${candidates}`);
  }
  return matches[0] || null;
}

async function findWinApp(options = {}) {
  const { env = process.env, config = null, platform = process.platform, access = fs.access, stat = fs.stat, readdir = fs.readdir, packageLocations, runCommand = run } = options;
  const fileConfig = config !== null ? config : loadCodexConfig(configPath(env));
  const explicit = resolveCodexPaths({ env, config: fileConfig }).appPath;
  if (explicit) {
    // 路径写错时给出可操作的提示，而不是裸的 ENOENT。
    const source = resolveCodexPaths({ env, config: fileConfig }).appSource === 'env'
      ? 'CODEX_APP_PATH 环境变量' : `配置文件 ${configPath(env)} 里的 codexAppPath`;
    try {
      const candidates = (await stat(explicit)).isDirectory()
        ? WIN_APP_NAMES.map(name => path.win32.join(explicit, name))
        : [explicit];
      for (const executable of candidates) {
        try { await access(executable); return { app: executable, executable }; } catch { /* Try the other executable name. */ }
      }
    } catch { /* Explain an unavailable explicit path below. */ }
    const updated = await findUpdatedWinApp(explicit, { platform, env, access, stat, readdir, packageLocations, runCommand });
    if (updated) return updated;
    const updateHint = winAppUpdatePattern(explicit) ? '已按 WindowsApps 安装包目录特征及系统已注册应用查找，未找到可用的替代版本。' : '';
    throw new Error(`指定的 Codex 应用不可用：${explicit}。${updateHint}请确认路径存在，指向 ChatGPT.exe、Codex.exe 或包含其中之一的目录（检查 ${source}）。`);
  }
  // 先在所有候选目录找 ChatGPT.exe，再回退 Codex.exe，避免旧安装抢先命中。
  for (const name of WIN_APP_NAMES) {
    for (const segments of WIN_APP_DIRECTORIES) {
      const base = env[segments[0]];
      if (!base) continue;
      const executable = path.win32.join(base, ...segments.slice(1), name);
      try { await access(executable); return { app: executable, executable }; } catch { /* Try the next layout. */ }
    }
  }
  throw new Error(
    '未找到 Codex 桌面应用。请设置 CODEX_APP_PATH 指向 ChatGPT.exe、Codex.exe 或它所在的目录，'
    + `或编辑配置文件 ${configPath(env)} 填写 codexAppPath；`
    + '如果你使用的是 Codex CLI，无需此入口，在终端设置 NO_PROXY 后直接运行 codex 即可。'
  );
}

async function winAppRunning(executable) {
  const name = path.basename(executable);
  const { stdout } = await run('tasklist', ['/FI', `IMAGENAME eq ${name}`, '/FO', 'CSV', '/NH'], { timeout: 5000, windowsHide: true });
  return stdout.toLowerCase().includes(`"${name.toLowerCase()}"`);
}

async function winInheritedBypass(env = process.env) {
  const inherited = [];
  // Windows GUI 进程的环境来自用户级环境变量，只读查询，不做修改。
  for (const key of ['NO_PROXY', 'no_proxy']) {
    if (env[key]) { inherited.push(env[key]); continue; }
    try {
      const { stdout } = await run('reg', ['query', 'HKCU\\Environment', '/v', key], { timeout: 2000 });
      const match = stdout.match(/REG_(?:SZ|EXPAND_SZ)\s+(.+)/);
      if (match) inherited.push(match[1].trim());
    } catch { /* Unset variable. */ }
  }
  return inherited;
}

function winLaunch(app, env) {
  // 直接以注入后的环境变量启动子进程，等价于 macOS 的 `open --env`，
  // 不需要修改系统或用户级环境变量。
  return new Promise((resolve, reject) => {
    const child = spawn(app.executable, [], { detached: true, stdio: 'ignore', env });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}

// ----------------------------------------------------------------- main

function relayStatus(port) {
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: '127.0.0.1', port, path: '/api/status', agent: false }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => {
        body += chunk;
        if (body.length > 256 * 1024) req.destroy(new Error('中转服务状态响应过大。'));
      });
      res.on('error', reject);
      res.on('end', () => {
        try { if (res.statusCode !== 200) throw new Error(); resolve(JSON.parse(body)); }
        catch { reject(new Error('中转服务状态不可用。')); }
      });
    });
    const timer = setTimeout(() => req.destroy(new Error('中转服务未响应，请先启动中转服务。')), 5000);
    req.on('error', reject);
    req.on('close', () => clearTimeout(timer));
  });
}

const PLATFORMS = {
  darwin: { name: 'macOS', findApp: findMacApp, isRunning: macAppRunning, inheritedBypass: macInheritedBypass, launch: macLaunch,
    quitHint: '请在本轮回复结束后用 Cmd+Q 完全退出' },
  win32: { name: 'Windows', findApp: findWinApp, isRunning: winAppRunning, inheritedBypass: winInheritedBypass, launch: winLaunch,
    quitHint: '请在本轮回复结束后从托盘完全退出' },
};

// 配置文件是可选的：存在就把来源写进日志，方便用户确认到底读了哪个文件。
function describeConfig(env = process.env, config = null) {
  const fileConfig = config !== null ? config : loadCodexConfig(configPath(env));
  const resolved = resolveCodexPaths({ env, config: fileConfig });
  const fields = [
    resolved.appPath ? `codexAppPath=${resolved.appPath}（来自${resolved.appSource === 'env' ? '环境变量' : '配置文件'}）` : null,
    resolved.home ? `codexHome=${resolved.home}（来自${resolved.homeSource === 'env' ? '环境变量' : '配置文件'}）` : null,
  ].filter(Boolean);
  if (!fields.length) return null;
  return `配置文件 ${resolved.configFile}：${fields.join('；')}`;
}

async function launch(options = {}) {
  const env = options.env || process.env;
  const argv = options.argv || [];
  const platformName = options.platform || process.platform;
  const platform = options.adapter || PLATFORMS[platformName];
  if (!platform) throw new Error('此启动入口仅支持 macOS 和 Windows。');
  if (argv.some(arg => arg !== '--check')) throw new Error('支持的参数：--check（仅检查，不启动）。');
  const check = argv.includes('--check');
  const context = await launchContext({ ...options, env });
  const app = await platform.findApp({ env, config: options.config });
  const running = await platform.isRunning(app.executable);
  if (running && !check) throw new Error(`Codex App 正在运行。${platform.quitHint}，再点击启动或运行启动脚本。`);
  const inherited = await platform.inheritedBypass(env);
  const bypass = bypassList(context.env.NO_PROXY, context.env.no_proxy, ...inherited);
  const childEnv = { ...context.env, NO_PROXY: bypass, no_proxy: bypass };
  if (check) {
    return { message: `检查通过：中转服务可用，Codex 已配置本地代理。${running ? 'Codex 当前仍在运行；启动前请完全退出。' : 'Codex 已退出，可以启动。'}`, executable: app.executable, home: context.home };
  }
  if (platformName === 'darwin') await platform.launch(app, launchArguments(app.app, [bypass], context.home));
  else await platform.launch(app, childEnv);
  return { message: '已请求启动 Codex App，本机绕过规则随本次进程生效。', executable: app.executable, home: context.home };
}

// 以管理服务当前目录为准，避免页面检查的是 A 目录、启动却读 B 目录。
async function launchContext({ env = process.env, status, getStatus = relayStatus } = {}) {
  const port = Number(env.RELAY_UI_PORT || 3790);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('RELAY_UI_PORT 无效。');
  const current = status || await getStatus(port);
  if (!current.proxyInstalled || current.mode !== 'proxy') throw new Error('Codex 尚未接入本地代理，请先在管理页面接入。');
  if (current.writeBlocked) throw new Error('存在未完成的配置写入，请先恢复配置后再启动。');
  if (!current.selectedProxyName) throw new Error('请先选择一个中转站。');
  const url = new URL(current.proxyUrl);
  if (url.hostname !== '127.0.0.1' || url.protocol !== 'http:') throw new Error('本地代理地址不符合此启动入口要求。');
  const home = expandPath(current.home, env);
  if (!home) throw new Error('管理服务未返回 Codex 配置目录，请重启中转服务。');
  const explicit = expandPath(env.CODEX_HOME, env);
  const canonical = async value => {
    const resolved = await fs.realpath(value).catch(() => path.resolve(value));
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  if (explicit && await canonical(explicit) !== await canonical(home)) throw new Error('CODEX_HOME 与管理页面的配置目录不同，请保持一致后再启动。');
  const bypass = bypassList(env.NO_PROXY, env.no_proxy);
  return { home, status: current, env: { ...env, CODEX_HOME: home, NO_PROXY: bypass, no_proxy: bypass } };
}

if (require.main === module) launch({ argv: process.argv.slice(2) }).then(result => {
  const description = describeConfig();
  if (description) console.log(description);
  console.log(result.message);
  console.log('应用：' + result.executable);
  console.log('Codex 配置目录：' + result.home);
}).catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { bypassList, launchArguments, relayStatus, launchContext, findWinApp, findUpdatedWinApp, findRegisteredWinApp, listRegisteredWinAppLocations, findMacApp, describeConfig, launch };
