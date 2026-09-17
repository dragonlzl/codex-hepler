const { randomUUID } = require('node:crypto');
const { MonitorLogin, loginError } = require('./monitor-login');
const { validateRightcodeToken } = require('./account-rightcode');
const { problem } = require('./config-store');

class RightcodeLogin extends MonitorLogin {
  constructor(request, clock) { super(request, clock, 'rightcode'); }

  async login(payload, signal) {
    const secondStep = payload.challengeId !== undefined;
    let json;
    if (secondStep) {
      const challenge = this.challenges.get(payload.challengeId);
      if (!challenge || challenge.expiresAt <= this.clock()) { this.cancel(payload.challengeId); throw problem('二次验证已过期，请重新登录。', 410); }
      if (typeof payload.code !== 'string' || !/^\d{6}$/.test(payload.code.trim())) throw problem('请输入 6 位验证码。', 400);
      json = { ...challenge.credentials, otp_code: payload.code.trim() };
    } else {
      if (typeof payload.username !== 'string' || !payload.username.trim() || payload.username.length > 320 ||
          typeof payload.password !== 'string' || !payload.password || payload.password.length > 4096) throw problem('请输入有效的账号和密码。', 400);
      json = { username: payload.username.trim(), password: payload.password };
    }
    let response;
    try { response = await this.request(this.endpoints.login, { signal, json }); signal.throwIfAborted(); }
    catch (error) { throw loginError(error, secondStep); }
    if (secondStep && !this.challenges.has(payload.challengeId)) throw problem('二次验证已取消，请重新登录。', 410);
    const token = response?.user_token ?? response?.userToken;
    if (response?.otp_required === true && !token) {
      if (secondStep) throw problem('验证码无效，请重试。', 400);
      while (this.challenges.size >= 8) this.cancel(this.challenges.keys().next().value);
      const challengeId = randomUUID();
      const timer = setTimeout(() => this.cancel(challengeId), 300000); timer.unref();
      // RC requires password + OTP in the same request. Keep it only in this
      // short-lived in-memory challenge; cancel/expiry/success erase the owner.
      this.challenges.set(challengeId, { credentials: json, expiresAt: this.clock() + 300000, timer });
      return { requires2fa: true, challengeId, message: '请输入身份验证器中的 6 位验证码。' };
    }
    if (!token) throw problem('RC 未返回有效授权，请检查账号密码；若站点要求人机验证，可使用下方手动 userToken 授权。', 400);
    const credential = validateRightcodeToken(token);
    if (secondStep) this.cancel(payload.challengeId);
    return { token: credential.token };
  }
}

module.exports = { RightcodeLogin };
