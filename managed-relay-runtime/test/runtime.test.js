const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { once } = require('node:events');
const { gzipSync } = require('node:zlib');
const { ConfigStore, inspectConfig, patchBase, atomicWrite } = require('../config-store');
const { start } = require('../../managed-relay-server');

async function fixture(t, baseA = 'https://a.example/v1', baseB = 'https://b.example/codex/v1') {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-regression-'));
  const cleanups = [];
  t.after(async () => {
    // Stop background writers before deleting their configuration directory.
    for (const close of cleanups) await close();
    await fs.rm(home, { recursive: true, force: true });
  });
  const original = `# Original provider must survive\nmodel_provider = 'original.provider'\nmodel = "test-model"\n[model_providers.'original.provider']\nname = "Original identity"\nbase_url = '${baseA}' # preserve this comment\nwire_api = "responses"\nrequires_openai_auth = true\nsupports_websockets = true\n[projects."/tmp/project"]\ntrust_level = "trusted"\n`;
  const auth = '{\n  "OPENAI_API_KEY": "sk-test-a", "extra": "keep"\n}\n';
  const keys = [{ name: '中转站甲', value: 'sk-test-a', baseurl: baseA }, { name: '备用线路✨', value: 'sk-test-b', baseurl: baseB }];
  await fs.writeFile(path.join(home, 'config.toml'), original);
  await fs.writeFile(path.join(home, 'auth.json'), auth);
  await fs.writeFile(path.join(home, 'key_config.json'), JSON.stringify({ keys, target_file: 'auth.json' }));
  const store = new ConfigStore(home, 'http://127.0.0.1:3211/v1');
  return { home, store, original, auth, keys, onCleanup: close => cleanups.push(close), config: () => fs.readFile(store.configPath, 'utf8') };
}

test('TOML edits only the active value, preserving quoted/dotted keys, inline tables and comments', () => {
  for (const text of [
    'model_provider="a.b"\n[model_providers."a.b"]\nbase_url="https://a.example" # trailing\nname="original"\n',
    'model_provider="a.b"\nmodel_providers."a.b".base_url="https://a.example"\n',
    'model_provider="a.b"\nmodel_providers={"a.b"={base_url="https://a.example",name="original"}}\n',
  ]) {
    const info = inspectConfig(text);
    assert.equal(info.id, 'a.b');
    const patched = patchBase(info, 'http://127.0.0.1:3211/v1');
    assert.equal(patched, text.replace('https://a.example', 'http://127.0.0.1:3211/v1'));
  }
});

test('startup/status ignores stale mode and unused local-proxy blocks without writing configuration', async t => {
  const f = await fixture(t);
  const text = f.original + '[model_providers.unused]\nbase_url="http://127.0.0.1:3211/v1"\n';
  await fs.writeFile(f.store.configPath, text);
  await fs.writeFile(f.store.statePath, JSON.stringify({ mode: 'proxy', activeName: '备用线路✨' }));
  const state = await f.store.status();
  assert.equal(state.mode, 'direct');
  assert.equal(state.proxyInstalled, false);
  assert.equal(state.activeName, '中转站甲');
  assert.equal(await f.config(), text);
});

test('route order persists in relay state without rewriting key configuration', async t => {
  const f = await fixture(t);
  const before = await fs.readFile(f.store.keysPath, 'utf8');
  const app = await start({ home: f.home, proxyPort: 0, uiPort: 0, log: () => {} });
  f.onCleanup(() => app.close());
  await post(app, '/api/reorder', { names: ['备用线路✨', '中转站甲'] });
  assert.deepEqual((await f.store.status()).keys.map(entry => entry.name), ['备用线路✨', '中转站甲']);
  assert.equal(await fs.readFile(f.store.keysPath, 'utf8'), before);
  assert.deepEqual(JSON.parse(await fs.readFile(f.store.statePath)).order, ['备用线路✨', '中转站甲']);
  await assert.rejects(f.store.reorder(['中转站甲']), /排序/);
});

