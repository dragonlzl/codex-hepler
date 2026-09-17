const { randomUUID } = require('node:crypto');
const { problem } = require('./config-store');
const { loginEndpoints } = require('./account-sites');

const { login: LOGIN_ENDPOINT, totp: TOTP_ENDPOINT } = loginEndpoints('blackaicoding');
const CHALLENGE_MS = 5 * 60 * 1000;

function loginError(error, secondStep) {
  if (error.status === 429) return problem('登录尝试过于频繁，请稍后重试。', 429);
  if (error.status === 401 || error.status === 400) return problem(secondStep ? '验证码无效或已过期，请重试或重新登录。' : '账号或密码不正确，请重新输入。', 400);
  if (error.status === 403) return problem('站点拒绝登录，请检查账号状态或站点是否要求人机验证。', 400);
  return problem('暂时无法完成登录，请稍后重试。', 400);
}

// Only this in-memory owner holds the provider's temporary two-factor tokens.
class MonitorLogin {
  constructor(request, clock = Date.now, site = 'blackaicoding') {
    this.request = request;
    this.clock = clock;
    this.endpoints = loginEndpoints(site);
    this.challenges = new Map();
  }

  cancel(id) {
    const challenge = this.challenges.get(id);
    if (challenge) clearTimeout(challenge.timer);
    this.challenges.delete(id);
  }

  clear() { for (const id of this.challenges.keys()) this.cancel(id); }

  async login(payload, signal) {
    const secondStep = payload.challengeId !== undefined;
    let json;
    if (secondStep) {
      const challenge = this.challenges.get(payload.challengeId);
      if (!challenge || challenge.expiresAt <= this.clock()) {
        this.cancel(payload.challengeId);
        throw problem('二次验证已过期，请重新登录。', 410);
      }
      if (typeof payload.code !== 'string' || !/^\d{6}$/.test(payload.code.trim())) throw problem('请输入 6 位验证码。', 400);
      json = { temp_token: challenge.token, totp_code: payload.code.trim() };
    } else {
      if (typeof payload.username !== 'string' || !payload.username.trim() || payload.username.length > 320) throw problem('请输入账号或邮箱。', 400);
      if (typeof payload.password !== 'string' || !payload.password || payload.password.length > 4096) throw problem('请输入有效的密码。', 400);
      json = { email: payload.username.trim(), password: payload.password };
    }
    let response;
    try { response = await this.request(secondStep ? this.endpoints.totp : this.endpoints.login, { signal, json }); }
    catch (error) { throw loginError(error, secondStep); }
    signal.throwIfAborted();
    if (secondStep && !this.challenges.has(payload.challengeId)) throw problem('二次验证已取消，请重新登录。', 410);
    if (response?.code !== 0) {
      // Never reflect upstream messages: they can contain credential values.
      if (typeof response?.code === 'string' && /captcha|turnstile/i.test(response.code)) throw problem('站点要求人机验证，暂时无法在工具内完成登录。', 400);
      throw loginError({ status: 400 }, secondStep);
    }
    const data = response.data;
    if (data?.requires_2fa === true) {
      if (secondStep || typeof data.temp_token !== 'string' || !data.temp_token || data.temp_token.length > 16000) throw problem('站点二次验证响应异常，请重新登录。', 400);
      while (this.challenges.size >= 8) this.cancel(this.challenges.keys().next().value);
      const challengeId = randomUUID();
      const timer = setTimeout(() => this.cancel(challengeId), CHALLENGE_MS);
      timer.unref();
      this.challenges.set(challengeId, { token: data.temp_token, expiresAt: this.clock() + CHALLENGE_MS, timer });
      return { requires2fa: true, challengeId, message: '请输入身份验证器中的 6 位验证码。' };
    }
    if (typeof data?.access_token !== 'string') throw problem('站点未返回有效的登录授权，请重试。', 400);
    if (secondStep) this.cancel(payload.challengeId);
    return { token: data.access_token };
  }
}

module.exports = { MonitorLogin, LOGIN_ENDPOINT, TOTP_ENDPOINT, loginError };
