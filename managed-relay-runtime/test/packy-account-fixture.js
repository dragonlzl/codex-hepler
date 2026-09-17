const packy = require('../account-packycode');
const { loginEndpoints } = require('../account-sites');
const LOGIN = loginEndpoints('packycode');
const COOKIE = 'session=packy-fixture-cookie';
const PASSWORD = 'fixture-password';
async function request(url, { json, session }) {
  if (url === packy.SETTINGS_ENDPOINT) return { success: true, data: { quota_per_unit: 500000, quota_display_type: 'USD', tencent_captcha_check: false } };
  if (url === packy.CAPTCHA_ENDPOINT) return { success: true, data: { aid_encrypted: 'fixture-aid' } };
  if (new URL(url).pathname === '/api/user/login') {
    if (json.password !== PASSWORD) return { payload: { success: false }, cookies: [] };
    return json.username === 'otp'
      ? { payload: { success: true, data: { require_2fa: true } }, cookies: ['session=packy-pending; Path=/; HttpOnly'] }
      : { payload: { success: true, data: { id: 321 } }, cookies: [COOKIE + '; Domain=.packyapi.com; Path=/; HttpOnly; Secure'] };
  }
  if (url === LOGIN.totp) return json.code === '123456' && session?.cookie === 'session=packy-pending'
    ? { payload: { success: true, data: { id: 321 } }, cookies: [COOKIE + '; Path=/; HttpOnly'] }
    : { payload: { success: false }, cookies: [] };
  if (url.includes('/api/perf-metrics?')) return { success: true, data: {
    model_name: new URL(url).searchParams.get('model'), groups: [{ group: 'codex', success_rate: 100,
      avg_latency_ms: 3000, avg_ttft_ms: 1000, avg_tps: 30,
      series: [{ ts: Math.floor(Date.now() / 3600000) * 3600, success_rate: 100, avg_latency_ms: 3000, avg_ttft_ms: 1000, avg_tps: 30 }] }],
  } };
  if (url === packy.BALANCE_ENDPOINT && session?.cookie === COOKIE && session.userId === 321) return { success: true, data: { id: 321, quota: 61728394, email: 'private@example.invalid' } };
  throw Object.assign(new Error('Packy fixture unauthorized'), { status: 401 });
}
module.exports = { request, COOKIE, PASSWORD, LOGIN };
