class MonitorAuthorization {
  constructor(onAuthorized) {
    this.dialog = document.querySelector('#monitor-auth-dialog');
    this.form = document.querySelector('#monitor-auth-form');
    this.feedback = document.querySelector('#monitor-auth-feedback');
    this.toast = document.querySelector('#monitor-auth-toast');
    this.toastTimer = null;
    this.loginFields = document.querySelector('#monitor-login-fields');
    this.otpFields = document.querySelector('#monitor-otp-fields');
    this.submit = document.querySelector('#monitor-auth-submit');
    this.tokenSubmit = document.querySelector('#monitor-token-submit');
    this.back = document.querySelector('#monitor-auth-back');
    this.onAuthorized = onAuthorized;
    this.busy = false;
    this.challengeId = null;
    this.browserLoginId = null;
    this.browserController = null;
    this.projection = new ProjectedLogin(document.querySelector('#monitor-projected-login'), this.dialog);
    this.site = 'blackaicoding';
    this.packyChallenge = new PackyLoginChallenge();
    this.form.addEventListener('submit', event => { event.preventDefault(); this.login(); });
    document.querySelector('#monitor-browser-fallback button').addEventListener('click', () => { if (!this.busy) this.loginInBrowser('window'); });
    this.tokenSubmit.addEventListener('click', () => this.authorizeToken());
    this.form.elements.token.addEventListener('keydown', event => {
      if (event.key === 'Enter') { event.preventDefault(); this.authorizeToken(); }
    });
    document.querySelector('#monitor-auth-clear').addEventListener('click', () => this.clear());
    document.querySelector('#monitor-auth-cancel').addEventListener('click', () => {
      if (this.browserController) { this.cancelBrowserLogin(); this.dialog.close(); }
      else if (!this.busy) this.dialog.close();
    });
    this.back.addEventListener('click', () => { this.cancelChallenge(); this.render(); this.form.elements.username.focus(); });
    this.dialog.addEventListener('cancel', event => { if (this.browserController) this.cancelBrowserLogin(); else if (this.busy) event.preventDefault(); });
    this.dialog.addEventListener('close', () => { this.form.reset(); this.cancelChallenge(); this.cancelBrowserLogin(); this.render(); });
    window.addEventListener('pagehide', () => { this.form.reset(); this.cancelChallenge(); this.cancelBrowserLogin(); this.packyChallenge.cancel?.(); this.hideToast(); });
  }

