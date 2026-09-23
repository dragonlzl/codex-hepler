const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { defaults, validateSettings, health, evaluate, choose, WINDOW_MS, subscriptionRemaining } = require('../auto-switch-policy');
const { ConfigStore } = require('../config-store');
const { AutoSwitch } = require('../auto-switch');
const { start } = require('../../managed-relay-server');
const { readInputSubscriptions } = require('../account-input');
const { Availability } = require('../availability');
const { MonitorAuth } = require('../monitor-auth');

const epoch = Date.parse('2026-09-18T10:00:00Z');
const keys = [{ name: 'A', merchantId: 'input', baseurl: 'https://ai.input.im', value: 'sk-a' },
  { name: 'B', merchantId: 'aixor', baseurl: 'https://aixor.cc', value: 'sk-b' },
  { name: 'C', merchantId: 'rightcode', baseurl: 'https://www.rightapi.ai', value: 'sk-c' },
  { name: 'A 订阅', merchantId: 'input', baseurl: 'https://ai.input.im/v1', value: 'sk-sub' }];
const settings = () => ({ ...defaults(), enabled: true, pool: keys.slice(0, 3).map((key, index) => ({ name: key.name, priority: index + 1, source: 'balance' })) });
const point = (at, state = 'available') => ({ at, state, ok: state === 'available' });
const row = (name, now = epoch, state = 'available', amount = 10) => ({ name, state, fetchedAt: now,
  sampleIntervalMs: 60000, last: point(now, state), history: [point(now - 60000, state), point(now, state)],
  balance: { state: 'available', amount, currency: 'USD', fetchedAt: now } });
const plan = (remaining = 5) => ({ id: 42, state: 'active', currency: 'USD', expiresAt: epoch + 86400000,
  quotas: [{ period: 'daily', remaining, limit: 20 }, { period: 'weekly', remaining: 100, limit: 200 }] });

test('green beats priority; invalid funding is removed before yellow fallback; priorities preempt', () => {
  const config = settings(), rows = [row('A', epoch, 'degraded'), row('B'), row('C')];
  assert.equal(choose(evaluate(config, keys, rows, epoch), 'A').name, 'B');
  rows[1].balance.amount = 0; rows[2].balance.state = 'auth-required';
  assert.equal(choose(evaluate(config, keys, rows, epoch), 'C').name, 'A');
  rows[0] = row('A'); rows[1] = row('B');
  assert.equal(choose(evaluate(config, keys, rows, epoch), 'B').name, 'A');
});

test('subscription wins within merchant; exact M/N boundaries pass, zero never passes', () => {
  const config = settings(); config.pool.push({ name: 'A 订阅', priority: 1, source: 'subscription', subscriptionId: 42 });
  const subscription = row('A 订阅', epoch, 'available', 0);
  subscription.subscriptions = { state: 'available', fetchedAt: epoch, items: [plan(1)] };
  const rows = [row('A', epoch, 'available', 1), subscription, row('B')];
  assert.equal(choose(evaluate(config, keys, rows, epoch), 'A').name, 'A 订阅');
  subscription.subscriptions.items = [plan(0.999)];
  assert.equal(choose(evaluate(config, keys, rows, epoch), 'A 订阅').name, 'A');
  rows[0].balance.amount = 0.999;
  assert.equal(choose(evaluate(config, keys, rows, epoch), 'A').name, 'B');
  config.balanceMinimum = 0; rows[0].balance.amount = 0;
  assert.equal(evaluate(config, keys, rows, epoch)[0].eligible, false);
  config.subscriptionMinimum = 0; subscription.subscriptions.items = [plan(0)];
  assert.equal(evaluate(config, keys, rows, epoch).at(-1).eligible, false);
});

