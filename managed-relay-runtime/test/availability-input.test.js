const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { Availability, MODELS, requestJson } = require('../availability');
const { ENDPOINT, POOLS, poolForName, readInputStatus, channelSnapshot } = require('../availability-input');
const keyGroups = require('../input-key-groups');
const { ConfigStore } = require('../config-store');
const { MonitorAuth } = require('../monitor-auth');
const { accountId } = require('../relay-identity');
const { health } = require('../auto-switch-policy');
const { start } = require('../../managed-relay-server');
const fixture = require('./input-fixture');
const NOW = Date.now();
const entries = fixture.KEYS.map((value, i) => ({ name: 'INPUT ' + i, value, baseurl: 'https://ai.input.im/v1' }));

async function setup(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'input-pools-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  await fs.writeFile(path.join(home, 'config.toml'), 'model_provider="relay"\n[model_providers.relay]\nbase_url="https://ai.input.im/v1"\n');
  await fs.writeFile(path.join(home, 'key_config.json'), JSON.stringify({ keys: entries }));
  const store = new ConfigStore(home, 'http://127.0.0.1:3211/v1');
  for (const entry of entries) await new MonitorAuth(home, 'input', accountId(entry)).save(fixture.TOKEN);
  return { home, store };
}

test('INPUT preserves all three exact pools, source rates and separate red/yellow/green samples', () => {
  const payload = fixture.status(NOW);
  payload.data.items[0].timeline[0].status = 'failed';
  payload.data.items[1].timeline[0].status = 'degraded';
  payload.data.items.reverse();
  const parsed = readInputStatus(payload, MODELS, NOW);
  assert.deepEqual(parsed[MODELS[0]], parsed[MODELS[1]]);
  const row = channelSnapshot(parsed[MODELS[0]], {}, NOW);
  assert.deepEqual(row.channels.map(c => c.groupLabel), POOLS);
  assert.deepEqual(row.channels.map(c => c.state), ['unavailable', 'degraded', 'available']);
  assert.equal(row.channels[0].uptimePct, 95);
  assert.equal(row.channels[0].history.length, 60);
  assert.equal(row.channels[0].metrics.pingMs, 10);
  assert.match(row.channels[0].sourceModelLabel, /gpt-5.6-sol/);
  assert.equal(channelSnapshot(parsed[MODELS[0]], {}, NOW + 180001).state, 'stale');
  assert.equal(poolForName('  ＣｏｄｅＸ 余额-2  '), POOLS[1]);
  for (const name of ['CodeX 余额-20', 'CodeX 余额-2 备用', 'CodeX Plus 年度']) assert.equal(poolForName(name), null);
  for (const mutate of [p => p.data.items.push(p.data.items[0]), p => p.data.items[0].timeline.push(p.data.items[0].timeline[0]),
    p => { p.data.items[0].availability_7d = 101; }, p => { p.data.items[0].timeline[0].status = 'bogus'; }]) {
    const invalid = fixture.status(NOW); mutate(invalid); assert.throws(() => readInputStatus(invalid, MODELS, NOW));
  }
});

test('INPUT key mapping paginates with exact keys, retains hashes only and confines credentials', async () => {
  const calls = [];
  const groups = await keyGroups.readKeyGroups(async url => {
    calls.push(url); const page = Number(new URL(url).searchParams.get('page'));
    const result = fixture.keyPage(page, [fixture.KEYS[page - 1]], [POOLS[page - 1]]); result.data.pages = 2; return result;
  }, keyGroups.keyEndpoint(1), { signal: new AbortController().signal });
  assert.equal(calls.length, 2);
  assert.equal(groups[keyGroups.keyHash(fixture.KEYS[1])].pool, POOLS[1]);
  assert.ok(!JSON.stringify(groups).includes(fixture.KEYS[0]));
  const settings = { site: 'input', token: fixture.TOKEN, signal: new AbortController().signal,
    outbound: { resolve: async () => { throw new Error('network boundary'); } } };
  for (const url of [ENDPOINT, keyGroups.keyEndpoint(1), keyGroups.keyEndpoint(100)]) await assert.rejects(requestJson(url, settings), /network boundary/);
  for (const url of [ENDPOINT + '?redirect=x', keyGroups.keyEndpoint(101), keyGroups.keyEndpoint(1) + '&page=2',
    'https://status.input.im/api/status', 'https://api.aigo0.com/api/v1/channel-monitors']) await assert.rejects(requestJson(url, settings), /target rejected/);
});

