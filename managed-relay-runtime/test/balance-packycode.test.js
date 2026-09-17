const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const https = require('node:https');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const vm = require('node:vm');
const { PackyBalance, DEFAULTS, USAGE_PATH, normalizeApiBaseUrl, validateConfig, parsePackyUsage, retryAfter, requestPackyUsage } = require('../balance-packycode');
const { adapterFor } = require('../availability');
const { start } = require('../../managed-relay-server');
const KEY = 'sk-packy-private-fixture';
const payload = () => ({ code: true, data: { name: '示例 Key', total_available: 200000000, total_granted: 250000000, total_used: 90000000, unlimited_quota: false } });
const entry = (name = 'Packy', value = KEY) => ({ name, baseurl: 'https://cf.api.fan/v1', value });
const tick = () => new Promise(resolve => setImmediate(resolve));
const make = (options = {}) => new PackyBalance({ outbound: {}, getEntry: async name => entry(name), isPacky: base => adapterFor(base)?.id === 'packycode', wait: async () => {}, ...options });
async function settled(manager, name = 'Packy') {
  await manager.read(name);
  for (let i = 0; i < 100; i++) { await tick(); const row = await manager.read(name); if (!row.refreshing) return row; }
  throw new Error('Fixture did not settle');
}
async function homeFor(t) { const home = await fs.mkdtemp(path.join(os.tmpdir(), 'packy-balance-')); t.after(() => fs.rm(home, { recursive: true, force: true })); return home; }

test('normalization preserves the configured host and path while stripping known suffixes once', () => {
  for (const suffix of ['', '/', '///', '/v1', '/v1/', '/api/usage/token/', '/v1/api/usage/token/']) assert.equal(normalizeApiBaseUrl('https://slb-v1.api.fan' + suffix), DEFAULTS.api_base_url);
  assert.equal(normalizeApiBaseUrl('https://example.com/prefix/v1/'), 'https://example.com/prefix');
  assert.equal(normalizeApiBaseUrl(' https://www.packyapi.com/API/USAGE/TOKEN/ '), 'https://www.packyapi.com');
  for (const url of ['http://slb-v1.api.fan', 'https://user:pass@example.com', 'https://example.com?a=1', 'https://example.com#key', 'invalid']) assert.throws(() => normalizeApiBaseUrl(url));
  assert.deepEqual(validateConfig({}), DEFAULTS);
  assert.throws(() => validateConfig({ request_timeout_seconds: 0 }));
  assert.throws(() => validateConfig({ refresh_interval_seconds: 0 }));
  assert.equal(adapterFor('https://slb-v1.api.fan/v1').id, 'packycode');
});

test('parser uses available quota directly, supports aliases/root/numeric strings and retains precision', () => {
  const expected = { amount: 400, maximum: 500, usedAmount: 180, remainingPercent: 80, unlimited: false, currency: 'USD', tokenName: '示例 Key' };
  assert.deepEqual(parsePackyUsage(payload()), expected);
  assert.notEqual(expected.amount, expected.maximum - expected.usedAmount);
  assert.deepEqual(parsePackyUsage({ token_name: '示例 Key', totalAvailable: '2e8', totalGranted: '250000000', totalUsed: '90000000' }), expected);
  assert.equal(parsePackyUsage({ total_granted: 250000000, data: { total_available: 1, total_used: 0 } }).amount, .000002);
  assert.equal(parsePackyUsage({ data: { total_available: 1234567.89, total_granted: 0 } }).amount, 2.46913578);
  assert.equal(parsePackyUsage({ total_available: 0, total_granted: 0 }).remainingPercent, null);
  assert.equal(parsePackyUsage({ total_available: 10, total_granted: 5 }).remainingPercent, 100);
  assert.equal(parsePackyUsage({ total_available: 0, total_granted: 5 }).remainingPercent, 0);
});