  open(site = 'blackaicoding', name, accountId) {
    if (this.busy) return;
    const sites = {
      blackaicoding: { name: 'code for me', origin: 'https://blackaicoding.com', description: '自动读取监控和账号余额。' },
      input: { name: 'INPUT', origin: 'https://ai.input.im', description: '自动读取三个号池的监控状态、API Key 所属号池、账号余额和订阅额度。' },
      aixor: { name: 'Aixor', origin: 'https://aixor.cc', description: '自动读取当前余额和未过期订阅。公开可用性无需登录。' },
      packycode: { name: 'Packycode', origin: 'https://www.packyapi.com', description: '请先阅读并勾选服务条款及相关政策，再完成人机验证。授权后自动读取控制台当前余额，每 15 秒随检测刷新。' },
      krill: { name: 'Krill', origin: 'https://www.krill-code.com', credentialName: 'krill_jwt', description: '自动读取个人账号余额、套餐状态和近 7 天用量。公开可用性无需登录。' },
      rightcode: { name: 'RC', origin: 'https://www.rightapi.ai', credentialName: 'userToken', description: '自动读取控制台当前余额，每 15 秒随检测刷新。Codex 模型可用性无需登录。' },
      timicc: { name: 'timiCC', origin: 'https://timicc.com', description: '自动读取当前余额，每 15 秒随检测刷新。两个 Codex 号池的公开状态无需登录。' },
      aigo: { name: '派大星', origin: 'https://api.aigo0.com', credentialName: 'auth_token', browser: true, description: '点击「在此页面登录」，在官网实时画面中确认条款、输入账号密码并完成人机验证。成功后自动保存授权，无需复制令牌。' },
    };
    if (!Object.hasOwn(sites, site)) return;
    this.hideToast();
    this.form.reset();
    this.form.querySelector('details').open = false;
    this.cancelChallenge();
    this.site = site;
    this.name = name;
    this.accountId = accountId;
    const settings = sites[site];
    this.browserOnly = Boolean(settings.browser);
    document.querySelector('#monitor-browser-fallback').hidden = !this.browserOnly;
    document.querySelector('#monitor-auth-title').textContent = settings.name + ' · ' + (name || '账号授权');
    document.querySelector('#monitor-auth-description').textContent = '使用 ' + settings.name + ' 账号登录，' + settings.description + ' 本次授权供该账号及设为同一账号的绑定配置共用，重新登录或清除授权会作用于整个共用账号。';
    const link = document.querySelector('#monitor-auth-site');
    link.href = settings.origin + (site === 'rightcode' ? '/dashboard' : site === 'timicc' ? '/usage' : ['input', 'aigo'].includes(site) ? '/monitor' : '/'); link.textContent = settings.name;
    document.querySelector('#monitor-auth-origin').textContent = settings.origin;
    this.form.elements.username.placeholder = settings.name + ' 账号或邮箱';
    const session = ['aixor', 'packycode'].includes(site);
    this.session = session;
    this.credentialName = settings.credentialName || 'auth_token';
    document.querySelector('#monitor-auth-manual-title').textContent = session ? '无法登录？手动复制登录会话' : '无法登录？使用 ' + this.credentialName + ' 授权';
    document.querySelector('#monitor-token-steps').hidden = session;
    document.querySelector('#monitor-cookie-steps').hidden = !session;
    document.querySelector('#monitor-user-id-field').hidden = !session;
    document.querySelector('#monitor-token-key').textContent = this.credentialName;
    document.querySelector('#monitor-credential-label').textContent = session ? 'Cookie 请求头' : this.credentialName;
    this.form.elements.token.placeholder = session ? '粘贴 Cookie 的完整值' : '粘贴 ' + this.credentialName;
    this.tokenSubmit.textContent = session ? '验证并保存会话' : '验证并保存 ' + this.credentialName;
    this.requiresAgreement = ['aixor', 'timicc', 'packycode'].includes(site);
    document.querySelector('#monitor-auth-agreement').hidden = !this.requiresAgreement;
    document.querySelector('#monitor-agreement-links').innerHTML = ['timicc', 'aigo'].includes(site)
      ? [['terms', '服务条款'], ['usage-policy', '使用政策'], ['supported-regions', '支持的国家和地区'], ['service-specific-terms', '隐私政策']]
        .map(([path, label]) => '<a href="' + settings.origin + '/legal/' + path + '" target="_blank" rel="noreferrer">' + label + '</a>').join('、')
      : '<a href="' + settings.origin + '/user-agreement" target="_blank" rel="noreferrer">' + settings.name + ' 用户协议</a>';
    this.form.elements.agreement.required = this.requiresAgreement;
    if (site === 'packycode') this.setPackyAgreements();
    const cookieLink = document.querySelector('#monitor-cookie-site');
    cookieLink.href = settings.origin + (site === 'packycode' ? '/console' : '/wallet');
    cookieLink.textContent = settings.name + (site === 'packycode' ? ' 控制台' : ' 钱包');
    document.querySelector('#monitor-cookie-fallback').textContent = site === 'packycode'
      ? '若看不到用户 ID，可在 Application → Local Storage → https://www.packyapi.com 中打开 user，复制其中的 id 数字。'
      : '若看不到用户 ID，可在 Application → Local Storage → https://aixor.cc 中复制 uid。';
    document.querySelector('#monitor-cookie-note').textContent = settings.name + ' 使用会话 Cookie，无需寻找 auth_token；会话失效后重新登录即可。';
    this.feedback.textContent = '';
    this.render();
    this.dialog.showModal();
    if (this.browserOnly) this.submit.focus(); else this.form.elements.username.focus();
  }

