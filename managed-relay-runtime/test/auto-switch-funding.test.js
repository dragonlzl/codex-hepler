const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { ConfigStore } = require('../config-store');
const { AutoSwitch } = require('../auto-switch');
const { AutoSwitchFunding } = require('../auto-switch-funding');
const { defaults } = require('../auto-switch-policy');

const NOW = Date.parse('2026-09-23T08:00:00Z');
const resource = source => source === 'subscription' ? 'subscriptions' : 'balance';
function row(name, now, source = 'balance', amount = 10) {
  const sample = { at: now, state: 'available', ok: true };
  return { name, state: 'available', last: sample, history: [sample],
    balance: { state: 'available', amount, currency: 'USD', fetchedAt: now },
    ...(source === 'subscription' ? { subscriptions: { state: 'available', fetchedAt: now, items: [{
      id: 42, state: 'active', currency: 'USD', expiresAt: NOW + 86400000,
      quotas: [{ period: 'daily', remaining: amount }, { period: 'weekly', remaining: 100 }],
    }] } } : {}) };
}

async function fixture(t, source = 'balance') {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-funding-test-'));
  let auto;
  t.after(async () => { await auto?.close(); await fs.rm(home, { recursive: true, force: true }); });
  const entries = ['A', 'B'].map(name => ({ name, value: 'sk-private-' + name,
    baseurl: name === 'A' ? 'https://ai.input.im/v1' : 'https://aixor.cc/v1' }));
  await fs.writeFile(path.join(home, 'config.toml'), 'model_provider="custom"\n[model_providers.custom]\nbase_url="https://ai.input.im/v1"\n');
  await fs.writeFile(path.join(home, 'auth.json'), '{"OPENAI_API_KEY":"sk-private-A"}');
  await fs.writeFile(path.join(home, 'key_config.json'), JSON.stringify({ keys: entries }));
  const store = new ConfigStore(home, 'http://127.0.0.1:3211/v1');
  await store.install('A');
  const config = { ...defaults(), enabled: true, balanceMinimum: 5, subscriptionMinimum: 5,
    pool: [{ name: 'A', priority: 1, source, ...(source === 'subscription' ? { subscriptionId: 42 } : {}) },
      { name: 'B', priority: 2, source: 'balance' }] };
  let now = NOW, rows = [];
  const monitor = { authorizationVersion: 0, snapshot: async () => ({ rows }) };
  const create = () => new AutoSwitch(store, monitor, { clock: () => now });
  auto = create();
  const save = async () => {
    auto.invalidate();
    await store.saveAutoSwitch({ revision: (await store.status()).autoSwitchRevision, settings: config });
  };
  await save();
  return { home, store, monitor, config, save, get auto() { return auto; },
    async restart() { await auto.close(); auto = create(); },
    async tick(nextRows, time = now) { now = time; rows = nextRows; await auto.tick(); return auto.snapshot(); },
  };
}

