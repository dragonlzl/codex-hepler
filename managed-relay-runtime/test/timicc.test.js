const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { Availability, MODELS, adapterFor, requestJson } = require('../availability');
const { MonitorAuth } = require('../monitor-auth');
const { MonitorLogin } = require('../monitor-login');
const { accountId, merchantId } = require('../relay-identity');
const { bindingModel } = require('../account-bindings');
const { ConfigStore } = require('../config-store');
const timiccKeys = require('../timicc-key-groups');
const { readTimiccStatus, channelSnapshot, ENDPOINT, POOLS } = require('../availability-timicc');
const { start } = require('../../managed-relay-server');
const fixture = require('./timicc-fixture');
const NOW = Date.now();
const keys = [{ name: 'timi', baseurl: 'https://timicc.com', value: 'sk-not-login' }, { name: 'timi backup', baseurl: 'https://timicc.com', value: 'sk-other' }];
async function temp(t) { const home = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-timi-')); t.after(() => fs.rm(home, { recursive: true, force: true })); return home; }

test('timiCC recognizes exact hosts and preserves legacy account binding identities', () => {
  for (const baseurl of ['https://timicc.com', 'https://www.timicc.com/v1']) { assert.equal(adapterFor(baseurl).id, 'timicc'); assert.equal(merchantId(baseurl), 'timicc'); }
  for (const url of ['https://timicc.com.evil.example', 'https://timicc.com:8443', 'https://user@timicc.com']) assert.equal(adapterFor(url), null);
  const members = keys.map(accountId), id = 'e'.repeat(64);
  const state = { accountBindings: [{ id, merchant: 'https://timicc.com', members, sourceId: members[0] }] };
  assert.equal(bindingModel(keys, state).describe(keys[1]).accountId, id);
  assert.equal(state.accountBindings[0].merchant, 'https://timicc.com');
});

test('both model choices share two exact pools without treating the probe as a model-specific test', () => {
  const payload = fixture.status(NOW);
  payload.providerTimelines.push({ ...payload.providerTimelines[0], id: 'unrelated', latest: { ...payload.providerTimelines[0].latest, name: POOLS[0] + '扩展备用', status: 'failed' } });
  const status = readTimiccStatus(payload, MODELS, NOW);
  assert.deepEqual(status[MODELS[0]], status[MODELS[1]]);
  assert.deepEqual(status[MODELS[0]].channels.map(channel => channel.groupLabel), POOLS);
  const channels = channelSnapshot(status[MODELS[0]], {}, NOW).channels;
  assert.deepEqual(channels.map(c => c.state), ['available', 'degraded']);
  assert.equal(channels[0].history.length, 60); assert.ok(channels[0].history[0].at < channels[0].history.at(-1).at);
  assert.equal(channels[1].uptimePct, 92); // Source seven-day rate, not the last sixty-point mean.
  assert.equal(channels[1].metrics.latencyMs, 35000); assert.equal(channels[1].metrics.pingMs, 58);
  assert.match(channels[0].sourceModelLabel, /gpt-5.6-sol/); assert.match(status[MODELS[0]].modelNote, /共用/);
});

test('pool faults, maintenance, missing data and staleness stay distinct and official status cannot mask errors', () => {
  for (const [source, state] of [['failed', 'unavailable'], ['error', 'unavailable'], ['validation_failed', 'degraded'], ['maintenance', 'maintenance']]) {
    const payload = fixture.status(NOW); payload.providerTimelines[0].latest.status = source;
    const row = channelSnapshot(readTimiccStatus(payload, MODELS, NOW)[MODELS[0]], {}, NOW);
    assert.equal(row.channels[0].state, state);
    if (state === 'unavailable') assert.equal(row.state, 'unavailable');
  }
  const payload = fixture.status(NOW); payload.providerTimelines.pop();
  const parsed = readTimiccStatus(payload, MODELS, NOW)[MODELS[0]];
  const missing = channelSnapshot(parsed, {}, NOW);
  assert.equal(missing.state, 'no-data'); assert.equal(missing.channels[1].last, null); assert.deepEqual(missing.channels[1].history, []);
  assert.equal(channelSnapshot(parsed, {}, NOW + 900001).channels[0].state, 'stale');
  assert.equal(channelSnapshot(parsed, { error: true }, NOW).channels[0].state, 'stale');
  assert.equal(channelSnapshot(parsed, { error: true }, NOW).channels[1].state, 'error');
});

test('malformed or ambiguous pool data never becomes successful checks', () => {
  for (const mutate of [p => p.providerTimelines.push(p.providerTimelines[0]), p => { p.groupName = 'other'; }, p => { p.providerTimelines[0].latest.status = 'unknown'; },
    p => { p.providerTimelines[0].items[0].latencyMs = -1; }, p => p.providerTimelines[0].items.push(p.providerTimelines[0].items[0]),
    p => { p.availabilityStats['pool-0'][0].availabilityPct = 101; }]) {
    const p = fixture.status(NOW); mutate(p); assert.throws(() => readTimiccStatus(p, MODELS, NOW));
  }
});

test('multiple timiCC routes and model switches share one public request, while balances stay account-scoped', async t => {
  const home = await temp(t), entries = keys.map(entry => ({ ...entry, accountId: accountId(entry) }));
  const calls = []; let clock = NOW, fail = false;
  await new MonitorAuth(home, 'timicc', entries[0].accountId).save(fixture.TOKEN);
  const monitor = new Availability({}, { home, clock: () => clock, getEntries: async () => entries, request: async (url, options) => {
    calls.push(url);
    if (url === ENDPOINT) { assert.equal(options.token, undefined); if (fail) throw new Error('private failure'); return fixture.status(clock); }
    return fixture.request(url, options);
  } });
  t.after(() => monitor.close());
  const [astra, sol] = await Promise.all([monitor.snapshot(entries), monitor.snapshot(entries, MODELS[1])]);
  assert.equal(calls.filter(url => url === ENDPOINT).length, 1);
  assert.equal(astra.rows[0].balance.amount, 4.00491851); assert.equal(astra.rows[1].balance.state, 'auth-required');
  assert.deepEqual(astra.rows[0].channels, sol.rows[0].channels);
  fail = true; clock += 15001;
  const stale = (await monitor.snapshot(entries)).rows[0];
  assert.equal(stale.state, 'stale'); assert.ok(stale.channels.every(c => c.state === 'stale'));
  assert.ok(stale.channels.every(c => c.history.length === 60)); assert.equal(stale.balance.state, 'available');
});

test('timiCC supports password, OTP, manual token and clear without exposing credentials', async t => {
  const home = await temp(t), calls = [];
  const monitor = new Availability({}, { home, request: async (url, options) => { calls.push({ url, json: options.json }); return fixture.request(url, options); } });
  t.after(() => monitor.close());
  const login = { site: 'timicc', username: 'normal', password: fixture.PASSWORD, agreement: true };
  await assert.rejects(monitor.login({ ...login, agreement: false }), /服务条款/); assert.equal(calls.length, 0);
  const result = await monitor.login(login);
  assert.deepEqual(calls[0].json, { email: 'normal', password: fixture.PASSWORD });
  assert.ok(!JSON.stringify(result).includes(fixture.TOKEN));
  const auth = new MonitorAuth(home, 'timicc'); assert.equal((await auth.read()).token, fixture.TOKEN);
  const disk = await fs.readFile(auth.file, 'utf8'); assert.ok(!disk.includes(fixture.PASSWORD));
  if (process.platform !== 'win32') assert.equal((await fs.stat(auth.file)).mode & 0o777, 0o600);
  const challenge = await monitor.login({ ...login, username: 'otp' }); assert.equal(challenge.requires2fa, true);
  await assert.rejects(monitor.login({ site: 'timicc', challengeId: challenge.challengeId, code: '000000' }), /验证码/);
  await monitor.login({ site: 'timicc', challengeId: challenge.challengeId, code: '123456' });
  await monitor.authorize('timicc', fixture.TOKEN);
  await monitor.authorize('timicc', ''); assert.equal(await auth.read(), null);
  assert.equal(await new MonitorAuth(home, 'input').read(), null);
});

test('timiCC credentials never go to the status host or unrelated endpoints', async () => {
  const options = { site: 'timicc', token: fixture.TOKEN, outbound: { resolve: async () => { throw new Error('Network must not be reached'); } }, signal: new AbortController().signal };
  for (const url of [ENDPOINT, 'https://status.timicc.com/', 'https://timicc.com/api/v1/keys', 'https://www.timicc.com/api/v1/auth/me', fixture.BALANCE_ENDPOINT + '?next=x']) await assert.rejects(requestJson(url, options), /target rejected/);
  await assert.rejects(requestJson(ENDPOINT, { ...options, token: undefined, json: { email: 'secret', password: 'secret' } }), /target rejected/);
});

test('multi-channel UI renders separate bars and filters a red pool without averaging it away', async () => {
  const source = await fs.readFile(path.join(__dirname, '../../managed-relay-public/availability.js'), 'utf8');
  const context = vm.createContext({ Intl, Date, escapeHtml: value => String(value).replace(/[&<>"']/g, c => '&#' + c.charCodeAt(0) + ';') });
  vm.runInContext(source + '\nthis.View = RelayAvailability;', context);
  const view = Object.create(context.View.prototype); view.model = MODELS[0]; view.error = '';
  const status = readTimiccStatus(fixture.status(NOW), MODELS, NOW)[MODELS[0]];
  let row = { ...status, ...channelSnapshot(status, {}, NOW) };
  const html = view.markup(row);
  for (const name of POOLS) assert.ok(html.includes(name));
  assert.equal((html.match(/class="availability-bars/g) || []).length, 2);
  assert.match(html, /端点 PING/); assert.ok(!html.includes('首 Token')); assert.match(html, /共用/);
  assert.equal(context.View.filterState(row), 'available');
  row.channels[1].history.at(-1).state = 'unavailable';
  assert.equal(context.View.filterState(row), 'unavailable');
  row.channels[1] = { state: 'no-data', history: [], sampleCount: 0 };
  assert.equal(context.View.filterState(row), null);
});

test('key groups use complete key matching, exact pool names and validated pagination', async () => {
  const calls = [], signal = new AbortController().signal;
  const result = await timiccKeys.readKeyGroups(async url => {
    calls.push(url);
    const page = Number(new URL(url).searchParams.get('page'));
    return { code: 0, data: { page, pages: 2, page_size: 100, items: [{ key: keys[page - 1].value,
      group: { name: page === 1 ? 'CodeX team/plus号池' : 'Codex Pro号池' } }] } };
  }, timiccKeys.endpoint(1), { signal });
  assert.deepEqual(calls, [timiccKeys.endpoint(1), timiccKeys.endpoint(2)]);
  assert.equal(result[timiccKeys.keyHash(keys[0].value)].pool, POOLS[0]);
  assert.equal(result[timiccKeys.keyHash(keys[1].value)].pool, POOLS[1]);
  assert.ok(keys.every(key => !JSON.stringify(result).includes(key.value)));
  for (const group of ['Codex Pro号池备用', 'Pro', '', null]) assert.equal(timiccKeys.poolForGroup(group), null);
  assert.equal(timiccKeys.poolForGroup(' CodeX TEAM/PLUS号池 '), POOLS[0]);
  for (const mutate of [p => { p.data.pages = 101; }, p => { p.data.page = 2; }, p => { p.code = 1; },
    p => { p.data.items[0].key = null; }, p => { p.data.items.push(p.data.items[0]); }]) {
    const p = await fixture.request(timiccKeys.endpoint(1), { token: fixture.TOKEN }); mutate(p);
    await assert.rejects(timiccKeys.readKeyGroups(async () => p, timiccKeys.endpoint(1), { signal }));
  }
  const abort = new AbortController(); abort.abort();
  await assert.rejects(timiccKeys.readKeyGroups(async () => ({}), timiccKeys.endpoint(1), { signal: abort.signal }));
  const options = { site: 'timicc', token: fixture.TOKEN, signal, outbound: { resolve: async () => { throw new Error('Allowed network boundary'); } } };
  await assert.rejects(requestJson(timiccKeys.endpoint(2), options), /Allowed network boundary/);
  for (const suffix of ['&redirect=evil', '#x', '&page_size=1']) await assert.rejects(requestJson(timiccKeys.endpoint(1) + suffix, options), /target rejected/);
});

test('follow mode uses each child key with a shared login; all mode requires no key lookup', async t => {
  const home = await temp(t), shared = 'b'.repeat(64), calls = [];
  let clock = NOW, groupName = POOLS[0], fail = false;
  const entries = keys.map(entry => ({ ...entry, accountId: shared, naturalAccountId: accountId(entry), accountBindingId: shared, accountSourceName: keys[0].name, statusMode: 'all' }));
  await new MonitorAuth(home, 'timicc', shared).save(fixture.TOKEN);
  const monitor = new Availability({}, { home, getEntries: async () => entries, getEntry: async name => keys.find(key => key.name === name), clock: () => clock,
    request: async (url, options) => {
      calls.push(url);
      if (url === timiccKeys.endpoint(1)) {
        if (fail) throw Object.assign(new Error('Lookup failed'), { status: 503 });
        const data = await fixture.request(url, options); data.data.items[0].group.name = groupName; return data;
      }
      return fixture.request(url, options);
    } });
  t.after(() => monitor.close());
  let rows = (await monitor.snapshot(entries)).rows;
  assert.ok(rows.every(row => row.channels.length === 2)); assert.ok(!calls.includes(timiccKeys.endpoint(1)));
  entries.forEach(entry => { entry.statusMode = 'api-key'; });
  rows = (await monitor.snapshot(entries)).rows;
  assert.deepEqual(rows.map(row => row.channels[0].groupLabel), POOLS);
  assert.ok(rows.every(row => row.channels.length === 1 && row.balance.amount === 4.00491851));
  assert.equal(calls.filter(url => url === timiccKeys.endpoint(1)).length, 1);
  assert.ok(keys.every(key => !JSON.stringify(rows).includes(key.value)));
  assert.ok(!JSON.stringify(rows).includes(fixture.TOKEN));
  clock += 15001; groupName = POOLS[1];
  rows = (await monitor.snapshot(entries, MODELS[1])).rows;
  assert.equal(rows[0].channels[0].groupLabel, POOLS[1]);
  clock += 15001; fail = true;
  rows = (await monitor.snapshot(entries)).rows;
  assert.ok(rows.every(row => row.channels.length === 0 && /查询失败/.test(row.message)));
  assert.ok(rows.every(row => row.balance.state === 'available'));
  clock += 15001; fail = false; groupName = 'Codex Pro号池备用';
  rows = (await monitor.snapshot(entries)).rows;
  assert.equal(rows[0].channels.length, 0); assert.match(rows[0].message, /不对应/);
  entries[0].naturalAccountId = accountId({ ...keys[0], value: 'changed' });
  assert.match((await monitor.snapshot(entries)).rows[0].message, /已变更/);
  await monitor.authorize('timicc', '', undefined, { name: keys[0].name });
  assert.ok((await monitor.snapshot(entries)).rows.every(row => row.channels.length === 0 && /请登录/.test(row.message)));
});

test('wrong account never guesses a pool and keys from other accounts stay isolated', async t => {
  const home = await temp(t), entries = keys.map(entry => ({ ...entry, accountId: accountId(entry), statusMode: 'api-key' }));
  await new MonitorAuth(home, 'timicc', entries[0].accountId).save(fixture.TOKEN);
  const monitor = new Availability({}, { home, getEntries: async () => entries,
    getEntry: async name => ({ ...keys.find(key => key.name === name), value: 'key-not-owned-by-authorized-account' }), request: fixture.request });
  t.after(() => monitor.close());
  const rows = (await monitor.snapshot(entries)).rows;
  assert.ok(rows.every(row => row.channels.length === 0));
  assert.match(rows[0].message, /未在授权账号中找到/); assert.match(rows[1].message, /请登录/);
});

test('per-child display choice persists, migrates on rename and rejects stale or invalid edits', async t => {
  const home = await temp(t), alias = { ...keys[0], name: 'timi alias' };
  await fs.writeFile(path.join(home, 'config.toml'), 'model_provider="relay"\n[model_providers.relay]\nbase_url="https://timicc.com"\n');
  await fs.writeFile(path.join(home, 'key_config.json'), JSON.stringify({ keys: [...keys, alias] }));
  const app = await start({ home, uiPort: 0, proxyPort: 0, availabilityOptions: { request: fixture.request }, log: () => {} });
  t.after(() => app.close());
  const post = async body => {
    const res = await fetch(app.uiUrl + '/api/timicc/status/mode', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, data: await res.json() };
  };
  const before = await app.store.status(), entry = before.keys[0];
  const payload = { name: entry.name, mode: 'api-key', previousMode: 'all', revision: entry.revision };
  assert.ok(before.keys.every(row => row.statusMode === 'all'));
  const result = await post(payload); assert.equal(result.status, 200);
  assert.deepEqual(result.data.status.keys.map(row => row.statusMode), ['api-key', 'all', 'all']);
  assert.equal((await post(payload)).status, 409);
  assert.equal((await post({ ...payload, mode: 'both' })).status, 400);
  const fresh = new ConfigStore(home, app.proxyUrl);
  assert.equal((await fresh.status()).keys[0].statusMode, 'api-key');
  await fresh.edit(entry.name, { ...keys[0], name: 'renamed', revision: entry.revision });
  let row = (await fresh.status()).keys.find(entry => entry.name === 'renamed'); assert.equal(row.statusMode, 'api-key');
  await fresh.edit(row.name, { name: row.name, baseurl: 'https://ai.input.im', revision: row.revision });
  const state = JSON.parse(await fs.readFile(fresh.statePath, 'utf8'));
  assert.equal(Object.hasOwn(state.timiccStatusModes, 'renamed'), false);
  assert.equal(Object.hasOwn(state.timiccStatusModes, entry.name), false);
});

test('a pending snapshot cannot restore a previous display mode', async t => {
  const home = await temp(t), entry = { ...keys[0], accountId: accountId(keys[0]), statusMode: 'api-key' };
  await new MonitorAuth(home, 'timicc', entry.accountId).save(fixture.TOKEN);
  let release, started;
  const gate = new Promise(resolve => { release = resolve; }), ready = new Promise(resolve => { started = resolve; });
  const monitor = new Availability({}, { home, getEntries: async () => [entry], getEntry: async () => keys[0], request: async (url, options) => {
    if (url === timiccKeys.endpoint(1)) { started(); await gate; }
    return fixture.request(url, options);
  } });
  t.after(() => monitor.close());
  const pending = monitor.snapshot([entry]); await ready;
  await monitor.changeStatusMode(async () => { entry.statusMode = 'all'; }); release();
  const row = (await pending).rows[0];
  assert.equal(row.statusMode, 'all'); assert.equal(row.channels.length, 2);
});
