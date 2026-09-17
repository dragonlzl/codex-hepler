(() => {
  let started = false;
  window.addEventListener('message', event => {
    if (started || event.source !== parent || event.data?.type !== 'packy-captcha-start') return;
    started = true;
    const { appId, aidEncrypted, nonce } = event.data;
    const result = value => parent.postMessage({ type: 'packy-captcha-result', nonce, ...value }, '*');
    const script = document.createElement('script');
    script.src = 'https://turing.captcha.qcloud.com/TJCaptcha.js';
    script.onerror = () => result({ ok: false, reason: 'unreachable' });
    script.onload = () => {
      try {
        document.querySelector('#status').textContent = '请按提示完成验证';
        new window.TencentCaptcha(appId, data => result(data.ret === 0 ? { ok: true, ticket: data.ticket, randstr: data.randstr } : { ok: false }), { aidEncrypted }).show();
      } catch { result({ ok: false }); }
    };
    document.head.append(script);
  });
})();