test('finite quotas reject errors, missing remaining fields, negative/nonfinite/invalid values; unlimited skips sentinel conversion', () => {
  for (const body of [null, [], {}, { code: false, ...payload(), data: payload().data, code: false }, { data: { ...payload().data, error: null } }, { error: 'private', data: payload().data }]) assert.throws(() => parsePackyUsage(body));
  for (const value of [undefined, null, '', false, 'bad', '-1', Infinity, '1e999']) {
    const body = payload(); body.data.total_available = value; assert.throws(() => parsePackyUsage(body));
  }
  for (const field of ['total_granted', 'total_used']) { const body = payload(); body.data[field] = -1; assert.throws(() => parsePackyUsage(body)); }
  const unlimited = parsePackyUsage({ unlimited_quota: true, total_available: -1 });
  assert.equal(unlimited.unlimited, true); assert.equal(unlimited.amount, null); assert.equal(unlimited.maximum, null); assert.equal(unlimited.remainingPercent, null);
});

test('GET transport uses only the configured endpoint, no body, bounded response and no redirects', async t => {
  let calls = 0, status = 200, content = JSON.stringify(payload());
  const endpoint = 'https://slb-v1.api.fan' + USAGE_PATH;
  t.mock.method(https, 'get', (url, options) => {
    calls++; assert.equal(url, endpoint); assert.equal(options.headers.authorization, 'Bearer ' + KEY); assert.equal(options.headers.accept, 'application/json');
    assert.equal(options.headers.cookie, undefined); assert.equal(options.headers['content-length'], undefined);
    const req = new EventEmitter(); req.destroy = () => {};
    setImmediate(() => { const res = new PassThrough(); res.statusCode = status; res.headers = { 'retry-after': '90', location: 'https://other.example' }; req.emit('response', res); res.end(content); });
    return req;
  });
  const options = { apiKey: KEY, outbound: { resolve: async () => ({}), agent: () => false }, signal: new AbortController().signal };
  assert.deepEqual(await requestPackyUsage(endpoint, options), payload());
  status = 302; await assert.rejects(requestPackyUsage(endpoint, options), error => error.status === 302); assert.equal(calls, 2);
  status = 429; await assert.rejects(requestPackyUsage(endpoint, options), error => error.retryAfterSeconds === 60);
  status = 200; content = 'not JSON'; await assert.rejects(requestPackyUsage(endpoint, options), /Invalid Packycode JSON/);
  content = ' '.repeat(1024 * 1024 + 1); await assert.rejects(requestPackyUsage(endpoint, options), /too large/);
  await assert.rejects(requestPackyUsage('https://slb-v1.api.fan/api/other', options), /endpoint/);
  await assert.rejects(requestPackyUsage(endpoint, { ...options, apiKey: 'secret\r\nInjected: yes' }), /API Key/);
});

test('background cache merges concurrent and duplicate-key queries, isolates keys and refetches after rotation or thirty minutes', async t => {
  let now = Date.now(), apiKey = KEY, release;
  const calls = [];
  const gate = new Promise(resolve => { release = resolve; });
  const manager = make({ clock: () => now, getEntry: async name => entry(name, name === 'Other' ? 'sk-other-private' : apiKey), request: async (url, options) => {
    calls.push(options.apiKey); await gate; const body = payload(); body.data.total_available = options.apiKey === KEY ? 200000000 : 500000; return body;
  } }); t.after(() => manager.close());
  const rows = await Promise.all([manager.read('Packy'), manager.read('Duplicate'), manager.read('Packy', { force: true }), manager.read('Other')]);
  assert.ok(rows.every(row => row.refreshing)); assert.equal(calls.length, 2);
  release();
  let row = await settled(manager); assert.equal(row.amount, 400); assert.equal((await settled(manager, 'Other')).amount, 1);
  now += 1799999; await manager.read('Duplicate'); assert.equal(calls.length, 2);
  now++; await settled(manager); assert.equal(calls.length, 3);
  await manager.read('Packy', { force: true }); await settled(manager); assert.equal(calls.length, 4);
  apiKey = 'sk-rotated-private'; row = await manager.read('Packy'); assert.equal(row.amount, undefined);
  assert.equal((await settled(manager)).amount, 1); assert.equal(calls.length, 5);
});

