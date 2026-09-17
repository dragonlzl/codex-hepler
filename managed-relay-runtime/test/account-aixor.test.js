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
const { AixorLogin, mergeCookies } = require('../login-aixor');
const aixor = require('../account-aixor');
const fixture = require('./aixor-account-fixture');
const jwtFixture = require('./monitor-login-fixture');
const { start } = require('../../managed-relay-server');
const keys = [{ name: 'Aixor', baseurl: 'https://aixor.org/v1', value: 'sk-not-session' }, { name: 'Aixor backup', baseurl: 'https://aixor.cc/v1' }];
const credentials = { site: 'aixor', username: 'normal', password: fixture.PASSWORD, agreement: true };
const deps = { settings: { scale: 500000 }, plans: { 7: 'Premium-gpt 月度套餐' } };
async function homeFor(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-aixor-'));
  t.after(() => fs.rm(home, { recursive: true, force: true })); return home;
}

test('wallet quota conversion follows the site scale and keeps zero/negative balances without account fields', () => {
  assert.deepEqual(aixor.readAixorSettings({ success: true, data: { quota_per_unit: 500000, quota_display_type: 'USD' } }), deps.settings);
  for (const quota of [0, -500000, 12345678]) assert.deepEqual(aixor.readAixorBalance({ success: true, data: { id: 123, quota, email: 'private' } }, Date.now(), '', deps), { amount: quota / 500000, currency: 'USD' });
  assert.throws(() => aixor.readAixorSettings({ success: true, data: { quota_per_unit: 0, quota_display_type: 'USD' } }));
  assert.throws(() => aixor.readAixorBalance({ success: true, data: { id: 123, quota: null } }, Date.now(), '', deps));
  assert.throws(() => aixor.readAixorIdentity({ success: false, code: 'AUTH_TOKEN_EXPIRED' }), error => error.status === 401);
});

test('only nonexpired, noncancelled subscriptions survive; quota totals and reset times match the wallet', () => {
  const now = Date.now();
  const result = aixor.readAixorSubscriptions(fixture.subscriptions(now), now, '', deps);
  assert.deepEqual(result.items.map(item => item.id), [1, 5]);
  assert.equal(result.hideExpired, true);
  assert.equal(result.items[0].name, 'Premium-gpt 月度套餐');
  assert.deepEqual(result.items[0].quotas[0], { period: 'total', limit: 100, used: 25, remaining: 75,
    resetsAt: (Math.floor(now / 1000) + 3600) * 1000, noReset: false });
  assert.deepEqual(result.items[1].quotas, []);
  assert.equal(result.items[1].unlimitedLabel, '不限总额度');
  assert.equal(aixor.readAixorSubscriptions(fixture.subscriptions(now), now, '', { ...deps, plans: null }).items[0].name, '订阅 #1');
  const source = fixture.subscriptions(now);
  source.data.all_subscriptions[0].subscription.amount_used = 75000000;
  assert.equal(aixor.readAixorSubscriptions(source, now, '', deps).items[0].quotas[0].remaining, 0);
  source.data.all_subscriptions[0].subscription.end_time = Math.floor(now / 1000);
  assert.deepEqual(aixor.readAixorSubscriptions(source, now, '', deps).items.map(item => item.id), [5]);
  assert.throws(() => aixor.readAixorSubscriptions({ success: true, data: {} }, now, '', deps));
});

