const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { start } = require('../../managed-relay-server');
const { accountId, merchantId } = require('../relay-identity');
const { MonitorAuth } = require('../monitor-auth');
const { atomicWrite } = require('../config-store');
const { group } = require('../../managed-relay-public/route-groups');
const fixture = require('./monitor-login-fixture');
const { BALANCE_ENDPOINT, SUBSCRIPTIONS_ENDPOINT } = require('../account-input');
const { loginEndpoints } = require('../account-sites');
const SECOND_TOKEN = fixture.INPUT_TOKEN.replace('inputfixture.', 'second.');
const keys = [
  { name: 'A', baseurl: 'https://ai.input.im/v1', value: 'sk-private-a' },
  { name: 'A alias', baseurl: 'https://ai.input.im/v1', value: 'sk-private-a' },
  { name: 'B', baseurl: 'https://ai.input.im/alternate/v1', value: 'sk-private-b' },
  { name: 'C', baseurl: 'https://ai.input.im/v1', value: 'sk-private-c' },
  { name: 'D', baseurl: 'https://ai.input.im/third/v1', value: 'sk-private-d' },
  { name: 'Foreign', baseurl: 'https://aixor.cc/v1', value: 'sk-private-foreign' },
];
async function request(url, options) {
  if (url === loginEndpoints('input').login && options.json.email === 'other') return { code: 0, data: { access_token: SECOND_TOKEN } };
  if (url === BALANCE_ENDPOINT && options.token === SECOND_TOKEN) return { code: 0, data: { balance: 222 } };
  if (url === SUBSCRIPTIONS_ENDPOINT && options.token === SECOND_TOKEN) return fixture.subscriptions();
  return fixture.request(url, options);
}
async function setup(t, entries = keys, availabilityOptions = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-binding-'));
  await fs.writeFile(path.join(home, 'config.toml'), `model_provider="relay"\n[model_providers.relay]\nbase_url="${entries[0].baseurl}"\n`);
  await fs.writeFile(path.join(home, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: entries[0].value }));
  await fs.writeFile(path.join(home, 'key_config.json'), JSON.stringify({ keys: entries, extra: 'preserved' }));
  let app;
  const launch = async () => { app = await start({ home, uiPort: 0, proxyPort: 0, availabilityOptions: { request, ...availabilityOptions }, log: () => {} }); };
  await launch();
  t.after(async () => { await app.close(); await fs.rm(home, { recursive: true, force: true }); });
  const get = async endpoint => (await fetch(app.uiUrl + endpoint)).json();
  const post = async (endpoint, body) => {
    const response = await fetch(app.uiUrl + endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { code: response.status, data: await response.json() };
  };
  const status = () => get('/api/status');
  const bind = async (targetName, names, revision) => post('/api/accounts/bind', { targetName, names, revision: revision || (await status()).accountBindingsRevision });
  const unbind = async (name, all = false) => {
    const s = await status(); const row = s.keys.find(entry => entry.name === name);
    return post('/api/accounts/unbind', { name, all, accountId: row.accountId, revision: s.accountBindingsRevision });
  };
  const login = (name, username = 'normal') => post('/api/availability/login', { site: 'input', name, username, password: fixture.PASSWORD });
  return { home, status, post, bind, unbind, login, rows: async () => (await get('/api/availability')).rows,
    restart: async () => { await app.close(); await launch(); }, store: () => app.store };
}

