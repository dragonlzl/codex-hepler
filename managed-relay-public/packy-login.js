class PackyLoginChallenge {
  async options() {
    const response = await fetch('/api/availability/login/options?site=packycode', { cache: 'no-store', signal: AbortSignal.timeout(12000) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '暂时无法读取登录验证设置，请稍后重试。');
    return data;
  }

  verify(options) {
    if (!options) return Promise.resolve(undefined);
    return new Promise((resolve, reject) => {
      const dialog = document.createElement('dialog');
      dialog.className = 'packy-captcha-dialog';
      dialog.setAttribute('aria-label', 'Packycode 人机验证');
      const title = document.createElement('h2'); title.textContent = '请完成人机验证';
      const frame = document.createElement('iframe');
      frame.title = '腾讯人机验证';
      // Third-party captcha code cannot access the login form, password or other local UI data.
      frame.setAttribute('sandbox', 'allow-scripts allow-forms');
      frame.src = '/packy-captcha.html';
      const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = '取消验证';
      dialog.append(title, frame, cancel); document.body.append(dialog);
      const nonce = crypto.randomUUID();
      let settled = false;
      const finish = (error, value) => {
        if (settled) return; settled = true;
        clearTimeout(timer); window.removeEventListener('message', receive);
        this.cancel = null; dialog.close(); dialog.remove();
        if (error) reject(error); else resolve(value);
      };
      const receive = event => {
        if (event.source !== frame.contentWindow || event.data?.nonce !== nonce || event.data?.type !== 'packy-captcha-result') return;
        const result = event.data;
        if (result.ok && [result.ticket, result.randstr].every(value => typeof value === 'string' && value.length > 0 && value.length <= 8192)) finish(null, { ticket: result.ticket, randstr: result.randstr });
        else finish(new Error(result.reason === 'unreachable'
          ? '无法访问人机验证服务，请开启 VPN 或配置可用代理后重试。'
          : '人机验证未完成，请重试；也可使用下方手动会话授权。'));
      };
      const timer = setTimeout(() => finish(new Error('人机验证超时，请重新登录。')), 120000);
      this.cancel = () => finish(new Error('已取消人机验证。'));
      cancel.addEventListener('click', () => this.cancel?.());
      dialog.addEventListener('cancel', event => { event.preventDefault(); this.cancel?.(); });
      window.addEventListener('message', receive);
      frame.addEventListener('load', () => frame.contentWindow.postMessage({ type: 'packy-captcha-start', nonce, ...options }, '*'), { once: true });
      dialog.showModal();
    });
  }
}