test('balance routes need fresh balance while subscription routes survive transient balance failures', () => {
  const balanceConfig = settings();
  const balance = row('A');
  for (const state of ['auth-required', 'error', 'stale', 'loading']) {
    balance.balance.state = state;
    assert.equal(evaluate(balanceConfig, keys, [balance], epoch)[0].eligible, false);
  }
  const config = settings(); config.pool = [{ name: 'A 订阅', priority: 1, source: 'subscription', subscriptionId: 42 }];
  const subscription = row('A 订阅'); subscription.subscriptions = { state: 'available', fetchedAt: epoch, items: [plan()] };
  for (const state of ['auth-required', 'error', 'stale', 'loading']) {
    subscription.balance.state = state;
    assert.equal(evaluate(config, keys, [subscription], epoch)[0].eligible, true);
  }
  const keyBalance = row('A'); keyBalance.balance = { ...keyBalance.balance, kind: 'packy-key', refreshMs: 1800000 };
  assert.equal(evaluate(settings(), keys, [keyBalance], epoch)[0].eligible, true);
});

test('3-minute window includes all observations, duplicate polling cannot erase failure; slow sources use one sample', () => {
  assert.equal(WINDOW_MS, 180000);
  const data = row('A'); data.history.unshift(point(epoch - 170000, 'unavailable'));
  assert.equal(health(data, epoch).rank, null);
  assert.equal(health(data, epoch + 1000).rank, null);
  assert.equal(health(data, epoch + 10000).rank, null);
  assert.equal(health(data, epoch + 10001).rank, 0);
  data.history = [point(epoch - 120000, 'degraded'), point(epoch)];
  assert.equal(health(data, epoch).rank, 1);
  data.sampleIntervalMs = 300000; data.staleAfterMs = 900000;
  data.history = [point(epoch - 300000, 'unavailable'), point(epoch)];
  assert.equal(health(data, epoch).rank, 0);
  data.sampleIntervalMs = 3600000; data.staleAfterMs = 3780000;
  data.history = [point(epoch - 3600000, 'unavailable'), point(epoch)];
  assert.equal(health(data, epoch).rank, 0);
  assert.equal(health(data, epoch + 3780001).rank, null);
  data.last.at = null;
  assert.equal(health(data, epoch).rank, null); // Fixed status is not a timestamped observation.
});

test('actual subscription limits exclude history, expiry, reset windows and incompatible units', () => {
  const item = plan(); item.quotas.push({ period: 'recent7d', remaining: 0 });
  assert.equal(subscriptionRemaining(item, 'krill', epoch), 5);
  item.quotas[0].unit = 'requests';
  assert.equal(subscriptionRemaining(item, 'krill', epoch), null);
  delete item.quotas[0].unit; item.quotas[0].resetsAt = epoch;
  assert.equal(subscriptionRemaining(item, 'krill', epoch), null);
  assert.equal(subscriptionRemaining({ ...plan(), state: 'frozen' }, 'krill', epoch), null);
  assert.equal(subscriptionRemaining({ ...plan(), expiresAt: epoch }, 'input', epoch), null);
  assert.equal(subscriptionRemaining({ ...plan(), quotas: [] }, 'krill', epoch), null);
  assert.equal(subscriptionRemaining({ ...plan(), quotas: [] }, 'input', epoch), null);
  assert.equal(subscriptionRemaining({ ...plan(), quotas: [], unlimited: true }, 'input', epoch), Infinity);
  const carry = { ...plan(), quotas: [{ period: 'weekly', remaining: 0 }, { period: 'carryover', remaining: 4 }, { period: 'total', remaining: 100 }] };
  assert.equal(subscriptionRemaining(carry, 'krill', epoch), 4);
});

test('missing subscription limits never masquerade as unlimited quota', () => {
  const data = { id: 1, status: 'active', group: { name: 'fixture' } };
  const read = () => readInputSubscriptions({ code: 0, data: [data] }, epoch).items[0];
  assert.equal(subscriptionRemaining(read(), 'input', epoch), null);
  data.group.daily_limit_usd = 0;
  assert.equal(subscriptionRemaining(read(), 'input', epoch), Infinity);
  data.group.weekly_limit_usd = null;
  assert.equal(subscriptionRemaining(read(), 'input', epoch), null);
});

