const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');

const run = promisify(execFile);
const LOCAL_HOSTS = ['127.0.0.1', 'localhost', '::1'];

function bypassList(...values) {
  return [...new Set([...values.flatMap(value => (value || '').split(',').map(s => s.trim()).filter(Boolean)), ...LOCAL_HOSTS])].join(',');
}

function launchArguments(app, values) {
  const bypass = bypassList(...values);
  return ['-a', app, '--env', 'NO_PROXY=' + bypass, '--env', 'no_proxy=' + bypass];
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

async function findMacApp() {
  if (process.env.CODEX_APP_PATH) return macAppInfo(path.resolve(process.env.CODEX_APP_PATH));
  for (const app of MAC_APP_CANDIDATES) {
    try { await fs.access(app); return await macAppInfo(app); } catch { /* Try the other app name. */ }
  }
  throw new Error('未找到 Codex 应用。可使用 CODEX_APP_PATH 指定应用位置。');
}

async function macAppRunning(executable) {
  const { stdout } = await run('/bin/ps', ['-axo', 'pid=,comm=']);
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
  await run('/usr/bin/open', args);
}

// -------------------------------------------------------------- Windows

// Codex 桌面应用在 Windows 上没有固定的公开安装位置，这里按常见布局探测。
// 探测失败时可用 CODEX_APP_PATH 直接指向 Codex.exe。
const WIN_APP_CANDIDATES = [
  ['LOCALAPPDATA', 'Programs', 'Codex', 'Codex.exe'],
  ['LOCALAPPDATA', 'Programs', 'ChatGPT', 'ChatGPT.exe'],
  ['LOCALAPPDATA', 'Codex', 'Codex.exe'],
  ['LOCALAPPDATA', 'ChatGPT', 'ChatGPT.exe'],
  ['PROGRAMFILES', 'Codex', 'Codex.exe'],
  ['PROGRAMFILES', 'ChatGPT', 'ChatGPT.exe'],
];

async function findWinApp() {
  if (process.env.CODEX_APP_PATH) {
    const target = path.resolve(process.env.CODEX_APP_PATH);
    const executable = (await fs.stat(target)).isDirectory() ? path.join(target, 'Codex.exe') : target;
    await fs.access(executable);
    return { app: executable, executable };
  }
  for (const segments of WIN_APP_CANDIDATES) {
    const base = process.env[segments[0]];
    if (!base) continue;
    const executable = path.join(base, ...segments.slice(1));
    try { await fs.access(executable); return { app: executable, executable }; } catch { /* Try the next layout. */ }
  }
  throw new Error(
    '未找到 Codex 桌面应用。请设置 CODEX_APP_PATH 指向 Codex.exe；'
    + '如果你使用的是 Codex CLI，无需此入口，在终端设置 NO_PROXY 后直接运行 codex 即可。'
  );
}

async function winAppRunning(executable) {
  const name = path.basename(executable);
  const { stdout } = await run('tasklist', ['/FI', `IMAGENAME eq ${name}`, '/FO', 'CSV', '/NH']);
  return stdout.toLowerCase().includes(`"${name.toLowerCase()}"`);
}

async function winInheritedBypass() {
  const inherited = [];
  // Windows GUI 进程的环境来自用户级环境变量，只读查询，不做修改。
  for (const key of ['NO_PROXY', 'no_proxy']) {
    try {
      const { stdout } = await run('reg', ['query', 'HKCU\\Environment', '/v', key], { timeout: 2000 });
      const match = stdout.match(/REG_(?:SZ|EXPAND_SZ)\s+(.+)/);
      if (match) inherited.push(match[1].trim());
    } catch { /* Unset variable. */ }
  }
  return inherited;
}

function winLaunch(app, bypass) {
  // 直接以注入后的环境变量启动子进程，等价于 macOS 的 `open --env`，
  // 不需要修改系统或用户级环境变量。
  const child = spawn(app.executable, [], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, NO_PROXY: bypass, no_proxy: bypass },
  });
  child.unref();
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

async function launch() {
  const platform = PLATFORMS[process.platform];
  if (!platform) throw new Error('此启动入口仅支持 macOS 和 Windows。');
  if (process.argv.slice(2).some(arg => arg !== '--check')) throw new Error('支持的参数：--check（仅检查，不启动）。');
  const check = process.argv.includes('--check');
  const app = await platform.findApp();
  const running = await platform.isRunning(app.executable);
  if (running && !check) throw new Error(`Codex 正在运行。${platform.quitHint}，再运行此脚本。`);
  const port = Number(process.env.RELAY_UI_PORT || 3790);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('RELAY_UI_PORT 无效。');
  const status = await relayStatus(port);
  if (!status.proxyInstalled || status.mode !== 'proxy') throw new Error('Codex 尚未接入本地代理，请先在管理页面接入。');
  const url = new URL(status.proxyUrl);
  if (url.hostname !== '127.0.0.1' || url.protocol !== 'http:') throw new Error('本地代理地址不符合此启动入口要求。');
  const inherited = await platform.inheritedBypass();
  const bypass = bypassList(process.env.NO_PROXY, process.env.no_proxy, ...inherited);
  if (check) {
    console.log('检查通过：中转服务可用，Codex 已配置本地代理。');
    console.log(running ? 'Codex 当前仍在运行；此检查不会改变现有进程环境。' : 'Codex 已退出，可以启动。');
    console.log('启动时将为 Codex 设置 NO_PROXY / no_proxy，包含 127.0.0.1、localhost、::1。');
    return;
  }
  if (process.platform === 'darwin') await platform.launch(app, launchArguments(app.app, [process.env.NO_PROXY, process.env.no_proxy, ...inherited]));
  else await platform.launch(app, bypass);
  console.log('已请求启动 Codex，本机绕过规则随本次进程生效。');
  console.log('中转服务继续负责上游网络；FlyingBird 和系统代理设置未修改。');
}

if (require.main === module) launch().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { bypassList, launchArguments, relayStatus };
