const aixor = require('../account-aixor');
const { loginEndpoints } = require('../account-sites');
const LOGIN = loginEndpoints('aixor');
const COOKIE = 'session=aixor-fixture-cookie';
const USER_ID = 123;
const PASSWORD = 'fixture-password';

function subscriptions(now = Date.now()) {
  const seconds = Math.floor(now / 1000);
  const row = (id, status, end_time, amount_total = 50000000) => ({ subscription: {
    id, plan_id: 7, status, start_time: seconds - 86400, end_time, next_reset_time: seconds + 3600,
    amount_total, amount_used: 12500000,
  } });
  return { success: true, data: { billing_preference: 'subscription_first', all_subscriptions: [
    row(1, 'active', seconds + 7 * 86400), row(2, 'expired', seconds - 100),
    row(3, 'active', seconds - 1), row(4, 'cancelled', seconds + 86400), row(5, 'active', seconds + 86400, 0),
  ] } };
}

async function request(url, options) {
  const { json, session } = options;
  if (url === LOGIN.login) {
    if (json.password !== PASSWORD) return { payload: { success: false }, cookies: [] };
    return json.username === 'otp'
      ? { payload: { success: true, data: { require_2fa: true } }, cookies: ['session=aixor-fixture-pending; Path=/; HttpOnly; Secure'] }
      : { payload: { success: true, data: { id: USER_ID } }, cookies: [COOKIE + '; Path=/; HttpOnly; Secure'] };
  }
  if (url === LOGIN.totp) return json.code === '123456' && session?.cookie === 'session=aixor-fixture-pending'
    ? { payload: { success: true, data: { id: USER_ID } }, cookies: [COOKIE + '; Path=/; HttpOnly; Secure'] }
    : { payload: { success: false }, cookies: [] };
  if (url === aixor.SETTINGS_ENDPOINT) return { success: true, data: { quota_per_unit: 500000, quota_display_type: 'USD' } };
  if (url.startsWith('https://aixor.cc/api/perf-metrics?')) return { success: true, data: {
    model_name: new URL(url).searchParams.get('model'), groups: [{ group: 'Premium-gpt', success_rate: 100,
      avg_latency_ms: 3000, avg_ttft_ms: 1000, avg_tps: 30,
      series: [{ ts: Math.floor(Date.now() / 3600000) * 3600, success_rate: 100, avg_latency_ms: 3000, avg_ttft_ms: 1000, avg_tps: 30 }] }],
  } };
  if (session?.cookie !== COOKIE || session?.userId !== USER_ID) throw Object.assign(new Error('Fixture unauthorized'), { status: 401 });
  if (url === aixor.BALANCE_ENDPOINT) return { success: true, data: { id: USER_ID, quota: 12345678, email: 'private@example.invalid' } };
  if (url === aixor.SUBSCRIPTIONS_ENDPOINT) return subscriptions();
  if (url === aixor.PLANS_ENDPOINT) return { success: true, data: [{ plan: { id: 7, title: 'Premium-gpt 月度套餐' } }] };
  throw new Error('Unexpected Aixor fixture request');
}

module.exports = { request, subscriptions, COOKIE, USER_ID, PASSWORD, LOGIN };
