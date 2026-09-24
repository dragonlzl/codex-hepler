const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const https = require('node:https');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const vm = require('node:vm');
const { Availability, MODELS, REFRESH_MS, requestJson } = require('../availability');
const { MonitorAuth } = require('../monitor-auth');
const { loginEndpoints } = require('../account-sites');
const { BALANCE_ENDPOINT, SUBSCRIPTIONS_ENDPOINT, readInputSubscriptions } = require('../account-input');
const { ENDPOINT: BLACK_BALANCE } = require('../balance-blackaicoding');
const { start } = require('../../managed-relay-server');
const fixture = require('./monitor-login-fixture');
const LOGIN = loginEndpoints('input');
const PUBLIC = 'https://status.input.im/api/status';
const { ENDPOINT } = require('../availability-input');
const { keyEndpoint } = require('../input-key-groups');
const keys = [{ name: 'INPUT', baseurl: 'https://ai.input.im', value: 'sk-not-account-auth' },
  { name: 'INPUT backup', baseurl: 'https://ai.input.im/v1', value: 'sk-not-account-auth-2' }];
const credentials = { site: 'input', username: 'normal', password: fixture.PASSWORD };
async function homeFor(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-input-account-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  return home;
}

test('subscription parser preserves separate periods, balances, expiry and rolling reset windows without exposing profile fields', () => {
  const source = fixture.subscriptions();
  source.data[0].user = { email: 'private@example.invalid' };
  source.data[0].group.description = 'private-account-note';
  const result = readInputSubscriptions(source);
  assert.equal(result.items.length, 2);
  const active = result.items[0];
  assert.equal(active.name, 'Codex 高级订阅');
  assert.equal(active.state, 'active');
  assert.deepEqual(active.quotas.map(q => q.remaining), [63.75, 315, 1079.5]);
  assert.equal(active.quotas[0].resetsAt, Date.parse(source.data[0].daily_window_start) + 86400000);
  assert.equal(active.quotas[1].resetsAt, Date.parse(source.data[0].weekly_window_start) + 7 * 86400000);
  assert.equal(active.quotas[2].resetsAt, Date.parse(source.data[0].monthly_window_start) + 30 * 86400000);
  assert.equal(result.items[1].quotas[0].remaining, 0);
  assert.equal(result.items[1].quotas[0].endsWithSubscription, true);
  assert.equal(result.items[1].quotas[0].resetsAt, result.items[1].expiresAt);
  assert.ok(!JSON.stringify(result).includes('private'));
});

test('empty, unlimited, future and expired subscriptions remain distinct; missing usage is not fabricated as zero', () => {
  assert.deepEqual(readInputSubscriptions({ code: 0, data: [] }), { items: [] });
  const source = fixture.subscriptions();
  source.data = [source.data[0]];
  source.data[0].daily_usage_usd = null;
  let item = readInputSubscriptions(source).items[0];
  assert.equal(item.quotas[0].used, null); assert.equal(item.quotas[0].remaining, null);
  source.data[0].daily_usage_usd = 125;
  assert.equal(readInputSubscriptions(source).items[0].quotas[0].remaining, 0);
  source.data[0].group = { name: 'Unlimited', daily_limit_usd: 0 };
  source.data[0].expires_at = null;
  item = readInputSubscriptions(source).items[0];
  assert.equal(item.expiresAt, null); assert.deepEqual(item.quotas, []);
  source.data[0].starts_at = new Date(Date.now() + 86400000).toISOString();
  assert.equal(readInputSubscriptions(source).items[0].state, 'pending');
  source.data[0].expires_at = new Date(Date.now() - 86400000).toISOString();
  assert.equal(readInputSubscriptions(source).items[0].state, 'expired');
  for (const mutate of [s => { s.code = 1; }, s => { s.data = {}; }, s => { s.data[0].group.daily_limit_usd = '100'; },
    s => { s.data[0].weekly_usage_usd = -1; }, s => { s.data[0].expires_at = 'wrong'; }, s => { s.data.push(s.data[0]); }]) {
    const bad = fixture.subscriptions(); mutate(bad); assert.throws(() => readInputSubscriptions(bad));
  }
});

test('INPUT monitor requires account login and makes no unauthenticated requests', async t => {
  const calls = [];
  const monitor = new Availability({}, { request: async (url, options) => {
    calls.push(url); assert.equal(options.token, undefined); return fixture.request(url, options);
  } });
  t.after(() => monitor.close());
  const row = (await monitor.snapshot(keys)).rows[0];
  assert.equal(row.state, 'auth-required');
  assert.equal(row.authorizationSite, 'input');
  assert.equal(row.balance.state, 'auth-required');
  assert.equal(row.subscriptions.state, 'auth-required');
  assert.deepEqual(calls, []);
});