test('pin API preserves credentials, base order and routing across refresh and mode changes', async t => {
  const f = await fixture(t);
  const keysBefore = await fs.readFile(f.store.keysPath, 'utf8');
  const app = await start({ home: f.home, proxyPort: 0, uiPort: 0, log: () => {} });
  f.onCleanup(() => app.close());
  await post(app, '/api/reorder', { names: ['备用线路✨', '中转站甲'] });
  await post(app, '/api/pin', { name: '中转站甲', pinned: true });
  const state = await (await fetch(app.uiUrl + '/api/status')).json();
  assert.deepEqual(state.keys.map(entry => [entry.name, entry.pinned]), [['中转站甲', true], ['备用线路✨', false]]);
  assert.equal(state.activeName, '中转站甲');
  assert.equal(await f.config(), f.original);
  assert.equal(await fs.readFile(f.store.authPath, 'utf8'), f.auth);
  const reopened = new ConfigStore(f.home, app.proxyUrl);
  assert.equal((await reopened.status()).keys[0].pinned, true);

  await post(app, '/api/proxy/install', { name: '备用线路✨' });
  await post(app, '/api/select', { name: '中转站甲', mode: 'proxy' });
  await post(app, '/api/proxy/install', { name: '备用线路✨' });
  assert.deepEqual(JSON.parse(await fs.readFile(f.store.statePath)).order, ['备用线路✨', '中转站甲']);
  assert.equal((await app.store.activeEntry()).name, '备用线路✨');
  assert.equal((await app.status()).keys[0].pinned, true);
  await post(app, '/api/proxy/restore');
  await post(app, '/api/pin', { name: '中转站甲', pinned: false });
  assert.deepEqual((await app.status()).keys.map(entry => entry.name), ['备用线路✨', '中转站甲']);
  assert.equal(await fs.readFile(f.store.keysPath, 'utf8'), keysBefore);
  assert.equal(await f.config(), f.original);
  assert.equal(await fs.readFile(f.store.authPath, 'utf8'), f.auth);
});

test('dragging within pin groups preserves unpin placement and appends newly added routes', async t => {
  const f = await fixture(t);
  await f.store.add({ name: 'third', value: 'sk-third', baseurl: 'https://third.example' });
  await f.store.add({ name: 'fourth', value: 'sk-fourth', baseurl: 'https://fourth.example' });
  const order = ['中转站甲', '备用线路✨', 'third', 'fourth'];
  await f.store.reorder(order);
  await Promise.all([f.store.pin('备用线路✨', true), f.store.pin('fourth', true)]);
  assert.deepEqual((await f.store.status()).keys.map(entry => entry.name), ['备用线路✨', 'fourth', '中转站甲', 'third']);
  await f.store.reorder(['fourth', '备用线路✨', 'third', '中转站甲']);
  assert.deepEqual((await f.store.status()).keys.map(entry => entry.name), ['fourth', '备用线路✨', 'third', '中转站甲']);
  await f.store.pin('fourth', false);
  assert.deepEqual((await f.store.status()).keys.map(entry => entry.name), ['备用线路✨', 'third', 'fourth', '中转站甲']);
  await f.store.pin('备用线路✨', false);
  assert.deepEqual((await f.store.status()).keys.map(entry => entry.name), ['third', 'fourth', '中转站甲', '备用线路✨']);
  await f.store.add({ name: 'fifth', value: 'sk-fifth', baseurl: 'https://fifth.example' });
  assert.equal((await f.store.status()).keys.at(-1).name, 'fifth');
});

