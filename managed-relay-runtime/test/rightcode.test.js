const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const { PassThrough } = require('node:stream');
const { EventEmitter } = require('node:events');
const { Availability, adapterFor, requestJson } = require('../availability');
const { MonitorAuth } = require('../monitor-auth');
const { RightcodeLogin } = require('../login-rightcode');
const { readRightcodeBalance, validateRightcodeToken, BALANCE_ENDPOINT } = require('../account-rightcode');
const { readRightcodeStatus, codexCatalog, ENDPOINT, CATALOG_ENDPOINT } = require('../availability-rightcode');
const { accountId, merchantId } = require('../relay-identity');
const { bindingModel } = require('../account-bindings');
const { start } = require('../../managed-relay-server');
const fixture = require('./rightcode-fixture');
const now = Date.now();
const models = fixture.MODELS;
const keys = [{ name: 'RC', baseurl: 'https://www.rightapi.ai/v1', value: 'sk-not-login' }, { name: 'RC other', baseurl: 'https://www.rightapi.ai/v1', value: 'sk-other' }];
async function temp(t) { const home = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-rightcode-')); t.after(() => fs.rm(home, { recursive: true, force: true })); return home; }

test('RC bindings created before adaptation keep their account and authorization identity', () => {
  const id = 'd'.repeat(64), members = keys.map(accountId);
  const state = { accountBindings: [{ id, merchant: 'https://www.rightapi.ai', members, sourceId: members[0] }] };
  const model = bindingModel(keys, state);
  for (const entry of keys) {
    assert.equal(model.describe(entry).accountId, id);
    assert.equal(model.describe(entry).merchantId, 'rightcode');
    assert.equal(model.describe(entry).accountSourceName, 'RC');
  }
  assert.equal(state.accountBindings[0].merchant, 'https://www.rightapi.ai');
});

test('RC only recognizes verified site hosts and converts account money without quota scaling', () => {
  for (const base of ['https://www.rightapi.ai/v1', 'https://rightapi.ai/codex/v1']) {
    assert.equal(adapterFor(base).id, 'rightcode'); assert.equal(merchantId(base), 'rightcode');
  }
  for (const base of ['https://rightapi.ai.evil.example/v1', 'https://www.rightapi.ai:8443/v1', 'https://secret@rightapi.ai/v1']) assert.equal(adapterFor(base), null);
  for (const balance of [0, -1.2345, '44.167253']) assert.deepEqual(readRightcodeBalance({ balance, user_token: fixture.TOKEN }), { amount: Number(balance), currency: 'USD' });
  for (const balance of [null, undefined, '', true, 'NaN', Infinity, '1dollar']) assert.throws(() => readRightcodeBalance({ balance }));
  assert.throws(() => readRightcodeBalance({ balance: 0, error: 'unauthorized' }));
  assert.deepEqual(validateRightcodeToken(fixture.TOKEN), { token: fixture.TOKEN, expiresAt: null });
  for (const value of ['', 'sk-not-login-123456789', 'Bearer ' + fixture.TOKEN, 'token\r\n' + fixture.TOKEN]) assert.throws(() => validateRightcodeToken(value));
});

test('Codex 24-hour status uses exact model IDs, source availability and 90/60 color thresholds', () => {
  const payload = fixture.status(now), catalog = codexCatalog(fixture.catalog());
  const points = payload.models[0].points;
  points[0].availability = 0; points[1].availability = 59.99; points[2].availability = 60; points[3].availability = 89.99; points[4].availability = 90; points[5].availability = 100;
  points[6].availability = 100; points[6].no_sample = true;
  const result = readRightcodeStatus(payload, models, now, catalog);
  const astra = result[models[0]];
  assert.deepEqual(astra.history.slice(0, 7).map(point => point.state), ['unavailable', 'unavailable', 'degraded', 'degraded', 'available', 'available', 'no-data']);
  assert.equal(astra.history[6].ok, null); assert.equal(astra.history[6].uptimePct, null);
  assert.equal(astra.uptimePct, points.reduce((sum, point) => sum + point.availability, 0) / 24);
  assert.equal(astra.sampleCount, 23); assert.equal(astra.history.length, 24);
  assert.ok(astra.history[1].barHeightPct < astra.history[4].barHeightPct);
  assert.ok(astra.history[0].barHeightPct > 0); assert.equal(astra.history[5].barHeightPct, 100);
  payload.models[0].model = 'other-gpt-6-astra';
  assert.equal(readRightcodeStatus(payload, models, now, catalog)[models[0]].last, null);
  payload.upstream_prefix = '/claude'; assert.throws(() => readRightcodeStatus(payload, models, now, catalog));
});

test('disabled, all-empty and malformed models cannot borrow another channel or report healthy', () => {
  const payload = fixture.status(now), catalog = codexCatalog(fixture.catalog());
  for (const point of payload.models[0].points) point.no_sample = true;
  let result = readRightcodeStatus(payload, models, now, catalog)[models[0]];
  assert.equal(result.sampleCount, 0); assert.equal(result.uptimePct, null); assert.equal(result.last.state, 'no-data');
  result = readRightcodeStatus(payload, models, now, { ...catalog, [models[0]]: false })[models[0]];
  assert.equal(result.disabled, true); assert.deepEqual(result.history, []);
  for (const mutation of [p => { p.models.push(p.models[0]); }, p => { p.models[0].points[0].availability = -1; }, p => { p.models[0].points.push(p.models[0].points[0]); }, p => { p.window = '2h'; }, p => { p.models[0].points[0].end_at = 1; }]) {
    const invalid = fixture.status(now); mutation(invalid); assert.throws(() => readRightcodeStatus(invalid, models, now, catalog));
  }
  const other = fixture.catalog(); other.upstreams.shift(); assert.throws(() => codexCatalog(other));
});

test('RC requests share model snapshots and preserve stale balance/status after errors', async t => {
  let clock = now, fail = false; const calls = [];
  const monitor = new Availability({}, { clock: () => clock, auths: { rightcode: { read: async () => ({ token: fixture.TOKEN }) } },
    request: async (url, options) => {
      calls.push(url);
      if (url === BALANCE_ENDPOINT) assert.equal(options.token, fixture.TOKEN);
      else assert.equal(options.token, undefined);
      if (fail) throw new Error('private');
      return url === ENDPOINT ? fixture.status(clock) : fixture.request(url, options);
    } });
  t.after(() => monitor.close());
  const [first, second] = await Promise.all([monitor.snapshot(keys), monitor.snapshot(keys, models[1])]);
  assert.equal(first.rows[0].balance.amount, 45.6789); assert.equal(second.rows[0].model, models[1]);
  for (const endpoint of [ENDPOINT, CATALOG_ENDPOINT, BALANCE_ENDPOINT]) assert.equal(calls.filter(call => call === endpoint).length, 1);
  fail = true; clock += 15001;
  const stale = (await monitor.snapshot(keys)).rows[0];
  assert.equal(stale.state, 'stale'); assert.equal(stale.balance.state, 'stale'); assert.equal(stale.balance.amount, 45.6789);
  assert.equal(stale.balance.fetchedAt, first.rows[0].balance.fetchedAt);
  assert.ok(!JSON.stringify(stale).includes('private'));
});

test('RC password and two-factor login keep secrets only in expiring memory and clear after success/cancel', async t => {
  let clock = now;
  const client = new RightcodeLogin(fixture.request, () => clock); t.after(() => client.clear());
  const signal = new AbortController().signal;
  assert.equal((await client.login({ username: 'normal', password: fixture.PASSWORD }, signal)).token, fixture.TOKEN);
  let challenge = await client.login({ username: 'otp', password: fixture.PASSWORD }, signal);
  assert.equal(challenge.requires2fa, true); assert.ok(!JSON.stringify(challenge).includes(fixture.PASSWORD));
  await assert.rejects(client.login({ challengeId: challenge.challengeId, code: '000000' }, signal), /验证码/);
  assert.equal((await client.login({ challengeId: challenge.challengeId, code: '123456' }, signal)).token, fixture.TOKEN);
  assert.equal(client.challenges.size, 0);
  challenge = await client.login({ username: 'otp', password: fixture.PASSWORD }, signal); clock += 300001;
  await assert.rejects(client.login({ challengeId: challenge.challengeId, code: '123456' }, signal), error => error.status === 410);
  assert.equal(client.challenges.size, 0);
  challenge = await client.login({ username: 'otp', password: fixture.PASSWORD }, signal); client.cancel(challenge.challengeId);
  await assert.rejects(client.login({ challengeId: challenge.challengeId, code: '123456' }, signal), error => error.status === 410);
});

test('local RC endpoints isolate accounts, validate manual tokens and never return or log secrets', async t => {
  const home = await temp(t), logs = [];
  await fs.writeFile(path.join(home, 'config.toml'), 'model_provider="relay"\n[model_providers.relay]\nbase_url="https://www.rightapi.ai/v1"\n');
  await fs.writeFile(path.join(home, 'key_config.json'), JSON.stringify({ keys }));
  const app = await start({ home, uiPort: 0, proxyPort: 0, availabilityOptions: { request: fixture.request }, log: record => logs.push(record) }); t.after(() => app.close());
  const post = async (endpoint, payload, origin = app.uiUrl) => {
    const r = await fetch(app.uiUrl + endpoint, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ name: 'RC', site: 'rightcode', ...payload }) });
    return { status: r.status, data: await r.json() };
  };
  const login = await post('/api/availability/login', { username: 'normal', password: fixture.PASSWORD }); assert.equal(login.status, 200);
  const rows = (await (await fetch(app.uiUrl + '/api/availability')).json()).rows;
  assert.equal(rows[0].balance.state, 'available'); assert.equal(rows[1].balance.state, 'auth-required');
  assert.ok(rows.every(row => row.state === 'available'));
  const auth = new MonitorAuth(home, 'rightcode', accountId(keys[0]));
  assert.equal((await auth.read()).token, fixture.TOKEN);
  if (process.platform !== 'win32') assert.equal((await fs.stat(auth.file)).mode & 0o777, 0o600);
  const saved = await fs.readFile(auth.file, 'utf8'); assert.ok(!saved.includes(fixture.PASSWORD));
  assert.equal(await new MonitorAuth(home, 'input', accountId(keys[0])).read(), null);
  assert.equal((await post('/api/availability/authorization', { token: 'invalid' })).status, 400);
  assert.equal((await auth.read()).token, fixture.TOKEN);
  assert.equal((await post('/api/availability/authorization', { token: fixture.TOKEN })).status, 200);
  assert.equal((await post('/api/availability/authorization', { token: fixture.TOKEN }, 'https://www.rightapi.ai')).status, 403);
  assert.equal((await post('/api/availability/authorization', { token: '' })).status, 200);
  assert.equal(await auth.read(), null);
  for (const secret of [fixture.PASSWORD, fixture.TOKEN, 'private@example.invalid', ...keys.map(key => key.value)]) assert.ok(!JSON.stringify({ rows, login, logs }).includes(secret));
});