test('Cookie input rejects header injection, malformed IDs and traversal; cookie updates retain only destination-scoped values', () => {
  assert.deepEqual(aixor.validateAixorSession({ cookie: fixture.COOKIE, userId: '123' }), { cookie: fixture.COOKIE, userId: 123, expiresAt: null });
  for (const cookie of ['', 'Cookie: ' + fixture.COOKIE, 'session=x\r\nOther: bad', 'session=x; bad', 'session=']) assert.throws(() => aixor.validateAixorSession({ cookie, userId: 123 }));
  for (const userId of [0, -1, 'abc', '1\n', Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => aixor.validateAixorSession({ cookie: fixture.COOKIE, userId }));
  assert.equal(mergeCookies('session=old; other=keep', ['session=new; Path=/; HttpOnly; Secure', 'evil=x; Domain=other.example', 'deleted=x; Max-Age=0']), 'session=new; other=keep');
  assert.equal(mergeCookies('session=old', ['session=; Max-Age=0']), '');
  assert.throws(() => new MonitorAuth('/tmp', '../aixor'));
});

test('Aixor password login captures Cookie and ID, verifies identity, and saves no password or JWT-site credentials', async t => {
  const home = await homeFor(t), calls = [];
  const monitor = new Availability({}, { home, request: async (url, options) => {
    calls.push(url); assert.equal(options.site, 'aixor'); assert.equal(options.token, undefined);
    if (url === fixture.LOGIN.login) {
      assert.deepEqual(options.json, { username: 'normal', password: fixture.PASSWORD }); assert.equal(options.captureCookies, true);
    }
    return fixture.request(url, options);
  } });
  t.after(() => monitor.close());
  await assert.rejects(monitor.login({ ...credentials, agreement: false }), /用户协议/);
  const result = await monitor.login(credentials);
  assert.deepEqual(calls, [fixture.LOGIN.login, aixor.BALANCE_ENDPOINT]);
  assert.ok(!JSON.stringify(result).includes(fixture.COOKIE));
  assert.equal(result.expiresAt, null);
  const auth = new MonitorAuth(home, 'aixor');
  assert.deepEqual(await auth.read(), { cookie: fixture.COOKIE, userId: fixture.USER_ID, expiresAt: null });
  const disk = await fs.readFile(auth.file, 'utf8');
  assert.ok(!disk.includes(fixture.PASSWORD)); assert.ok(!disk.includes('token'));
  if (process.platform !== 'win32') assert.equal((await fs.stat(auth.file)).mode & 0o777, 0o600);
  assert.equal(await new MonitorAuth(home, 'input').read(), null);
  assert.equal(await new MonitorAuth(home).read(), null);
  await assert.rejects(monitor.authorize('aixor', fixture.COOKIE, 456));
  assert.equal((await auth.read()).userId, fixture.USER_ID);
});

test('Aixor two-factor retains only temporary cookies in memory and supports retry, cancel, expiry and shutdown', async t => {
  let now = Date.now();
  const monitor = new Availability({}, { home: await homeFor(t), clock: () => now, request: fixture.request });
  t.after(() => monitor.close());
  let challenge = await monitor.login({ ...credentials, username: 'otp' });
  assert.equal(challenge.requires2fa, true); assert.ok(!JSON.stringify(challenge).includes('cookie'));
  assert.equal(await monitor.auths.get('aixor').read(), null);
  await assert.rejects(monitor.login({ site: 'input', challengeId: challenge.challengeId, code: '123456' }), error => error.status === 410);
  await assert.rejects(monitor.login({ site: 'aixor', challengeId: challenge.challengeId, code: '000000' }), /验证码无效/);
  await monitor.login({ site: 'aixor', challengeId: challenge.challengeId, code: '123456' });
  assert.equal((await monitor.auths.get('aixor').read()).cookie, fixture.COOKIE);
  assert.equal(monitor.loginClients.get('aixor').challenges.size, 0);
  for (const invalidate of [id => monitor.cancelLogin('aixor', id), () => { now += 300001; }]) {
    challenge = await monitor.login({ ...credentials, username: 'otp' }); await invalidate(challenge.challengeId);
    await assert.rejects(monitor.login({ site: 'aixor', challengeId: challenge.challengeId, code: '123456' }), error => error.status === 410);
  }
  await monitor.login({ ...credentials, username: 'otp' }); monitor.close();
  assert.equal(monitor.loginClients.get('aixor').challenges.size, 0);
});

test('balance/subscriptions share 15 second requests across domains/models; expired entries vanish even from stale cache', async t => {
  let now = Date.now(), failure = false;
  const initial = now, calls = [];
  const monitor = new Availability({}, { clock: () => now, auths: { aixor: { read: async () => ({ cookie: fixture.COOKIE, userId: fixture.USER_ID }) } }, request: async (url, options) => {
    calls.push(url);
    if ([aixor.SETTINGS_ENDPOINT].includes(url) || url.includes('perf-metrics')) assert.equal(options.session, undefined);
    else assert.equal(options.session.cookie, fixture.COOKIE);
    if (url === aixor.SUBSCRIPTIONS_ENDPOINT) {
      if (failure) throw new Error('private-cookie-must-not-leak');
      const data = fixture.subscriptions(initial); data.data.all_subscriptions[0].subscription.end_time = Math.floor(initial / 1000) + 20;
      return data;
    }
    return fixture.request(url, options);
  } });
  t.after(() => monitor.close());
  const results = await Promise.all([monitor.snapshot(keys), monitor.snapshot(keys, MODELS[1])]);
  for (const result of results) for (const row of result.rows) {
    assert.equal(row.balance.amount, 24.691356); assert.equal(row.subscriptions.items.length, 2); assert.equal(row.state, 'available');
  }
  for (const endpoint of [aixor.BALANCE_ENDPOINT, aixor.SUBSCRIPTIONS_ENDPOINT, aixor.PLANS_ENDPOINT, aixor.SETTINGS_ENDPOINT]) assert.equal(calls.filter(url => url === endpoint).length, 1);
  now += 21000; failure = true;
  const stale = (await monitor.snapshot(keys)).rows[0];
  assert.equal(stale.balance.state, 'available'); assert.equal(stale.subscriptions.state, 'stale');
  assert.deepEqual(stale.subscriptions.items.map(item => item.id), [5]);
  assert.ok(!JSON.stringify(stale).includes('private-cookie'));
});

test('Aixor account requests are isolated from other sites and public monitoring; clear removes only that site', async t => {
  const home = await homeFor(t);
  const monitor = new Availability({}, { home, request: jwtFixture.request });
  t.after(() => monitor.close());
  await monitor.authorize('input', jwtFixture.INPUT_TOKEN);
  const initial = (await monitor.snapshot(keys)).rows[0];
  assert.equal(initial.state, 'available'); assert.equal(initial.balance.state, 'auth-required');
  await monitor.authorize('aixor', fixture.COOKIE, fixture.USER_ID);
  assert.equal((await monitor.snapshot(keys)).rows[0].subscriptions.items.length, 2);
  await monitor.authorize('aixor', '');
  const cleared = (await monitor.snapshot(keys)).rows[0];
  assert.equal(cleared.state, 'available');
  assert.deepEqual(cleared.balance, { fetchedAt: null, state: 'auth-required' });
  assert.deepEqual(cleared.subscriptions, { fetchedAt: null, state: 'auth-required' });
  assert.equal((await monitor.auths.get('input').read()).token, jwtFixture.INPUT_TOKEN);
});

test('session transport sends Cookie and user ID only to fixed account endpoints and captures Set-Cookie only at login', async t => {
  let getCalls = 0, postCalls = 0, responseStatus = 200;
  const respond = (req, value, cookies) => setImmediate(() => { const res = new PassThrough(); res.statusCode = responseStatus; res.headers = { 'set-cookie': cookies || [] }; req.emit('response', res); res.end(JSON.stringify(value)); });
  t.mock.method(https, 'get', (url, options) => {
    getCalls++; assert.equal(url, aixor.BALANCE_ENDPOINT); assert.equal(options.headers.cookie, fixture.COOKIE);
    assert.equal(options.headers['New-Api-User'], '123'); assert.equal(options.headers.authorization, undefined);
    const req = new EventEmitter(); req.destroy = () => {}; respond(req, { success: true }); return req;
  });
  t.mock.method(https, 'request', (url, options) => {
    postCalls++; assert.equal(url, fixture.LOGIN.login); assert.equal(options.headers.cookie, undefined);
    assert.equal(options.headers.authorization, undefined); assert.equal(options.method, 'POST');
    const req = new EventEmitter(); req.destroy = () => {}; req.end = body => {
      assert.deepEqual(JSON.parse(body), { username: 'normal', password: fixture.PASSWORD });
      respond(req, { success: true, data: { id: 123 } }, [fixture.COOKIE + '; Path=/; HttpOnly']);
    }; return req;
  });
  const base = { outbound: { resolve: async () => ({}), agent: () => false }, signal: new AbortController().signal, site: 'aixor' };
  const session = { cookie: fixture.COOKIE, userId: 123 };
  for (const url of ['https://ai.input.im/api/v1/auth/me', aixor.SETTINGS_ENDPOINT, aixor.BALANCE_ENDPOINT + '?redirect=1', 'http://aixor.cc/api/user/self']) {
    await assert.rejects(requestJson(url, { ...base, session }), /target rejected/);
  }
  await assert.rejects(requestJson(aixor.BALANCE_ENDPOINT, { ...base, site: 'input', session }), /target rejected/);
  await assert.rejects(requestJson(aixor.BALANCE_ENDPOINT, { ...base, token: jwtFixture.TOKEN }), /target rejected/);
  assert.equal(getCalls, 0);
  assert.deepEqual(await requestJson(aixor.BALANCE_ENDPOINT, { ...base, session }), { success: true });
  responseStatus = 302;
  await assert.rejects(requestJson(aixor.BALANCE_ENDPOINT, { ...base, session }), error => error.status === 302);
  responseStatus = 200;
  const login = await requestJson(fixture.LOGIN.login, { ...base, json: { username: 'normal', password: fixture.PASSWORD }, captureCookies: true });
  assert.equal(login.cookies.length, 1); assert.equal(postCalls, 1);
  await assert.rejects(requestJson(aixor.BALANCE_ENDPOINT, { ...base, captureCookies: true }), /target rejected/);
});

test('local Aixor API returns only normalized wallet fields, retains prior auth on bad input and logs no session', async t => {
  const home = await homeFor(t), logs = [];
  await fs.writeFile(path.join(home, 'config.toml'), 'model_provider="relay"\n[model_providers.relay]\nbase_url="https://aixor.cc"\n');
  await fs.writeFile(path.join(home, 'key_config.json'), JSON.stringify({ keys }));
  const app = await start({ home, uiPort: 0, proxyPort: 0, availabilityOptions: { request: fixture.request }, log: entry => logs.push(entry) });
  t.after(() => app.close());
  const post = (endpoint, payload, origin = app.uiUrl) => fetch(app.uiUrl + endpoint, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ name: keys[0].name, ...payload }) });
  assert.equal((await post('/api/availability/login', credentials, 'https://aixor.cc')).status, 403);
  const login = await post('/api/availability/login', credentials); assert.equal(login.status, 200);
  const result = await login.json();
  const snapshot = await (await fetch(app.uiUrl + '/api/availability')).json();
  assert.equal(snapshot.rows[0].balance.amount, 24.691356); assert.equal(snapshot.rows[0].subscriptions.items.length, 2);
  for (const secret of [fixture.PASSWORD, fixture.COOKIE, 'private@example.invalid']) assert.ok(!JSON.stringify({ result, snapshot, logs }).includes(secret));
  assert.equal((await post('/api/availability/authorization', { site: 'aixor', token: fixture.COOKIE, userId: '123' })).status, 200);
  assert.equal((await post('/api/availability/authorization', { site: 'aixor', token: fixture.COOKIE, userId: 'bad' })).status, 400);
});

