const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { problem } = require('./config-store');
const { BrowserLoginSurface, viewport } = require('./browser-login-surface');

const LOGIN_URL = 'https://api.aigo0.com/login?redirect=/monitor';
const LIFETIME = 5 * 60000;

async function chromePath() {
  const candidates = process.platform === 'darwin'
    ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', path.join(os.homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome')]
    : process.platform === 'win32'
      ? [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean).map(root => path.join(root, 'Google/Chrome/Application/chrome.exe'))
      : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  for (const candidate of candidates) { try { await fs.access(candidate, fs.constants.X_OK); return candidate; } catch {} }
  throw problem('未找到 Google Chrome，请安装后重试，或使用下方手动 auth_token 授权。', 400);
}

// Only the dedicated child process can access this pipe; no debugging TCP port is opened.
async function launchChrome(signal, { presentation = 'window', size = viewport() } = {}) {
  const executable = await chromePath();
  signal.throwIfAborted();
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-aigo-login-'));
  const child = spawn(executable, ['--no-first-run', '--no-default-browser-check', '--disable-sync', '--remote-debugging-pipe', '--user-data-dir=' + profile,
    ...(presentation === 'embedded' ? ['--headless=new', '--window-size=' + size.width + ',' + size.height] : []), 'about:blank'],
    { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'], windowsHide: false });
  let closed = false, exited = false, sequence = 0, buffer = '';
  const pending = new Map();
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
    if (buffer.length > 1024 * 1024) { buffer = ''; fail(); return; }
    let end;
    while ((end = buffer.indexOf('\0')) >= 0) {
      const raw = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      try {
        const message = JSON.parse(raw), waiter = pending.get(message.id);
        if (!waiter) continue;
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
    const surface = presentation === 'embedded' ? new BrowserLoginSurface(command, sessionId, size, targetId) : null;
    await surface?.setup();
    await command('Page.navigate', { url: LOGIN_URL }, sessionId);
    if (!surface) await command('Page.bringToFront', {}, sessionId);
    return { close, ...(surface ? { frame: () => surface.frame(), input: event => surface.input(event) } : {}), readToken: async () => {
      signal.throwIfAborted();
      const result = await command('Runtime.evaluate', {
        expression: 'location.origin === "https://api.aigo0.com" ? localStorage.getItem("auth_token") : null', returnByValue: true,
      }, sessionId);
      const value = result?.result?.value;
      return typeof value === 'string' && value.length <= 16000 ? value : null;
    } };
  } catch {
    await close();
    throw problem('无法打开登录窗口，或窗口已关闭。请重试，也可使用手动 auth_token 授权。', 400);
  }
}

class BrowserLogin {
  constructor({ launch = launchChrome, lifetime = LIFETIME, interval = 1000 } = {}) {
    Object.assign(this, { launch, lifetime, interval });
    this.sessions = new Map();
    this.closed = false;
  }

  async start(scope, complete, options = {}) {
    const presentation = options.presentation ?? 'window';
    if (!['window', 'embedded'].includes(presentation)) throw problem('登录方式无效。', 400);
    const size = viewport(options.viewport);
    if (this.closed) throw problem('服务已关闭。', 409);
    if ([...this.sessions.values()].some(session => session.scope === scope && session.state === 'pending')) throw problem('该账号已有登录窗口，请先完成或取消。', 409);
    if ([...this.sessions.values()].filter(session => session.state === 'pending').length >= 3) throw problem('请先完成已打开的登录窗口。', 409);
    const session = { id: randomUUID(), scope, presentation, state: 'pending', controller: new AbortController() };
    this.sessions.set(session.id, session);
    session.timeout = setTimeout(() => this.finish(session, 'error', { message: '登录窗口已超时，请重新打开。' }), this.lifetime);
    try { session.browser = await this.launch(session.controller.signal, { presentation, size }); }
    catch (error) { this.finish(session, 'error', { message: '无法打开登录窗口，请重试或手动授权。' }); throw error; }
    if (session.state !== 'pending') { await session.browser.close(); throw problem('登录已取消，请重试。', 409); }
    const poll = async () => {
      if (session.state !== 'pending') return;
      try {
        const token = await session.browser.readToken();
        if (token) {
          const result = await complete(token, session.controller.signal);
          if (session.state === 'pending') this.finish(session, 'success', result);
          return;
        }
      } catch (error) {
        this.finish(session, 'error', { message: error.status ? error.message : '登录窗口已关闭或连接中断，请重新登录。' });
        return;
      }
      if (session.state === 'pending') session.timer = setTimeout(poll, this.interval);
    };
    session.timer = setTimeout(poll, this.interval);
    return { browserLoginId: session.id, presentation, message: presentation === 'embedded'
      ? '请在下方官网画面中确认条款、输入账号密码并完成人机验证。登录成功后自动保存授权。'
      : '请在新打开的 Chrome 窗口中登录并完成人机验证，成功后将自动关闭。' };
  }

  finish(session, state, result) {
    if (session.state !== 'pending') return;
    session.state = state; session.result = result;
    clearTimeout(session.timeout); clearTimeout(session.timer);
    session.controller.abort();
    session.cleanup = session.browser?.close().catch(() => {});
    session.expiry = setTimeout(() => this.sessions.delete(session.id), 60000);
    session.expiry.unref();
  }

  status(id) {
    const session = this.sessions.get(id);
    if (!session) throw problem('登录会话已失效，请重新登录。', 410);
    return { state: session.state, ...(session.result || {}) };
  }

  async surface(id, event) {
    const session = this.sessions.get(id);
    if (!session || session.state !== 'pending') throw problem('登录会话已结束，请重新登录。', 410);
    if (session.presentation !== 'embedded' || !session.browser?.frame) throw problem('该登录会话不支持页面内操作。', 400);
    try { return event === undefined ? await session.browser.frame() : await session.browser.input(event); }
    catch (error) {
      if (error.status) throw error;
      throw problem('登录画面连接中断，请重试或改用独立 Chrome 窗口登录。', 502);
    }
  }

  cancel(id) {
    const session = this.sessions.get(id);
    if (session) this.finish(session, 'cancelled', { message: '已取消浏览器登录。' });
    return { message: '已取消浏览器登录。' };
  }

  async close() {
    this.closed = true;
    for (const session of this.sessions.values()) { this.cancel(session.id); clearTimeout(session.expiry); }
    await Promise.allSettled([...this.sessions.values()].map(session => session.cleanup));
    this.sessions.clear();
  }
}

module.exports = { BrowserLogin, launchChrome, LOGIN_URL };
