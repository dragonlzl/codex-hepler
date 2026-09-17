const { ENDPOINT, POOLS } = require('../availability-timicc');
const { loginEndpoints } = require('../account-sites');
const { endpoint } = require('../timicc-key-groups');
const TOKEN = 'timifixture.' + Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 86400 })).toString('base64url') + '.signature';
const PASSWORD = 'fixture-password';
const BALANCE_ENDPOINT = 'https://timicc.com/api/v1/auth/me';
const LOGIN = loginEndpoints('timicc');
function status(now = Date.now()) {
  const timelines = POOLS.map((pool, i) => {
    const id = 'pool-' + i;
    const items = Array.from({ length: 60 }, (_, n) => ({ id, name: pool + ' - gpt-5.6-sol', model: 'gpt-5.6-sol', groupName: 'CodeX 通道',
      status: i && n % 9 === 0 ? 'degraded' : 'operational', checkedAt: new Date(now - n * 300000).toISOString(), latencyMs: i ? 35000 : 2800, pingLatencyMs: 58 }));
    return { id, latest: { ...items[0], officialStatus: { status: 'operational' } }, items };
  });
  return { groupName: 'CodeX 通道', providerTimelines: timelines, pollIntervalMs: 300000, trendPeriod: '7d', generatedAt: now,
    availabilityStats: Object.fromEntries(timelines.map(t => [t.id, [{ period: '7d', totalChecks: 1000, operationalCount: 920, availabilityPct: 92 }]])) };
}
async function request(url, { json, token }) {
  if (url === ENDPOINT) return status();
  if (url === LOGIN.login) {
    if (json.password !== PASSWORD) throw Object.assign(new Error('Fixture credentials rejected'), { status: 401 });
    return { code: 0, data: json.email === 'otp' ? { requires_2fa: true, temp_token: 'fixture-pending-token' } : { access_token: TOKEN } };
  }
  if (url === LOGIN.totp) {
    if (json.temp_token !== 'fixture-pending-token' || json.totp_code !== '123456') throw Object.assign(new Error('Fixture OTP rejected'), { status: 400 });
    return { code: 0, data: { access_token: TOKEN } };
  }
  if (url === BALANCE_ENDPOINT && token === TOKEN) return { code: 0, data: { balance: 4.00491851, email: 'private@example.invalid' } };
  if (url === endpoint(1) && token === TOKEN) return { code: 0, data: { page: 1, page_size: 100, pages: 1, total: 2,
    items: [{ key: 'sk-not-login', group: { name: 'CodeX team/plus号池' } }, { key: 'sk-other', group: { name: 'Codex Pro号池' } }] } };
  throw Object.assign(new Error('Fixture unauthorized'), { status: 401 });
}
module.exports = { TOKEN, PASSWORD, BALANCE_ENDPOINT, LOGIN, request, status };