test('invalid pins and failed writes leave existing order and active selection intact', async t => {
  const f = await fixture(t);
  await f.store.select('中转站甲', 'proxy');
  await f.store.reorder(['备用线路✨', '中转站甲']);
  const before = await fs.readFile(f.store.statePath, 'utf8');
  const app = await start({ home: f.home, proxyPort: 0, uiPort: 0, log: () => {} });
  f.onCleanup(() => app.close());
  for (const payload of [{ name: 'missing', pinned: true }, { name: '中转站甲', pinned: 'false' }]) {
    const res = await fetch(app.uiUrl + '/api/pin', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    assert.equal(res.status, 400);
  }
  const failing = new ConfigStore(f.home, f.store.proxyUrl, async () => { throw new Error('write failure'); });
  await assert.rejects(failing.pin('备用线路✨', true), /回滚/);
  assert.equal(await fs.readFile(f.store.statePath, 'utf8'), before);
  assert.equal((await f.store.activeEntry()).name, '中转站甲');
});

test('install/route switch/restore preserves identity and restores exact original bytes', async t => {
  const f = await fixture(t);
  const result = await f.store.install('中转站甲');
  assert.equal(result.restartRequired, true);
  const applied = inspectConfig(await f.config());
  assert.equal(applied.id, 'original.provider');
  assert.equal(applied.provider.name, 'Original identity');
  assert.equal(applied.provider.supports_websockets, true);
  assert.equal(await fs.readFile(f.store.authPath, 'utf8'), f.auth);
  assert.equal((await f.store.status()).mode, 'proxy');
  assert.equal((await f.store.select('备用线路✨', 'proxy')).restartRequired, false);
  await f.store.install('备用线路✨');
  assert.equal((await f.store.restore()).restartRequired, true);
  assert.equal(await f.config(), f.original);
  assert.equal(await fs.readFile(f.store.authPath, 'utf8'), f.auth);
  assert.equal((await f.store.status()).mode, 'direct');
  const session = await fs.stat(f.store.sessionPath);
  assert.equal(session.mode & 0o777, 0o600);
});

test('a fresh install cycle backs up the latest direct target, not the first-ever backup', async t => {
  const f = await fixture(t);
  await f.store.install('中转站甲');
  await f.store.restore();
  await f.store.select('备用线路✨', 'direct');
  const direct = await f.config();
  assert.equal(inspectConfig(direct).id, 'original.provider');
  assert.equal(inspectConfig(direct).provider.name, 'Original identity');
  assert.equal(JSON.parse(await fs.readFile(f.store.authPath)).OPENAI_API_KEY, 'sk-test-b');
  await f.store.install('中转站甲');
  await f.store.restore();
  assert.equal(await f.config(), direct);
});

test('manual restore and later independent edits are respected', async t => {
  const f = await fixture(t);
  await f.store.install('中转站甲');
  const edited = (await f.config()).replace('test-model', 'new-model');
  await fs.writeFile(f.store.configPath, edited);
  await fs.writeFile(f.store.authPath, '{"OPENAI_API_KEY":"user-new-key"}');
  await f.store.restore();
  assert.equal(await f.config(), f.original.replace('test-model', 'new-model'));
  assert.equal(JSON.parse(await fs.readFile(f.store.authPath)).OPENAI_API_KEY, 'user-new-key');
  await fs.writeFile(f.store.configPath, f.original);
  const result = await f.store.restore();
  assert.equal(result.restartRequired, false);
  assert.equal(await f.config(), f.original);
});

test('legacy proxy without a trusted session cannot restore a guessed/stale backup', async t => {
  const f = await fixture(t);
  const proxyText = patchBase(inspectConfig(f.original), f.store.proxyUrl);
  await fs.writeFile(f.store.configPath, proxyText);
  await fs.writeFile(f.store.configPath + '.relay-ui-direct.bak', 'stale backup');
  await assert.rejects(f.store.restore(), /没有本次接入前/);
  assert.equal(await f.config(), proxyText);
});

test('failed direct write rolls authentication back and releases the write queue', async t => {
  const f = await fixture(t);
  const store = new ConfigStore(f.home, f.store.proxyUrl, async (file, text) => {
    if (file === f.store.configPath) throw new Error('simulated disk error');
    await atomicWrite(file, text);
  });
  await assert.rejects(store.select('备用线路✨', 'direct'), /已回滚/);
  assert.equal(await f.config(), f.original);
  assert.equal(await fs.readFile(store.authPath, 'utf8'), f.auth);
  assert.equal((await store.status()).writeBlocked, false);
  await store.select('中转站甲', 'proxy');
});

test('pending transaction or malformed config blocks writes without overriding manual recovery', async t => {
  const f = await fixture(t);
  await fs.mkdir(f.store.runtimeDir);
  await fs.writeFile(f.store.journalPath, '{}');
  await assert.rejects(f.store.install('中转站甲'), /暂停/);
  assert.equal(await f.config(), f.original);
  await fs.unlink(f.store.journalPath);
  await fs.writeFile(f.store.configPath, 'broken = "');
  await assert.rejects(f.store.install('中转站甲'), /TOML/);
  assert.equal(await f.config(), 'broken = "');
});

test('concurrent additions do not lose keys; invalid credentials never reach HTTP headers', async t => {
  const f = await fixture(t);
  await Promise.all(Array.from({ length: 6 }, (_, i) => f.store.add({ name: 'new-' + i, value: 'sk-new-' + i, baseurl: 'https://new.example' })));
  assert.equal((await f.store.keys()).config.keys.length, 8);
  await assert.rejects(f.store.add({ name: 'bad', value: 'sk-test\r\nInjected:x', baseurl: 'https://new.example' }), /API Key/);
  await f.store.add({ name: 'self', value: 'sk-self', baseurl: f.store.proxyUrl });
  await assert.rejects(f.store.install('self'), /自身/);
  await f.store.select('中转站甲', 'proxy');
  const { config } = await f.store.keys();
  config.keys = config.keys.filter(key => key.name !== '中转站甲');
  await fs.writeFile(f.store.keysPath, JSON.stringify(config));
  await assert.rejects(f.store.activeEntry(), /不存在/);
});

async function upstream(t, handler) {
  const server = http.createServer(handler);
  const sockets = new Set();
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

async function post(app, endpoint, data = {}) {
  const response = await fetch(app.uiUrl + endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });
  const json = await response.json();
  assert.equal(response.status, 200, JSON.stringify(json));
  return json;
}

async function editPayload(store, name, changes = {}) {
  const entry = (await store.status()).keys.find(entry => entry.name === name);
  return { originalName: name, name: entry.name, baseurl: entry.baseurl, revision: entry.revision, value: '', ...changes };
}

test('editing renames a pinned route without losing metadata, base order, selection or credentials', async t => {
  const f = await fixture(t);
  const raw = JSON.parse(await fs.readFile(f.store.keysPath, 'utf8'));
  raw.keys[0].note = 'keep entry metadata';
  await fs.writeFile(f.store.keysPath, JSON.stringify(raw));
  const app = await start({ home: f.home, proxyPort: 0, uiPort: 0, log: () => {} });
  f.onCleanup(() => app.close());
  await app.store.install('中转站甲');
  await app.store.reorder(['备用线路✨', '中转站甲']);
  await app.store.pin('中转站甲', true);
  const configBefore = await f.config();
  const saved = await post(app, '/api/keys/edit', await editPayload(app.store, '中转站甲', { name: '团队 "A" <新>' }));
  assert.equal(saved.status.selectedProxyName, '团队 "A" <新>');
  assert.equal(saved.status.keys[0].pinned, true);
  assert.equal(saved.status.keys[0].active, true);
  assert.equal(JSON.stringify(saved).includes('sk-test-a'), false);
  const keys = JSON.parse(await fs.readFile(f.store.keysPath, 'utf8'));
  assert.equal(keys.target_file, 'auth.json');
  assert.equal(keys.keys[0].note, 'keep entry metadata');
  assert.equal(keys.keys[0].value, 'sk-test-a');
  assert.deepEqual(keys.keys[1], raw.keys[1]);
  const state = JSON.parse(await fs.readFile(f.store.statePath, 'utf8'));
  assert.deepEqual(state.order, ['备用线路✨', '团队 "A" <新>']);
  assert.deepEqual(state.pinned, ['团队 "A" <新>']);
  assert.equal((await app.store.activeEntry()).name, '团队 "A" <新>');
  await app.store.pin('团队 "A" <新>', false);
  assert.deepEqual((await app.status()).keys.map(entry => entry.name), state.order);
  assert.equal(await f.config(), configBefore);
  assert.equal(await fs.readFile(f.store.authPath, 'utf8'), f.auth);
  assert.equal((await fs.stat(f.store.keysPath)).mode & 0o777, 0o600);
});

test('editing direct route credentials updates the catalog until explicitly applied', async t => {
  const f = await fixture(t);
  const payload = await editPayload(f.store, '中转站甲', { baseurl: 'https://new.example/v1', value: 'sk-replaced-secret' });
  const result = await f.store.edit('中转站甲', payload);
  assert.match(result.message, /切换/);
  assert.equal(await f.config(), f.original);
  assert.equal(await fs.readFile(f.store.authPath, 'utf8'), f.auth);
  assert.equal((await f.store.entry('中转站甲')).value, 'sk-replaced-secret');
  const state = await f.store.status();
  assert.equal(state.activeName, null);
  assert.equal(JSON.stringify(state).includes('sk-replaced-secret'), false);
  await f.store.select('中转站甲', 'direct');
  assert.equal(inspectConfig(await f.config()).baseUrl, 'https://new.example/v1');
  assert.equal(JSON.parse(await fs.readFile(f.store.authPath)).OPENAI_API_KEY, 'sk-replaced-secret');
});

test('edit rejects duplicate, invalid and stale changes without overwriting saved data', async t => {
  const f = await fixture(t);
  const app = await start({ home: f.home, proxyPort: 0, uiPort: 0, log: () => {} });
  f.onCleanup(() => app.close());
  const before = await fs.readFile(f.store.keysPath, 'utf8');
  const original = await editPayload(app.store, '中转站甲');
  const requestEdit = payload => fetch(app.uiUrl + '/api/keys/edit', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  for (const [changes, status] of [
    [{ name: '备用线路✨' }, 409], [{ name: '' }, 400], [{ value: 'sk-key\r\ninjected' }, 400],
    [{ value: '   ' }, 400], [{ baseurl: 'file:///tmp/test' }, 400], [{ baseurl: app.proxyUrl }, 400],
    [{ revision: 'outdated' }, 409], [{ originalName: 'missing' }, 409],
  ]) assert.equal((await requestEdit({ ...original, ...changes })).status, status);
  assert.equal(await fs.readFile(f.store.keysPath, 'utf8'), before);
  await post(app, '/api/keys/edit', { ...original, value: 'sk-new-secret' });
  const after = await fs.readFile(f.store.keysPath, 'utf8');
  assert.equal((await requestEdit({ ...original, name: 'stale rename' })).status, 409);
  assert.equal(await fs.readFile(f.store.keysPath, 'utf8'), after);
  assert.equal(await f.config(), f.original);
});

test('rename failure rolls the catalog back together with selection and ordering', async t => {
  const f = await fixture(t);
  await f.store.select('中转站甲', 'proxy');
  await f.store.reorder(['备用线路✨', '中转站甲']);
  await f.store.pin('中转站甲', true);
  const before = await fs.readFile(f.store.keysPath, 'utf8');
  const stateBefore = await fs.readFile(f.store.statePath, 'utf8');
  const failing = new ConfigStore(f.home, f.store.proxyUrl, async (file, text) => {
    if (file === f.store.statePath) throw new Error('disk failure');
    await atomicWrite(file, text);
  });
  await assert.rejects(failing.edit('中转站甲', await editPayload(failing, '中转站甲', { name: 'rename' })), /回滚/);
  assert.equal(await fs.readFile(f.store.keysPath, 'utf8'), before);
  assert.equal(await fs.readFile(f.store.statePath, 'utf8'), stateBefore);
  assert.equal((await f.store.activeEntry()).name, '中转站甲');
  assert.equal((await f.store.status()).writeBlocked, false);
});

test('editing an active proxy route changes new requests while an existing SSE keeps its upstream', async t => {
  let release;
  const a = await upstream(t, (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer sk-test-a');
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: original\n\n');
    release = () => res.end('data: finished-original\n\n');
  });
  const b = await upstream(t, (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer sk-updated');
    assert.equal(req.url, '/new/responses');
    res.end('updated-response');
  });
  const f = await fixture(t, a.url + '/v1');
  const app = await start({ home: f.home, proxyPort: 0, uiPort: 0, log: () => {} });
  f.onCleanup(() => app.close());
  await app.store.install('中转站甲');
  const configBefore = await f.config();
  const response = await fetch(app.proxyUrl + '/responses');
  const reader = response.body.getReader();
  assert.equal(new TextDecoder().decode((await reader.read()).value), 'data: original\n\n');
  const result = await post(app, '/api/keys/edit', await editPayload(app.store, '中转站甲', { name: '已编辑', value: 'sk-updated', baseurl: b.url + '/new' }));
  assert.match(result.message, /无需重启/);
  assert.equal(await (await fetch(app.proxyUrl + '/responses')).text(), 'updated-response');
  release();
  assert.equal(new TextDecoder().decode((await reader.read()).value), 'data: finished-original\n\n');
  assert.equal((await reader.read()).done, true);
  assert.equal(await f.config(), configBefore);
  assert.equal(await fs.readFile(f.store.authPath, 'utf8'), f.auth);
});

test('connection diagnostics survive page refresh and remain separate from model request logs', async t => {
  const target = await upstream(t, (req, res) => {
    assert.equal(req.url, '/v1/models');
    res.setHeader('content-type', 'application/json');
    res.end('{"data":[]}');
  });
  const f = await fixture(t, target.url + '/v1');
  const app = await start({ home: f.home, proxyPort: 0, uiPort: 0, log: () => {} });
  f.onCleanup(() => app.close());
  const result = await post(app, '/api/network/test', { name: '中转站甲' });
  assert.equal(result.diagnostic.status, 200);
  const status = await app.status();
  assert.deepEqual(status.lastDiagnostic, result.diagnostic);
  assert.equal(status.lastRequest, null);
  const logs = await (await fetch(app.uiUrl + '/api/diagnostics')).json();
  assert.equal(logs.events[0].event, 'relay_diagnostic');
  assert.equal(logs.events[0].status, 200);
  assert.equal(JSON.stringify(logs).includes('sk-test-a'), false);
  assert.equal(await f.config(), f.original);
});

test('Chinese/emoji routes survive real HTTP responses; switch auth/path and keep SSE in flight', async t => {
  let releaseStream;
  const a = await upstream(t, (req, res) => {
    if (req.url === '/v1/stream') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: first\n\n');
      releaseStream = () => res.end('data: last\n\n');
      return;
    }
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => res.end(JSON.stringify({ url: req.url, auth: req.headers.authorization, body: Buffer.concat(chunks).toString() })));
  });
  const b = await upstream(t, (req, res) => res.end(JSON.stringify({ url: req.url, auth: req.headers.authorization })));
  const f = await fixture(t, a.url + '/v1', b.url + '/codex/v1');
  const app = await start({ home: f.home, proxyPort: 0, uiPort: 0, log: () => {} });
  f.onCleanup(() => app.close());
  await post(app, '/api/proxy/install', { name: '中转站甲' });
  const response = await fetch(app.proxyUrl + '/responses?test=1', { method: 'POST', headers: { authorization: 'Bearer old-client-key' }, body: 'request-body' });
  assert.equal(response.status, 200);
  assert.equal(decodeURIComponent(response.headers.get('x-relay-ui-provider')), '中转站甲');
  assert.deepEqual(await response.json(), { url: '/v1/responses?test=1', auth: 'Bearer sk-test-a', body: 'request-body' });
  const stream = await fetch(app.proxyUrl + '/stream');
  const reader = stream.body.getReader();
  assert.equal(new TextDecoder().decode((await reader.read()).value), 'data: first\n\n');
  await post(app, '/api/select', { name: '备用线路✨', mode: 'proxy' });
  const second = await fetch(app.proxyUrl + '/responses');
  assert.equal(decodeURIComponent(second.headers.get('x-relay-ui-provider')), '备用线路✨');
  assert.deepEqual(await second.json(), { url: '/codex/v1/responses', auth: 'Bearer sk-test-b' });
  releaseStream();
  assert.equal(new TextDecoder().decode((await reader.read()).value), 'data: last\n\n');
  await reader.read();
  assert.equal((await (await fetch(app.uiUrl + '/api/status')).json()).mode, 'proxy');
  await post(app, '/api/proxy/restore');
  assert.equal(await f.config(), f.original);
});