test('retries follow 1/3/5 seconds, honor bounded Retry-After and preserve last success on failure without secrets', async t => {
  let fail = false, calls = 0; const waits = [];
  const manager = make({ request: async () => { calls++; if (fail) throw Object.assign(new Error(KEY), { status: 503 }); return payload(); }, wait: async ms => { waits.push(ms); } });
  t.after(() => manager.close());
  const before = await settled(manager);
  fail = true; await manager.read('Packy', { force: true }); const failed = await settled(manager);
  assert.deepEqual(waits, [1000, 3000, 5000]); assert.equal(calls, 5);
  assert.equal(failed.amount, 400); assert.equal(failed.state, 'stale'); assert.equal(failed.fetchedAt, before.fetchedAt); assert.match(failed.message, /503/); assert.ok(!JSON.stringify(failed).includes(KEY));
  let now = Date.now(); const limitedWaits = [];
  const limited = make({ clock: () => now, request: async () => { throw Object.assign(new Error(KEY), { status: 429, retryAfterSeconds: 90 }); }, wait: async ms => { limitedWaits.push(ms); now += ms; } });
  t.after(() => limited.close()); const denied = await settled(limited);
  assert.deepEqual(limitedWaits, [60000, 60000, 60000]); assert.equal(denied.state, 'error'); assert.equal(denied.amount, undefined);
  await limited.read('Packy', { force: true }); assert.equal(limitedWaits.length, 3); // Final Retry-After also gates manual refresh.
  assert.equal(retryAfter('3.5'), 3.5); for (const value of [undefined, 'date', 0, -1, Infinity]) assert.equal(retryAfter(value), null);
});

test('settings persist without keys; changing endpoint aborts retries and clears previous endpoint cache', async t => {
  const home = await homeFor(t); let oldSignal;
  const manager = make({ home, request: async (url, { signal }) => {
    if (url.startsWith(DEFAULTS.api_base_url)) { oldSignal = signal; return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })); }
    return payload();
  } }); t.after(() => manager.close());
  await manager.read('Packy'); assert.ok(oldSignal && !oldSignal.aborted);
  const result = await manager.saveSettings({ api_base_url: 'https://www.packyapi.com/v1/', request_timeout_seconds: 5, refresh_interval_seconds: 600 });
  assert.equal(oldSignal.aborted, true); assert.equal(result.settings.api_base_url, 'https://www.packyapi.com');
  assert.equal((await settled(manager)).amount, 400);
  const disk = await fs.readFile(manager.file, 'utf8'); assert.ok(!disk.includes(KEY)); assert.ok(!disk.includes('api_keys'));
  if (process.platform !== 'win32') assert.equal((await fs.stat(manager.file)).mode & 0o777, 0o600);
  const reloaded = make({ home, request: async () => payload() }); t.after(() => reloaded.close());
  assert.deepEqual(await reloaded.settings(), result.settings);
  await assert.rejects(manager.saveSettings({ api_base_url: 'http://insecure.example' }));
  assert.deepEqual(await manager.settings(), result.settings);
});

test('shutdown cancels a retry wait and stalled route resolution, without late balance writes', async t => {
  let signal, calls = 0;
  const manager = make({ request: async () => { calls++; throw new Error(KEY); }, wait: (ms, abort) => {
    signal = abort; return new Promise((resolve, reject) => abort.addEventListener('abort', () => reject(new Error('closed')), { once: true }));
  } }); t.after(() => manager.close());
  await manager.read('Packy'); await tick(); assert.ok(signal && !signal.aborted);
  manager.close(); await tick(); assert.equal(signal.aborted, true); assert.equal(calls, 1); assert.equal(manager.cache.size, 0);
  await assert.rejects(manager.read('Packy'));
  const controller = new AbortController();
  const pending = requestPackyUsage(DEFAULTS.api_base_url + USAGE_PATH, { apiKey: KEY, outbound: { resolve: () => new Promise(() => {}) }, signal: controller.signal });
  controller.abort(new Error('deadline')); await assert.rejects(pending, /deadline/);
});

