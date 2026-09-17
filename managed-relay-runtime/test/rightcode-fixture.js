const { loginEndpoints } = require('../account-sites');
const { BALANCE_ENDPOINT } = require('../account-rightcode');
const { ENDPOINT, CATALOG_ENDPOINT } = require('../availability-rightcode');
const TOKEN = 'rc-fixture-account-token-123456789';
const PASSWORD = 'fixture-password';
const MODELS = ['gpt-6-astra', 'gpt-5.6-sol'];

function catalog() {
  return { upstreams: [{ name: 'Codex', prefix: '/codex', models: MODELS.map(name => ({ name, is_available: true })) },
    { name: 'Other', prefix: '/claude', models: MODELS.map(name => ({ name, is_available: false })) }] };
}
function status(now = Date.now()) {
  const generated_at = Math.floor(now / 1000), hour = Math.floor(generated_at / 3600) * 3600;
  return { upstream_id: 1, upstream_prefix: '/codex', window: '24h', generated_at,
    models: MODELS.map((model, m) => ({ model, points: Array.from({ length: 24 }, (_, i) => ({ start_at: hour - (23 - i) * 3600,
      end_at: Math.min(generated_at, hour - (22 - i) * 3600), availability: i === 22 ? (m ? 55 : 28.8) : i < 3 ? 79.2 : 98,
      user_availability: 100, first_attempt_availability: 100, no_sample: false })) })) };
}
async function request(url, { json, token }) {
  if (url === ENDPOINT) return status();
  if (url === CATALOG_ENDPOINT) return catalog();
  if (url === loginEndpoints('rightcode').login) {
    if (json.password !== PASSWORD) throw Object.assign(new Error('Fixture credentials rejected'), { status: 401 });
    if (json.username === 'otp' && !json.otp_code) return { otp_required: true };
    if (json.otp_code && json.otp_code !== '123456') throw Object.assign(new Error('Fixture OTP rejected'), { status: 400 });
    return { username: json.username, balance: '45.6789', user_token: TOKEN };
  }
  if (url === BALANCE_ENDPOINT && token === TOKEN) return { balance: '45.6789', user_token: TOKEN, email: 'private@example.invalid' };
  throw Object.assign(new Error('Fixture unauthorized'), { status: 401 });
}
module.exports = { TOKEN, PASSWORD, MODELS, catalog, status, request };
