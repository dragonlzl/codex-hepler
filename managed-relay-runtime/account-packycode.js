const { problem } = require('./config-store');
const { loginEndpoints } = require('./account-sites');
const { networkAccessError } = require('./network-error');
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
  const read = async (endpoint, stage) => {
    let payload;
    try {
      payload = await request(endpoint, { signal });
      signal.throwIfAborted();
    } catch (error) {
      // These endpoints are public bootstrap reads, not local configuration writes.
      // Never reflect an upstream body, URL or raw exception into the login form.
      const networkError = networkAccessError(error, ' Packycode，无法获取' + stage, signal);
      if (networkError) throw networkError;
      const code = error.code || error.cause?.code;
      if (['EACCES', 'EPERM', 'ENOENT', 'ENOSPC', 'EROFS'].includes(code)) throw error;
      const reasons = {
        CERT_HAS_EXPIRED: '站点证书已过期', UNABLE_TO_VERIFY_LEAF_SIGNATURE: '站点证书验证失败',
        DEPTH_ZERO_SELF_SIGNED_CERT: '站点证书验证失败', ERR_TLS_CERT_ALTNAME_INVALID: '站点证书与域名不匹配',
      };
      const upstreamStatus = Number.isInteger(error.status) && error.status >= 100 && error.status <= 599 ? error.status : null;
      const reason = (Object.hasOwn(reasons, code) ? reasons[code] : null) || (upstreamStatus ? '站点返回 HTTP ' + upstreamStatus : error instanceof SyntaxError ? '站点未返回有效 JSON' : '网络连接失败');
      const advice = upstreamStatus === 429 ? '站点请求过于频繁，请稍后重试。'
        : '请检查「运行与连接 → 上游网络」的代理及 Packycode 官网能否打开，再重试。';
      throw problem('无法获取 Packycode ' + stage + '（' + reason + '）。' + advice, upstreamStatus === 429 ? 429 : 502);
    }
    if (payload?.success !== true || !payload.data || typeof payload.data !== 'object' || Array.isArray(payload.data)) {
      throw problem('Packycode 返回的' + stage + '无效，请稍后重试。', 502);
    }
    return payload.data;
  };
  const settings = await read(SETTINGS_ENDPOINT, '登录设置');
  if (settings.turnstile_check && !settings.tencent_captcha_check) throw problem('站点已更换人机验证方式，请使用下方手动会话授权。', 400);
  const options = { agreement: Boolean(settings.user_agreement_enabled), privacy: Boolean(settings.privacy_policy_enabled), captcha: null };
  if (settings.tencent_captcha_check) {
    const appId = String(settings.tencent_captcha_app_id || '');
    const aid = (await read(CAPTCHA_ENDPOINT, '人机验证配置')).aid_encrypted;
    if (!/^\d{1,30}$/.test(appId) || typeof aid !== 'string' || !aid || aid.length > 16000) throw problem('无法获取人机验证信息，请稍后重试。', 400);
    options.captcha = { appId, aidEncrypted: aid };
  }
  return options;
}

module.exports = { BALANCE_ENDPOINT, SETTINGS_ENDPOINT, CAPTCHA_ENDPOINT, readIdentity, readSettings, readBalance, loginUrl, isLoginUrl, loginOptions };