test('slow aggregated grid and current status must both be usable', () => {
  const data = row('A'); data.sampleIntervalMs = 1200000;
  data.history = [point(epoch - 1200000, 'unavailable')];
  assert.equal(health(data, epoch).rank, null);
  data.history[0].state = 'degraded'; assert.equal(health(data, epoch).rank, 1);
});

test('settings reject duplicate/missing routes, mismatched merchant priorities, invalid thresholds and empty enabled pool', () => {
  const config = settings(); assert.deepEqual(validateSettings(config, keys), config);
  for (const change of [c => { c.balanceMinimum = -1; }, c => { c.subscriptionMinimum = NaN; },
    c => { c.pool = []; }, c => { c.pool.push(c.pool[0]); }, c => { c.pool[0].name = 'missing'; },
    c => { c.pool[0].priority = 0; }, c => { c.pool[0].source = 'auto'; },
    c => { c.pool.push({ name: 'A 订阅', priority: 2, source: 'subscription', subscriptionId: 42 }); }]) {
    const value = settings(); change(value); assert.throws(() => validateSettings(value, keys));
  }
});

async function fixture(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-auto-test-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  await fs.writeFile(path.join(home, 'config.toml'), 'model_provider="custom"\n[model_providers.custom]\nbase_url="https://ai.input.im"\n');
  await fs.writeFile(path.join(home, 'auth.json'), '{"OPENAI_API_KEY":"sk-a"}');
  await fs.writeFile(path.join(home, 'key_config.json'), JSON.stringify({ keys }));
  const store = new ConfigStore(home, 'http://127.0.0.1:3211/v1');
  await store.install('A');
  let now = epoch, rows = null, request = null, calls = 0;
  const monitor = { authorizationVersion: 0, snapshot: async (...args) => { calls++; return request ? request(...args) : { rows: rows || keys.map(key => row(key.name, now)) }; } };
  const events = [];
  const auto = new AutoSwitch(store, monitor, { clock: () => now, record: event => events.push(event) });
  t.after(() => auto.close());
  const save = async config => { auto.invalidate(); await store.saveAutoSwitch({ revision: (await store.status()).autoSwitchRevision, settings: config }); };
  await save(settings());
  return { home, store, auto, monitor, events, save, setNow: value => { now = value; }, setRows: value => { rows = value; },
    setRequest: value => { request = value; }, calls: () => calls };
}

test('current red switches immediately, all failed keeps last route and recovery preempts', async t => {
  const f = await fixture(t);
  f.setRows([row('A', epoch, 'unavailable'), row('B'), row('C')]);
  await f.auto.tick(); assert.equal((await f.store.activeEntry()).name, 'B'); assert.equal(f.events.length, 1);
  assert.equal(f.auto.snapshot().waitUntil, null);
  assert.equal(f.events[0].at, new Date(epoch).toISOString());
  assert.match(f.events[0].switchReason, /当前渠道不可用，立即切换/);
  f.setNow(epoch + 1); f.setRows(keys.map(key => row(key.name, epoch + 1, 'unavailable')));
  await f.auto.tick(); assert.equal(f.auto.snapshot().phase, 'no-candidate'); assert.equal((await f.store.activeEntry()).name, 'B');
  f.setRows([row('A', epoch + 1), row('B', epoch + 1, 'unavailable')]);
  await f.auto.tick(); assert.equal((await f.store.activeEntry()).name, 'A');
});

