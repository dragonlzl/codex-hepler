const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const https = require('node:https');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const vm = require('node:vm');
const { Availability, REFRESH_MS, MODELS, requestJson } = require('../availability');
const { MonitorAuth } = require('../monitor-auth');
const { KrillLogin } = require('../login-krill');
const krill = require('../account-krill');
const fixture = require('./krill-account-fixture');
const otherFixture = require('./monitor-login-fixture');
const { start } = require('../../managed-relay-server');
const keys = ['https://www.krill-code.com', 'https://api-slb.krill-code.net/codex/v1', 'https://api.cdn-krill-ai.com/coding/v1'].map((baseurl, i) => ({ name: 'Krill ' + i, baseurl, value: 'sk-not-account-token' }));
const credentials = { site: 'krill', username: 'normal', password: fixture.PASSWORD };
async function homeFor(t) { const home = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-krill-account-')); t.after(() => fs.rm(home, { recursive: true, force: true })); return home; }
const parse = (source, now = Date.now()) => krill.readKrillSubscriptions(source, now, '', { usage: krill.readKrillUsage(fixture.usage(), now) });

test('Krill balance parses decimal strings and zero/negative values without exposing personal data', () => {
  for (const value of ['0', '-2.50', '88.125', 0, 3.5]) assert.deepEqual(krill.readKrillBalance(fixture.wrap({ balance_usd: value, email: 'private' })), { amount: Number(value), currency: 'USD' });
  for (const value of ['', null, false, '1e9', Infinity, 'bad']) assert.throws(() => krill.readKrillBalance(fixture.wrap({ balance_usd: value })));
  assert.throws(() => krill.readKrillBalance({ success: false, code: 0, data: { balance_usd: '1' } }));
  assert.deepEqual(krill.readKrillIdentity(fixture.wrap({ id: 456, email: 'private' })), { userId: 456 });
});

test('current quotas and seven-day statistics are distinct, frozen state survives, expired plans are excluded', () => {
  const now = Date.now(), result = parse(fixture.subscriptions(now), now);
  assert.deepEqual(result.items.map(item => item.id), [201, 202]);
  assert.equal(result.windowEndAt - result.windowStartAt, 7 * 86400000);
  assert.deepEqual(result.items[0].quotas.map(q => q.period), ['carryover', 'weekly', 'total', 'recent7d']);
  assert.deepEqual(result.items[0].quotas.map(q => q.remaining), [15, 63.75, 280, 14.25]);
  assert.equal(result.items[0].quotas.at(-1).remainingLabel, '区间余量');
  assert.equal(result.items[1].state, 'frozen');
  assert.equal(result.items[1].quotas.length, 1);
  const body = krill.usageBody(now);
  assert.equal(Date.parse(body.end_time) - Date.parse(body.start_time), 7 * 86400000);
  const empty = fixture.subscriptions(now); empty.data.subscriptions = [];
  assert.deepEqual(parse(empty, now).items, []);
  assert.throws(() => krill.readKrillUsage(fixture.wrap({ items: [fixture.usage().data.items[0], fixture.usage().data.items[0]] }), now));
});

test('request-count, credit, daily and monthly quotas retain their units; missing statistics stay unknown', () => {
  const source = fixture.subscriptions(); source.data.subscriptions = [source.data.subscriptions[0]];
  const item = source.data.subscriptions[0];
  item.plan.billing_type = 'request_count';
  source.data.request_count_quota = { used_5h: 5, limit_5h: 10, used_weekly: 30, limit_weekly: 50, used_monthly: 80, limit_monthly: 100 };
  let result = parse(source).items[0];
  assert.ok(result.quotas.slice(0, 3).every(q => q.unit === 'requests'));
  assert.deepEqual(result.quotas.slice(0, 3).map(q => q.remaining), [5, 20, 20]);
  item.plan.billing_type = 'usd_monthly'; item.quota = { used_usd: '20', daily_limit_usd: '100' };
  result = parse(source).items[0]; assert.equal(result.quotas[0].period, 'total'); assert.equal(result.quotas[0].remaining, 80);
  item.plan.billing_type = 'usd_daily'; item.total_used_usd = '15'; item.total_limit_usd = '30';
  assert.equal(parse(source).items[0].quotas[0].remaining, 15);
  item.quota = { limit_credits: 200, remaining_credits: 120 };
  result = parse(source).items[0]; assert.equal(result.quotas[0].unit, 'credits'); assert.equal(result.quotas[0].used, 80);
  result = krill.readKrillSubscriptions(source, Date.now(), '', { usage: krill.readKrillUsage(fixture.wrap({ items: [] }), Date.now()) }).items[0];
  assert.equal(result.quotas.at(-1).used, null); assert.equal(result.quotas.at(-1).limit, null);
});

test('Krill login normalizes token and TOTP protocol, validates before persisting, and isolates credentials', async t => {
  const home = await homeFor(t), calls = [];
  const monitor = new Availability({}, { home, request: async (url, options) => { calls.push(url); return fixture.request(url, options); } });
  t.after(() => monitor.close());
  await assert.rejects(monitor.login({ ...credentials, password: 'wrong' }), /账号或密码/);
  calls.length = 0;
  const result = await monitor.login(credentials);
  assert.deepEqual(calls, [fixture.LOGIN.login, krill.IDENTITY_ENDPOINT]);
  assert.ok(!JSON.stringify(result).includes(fixture.TOKEN));
  const auth = new MonitorAuth(home, 'krill');
  assert.equal((await auth.read()).token, fixture.TOKEN);
  assert.deepEqual(Object.keys(JSON.parse(await fs.readFile(auth.file, 'utf8'))).sort(), ['expiresAt', 'token']);
  if (process.platform !== 'win32') assert.equal((await fs.stat(auth.file)).mode & 0o777, 0o600);
  assert.equal(await new MonitorAuth(home, 'input').read(), null);
  await assert.rejects(monitor.authorize('krill', otherFixture.INPUT_TOKEN));
  assert.equal((await auth.read()).token, fixture.TOKEN);
  const challenge = await monitor.login({ ...credentials, username: 'otp' });
  assert.ok(!JSON.stringify(challenge).includes(fixture.PENDING));
  await assert.rejects(monitor.login({ site: 'input', challengeId: challenge.challengeId, code: '123456' }), error => error.status === 410);
  await assert.rejects(monitor.login({ site: 'krill', challengeId: challenge.challengeId, code: '000000' }), /验证码无效/);
  await monitor.login({ site: 'krill', challengeId: challenge.challengeId, code: '123456' });
  assert.equal(monitor.loginClients.get('krill').challenges.size, 0);
});

test('Krill TOTP challenges cancel and expire and ignore provider error text', async () => {
  let now = Date.now(); const client = new KrillLogin(fixture.request, () => now), signal = new AbortController().signal;
  for (const invalidate of [id => client.cancel(id), () => { now += 300001; }]) {
    const challenge = await client.login({ ...credentials, username: 'otp' }, signal); invalidate(challenge.challengeId);
    await assert.rejects(client.login({ challengeId: challenge.challengeId, code: '123456' }, signal), error => error.status === 410);
  }
  await assert.rejects(new KrillLogin(async () => ({ success: false, code: 1, message: 'private-password' })).login(credentials, signal), error => !error.message.includes('private-password'));
  client.clear();
});

test('public status requires no login; wallet data and seven-day POST queries are cached across routes and models', async t => {
  let now = Date.now(), credential = null; const calls = [];
  const monitor = new Availability({}, { clock: () => now, auths: { krill: { read: async () => credential } }, request: async (url, options) => {
    calls.push(url);
    if (url === fixture.PUBLIC) assert.equal(options.token, undefined);
    else { assert.equal(options.token, fixture.TOKEN); assert.equal(options.site, 'krill'); }
    if (url === krill.USAGE_ENDPOINT) assert.deepEqual(options.json, krill.usageBody(now));
    return fixture.request(url, options);
  } }); t.after(() => monitor.close());
  let row = (await monitor.snapshot(keys)).rows[0];
  assert.equal(row.state, 'available'); assert.equal(row.balance.state, 'auth-required'); assert.equal(row.subscriptions.state, 'auth-required');
  assert.deepEqual(calls, [fixture.PUBLIC]);
  credential = { token: fixture.TOKEN }; now += REFRESH_MS; calls.length = 0;
  const results = await Promise.all([monitor.snapshot(keys), monitor.snapshot(keys, MODELS[1])]);
  for (const result of results) for (const row of result.rows) {
    assert.equal(row.balance.amount, 88.125); assert.equal(row.subscriptions.items.length, 2);
  }
  assert.deepEqual(calls.sort(), [fixture.PUBLIC, krill.BALANCE_ENDPOINT, krill.SUBSCRIPTIONS_ENDPOINT, krill.USAGE_ENDPOINT].sort());
  now += REFRESH_MS - 1; await monitor.snapshot(keys); assert.equal(calls.length, 4);
  now++; await monitor.snapshot(keys); assert.equal(calls.length, 8);
});

test('failed or unauthorized usage leaves previous packages marked stale without breaking balance/public monitoring', async t => {
  let now = Date.now(), failure = 0;
  const monitor = new Availability({}, { clock: () => now, auths: { krill: { read: async () => ({ token: fixture.TOKEN }) } }, request: async (url, options) => {
    if (url === krill.USAGE_ENDPOINT && failure) throw Object.assign(new Error('private upstream'), { status: failure });
    return fixture.request(url, options);
  } }); t.after(() => monitor.close());
  const initial = (await monitor.snapshot(keys)).rows[0];
  for (const [code, state] of [[500, 'stale'], [401, 'auth-required']]) {
    failure = code; now += REFRESH_MS;
    const row = (await monitor.snapshot(keys)).rows[0];
    assert.equal(row.balance.state, 'available'); assert.equal(row.state, 'available');
    assert.equal(row.subscriptions.state, state); assert.equal(row.subscriptions.fetchedAt, initial.subscriptions.fetchedAt);
    assert.ok(!JSON.stringify(row).includes('private upstream'));
  }
});

test('protected read-only POST accepts only fixed Krill usage endpoint, seven-day filter and that site token', async t => {
  let calls = 0, status = 200;
  t.mock.method(https, 'request', (url, options) => {
    calls++; assert.equal(url, krill.USAGE_ENDPOINT); assert.equal(options.method, 'POST');
    assert.equal(options.headers.authorization, 'Bearer ' + fixture.TOKEN);
    assert.equal(options.headers.cookie, undefined); assert.equal(options.headers['X-Enterprise-Id'], undefined);
    const req = new EventEmitter(); req.destroy = () => {}; req.end = body => {
      assert.deepEqual(Object.keys(JSON.parse(body)).sort(), ['end_time', 'start_time']);
      setImmediate(() => { const res = new PassThrough(); res.statusCode = status; req.emit('response', res); res.end(JSON.stringify(fixture.usage())); });
    }; return req;
  });
  const base = { site: 'krill', token: fixture.TOKEN, json: krill.usageBody(Date.now()), signal: new AbortController().signal, outbound: { resolve: async () => ({}), agent: () => false } };
  for (const url of [fixture.PUBLIC, fixture.LOGIN.login, 'https://www.krill-code.com/api/subscription/reset-credits', 'https://ai.input.im/api/v1/auth/me', krill.USAGE_ENDPOINT + '?x=1']) await assert.rejects(requestJson(url, base), /target rejected/);
  await assert.rejects(requestJson(krill.USAGE_ENDPOINT, { ...base, site: 'input' }), /target rejected/);
  await assert.rejects(requestJson(krill.USAGE_ENDPOINT, { ...base, json: { ...base.json, action: 'reset' } }), /Invalid usage query/);
  await assert.rejects(requestJson(krill.USAGE_ENDPOINT, { ...base, json: undefined }), /Invalid usage query/);
  assert.equal(calls, 0);
  await requestJson(krill.USAGE_ENDPOINT, base);
  status = 302; await assert.rejects(requestJson(krill.USAGE_ENDPOINT, base), error => error.status === 302);
  assert.equal(calls, 2);
});

test('local Krill login and manual token API expose no credentials; clearing wipes cached usage and keeps other sites', async t => {
  const home = await homeFor(t), logs = [];
  await fs.writeFile(path.join(home, 'config.toml'), 'model_provider="relay"\n[model_providers.relay]\nbase_url="https://www.krill-code.com"\n');
  await fs.writeFile(path.join(home, 'key_config.json'), JSON.stringify({ keys }));
  await new MonitorAuth(home, 'input').save(otherFixture.INPUT_TOKEN);
  const app = await start({ home, uiPort: 0, proxyPort: 0, availabilityOptions: { request: fixture.request }, log: item => logs.push(item) }); t.after(() => app.close());
  const post = (endpoint, body, origin = app.uiUrl) => fetch(app.uiUrl + endpoint, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ name: keys[0].name, ...body }) });
  assert.equal((await post('/api/availability/login', credentials, 'https://www.krill-code.com')).status, 403);
  const response = await post('/api/availability/login', credentials); assert.equal(response.status, 200); const result = await response.json();
  const snapshot = await (await fetch(app.uiUrl + '/api/availability')).json();
  assert.equal(snapshot.rows[0].balance.amount, 88.125);
  for (const secret of [fixture.TOKEN, fixture.PASSWORD, fixture.PENDING, 'private@example.invalid']) assert.ok(!JSON.stringify({ result, snapshot, logs }).includes(secret));
  assert.equal((await post('/api/availability/authorization', { site: 'krill', token: '' })).status, 200);
  const cleared = (await (await fetch(app.uiUrl + '/api/availability')).json()).rows[0];
  assert.equal(cleared.state, 'available'); assert.deepEqual(cleared.subscriptions, { fetchedAt: null, state: 'auth-required' });
  assert.equal((await new MonitorAuth(home, 'input').read()).token, otherFixture.INPUT_TOKEN);
  assert.equal((await post('/api/availability/authorization', { site: 'krill', token: fixture.TOKEN })).status, 200);
});

