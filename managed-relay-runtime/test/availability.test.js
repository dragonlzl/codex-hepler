const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const { PassThrough } = require('node:stream');
const { EventEmitter } = require('node:events');
const { Availability, MODELS, REFRESH_MS, adapterFor, readInputStatus, requestJson } = require('../availability');
const { start } = require('../../managed-relay-server');

const NOW = 1789551000000;
const keys = [
  { name: 'INPUT', baseurl: 'https://ai.input.im', value: 'sk-private' },
  { name: 'INPUT backup', baseurl: 'https://ai.input.im/v1', value: 'sk-private-backup' },
  { name: 'Other', baseurl: 'https://other.example/v1', value: 'sk-other' },
];
function payload(now = NOW) {
  return { services: MODELS.map((model, index) => {
    const history = Array.from({ length: 60 }, (_, i) => ({ ts: now / 1000 - (59 - i) * 60, ok: index === 0 || i % 2 === 0, latency_ms: 123, error: null }));
    return { model, history, last: history.at(-1) };
  }) };
}

test('adapter matches exact registered hosts independent of route name and path', () => {
  assert.equal(adapterFor('https://AI.INPUT.IM/v1/').id, 'input');
  assert.equal(adapterFor('http://ai.input.im').id, 'input');
  for (const url of ['https://ai.input.im.evil.example', 'https://other.example/ai.input.im', 'https://evil@ai.input.im', 'https://ai.input.im:8443', 'file://ai.input.im', 'invalid']) {
    assert.equal(adapterFor(url), null);
  }
});

test('normalizes model IDs, chronological samples and the most recent 60 only', () => {
  const data = payload();
  data.services[0].history.reverse();
  data.services[0].history.push({ ts: NOW / 1000 - 6000, ok: false });
  data.services.push({ model: 'gpt-6-astra-alias', history: 'not relevant' });
  const models = readInputStatus(data);
  assert.deepEqual(Object.keys(models), MODELS);
  assert.equal(models['gpt-6-astra'].history.length, 60);
  assert.equal(models['gpt-6-astra'].uptimePct, 100);
  assert.equal(models['gpt-5.6-sol'].uptimePct, 50);
  assert.equal(models['gpt-6-astra'].last.at, NOW);
  assert.equal(models['gpt-6-astra'].last.latencyMs, 123);
  assert.ok(models['gpt-6-astra'].history[0].at < models['gpt-6-astra'].history.at(-1).at);
  assert.throws(() => readInputStatus({ services: [{ model: MODELS[0], history: [{ ts: 123, ok: 'false' }] }] }));
  assert.throws(() => readInputStatus({}));
});

test('deduplicates concurrent requests, duplicate relay accounts and both model selections for 15 seconds', async () => {
  let now = NOW;
  let calls = 0;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const monitor = new Availability({}, { clock: () => now, request: async (url, options) => {
    calls++;
    assert.equal(url, 'https://status.input.im/api/status');
    assert.deepEqual(Object.keys(options).sort(), ['outbound', 'signal']);
    await gate;
    return payload(now);
  } });
  const first = monitor.snapshot(keys);
  const second = monitor.snapshot(keys, 'gpt-5.6-sol');
  release();
  const [astra, sol] = await Promise.all([first, second]);
  assert.equal(calls, 1);
  assert.equal(astra.model, 'gpt-6-astra');
  assert.equal(astra.rows[0].state, 'available');
  assert.equal(sol.rows[0].state, 'unavailable');
  assert.deepEqual(astra.rows[0].history, astra.rows[1].history);
  assert.equal(astra.rows[2].state, 'unsupported');
  assert.ok(!JSON.stringify(astra).includes('sk-private'));
  now += REFRESH_MS - 1;
  await monitor.snapshot(keys);
  assert.equal(calls, 1);
  now++;
  await monitor.snapshot(keys);
  assert.equal(calls, 2);
  monitor.close();
});

