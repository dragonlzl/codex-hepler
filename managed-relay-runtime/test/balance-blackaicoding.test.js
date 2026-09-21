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
const { ENDPOINT: MONITOR_ENDPOINT } = require('../availability-blackaicoding');
const { ENDPOINT, readBlackaicodingBalance } = require('../balance-blackaicoding');
const fixture = require('./monitor-login-fixture');

const keys = [{ name: 'code for me', baseurl: 'https://blackaicoding.com', value: 'sk-not-login' },
  { name: 'code for me backup', baseurl: 'https://www.blackaicoding.com/v1', value: 'sk-not-login-2' }];
const profile = amount => ({ code: 0, data: { balance: amount, email: 'private@example.invalid', id: 9367, role: 'user', token: 'private-profile-secret' } });
const auth = () => ({ read: async () => ({ token: fixture.TOKEN }) });

test('balance parser returns only dollar balance, preserves zero and negatives, rejects missing or malformed amounts', () => {
  for (const amount of [1234.56789, 0, -5.678]) assert.deepEqual(readBlackaicodingBalance(profile(amount)), { amount, currency: 'USD' });
  for (const amount of [undefined, null, '', '12.34', NaN, Infinity, {}, false]) assert.throws(() => readBlackaicodingBalance(profile(amount)));
  assert.throws(() => readBlackaicodingBalance({ code: 1, data: { balance: 50 } }));
  assert.throws(() => readBlackaicodingBalance({ code: 0 }));
});

test('15 second polling shares balance across model selections and duplicate routes, and excludes profile details', async t => {
  let now = Date.now(), amount = 1234.56789;
  const calls = [];
  const monitor = new Availability({}, { auth: auth(), clock: () => now, request: async (url, options) => {
    calls.push(url);
    assert.equal(options.token, fixture.TOKEN);
    return url === ENDPOINT ? profile(amount) : fixture.matrix();
  } });
  t.after(() => monitor.close());
  const [astra, sol] = await Promise.all([monitor.snapshot(keys), monitor.snapshot(keys, MODELS[1])]);
  assert.equal(calls.filter(url => url === ENDPOINT).length, 1);
  assert.equal(calls.filter(url => url === MONITOR_ENDPOINT).length, 1);
  for (const result of [astra, sol]) for (const row of result.rows) {
    assert.deepEqual(row.balance, { amount, currency: 'USD', fetchedAt: now, state: 'available' });
  }
  assert.ok(!JSON.stringify(astra).includes('private'));
  amount = 0;
  now += REFRESH_MS - 1;
  assert.equal((await monitor.snapshot(keys)).rows[0].balance.amount, 1234.56789);
  now++;
  const zero = (await monitor.snapshot(keys)).rows[0].balance;
  assert.equal(zero.amount, 0);
  assert.equal(zero.state, 'available');
  assert.equal(zero.fetchedAt, now);
  assert.equal(calls.filter(url => url === ENDPOINT).length, 2);
});

test('balance and availability fail independently; stale balance keeps its fetch time and expired auth is explicit', async t => {
  let now = Date.now(), balanceFailure = 0, monitorFailure = false, credential = true;
  const monitor = new Availability({}, { auth: { read: async () => credential ? { token: fixture.TOKEN } : null }, clock: () => now,
    request: async url => {
      if (url === ENDPOINT) {
        if (balanceFailure) throw Object.assign(new Error('private-profile-secret'), { status: balanceFailure });
        return profile(42.12);
      }
      if (monitorFailure) throw new Error('Monitor offline');
      return fixture.matrix();
    } });
  t.after(() => monitor.close());
  balanceFailure = 503;
  let row = (await monitor.snapshot(keys)).rows[0];
  assert.equal(row.state, 'available');
  assert.deepEqual(row.balance, { state: 'error', fetchedAt: null,
    failure: { code: 'HTTP_503', message: '上游 HTTP 503', at: now } });
  balanceFailure = 0; monitorFailure = true; now += REFRESH_MS;
  row = (await monitor.snapshot(keys)).rows[0];
  assert.equal(row.state, 'stale');
  assert.equal(row.balance.state, 'available');
  const fetchedAt = row.balance.fetchedAt;
  balanceFailure = 503; monitorFailure = false; now += REFRESH_MS;
  row = (await monitor.snapshot(keys)).rows[0];
  assert.equal(row.state, 'available');
  assert.deepEqual(row.balance, { amount: 42.12, currency: 'USD', state: 'stale', fetchedAt,
    failure: { code: 'HTTP_503', message: '上游 HTTP 503', at: now } });
  balanceFailure = 401; now += REFRESH_MS;
  row = (await monitor.snapshot(keys)).rows[0];
  assert.equal(row.balance.state, 'auth-required');
  assert.equal(row.balance.fetchedAt, fetchedAt);
  assert.ok(!JSON.stringify(row).includes('private'));
  credential = false; now += REFRESH_MS;
  row = (await monitor.snapshot(keys)).rows[0];
  assert.equal(row.state, 'auth-required');
  assert.equal(row.balance.state, 'auth-required');
});