test('bad/disconnected upstream and request timeout cannot take down either local server', async t => {
  const target = await upstream(t, (req, res) => {
    if (req.url === '/v1/reset') req.socket.destroy();
    else if (req.url === '/v1/truncated') { res.writeHead(200, { 'content-length': '1000' }); res.write('partial'); setImmediate(() => res.destroy()); }
    else if (req.url === '/v1/wait') { /* Keep silent until proxy times out. */ }
    else res.end('healthy');
  });
  const f = await fixture(t, target.url + '/v1');
  const app = await start({ home: f.home, proxyPort: 0, uiPort: 0, timeoutMs: 100, log: () => {} });
  f.onCleanup(() => app.close());
  await post(app, '/api/proxy/install', { name: '中转站甲' });
  for (const suffix of ['/reset', '/wait']) assert.equal((await fetch(app.proxyUrl + suffix)).status, 502);
  await fetch(app.proxyUrl + '/truncated').then(r => r.text()).catch(() => {});
  assert.equal(await (await fetch(app.proxyUrl + '/ok')).text(), 'healthy');
  assert.equal((await fetch(app.uiUrl + '/api/status')).status, 200);
});

test('gzip bytes and content length pass through unchanged', async t => {
  const bytes = gzipSync('data: compressed\n\n');
  const target = await upstream(t, (req, res) => {
    assert.equal(req.headers['content-encoding'], 'gzip');
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      assert.deepEqual(Buffer.concat(chunks), bytes);
      res.writeHead(200, { 'content-encoding': 'gzip', 'content-length': String(bytes.length) });
      res.end(bytes);
    });
  });
  const f = await fixture(t, target.url + '/v1');
  const app = await start({ home: f.home, proxyPort: 0, uiPort: 0, log: () => {} });
  f.onCleanup(() => app.close());
  await post(app, '/api/proxy/install', { name: '中转站甲' });
  await new Promise((resolve, reject) => {
    const req = http.request(app.proxyUrl + '/responses', { method: 'POST', headers: { 'content-encoding': 'gzip', 'content-length': bytes.length } }, res => {
      const chunks = []; res.on('data', c => chunks.push(c));
      res.on('end', () => { try { assert.deepEqual(Buffer.concat(chunks), bytes); resolve(); } catch (err) { reject(err); } });
    });
    req.on('error', reject); req.end(bytes);
  });
});