test('missing models stay unknown and do not borrow another model history', async () => {
  const data = payload();
  data.services = data.services.slice(1);
  const monitor = new Availability({}, { clock: () => NOW, request: async () => data });
  const row = (await monitor.snapshot(keys)).rows[0];
  assert.equal(row.state, 'no-data');
  assert.deepEqual(row.history, []);
  assert.equal(row.uptimePct, null);
  assert.equal((await monitor.snapshot(keys, MODELS[1])).rows[0].history.length, 60);
  await assert.rejects(monitor.snapshot(keys, 'gpt-6-astra-alias'), error => error.status === 400);
  monitor.close();
});

test('failures retain historical samples but mark them stale, then recover', async () => {
  let now = NOW;
  let fail = false;
  const monitor = new Availability({}, { clock: () => now, request: async () => {
    if (fail) throw new Error('token=should-not-leak');
    return payload(now);
  } });
  await monitor.snapshot(keys);
  fail = true;
  now += REFRESH_MS;
  const stale = (await monitor.snapshot(keys)).rows[0];
  assert.equal(stale.state, 'stale');
  assert.equal(stale.fetchedAt, NOW);
  assert.equal(stale.history.length, 60);
  assert.ok(!JSON.stringify(stale).includes('should-not-leak'));
  fail = false;
  now += REFRESH_MS;
  assert.equal((await monitor.snapshot(keys)).rows[0].state, 'available');
  monitor.close();
});

test('cold failures and malformed responses do not become red model samples', async () => {
  const monitor = new Availability({}, { request: async () => ({ services: 'invalid' }) });
  const row = (await monitor.snapshot(keys)).rows[0];
  assert.equal(row.state, 'error');
  assert.deepEqual(row.history, []);
  assert.equal(row.uptimePct, null);
  assert.equal(row.failure.code, 'INVALID_RESPONSE');
  monitor.close();
});

test('refresh failures expose classified causes, record safe diagnostics and clear them on recovery', async () => {
  let now = NOW, failure = Object.assign(new Error('private-key'), { code: 'ECONNRESET' });
  const events = [];
  const monitor = new Availability({}, { clock: () => now, record: event => events.push(event), request: async () => {
    if (failure) throw failure;
    return payload(now);
  } });
  try {
    let row = (await monitor.snapshot(keys)).rows[0];
    assert.equal(row.failure.code, 'ECONNRESET'); assert.match(row.failure.message, /连接被重置/);
    assert.equal(events[0].event, 'availability_refresh_failed'); assert.equal(events[0].endpoint, 'status');
    assert.equal(JSON.stringify([row, events]).includes('private-key'), false);
    failure = Object.assign(new Error('private-token'), { status: 429 }); now += REFRESH_MS;
    row = (await monitor.snapshot(keys)).rows[0];
    assert.equal(row.failure.code, 'HTTP_429'); assert.match(row.failure.message, /频率受限/);
    failure = null; now += REFRESH_MS;
    row = (await monitor.snapshot(keys)).rows[0];
    assert.equal(row.state, 'available'); assert.equal(row.failure, undefined);
  } finally { await monitor.close(); }
});

test('synchronous transport errors can be retried after the cache expires', async () => {
  let now = NOW;
  let calls = 0;
  const monitor = new Availability({}, { clock: () => now, request: () => {
    if (++calls === 1) throw new Error('Synchronous failure');
    return payload(now);
  } });
  assert.equal((await monitor.snapshot(keys)).rows[0].state, 'error');
  now += REFRESH_MS;
  assert.equal((await monitor.snapshot(keys)).rows[0].state, 'available');
  assert.equal(calls, 2);
  monitor.close();
});

test('an old successful source sample is stale even when fetching succeeds', async () => {
  const monitor = new Availability({}, { clock: () => NOW + 181000, request: async () => payload() });
  assert.equal((await monitor.snapshot(keys)).rows[0].state, 'stale');
  monitor.close();
});