test('unavailable INPUT immediately selects a healthy Krill subscription from the screenshot scenario', async t => {
  const f = await fixture(t);
  for (const name of ['Krill 周卡', 'Krill 月卡']) await f.store.add({
    name, value: 'sk-fixture-' + (name.includes('周') ? 'weekly' : 'monthly'),
    baseurl: 'https://api-slb.krill-code.net/codex/v1',
  });
  const config = settings();
  config.pool = [{ name: 'A', priority: 2, source: 'balance' },
    ...['Krill 周卡', 'Krill 月卡'].map(name => ({ name, priority: 1, source: 'subscription', subscriptionId: 42 }))];
  await f.save(config);
  const subscriptions = config.pool.slice(1).map(({ name }) => ({ ...row(name),
    subscriptions: { state: 'available', fetchedAt: epoch, items: [plan(10)] } }));
  f.setRows([row('A', epoch, 'unavailable'), ...subscriptions]);
  await f.auto.tick();
  const runtime = f.auto.snapshot();
  assert.ok(subscriptions.some(item => item.name === runtime.lastSwitch.to));
  assert.equal(runtime.lastSwitch.from, 'A');
  assert.equal(runtime.lastSwitch.at, epoch);
  assert.equal(runtime.lastSwitch.source, 'subscription');
  assert.equal(runtime.phase, 'active');
  assert.equal(runtime.waitUntil, null);
  assert.equal((await f.store.activeEntry()).name, runtime.lastSwitch.to);
});

test('unknown status retains the incumbent without qualifying it as a new candidate', async t => {
  for (const patch of [{ state: 'no-data' }, { state: 'stale' }, { state: 'error' }, { state: 'auth-required' },
    { last: point(epoch - WINDOW_MS - 1) }, { last: point(epoch, 'no-data') }, { requiresLogin: true },
    { referenceOnly: true }, { channels: [] }, { channels: [{ state: 'auth-required' }] }]) {
    const f = await fixture(t);
    f.setRows([{ ...row('A'), ...patch }, row('B')]);
    await f.auto.tick();
    assert.equal((await f.store.activeEntry()).name, 'A');
    assert.equal(f.auto.snapshot().waitUntil, null);
    assert.equal(f.auto.snapshot().phase, 'unconfirmed');
    assert.equal(f.auto.snapshot().lastSwitch, null);
    assert.equal(f.auto.snapshot().candidates[0].eligible, false);
    assert.equal(f.auto.snapshot().candidates[0].currentHealth, 'unknown');
    assert.equal(f.events.length, 0);
  }
});

test('status refresh failures retain the incumbent even after three minutes and recovery resumes ranking', async t => {
  const fixtureState = await fixture(t);
  const failedRows = now => {
    const failed = row('A', now);
    failed.state = 'stale';
    failed.failure = { code: 'REFRESH_TIMEOUT', message: '查询超时（10 秒）' };
    return [failed, row('B', now)];
  };
  fixtureState.setRows(failedRows(epoch)); await fixtureState.auto.tick();
  assert.equal(fixtureState.auto.snapshot().phase, 'unconfirmed');
  assert.equal(fixtureState.auto.snapshot().waitUntil, null);
  assert.match(fixtureState.auto.snapshot().candidates[0].reason, /状态查询失败.*查询超时/);
  assert.equal((await fixtureState.store.activeEntry()).name, 'A');
  fixtureState.setNow(epoch + WINDOW_MS + 1);
  fixtureState.setRows(failedRows(epoch + WINDOW_MS + 1)); await fixtureState.auto.tick();
  assert.equal((await fixtureState.store.activeEntry()).name, 'A');
  assert.equal(fixtureState.events.length, 0);
  fixtureState.setRows([row('A', epoch + WINDOW_MS + 1, 'degraded'), row('B', epoch + WINDOW_MS + 1)]);
  await fixtureState.auto.tick();
  assert.equal((await fixtureState.store.activeEntry()).name, 'B');
  assert.match(fixtureState.events[0].switchReason, /绿色候选优先/);
});