test('manual bindings persist, share login through any member, and unbind restores original accounts', async t => {
  const ctx = await setup(t);
  assert.equal((await ctx.login('A')).code, 200);
  assert.equal((await ctx.login('B', 'other')).code, 200);
  const before = await ctx.status();
  const bound = await ctx.bind('A', ['B']); assert.equal(bound.code, 200);
  let status = bound.data.status;
  const shared = status.keys.find(entry => entry.name === 'A').accountId;
  assert.notEqual(shared, accountId(keys[0]));
  assert.ok(['A', 'A alias', 'B'].every(name => status.keys.find(entry => entry.name === name).accountId === shared));
  assert.equal(status.keys.find(entry => entry.name === 'B').accountSourceName, 'A');
  assert.equal(group(status.keys.filter(entry => entry.merchantId === 'input')).length, 1);
  let rows = await ctx.rows();
  assert.ok(rows.filter(row => ['A', 'A alias', 'B'].includes(row.name)).every(row => row.balance.amount === 67.89123));
  assert.equal(rows.find(row => row.name === 'C').balance.state, 'auth-required');
  assert.equal((await new MonitorAuth(ctx.home, 'input', accountId(keys[2])).read()).token, SECOND_TOKEN);
  if (process.platform !== 'win32') assert.equal((await fs.stat(new MonitorAuth(ctx.home, 'input', shared).file)).mode & 0o777, 0o600);
  await ctx.restart();
  assert.equal((await ctx.status()).keys.find(entry => entry.name === 'B').accountId, shared);
  assert.equal((await ctx.login('B', 'other')).code, 200);
  rows = await ctx.rows();
  assert.ok(rows.filter(row => ['A', 'A alias', 'B'].includes(row.name)).every(row => row.balance.amount === 222));
  assert.equal((await ctx.post('/api/availability/authorization', { site: 'input', name: 'A alias', accountId: shared, token: '' })).code, 200);
  assert.ok((await ctx.rows()).filter(row => ['A', 'A alias', 'B'].includes(row.name)).every(row => row.balance.state === 'auth-required'));
  await ctx.login('A');
  assert.equal((await ctx.bind('A', ['C'], before.accountBindingsRevision)).code, 409);
  assert.equal((await ctx.unbind('B')).code, 200);
  rows = await ctx.rows();
  assert.equal(rows.find(row => row.name === 'A').balance.amount, 67.89123);
  assert.equal(rows.find(row => row.name === 'B').balance.amount, 222);
  assert.equal((await ctx.unbind('A', true)).code, 200);
  status = await ctx.status();
  assert.equal(status.keys.find(entry => entry.name === 'A').accountId, accountId(keys[0]));
  assert.ok(status.keys.every(entry => !entry.accountBindingId));
  const config = JSON.parse(await fs.readFile(path.join(ctx.home, 'key_config.json'), 'utf8'));
  assert.deepEqual(config, { keys, extra: 'preserved' });
  const serialized = JSON.stringify({ status, rows, bound });
  for (const secret of [fixture.INPUT_TOKEN, SECOND_TOKEN, fixture.PASSWORD, ...keys.map(entry => entry.value)]) assert.ok(!serialized.includes(secret));
});

test('merging bound groups preserves the chosen account and cancels obsolete two-factor challenges', async t => {
  const ctx = await setup(t);
  await ctx.login('A'); await ctx.login('C', 'other');
  await ctx.bind('A', ['B']); await ctx.bind('C', ['D']);
  const old = await ctx.status(); const oldId = old.keys.find(entry => entry.name === 'D').accountId;
  const challenge = await ctx.login('D', 'otp'); assert.equal(challenge.data.requires2fa, true);
  assert.equal((await ctx.bind('A', ['C'])).code, 200);
  const status = await ctx.status(); const id = status.keys.find(entry => entry.name === 'A').accountId;
  assert.ok(status.keys.filter(entry => entry.merchantId === 'input').every(entry => entry.accountId === id));
  assert.equal(status.keys[0].boundAccountCount, 4);
  assert.equal((await ctx.post('/api/availability/login', { site: 'input', name: 'D', accountId: oldId, challengeId: challenge.data.challengeId, code: '123456' })).code, 409);
  assert.equal((await ctx.post('/api/availability/login', { site: 'input', name: 'D', challengeId: challenge.data.challengeId, code: '123456' })).code, 410);
  const next = await ctx.login('B', 'otp');
  assert.equal((await ctx.post('/api/availability/login', { site: 'input', name: 'C', accountId: id, challengeId: next.data.challengeId, code: '123456' })).code, 200);
  assert.ok((await ctx.rows()).filter(row => row.name !== 'Foreign').every(row => row.balance.amount === 67.89123));
  await ctx.unbind('D');
  assert.equal((await ctx.rows()).find(row => row.name === 'D').balance.state, 'auth-required');
});

