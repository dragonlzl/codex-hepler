const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const https = require('node:https');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { start } = require('../../managed-relay-server');
const { Availability, requestJson } = require('../availability');
const { AixorLogin, mergeCookies } = require('../login-aixor');
const { MonitorAuth } = require('../monitor-auth');
const packy = require('../account-packycode');
const fixture = require('./packy-account-fixture');
const entries = [
  { name: 'Packy A', baseurl: 'https://cf.api.fan/v1', value: 'sk-fixture-a' },
  { name: 'Packy B', baseurl: 'https://cf.api.fan/v1', value: 'sk-fixture-b' },
  { name: 'Packy alias', baseurl: 'https://cf.api.fan/v1', value: 'sk-fixture-a' },
];
async function setup(t, options = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-packy-account-'));
  await fs.writeFile(path.join(home, 'config.toml'), 'model_provider="relay"\n[model_providers.relay]\nbase_url="https://cf.api.fan/v1"\n');
  await fs.writeFile(path.join(home, 'key_config.json'), JSON.stringify({ keys: entries }));
  const calls = [], keyCalls = [];
  const availabilityOptions = {
    request: async (url, settings) => { calls.push({ url, settings }); return (options.request || fixture.request)(url, settings); },
    packyBalanceOptions: { request: async (_url, settings) => {
      keyCalls.push(settings.apiKey);
      return { code: true, data: { total_available: settings.apiKey.endsWith('a') ? 200000000 : 100000000, total_granted: 250000000, total_used: 0 } };
    } }, ...options,
  };
  let app;
  const launch = async () => { app = await start({ home, uiPort: 0, proxyPort: 0, availabilityOptions, log: () => {} }); };
  await launch();
  t.after(async () => { await app.close(); await fs.rm(home, { recursive: true, force: true }); });
  const get = async endpoint => (await fetch(app.uiUrl + endpoint)).json();
  const post = async (endpoint, body) => {
    const response = await fetch(app.uiUrl + endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { code: response.status, data: await response.json() };
  };
  const status = () => get('/api/status');
  const source = async (name, source) => {
    const entry = (await status()).keys.find(entry => entry.name === name);
    return post('/api/packycode/balance/source', { name, source, previousSource: entry.balanceSource, revision: entry.revision });
  };
  const login = (name, username = 'normal') => post('/api/availability/login', { name, site: 'packycode', username, password: fixture.PASSWORD });
  return { home, get, post, status, source, login, calls, keyCalls, rows: async () => (await get('/api/availability')).rows,
    restart: async () => { await app.close(); await launch(); } };
}

test('each Packy configuration independently persists one source across restart, rename and account binding', async t => {
  const c = await setup(t);
  assert.ok((await c.status()).keys.every(entry => entry.balanceSource === 'api-key'));
  assert.equal((await c.login('Packy A')).code, 409);
  const old = (await c.status()).keys[0];
  assert.equal((await c.source('Packy A', 'account')).code, 200);
  assert.equal((await c.post('/api/packycode/balance/source', { name: old.name, source: 'api-key', previousSource: 'api-key', revision: old.revision })).code, 409);
  assert.equal((await c.source('Packy A', 'both')).code, 400);
  assert.equal((await c.login('Packy A')).code, 200);
  const rows = await c.rows();
  assert.equal(rows[0].balance.kind, 'packy-account'); assert.equal(rows[0].balance.amount, 123.456788);
  assert.equal(rows[1].balance.kind, 'packy-key'); assert.equal(rows[2].balance.kind, 'packy-key');
  assert.equal(rows[1].authorizationSite, undefined);
  assert.equal(c.calls.filter(call => call.url === packy.BALANCE_ENDPOINT).length, 2); // verification + account polling
  await c.restart();
  assert.deepEqual((await c.status()).keys.map(entry => entry.balanceSource), ['account', 'api-key', 'api-key']);
  let row = (await c.status()).keys[0];
  const edited = await c.post('/api/keys/edit', { originalName: row.name, name: 'Renamed', baseurl: row.baseurl, revision: row.revision });
  assert.equal(edited.code, 200); assert.equal(edited.data.status.keys[0].balanceSource, 'account');
  const status = await c.status();
  assert.equal((await c.post('/api/accounts/bind', { targetName: 'Renamed', names: ['Packy B'], revision: status.accountBindingsRevision })).code, 200);
  assert.deepEqual((await c.status()).keys.map(entry => entry.balanceSource), ['account', 'api-key', 'api-key']);
  assert.equal((await c.source('Packy B', 'account')).code, 200);
  assert.equal((await c.rows())[1].balance.amount, 123.456788);
  const serialized = JSON.stringify({ status: await c.status(), rows: await c.rows() });
  for (const secret of [fixture.COOKIE, fixture.PASSWORD, ...entries.map(e => e.value)]) assert.ok(!serialized.includes(secret));
  const auth = new MonitorAuth(c.home, 'packycode', (await c.status()).keys[0].accountId);
  assert.equal((await auth.read()).cookie, fixture.COOKIE);
  if (process.platform !== 'win32') assert.equal((await fs.stat(auth.file)).mode & 0o777, 0o600);
});

test('all-account mode makes no key requests; distinct accounts require their own authorization', async t => {
  const c = await setup(t);
  for (const entry of entries) await c.source(entry.name, 'account');
  await c.login('Packy A');
  const rows = await c.rows();
  assert.equal(rows[0].balance.state, 'available'); assert.equal(rows[1].balance.state, 'auth-required');
  assert.equal(rows[2].balance.state, 'available'); // Explicitly identical key identity.
  assert.deepEqual(c.keyCalls, []);
  assert.equal((await c.post('/api/packycode/balance/refresh', { name: 'Packy A' })).code, 409);
  await c.source('Packy A', 'api-key');
  assert.equal((await c.rows())[0].balance.kind, 'packy-key');
  assert.deepEqual(c.keyCalls, ['sk-fixture-a']);
  await c.source('Packy A', 'account');
  assert.equal((await c.rows())[0].balance.amount, 123.456788);
});

test('a source switch during an account read cannot return the old source balance', async t => {
  let release, reached, pause = false;
  const gate = new Promise(resolve => { release = resolve; });
  const began = new Promise(resolve => { reached = resolve; });
  const c = await setup(t, { request: async (url, options) => {
    if (pause && url === packy.BALANCE_ENDPOINT) { reached(); await gate; }
    return fixture.request(url, options);
  } });
  await c.source('Packy A', 'account'); await c.login('Packy A'); pause = true;
  const pending = c.rows(); await began;
  try { await c.source('Packy A', 'api-key'); } finally { release(); }
  assert.equal((await pending)[0].balance.kind, 'packy-key');
});

test('Packy session login handles captcha and two-factor challenge without persisting secrets to responses', async t => {
  const client = new AixorLogin(fixture.request, Date.now, 'packycode'); t.after(() => client.clear());
  const signal = new AbortController().signal;
  const result = await client.login({ username: 'normal', password: fixture.PASSWORD, captcha: { ticket: 'a+b/=', randstr: 'xyz' } }, signal);
  assert.equal(result.credential.cookie, fixture.COOKIE);
  const challenge = await client.login({ username: 'otp', password: fixture.PASSWORD }, signal);
  assert.ok(challenge.requires2fa); assert.ok(!JSON.stringify(challenge).includes('packy-pending'));
  await assert.rejects(client.login({ challengeId: challenge.challengeId, code: '000000' }, signal), /验证码/);
  assert.equal((await client.login({ challengeId: challenge.challengeId, code: '123456' }, signal)).credential.userId, 321);
  const canceled = await client.login({ username: 'otp', password: fixture.PASSWORD }, signal);
  client.cancel(canceled.challengeId);
  await assert.rejects(client.login({ challengeId: canceled.challengeId, code: '123456' }, signal), error => error.status === 410);
  const rejecting = new AixorLogin(async () => ({ payload: { success: false, code: 'captcha_required', message: fixture.PASSWORD } }), Date.now, 'packycode');
  await assert.rejects(rejecting.login({ username: 'normal', password: fixture.PASSWORD }, signal), /人机验证/);
  assert.equal(mergeCookies('', ['session=good; Domain=.packyapi.com', 'evil=x; Domain=aixor.cc'], 'packycode'), 'session=good');
});

test('Packy captcha metadata is sanitized and account quota uses current site conversion', async () => {
  const options = await packy.loginOptions(async url => url === packy.SETTINGS_ENDPOINT
    ? { success: true, data: { tencent_captcha_check: true, tencent_captcha_app_id: '123456', user_agreement_enabled: true, internal: 'omit' } }
    : { success: true, data: { aid_encrypted: 'encrypted-aid', secret: 'omit' } }, new AbortController().signal);
  assert.deepEqual(options, { agreement: true, privacy: false, captcha: { appId: '123456', aidEncrypted: 'encrypted-aid' } });
  assert.equal(packy.readBalance({ success: true, data: { id: 1, quota: 12345678 } }, 0, '', { settings: { scale: 500000 } }).amount, 24.691356);
  assert.throws(() => packy.readIdentity({ success: false, message: '未登录或登录已过期' }), error => error.status === 401);
  assert.throws(() => packy.readSettings({ success: true, data: { quota_per_unit: 0, quota_display_type: 'USD' } }));
});

test('Packy transport confines password, cookies and captcha proofs to verified endpoints', async t => {
  const send = (req, value) => setImmediate(() => { const res = new PassThrough(); res.statusCode = 200; res.headers = {}; req.emit('response', res); res.end(JSON.stringify(value)); });
  const endpoint = packy.loginUrl({ ticket: 'ticket+/=', randstr: 'rand' });
  t.mock.method(https, 'request', (url, options) => {
    assert.equal(url, endpoint); assert.equal(options.headers.cookie, undefined);
    const req = new EventEmitter(); req.destroy = () => {}; req.end = body => { assert.equal(JSON.parse(body).password, fixture.PASSWORD); send(req, { success: true }); }; return req;
  });
  t.mock.method(https, 'get', (url, options) => {
    assert.equal(url, packy.BALANCE_ENDPOINT); assert.equal(options.headers.cookie, fixture.COOKIE);
    assert.equal(options.headers['New-Api-User'], '321'); assert.equal(options.headers.authorization, undefined);
    const req = new EventEmitter(); req.destroy = () => {}; send(req, { success: true }); return req;
  });
  const base = { site: 'packycode', outbound: { resolve: async () => ({}), agent: () => false }, signal: new AbortController().signal };
  await requestJson(endpoint, { ...base, json: { username: 'user', password: fixture.PASSWORD }, captureCookies: true });
  const session = { cookie: fixture.COOKIE, userId: 321 };
  await requestJson(packy.BALANCE_ENDPOINT, { ...base, session });
  for (const url of [packy.SETTINGS_ENDPOINT, 'https://aixor.cc/api/user/self', packy.BALANCE_ENDPOINT + '?next=x']) await assert.rejects(requestJson(url, { ...base, session }), /target rejected/);
  for (const url of [endpoint.replace('www.packyapi.com', 'evil.example'), endpoint + '&redirect=x', endpoint + '&tencent_ticket=other']) await assert.rejects(requestJson(url, { ...base, json: { password: fixture.PASSWORD }, captureCookies: true }), /target rejected/);
});

test('failed or expired account reads preserve the last balance; clearing credentials removes it', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'packy-stale-'));
  let now = Date.now(), failure = 0;
  const monitor = new Availability({}, { home, clock: () => now, request: async (url, options) => {
    if (url === packy.BALANCE_ENDPOINT && failure) throw Object.assign(new Error('private upstream detail'), { status: failure });
    return fixture.request(url, options);
  } });
  t.after(async () => { monitor.close(); await fs.rm(home, { recursive: true, force: true }); });
  await monitor.authorize('packycode', fixture.COOKIE, 321);
  const keys = [{ name: 'Packy', baseurl: 'https://www.packyapi.com', balanceSource: 'account' }];
  const first = (await monitor.snapshot(keys)).rows[0].balance;
  for (const status of [500, 401]) {
    failure = status; now += 15001;
    const balance = (await monitor.snapshot(keys)).rows[0].balance;
    assert.equal(balance.amount, first.amount); assert.equal(balance.fetchedAt, first.fetchedAt);
    assert.equal(balance.state, status === 401 ? 'auth-required' : 'stale');
  }
  await monitor.authorize('packycode', '');
  assert.equal((await monitor.snapshot(keys)).rows[0].balance.amount, undefined);
});

test('switching all consumers away from key mode aborts its pending retry', async t => {
  let signal, calls = 0, reached;
  const waiting = new Promise(resolve => { reached = resolve; });
  const c = await setup(t, { packyBalanceOptions: {
    request: async () => { calls++; throw new Error('temporary failure'); },
    wait: (_ms, pendingSignal) => { signal = pendingSignal; reached(); return new Promise(resolve => pendingSignal.addEventListener('abort', resolve, { once: true })); },
  } });
  await c.source('Packy B', 'account'); await c.source('Packy alias', 'account');
  await c.rows(); await waiting;
  await c.source('Packy A', 'account');
  assert.ok(signal.aborted);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(calls, 1);
});