for (const source of ['balance', 'subscription']) {
  test(source + ': confirmed insufficient funding survives each query failure and switches when backup recovers', async t => {
    for (const failure of ['stale', 'auth-required', 'error', 'missing', 'expired', 'missing-row']) {
      const f = await fixture(t, source);
      let state = await f.tick([row('A', NOW, source, 3), row('B', NOW, 'balance', 0)]);
      assert.equal(state.phase, 'no-candidate');
      assert.equal((await f.store.activeEntry()).name, 'A');
      const a = row('A', NOW + 90000, source, 99);
      if (failure === 'missing') delete a[resource(source)];
      else if (failure === 'expired') a[resource(source)].fetchedAt = NOW;
      else a[resource(source)].state = failure;
      state = await f.tick([...(failure === 'missing-row' ? [] : [a]), row('B', NOW + 90000)], NOW + 90000);
      assert.equal((await f.store.activeEntry()).name, 'B', failure);
      const candidate = state.candidates.find(item => item.name === 'A');
      assert.equal(candidate.fundingState, 'unavailable');
      assert.equal(candidate.eligible, false);
      assert.equal(candidate.fundingRetained, true);
      assert.equal(candidate.remaining, 3);
      assert.equal(candidate.fundingConfirmedAt, NOW);
      assert.match(candidate.reason, /上次确认额度不足.*等待重新查询/);
    }
  });

  test(source + ': only a newer successful funding query at the threshold releases exclusion', async t => {
    const f = await fixture(t, source);
    await f.tick([row('A', NOW, source, 3), row('B', NOW)]);
    for (const fetchedAt of [NOW - 1, NOW]) {
      const a = row('A', NOW + 1, source, 5); a[resource(source)].fetchedAt = fetchedAt;
      const state = await f.tick([a, row('B', NOW + 1)], NOW + 1);
      assert.equal((await f.store.activeEntry()).name, 'B');
      assert.equal(state.candidates[0].fundingRetained, true);
    }
    const a = row('A', NOW + 2, source, 5); a[resource(source)].state = 'auth-required';
    await f.tick([a, row('B', NOW + 2)], NOW + 2);
    assert.equal((await f.store.activeEntry()).name, 'B');
    const state = await f.tick([row('A', NOW + 3, source, 5), row('B', NOW + 3)], NOW + 3);
    assert.equal((await f.store.activeEntry()).name, 'A');
    assert.equal(state.candidates[0].fundingState, 'available');
    assert.equal(state.candidates[0].fundingRetained, undefined);
    await f.restart();
    a[resource(source)].fetchedAt = NOW + 3;
    const failedAgain = await f.tick([a, row('B', NOW + 4)], NOW + 4);
    assert.equal((await f.store.activeEntry()).name, 'A');
    assert.equal(failedAgain.phase, 'unconfirmed', 'old exclusion must not reappear after recovery');
  });

  test(source + ': relogin, toggling, manual selection and restart do not erase negative funding evidence', async t => {
    const f = await fixture(t, source);
    await f.tick([row('A', NOW, source, 3), row('B', NOW)]);
    const disk = await fs.readFile(f.auto.funding.file, 'utf8');
    assert.ok(!disk.includes('sk-private-'));
    assert.equal((await fs.stat(f.auto.funding.file)).mode & 0o777, 0o600);
    await f.store.select('A', 'proxy'); // Explicitly selects A and disables auto switching.
    await f.auto.tick();
    assert.equal((await f.store.activeEntry()).name, 'A');
    f.monitor.authorizationVersion++;
    f.config.enabled = true; await f.save(); await f.restart();
    const a = row('A', NOW + 1, source, 100); a[resource(source)].state = 'error';
    const state = await f.tick([a, row('B', NOW + 1)], NOW + 1);
    assert.equal((await f.store.activeEntry()).name, 'B');
    assert.equal(state.candidates[0].fundingRetained, true);
  });

  test(source + ': formerly adequate or never known funding remains unknown when queries fail', async t => {
    const f = await fixture(t, source);
    await f.tick([row('A', NOW, source, 8), row('B', NOW)]);
    const a = row('A', NOW + 1, source, 8); a[resource(source)].state = 'error';
    let state = await f.tick([a, row('B', NOW + 1)], NOW + 1);
    assert.equal((await f.store.activeEntry()).name, 'A');
    assert.equal(state.phase, 'unconfirmed');
    assert.equal(state.candidates[0].eligible, false);
    assert.equal(state.candidates[0].fundingRetained, undefined);
    await f.restart();
    delete a[resource(source)];
    state = await f.tick([a, row('B', NOW + 2)], NOW + 2);
    assert.equal(state.phase, 'unconfirmed');
    assert.equal((await f.store.activeEntry()).name, 'A');
  });
}

test('changed thresholds reevaluate old negative amounts but do not turn failed queries into successful evidence', async t => {
  const f = await fixture(t);
  await f.tick([row('A', NOW, 'balance', 3), row('B', NOW, 'balance', 0)]);
  const a = row('A', NOW + 1); a.balance.state = 'error';
  f.config.balanceMinimum = 10; await f.save();
  let state = await f.tick([a, row('B', NOW + 1, 'balance', 0)], NOW + 1);
  assert.equal(state.candidates[0].fundingState, 'unavailable');
  f.config.balanceMinimum = 2; await f.save();
  state = await f.tick([a, row('B', NOW + 1)]);
  assert.equal(state.phase, 'unconfirmed');
  assert.equal(state.candidates[0].eligible, false);
  assert.equal((await f.store.activeEntry()).name, 'A');
  await f.tick([row('A', NOW + 2, 'balance', 0), row('B', NOW + 2, 'balance', 0)], NOW + 2);
  f.config.balanceMinimum = 0; await f.save();
  state = await f.tick([a, row('B', NOW + 3)], NOW + 3);
  assert.equal((await f.store.activeEntry()).name, 'B');
  assert.equal(state.candidates[0].remaining, 0);
});

test('subscription expiry and depletion remain excluded across quota reset times until a new query succeeds', async t => {
  for (const issue of ['expired', 'depleted', 'missing']) {
    const f = await fixture(t, 'subscription'), a = row('A', NOW, 'subscription', 0);
    if (issue === 'expired') a.subscriptions.items[0].expiresAt = NOW;
    if (issue === 'missing') a.subscriptions.items = [];
    if (issue === 'depleted') a.subscriptions.items[0].quotas[0].resetsAt = NOW + 1000;
    await f.tick([a, row('B', NOW, 'balance', 0)]);
    a.subscriptions.state = 'stale';
    const state = await f.tick([a, row('B', NOW + 2000)], NOW + 2000);
    assert.equal((await f.store.activeEntry()).name, 'B');
    assert.equal(state.candidates[0].fundingRetained, true);
    await f.tick([row('A', NOW + 2001, 'subscription', 5), row('B', NOW + 2001)], NOW + 2001);
    assert.equal((await f.store.activeEntry()).name, 'A');
  }
});