test('INPUT all mode shows three pools; simple and automatic modes follow each key without changing the preference', async t => {
  const { home, store } = await setup(t);
  const monitor = new Availability({}, { home, clock: () => NOW, getEntry: name => store.entry(name), getEntries: async () => (await store.status()).keys,
    request: async (url, options) => url === ENDPOINT ? fixture.status(NOW) : fixture.request(url, options) });
  t.after(() => monitor.close());
  const keys = (await store.status()).keys;
  let rows = (await monitor.snapshot(keys)).rows;
  assert.equal(rows[1].channels.length, 3); assert.equal(rows[1].channels[0].groupLabel, POOLS[1]);
  assert.equal(rows[1].collapsibleChannels, false);
  for (const options of [{ followApiKey: true }, { automatic: true }]) {
    rows = (await monitor.snapshot(keys, MODELS[0], options)).rows;
    assert.deepEqual(rows.map(r => r.channels.length), [1, 1]);
    assert.deepEqual(rows.map(r => r.channels[0].groupLabel), POOLS.slice(0, 2));
    assert.ok(rows.every(r => health(r, NOW).current === 'available'));
  }
  assert.ok((await store.status()).keys.every(key => key.statusMode === 'all'));
});

test('INPUT account mappings refresh, unknown or failed mappings never reuse the previous pool, and other accounts remain isolated', async t => {
  const { home, store } = await setup(t);
  let now = NOW, group = POOLS[1], keyFailure = false, statusFailure = 0;
  const calls = [];
  const monitor = new Availability({}, { home, clock: () => now, getEntry: name => store.entry(name), getEntries: async () => (await store.status()).keys,
    request: async (url, options) => {
      calls.push(url);
      if (url === ENDPOINT) { if (statusFailure) throw Object.assign(new Error('private error'), { status: statusFailure }); return fixture.status(now); }
      if (keyGroups.isKeyEndpoint(url)) {
        if (keyFailure) throw new Error('private mapping failure');
        return fixture.keyPage(1, fixture.KEYS, [POOLS[0], group]);
      }
      return fixture.request(url, options);
    } });
  t.after(() => monitor.close());
  const keys = (await store.status()).keys;
  await Promise.all([monitor.snapshot(keys), monitor.snapshot(keys, MODELS[1])]);
  assert.equal(calls.filter(u => u === ENDPOINT).length, 2); // One per authorized account, shared by model choices.
  group = POOLS[2]; now += 15001;
  let row = (await monitor.snapshot(keys, MODELS[0], { followApiKey: true })).rows[1];
  assert.equal(row.channels[0].groupLabel, POOLS[2]);
  group = 'CodeX Plus 年度'; now += 15001;
  row = (await monitor.snapshot(keys, MODELS[0], { followApiKey: true })).rows[1];
  assert.equal(row.state, 'no-data'); assert.equal(row.channels.length, 0); assert.match(row.message, /监测范围/);
  group = POOLS[1]; keyFailure = true; now += 15001;
  row = (await monitor.snapshot(keys, MODELS[0], { followApiKey: true })).rows[1];
  assert.equal(row.channels.length, 0); assert.ok(row.failure);
  keyFailure = false; statusFailure = 503; now += 15001;
  row = (await monitor.snapshot(keys, MODELS[0], { followApiKey: true })).rows[1];
  assert.equal(row.state, 'stale'); assert.equal(row.channels[0].history.length, 60);
  statusFailure = 401; now += 15001;
  row = (await monitor.snapshot(keys, MODELS[0], { followApiKey: true })).rows[1];
  assert.equal(row.state, 'auth-required');
  assert.equal(health(row, now).current, 'unknown');
  await monitor.authorize('input', '', undefined, { name: entries[0].name });
  statusFailure = 0; now += 15001;
  const rows = (await monitor.snapshot(keys, MODELS[0], { followApiKey: true })).rows;
  assert.equal(rows[0].state, 'auth-required'); assert.equal(rows[1].state, 'available');
  assert.ok(!JSON.stringify(rows).includes(fixture.KEYS[1]));
});

