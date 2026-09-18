const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const { launch, launchContext } = require('./codex-launch');
const { findCli, workingDirectory, psQuote, encodedCommand, powershellPath } = require('./codex-cli-launch');

const run = promisify(execFile);
const shellQuote = value => "'" + String(value).replace(/'/g, "'\\''") + "'";
const isAlive = pid => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
};

async function findITerm({ runCommand = run, access = fs.access } = {}) {
  const candidates = ['/Applications/iTerm.app', '/Applications/iTerm2.app',
    path.join(os.homedir(), 'Applications/iTerm.app'), path.join(os.homedir(), 'Applications/iTerm2.app')];
  for (const candidate of candidates) {
    try { await access(candidate); return candidate; } catch { /* Try another standard installation. */ }
  }
  // Also support installations moved outside Applications, without a disk walk.
  try {
    const { stdout } = await runCommand('/usr/bin/mdfind', ['kMDItemCFBundleIdentifier == "com.googlecode.iterm2"'], { timeout: 3000 });
    for (const candidate of stdout.split('\n').filter(value => value.endsWith('.app'))) {
      try { await access(candidate); return candidate; } catch { /* Stale Spotlight entry. */ }
    }
  } catch { /* Spotlight may be disabled. */ }
  return null;
}

async function openTerminal(job, { platform = process.platform, env = process.env, runCommand = run, spawnProcess = spawn, detectITerm = findITerm } = {}) {
  if (platform === 'darwin') {
    const iterm = await detectITerm({ runCommand });
    let fallback = false;
    if (iterm) {
      try {
        await runCommand('/usr/bin/open', ['-a', iterm], { timeout: 5000 });
        // Pass the command as an AppleScript argument, never interpolate a path
        // into source. iTerm creates a new session, not input in an existing one.
        const script = 'on run argv\n tell application id "com.googlecode.iterm2"\n activate\n create window with default profile command (item 1 of argv)\n end tell\nend run';
        await runCommand('/usr/bin/osascript', ['-e', script, ['/bin/sh', job.command].map(shellQuote).join(' ')], { timeout: 45000 });
        return { terminal: 'iTerm' };
      } catch { fallback = true; }
    }
    // Opening a .command file avoids AppleScript Automation permissions and
    // starts a separate Terminal session without typing into an existing shell.
    await runCommand('/usr/bin/open', ['-a', 'Terminal', job.command], { timeout: 10000 });
    return { terminal: 'Terminal', fallback };
  }
  const ps = powershellPath(env);
  const code = `& ${[process.execPath, path.join(__dirname, 'codex-terminal.js'), job.manifest].map(psQuote).join(' ')}; Write-Host 'Codex CLI session ended.'`;
  const args = ['-NoLogo', '-NoProfile', '-NoExit', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodedCommand(code)];
  try {
    await runCommand('wt.exe', ['-w', 'new', ps, ...args], { timeout: 8000, windowsHide: true });
  } catch {
    await new Promise((resolve, reject) => {
      const child = spawnProcess(ps, args, { detached: true, stdio: 'ignore', windowsHide: false, env });
      child.once('error', reject);
      child.once('spawn', () => { child.unref(); resolve(); });
    });
    return { terminal: 'PowerShell' };
  }
  return { terminal: 'Windows Terminal' };
}

function createLauncher(options = {}) {
  const platform = options.platform || process.platform;
  let launching = false;
  let session = null;
  let lastCli = { state: 'idle' };

  async function snapshot() {
    let cli = lastCli;
    const current = session;
    if (current) {
      try { cli = JSON.parse(await fs.readFile(current.report, 'utf8')); }
      catch { cli = { state: 'pending' }; }
      if (cli.state === 'pending' && Date.now() > current.expiresAt) {
        cli = { state: 'failed', message: '终端未在 90 秒内启动 CLI，请检查终端窗口后重试。' };
        await fs.rm(current.manifest, { force: true });
      }
      if (cli.state === 'running' && !(options.isAlive || isAlive)(cli.pid)) cli = { state: 'exited' };
      if (['exited', 'failed'].includes(cli.state)) {
        await fs.rm(current.dir, { recursive: true, force: true });
        if (session === current) { session = null; lastCli = cli; }
      }
    }
    return { available: ['darwin', 'win32'].includes(platform), busy: launching, cli, defaultCwd: os.homedir() };
  }

  async function start(target, { status, env = process.env, config, cwd } = {}) {
    if (!['app', 'cli'].includes(target)) throw new Error('启动类型无效。');
    if (launching) throw new Error('正在处理启动请求，请稍候。');
    if (!['darwin', 'win32'].includes(platform)) throw new Error('页面启动仅支持 macOS 和 Windows。');
    launching = true;
    try {
      const context = await launchContext({ env, status });
      if (target === 'app') return await (options.launchApp || launch)({ env: context.env, status, config, platform });
      const state = await snapshot();
      if (['pending', 'running'].includes(state.cli.state)) throw new Error('本工具启动的 Codex CLI 正在运行或等待终端打开，请使用已有终端。');
      const executable = await (options.findCli || findCli)({ env: context.env, config, platform });
      const directory = await workingDirectory(cwd || os.homedir());
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-relay-terminal-'));
      await fs.chmod(dir, 0o700);
      const job = { dir, manifest: path.join(dir, 'launch.json'), command: path.join(dir, 'Codex CLI.command'), report: path.join(dir, 'status.json'), expiresAt: Date.now() + 90000 };
      try {
        // Forward launch context, not the relay's entire environment or keys.
        // Terminal also retains its own inherited authentication environment.
        const forwarded = {};
        for (const name of ['PATH', 'Path', 'CODEX_HOME', 'NO_PROXY', 'no_proxy', 'RELAY_UI_PORT', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) {
          if (context.env[name] !== undefined) forwarded[name] = context.env[name];
        }
        forwarded.CODEX_CLI_PATH = executable;
        await fs.writeFile(job.manifest, JSON.stringify({ cwd: directory, env: forwarded, report: job.report, expiresAt: job.expiresAt }), { mode: 0o600 });
        await fs.writeFile(job.command, '#!/bin/sh\n' + [process.execPath, path.join(__dirname, 'codex-terminal.js'), job.manifest].map(shellQuote).join(' ') + '\nprintf "\\nCodex CLI session ended.\\n"\n', { mode: 0o700 });
        session = job;
        lastCli = { state: 'pending' };
        const opened = await (options.openTerminal || openTerminal)(job, { platform, env: context.env });
        const prefix = opened?.fallback ? 'iTerm 未能启动会话，已回退到 Terminal。' : `已请求打开 ${opened?.terminal || '终端'}。`;
        return { message: prefix + 'Codex CLI 将自动启动，请在新终端中操作。', cwd: directory };
      } catch (error) {
        session = null;
        await fs.rm(dir, { recursive: true, force: true });
        throw error;
      }
    } finally { launching = false; }
  }
  return { start, snapshot };
}

module.exports = { createLauncher, openTerminal, findITerm, shellQuote };