test('subscription entry remains eligible when its balance refresh fails', async t => {
  const f = await fixture(t); const config = settings();
  config.pool = [{ name: 'A 订阅', priority: 1, source: 'subscription', subscriptionId: 42 }, { name: 'B', priority: 2, source: 'balance' }];
  await f.save(config);
  const subscription = row('A 订阅', epoch, 'available', 10);
  subscription.balance = { state: 'stale', amount: 10, currency: 'USD', fetchedAt: epoch - 60000,
    failure: { code: 'REFRESH_TIMEOUT', message: '查询超时' } };
  subscription.subscriptions = { state: 'available', fetchedAt: epoch, items: [plan(10)] };
  f.setRows([row('A'), row('B'), subscription]);
  await f.auto.tick();
  assert.equal((await f.store.activeEntry()).name, 'A 订阅');
  assert.equal(f.auto.snapshot().candidates.find(item => item.name === 'A 订阅').eligible, true);
});

test('a later outage switches immediately after recovery', async t => {
  const f = await fixture(t);
  f.setRows([row('A', epoch, 'unavailable'), row('B')]); await f.auto.tick();
  assert.equal((await f.store.activeEntry()).name, 'B');
  f.setNow(epoch + 60000); f.setRows([row('A', epoch + 60000), row('B', epoch + 60000)]); await f.auto.tick();
  assert.equal(f.auto.snapshot().phase, 'active');
  f.setNow(epoch + 120000); f.setRows([row('A', epoch + 120000, 'unavailable'), row('B', epoch + 120000)]); await f.auto.tick();
  assert.equal((await f.store.activeEntry()).name, 'B');
  assert.equal(f.auto.snapshot().waitUntil, null);
});

test('recent red history blocks re-entry after failover; shutdown cancels in-flight selection', async t => {
  const f = await fixture(t);
  f.setRows([row('A', epoch, 'unavailable'), row('B')]); await f.auto.tick();
  assert.equal((await f.store.activeEntry()).name, 'B');
  f.setNow(epoch + 60000);
  const recovered = row('A', epoch + 60000); recovered.history = [point(epoch, 'unavailable'), point(epoch + 60000)];
  f.setRows([recovered, row('B', epoch + 60000)]); await f.auto.tick();
  assert.equal((await f.store.activeEntry()).name, 'B'); assert.equal(f.auto.snapshot().waitUntil, null);
  let entered, release; const started = new Promise(resolve => { entered = resolve; });
  f.setRequest(() => { entered(); return new Promise(resolve => { release = resolve; }); });
  const pending = f.auto.tick(); await started; f.auto.stop();
  release({ rows: [row('A', epoch + 60000), row('B', epoch + 60000, 'available', 0)] });
  await pending; assert.equal((await f.store.activeEntry()).name, 'B');
});

test('without an alternative, a recovered incumbent stays active despite its earlier red sample', async t => {
  const f = await fixture(t);
  f.setRows([row('A', epoch, 'unavailable'), row('B', epoch, 'unavailable')]);
  await f.auto.tick();
  assert.equal(f.auto.snapshot().phase, 'no-candidate');
  const recovered = row('A', epoch + 60000);
  recovered.history = [point(epoch, 'unavailable'), point(epoch + 60000)];
  f.setNow(epoch + 60000); f.setRows([recovered, row('B', epoch + 60000)]);
  await f.auto.tick();
  assert.equal((await f.store.activeEntry()).name, 'A');
  assert.equal(f.auto.snapshot().phase, 'active');
});

test('subscription reset restores merchant subscription ahead of its balance entry', async t => {
  const f = await fixture(t); const config = settings();
  config.pool.push({ name: 'A 订阅', priority: 1, source: 'subscription', subscriptionId: 42 }); await f.save(config);
  const sub = row('A 订阅'); sub.subscriptions = { state: 'available', fetchedAt: epoch, items: [plan(0.5)] };
  f.setRows([row('A'), row('B'), sub]); await f.auto.tick(); assert.equal((await f.store.activeEntry()).name, 'A');
  sub.subscriptions.items = [plan(10)]; await f.auto.tick(); assert.equal((await f.store.activeEntry()).name, 'A 订阅');
});