test('bindings survive rename and key rotation but cannot cross merchants or accept stale edits', async t => {
  const ctx = await setup(t);
  await ctx.login('A'); await ctx.bind('A', ['B']);
  let s = await ctx.status(); let row = s.keys.find(entry => entry.name === 'B'); const id = row.accountId;
  const edited = await ctx.post('/api/keys/edit', { originalName: 'B', name: 'B renamed', baseurl: row.baseurl, value: 'sk-rotated', revision: row.revision });
  assert.equal(edited.code, 200);
  row = edited.data.status.keys.find(entry => entry.name === 'B renamed');
  assert.equal(row.accountId, id);
  assert.equal((await ctx.rows()).find(entry => entry.name === 'B renamed').balance.amount, 67.89123);
  assert.equal((await ctx.bind('A', ['Foreign'])).code, 400);
  assert.equal((await ctx.post('/api/availability/login', { site: 'aixor', name: 'B renamed', username: 'normal', password: fixture.PASSWORD })).code, 400);
  const moved = await ctx.post('/api/keys/edit', { originalName: row.name, name: row.name, baseurl: 'https://aixor.cc/v1', value: '', revision: row.revision });
  assert.equal(moved.code, 200);
  assert.equal(moved.data.status.keys.find(entry => entry.name === row.name).accountBindingId, null);
  assert.equal((await ctx.rows()).find(entry => entry.name === row.name).balance.state, 'auth-required');
  assert.notEqual(merchantId('https://aixor.cc.evil.example/v1'), 'aixor');
  assert.equal(merchantId('https://cf.api.fan/v1'), merchantId('https://codex-api.packycode.com/v1'));
});

test('binding credentials and metadata commit together and roll back on a state write failure', async t => {
  const ctx = await setup(t);
  await ctx.login('A');
  const store = ctx.store();
  const originals = (await fs.readdir(store.runtimeDir)).filter(file => file.endsWith('-monitor-auth.json')).sort();
  store.write = async (file, text) => { if (file === store.statePath) throw new Error('Fixture disk error'); return atomicWrite(file, text); };
  assert.equal((await ctx.bind('A', ['B'])).code, 500);
  store.write = atomicWrite;
  const status = await ctx.status();
  assert.ok(status.keys.every(entry => !entry.accountBindingId));
  assert.deepEqual((await fs.readdir(store.runtimeDir)).filter(file => file.endsWith('-monitor-auth.json')).sort(), originals);
  assert.equal(status.writeBlocked, false);
  assert.equal((await new MonitorAuth(ctx.home, 'input', accountId(keys[0])).read()).token, fixture.INPUT_TOKEN);
});

test('an in-flight snapshot cannot return pre-binding balances after accounts merge', async t => {
  let release, reached;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { reached = resolve; });
  let pause = false;
  const ctx = await setup(t, keys, { request: async (url, options) => {
    if (pause && url === BALANCE_ENDPOINT && options.token === SECOND_TOKEN) { reached(); await gate; }
    return request(url, options);
  } });
  await ctx.login('A'); await ctx.login('B', 'other');
  pause = true;
  const snapshot = ctx.rows();
  await started;
  try { assert.equal((await ctx.bind('A', ['B'])).code, 200); }
  finally { release(); }
  const rows = await snapshot;
  assert.equal(rows.find(entry => entry.name === 'B').balance.amount, 67.89123);
});

test('bound Packycode keys share the selected balance source, including refresh and unbinding', async t => {
  const entries = [{ name: 'Packy A', baseurl: 'https://cf.api.fan/v1', value: 'sk-packy-a' }, { name: 'Packy B', baseurl: 'https://codex-api.packycode.com/v1', value: 'sk-packy-b' }];
  const calls = [];
  const ctx = await setup(t, entries, { packyBalanceOptions: { request: async (_url, { apiKey }) => {
    calls.push(apiKey); return { code: true, data: { name: 'Fixture', total_available: apiKey.endsWith('a') ? 50000000 : 100000000, total_granted: 250000000, total_used: 0 } };
  } } });
  await ctx.rows();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await ctx.rows())[1].balance.amount, 200);
  const result = await ctx.bind('Packy A', ['Packy B']); assert.equal(result.code, 200);
  assert.equal(group(result.data.status.keys).length, 1);
  assert.ok((await ctx.rows()).every(row => row.balance.amount === 100));
  calls.length = 0;
  assert.equal((await ctx.post('/api/packycode/balance/refresh', { name: 'Packy B' })).code, 200);
  assert.deepEqual(calls, ['sk-packy-a']);
  await ctx.unbind('Packy B');
  assert.equal((await ctx.rows())[1].balance.amount, 200);
});
