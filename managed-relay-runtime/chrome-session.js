const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { problem } = require('./config-store');

async function chromePath() {
  const candidates = process.platform === 'darwin'
    ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', path.join(os.homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome')]
    : process.platform === 'win32'
      ? [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean).map(root => path.join(root, 'Google/Chrome/Application/chrome.exe'))
      : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  for (const candidate of candidates) { try { await fs.access(candidate, fs.constants.X_OK); return candidate; } catch {} }
  throw problem('未找到 Google Chrome，请安装后重试。', 400);
}

// Only the dedicated child process can access this pipe; no debugging TCP port is opened.
async function launchSession(signal, { headless = false, size = { width: 1280, height: 800 } } = {}) {
  const executable = await chromePath();
  signal.throwIfAborted();
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-browser-'));
  const child = spawn(executable, ['--no-first-run', '--no-default-browser-check', '--disable-sync', '--remote-debugging-pipe', '--user-data-dir=' + profile,
    ...(headless ? ['--headless=new', '--window-size=' + size.width + ',' + size.height] : []), 'about:blank'],
    { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'], windowsHide: false });
  let closed = false, exited = false, sequence = 0, buffer = '';
  const pending = new Map();
  const listeners = new Set();
  const fail = () => { for (const request of pending.values()) request.reject(new Error('Browser connection closed')); pending.clear(); };
  const exit = new Promise(resolve => {
    child.once('exit', () => { exited = true; fail(); resolve(); });
    child.once('error', () => { exited = true; fail(); resolve(); });
  });
  child.stdio[3].on('error', fail);
  child.stdio[4].on('error', fail);
  child.stdio[4].setEncoding('utf8');
  child.stdio[4].on('data', chunk => {
    buffer += chunk;
    if (buffer.length > 16 * 1024 * 1024) { buffer = ''; fail(); return; }
    let end;
    while ((end = buffer.indexOf('\0')) >= 0) {
      const raw = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      try {
        const message = JSON.parse(raw), waiter = pending.get(message.id);
        if (!waiter) { for (const listener of listeners) listener(message); continue; }
        pending.delete(message.id);
        if (message.error) waiter.reject(new Error('Browser command failed')); else waiter.resolve(message.result);
      } catch { fail(); }
    }
  });
  function command(method, params = {}, sessionId) {
    if (exited || closed) return Promise.reject(new Error('Browser closed'));
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('Browser command timeout')); }, 10000);
      pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
      child.stdio[3].write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
    });
  }
  let closing;
  function close() {
    if (closing) return closing;
    closing = (async () => {
      // Ask Chrome to stop its child processes before deleting their temporary profile.
      if (!exited && child.stdio[3].writable) child.stdio[3].write(JSON.stringify({ id: ++sequence, method: 'Browser.close', params: {} }) + '\0');
      closed = true; signal.removeEventListener('abort', abort); fail();
      const terminateTimer = setTimeout(() => { if (!exited) child.kill('SIGTERM'); }, 1500);
      const killTimer = setTimeout(() => { if (!exited) child.kill('SIGKILL'); }, 3000);
      await exit; clearTimeout(terminateTimer); clearTimeout(killTimer);
      child.stdio[3].destroy(); child.stdio[4].destroy();
      await fs.rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    })();
    return closing;
  }
  const abort = () => { close().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    signal.throwIfAborted();
    await command('Browser.getVersion');
    const { targetInfos } = await command('Target.getTargets');
    const target = targetInfos.find(target => target.type === 'page');
    const targetId = target?.targetId || (await command('Target.createTarget', { url: 'about:blank' })).targetId;
    const { sessionId } = await command('Target.attachToTarget', { targetId, flatten: true });
    return { command, sessionId, targetId, close, onEvent: listener => { listeners.add(listener); return () => listeners.delete(listener); } };
  } catch (error) { await close(); throw error; }
}

module.exports = { launchSession, chromePath };