test('INPUT password login verifies auth/me, stores auth_token separately and refreshes balance/subscriptions once per 15 seconds', async t => {
  const home = await homeFor(t);
  let now = Date.now();
  const calls = [];
  const monitor = new Availability({}, { home, clock: () => now, request: async (url, options) => {
    calls.push(url);
    if (url === PUBLIC) assert.equal(options.token, undefined);
    else {
      assert.equal(options.site, 'input');
      if (url === LOGIN.login) assert.deepEqual(options.json, { email: 'normal', password: fixture.PASSWORD });
      else assert.equal(options.token, fixture.INPUT_TOKEN);
    }
    return fixture.request(url, options);
  } });
  t.after(() => monitor.close());
  const result = await monitor.login(credentials);
  assert.deepEqual(calls, [LOGIN.login, BALANCE_ENDPOINT]);
  assert.ok(!JSON.stringify(result).includes(fixture.INPUT_TOKEN));
  const input = new MonitorAuth(home, 'input'), black = new MonitorAuth(home);
  assert.equal((await input.read()).token, fixture.INPUT_TOKEN);
  assert.equal(await black.read(), null);
  assert.notEqual(input.file, black.file);
  assert.deepEqual(Object.keys(JSON.parse(await fs.readFile(input.file, 'utf8'))).sort(), ['expiresAt', 'token']);
  if (process.platform !== 'win32') assert.equal((await fs.stat(input.file)).mode & 0o777, 0o600);
  calls.length = 0;
  const responses = await Promise.all([monitor.snapshot(keys), monitor.snapshot(keys, MODELS[1])]);
  for (const response of responses) for (const row of response.rows) {
    assert.equal(row.balance.amount, 67.89123);
    assert.equal(row.subscriptions.items.length, 2);
    assert.equal(row.state, 'available');
  }
  assert.deepEqual(calls.sort(), [ENDPOINT, keyEndpoint(1), BALANCE_ENDPOINT, SUBSCRIPTIONS_ENDPOINT].sort());
  now += REFRESH_MS - 1; await monitor.snapshot(keys); assert.equal(calls.length, 4);
  now++; await monitor.snapshot(keys); assert.equal(calls.length, 8);
});

test('manual INPUT auth validates before save; clearing INPUT and two-factor challenges cannot affect code for me', async t => {
  const home = await homeFor(t);
  const monitor = new Availability({}, { home, request: fixture.request });
  t.after(() => monitor.close());
  await monitor.authorize('blackaicoding', fixture.TOKEN);
  await monitor.authorize('input', fixture.INPUT_TOKEN);
  await assert.rejects(monitor.authorize('input', fixture.TOKEN));
  assert.equal((await new MonitorAuth(home, 'input').read()).token, fixture.INPUT_TOKEN);
  const inputChallenge = await monitor.login({ ...credentials, username: 'otp' });
  const blackChallenge = await monitor.login({ ...credentials, site: 'blackaicoding', username: 'otp' });
  await assert.rejects(monitor.login({ site: 'blackaicoding', challengeId: inputChallenge.challengeId, code: '123456' }), error => error.status === 410);
  await monitor.authorize('input', '');
  assert.equal((await new MonitorAuth(home).read()).token, fixture.TOKEN);
  assert.equal(await new MonitorAuth(home, 'input').read(), null);
  assert.equal(monitor.loginClients.get('input').challenges.size, 0);
  assert.equal(monitor.loginClients.get('blackaicoding').challenges.size, 1);
  await monitor.login({ site: 'blackaicoding', challengeId: blackChallenge.challengeId, code: '123456' });
  const challenge = await monitor.login({ ...credentials, username: 'otp' });
  await assert.rejects(monitor.login({ site: 'input', challengeId: challenge.challengeId, code: '000000' }), /验证码无效/);
  await monitor.login({ site: 'input', challengeId: challenge.challengeId, code: '123456' });
  assert.equal((await new MonitorAuth(home, 'input').read()).token, fixture.INPUT_TOKEN);
  assert.throws(() => new MonitorAuth(home, '../other'));
});

test('subscription failures retain explicitly stale data while balance and monitor keep refreshing', async t => {
  let now = Date.now(), failure = 0;
  const monitor = new Availability({}, { clock: () => now, auths: { input: { read: async () => ({ token: fixture.INPUT_TOKEN }) } }, request: async (url, options) => {
    if (url === SUBSCRIPTIONS_ENDPOINT && failure) throw Object.assign(new Error('private input error'), { status: failure });
    return fixture.request(url, options);
  } });
  t.after(() => monitor.close());
  let row = (await monitor.snapshot(keys)).rows[0];
  const fetchedAt = row.subscriptions.fetchedAt;
  for (const [code, state] of [[503, 'stale'], [401, 'auth-required']]) {
    now += REFRESH_MS; failure = code;
    row = (await monitor.snapshot(keys)).rows[0];
    assert.equal(row.state, 'available'); assert.equal(row.balance.state, 'available');
    assert.equal(row.subscriptions.state, state);
    assert.equal(row.subscriptions.fetchedAt, fetchedAt);
    assert.equal(row.subscriptions.items.length, 2);
    assert.ok(!JSON.stringify(row).includes('private input error'));
  }
});

