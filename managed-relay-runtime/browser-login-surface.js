const { problem } = require('./config-store');

const ORIGIN = 'https://api.aigo0.com';
const KEYS = {
  Enter: ['Enter', 13], Tab: ['Tab', 9], Escape: ['Escape', 27], Backspace: ['Backspace', 8], Delete: ['Delete', 46],
  ArrowLeft: ['ArrowLeft', 37], ArrowUp: ['ArrowUp', 38], ArrowRight: ['ArrowRight', 39], ArrowDown: ['ArrowDown', 40],
  Home: ['Home', 36], End: ['End', 35], PageUp: ['PageUp', 33], PageDown: ['PageDown', 34],
};

function viewport(value = {}) {
  const width = value.width ?? 760, height = value.height ?? 780;
  if (!Number.isInteger(width) || width < 280 || width > 1000 || !Number.isInteger(height) || height < 400 || height > 1000) throw problem('登录画面尺寸无效。', 400);
  return { width, height };
}

// A closed set of input actions; callers cannot submit CDP commands, URLs or JavaScript.
function inputCommands(event, size) {
  if (!event || typeof event !== 'object') throw problem('登录画面操作无效。', 400);
  if (event.type === 'text') {
    if (typeof event.text !== 'string' || !event.text || event.text.length > 4096 || /[\u0000-\u0008\u000b-\u001f]/.test(event.text)) throw problem('输入内容无效或过长。', 400);
    return [['Input.insertText', { text: event.text }]];
  }
  if (event.type === 'key') {
    if (event.key === 'SelectAll') return [['Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: process.platform === 'darwin' ? 4 : 2, commands: ['selectAll'] }],
      ['Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 }]];
    if (!Object.hasOwn(KEYS, event.key) || (event.shift !== undefined && typeof event.shift !== 'boolean')) throw problem('不支持该登录按键。', 400);
    const [code, value] = KEYS[event.key], params = { key: event.key, code, windowsVirtualKeyCode: value, modifiers: event.shift ? 8 : 0 };
    return [['Input.dispatchKeyEvent', { ...params, type: event.key === 'Enter' ? 'keyDown' : 'rawKeyDown', ...(event.key === 'Enter' ? { text: '\r' } : {}) }],
      ['Input.dispatchKeyEvent', { ...params, type: 'keyUp' }]];
  }
  const { x, y } = event;
  if (![x, y].every(Number.isFinite) || x < 0 || x >= size.width || y < 0 || y >= size.height) throw problem('登录画面坐标已变化，请重试。', 400);
  if (event.type === 'click') return [['Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', buttons: 1, clickCount: 1, x, y }],
    ['Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', buttons: 0, clickCount: 1, x, y }]];
  if (event.type === 'scroll') {
    if (!Number.isFinite(event.deltaY) || Math.abs(event.deltaY) > 800) throw problem('滚动距离无效。', 400);
    return [['Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: event.deltaY }]];
  }
  throw problem('不支持该登录画面操作。', 400);
}

class BrowserLoginSurface {
  constructor(command, sessionId, size, targetId) {
    Object.assign(this, { command, sessionId, size, targetId });
    this.loginSessionId = sessionId;
    this.documentTarget = null;
    this.queue = Promise.resolve();
    this.pending = 0;
    this.framePending = null;
  }

  async setup() {
    await this.command('Emulation.setDeviceMetricsOverride', { ...this.size, deviceScaleFactor: 1, mobile: false }, this.sessionId);
  }

  async checkOrigin() {
    const result = await this.command('Runtime.evaluate', { expression: 'location.origin', returnByValue: true }, this.sessionId);
    if (result?.result?.value !== ORIGIN) throw problem('官网登录页面尚未就绪或无法访问，请稍后重试；可改用独立 Chrome 窗口登录。', 400);
  }

  async syncDocument() {
    if (!this.targetId) return;
    const { targetInfos } = await this.command('Target.getTargets');
    const document = targetInfos.find(target => target.type === 'page' && target.targetId !== this.targetId && target.url.startsWith(ORIGIN + '/legal/'));
    if (!document) { this.documentTarget = null; this.sessionId = this.loginSessionId; return; }
    if (this.documentTarget === document.targetId) return;
    this.documentTarget = document.targetId;
    this.sessionId = (await this.command('Target.attachToTarget', { targetId: document.targetId, flatten: true })).sessionId;
    await this.setup();
  }

  serialize(action) {
    if (this.pending >= 40) return Promise.reject(problem('操作过快，请稍候。', 429));
    this.pending++;
    const result = this.queue.then(action);
    this.queue = result.catch(() => {}).finally(() => { this.pending--; });
    return result;
  }

  frame() {
    if (this.framePending) return this.framePending;
    this.framePending = this.serialize(async () => {
      await this.syncDocument();
      await this.checkOrigin();
      const { data } = await this.command('Page.captureScreenshot', { format: 'jpeg', quality: 75, fromSurface: true, captureBeyondViewport: false }, this.sessionId);
      if (typeof data !== 'string' || data.length > 1000000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) throw problem('登录画面暂时无法加载，请重试。', 502);
      return { ...this.size, image: data, mimeType: 'image/jpeg', showingDocument: Boolean(this.documentTarget) };
    }).finally(() => { this.framePending = null; });
    return this.framePending;
  }

  input(event) {
    if (event?.type === 'back-to-login') return this.serialize(async () => {
      if (this.targetId) {
        const { targetInfos } = await this.command('Target.getTargets');
        for (const target of targetInfos.filter(target => target.type === 'page' && target.targetId !== this.targetId && target.url.startsWith(ORIGIN + '/legal/'))) {
          await this.command('Target.closeTarget', { targetId: target.targetId });
        }
      }
      this.documentTarget = null; this.sessionId = this.loginSessionId;
      return { accepted: true };
    });
    const commands = inputCommands(event, this.size);
    return this.serialize(async () => {
      await this.checkOrigin();
      for (const [method, params] of commands) await this.command(method, params, this.sessionId);
      return { accepted: true };
    });
  }
}

module.exports = { BrowserLoginSurface, viewport, inputCommands };
