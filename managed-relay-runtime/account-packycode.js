const { problem } = require('./config-store');
const { loginEndpoints } = require('./account-sites');
const ORIGIN = 'https://www.packyapi.com';
const BALANCE_ENDPOINT = ORIGIN + '/api/user/self';
const SETTINGS_ENDPOINT = ORIGIN + '/api/status';
const CAPTCHA_ENDPOINT = ORIGIN + '/api/captcha/tencent/aid-encrypted';

function data(payload) {
  if (payload?.success !== true) {
    const expired = /^AUTH_/.test(payload?.code || '') || /未登录|无权.*登录|登录.*(?:过期|失效)|not logged|session expired/i.test(payload?.message || '');
    throw Object.assign(new Error('Invalid Packycode account response'), expired ? { status: 401 } : {});
  }
  return payload.data;
}

function readIdentity(payload) {
  const user = data(payload);
  if (!Number.isSafeInteger(user?.id) || user.id <= 0 || !Number.isFinite(user.quota)) throw new Error('Invalid Packycode account');
  return { userId: user.id, quota: user.quota };
}

function readSettings(payload) {
  const settings = data(payload), scale = Number(settings?.quota_per_unit);
  if (!Number.isFinite(scale) || scale <= 0 || settings.quota_display_type !== 'USD') throw new Error('Unsupported Packycode quota conversion');
  return { scale };
}

function readBalance(payload, now, model, dependencies) {
  return { kind: 'packy-account', amount: readIdentity(payload).quota / dependencies.settings.scale, currency: 'USD' };
}

// Only these two captcha fields may extend the fixed password-login URL.
function loginUrl(captcha) {
  const url = new URL(loginEndpoints('packycode').login);
  if (captcha !== undefined) {
    if (!captcha || ![captcha.ticket, captcha.randstr].every(value => typeof value === 'string' && /^[\x21-\x7e]{1,8192}$/.test(value))) throw problem('请重新完成人机验证。', 400);
    url.searchParams.set('tencent_ticket', captcha.ticket);
    url.searchParams.set('tencent_randstr', captcha.randstr);
  }
  return url.href;
}

function isLoginUrl(value) {
  try {
    const url = new URL(value), endpoints = loginEndpoints('packycode');
    if (value === endpoints.login || value === endpoints.totp) return true;
    return [...url.searchParams.keys()].sort().join(',') === 'tencent_randstr,tencent_ticket' &&
      loginUrl({ ticket: url.searchParams.get('tencent_ticket'), randstr: url.searchParams.get('tencent_randstr') }) === value;
  } catch { return false; }
}

async function loginOptions(request, signal) {
  const settings = data(await request(SETTINGS_ENDPOINT, { signal }));
  if (settings.turnstile_check && !settings.tencent_captcha_check) throw problem('站点已更换人机验证方式，请使用下方手动会话授权。', 400);
  const options = { agreement: Boolean(settings.user_agreement_enabled), privacy: Boolean(settings.privacy_policy_enabled), captcha: null };
  if (settings.tencent_captcha_check) {
    const appId = String(settings.tencent_captcha_app_id || '');
    const aid = data(await request(CAPTCHA_ENDPOINT, { signal }))?.aid_encrypted;
    if (!/^\d{1,30}$/.test(appId) || typeof aid !== 'string' || !aid || aid.length > 16000) throw problem('无法获取人机验证信息，请稍后重试。', 400);
    options.captcha = { appId, aidEncrypted: aid };
  }
  return options;
}

module.exports = { BALANCE_ENDPOINT, SETTINGS_ENDPOINT, CAPTCHA_ENDPOINT, readIdentity, readSettings, readBalance, loginUrl, isLoginUrl, loginOptions };
