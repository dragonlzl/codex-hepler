class ProjectedLogin {
  constructor(container, dialog) {
    Object.assign(this, { container, dialog });
    container.innerHTML = '<p class="projected-login-caption">派大星官网登录画面 · 点击画面中的输入框即可输入，支持粘贴；滚轮可翻阅条款。</p>' +
      '<div class="projected-login-stage"><img alt="派大星官网登录页面" draggable="false" />' +
      '<textarea class="projected-login-keyboard" aria-label="官网登录页面键盘输入" autocomplete="off" autocapitalize="none" spellcheck="false"></textarea></div>' +
      '<div class="projected-login-tools"><button type="button" data-key="Tab">下一输入框</button><button type="button" data-key="Backspace">退格</button>' +
      '<button type="button" data-key="Enter">回车</button><button type="button" data-scroll="-450">向上滚动</button><button type="button" data-scroll="450">向下滚动</button><button type="button" data-back hidden>返回登录页</button></div>' +
      '<p class="projected-login-error" role="status"></p>';
    this.image = container.querySelector('img');
    this.keyboard = container.querySelector('textarea');
    this.stage = container.querySelector('.projected-login-stage');
    this.error = container.querySelector('.projected-login-error');
    this.queue = Promise.resolve();
    this.stage.addEventListener('pointerdown', event => {
      if (!this.active || !this.size || event.button !== 0) return;
      event.preventDefault();
      this.keyboard.focus({ preventScroll: true });
      this.pointer = { x: event.clientX, y: event.clientY, id: event.pointerId };
      this.stage.setPointerCapture(event.pointerId);
    });
    this.stage.addEventListener('pointerup', event => {
      const pointer = this.pointer; this.pointer = null;
      if (!pointer || event.pointerId !== pointer.id || !this.size) return;
      const rect = this.image.getBoundingClientRect();
      const x = Math.max(0, Math.min(this.size.width - 1, (pointer.x - rect.left) / rect.width * this.size.width));
      const y = Math.max(0, Math.min(this.size.height - 1, (pointer.y - rect.top) / rect.height * this.size.height));
      const delta = pointer.y - event.clientY;
      this.input(Math.abs(delta) > 12 ? { type: 'scroll', x, y, deltaY: Math.max(-800, Math.min(800, delta * this.size.height / rect.height)) } : { type: 'click', x, y });
    });
    this.stage.addEventListener('pointercancel', () => { this.pointer = null; });
    this.stage.addEventListener('wheel', event => {
      if (!this.active || !this.size) return;
      event.preventDefault();
      const rect = this.image.getBoundingClientRect();
      this.input({ type: 'scroll', x: Math.max(0, Math.min(this.size.width - 1, (event.clientX - rect.left) / rect.width * this.size.width)),
        y: Math.max(0, Math.min(this.size.height - 1, (event.clientY - rect.top) / rect.height * this.size.height)), deltaY: Math.max(-800, Math.min(800, event.deltaY * (event.deltaMode === 1 ? 16 : 1))) });
    }, { passive: false });
    this.keyboard.addEventListener('input', event => {
      if (event.isComposing) return;
      const text = this.keyboard.value; this.keyboard.value = '';
      if (text) this.input({ type: 'text', text });
    });
    this.keyboard.addEventListener('compositionend', () => {
      const text = this.keyboard.value; this.keyboard.value = '';
      if (text) this.input({ type: 'text', text });
    });
    this.keyboard.addEventListener('paste', event => {
      event.preventDefault();
      const text = event.clipboardData.getData('text'); this.keyboard.value = '';
      if (text) this.input({ type: 'text', text });
    });
    this.keyboard.addEventListener('keydown', event => {
      if (event.isComposing) return;
      const key = (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a' ? 'SelectAll' : event.key;
      if (['SelectAll', 'Enter', 'Tab', 'Backspace', 'Delete', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(key)) {
        event.preventDefault(); this.input({ type: 'key', key, shift: event.shiftKey });
      }
    });
    container.querySelector('.projected-login-tools').addEventListener('click', event => {
      const button = event.target.closest('button');
      if (!button || !this.size) return;
      this.keyboard.focus({ preventScroll: true });
      this.input(button.hasAttribute('data-back') ? { type: 'back-to-login' } : button.dataset.key ? { type: 'key', key: button.dataset.key }
        : { type: 'scroll', x: this.size.width / 2, y: this.size.height / 2, deltaY: Number(button.dataset.scroll) });
    });
    this.stop();
  }

  dimensions() { return { width: Math.max(280, Math.min(760, Math.floor(window.innerWidth - 80))), height: Math.max(400, Math.min(780, Math.floor(window.innerHeight - 300))) }; }

  async request(action, payload = {}) {
    const response = await fetch('/api/availability/browser-login/' + action, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: this.id, ...payload }), signal: AbortSignal.any([this.signal, AbortSignal.timeout(12000)]) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '登录画面暂时无法连接。');
    return data;
  }

  enableControls() {
    if (!this.active) return;
    this.keyboard.disabled = false;
    this.container.querySelectorAll('button').forEach(button => { button.disabled = false; });
  }

  start(id, signal) {
    this.stop();
    Object.assign(this, { id, signal, active: true, queue: Promise.resolve() });
    this.container.hidden = false;
    this.dialog.classList.add('has-projected-login');
    this.error.textContent = '正在加载官网登录画面…';
    this.enableControls();
    signal.addEventListener('abort', () => { if (this.signal === signal) this.stop(); }, { once: true });
    this.refresh();
  }

  input(event) {
    if (!this.active) return;
    const signal = this.signal, id = this.id;
    this.queue = this.queue.then(async () => {
      if (!this.active || signal.aborted || id !== this.id) return;
      await this.request('input', { event });
    }).catch(error => { if (this.active && !signal.aborted && id === this.id) this.error.textContent = error.message; });
  }

  async refresh() {
    const signal = this.signal;
    if (!this.active || signal.aborted) return;
    try {
      if (!document.hidden) {
        const frame = await this.request('frame');
        if (!this.active || signal !== this.signal || signal.aborted) return;
        if (frame.mimeType !== 'image/jpeg' || !Number.isInteger(frame.width) || !Number.isInteger(frame.height) || typeof frame.image !== 'string') throw new Error('登录画面格式无效。');
        this.size = { width: frame.width, height: frame.height };
        this.image.src = 'data:image/jpeg;base64,' + frame.image;
        this.image.width = frame.width; this.image.height = frame.height;
        this.image.hidden = false;
        this.container.querySelector('[data-back]').hidden = !frame.showingDocument;
        this.error.textContent = '';
      }
    } catch (error) { if (this.active && signal === this.signal && !signal.aborted) this.error.textContent = error.message; }
    finally { if (this.active && signal === this.signal && !signal.aborted) this.timer = setTimeout(() => this.refresh(), 750); }
  }

  stop() {
    this.active = false; this.size = null; this.pointer = null;
    clearTimeout(this.timer);
    this.container.hidden = true;
    this.dialog.classList.remove('has-projected-login');
    this.image.removeAttribute('src'); this.image.hidden = true;
    this.keyboard.value = ''; this.error.textContent = '';
  }
}