test('local server queries saved Packycode keys only, protects settings and refresh routes, and exposes no credentials', async t => {
  const home = await homeFor(t), logs = [], calls = [];
  await fs.writeFile(path.join(home, 'config.toml'), 'model_provider="relay"\n[model_providers.relay]\nbase_url="https://cf.api.fan/v1"\n');
  await fs.writeFile(path.join(home, 'key_config.json'), JSON.stringify({ keys: [entry(), entry('Duplicate'), { name: 'Other', value: 'sk-other', baseurl: 'https://example.com' }] }));
  const app = await start({ home, uiPort: 0, proxyPort: 0, log: value => logs.push(value), availabilityOptions: { request: async url => ({ success: true, data: { model_name: new URL(url).searchParams.get('model'), groups: [] } }),
    packyBalanceOptions: { request: async (url, { apiKey }) => { calls.push({ url, apiKey }); const result = payload(); result.data.name = KEY; return result; }, wait: async () => {} } } });
  t.after(() => app.close());
  const post = (url, data, origin = app.uiUrl) => fetch(app.uiUrl + url, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify(data) });
  const first = await (await fetch(app.uiUrl + '/api/availability')).json(); await tick();
  const snapshot = await (await fetch(app.uiUrl + '/api/availability')).json();
  assert.equal(snapshot.rows[0].balance.amount, 400); assert.equal(calls.length, 1); assert.equal(calls[0].apiKey, KEY); assert.equal(calls[0].url, DEFAULTS.api_base_url + USAGE_PATH);
  assert.equal(snapshot.rows[0].balance.tokenName, '[已隐藏]'); assert.equal(snapshot.rows[2].balance, undefined);
  assert.equal((await post('/api/packycode/balance/refresh', { name: 'Other' })).status, 400);
  assert.equal((await post('/api/packycode/balance/settings', { api_base_url: 'https://www.packyapi.com' }, 'https://evil.example')).status, 403);
  assert.equal((await post('/api/packycode/balance/refresh', { name: 'Packy' }, 'https://evil.example')).status, 403);
  const refresh = await post('/api/packycode/balance/refresh', { name: 'Packy' }); assert.equal(refresh.status, 200);
  const refreshBody = await refresh.json(); await tick(); assert.equal(calls.length, 2);
  const saved = await post('/api/packycode/balance/settings', { api_base_url: 'https://slb-v1.api.fan/v1/api/usage/token/' }); assert.equal(saved.status, 200);
  const config = await (await fetch(app.uiUrl + '/api/packycode/balance/settings')).json(); assert.deepEqual(config.settings, DEFAULTS);
  assert.ok(!JSON.stringify({ first, snapshot, refreshBody, config, logs }).includes(KEY));
});

test('Packycode UI distinguishes unlimited, unknown and stale balances and formats only at display time', async () => {
  const source = await fs.readFile(path.join(__dirname, '../../managed-relay-public/availability.js'), 'utf8');
  const context = vm.createContext({ Intl, Date, escapeHtml: value => String(value).replace(/[&<>"']/g, c => '&#' + c.charCodeAt(0) + ';') });
  vm.runInContext(source + '\nthis.View = RelayAvailability;', context); const view = Object.create(context.View.prototype); view.error = '';
  let html = view.balanceMarkup({ kind: 'packy-key', ...parsePackyUsage(payload()), state: 'available', fetchedAt: Date.now(), refreshMs: 1800000 });
  assert.match(html, /\$400\.00 \/ \$500\.00/); assert.match(html, /80\.00%/); assert.match(html, /30 分钟/); assert.match(html, /刷新余额/);
  html = view.balanceMarkup({ kind: 'packy-key', ...parsePackyUsage({ unlimited_quota: true, total_available: -1 }), state: 'available' });
  assert.match(html, /无限额度/); assert.ok(!html.includes('$-'));
  html = view.balanceMarkup({ kind: 'packy-key', state: 'error', message: 'HTTP 403' }); assert.match(html, /— \/ —/); assert.ok(!html.includes('$0.00'));
  html = view.balanceMarkup({ kind: 'packy-key', ...parsePackyUsage(payload()), tokenName: '<script>bad</script>', state: 'stale', message: 'HTTP 429' });
  assert.match(html, /上次余额/); assert.match(html, /400\.00/); assert.ok(!html.includes('<script>'));
});