  render() {
    const secondStep = Boolean(this.challengeId);
    for (const control of this.form.elements) control.disabled = this.busy;
    this.loginFields.hidden = secondStep || this.browserOnly;
    this.loginFields.disabled = this.busy || secondStep || this.browserOnly;
    this.otpFields.hidden = !secondStep;
    this.otpFields.disabled = this.busy || !secondStep;
    this.back.hidden = !secondStep;
    this.submit.textContent = this.browserOnly ? '在此页面登录' : secondStep ? '验证并授权' : '登录并授权';
    if (this.browserController) document.querySelector('#monitor-auth-cancel').disabled = false;
    this.projection.enableControls();
    this.form.setAttribute('aria-busy', String(this.busy));
  }

  hideToast() {
    clearTimeout(this.toastTimer);
    this.toastTimer = null;
    this.toast.hidden = true;
  }

  showToast(message, expiresAt) {
    this.hideToast();
    this.toast.querySelector('.auth-toast-message').textContent = message;
    const expiry = this.toast.querySelector('.auth-toast-expiry');
    expiry.textContent = expiresAt ? '有效期至 ' + new Date(expiresAt).toLocaleString() : '';
    expiry.hidden = !expiresAt;
    this.toast.hidden = false;
    this.toastTimer = setTimeout(() => this.hideToast(), 4000);
  }