test('Aixor subscription UI filters expiry while retaining INPUT history and escapes plan names', async () => {
  const source = await fs.readFile(path.join(__dirname, '../../managed-relay-public/availability.js'), 'utf8');
  const context = vm.createContext({ Intl, Date, escapeHtml: value => String(value).replace(/[&<>"']/g, c => '&#' + c.charCodeAt(0) + ';') });
  vm.runInContext(source + '\nthis.View = RelayAvailability;', context);
  const view = Object.create(context.View.prototype); view.error = '';
  const now = Date.now(), data = aixor.readAixorSubscriptions(fixture.subscriptions(now), now, '', deps);
  data.items[0].name = '<b>plan</b>';
  let html = view.subscriptionsMarkup({ ...data, state: 'available' });
  assert.ok(!html.includes('<b>')); assert.match(html, /套餐额度/); assert.match(html, /剩余 \$75\.00/); assert.match(html, /不限总额度/);
  data.items.forEach(item => { item.expiresAt = now - 1; });
  html = view.subscriptionsMarkup({ ...data, state: 'stale' });
  assert.match(html, /暂无未过期订阅/); assert.ok(!html.includes('剩余'));
  html = view.subscriptionsMarkup({ ...data, hideExpired: false, state: 'available' });
  assert.match(html, /剩余/);
});