test('request timeout and service shutdown abort pending network work', async () => {
  let aborted = 0;
  const request = async (_url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => { aborted++; reject(signal.reason); }, { once: true });
  });
  const timed = new Availability({}, { request, timeoutMs: 20 });
  assert.equal((await timed.snapshot(keys)).rows[0].state, 'error');
  assert.equal(aborted, 1);
  timed.close();
  const closing = new Availability({}, { request });
  const pending = closing.snapshot(keys);
  closing.close();
  assert.equal((await pending).rows[0].state, 'error');
  assert.equal(aborted, 2);
});

test('unsupported sites never cause an outbound status request', async () => {
  const monitor = new Availability({}, { request: async () => { assert.fail('Unexpected network request'); } });
  assert.equal((await monitor.snapshot([keys[2]])).rows[0].state, 'unsupported');
  monitor.close();
});

test('HTTP reader sends no auth, refuses redirects and bounds malformed or oversized responses', async t => {
  let statusCode = 200;
  let contents = JSON.stringify(payload());
  let calls = 0;
  t.mock.method(https, 'get', (url, options) => {
    calls++;
    assert.equal(url, 'https://status.input.im/api/status');
    assert.deepEqual(options.headers, { accept: 'application/json', 'cache-control': 'no-cache' });
    const request = new EventEmitter();
    request.destroy = () => {};
    setImmediate(() => {
      const response = new PassThrough();
      response.statusCode = statusCode;
      request.emit('response', response);
      response.end(contents);
    });
    return request;
  });
  const options = { outbound: { resolve: async () => ({}), agent: () => false }, signal: new AbortController().signal };
  assert.equal((await requestJson('https://status.input.im/api/status', options)).services.length, 2);
  statusCode = 302;
  await assert.rejects(requestJson('https://status.input.im/api/status', options), /HTTP/);
  assert.equal(calls, 2);
  statusCode = 200;
  contents = '<html>invalid</html>';
  await assert.rejects(requestJson('https://status.input.im/api/status', options), SyntaxError);
  contents = 'x'.repeat(1024 * 1024 + 1);
  await assert.rejects(requestJson('https://status.input.im/api/status', options), /too large/);
});

test('the request deadline includes a stalled outbound route lookup', async () => {
  const controller = new AbortController();
  const pending = requestJson('https://status.input.im/api/status', {
    outbound: { resolve: () => new Promise(() => {}) }, signal: controller.signal,
  });
  controller.abort(new Error('Deadline reached'));
  await assert.rejects(pending, /Deadline/);
});

test('HTTP API validates models, returns no credentials and leaves Codex config unchanged', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-availability-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const files = {
    'config.toml': 'model_provider="relay"\nmodel="keep-current-model"\n[model_providers.relay]\nbase_url="https://ai.input.im"\n',
    'auth.json': '{"OPENAI_API_KEY":"sk-private"}',
    'key_config.json': JSON.stringify({ keys }),
  };
  for (const [file, contents] of Object.entries(files)) await fs.writeFile(path.join(home, file), contents);
  const app = await start({ home, proxyPort: 0, uiPort: 0, availabilityOptions: { clock: () => NOW, request: async () => payload() }, log: () => {} });
  t.after(() => app.close());
  const status = await (await fetch(app.uiUrl + '/api/status')).json();
  assert.equal(status.availabilityAvailable, true);
  const astra = await (await fetch(app.uiUrl + '/api/availability')).json();
  assert.equal(astra.rows[0].state, 'available');
  const sol = await (await fetch(app.uiUrl + '/api/availability?model=gpt-5.6-sol')).json();
  assert.equal(sol.rows[0].state, 'unavailable');
  assert.equal((await fetch(app.uiUrl + '/api/availability?model=unknown')).status, 400);
  assert.ok(!JSON.stringify(astra).includes('sk-private'));
  for (const [file, contents] of Object.entries(files)) assert.equal(await fs.readFile(path.join(home, file), 'utf8'), contents);
});