test('successful model calls and recovery of a different funding source cannot clear a known deficit', async t => {
  for (const source of ['balance', 'subscription']) {
    const f = await fixture(t, source);
    await f.tick([row('A', NOW, source, 3), row('B', NOW, 'balance', 0)]);
    const key = (await f.store.status()).keys.find(item => item.name === 'A');
    f.auto.observe({ provider: 'A', routeId: key.naturalAccountId, startedAt: new Date(NOW).toISOString(),
      at: new Date(NOW).toISOString(), status: 200, outcome: 'completed', responseComplete: true });
    await f.auto.tick();
    const a = row('A', NOW + 1, 'subscription', 100);
    a[resource(source)].state = 'error';
    const state = await f.tick([a, row('B', NOW + 1)], NOW + 1);
    assert.equal((await f.store.activeEntry()).name, 'B');
    assert.equal(state.candidates[0].fundingRetained, true);
  }
});

test('renaming preserves evidence, while a new key, funding source or plan never inherits the old deficit', async t => {
  for (const change of ['rename', 'key', 'source', 'plan']) {
    const source = change === 'plan' ? 'subscription' : 'balance';
    const f = await fixture(t, source);
    await f.tick([row('A', NOW, source, 3), row('B', NOW, 'balance', 0)]);
    const key = (await f.store.status()).keys.find(item => item.name === 'A');
    let name = 'A';
    if (change === 'rename') {
      name = 'renamed';
      await f.store.edit('A', { ...key, name });
      f.config.pool[0].name = name;
    } else if (change === 'key') await f.store.edit('A', { ...key, value: 'sk-new-key' });
    else if (change === 'source') f.config.pool[0] = { ...f.config.pool[0], source: 'subscription', subscriptionId: 42 };
    else f.config.pool[0].subscriptionId = 43;
    await f.save();
    const a = row(name, NOW + 1, 'subscription', 100);
    a.balance.state = 'error'; a.subscriptions.state = 'error';
    const state = await f.tick([a, row('B', NOW + 1)], NOW + 1);
    assert.equal((await f.store.activeEntry()).name, change === 'rename' ? 'B' : name);
    assert.equal(state.candidates[0].fundingState, change === 'rename' ? 'unavailable' : 'unknown');
  }
});

test('funding identities isolate account/key/source/plan and ignore alias, priority and thresholds', async t => {
  const f = await fixture(t), funding = f.auto.funding;
  const keys = (await f.store.status()).keys, key = keys.find(key => key.name === 'A');
  const item = f.config.pool[0], id = funding.identity(item, keys);
  assert.equal(funding.identity({ ...item, priority: 99 }, keys), id);
  assert.equal(funding.identity({ ...item, name: 'renamed' }, [{ ...key, name: 'renamed' }]), id);
  for (const change of [{ accountId: 'different' }, { naturalAccountId: 'different' }, { balanceSource: 'api-key' }]) {
    assert.notEqual(funding.identity(item, [{ ...key, ...change }]), id);
  }
  const subscription = { ...item, source: 'subscription', subscriptionId: 42 };
  assert.notEqual(funding.identity(subscription, keys), id);
  assert.notEqual(funding.identity({ ...subscription, subscriptionId: 43 }, keys), funding.identity(subscription, keys));
  const packy = { ...key, merchantId: 'packycode', balanceSource: 'api-key', accountBindingId: 'binding', accountSourceName: 'B' };
  const packyId = funding.identity(item, [packy, keys[1]]);
  assert.notEqual(funding.identity(item, [packy, { ...keys[1], naturalAccountId: 'rotated-source' }]), packyId);
  await f.tick([row('A', NOW, 'balance', 3), row('B', NOW, 'balance', 0)]);
  funding.reconcile(f.config, [{ ...key, accountId: 'different' }, keys[1]]);
  assert.equal(funding.records.size, 1, 'only B evidence remains');
});

test('a different configuration directory starts with its own evidence', async t => {
  const first = await fixture(t), second = await fixture(t);
  await first.tick([row('A', NOW, 'balance', 3), row('B', NOW, 'balance', 0)]);
  const a = row('A', NOW + 1); a.balance.state = 'error';
  const state = await second.tick([a, row('B', NOW + 1)], NOW + 1);
  assert.equal(state.phase, 'unconfirmed');
  assert.equal((await second.store.activeEntry()).name, 'A');
});

test('failed evidence writes retain in-memory exclusion and retry; corrupt evidence is not silently erased', async t => {
  const f = await fixture(t);
  await fs.mkdir(f.auto.funding.file, { recursive: true });
  // Load before simulating a file becoming unwritable, so the write path is exercised.
  f.auto.funding.loaded = true;
  const state = await f.tick([row('A', NOW, 'balance', 3), row('B', NOW)]);
  assert.equal((await f.store.activeEntry()).name, 'B');
  assert.match(state.message, /额度排除记录保存失败/);
  await fs.rmdir(f.auto.funding.file);
  await f.auto.tick();
  assert.equal(f.auto.funding.warning, '');
  assert.equal(JSON.parse(await fs.readFile(f.auto.funding.file, 'utf8')).records.length, 1);
  await fs.writeFile(f.auto.funding.file, '{broken');
  await assert.rejects(new AutoSwitchFunding(f.home).load());
  assert.equal(await fs.readFile(f.auto.funding.file, 'utf8'), '{broken');
});
