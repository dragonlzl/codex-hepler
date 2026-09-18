const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { Availability, MODELS, adapterFor, requestJson } = require('../availability');
const { MonitorAuth } = require('../monitor-auth');
const { ConfigStore } = require('../config-store');
const { accountId, merchantId } = require('../relay-identity');
const { readAigoStatus, channelSnapshot, ENDPOINT, POOLS, keyEndpoint, poolForName } = require('../availability-aigo');
const aigoKeys = require('../aigo-key-groups');
const { bindingModel } = require('../account-bindings');
const fixture = require('./aigo-fixture');
const NOW = Date.now();
const entries = [{ name: '派大星主号', baseurl: 'https://api.aigo0.com', value: fixture.KEYS[0] }, { name: '派大星备用', baseurl: 'https://api.aigo0.com', value: fixture.KEYS[1] }];

async function temp(t) { const home = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-aigo-')); t.after(() => fs.rm(home, { recursive: true, force: true })); return home; }

test('派大星 recognizes exact host and six requested pool prefixes', () => {
  assert.equal(adapterFor('https://api.aigo0.com/v1').id, 'aigo');
  assert.equal(merchantId('https://api.aigo0.com/v1'), 'aigo');
  assert.equal(adapterFor('https://api.aigo0.com.evil.example'), null);
  assert.deepEqual(POOLS, ['CX009-PLUS', 'CX008', 'CX00035', 'CX012', 'CX009-BUG', 'CX015']);
  for (const pool of POOLS) assert.equal(require('../availability-aigo').poolForName(pool + ' 混合渠道'), pool);
  assert.equal(require('../availability-aigo').poolForName('CX0035-福利特惠'), 'CX00035');
  assert.equal(require('../availability-aigo').poolForName('CX009'), null);
  assert.equal(poolForName('CX009-BUG PRO'), 'CX009-BUG');
  assert.equal(poolForName('CX0088-新分组'), null);
  const record = { id: 'c'.repeat(64), merchant: 'https://api.aigo0.com', members: entries.map(accountId), sourceId: accountId(entries[0]) };
  assert.equal(bindingModel(entries, { accountBindings: [record] }).describe(entries[0]).accountId, record.id);
  assert.equal(record.merchant, 'https://api.aigo0.com');
});

test('派大星 status parsing shares both models and preserves independent pool samples', () => {
  const status = readAigoStatus(fixture.status(NOW), MODELS, NOW);
  assert.deepEqual(status[MODELS[0]], status[MODELS[1]]);
  assert.deepEqual(status[MODELS[0]].channels.map(channel => channel.groupLabel), POOLS);
  const row = channelSnapshot(status[MODELS[0]], {}, NOW);
  assert.equal(row.channels.length, 6); assert.equal(row.channels[0].history.length, 60);
  assert.equal(row.channels[1].state, 'degraded'); assert.equal(row.channels[1].uptimePct, 88.5);
  assert.equal(row.channels[0].metrics.pingMs, 42);
  assert.equal(channelSnapshot(status[MODELS[0]], {}, NOW + 900001).channels[0].state, 'stale');
});

test('派大星 key lookup stores only hashes and maps pool prefixes', async () => {
  const result = await aigoKeys.readKeyGroups(async url => fixture.request(url, { token: fixture.TOKEN }), keyEndpoint(1), { signal: new AbortController().signal });
  assert.equal(result[aigoKeys.keyHash(fixture.KEYS[0])].pool, POOLS[0]);
  assert.equal(result[aigoKeys.keyHash(fixture.KEYS[1])].pool, POOLS[1]);
  assert.ok(!JSON.stringify(result).includes(fixture.KEYS[0]));
  for (const url of [ENDPOINT, keyEndpoint(1)]) assert.equal(url === ENDPOINT || aigoKeys.isKeyEndpoint(url), true);
  const options = { site: 'aigo', token: fixture.TOKEN, signal: new AbortController().signal, outbound: { resolve: async () => { throw new Error('network boundary'); } } };
  await assert.rejects(requestJson(ENDPOINT, options), /network boundary/);
  for (const url of [ENDPOINT + '/1/status', ENDPOINT + '?redirect=evil', keyEndpoint(1) + '&page=2', 'https://aigo0.com/api/v1/auth/me']) await assert.rejects(requestJson(url, options), /target rejected/);
});

test('派大星 all mode orders matching pool first and follow mode filters to one pool', async t => {
  const home = await temp(t), source = { ...entries[0], accountId: accountId(entries[0]), statusMode: 'all' }, backup = { ...entries[1], accountId: accountId(entries[1]), statusMode: 'api-key' };
  await new MonitorAuth(home, 'aigo', source.accountId).save(fixture.TOKEN);
  await new MonitorAuth(home, 'aigo', backup.accountId).save(fixture.TOKEN);
  const monitor = new Availability({}, { home, getEntries: async () => [source, backup], getEntry: async name => entries.find(entry => entry.name === name), request: fixture.request, clock: () => NOW });
  t.after(() => monitor.close());
  const rows = (await monitor.snapshot([source, backup])).rows;
  assert.equal(rows[0].channels.length, 6); assert.equal(rows[0].channels[0].groupLabel, POOLS[0]); assert.equal(rows[0].collapsibleChannels, true);
  assert.equal(rows[1].channels.length, 1); assert.equal(rows[1].channels[0].groupLabel, POOLS[1]);
  assert.equal(rows[0].balance.amount, 12.3456); assert.equal(rows[1].balance.amount, 12.3456);
});

test('派大星 status mode persists per child and UI supports collapse control', async t => {
  const source = await fs.readFile(path.join(__dirname, '../../managed-relay-public/availability.js'), 'utf8');
  const context = vm.createContext({ Intl, Date, localStorage: { getItem: () => null, setItem: () => {} }, escapeHtml: value => String(value).replace(/[&<>"']/g, c => '&#' + c.charCodeAt(0) + ';') });
  vm.runInContext(source + '\nthis.View = RelayAvailability;', context);
  const view = Object.create(context.View.prototype); view.model = MODELS[0]; view.error = ''; view.getState = () => ({ home: '/tmp' }); view.expandedChannels = new Set();
  const status = { ...readAigoStatus(fixture.status(NOW), MODELS, NOW)[MODELS[0]], ...channelSnapshot(readAigoStatus(fixture.status(NOW), MODELS, NOW)[MODELS[0]], {}, NOW), collapsibleChannels: true };
  const html = view.markup(status, '派大星主号');
  assert.equal((html.match(/<section class="availability-channel/g) || []).length, 2); assert.match(html, /展开全部号池/);
  view.expandedChannels.add(view.aigoExpansionKey('派大星主号'));
  assert.equal((view.markup(status, '派大星主号').match(/<section class="availability-channel/g) || []).length, 6);
  assert.equal((view.markup(status, '另一个子项').match(/<section class="availability-channel/g) || []).length, 2);
});

test('派大星 mode choice persists per child and rejects a stale revision', async t => {
  const home = await temp(t), key = { name: '派大星配置', baseurl: 'https://api.aigo0.com', value: fixture.KEYS[0] };
  await fs.writeFile(path.join(home, 'config.toml'), 'model_provider="relay"\n[model_providers.relay]\nbase_url="https://api.aigo0.com"\n');
  await fs.writeFile(path.join(home, 'key_config.json'), JSON.stringify({ keys: [key] }));
  const store = new ConfigStore(home, 'http://127.0.0.1:3211/v1'), before = await store.status(), entry = before.keys[0];
  await store.setAigoStatusMode({ name: entry.name, mode: 'api-key', previousMode: 'all', revision: entry.revision });
  assert.equal((await store.status()).keys[0].statusMode, 'api-key');
  await assert.rejects(store.setAigoStatusMode({ name: entry.name, mode: 'all', previousMode: 'all', revision: entry.revision }), /子项配置已变化/);
});

test('派大星 validates ambiguous pools, invalid rates and samples without accepting unrelated monitors', () => {
  for (const mutate of [p => p.data.items.push(p.data.items[0]), p => p.data.items[0].timeline.push(p.data.items[0].timeline[0]),
    p => { p.data.items[0].availability_7d = 101; }, p => { p.data.items[0].timeline[0].status = 'success'; },
    p => { p.data.items[0].timeline[0].checked_at = '2026-09-18'; }, p => { p.data.items[0].primary_latency_ms = -1; }]) {
    const p = fixture.status(NOW); mutate(p); assert.throws(() => readAigoStatus(p, MODELS, NOW));
  }
  const p = fixture.status(NOW); p.data.items[0].name = 'CX009-PLUSPLUS';
  assert.equal(readAigoStatus(p, MODELS, NOW)[MODELS[0]].channels[0].sampleCount, 0);
});

test('派大星 account cache stays isolated and refresh failure never retains an obsolete Key group', async t => {
  const home = await temp(t), shared = 'b'.repeat(64);
  const routes = entries.map(key => ({ ...key, accountId: shared, naturalAccountId: accountId(key), accountBindingId: shared, accountSourceName: entries[0].name, statusMode: 'all' }));
  routes.push({ name: 'unauthed', baseurl: entries[0].baseurl, accountId: 'd'.repeat(64), statusMode: 'all' });
  await new MonitorAuth(home, 'aigo', shared).save(fixture.TOKEN);
  let clock = NOW, group = 'CX009-BUG PRO', failKeys = false, failStatus = false;
  const calls = [];
  const monitor = new Availability({}, { home, getEntry: async name => entries.find(key => key.name === name), getEntries: async () => routes, clock: () => clock,
    request: async (url, options) => {
      calls.push(url);
      if (url === ENDPOINT && failStatus) throw Object.assign(new Error('Expired'), { status: 401 });
      const p = await fixture.request(url, options);
      if (url === keyEndpoint(1)) { if (failKeys) throw new Error('Lookup failed'); p.data.items[0].group.name = group; }
      return p;
    } });
  t.after(() => monitor.close());
  const [first, second] = await Promise.all([monitor.snapshot(routes), monitor.snapshot(routes, MODELS[1])]);
  assert.equal(first.rows[0].channels[0].groupLabel, 'CX009-BUG');
  assert.equal(first.rows[1].channels[0].groupLabel, 'CX008');
  assert.equal(first.rows[2].state, 'auth-required'); assert.equal(first.rows[2].balance.state, 'auth-required');
  assert.equal(first.rows[2].channels, undefined); assert.equal(calls.filter(url => url === ENDPOINT).length, 1);
  assert.deepEqual(first.rows[0].channels, second.rows[0].channels);
  clock += 15001; group = 'CX015-PRO'; routes[0].statusMode = 'api-key';
  let row = (await monitor.snapshot(routes)).rows[0];
  assert.equal(row.channels.length, 1); assert.equal(row.channels[0].groupLabel, 'CX015');
  clock += 15001; failKeys = true;
  row = (await monitor.snapshot(routes)).rows[0]; assert.equal(row.channels.length, 0); assert.match(row.message, /查询失败/);
  assert.equal(row.balance.state, 'available');
  routes[0].statusMode = 'all';
  row = (await monitor.snapshot(routes)).rows[0]; assert.equal(row.channels.length, 6); assert.equal(row.collapsibleChannels, true);
  assert.equal(row.keyGroup, undefined); assert.match(row.modelNote, /暂时无法确认/);
  clock += 15001; failKeys = false; group = '未监测的分组'; routes[0].statusMode = 'api-key';
  row = (await monitor.snapshot(routes)).rows[0]; assert.equal(row.channels.length, 0); assert.match(row.message, /监测范围/);
  routes[0].statusMode = 'all'; clock += 15001; failStatus = true;
  row = (await monitor.snapshot(routes)).rows[0]; assert.equal(row.state, 'auth-required');
  assert.ok(row.channels.every(channel => channel.state === 'auth-required' && channel.history.length === 60));
  const json = JSON.stringify(await monitor.snapshot(routes));
  assert.ok([...fixture.KEYS, fixture.TOKEN].every(secret => !json.includes(secret)));
});