test('occupied UI port releases the proxy port, instead of leaving a half-started service', async t => {
  const occupied = await upstream(t, (req, res) => res.end());
  const probe = await upstream(t, (req, res) => res.end());
  const port = probe.server.address().port;
  await new Promise(resolve => probe.server.close(resolve));
  const f = await fixture(t);
  await assert.rejects(start({ home: f.home, proxyPort: port, uiPort: occupied.server.address().port }), { code: 'EADDRINUSE' });
  const bind = net.createServer();
  await new Promise((resolve, reject) => { bind.once('error', reject); bind.listen(port, '127.0.0.1', resolve); });
  await new Promise(resolve => bind.close(resolve));
});

test('WebSocket upgrade retains provider auth and forwards both directions', async t => {
  const target = await upstream(t, (req, res) => res.end());
  target.server.on('upgrade', (req, socket) => {
    assert.equal(req.headers.authorization, 'Bearer sk-test-a');
    assert.equal(req.url, '/v1/responses');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
    socket.on('data', data => socket.write(data));
  });
  const f = await fixture(t, target.url + '/v1');
  const app = await start({ home: f.home, proxyPort: 0, uiPort: 0, log: () => {} });
  f.onCleanup(() => app.close());
  await post(app, '/api/proxy/install', { name: '中转站甲' });
  const client = net.connect(Number(new URL(app.proxyUrl).port), '127.0.0.1');
  await once(client, 'connect');
  client.write('GET /v1/responses HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
  const [handshake] = await once(client, 'data');
  assert.match(handshake.toString(), /101 Switching/);
  client.write('frame-bytes');
  const [echo] = await once(client, 'data');
  assert.equal(echo.toString(), 'frame-bytes');
  client.destroy();
});