test('RC Bearer token is sent only to auth/me and password only to its login endpoint', async t => {
  let gets = 0, posts = 0;
  const response = req => setImmediate(() => { const res = new PassThrough(); res.statusCode = 200; res.headers = {}; req.emit('response', res); res.end('{}'); });
  t.mock.method(https, 'get', (url, options) => { gets++; assert.equal(url, BALANCE_ENDPOINT); assert.equal(options.headers.authorization, 'Bearer ' + fixture.TOKEN); const req = new EventEmitter(); req.destroy = () => {}; response(req); return req; });
  t.mock.method(https, 'request', (url, options) => { posts++; assert.equal(url, 'https://www.rightapi.ai/auth/login'); assert.equal(options.headers.authorization, undefined); const req = new EventEmitter(); req.destroy = () => {}; req.end = () => response(req); return req; });
  const base = { outbound: { resolve: async () => ({}), agent: () => false }, signal: new AbortController().signal, site: 'rightcode' };
  for (const url of [ENDPOINT, CATALOG_ENDPOINT, 'https://rightapi.ai/auth/me', BALANCE_ENDPOINT + '?next=1', 'https://www.rightapi.ai.evil.example/auth/me']) await assert.rejects(requestJson(url, { ...base, token: fixture.TOKEN }), /target rejected/);
  await requestJson(BALANCE_ENDPOINT, { ...base, token: fixture.TOKEN }); assert.equal(gets, 1);
  await requestJson('https://www.rightapi.ai/auth/login', { ...base, json: { username: 'normal', password: fixture.PASSWORD } }); assert.equal(posts, 1);
  await assert.rejects(requestJson(BALANCE_ENDPOINT, { ...base, json: { password: fixture.PASSWORD } }), /target rejected/);
});
