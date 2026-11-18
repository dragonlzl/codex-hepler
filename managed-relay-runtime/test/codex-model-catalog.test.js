const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const { ConfigStore, inspectConfig, patchBase, patchCatalog } = require('../config-store');
const { CodexModelCatalog, buildCatalog, catalogUrl, routeKey } = require('../codex-model-catalog');
const metadata = require('../assets/codex-models.json').models;
const { start } = require('../../managed-relay-server');

const direct = () => ({ localPorts: new Set(), resolve: async () => ({ proxyUrl: '', label: 'DIRECT' }), agent: () => false, status: async () => ({}), close() {} });
const slugs = result => result.models.map(model => model.slug);
const deferred = () => Promise.withResolvers();

async function fixture(t, options = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'codextool-models-'));
  const calls = [];
  let handler = (req, res) => {
    const ids = req.url.startsWith('/b/') ? ['gpt-6.1-sol'] : ['gpt-6.2-sol', 'gpt-6.2-astra', 'gpt-image-2.6', 'claude-sonnet-5'];
    res.end(JSON.stringify({ data: ids.map(id => ({ id })) }));
  };
  const upstream = http.createServer((req, res) => {
    calls.push({ url: req.url, auth: req.headers.authorization, ua: req.headers['user-agent'] });
    handler(req, res);
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + upstream.address().port;
  const keys = [{ name: 'A', baseurl: origin + '/a/v1', value: 'fake-key-a' }, { name: 'B', baseurl: origin + '/b/v1', value: 'fake-key-b' }];
  const original = `# keep comments\nmodel_provider="relay"\nmodel="gpt-6.1-sol"\n[model_providers.relay]\nname="Relay"\nbase_url='${keys[0].baseurl}' # URL comment\nwire_api="responses"\nrequires_openai_auth=true\n[projects."/keep"]\ntrust_level="trusted"\n`;
  await fs.writeFile(path.join(home, 'config.toml'), original);
  await fs.writeFile(path.join(home, 'auth.json'), '{"OPENAI_API_KEY":"fake-key-a"}\n');
  await fs.writeFile(path.join(home, 'key_config.json'), JSON.stringify({ keys }));
  const app = await start({ home, proxyPort: 0, uiPort: 0, outbound: direct(), monitoringEnabled: false, log() {}, ...options });
  t.after(async () => {
    await app.close();
    upstream.closeAllConnections();
    await new Promise(resolve => upstream.close(resolve));
    await fs.rm(home, { recursive: true, force: true });
  });
  return { home, app, store: app.store, original, calls, keys, setHandler(value) { handler = value; },
    config: () => fs.readFile(path.join(home, 'config.toml'), 'utf8'),
    async sync(headers = {}) {
      const response = await fetch(app.uiUrl + '/api/models/sync', { method: 'POST', headers: { 'content-type': 'application/json', origin: app.uiUrl, ...headers }, body: '{}' });
      return { response, body: await response.json() };
    } };
}

test('catalog intersects exact upstream IDs with official model-specific metadata', () => {
  const payload = { data: ['gpt-6.2-sol', 'gpt-6.2-astra', 'gpt-image-2.6', 'gpt-99-sol', 'claude-sonnet-5', 'gpt-6.2-sol'].map(id => ({ id })) };
  const catalog = buildCatalog(payload, metadata);
  assert.deepEqual(slugs(catalog), ['gpt-6.2-sol', 'gpt-6.2-astra']);
  assert.deepEqual(catalog.models[0], metadata.find(model => model.slug === 'gpt-6.2-sol'));
  assert.equal(catalog.models[0].context_window, 500000);
  assert.ok(catalog.models[0].supported_reasoning_levels.some(level => level.effort === 'ultra'));
  assert.throws(() => buildCatalog({ data: [] }, metadata), /未列出/);
  assert.throws(() => buildCatalog({ error: 'bad' }, metadata), /格式无效/);
  assert.deepEqual(slugs(buildCatalog({ models: [{ slug: 'gpt-6.2-sol' }] }, metadata)), ['gpt-6.2-sol']);
});

test('catalog TOML patch supports quoted IDs, dotted keys, inline providers, profiles and CRLF', () => {
  for (const text of [
    'model_provider="a.b"\n[model_providers."a.b"]\nbase_url="https://example.invalid/v1" # keep\nname="keep"\n',
    'model_provider="a.b"\nmodel_providers."a.b".base_url="https://example.invalid/v1"',
    'model_provider="a.b"\n[model_providers]\n"a.b".base_url="https://example.invalid/v1"\n',
    'model_provider="a.b"\nmodel_providers={"a.b"={base_url="https://example.invalid/v1",name="keep"}}\n',
    'profile="work"\n[profiles.work]\nmodel_provider="a.b"\n[model_providers."a.b"]\nbase_url="https://example.invalid/v1"\n',
    'model_provider="a.b"\r\n[model_providers."a.b"]\r\nbase_url="https://example.invalid/v1" # keep\r\n',
  ]) {
    const applied = patchCatalog(inspectConfig(text), 'http://127.0.0.1:3211/v1/codex/models');
    assert.equal(inspectConfig(applied).provider.model_catalog_url, 'http://127.0.0.1:3211/v1/codex/models');
    assert.equal(inspectConfig(applied).baseUrl, 'https://example.invalid/v1');
    assert.equal(inspectConfig(patchCatalog(inspectConfig(applied), null)).provider.model_catalog_url, undefined);
    if (text.includes('# keep')) assert.ok(applied.includes('# keep'));
  }
});

test('install and partial restore manage the catalog while preserving auth and unrelated edits', async t => {
  const f = await fixture(t);
  const auth = await fs.readFile(f.store.authPath, 'utf8');
  await f.store.install('A');
  assert.equal(inspectConfig(await f.config()).provider.model_catalog_url, catalogUrl(f.app.proxyUrl));
  assert.equal((await f.store.status()).modelCatalog.enabled, true);
  await fs.appendFile(f.store.configPath, '# external edit\n');
  await f.store.restore();
  const restored = inspectConfig(await f.config());
  assert.equal(restored.baseUrl, f.keys[0].baseurl);
  assert.equal(restored.provider.model_catalog_url, undefined);
  assert.ok((await f.config()).includes('# external edit'));
  assert.equal(await fs.readFile(f.store.authPath, 'utf8'), auth);
  await f.store.install('A');
  assert.equal(inspectConfig(patchBase(inspectConfig(await f.config()), 'http://127.0.0.1:4321/v1', undefined, true)).provider.model_catalog_url, 'http://127.0.0.1:4321/v1/codex/models');
});

test('existing installations upgrade their restoration record and still restore exact original bytes', async t => {
  const f = await fixture(t);
  const applied = patchBase(inspectConfig(f.original), f.app.proxyUrl);
  await fs.writeFile(f.store.configPath, applied);
  await fs.writeFile(f.store.statePath, JSON.stringify({ activeName: 'A' }));
  await fs.mkdir(f.store.runtimeDir, { recursive: true });
  await fs.writeFile(f.store.sessionPath, JSON.stringify({ version: 1, providerId: 'relay', baseUrl: f.keys[0].baseurl,
    rawBaseValue: `'${f.keys[0].baseurl}'`, configBefore: f.original, configApplied: applied }));
  const { response, body } = await f.sync();
  assert.equal(response.status, 200);
  assert.equal(body.restartRequired, true);
  assert.deepEqual(body.models, ['gpt-6.2-sol', 'gpt-6.2-astra']);
  assert.equal((await f.sync()).body.restartRequired, false);
  await f.store.restore();
  assert.equal(await f.config(), f.original);
});

test('custom local and provider catalogs are preserved and do not trigger upstream requests', async t => {
  const f = await fixture(t);
  for (const text of [
    'model_catalog_json="/user/catalog.json"\n' + f.original,
    f.original + '\n[profiles.work]\nmodel_provider="relay"\nmodel_catalog_json="/profile/catalog.json"\n',
    f.original.replace('name="Relay"', 'name="Relay"\nmodel_catalog_url="https://catalog.example/models"'),
    f.original + '\n[features]\napi_key_model_discovery=false\n',
  ]) {
    const config = text.includes('[profiles.work]') ? 'profile="work"\n' + text : text;
    await fs.writeFile(f.store.configPath, config);
    await f.store.install('A');
    assert.equal((await f.store.status()).modelCatalog.available, false);
    const before = await f.config();
    assert.equal((await f.sync()).response.status, 409);
    assert.equal(await f.config(), before);
    assert.equal(f.calls.length, 0);
    await f.store.restore();
    assert.equal(await f.config(), config);
  }
});

test('native catalog endpoint follows route changes and leaves ordinary models forwarding intact', async t => {
  const f = await fixture(t);
  await f.store.install('A');
  const endpoint = catalogUrl(f.app.proxyUrl);
  const first = await (await fetch(endpoint + '?client_version=0.169.0')).json();
  assert.deepEqual(slugs(first), ['gpt-6.2-sol', 'gpt-6.2-astra']);
  assert.equal(f.calls[0].url, '/a/v1/models');
  assert.equal(f.calls[0].ua, 'CodexTool/1.0');
  assert.equal(f.calls[0].auth, 'Bearer fake-key-a');
  const raw = await (await fetch(f.app.proxyUrl + '/models')).json();
  assert.ok(raw.data.some(model => model.id === 'gpt-image-2.6'));
  await f.store.select('B', 'proxy');
  assert.deepEqual(slugs(await (await fetch(endpoint)).json()), ['gpt-6.1-sol']);
  assert.equal(f.calls.at(-1).auth, 'Bearer fake-key-b');
  assert.equal((await fetch(endpoint, { method: 'POST' })).status, 405);
  const status = JSON.stringify(await f.app.status());
  assert.ok(!status.includes('fake-key-a') && !status.includes('fake-key-b'));
});

test('cache coalesces concurrent fetches, expires, and separates credentials on the same URL', async t => {
  const f = await fixture(t);
  let now = 0, entry = f.keys[0];
  const catalog = new CodexModelCatalog(f.home, { activeEntry: async () => entry }, direct(), { clock: () => now, cacheMs: 60 });
  t.after(() => catalog.close());
  await Promise.all([catalog.snapshot(), catalog.snapshot(), catalog.snapshot()]);
  assert.equal(f.calls.length, 1);
  now = 61;
  await catalog.snapshot();
  assert.equal(f.calls.length, 2);
  entry = { ...entry, value: 'another-key' };
  await catalog.snapshot();
  assert.equal(f.calls.length, 3);
  assert.equal(f.calls.at(-1).auth, 'Bearer another-key');
  assert.ok(!JSON.stringify([...catalog.cache.keys()]).includes('another-key'));
});

test('a route changed during fetching cannot publish or enable the old route catalog', async t => {
  const f = await fixture(t);
  await f.store.install('A');
  const arrived = deferred(), release = deferred();
  f.setHandler(async (req, res) => { arrived.resolve(); await release.promise; res.end('{"data":[{"id":"gpt-6.2-sol"}]}'); });
  const result = f.sync();
  await arrived.promise;
  await f.store.select('B', 'proxy');
  release.resolve();
  assert.equal((await result).response.status, 409);
  await assert.rejects(f.store.enableModelCatalog(routeKey(f.keys[0])), /已切换/);
});

test('malformed, rejected, oversized and timed-out lists leave configuration unchanged and errors redact bodies', async t => {
  const f = await fixture(t, { catalogOptions: { timeoutMs: 100, maxBytes: 200 } });
  await f.store.install('A');
  const before = await f.config();
  for (const handler of [
    (req, res) => { res.writeHead(403); res.end('secret-upstream-body'); },
    (req, res) => res.end('bad json secret-upstream-body'),
    (req, res) => res.end('{"data":[]}'),
    (req, res) => res.end('x'.repeat(201)),
    () => {},
    (req, res) => { res.writeHead(302, { location: 'http://untrusted.invalid' }); res.end(); },
  ]) {
    f.setHandler(handler);
    const { response, body } = await f.sync();
    assert.ok(response.status >= 400);
    assert.ok(!JSON.stringify(body).includes('secret-upstream-body'));
    assert.equal(await f.config(), before);
  }
});

test('synchronization requires the local UI origin and an installed third-party proxy', async t => {
  const f = await fixture(t);
  assert.equal((await f.sync()).response.status, 409);
  await f.store.install('A');
  assert.equal((await f.sync({ origin: 'https://untrusted.invalid' })).response.status, 403);
  assert.equal(f.calls.length, 0);
});

test('closing the catalog cancels an in-flight request and prevents cache publication', async t => {
  const f = await fixture(t);
  const arrived = deferred();
  f.setHandler(() => arrived.resolve());
  const catalog = new CodexModelCatalog(f.home, { activeEntry: async () => f.keys[0] }, direct());
  const pending = catalog.snapshot();
  await arrived.promise;
  catalog.close();
  await assert.rejects(pending, /取消|中断/);
  assert.equal(catalog.cache.size, 0);
  assert.equal(catalog.controllers.size, 0);
});

test('installed Codex model/list reads 6.2 and its reasoning options from the relay catalog', {
  skip: !process.env.CODEX_MODEL_CATALOG_TEST_BIN, timeout: 20000,
}, async t => {
  const f = await fixture(t);
  await f.store.install('A');
  const child = spawn(process.env.CODEX_MODEL_CATALOG_TEST_BIN, ['app-server'], {
    cwd: f.home, env: { ...process.env, CODEX_HOME: f.home, NO_PROXY: '127.0.0.1,localhost,::1', no_proxy: '127.0.0.1,localhost,::1' },
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  const output = createInterface({ input: child.stdout });
  t.after(() => { output.close(); child.kill('SIGKILL'); });
  const result = deferred();
  const send = message => child.stdin.write(JSON.stringify(message) + '\n');
  output.on('line', line => {
    const message = JSON.parse(line);
    if (message.id === 1) {
      if (message.error) { result.reject(new Error(JSON.stringify(message.error))); return; }
      send({ method: 'initialized', params: {} });
      send({ id: 2, method: 'model/list', params: { includeHidden: true } });
    }
    if (message.id === 2) message.error ? result.reject(new Error(JSON.stringify(message.error))) : result.resolve(message.result.data);
  });
  child.once('error', result.reject);
  child.once('exit', () => result.reject(new Error('Codex exited before returning the model list')));
  send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'codextool_catalog_tests', version: '1.0.0' } } });
  const models = await result.promise;
  assert.deepEqual(models.filter(model => !model.hidden).map(model => model.model), ['gpt-6.2-sol', 'gpt-6.2-astra']);
  assert.ok(models.find(model => model.model === 'gpt-6.2-sol').supportedReasoningEfforts.some(level => level.reasoningEffort === 'max'));
  assert.equal(f.calls.length, 1);
});