test('transport confines INPUT tokens and login bodies to that site and rejects redirects', async t => {
  let calls = 0;
  t.mock.method(https, 'get', (url, options) => {
    calls++; assert.equal(url, SUBSCRIPTIONS_ENDPOINT); assert.equal(options.headers.authorization, 'Bearer ' + fixture.INPUT_TOKEN);
    const req = new EventEmitter(); req.destroy = () => {};
    setImmediate(() => { const res = new PassThrough(); res.statusCode = 302; req.emit('response', res); res.end(); });
    return req;
  });
  const base = { outbound: { resolve: async () => ({}), agent: () => false }, signal: new AbortController().signal };
  const input = { ...base, site: 'input', token: fixture.INPUT_TOKEN };
  for (const url of [PUBLIC, BLACK_BALANCE, BALANCE_ENDPOINT + '?redirect=1', 'https://ai.input.im.evil.example/api/v1/auth/me']) {
    await assert.rejects(requestJson(url, input), /target rejected/);
  }
  await assert.rejects(requestJson(BALANCE_ENDPOINT, { ...base, token: fixture.TOKEN }), /target rejected/);
  await assert.rejects(requestJson(LOGIN.login, { ...base, json: { email: 'normal', password: fixture.PASSWORD } }), /target rejected/);
  await assert.rejects(requestJson(loginEndpoints('blackaicoding').login, { ...base, site: 'input', json: {} }), /target rejected/);
  assert.equal(calls, 0);
  await assert.rejects(requestJson(SUBSCRIPTIONS_ENDPOINT, input), error => error.status === 302);
  assert.equal(calls, 1);
});

test('local API supports INPUT login and manual authorization without returning secrets; clear removes both account resources', async t => {
  const home = await homeFor(t);
  await fs.writeFile(path.join(home, 'config.toml'), 'model_provider="relay"\n[model_providers.relay]\nbase_url="https://ai.input.im"\n');
  await fs.writeFile(path.join(home, 'key_config.json'), JSON.stringify({ keys }));
  const app = await start({ home, uiPort: 0, proxyPort: 0, availabilityOptions: { request: fixture.request }, log: () => {} });
  t.after(() => app.close());
  const post = (endpoint, payload, origin = app.uiUrl) => fetch(app.uiUrl + endpoint, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ name: keys[0].name, ...payload }) });
  assert.equal((await post('/api/availability/login', credentials, 'https://ai.input.im')).status, 403);
  const login = await post('/api/availability/login', credentials); assert.equal(login.status, 200);
  assert.ok(!(await login.text()).includes(fixture.INPUT_TOKEN));
  const snapshot = await (await fetch(app.uiUrl + '/api/availability')).json();
  assert.equal(snapshot.rows[0].balance.state, 'available');
  assert.equal(snapshot.rows[0].subscriptions.state, 'available');
  assert.ok(!JSON.stringify(snapshot).includes(fixture.INPUT_TOKEN));
  assert.equal((await post('/api/availability/authorization', { site: 'input', token: '' })).status, 200);
  const cleared = (await (await fetch(app.uiUrl + '/api/availability')).json()).rows[0];
  assert.equal(cleared.state, 'auth-required');
  assert.deepEqual(cleared.balance, { state: 'auth-required', fetchedAt: null });
  assert.deepEqual(cleared.subscriptions, { state: 'auth-required', fetchedAt: null });
  assert.equal((await post('/api/availability/authorization', { site: 'input', token: fixture.INPUT_TOKEN })).status, 200);
});

test('subscription UI escapes provider names and distinguishes missing auth, empty list, unlimited and stale data', async () => {
  const source = await fs.readFile(path.join(__dirname, '../../managed-relay-public/availability.js'), 'utf8');
  const context = vm.createContext({ Intl, Date, escapeHtml: value => String(value).replace(/[&<>"']/g, ch => '&#' + ch.charCodeAt(0) + ';') });
  vm.runInContext(source + '\nthis.View = RelayAvailability;', context);
  const view = Object.create(context.View.prototype); view.error = '';
  assert.match(view.subscriptionsMarkup({ state: 'auth-required' }), /需重新登录/);
  assert.doesNotMatch(view.subscriptionsMarkup({ state: 'auth-required' }), /暂无订阅/);
  assert.match(view.subscriptionsMarkup({ state: 'available', items: [] }), /暂无订阅/);
  const data = readInputSubscriptions(fixture.subscriptions());
  data.items[0].name = '<script>bad</script>';
  let html = view.subscriptionsMarkup({ ...data, state: 'available', fetchedAt: Date.now() });
  assert.ok(!html.includes('<script>')); assert.match(html, /剩余 \$63\.75/); assert.match(html, /已到期/);
  view.error = 'offline';
  html = view.subscriptionsMarkup({ ...data, state: 'available' });
  assert.match(html, /上次数据 · 刷新失败/);
  assert.equal(view.subscriptionsMarkup(undefined), '');
});
