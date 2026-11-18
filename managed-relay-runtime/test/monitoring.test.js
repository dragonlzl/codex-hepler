const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { start } = require('../../managed-relay-server');
const { Availability } = require('../availability');
const { PackyBalance } = require('../balance-packycode');
const { defaults } = require('../auto-switch-policy');
const { readAvailabilityMonitoring, writeAvailabilityMonitoring, readSettings } = require('../settings');
const timi = require('./timicc-fixture');

const key = { name: 'timi', baseurl: 'https://timicc.com', value: 'sk-test-monitoring' };
const tick = () => new Promise(setImmediate);

async function fixture(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-monitoring-'));
  const previous = process.env.RELAY_UI_SETTINGS;
  process.env.RELAY_UI_SETTINGS = path.join(home, 'settings.json');
  await fs.writeFile(path.join(home, 'config.toml'), 'model_provider="relay"\n[model_providers.relay]\nname="relay"\nbase_url="https://timicc.com"\nwire_api="responses"\n');
  await fs.writeFile(path.join(home, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: key.value }));
  await fs.writeFile(path.join(home, 'key_config.json'), JSON.stringify({ keys: [key] }));
  t.after(async () => {
    if (previous === undefined) delete process.env.RELAY_UI_SETTINGS; else process.env.RELAY_UI_SETTINGS = previous;
    await fs.rm(home, { recursive: true, force: true });
  });
  return home;
}

async function post(app, payload, origin = app.uiUrl) {
  const response = await fetch(app.uiUrl + '/api/availability/settings', {
    method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify(payload),
  });
  return { code: response.status, ...await response.json() };
}

test('monitoring defaults off for absent, corrupt and non-boolean settings, and persists explicit choices', async t => {
  await fixture(t);
  assert.equal(await readAvailabilityMonitoring(), false);
  await fs.writeFile(process.env.RELAY_UI_SETTINGS, '{broken');
  assert.equal(await readAvailabilityMonitoring(), false);
  for (const value of ['true', 1, null, [], {}]) {
    await fs.writeFile(process.env.RELAY_UI_SETTINGS, JSON.stringify({ availabilityMonitoringEnabled: value, home: '/saved' }));
    assert.equal(await readAvailabilityMonitoring(), false);
  }
  await writeAvailabilityMonitoring(true);
  assert.equal(await readAvailabilityMonitoring(), true);
  assert.equal((await readSettings()).home, '/saved');
  await assert.rejects(writeAvailabilityMonitoring('false'), /开关无效/);
  assert.equal(await readAvailabilityMonitoring(), true);
  await writeAvailabilityMonitoring(false);
  assert.equal(await readAvailabilityMonitoring(), false);
});

test('server defaults off, gates every snapshot consumer, and preserves auto-switch settings across pause and restart', async t => {
  const home = await fixture(t);
  let calls = 0;
  const options = { home, uiPort: 0, proxyPort: 0, log: () => {},
    availabilityOptions: { request: (...args) => { calls++; return timi.request(...args); } } };
  let app = await start(options);
  t.after(() => app.close());
  await app.autoSwitch.tick();
  assert.equal((await app.status()).availabilityMonitoringEnabled, false);
  assert.equal(app.autoSwitch.timer, undefined);
  await app.store.install('timi');
  await app.store.saveAutoSwitch({ revision: (await app.store.status()).autoSwitchRevision, settings: { ...defaults(), enabled: true,
    pool: [{ name: 'timi', priority: 1, source: 'balance' }] } });
  await app.autoSwitch.tick();
  assert.equal(app.autoSwitch.snapshot().phase, 'paused');
  const saved = (await app.status()).autoSwitchSettings;
  for (const endpoint of ['/api/availability', '/api/availability?view=simple', '/api/auto-switch/options']) {
    const response = await fetch(app.uiUrl + endpoint);
    assert.equal(response.status, 200);
    const result = await response.json();
    if (result.rows) { assert.equal(result.enabled, false); assert.equal(result.rows[0].state, 'disabled'); }
  }
  assert.equal(calls, 0);
  for (const payload of [{}, { enabled: 'true' }, { enabled: true, extra: true }, null]) assert.equal((await post(app, payload)).code, 400);
  assert.equal((await post(app, { enabled: true }, 'https://other.example')).code, 403);
  assert.equal((await post(app, { enabled: true })).status.availabilityMonitoringEnabled, true);
  assert.ok(app.autoSwitch.timer);
  const enabled = await (await fetch(app.uiUrl + '/api/availability')).json();
  assert.equal(enabled.enabled, true);
  assert.equal(enabled.rows[0].state, 'degraded');
  assert.ok(calls > 0);
  const disabled = await post(app, { enabled: false });
  assert.equal(disabled.status.availabilityMonitoringEnabled, false);
  assert.equal(app.autoSwitch.timer, null);
  assert.deepEqual(disabled.status.autoSwitchSettings, saved);
  const count = calls;
  await app.autoSwitch.tick();
  assert.equal((await (await fetch(app.uiUrl + '/api/availability')).json()).enabled, false);
  assert.equal(calls, count);
  await app.close();
  app = await start(options);
  assert.equal((await app.status()).availabilityMonitoringEnabled, false);
  assert.deepEqual((await app.status()).autoSwitchSettings, saved);
  assert.equal(calls, count);
  await post(app, { enabled: true });
  await app.close();
  app = await start(options);
  assert.equal((await app.status()).availabilityMonitoringEnabled, true);
  assert.ok(app.autoSwitch.timer);
});

