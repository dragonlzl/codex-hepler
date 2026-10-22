const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { start } = require('../../managed-relay-server');

async function fixture(t, launcher) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'account-api-'));
  const previousSettings = process.env.RELAY_UI_SETTINGS;
  process.env.RELAY_UI_SETTINGS = path.join(home, 'settings.json');
  t.after(() => {
    if (previousSettings === undefined) delete process.env.RELAY_UI_SETTINGS;
    else process.env.RELAY_UI_SETTINGS = previousSettings;
  });
  await fs.writeFile(path.join(home, 'config.toml'), 'model_provider="relay"\n[model_providers.relay]\nbase_url="https://example.invalid/v1"\nrequires_openai_auth=true\n');
  await fs.writeFile(path.join(home, 'auth.json'), '{"OPENAI_API_KEY":"fixture-secret-key"}');
  await fs.writeFile(path.join(home, 'key_config.json'), JSON.stringify({ keys: [
    { name: 'fixture', value: 'fixture-secret-key', baseurl: 'https://example.invalid/v1' },
  ] }));
  const app = await start({ home, proxyPort: 0, uiPort: 0, launcher, log: () => {} });
  t.after(async () => { await app.close(); await fs.rm(home, { recursive: true, force: true }); });
  const post = (route, payload, origin = app.uiUrl) => fetch(app.uiUrl + route, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) }, body: JSON.stringify(payload),
  });
  return { app, home, post };
}

test('account mode API requires local UI origin and validates only the fixed mode action', async t => {
  const { home, post } = await fixture(t);
  const before = await fs.readFile(path.join(home, 'auth.json'), 'utf8');
  for (const origin of ['', 'http://other.invalid']) {
    assert.equal((await post('/api/account-mode', { mode: 'official' }, origin)).status, 403);
  }
  for (const payload of [null, {}, { mode: 'bad' }, { mode: 'official', auth: {} }]) {
    assert.equal((await post('/api/account-mode', payload)).status, 400);
  }
  assert.equal(await fs.readFile(path.join(home, 'auth.json'), 'utf8'), before);
});

test('API round trip preserves official tokens without returning credentials and launches in official mode', async t => {
  const launches = [];
  const { app, home, post } = await fixture(t, {
    snapshot: async () => ({ available: true, cli: { state: 'idle' } }),
    start: async (target, context) => { launches.push({ target, context }); return { message: 'fixture launch' }; },
  });
  await app.store.install('fixture');
  const response = await post('/api/account-mode', { mode: 'official' });
  assert.equal(response.status, 200);
  const official = await response.json();
  assert.equal(official.status.accountSwitch.mode, 'official');
  assert.equal(official.status.proxyInstalled, false);
  assert.equal(official.restartRequired, true);
  assert.ok(!JSON.stringify(official).includes('fixture-secret-key'));
  const tokens = { auth_mode: 'chatgpt', tokens: { access_token: 'fixture-access-token', refresh_token: 'fixture-refresh-token' } };
  await fs.writeFile(path.join(home, 'auth.json'), JSON.stringify(tokens));
  assert.equal((await post('/api/launch', { target: 'app' })).status, 200);
  assert.equal(launches[0].context.status.accountSwitch.mode, 'official');
  const relay = await post('/api/account-mode', { mode: 'relay' });
  assert.equal(relay.status, 200);
  assert.equal((await relay.json()).status.proxyInstalled, true);
  const back = await post('/api/account-mode', { mode: 'official' });
  assert.equal(back.status, 200);
  const result = await back.json();
  assert.equal(result.status.accountSwitch.officialLoggedIn, true);
  assert.ok(!JSON.stringify(result).includes('fixture-access-token'));
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(home, 'auth.json'), 'utf8')), tokens);
});

test('account mode cannot change while a managed CLI session is active', async t => {
  const { home, post } = await fixture(t, { snapshot: async () => ({ cli: { state: 'running' } }) });
  const before = await fs.readFile(path.join(home, 'config.toml'), 'utf8');
  const response = await post('/api/account-mode', { mode: 'official' });
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /退出.*CLI/);
  assert.equal(await fs.readFile(path.join(home, 'config.toml'), 'utf8'), before);
});

test('official network mode persists Wi-Fi selection without exposing proxy credentials', async t => {
  const { app, post } = await fixture(t, { snapshot: async () => ({ cli: { state: 'idle' } }) });
  const wifi = await post('/api/official-network', { mode: 'wifi' });
  assert.equal(wifi.status, 200);
  const wifiBody = await wifi.json();
  assert.equal(wifiBody.status.officialNetwork.mode, 'wifi');
  assert.equal(wifiBody.status.officialNetwork.label, '官方模式未启用');
  assert.equal(wifiBody.restartRequired, true);
  const auto = await post('/api/official-network', { mode: 'auto' });
  assert.equal(auto.status, 200);
  assert.equal((await auto.json()).status.officialNetwork.mode, 'auto');
  assert.equal(JSON.stringify(wifiBody).includes('fixture-secret-key'), false);
});
