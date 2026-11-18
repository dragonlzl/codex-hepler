const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { bindingModel } = require('../account-bindings');
const { KRILL_HOSTS, accountId } = require('../relay-identity');
const { ConfigStore } = require('../config-store');
const { MonitorAuth } = require('../monitor-auth');
const { Availability } = require('../availability');
const fixture = require('./krill-account-fixture');

function legacyBinding(origin) {
  const entries = [
    { name: 'Krill primary', baseurl: origin + '/v1', value: 'sk-krill-primary' },
    { name: 'Krill weekly', baseurl: origin + '/coding/v1', value: 'sk-krill-weekly' },
  ];
  const record = { id: 'c'.repeat(64), merchant: origin, members: entries.map(accountId), sourceId: accountId(entries[1]) };
  return { entries, record };
}

test('legacy Krill official origins normalize without changing account IDs, membership, source or stored state', () => {
  for (const host of KRILL_HOSTS) for (const protocol of ['http:', 'https:']) {
    const { entries, record } = legacyBinding(protocol + '//' + host);
    const state = { accountBindings: [record] }, before = structuredClone(state);
    const model = bindingModel(entries, state, 'compat');
    assert.deepEqual(model.records, [{ ...record, merchant: 'krill' }]);
    assert.deepEqual(state, before);
    for (const entry of entries) {
      const description = model.describe(entry);
      assert.equal(description.accountId, record.id);
      assert.equal(description.accountBindingId, record.id);
      assert.equal(description.naturalAccountId, accountId(entry));
      assert.equal(description.accountSourceName, entries[1].name);
      assert.equal(description.boundAccountCount, 2);
    }
    assert.equal(model.revision, bindingModel(entries, { accountBindings: [{ ...record, merchant: 'krill' }] }, 'compat').revision);
  }
});

test('legacy Krill origin normalization rejects credentials, ports, paths, query strings, fragments and lookalike hosts', () => {
  const { entries, record } = legacyBinding('https://api.kbsfdxc.com');
  for (const merchant of [
    'ftp://api.kbsfdxc.com', 'https://api.kbsfdxc.com:443', 'https://api.kbsfdxc.com:8443',
    'https://user@api.kbsfdxc.com', 'https://user:password@api.kbsfdxc.com',
    'https://api.kbsfdxc.com/', 'https://api.kbsfdxc.com/v1', 'https://api.kbsfdxc.com?origin=krill',
    'https://api.kbsfdxc.com#krill', 'https://api.kbsfdxc.com.evil.example', 'https://other.kbsfdxc.com',
    'https://api.kbsfdxc.com@evil.example', 'https://evil.example@api.kbsfdxc.com', ' https://api.kbsfdxc.com',
  ]) assert.throws(() => bindingModel(entries, { accountBindings: [{ ...record, merchant }] }), { status: 409 });
  const foreign = { name: 'Other merchant', baseurl: 'https://ai.input.im/v1', value: 'sk-other' };
  assert.throws(() => bindingModel([...entries, foreign], { accountBindings: [{ ...record, members: [...record.members, accountId(foreign)] }] }), { status: 409 });
});

test('legacy Krill bindings keep their saved authorization usable without moving or rewriting credentials', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-krill-binding-compat-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const { entries, record } = legacyBinding('https://api-slb.kbsfdxc.net');
  await fs.writeFile(path.join(home, 'config.toml'), 'model_provider="relay"\n[model_providers.relay]\nbase_url="' + entries[0].baseurl + '"\n');
  await fs.writeFile(path.join(home, 'key_config.json'), JSON.stringify({ keys: entries }));
  const stateFile = path.join(home, 'relay-ui-state.json'), stateText = JSON.stringify({ accountBindings: [record] });
  await fs.writeFile(stateFile, stateText);
  const auth = new MonitorAuth(home, 'krill', record.id);
  await auth.save(fixture.TOKEN);
  const credentialText = await fs.readFile(auth.file, 'utf8');
  const store = new ConfigStore(home, 'http://127.0.0.1:3211');
  const routes = (await store.status()).keys;
  assert.ok(routes.every(entry => entry.accountId === record.id && entry.merchantId === 'krill'));
  assert.ok(routes.every(entry => entry.accountSourceName === entries[1].name));
  const monitor = new Availability({}, { home, getEntries: async () => routes, request: fixture.request });
  t.after(() => monitor.close());
  const rows = (await monitor.snapshot(routes)).rows;
  assert.ok(rows.every(row => row.balance.state === 'available' && row.balance.amount === 88.125));
  assert.ok(rows.every(row => row.subscriptions.state === 'available' && row.subscriptions.items.length === 2));
  assert.equal(await fs.readFile(auth.file, 'utf8'), credentialText);
  assert.equal(await fs.readFile(stateFile, 'utf8'), stateText);
  assert.deepEqual((await fs.readdir(path.dirname(auth.file))).filter(file => file.startsWith('krill-')), [path.basename(auth.file)]);
});
