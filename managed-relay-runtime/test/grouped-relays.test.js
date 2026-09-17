const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { start } = require('../../managed-relay-server');
const { accountId, providerId } = require('../relay-identity');
const { MonitorAuth } = require('../monitor-auth');
const { group, reorder } = require('../../managed-relay-public/route-groups');
const { BALANCE_ENDPOINT, SUBSCRIPTIONS_ENDPOINT } = require('../account-input');
const fixture = require('./monitor-login-fixture');

const baseurl = 'https://ai.input.im/v1';
const keys = [
  { name: 'Primary', baseurl, value: 'sk-aaaa-secret-1234' },
  { name: 'Alias', baseurl: baseurl + '/', value: 'sk-aaaa-secret-1234' },
  { name: 'Separate', baseurl, value: 'sk-bbbb-secret-1234' },
  { name: 'Other URL', baseurl: 'https://ai.input.im/other', value: 'sk-aaaa-secret-1234' },
];

test('provider and account groups preserve order, distinguish identical masks and isolate URL paths', () => {
  const safe = keys.map(entry => ({ ...entry, providerId: providerId(entry.baseurl), accountId: accountId(entry) }));
  const groups = group(safe);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0].entries.map(entry => entry.name), ['Primary', 'Alias', 'Separate']);
  assert.equal(groups[0].accounts.size, 2);
  assert.equal(safe[0].accountId, safe[1].accountId);
  assert.notEqual(safe[0].accountId, safe[2].accountId);
  assert.notEqual(safe[0].accountId, safe[3].accountId);
  assert.equal(accountId({ ...keys[0], name: 'Renamed' }), safe[0].accountId);
  assert.deepEqual(reorder(safe, 'Separate', 'Primary'), ['Separate', 'Primary', 'Alias', 'Other URL']);
  assert.deepEqual(reorder(safe, 'Primary', 'Other URL', true), ['Other URL', 'Primary', 'Alias', 'Separate']);
  assert.equal(reorder([{ ...safe[0], pinned: true }, ...safe.slice(1)], 'Primary', 'Separate'), null);
});

test('Krill aliases form one provider while their complete URLs distinguish lines and credentials', () => {
  const urls = ['https://api-slb.krill-code.net/codex/v1', 'https://api.cdn-krill-ai.com/coding/v1', 'https://api.cdn-krill-ai.com/codex/v1'];
  const routes = urls.map((baseurl, i) => ({ name: 'Krill ' + i, baseurl, value: 'same-key', providerId: providerId(baseurl), accountId: accountId({ baseurl, value: 'same-key' }) }));
  routes.push({ ...routes[0], name: 'Krill alias', baseurl: urls[0] + '/' });
  const groups = group(routes);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].id, 'krill');
  assert.equal(groups[0].entries.length, 4);
  assert.equal(groups[0].accounts.size, 3);
  assert.deepEqual([...groups[0].accounts.values()].map(entries => entries.length), [2, 1, 1]);
  assert.deepEqual(reorder(routes, 'Krill 2', 'Krill 0'), ['Krill 2', 'Krill 0', 'Krill alias', 'Krill 1']);
  for (const baseurl of ['https://krill-code.com.evil.example/v1', 'https://api.cdn-krill-ai.com:8443/v1', 'https://user@krill-code.com/v1']) {
    assert.notEqual(group([{ name: 'Lookalike', baseurl }])[0].id, 'krill');
  }
});

test('reordering keeps each account with its aliases and supports ordering aliases inside the account', () => {
  const routes = ['A1', 'B1', 'A2', 'B2', 'C1'].map(name => ({ name, baseurl, accountId: name[0] }));
  assert.deepEqual(reorder(routes, 'A2', 'A1'), ['A2', 'A1', 'B1', 'B2', 'C1']);
  assert.deepEqual(reorder(routes, 'B1', 'A2'), ['B1', 'B2', 'A1', 'A2', 'C1']);
  assert.deepEqual(reorder(routes, 'A1', 'C1'), ['B1', 'B2', 'C1', 'A1', 'A2']);
  const pinned = routes.map(entry => ({ ...entry, pinned: entry.name === 'A1' }));
  assert.equal(reorder(pinned, 'A2', 'B1'), null);
  assert.equal(reorder(pinned, 'B1', 'A1'), null);
  assert.deepEqual(reorder(pinned, 'B2', 'B1'), ['A1', 'A2', 'B2', 'B1', 'C1']);
});

test('Krill URLs share one status request while equal keys on different URLs keep independent account authorization', async t => {
  const { Availability } = require('../availability');
  const krillFixture = require('./krill-account-fixture');
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-krill-group-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const entries = ['https://api-slb.krill-code.net/codex/v1', 'https://api.cdn-krill-ai.com/coding/v1', 'https://api.cdn-krill-ai.com/codex/v1']
    .map((baseurl, i) => ({ name: 'Krill ' + i, baseurl, accountId: accountId({ baseurl, value: 'same-key' }) }));
  const calls = [];
  const monitor = new Availability({}, { home, getEntries: async () => entries, request: async (url, options) => {
    calls.push(url); return krillFixture.request(url, options);
  } });
  t.after(() => monitor.close());
  await monitor.login({ site: 'krill', name: entries[0].name, accountId: entries[0].accountId, username: 'normal', password: krillFixture.PASSWORD });
  const snapshot = await monitor.snapshot(entries);
  assert.equal(calls.filter(url => url.includes('/api/public/channel-status')).length, 1);
  assert.deepEqual(snapshot.rows[0].history, snapshot.rows[1].history);
  assert.deepEqual(snapshot.rows[0].history, snapshot.rows[2].history);
  assert.equal(snapshot.rows[0].balance.state, 'available');
  assert.equal(snapshot.rows[1].balance.state, 'auth-required');
  assert.equal(snapshot.rows[2].balance.state, 'auth-required');
});