test('INPUT HTTP mode changes persist independently, reject conflicts and survive rename', async t => {
  const { home } = await setup(t);
  const app = await start({ home, uiPort: 0, proxyPort: 0, availabilityOptions: { request: fixture.request }, log: () => {} });
  t.after(() => app.close());
  const post = payload => fetch(app.uiUrl + '/api/input/status/mode', { method: 'POST', headers: { origin: app.uiUrl, 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  const status = await app.store.status(), entry = status.keys[0];
  assert.equal(status.inputStatusModeAvailable, true);
  const payload = { name: entry.name, mode: 'api-key', previousMode: 'all', revision: entry.revision };
  assert.equal((await post(payload)).status, 200);
  assert.equal((await post(payload)).status, 409);
  assert.deepEqual((await app.store.status()).keys.map(k => k.statusMode), ['api-key', 'all']);
  let rows = (await (await fetch(app.uiUrl + '/api/availability')).json()).rows;
  assert.deepEqual(rows.map(r => r.channels.length), [1, 3]);
  rows = (await (await fetch(app.uiUrl + '/api/availability?view=simple')).json()).rows;
  assert.deepEqual(rows.map(r => r.channels.length), [1, 1]);
  await app.store.edit(entry.name, { name: 'renamed', value: '', baseurl: entry.baseurl, revision: entry.revision });
  assert.equal((await app.store.status()).keys.find(k => k.name === 'renamed').statusMode, 'api-key');
  await app.store.edit('renamed', { name: 'renamed', value: '', baseurl: 'https://other.example/v1', revision: (await app.store.status()).keys.find(k => k.name === 'renamed').revision });
  assert.equal(JSON.parse(await fs.readFile(app.store.statePath)).inputStatusModes.renamed, undefined);
});

test('INPUT view renders all three pools and invalidates all-mode data when switching to simple view', async () => {
  const context = vm.createContext({ Intl, Date, escapeHtml: s => String(s).replaceAll('<', '&lt;') });
  vm.runInContext(await fs.readFile(path.join(__dirname, '../../managed-relay-public/availability.js'), 'utf8') + '\nthis.View = RelayAvailability;', context);
  const view = Object.create(context.View.prototype);
  Object.assign(view, { model: MODELS[0], error: '', rows: new Map(), rowIdentities: new Map(), rowFailures: new Map() });
  const status = readInputStatus(fixture.status(NOW), MODELS, NOW)[MODELS[0]];
  const row = { ...status, ...channelSnapshot(status, {}, NOW) };
  assert.equal((view.markup(row).match(/class="availability-bars/g) || []).length, 3);
  const state = { home: '/tmp/test', keys: [{ name: 'INPUT', merchantId: 'input', statusMode: 'all', baseurl: entries[0].baseurl }] };
  view.getView = () => 'advanced'; view.reconcileRows(state);
  view.rows.set(JSON.stringify(['INPUT', entries[0].baseurl]), row);
  view.getView = () => 'simple'; view.reconcileRows(state);
  assert.equal(view.rows.size, 0);
});

test('INPUT selector is constructed, painted and submits only its own mode change', async () => {
  const events = new Map(), changes = [], target = { dataset: {}, innerHTML: '' };
  const fieldset = { disabled: false };
  const account = { dataset: { name: 'INPUT' }, querySelector: selector => selector === '.input-status-mode' ? target : null };
  const state = { inputStatusModeAvailable: true, keys: [{ name: 'INPUT', statusMode: 'all', revision: 'revision' }] };
  const list = { addEventListener: (name, fn) => { events.set(name, [...events.get(name) || [], fn]); } };
  class EmptyControl {}
  const context = vm.createContext({ Intl, Date, escapeHtml: s => String(s), localStorage: { getItem: () => null },
    document: { hidden: true, addEventListener() {} }, window: { addEventListener() {} }, setTimeout, clearTimeout,
    PackyBalanceControls: EmptyControl, TimiccStatusControls: EmptyControl, MonitorAuthorization: EmptyControl });
  vm.runInContext(await fs.readFile(path.join(__dirname, '../../managed-relay-public/aigo-status.js'), 'utf8') + '\n' +
    await fs.readFile(path.join(__dirname, '../../managed-relay-public/availability.js'), 'utf8') + '\nthis.View = RelayAvailability;', context);
  const client = new context.View({ list, select: { addEventListener() {} }, getState: () => state,
    mutateInputStatusMode: async payload => { changes.push(payload); state.keys[0].statusMode = payload.mode; },
    mutateAigoStatusMode: () => assert.fail('INPUT must not change Aigo'), isDragging: () => false });
  client.paint = () => client.input.paint(target, 'INPUT');
  client.refresh = () => {};
  client.paint();
  assert.match(target.innerHTML, /input-mode-option/);
  assert.match(target.innerHTML, /全部号池/);
  await client.input.setMode({ value: 'api-key', closest: selector => selector === '.provider-account' ? account : fieldset });
  assert.equal(changes.length, 1); assert.equal(changes[0].mode, 'api-key');
  assert.equal(changes[0].previousMode, 'all'); assert.equal(changes[0].revision, 'revision');
  assert.match(target.innerHTML, /value="api-key" checked/);
  client.cancel();
});