test('disabling aborts an in-flight refresh without logging a failure and re-enabling fetches fresh data', async t => {
  let started, calls = 0, aborted = 0, block = true;
  const ready = new Promise(resolve => { started = resolve; });
  const events = [];
  const monitor = new Availability({}, { record: event => events.push(event), request: (url, options) => {
    calls++;
    if (!block) return timi.request(url, options);
    return new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => { aborted++; reject(options.signal.reason); }, { once: true });
      started();
    });
  } });
  t.after(() => monitor.close());
  const pending = monitor.snapshot([key]);
  await ready;
  monitor.setMonitoringEnabled(false);
  assert.equal((await pending).rows[0].state, 'disabled');
  assert.equal(aborted, 1);
  assert.equal(events.length, 0);
  await monitor.snapshot([key]);
  assert.equal(calls, 1);
  block = false;
  monitor.setMonitoringEnabled(true);
  assert.equal((await monitor.snapshot([key])).rows[0].state, 'degraded');
  assert.equal(calls, 2);
});

test('disabling cancels Packy balance work and suppresses automatic reads until resumed', async t => {
  let started, calls = 0, aborted = 0;
  const ready = new Promise(resolve => { started = resolve; });
  const manager = new PackyBalance({ outbound: {}, getEntry: async () => ({ ...key, baseurl: 'https://cf.api.fan/v1' }), isPacky: () => true,
    request: (_url, { signal }) => {
      calls++;
      return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => { aborted++; reject(signal.reason); }, { once: true });
        started();
      });
    } });
  t.after(() => manager.close());
  assert.equal((await manager.read('Packy')).refreshing, true);
  await ready;
  manager.setMonitoringEnabled(false);
  await tick();
  assert.equal(aborted, 1);
  assert.equal((await manager.read('Packy')).state, 'disabled');
  assert.equal(calls, 1);
  manager.setMonitoringEnabled(true);
  await manager.read('Packy');
  await tick();
  assert.equal(calls, 2);
});

test('a balance read waiting for its key cannot start a request after monitoring is disabled', async t => {
  let release, calls = 0;
  const waiting = new Promise(resolve => { release = resolve; });
  const manager = new PackyBalance({ outbound: {}, getEntry: async () => { await waiting; return key; }, isPacky: () => true,
    request: async () => { calls++; throw new Error('must not fetch'); } });
  t.after(() => manager.close());
  const pending = manager.read('Packy');
  manager.setMonitoringEnabled(false);
  release();
  assert.equal((await pending).state, 'disabled');
  assert.equal(calls, 0);
});

test('the client clears old status and all timers while disabled, then resumes on explicit enable', async () => {
  const source = await fs.readFile(path.join(__dirname, '../../managed-relay-public/availability.js'), 'utf8');
  const timers = new Map(); let serial = 0, calls = 0;
  const state = { keys: [key], availabilityAvailable: true, availabilityMonitoringEnabled: false };
  const document = { hidden: false };
  const View = vm.runInNewContext(source + '\nRelayAvailability;', { document, Date, Intl, AbortController, AbortSignal,
    setTimeout: (action, delay) => { timers.set(++serial, { action, delay }); return serial; }, clearTimeout: id => timers.delete(id),
    fetch: async () => { calls++; return { ok: true, json: async () => ({ model: 'gpt-6-astra', rows: [{ ...key, state: 'available' }] }) }; } });
  const client = Object.assign(Object.create(View.prototype), { model: 'gpt-6-astra', signature: '', rows: new Map(),
    rowFailures: new Map(), rowIdentities: new Map(), select: {}, getState: () => state, getView: () => 'simple', isDragging: () => false, paint() {} });
  client.sync(); client.start(); await client.refresh();
  assert.equal(calls, 0); assert.equal(timers.size, 0);
  state.availabilityMonitoringEnabled = true;
  client.sync(); await tick();
  assert.equal(calls, 1); assert.equal(client.rows.size, 1);
  client.start();
  assert.equal(timers.size, 1);
  const controller = new AbortController(); client.request = controller;
  client.balancePoll = ++serial; timers.set(serial, {});
  state.availabilityMonitoringEnabled = false; client.sync();
  assert.equal(controller.signal.aborted, true);
  assert.equal(timers.size, 0); assert.equal(client.rows.size, 0);
  assert.equal(client.filterFor(key), null);
  state.availabilityMonitoringEnabled = true; document.hidden = true;
  client.start(); await client.refresh();
  assert.equal(timers.size, 0); assert.equal(calls, 1);
  document.hidden = false; await client.refresh();
  assert.equal(calls, 2);
  client.cancel();
});

test('management status polling uses 30 seconds while disabled, 5 seconds while enabled, and no timer when hidden', async () => {
  const source = await fs.readFile(path.join(__dirname, '../../managed-relay-public/app.js'), 'utf8');
  const start = source.indexOf('function scheduleStatusRefresh(');
  const code = source.slice(start, source.indexOf('\n}', start) + 2);
  const state = { availabilityMonitoringEnabled: false }, document = { hidden: false };
  let scheduled;
  const schedule = vm.runInNewContext(code + '\nscheduleStatusRefresh;', { state, document, statusTimer: null, load() {},
    setTimeout: (_action, delay) => { scheduled = delay; return 1; }, clearTimeout: () => { scheduled = null; } });
  schedule(); assert.equal(scheduled, 30000);
  state.availabilityMonitoringEnabled = true; schedule(); assert.equal(scheduled, 5000);
  document.hidden = true; schedule(); assert.equal(scheduled, null);
});