test('website login or funding queries failing do not evict either type of current route', async t => {
  for (const source of ['balance', 'subscription']) for (const resourceState of ['auth-required', 'error', 'stale', 'loading', 'expired-data', 'missing']) {
    const f = await fixture(t), config = settings();
    config.pool[0] = { ...config.pool[0], source, ...(source === 'subscription' ? { subscriptionId: 42 } : {}) };
    await f.save(config);
    const a = row('A');
    a.subscriptions = { state: 'available', fetchedAt: epoch, items: [plan()] };
    const resource = source === 'balance' ? 'balance' : 'subscriptions';
    if (resourceState === 'missing') delete a[resource];
    else if (resourceState === 'expired-data') a[resource].fetchedAt = epoch - 90000;
    else a[resource].state = resourceState;
    f.setRows([a, row('B')]); await f.auto.tick();
    assert.equal((await f.store.activeEntry()).name, 'A', source + ': ' + resourceState);
    assert.equal(f.auto.snapshot().phase, 'unconfirmed');
    assert.equal(f.auto.snapshot().candidates[0].fundingState, 'unknown');
    assert.equal(f.auto.snapshot().candidates[0].eligible, false);
    assert.equal(f.events.length, 0);
    // A fresh red sample remains sufficient evidence even when funding cannot be queried.
    a.last = point(epoch, 'unavailable'); a.state = 'unavailable';
    await f.auto.tick();
    assert.equal((await f.store.activeEntry()).name, 'B');
  }
});

test('actual API-key authentication and transport failures still switch when website login is expired', async t => {
  for (const failure of [{ upstreamStatus: 401 }, { upstreamStatus: 403 }, { upstreamStatus: 429 }, { upstreamStatus: 503 }, { phase: 'connect', errorCode: 'ECONNRESET' }]) {
    const f = await fixture(t);
    const a = row('A'); a.balance.state = 'auth-required'; a.state = 'auth-required';
    f.setRows([a, row('B')]); await f.auto.tick();
    assert.equal((await f.store.activeEntry()).name, 'A');
    const key = (await f.store.status()).keys.find(key => key.name === 'A');
    f.auto.observe({ provider: 'A', routeId: key.naturalAccountId,
      startedAt: new Date(epoch).toISOString(), at: new Date(epoch).toISOString(),
      outcome: 'failed', status: 502, phase: 'response', ...failure });
    await f.auto.tick();
    assert.equal((await f.store.activeEntry()).name, 'B');
    assert.equal(f.events.length, 1);
    assert.equal(f.auto.snapshot().waitUntil, null);
  }
});

test('confirmed insufficient funding or invalid subscription still switches while monitoring is unknown', async t => {
  for (const funding of [{ source: 'balance', amount: 0 }, { source: 'balance', amount: 0.5 },
    { source: 'subscription', plan: plan(0) }, { source: 'subscription', plan: { ...plan(), expiresAt: epoch } },
    { source: 'subscription', plan: { ...plan(), state: 'frozen' } }, { source: 'subscription', plan: null }]) {
    const f = await fixture(t), config = settings();
    config.pool[0] = { ...config.pool[0], source: funding.source, ...(funding.source === 'subscription' ? { subscriptionId: 42 } : {}) };
    await f.save(config);
    const a = row('A', epoch, 'error', funding.amount ?? 10);
    a.subscriptions = { state: 'available', fetchedAt: epoch, items: funding.plan ? [funding.plan] : [] };
    f.setRows([a, row('B')]); await f.auto.tick();
    assert.equal((await f.store.activeEntry()).name, 'B');
    assert.equal(f.auto.snapshot().candidates[0].fundingState, 'unavailable');
  }
});

test('turning off while a monitor request is in flight prevents late route writes and further queries', async t => {
  const f = await fixture(t); let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  f.setRequest(() => { entered(); return new Promise(resolve => { release = resolve; }); });
  const pending = f.auto.tick(); await started;
  f.auto.invalidate(); await f.store.toggleAutoSwitch(false);
  release({ rows: [row('A', epoch, 'available', 0), row('B')] }); await pending;
  assert.equal((await f.store.activeEntry()).name, 'A');
  const count = f.calls(); await f.auto.tick(); assert.equal(f.calls(), count);
  assert.equal(f.auto.snapshot().phase, 'disabled');
});

