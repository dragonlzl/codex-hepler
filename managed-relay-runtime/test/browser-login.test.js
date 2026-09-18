const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { BrowserLogin } = require('../browser-login');
const { MonitorAuth } = require('../monitor-auth');
const { Availability } = require('../availability');
const { accountId } = require('../relay-identity');
const { start } = require('../../managed-relay-server');
const fixture = require('./aigo-fixture');

async function until(read) {
  for (let i = 0; i < 200; i++) { const value = await read(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw new Error('Browser session did not settle');
}
async function temp(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-browser-auth-test-'));
  t.after(() => fs.rm(home, { recursive: true, force: true })); return home;
}

test('dedicated browser session imports a token once and closes after success without returning it', async t => {
  let closed = 0, saves = 0;
  const manager = new BrowserLogin({ interval: 5, launch: async () => ({ readToken: async () => fixture.TOKEN, close: async () => { closed++; } }) });
  t.after(() => manager.close());
  const session = await manager.start('account', async token => { assert.equal(token, fixture.TOKEN); saves++; return { message: '已保存', expiresAt: 100 }; });
  await until(() => manager.status(session.browserLoginId).state === 'success');
  assert.equal(saves, 1); assert.equal(closed, 1);
  assert.ok(!JSON.stringify(manager.status(session.browserLoginId)).includes(fixture.TOKEN));
});

test('browser cancellation, timeout, user close and service close terminate each session', async t => {
  for (const action of ['cancel', 'timeout', 'close-window', 'close-service']) {
    let saves = 0, closed = 0;
    const manager = new BrowserLogin({ interval: 5, lifetime: 30,
      launch: async () => ({ readToken: async () => { if (action === 'close-window') throw new Error('Raw private error'); return null; }, close: async () => { closed++; } }) });
    t.after(() => manager.close());
    const { browserLoginId: id } = await manager.start('account', async () => { saves++; });
    await assert.rejects(manager.start('account', async () => {}), /已有登录窗口/);
    if (action === 'cancel') manager.cancel(id);
    else if (action === 'close-service') await manager.close();
    else await until(() => manager.status(id).state !== 'pending');
    assert.equal(saves, 0); assert.equal(closed, 1);
    if (action !== 'close-service') assert.ok(!JSON.stringify(manager.status(id)).includes('Raw private'));
  }
});

test('cancelling a slow launch closes the arriving browser and rejects startup', async t => {
  let release, closed = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const manager = new BrowserLogin({ launch: async () => { await gate; return { readToken: async () => fixture.TOKEN, close: async () => { closed++; } }; } });
  t.after(() => manager.close());
  const pending = manager.start('account', async () => { throw new Error('Must not save'); });
  await manager.close(); release();
  await assert.rejects(pending, /取消/); assert.equal(closed, 1);
});

test('browser login HTTP flow saves only the account token and supports safe polling and cancellation', async t => {
  const home = await temp(t), key = { name: '派大星', baseurl: 'https://api.aigo0.com/v1', value: fixture.KEYS[0] };
  await fs.writeFile(path.join(home, 'config.toml'), 'model_provider="relay"\n[model_providers.relay]\nbase_url="https://api.aigo0.com/v1"\n');
  await fs.writeFile(path.join(home, 'key_config.json'), JSON.stringify({ keys: [key] }));
  let token = fixture.TOKEN, closed = 0;
  const app = await start({ home, uiPort: 0, proxyPort: 0, log: () => {}, availabilityOptions: { request: fixture.request,
    browserLoginOptions: { interval: 5, launch: async () => ({ readToken: async () => token,
      frame: async () => ({ width: 760, height: 780, image: 'YWlnbw==', mimeType: 'image/jpeg' }),
      input: async event => { assert.equal(event.type, 'text'); return { accepted: true }; }, close: async () => { closed++; } }) } } });
  t.after(() => app.close());
  const post = async (route, data) => {
    const res = await fetch(app.uiUrl + '/api/availability/browser-login/' + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    return { code: res.status, data: await res.json() };
  };
  assert.equal((await post('start', { site: 'input', name: key.name })).code, 400);
  const session = await post('start', { site: 'aigo', name: key.name, accountId: accountId(key) }); assert.equal(session.code, 200);
  const final = await until(async () => { const p = await post('status', { id: session.data.browserLoginId }); return p.data.state !== 'pending' && p; });
  assert.equal(final.data.state, 'success'); assert.ok(!JSON.stringify(final).includes(fixture.TOKEN));
  assert.equal((await new MonitorAuth(home, 'aigo', accountId(key)).read()).token, fixture.TOKEN); assert.equal(closed, 1);
  token = null;
  const second = await post('start', { site: 'aigo', name: key.name, presentation: 'embedded' });
  const frame = await post('frame', { id: second.data.browserLoginId }); assert.equal(frame.code, 200); assert.equal(frame.data.mimeType, 'image/jpeg');
  const input = await post('input', { id: second.data.browserLoginId, event: { type: 'text', text: 'private-fixture-input' } });
  assert.deepEqual(input.data, { accepted: true });
  const blocked = await fetch(app.uiUrl + '/api/availability/browser-login/input', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://other.invalid' }, body: JSON.stringify({ id: second.data.browserLoginId, event: { type: 'text', text: 'blocked' } }) });
  assert.equal(blocked.status, 403);
  await post('cancel', { id: second.data.browserLoginId }); assert.equal(closed, 2);
  assert.equal((await post('status', { id: second.data.browserLoginId })).data.state, 'cancelled');
  assert.equal((await post('frame', { id: second.data.browserLoginId })).code, 410);
});

test('changed account or newer authorization cannot be overwritten by a pending browser login', async t => {
  for (const change of ['key', 'authorization']) {
    const home = await temp(t); let token = null;
    const key = { name: '派大星', baseurl: 'https://api.aigo0.com', value: fixture.KEYS[0] };
    const entry = () => ({ ...key, accountId: accountId(key) });
    const monitor = new Availability({}, { home, getEntry: async () => key, getEntries: async () => [entry()], request: fixture.request,
      browserLoginOptions: { interval: 5, launch: async () => ({ readToken: async () => token, close: async () => {} }) } });
    t.after(() => monitor.close());
    const { browserLoginId: id } = await monitor.startBrowserLogin({ site: 'aigo', name: key.name });
    if (change === 'key') key.value = fixture.KEYS[1];
    else await monitor.authorize('aigo', '', undefined, { name: key.name });
    token = fixture.TOKEN;
    await until(() => monitor.browserLoginStatus(id).state === 'error');
    assert.equal(await new MonitorAuth(home, 'aigo', accountId(key)).read(), null);
  }
});