test('clear and replacement authorization discard cached balances, including a pending previous-account response', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-balance-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  let now = Date.now(), amount = 5, release;
  const monitor = new Availability({}, { home, clock: () => now, request: async url => {
    if (url !== ENDPOINT) return fixture.matrix();
    if (amount === 6) return new Promise(resolve => { release = resolve; });
    return profile(amount);
  } });
  t.after(() => monitor.close());
  await monitor.authorize('blackaicoding', fixture.TOKEN);
  assert.equal((await monitor.snapshot(keys)).rows[0].balance.amount, 5);
  now += REFRESH_MS; amount = 6;
  const pending = monitor.snapshot(keys);
  while (!release) await new Promise(resolve => setImmediate(resolve));
  await monitor.authorize('blackaicoding', '');
  release(profile(6));
  const cleared = (await pending).rows[0].balance;
  assert.deepEqual(cleared, { state: 'auth-required', fetchedAt: null });
  amount = 17;
  await monitor.authorize('blackaicoding', fixture.TOKEN);
  assert.equal((await monitor.snapshot(keys)).rows[0].balance.amount, 17);
  amount = 29;
  await monitor.authorize('blackaicoding', fixture.TOKEN);
  assert.equal((await monitor.snapshot(keys)).rows[0].balance.amount, 29);
  const other = new Availability({}, { home: path.join(home, 'another'), request: async () => { throw new Error('Must not request'); } });
  t.after(() => other.close());
  assert.deepEqual((await other.snapshot(keys)).rows[0].balance, { state: 'auth-required', fetchedAt: null });
});

test('public and unadapted sites never read account balance or send monitor authorization', async t => {
  const calls = [];
  const monitor = new Availability({}, { auth: { read: async () => { throw new Error('Should not read credentials'); } }, request: async (url, options) => {
    assert.equal(options.token, undefined); calls.push(url); return { services: [] };
  } });
  t.after(() => monitor.close());
  const result = await monitor.snapshot([{ name: 'packycode', baseurl: 'https://www.packyapi.com' }, { name: 'other', baseurl: 'https://example.com' }]);
  assert.equal(calls.length, 1);
  assert.ok(result.rows.every(row => !Object.hasOwn(row, 'balance')));
});

test('balance transport permits only exact account endpoint and rejects redirects without forwarding tokens', async t => {
  let calls = 0;
  t.mock.method(https, 'get', (url, options) => {
    calls++; assert.equal(url, ENDPOINT); assert.equal(options.headers.authorization, 'Bearer ' + fixture.TOKEN);
    const request = new EventEmitter(); request.destroy = () => {};
    setImmediate(() => { const response = new PassThrough(); response.statusCode = 302; request.emit('response', response); response.end(); });
    return request;
  });
  const options = { outbound: { resolve: async () => ({}), agent: () => false }, signal: new AbortController().signal, token: fixture.TOKEN };
  for (const url of [ENDPOINT + '?other=1', ENDPOINT.replace('https:', 'http:'), 'https://blackaicoding.com.evil.example/api/v1/auth/me', 'https://status.input.im/api/status']) {
    await assert.rejects(requestJson(url, options), /target rejected/);
  }
  assert.equal(calls, 0);
  await assert.rejects(requestJson(ENDPOINT, options), error => error.status === 302);
  assert.equal(calls, 1);
});

test('balance display distinguishes zero, unknown, stale and expired authorization without depending on monitor state', async () => {
  const source = await fs.readFile(path.join(__dirname, '../../managed-relay-public/availability.js'), 'utf8');
  const context = vm.createContext({ Intl, Date, escapeHtml: value => String(value).replace(/[&<>"']/g, character => '&#' + character.charCodeAt(0) + ';') });
  vm.runInContext(source + '\nthis.AvailabilityView = RelayAvailability;', context);
  const view = Object.create(context.AvailabilityView.prototype);
  view.error = '';
  const balance = { amount: 0, currency: 'USD', state: 'available', fetchedAt: Date.now() };
  assert.match(view.balanceMarkup(balance), /\$0\.00/);
  assert.match(view.balanceMarkup(balance), /depleted/);
  assert.match(view.balanceMarkup({ ...balance, amount: 1234.56789 }), /\$1,234\.57/);
  assert.match(view.balanceMarkup({ state: 'error' }), /<strong>—<\/strong>/);
  assert.match(view.balanceMarkup({ ...balance, state: 'auth-required' }), /上次余额 · 需重新登录/);
  view.error = 'Status request failed';
  assert.match(view.balanceMarkup(balance), /上次余额 · 刷新失败/);
  assert.equal(view.balanceMarkup(undefined), '');
});