test('manual routing, concurrent edits, and authorization changes invalidate pending decisions', async t => {
  for (const change of ['manual', 'edit', 'auth']) {
    const f = await fixture(t); let release, entered;
    const started = new Promise(resolve => { entered = resolve; });
    f.setRequest(() => { entered(); return new Promise(resolve => { release = resolve; }); });
    const pending = f.auto.tick(); await started;
    if (change === 'manual') await f.store.select('C', 'proxy');
    if (change === 'edit') { const item = (await f.store.status()).keys.find(key => key.name === 'B'); await f.store.edit('B', { ...item, value: 'sk-new-b' }); }
    if (change === 'auth') f.monitor.authorizationVersion++;
    release({ rows: [row('A', epoch, 'available', 0), row('B'), row('C')] }); await pending;
    assert.equal((await f.store.activeEntry()).name, change === 'manual' ? 'C' : 'A');
    if (change === 'manual') assert.equal((await f.store.status()).autoSwitchSettings.enabled, false);
    if (change === 'edit') assert.ok(!(await f.store.status()).autoSwitchSettings.pool.some(item => item.name === 'B'));
  }
});

test('actual request failure is not cleared by unchanged green history, cancellation and local proxy failures are ignored', async t => {
  const f = await fixture(t); await f.auto.tick();
  const key = (await f.store.status()).keys.find(key => key.name === 'A');
  const event = { provider: 'A', routeId: key.naturalAccountId, startedAt: new Date(epoch).toISOString(), at: new Date(epoch).toISOString(), outcome: 'failed', phase: 'connect', status: 502 };
  f.auto.observe({ ...event, status: 499, outcome: 'cancelled' }); await f.auto.tick(); assert.equal(f.auto.snapshot().phase, 'active');
  f.auto.observe({ ...event, phase: 'proxy-selection' }); await f.auto.tick(); assert.equal(f.auto.snapshot().phase, 'active');
  f.auto.observe(event); await f.auto.tick(); assert.equal((await f.store.activeEntry()).name, 'B');
  f.setNow(epoch + 1000);
  const unchanged = row('A', epoch + 1000);
  unchanged.last = point(epoch); unchanged.history = [point(epoch)]; unchanged.staleAfterMs = 900000;
  f.setRows([unchanged, row('B', epoch + 1000)]);
  await f.auto.tick(); assert.equal((await f.store.activeEntry()).name, 'B');
  await f.auto.tick(); assert.equal((await f.store.activeEntry()).name, 'B');
  f.setNow(epoch + WINDOW_MS + 1); f.setRows(null);
  await f.auto.tick(); assert.equal((await f.store.activeEntry()).name, 'A');
});

test('new healthy samples after the recovery window re-enable the failed route', async t => {
  const f = await fixture(t); await f.auto.tick();
  const key = (await f.store.status()).keys.find(key => key.name === 'A');
  f.auto.observe({ provider: 'A', routeId: key.naturalAccountId, startedAt: new Date(epoch).toISOString(),
    at: new Date(epoch).toISOString(), outcome: 'failed', phase: 'connect', status: 502 });
  await f.auto.tick();
  assert.equal((await f.store.activeEntry()).name, 'B');
  f.setNow(epoch + WINDOW_MS - 1); await f.auto.tick();
  assert.equal((await f.store.activeEntry()).name, 'B');
  f.setNow(epoch + WINDOW_MS); await f.auto.tick();
  assert.equal(f.auto.snapshot().waitUntil, null);
  assert.equal((await f.store.activeEntry()).name, 'A');
});