test('HTTP accounts share login only for matching keys; clear, 2FA, edits and restart remain isolated', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-grouped-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  await fs.writeFile(path.join(home, 'config.toml'), `model_provider="relay"\n[model_providers.relay]\nbase_url="${baseurl}"\n`);
  await fs.writeFile(path.join(home, 'key_config.json'), JSON.stringify({ keys }));
  await fs.writeFile(path.join(home, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: keys[0].value }));
  // Unbound legacy credentials must never silently supply a different key's balance.
  await new MonitorAuth(home, 'input').save(fixture.INPUT_TOKEN);
  const secondToken = fixture.INPUT_TOKEN.replace('inputfixture.', 'second.');
  const calls = [];
  const request = async (url, options) => {
    calls.push({ url, token: options.token });
    if (url === BALANCE_ENDPOINT && options.token === secondToken) return { code: 0, data: { balance: 222 } };
    if (url === SUBSCRIPTIONS_ENDPOINT && options.token === secondToken) return fixture.subscriptions();
    return fixture.request(url, options);
  };
  let app = await start({ home, uiPort: 0, proxyPort: 0, availabilityOptions: { request }, log: () => {} });
  t.after(() => app.close());
  const get = async url => (await fetch(app.uiUrl + url)).json();
  const post = async (url, payload) => {
    const response = await fetch(app.uiUrl + url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    return { code: response.status, body: await response.json() };
  };
  const login = name => post('/api/availability/login', { site: 'input', name, username: 'normal', password: fixture.PASSWORD });
  const authorize = (name, token) => post('/api/availability/authorization', { site: 'input', name, token });
  const rows = async () => (await get('/api/availability')).rows;
  const status = await get('/api/status');
  assert.equal(status.keys[0].accountId, status.keys[1].accountId);
  assert.equal(status.keys[0].maskedValue, status.keys[2].maskedValue);
  assert.ok(keys.every(key => !JSON.stringify(status).includes(key.value)));
  assert.ok((await rows()).every(row => row.balance.state === 'auth-required'));
  assert.equal((await login(undefined)).code, 400);
  assert.equal((await login('Alias')).code, 200);
  calls.length = 0;
  let data = await rows();
  assert.equal(data[0].balance.amount, 67.89123);
  assert.equal(data[1].balance.amount, data[0].balance.amount);
  assert.equal(data[2].balance.state, 'auth-required');
  assert.equal(data[3].balance.state, 'auth-required');
  assert.equal(calls.filter(call => call.url === BALANCE_ENDPOINT).length, 1);
  assert.equal((await authorize('Separate', secondToken)).code, 200);
  data = await rows();
  assert.equal(data[0].balance.amount, 67.89123);
  assert.equal(data[2].balance.amount, 222);
  assert.equal((await authorize('Alias', '')).code, 200);
  data = await rows();
  assert.equal(data[0].balance.state, 'auth-required');
  assert.equal(data[1].balance.state, 'auth-required');
  assert.equal(data[2].balance.amount, 222);

  const challenge = await post('/api/availability/login', { site: 'input', name: 'Primary', username: 'otp', password: fixture.PASSWORD });
  assert.equal(challenge.body.requires2fa, true);
  const step = { site: 'input', challengeId: challenge.body.challengeId, code: '123456' };
  assert.equal((await post('/api/availability/login', { ...step, name: 'Separate' })).code, 410);
  assert.equal((await post('/api/availability/login', { ...step, name: 'Alias' })).code, 200);
  // Identical connection details still retain the explicitly selected display name.
  assert.equal((await post('/api/select', { name: 'Alias', mode: 'direct' })).body.status.activeName, 'Alias');
  const entry = (await get('/api/status')).keys.find(entry => entry.name === 'Alias');
  assert.equal((await post('/api/keys/edit', { originalName: entry.name, revision: entry.revision, name: 'Renamed', baseurl: entry.baseurl, value: '' })).code, 200);
  assert.equal((await get('/api/status')).activeName, 'Renamed');
  const changed = (await get('/api/status')).keys.find(entry => entry.name === 'Separate');
  assert.equal((await post('/api/keys/edit', { originalName: changed.name, revision: changed.revision, name: changed.name, baseurl, value: 'sk-new-key' })).code, 200);
  assert.equal((await post('/api/availability/authorization', { site: 'input', name: changed.name, accountId: changed.accountId, token: secondToken })).code, 409);
  assert.equal((await rows()).find(row => row.name === 'Separate').balance.state, 'auth-required');
  await app.close();
  app = await start({ home, uiPort: 0, proxyPort: 0, availabilityOptions: { request }, log: () => {} });
  data = await rows();
  assert.equal(data.find(row => row.name === 'Renamed').balance.amount, 67.89123);
  assert.equal(data.find(row => row.name === 'Separate').balance.state, 'auth-required');
  assert.equal((await new MonitorAuth(home, 'input').read()).token, fixture.INPUT_TOKEN);
  for (const secret of [...keys.map(key => key.value), fixture.INPUT_TOKEN, secondToken]) assert.ok(!JSON.stringify(data).includes(secret));
});