test('Krill UI labels current vs seven-day quotas, escapes names, and never renders count quotas as dollars', async () => {
  const source = await fs.readFile(path.join(__dirname, '../../managed-relay-public/availability.js'), 'utf8');
  const context = vm.createContext({ Intl, Date, escapeHtml: value => String(value).replace(/[&<>"']/g, c => '&#' + c.charCodeAt(0) + ';') });
  vm.runInContext(source + '\nthis.View = RelayAvailability;', context); const view = Object.create(context.View.prototype); view.error = '';
  const data = parse(fixture.subscriptions()); data.items[0].name = '<b>name</b>';
  let html = view.subscriptionsMarkup({ ...data, state: 'available' });
  assert.ok(!html.includes('<b>')); assert.match(html, /近 7 天统计/); assert.match(html, /区间余量/); assert.match(html, /已冻结/);
  data.items[0].quotas = [{ period: 'requests5h', used: 5, limit: 10, remaining: 5, unit: 'requests', resetLabel: '账号共享请求次数额度' }];
  html = view.subscriptionsMarkup({ ...data, items: [data.items[0]], state: 'available' });
  assert.match(html, /5 次 \/ 10 次/); assert.ok(!html.includes('$'));
  data.items[0].quotas = [{ period: 'recent7d', used: null, limit: null, remaining: null, resetLabel: '统计区间' }];
  html = view.subscriptionsMarkup({ ...data, state: 'available' }); assert.match(html, /已用 — \/ —/); assert.ok(!html.includes('NaN'));
});
