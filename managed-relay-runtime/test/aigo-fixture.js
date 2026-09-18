const { ENDPOINT, POOLS, keyEndpoint } = require('../availability-aigo');
const { loginEndpoints } = require('../account-sites');

const TOKEN = 'aigofixture.' + Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 86400 })).toString('base64url') + '.signature';
const PASSWORD = 'fixture-password';
const BALANCE_ENDPOINT = 'https://api.aigo0.com/api/v1/auth/me';
const LOGIN = loginEndpoints('aigo');
const KEYS = ['sk-aigo-plus', 'sk-aigo-cx008'];

function item(pool, now, index) {
  const timeline = Array.from({ length: 60 }, (_, n) => ({
    status: pool === POOLS[1] && n % 11 === 0 ? 'degraded' : 'operational',
    checked_at: new Date(now - n * 60000).toISOString(), latency_ms: pool === POOLS[1] ? 1500 : 700,
    ping_latency_ms: pool === POOLS[1] ? 80 : 42,
  }));
  return { id: index + 1, name: pool + ' · Codex', provider: 'openai', primary_model: 'gpt-5.6-sol', primary_status: timeline[0].status,
    primary_latency_ms: timeline[0].latency_ms, primary_ping_latency_ms: timeline[0].ping_latency_ms,
    availability_7d: pool === POOLS[1] ? 88.5 : 99.2, timeline };
}

function status(now = Date.now()) {
  return { code: 0, data: { items: POOLS.map((pool, index) => item(pool, now, index)) } };
}

async function request(url, { json, token }) {
  if (url === ENDPOINT && token === TOKEN) return status();
  if (url === LOGIN.login) {
    if (json.password !== PASSWORD) throw Object.assign(new Error('Fixture credentials rejected'), { status: 401 });
    return { code: 0, data: json.email === 'otp' ? { requires_2fa: true, temp_token: 'aigo-pending-token' } : { access_token: TOKEN } };
  }
  if (url === LOGIN.totp) {
    if (json.temp_token !== 'aigo-pending-token' || json.totp_code !== '123456') throw Object.assign(new Error('Fixture OTP rejected'), { status: 400 });
    return { code: 0, data: { access_token: TOKEN } };
  }
  if (url === BALANCE_ENDPOINT && token === TOKEN) return { code: 0, data: { balance: 12.3456 } };
  if (url === keyEndpoint(1) && token === TOKEN) return { code: 0, data: { page: 1, page_size: 100, pages: 1, items: [
    { key: KEYS[0], group: { name: 'CX009-PLUS 混合渠道' } }, { key: KEYS[1], group: { name: 'CX008 低价' } },
  ] } };
  throw Object.assign(new Error('Fixture unauthorized'), { status: 401 });
}

module.exports = { TOKEN, PASSWORD, BALANCE_ENDPOINT, LOGIN, KEYS, request, status };
