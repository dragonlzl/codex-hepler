const { LOGIN_ENDPOINT, TOTP_ENDPOINT } = require('../monitor-login');
const { ENDPOINT } = require('../availability-blackaicoding');
const { ENDPOINT: BALANCE_ENDPOINT } = require('../balance-blackaicoding');
const { loginEndpoints } = require('../account-sites');
const { BALANCE_ENDPOINT: INPUT_BALANCE, SUBSCRIPTIONS_ENDPOINT: INPUT_SUBSCRIPTIONS } = require('../account-input');
const INPUT_LOGIN = loginEndpoints('input');

const TOKEN = 'fixture.' + Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 86400 })).toString('base64url') + '.signature';
const PASSWORD = 'fixture-password';
const TEMP_TOKEN = 'fixture-temp-token';
const REFRESH_TOKEN = 'fixture-refresh-token';
const INPUT_TOKEN = TOKEN.replace('fixture.', 'inputfixture.');

function subscriptions() {
  const now = Date.now();
  return { code: 0, data: [
    { id: 101, status: 'active', starts_at: new Date(now - 86400000).toISOString(), expires_at: new Date(now + 20 * 86400000).toISOString(),
      group: { name: 'Codex 高级订阅', daily_limit_usd: 100, weekly_limit_usd: 500, monthly_limit_usd: 1500 },
      daily_usage_usd: 36.25, weekly_usage_usd: 185, monthly_usage_usd: 420.5,
      daily_window_start: new Date(now - 3600000).toISOString(), weekly_window_start: new Date(now - 2 * 86400000).toISOString(), monthly_window_start: new Date(now - 10 * 86400000).toISOString() },
    { id: 102, status: 'expired', starts_at: new Date(now - 2 * 86400000).toISOString(), expires_at: new Date(now - 86400000).toISOString(),
      group: { name: '历史日卡', daily_limit_usd: 30 }, daily_usage_usd: 30, daily_window_start: new Date(now - 2 * 86400000).toISOString() },
  ] };
}

function matrix() {
  const end = Math.floor(Date.now() / 300000) * 300000;
  const metrics = { error_rate: .02, cache_rate: .8, ttft: { avg_ms: 1200 }, duration: { avg_ms: 18000 } };
  const health = { overall: 'healthy', score: 98 };
  return { code: 0, data: { group_by: 'platform_group_model', coverage: {
    requested_start: new Date(end - 5400000).toISOString(), requested_end: new Date(end).toISOString(),
    data_through: new Date(end).toISOString(), bucket_seconds: 300,
  }, items: ['__other__', 'gpt-5.6-sol'].map(model => ({ platform: 'openai', group_id: 2, group_name: 'codex混合渠道--低价', model, metrics, health,
    buckets: Array.from({ length: 18 }, (_, index) => ({ bucket_start: new Date(end - 5400000 + index * 300000).toISOString(), metrics, health })),
  })) } };
}

async function request(url, { json, token }) {
  if (url.startsWith('https://timicc.com/') || url.startsWith('https://status.timicc.com/')) return require('./timicc-fixture').request(...arguments);
  if (url.startsWith('https://api.aigo0.com/')) return require('./aigo-fixture').request(...arguments);
  if (url.startsWith('https://www.rightapi.ai/')) return require('./rightcode-fixture').request(...arguments);
  if (url.startsWith('https://www.packyapi.com/')) return require('./packy-account-fixture').request(...arguments);
  if (url.startsWith('https://aixor.cc/')) return require('./aixor-account-fixture').request(...arguments);
  if (url.startsWith('https://www.krill-code.com/')) return require('./krill-account-fixture').request(...arguments);
  if (url === 'https://status.input.im/api/status') return { services: ['gpt-6-astra', 'gpt-5.6-sol'].map(model => ({ model, history: [{ ts: Date.now() / 1000, ok: true, latency_ms: 800 }] })) };
  if (url === require('../availability-input').ENDPOINT || require('../input-key-groups').isKeyEndpoint(url)) return require('./input-fixture').request(...arguments);
  if (url === INPUT_LOGIN.login) {
    if (json.password !== PASSWORD) throw Object.assign(new Error('Invalid fixture credentials'), { status: 401 });
    return json.email === 'otp' ? { code: 0, data: { requires_2fa: true, temp_token: 'input-' + TEMP_TOKEN } } : { code: 0, data: { access_token: INPUT_TOKEN, refresh_token: 'input-' + REFRESH_TOKEN } };
  }
  if (url === INPUT_LOGIN.totp) {
    if (json.temp_token !== 'input-' + TEMP_TOKEN || json.totp_code !== '123456') throw Object.assign(new Error('Invalid fixture OTP'), { status: 400 });
    return { code: 0, data: { access_token: INPUT_TOKEN } };
  }
  if (url === INPUT_BALANCE && token === INPUT_TOKEN) return { code: 0, data: { balance: 67.89123 } };
  if (url === INPUT_SUBSCRIPTIONS && token === INPUT_TOKEN) return subscriptions();
  const success = { code: 0, data: { access_token: TOKEN, refresh_token: REFRESH_TOKEN, expires_in: 86400 } };
  if (url === LOGIN_ENDPOINT) {
    if (json.password !== PASSWORD) throw Object.assign(new Error('Invalid fixture credentials'), { status: 401 });
    return json.email === 'otp' ? { code: 0, data: { requires_2fa: true, temp_token: TEMP_TOKEN } } : success;
  }
  if (url === TOTP_ENDPOINT) {
    if (json.temp_token !== TEMP_TOKEN || json.totp_code !== '123456') throw Object.assign(new Error('Invalid fixture OTP'), { status: 400 });
    return success;
  }
  if (url === ENDPOINT && token === TOKEN) return matrix();
  if (url === BALANCE_ENDPOINT && token === TOKEN) return { code: 0, data: { balance: 1234.56789 } };
  throw Object.assign(new Error('Unavailable in login fixture'), { status: 401 });
}

module.exports = { TOKEN, INPUT_TOKEN, PASSWORD, TEMP_TOKEN, REFRESH_TOKEN, matrix, subscriptions, request };
