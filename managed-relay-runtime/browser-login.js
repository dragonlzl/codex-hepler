const { randomUUID } = require('node:crypto');
const { problem } = require('./config-store');
const { BrowserLoginSurface, viewport } = require('./browser-login-surface');
const { launchSession } = require('./chrome-session');

const LOGIN_URL = 'https://api.aigo0.com/login?redirect=/monitor';
const LIFETIME = 5 * 60000;

async function launchChrome(signal, { presentation = 'window', size = viewport() } = {}) {
  const browser = await launchSession(signal, { headless: presentation === 'embedded', size });
  const { command, sessionId, targetId, close } = browser;
  try {
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
