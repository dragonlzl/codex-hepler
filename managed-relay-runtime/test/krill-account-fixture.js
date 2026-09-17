const krill = require('../account-krill');
const { loginEndpoints } = require('../account-sites');
const LOGIN = loginEndpoints('krill');
const TOKEN = 'krillfixture.' + Buffer.from(JSON.stringify({ sub: 456, exp: Math.floor(Date.now() / 1000) + 86400 })).toString('base64url') + '.signature';
const PASSWORD = 'fixture-password';
const PENDING = 'krill-fixture-pending';
const PUBLIC = 'https://www.krill-code.com/api/public/channel-status?hours=24';
const wrap = data => ({ success: true, code: 0, data });

function subscriptions(now = Date.now()) {
  const iso = offset => new Date(now + offset * 86400000).toISOString();
  return wrap({ credit_balance_usd: '88.125', subscriptions: [
    { subscription_id: 201, status: 'active', subscription_start_at: iso(-5), subscription_end_at: iso(23),
      plan: { name: 'Codex 月度套餐', billing_type: 'usd_weekly', duration_days: 28 },
      quota: { used_usd: '36.25', daily_limit_usd: '100', forwarded_limit_usd: '20', forwarded_used_usd: '5', window_reset_at: iso(2) },
      total_limit_usd: '400', total_remaining_usd: '280' },
    { subscription_id: 202, status: 'frozen', subscription_start_at: iso(-1), subscription_end_at: iso(6),
      plan: { name: '备用周卡', billing_type: 'usd_weekly', duration_days: 7 }, quota: {} },
    { subscription_id: 203, status: 'expired', subscription_start_at: iso(-10), subscription_end_at: iso(-3), plan: { name: '过期套餐' } },
  ] });
}
function usage() { return wrap({ items: [
  { subscription_id: 201, plan_name: 'Codex 月度套餐', used_usd: '85.75', limit_usd: '100' },
  { subscription_id: 202, plan_name: '备用周卡', used_usd: '12.50', limit_usd: '50' },
  { subscription_id: 203, plan_name: '过期套餐', used_usd: '25', limit_usd: '50' },
] }); }

async function request(url, { json, token }) {
  if (url === PUBLIC) return wrap({ channels: ['gpt-6-astra', 'gpt-5.6-sol'].map((model, i) => ({
    channel_key: 'channel-' + i, channel: 'OpenAI 官渠', model_name: model, current_status: 1,
    history: [{ ts: new Date(Date.now() - 30000).toISOString().slice(0, 19).replace('T', ' '), s: 1 }],
  })), perf: [] });
  if (url === LOGIN.login) {
    if (json.password !== PASSWORD) throw Object.assign(new Error('Invalid fixture password'), { status: 401 });
    return json.email === 'otp' ? wrap({ requires_totp: true, pending_token: PENDING }) : wrap({ token: TOKEN, user: { id: 456, email: 'private@example.invalid' } });
  }
  if (url === LOGIN.totp) {
    if (json.pending_token !== PENDING || json.totp_code !== '123456') throw Object.assign(new Error('Invalid fixture OTP'), { status: 400 });
    return wrap({ token: TOKEN, user: { id: 456 } });
  }
  if (token !== TOKEN) throw Object.assign(new Error('Fixture unauthorized'), { status: 401 });
  if (url === krill.IDENTITY_ENDPOINT) return wrap({ id: 456, email: 'private@example.invalid', tos_accepted: true });
  if (url === krill.BALANCE_ENDPOINT) return wrap({ balance_usd: '88.125' });
  if (url === krill.SUBSCRIPTIONS_ENDPOINT) return subscriptions();
  if (url === krill.USAGE_ENDPOINT) return usage();
  throw new Error('Unexpected Krill fixture request');
}

module.exports = { request, subscriptions, usage, wrap, TOKEN, PASSWORD, PENDING, PUBLIC, LOGIN };
