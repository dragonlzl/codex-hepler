const { randomUUID } = require('node:crypto');
const { MonitorLogin, loginError } = require('./monitor-login');
const { problem } = require('./config-store');
const { validateAixorSession } = require('./account-aixor');
const { accountSite } = require('./account-sites');
const packy = require('./account-packycode');

function mergeCookies(previous, setCookies, site = 'aixor') {
  const host = new URL(accountSite(site).origin).hostname;
  const jar = new Map((previous || '').split(/;\s*/).filter(Boolean).map(part => [part.slice(0, part.indexOf('=')), part.slice(part.indexOf('=') + 1)]));
  for (const header of setCookies || []) {
    const [pair, ...attributes] = header.split(';');
    const index = pair.indexOf('=');
    if (index <= 0) throw new Error('Invalid login cookie');
    const name = pair.slice(0, index).trim(), value = pair.slice(index + 1).trim();
    const attrs = Object.fromEntries(attributes.map(a => { const [key, ...rest] = a.trim().split('='); return [key.toLowerCase(), rest.join('=')]; }));
    if (attrs.domain) {
      const domain = attrs.domain.toLowerCase().replace(/^\./, '');
      if (domain !== host && !(domain.includes('.') && host.endsWith('.' + domain))) continue;
    }
    if (attrs.path && !'/api/user/self'.startsWith(attrs.path) && !'/api/user/login/2fa'.startsWith(attrs.path)) continue;
    if (!value || (attrs['max-age'] !== undefined && Number(attrs['max-age']) <= 0) || (attrs.expires && Date.parse(attrs.expires) <= Date.now())) jar.delete(name);
    else jar.set(name, value);
  }
  const cookie = [...jar].map(([name, value]) => name + '=' + value).join('; ');
  if (cookie) validateAixorSession({ cookie, userId: 1 });
  return cookie;
}

class AixorLogin extends MonitorLogin {
  constructor(request, clock, site = 'aixor') { super(request, clock, site); this.site = site; }

  async login(payload, signal) {
    const secondStep = payload.challengeId !== undefined;
    let challenge, json;
    if (secondStep) {
      challenge = this.challenges.get(payload.challengeId);
      if (!challenge || challenge.expiresAt <= this.clock()) { this.cancel(payload.challengeId); throw problem('二次验证已过期，请重新登录。', 410); }
      if (typeof payload.code !== 'string' || !/^\d{6}$/.test(payload.code.trim())) throw problem('请输入 6 位验证码。', 400);
      json = { code: payload.code.trim() };
    } else {
      if (this.site === 'aixor' && payload.agreement !== true) throw problem('请先阅读并同意 Aixor 用户协议。', 400);
      if (this.site === 'packycode' && payload.agreement !== true) throw problem('请先阅读并同意 Packycode 的服务条款及相关政策。', 400);
      if (typeof payload.username !== 'string' || !payload.username.trim() || payload.username.length > 320 || typeof payload.password !== 'string' || !payload.password || payload.password.length > 4096) throw problem('请输入有效的账号和密码。', 400);
      json = { username: payload.username.trim(), password: payload.password };
    }
    let response;
    const endpoint = secondStep ? this.endpoints.totp : this.site === 'packycode' ? packy.loginUrl(payload.captcha) : this.endpoints.login;
    try { response = await this.request(endpoint, { signal, json,
      ...(challenge ? { session: { cookie: challenge.cookie } } : {}), captureCookies: true }); }
    catch (error) { throw loginError(error, secondStep); }
    signal.throwIfAborted();
    if (secondStep && !this.challenges.has(payload.challengeId)) throw problem('二次验证已取消，请重新登录。', 410);
    const result = response?.payload;
    if (result?.success !== true) {
      if (/captcha|turnstile/i.test(result?.code || '') || /验证码|人机/.test(result?.message || '') && !secondStep) throw problem('人机验证未通过或已过期，请重新登录并完成验证；也可使用下方手动会话授权。', 400);
      throw loginError({ status: 400 }, secondStep);
    }
    const cookie = mergeCookies(challenge?.cookie, response.cookies, this.site);
    if (!cookie) throw problem('站点未返回登录会话，请使用手动授权。', 400);
    if (result.data?.require_2fa) {
      if (secondStep) throw problem('二次验证响应异常，请重新登录。', 400);
      while (this.challenges.size >= 8) this.cancel(this.challenges.keys().next().value);
      const challengeId = randomUUID();
      const timer = setTimeout(() => this.cancel(challengeId), 300000); timer.unref();
      this.challenges.set(challengeId, { cookie, expiresAt: this.clock() + 300000, timer });
      return { requires2fa: true, challengeId, message: '请输入身份验证器中的 6 位验证码。' };
    }
    const credential = validateAixorSession({ cookie, userId: result.data?.id });
    if (secondStep) this.cancel(payload.challengeId);
    return { credential };
  }
}

module.exports = { AixorLogin, mergeCookies };
