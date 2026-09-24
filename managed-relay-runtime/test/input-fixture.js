const { ENDPOINT, POOLS } = require('../availability-input');
const { keyEndpoint } = require('../input-key-groups');
const KEYS = ['sk-input-one', 'sk-input-two'];
const TOKEN = 'inputfixture.' + Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 86400 })).toString('base64url') + '.signature';
function status(now = Date.now()) {
  return { code: 0, data: { items: POOLS.map((name, index) => ({ id: index + 1, name, provider: 'openai', group_name: '',
    primary_model: 'gpt-5.6-sol', primary_status: 'operational', primary_latency_ms: 1500, primary_ping_latency_ms: 10,
    availability_7d: 95 - index, extra_models: [], timeline: Array.from({ length: 60 }, (_, i) => ({
      status: 'operational', checked_at: new Date(now - i * 60000).toISOString(), latency_ms: 1500, ping_latency_ms: 10,
    })) })) } };
}
function keyPage(page = 1, keys = KEYS, pools = POOLS) {
  return { code: 0, data: { page, page_size: 100, pages: 1, items: keys.map((key, index) => ({ key, group: { name: pools[index] } })) } };
}
async function request(url, options) {
  if (options.token !== TOKEN) throw Object.assign(new Error('Fixture auth required'), { status: 401 });
  if (url === ENDPOINT) return status();
  if (url === keyEndpoint(1)) return keyPage();
  if (url.endsWith('/auth/me')) return { code: 0, data: { balance: 67.89123 } };
  if (url.endsWith('/subscriptions')) return { code: 0, data: [] };
  throw new Error('Unexpected INPUT fixture endpoint');
}
module.exports = { TOKEN, KEYS, status, keyPage, request };