test('rename preserves pool settings, key changes remove stale funding association, settings survive reopening', async t => {
  const f = await fixture(t); let key = (await f.store.status()).keys.find(key => key.name === 'A');
  await f.store.edit('A', { ...key, name: 'renamed' });
  const reopened = new ConfigStore(f.home, f.store.proxyUrl);
  assert.equal((await reopened.status()).autoSwitchSettings.pool[0].name, 'renamed');
  key = (await reopened.status()).keys.find(key => key.name === 'renamed');
  await reopened.edit('renamed', { ...key, value: 'sk-new' });
  assert.ok(!(await reopened.status()).autoSwitchSettings.pool.some(item => item.name === 'renamed'));
  await reopened.restore(); assert.equal((await reopened.status()).autoSwitchSettings.enabled, false);
});

test('failed settings writes roll back and stale settings cannot overwrite another window', async t => {
  const f = await fixture(t); const state = await f.store.status(), before = await fs.readFile(f.store.statePath, 'utf8');
  const failing = new ConfigStore(f.home, f.store.proxyUrl, async () => { throw new Error('fixture write failure'); });
  await assert.rejects(failing.toggleAutoSwitch(false), /回滚/);
  assert.equal(await fs.readFile(f.store.statePath, 'utf8'), before);
  await f.store.toggleAutoSwitch(false);
  await assert.rejects(f.store.saveAutoSwitch({ revision: state.autoSwitchRevision, settings: settings() }), /已变化/);
});

test('API exposes switch config; disabled startup does not run account probes and enabled timer works without a browser', async t => {
  const f = await fixture(t); await f.store.toggleAutoSwitch(false);
  let calls = 0;
  const app = await start({ home: f.home, uiPort: 0, proxyPort: 0, log: () => {}, autoSwitchOptions: { intervalMs: 10 },
    availabilityOptions: { request: async () => { calls++; throw new Error('fixture has no login'); } },
    launcher: { snapshot: async () => ({}) } });
  t.after(() => app.close());
  await app.autoSwitch.tick(); assert.equal(calls, 0);
  const post = async (endpoint, body) => { const res = await fetch(app.uiUrl + endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: res.status, body: await res.json() }; };
  const initial = await app.status();
  assert.equal((await post('/api/auto-switch/toggle', { enabled: true, revision: initial.autoSwitchRevision })).status, 409);
  await post('/api/proxy/install', { name: 'A' });
  const state = await app.status();
  assert.equal((await post('/api/auto-switch/toggle', { enabled: true, revision: state.autoSwitchRevision })).status, 200);
  await app.autoSwitch.tick(); assert.ok(calls > 0);
  const stopped = await post('/api/auto-switch/toggle', { enabled: false });
  assert.equal(stopped.body.status.autoSwitchSettings.enabled, false);
  const total = calls; await app.autoSwitch.tick(); assert.equal(calls, total);
});

test('automatic monitoring follows the actual key pool without changing the all-pools display setting', async t => {
  const f = await fixture(t), timi = require('./timicc-fixture');
  await f.store.add({ name: 'timi', baseurl: 'https://timicc.com', value: 'sk-not-login' });
  const key = (await f.store.status()).keys.find(key => key.name === 'timi');
  await new MonitorAuth(f.home, 'timicc', key.accountId).save(timi.TOKEN);
  const monitor = new Availability({}, { home: f.home, request: timi.request, getEntry: name => f.store.entry(name), getEntries: async () => (await f.store.status()).keys });
  t.after(() => monitor.close());
  const display = (await monitor.snapshot([key])).rows[0];
  assert.equal(display.channels.length, 2);
  const automatic = (await monitor.snapshot([key], 'gpt-6-astra', { automatic: true })).rows[0];
  assert.equal(automatic.channels.length, 1);
  assert.match(automatic.channels[0].sourceModelLabel, /gpt-5.6-sol/);
  assert.equal(health(automatic, Date.now()).rank, 0);
  assert.equal((await f.store.status()).keys.find(key => key.name === 'timi').statusMode, 'all');
  const reference = row('A'); reference.referenceOnly = true;
  assert.equal(health(reference, epoch).rank, null);
});