  cancelChallenge() {
    const challengeId = this.challengeId;
    this.challengeId = null;
    this.form.elements.code.value = '';
    if (challengeId) fetch('/api/availability/login/cancel', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ site: this.site, name: this.name, accountId: this.accountId, challengeId }), keepalive: true,
    }).catch(() => {}); // The server also expires abandoned challenges after five minutes.
  }

  async send(endpoint, payload) {
    const response = await fetch(endpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ site: this.site, name: this.name, accountId: this.accountId, ...payload }), signal: AbortSignal.timeout(25000),
    });
    const data = await response.json();
    if (!response.ok) throw Object.assign(new Error(data.error || '操作失败，请重试。'), { status: response.status });
    return data;
  }

  async perform(message, operation) {
    if (this.busy) return;
    let completed = false;
    this.busy = true;
    this.render();
    this.feedback.textContent = message;
    try {
      const data = await operation();
      if (data.requires2fa) {
        this.challengeId = data.challengeId;
        this.feedback.textContent = data.message;
      } else {
        this.cancelChallenge();
        this.form.reset();
        this.feedback.textContent = '';
        this.dialog.close();
        this.showToast(data.message, data.expiresAt);
        completed = true;
      }
    } catch (error) {
      if (error.status === 410) this.cancelChallenge();
      this.feedback.textContent = error.name === 'TimeoutError' ? '请求超时，请刷新检查授权状态后重试。' : error.message;
    } finally {
      this.form.elements.password.value = '';
      this.form.elements.token.value = '';
      this.form.elements.code.value = '';
      this.busy = false;
      this.render();
      if (this.challengeId) this.form.elements.code.focus();
    }
    if (completed) {
      try { await this.onAuthorized(); }
      catch { this.showToast('操作已成功，数据刷新失败，请稍后重试。'); }
    }
  }

  setPackyAgreements(options = {}) {
    const documents = [['terms', '服务条款'], ['usage-policy', '使用政策'], ['supported-regions', '支持的国家和地区'], ['service-specific-terms', '服务特定条款']];
    if (options.agreement) documents.push(['user-agreement', '用户协议']);
    if (options.privacy) documents.push(['privacy-policy', '隐私政策']);
    const links = document.querySelector('#monitor-agreement-links');
    const markup = documents.map(([path, label]) => '<a href="https://www.packyapi.com/' + path + '" target="_blank" rel="noreferrer">' + label + '</a>').join('、');
    if (links.innerHTML !== markup) {
      links.innerHTML = markup;
      this.form.elements.agreement.checked = false;
    }
  }

  async login() {
    if (this.busy) return;
    if (this.browserOnly) { this.loginInBrowser(); return; }
    const fields = this.form.elements;
    let packyOptions;
    if (this.site === 'packycode' && !this.challengeId) {
      if (!fields.agreement.checked) {
        this.feedback.textContent = '请先阅读并同意 Packycode 的服务条款及相关政策，再登录。';
        fields.agreement.focus();
        return;
      }
      this.busy = true;
      this.render();
      this.feedback.textContent = '正在读取 Packycode 登录设置…';
      try {
        packyOptions = await this.packyChallenge.options();
        this.setPackyAgreements(packyOptions);
      } catch (error) {
        this.feedback.textContent = error.name === 'TimeoutError' ? '读取登录设置超时，请稍后重试。' : error.message;
        return;
      } finally {
        this.busy = false;
        this.render();
      }
      if (!fields.agreement.checked) {
        this.feedback.textContent = 'Packycode 的协议内容已更新，请阅读并重新勾选同意后登录。';
        fields.agreement.focus();
        return;
      }
    }
    const payload = this.challengeId ? { challengeId: this.challengeId, code: fields.code.value } : { username: fields.username.value, password: fields.password.value,
      ...(this.requiresAgreement ? { agreement: fields.agreement.checked } : {}) };
    fields.password.value = '';
    fields.code.value = '';
    return this.perform('正在登录并验证账号授权…', async () => {
      if (packyOptions) payload.captcha = await this.packyChallenge.verify(packyOptions.captcha);
      return this.send('/api/availability/login', payload);
    });
  }

  cancelBrowserLogin() {
    this.projection.stop();
    this.browserController?.abort();
    const id = this.browserLoginId;
    this.browserLoginId = null;
    if (id) fetch('/api/availability/browser-login/cancel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }), keepalive: true }).catch(() => {});
  }

  async loginInBrowser(presentation = 'embedded') {
    const controller = new AbortController();
    this.browserController = controller;
    try {
      await this.perform(presentation === 'embedded' ? '正在加载官网登录画面…' : '正在打开 Chrome 登录窗口…', async () => {
        const started = await this.send('/api/availability/browser-login/start', { presentation, ...(presentation === 'embedded' ? { viewport: this.projection.dimensions() } : {}) });
        this.browserLoginId = started.browserLoginId;
        if (controller.signal.aborted) { this.cancelBrowserLogin(); throw new Error('已取消浏览器登录。'); }
        this.feedback.textContent = started.message;
        if (presentation === 'embedded') this.projection.start(this.browserLoginId, controller.signal);
        for (;;) {
          if (controller.signal.aborted) throw new Error('已取消浏览器登录。');
          const result = await this.send('/api/availability/browser-login/status', { id: this.browserLoginId });
          if (controller.signal.aborted) throw new Error('已取消浏览器登录。');
          if (result.state === 'success') { this.browserLoginId = null; return result; }
          if (result.state !== 'pending') throw new Error(result.message || '登录未完成，请重新登录。');
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      });
    } finally {
      if (this.browserController === controller) {
        this.cancelBrowserLogin(); this.browserController = null; this.render();
      }
    }
  }

  authorizeToken() {
    if (this.busy) return;
    const token = this.form.elements.token.value;
    if (!token.trim()) { this.feedback.textContent = this.session ? '请先粘贴 Cookie 请求头，再验证保存。' : '请先粘贴 ' + this.credentialName + '，再验证保存。'; return; }
    const payload = { token, ...(this.session ? { userId: this.form.elements.userId.value.trim() } : {}) };
    this.form.elements.token.value = '';
    this.perform('正在验证账号授权…', () => this.send('/api/availability/authorization', payload));
  }

  clear() {
    this.perform('正在清除授权…', () => this.send('/api/availability/authorization', { token: '' }));
  }
}
