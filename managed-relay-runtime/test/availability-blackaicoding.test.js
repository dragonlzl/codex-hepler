const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const https = require('node:https');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { readBlackaicodingStatus, ENDPOINT, MONITOR_URL } = require('../availability-blackaicoding');
const { MonitorAuth, validateToken } = require('../monitor-auth');
const { ENDPOINT: BALANCE_ENDPOINT } = require('../balance-blackaicoding');
const { Availability, MODELS, REFRESH_MS, adapterFor, requestJson } = require('../availability');
const { start } = require('../../managed-relay-server');
const NOW = Date.parse('2026-09-17T02:35:30Z');
const START = Date.parse('2026-09-17T01:10:00Z');
const keys = [{ name: 'code for me', baseurl: 'https://blackaicoding.com', value: 'sk-not-monitor-token' },
  { name: 'backup', baseurl: 'https://www.blackaicoding.com/v1', value: 'sk-not-monitor-token-2' },
  { name: 'input', baseurl: 'https://ai.input.im' }];
const jwt = exp => 'test.' + Buffer.from(JSON.stringify({ exp })).toString('base64url') + '.signature';
const TOKEN = jwt(Math.floor(Date.now() / 1000) + 86400);
function fixture() {
  const metrics = error_rate => ({ error_rate, success_rate: .01, cache_rate: .8, request_count: 0,
    ttft: { avg_ms: 30000 }, duration: { avg_ms: 60000 } });
  const row = (model, errorRate, group = 2, platform = 'openai') => ({ platform, group_id: group,
    group_name: group === 2 ? 'codex混合渠道--低价' : '纯pro渠道', model,
    metrics: metrics(errorRate), health: { overall: 'critical', score: 20 }, buckets: [
      { bucket_start: new Date(START).toISOString(), metrics: metrics(.1), health: { overall: 'healthy', score: 90 } },
      { bucket_start: new Date(START + 300000).toISOString(), metrics: metrics(.2), health: { overall: 'warning', score: 60 } },
      { bucket_start: new Date(START + 16 * 300000).toISOString(), metrics: metrics(errorRate), health: { overall: 'critical', score: 20 } },
    ] });
  return { code: 0, data: { group_by: 'platform_group_model', coverage: {
    requested_start: new Date(START).toISOString(), requested_end: new Date(START + 5400000).toISOString(),
    data_through: new Date(START + 17 * 300000).toISOString(), bucket_seconds: 300,
  }, items: [row('__other__', .4), row('gpt-5.6-sol', .3), row('gpt-6-astra', 0, 7), row('gpt-6-astra', 0, 2, 'anthropic')] } };
}

test('new monitor selects OpenAI group 2 exactly and labels other-model data as a reference', () => {
  const data = readBlackaicodingStatus(fixture(), MODELS);
  const astra = data[MODELS[0]], sol = data[MODELS[1]];
  assert.equal(astra.groupLabel, 'codex混合渠道--低价');
  assert.equal(astra.historyLength, 18);
  assert.equal(astra.history.length, 18);
  assert.equal(astra.sampleCount, 3);
  assert.equal(astra.uptimePct, 60);
  assert.equal(sol.uptimePct, 70);
  assert.equal(astra.sourceModelLabel, 'OpenAI · 其他模型（参考）');
  assert.match(astra.modelNote, /不能代表/);
  assert.equal(sol.sourceModelLabel, undefined);
  assert.deepEqual(astra.history.slice(0, 3).map(item => item.state), ['available', 'degraded', 'no-data']);
  assert.equal(astra.history.at(-1).state, 'no-data');
  assert.equal(astra.last.at, START + 17 * 300000);
  assert.equal(astra.metrics.ttftMs, 30000);
  assert.equal(astra.metrics.hideTps, true);
});

test('exact gpt6 beats other-model reference; sol never falls back; empty exact rows stay empty', () => {
  const value = fixture();
  const exact = structuredClone(value.data.items[1]); exact.model = MODELS[0]; exact.metrics.error_rate = .15;
  value.data.items.push(exact);
  let parsed = readBlackaicodingStatus(value, MODELS);
  assert.equal(parsed[MODELS[0]].uptimePct, 85);
  assert.equal(parsed[MODELS[0]].sourceModelLabel, undefined);
  exact.buckets = [];
  value.data.items = value.data.items.filter(row => row.model !== MODELS[1]);
  parsed = readBlackaicodingStatus(value, MODELS);
  assert.equal(parsed[MODELS[0]].last, null);
  assert.equal(parsed[MODELS[1]].last, null);
  assert.equal(parsed[MODELS[1]].sourceModelLabel, undefined);
});

test('compact view displays the same mixed-model reference and chart as full management', async () => {
  const source = await fs.readFile(path.join(__dirname, '../../managed-relay-public/availability.js'), 'utf8');
  const View = vm.runInNewContext(source + '\nRelayAvailability;', { Intl, Date,
    escapeHtml: value => String(value).replace(/[&<>"']/g, c => '&#' + c.charCodeAt(0) + ';') });
  const view = Object.assign(Object.create(View.prototype), { model: MODELS[0], error: '', simpleCharts: new Set(),
    getState: () => ({ home: 'fixture', keys }), paint: () => {} });
  const parsed = readBlackaicodingStatus(fixture(), MODELS)[MODELS[0]];
  const row = { ...parsed, state: 'unavailable', displayAt: NOW };
  assert.match(view.markup(row), /其他模型（参考）/);
  const summary = view.simpleStatusMarkup(row, keys[0].name);
  assert.match(summary, /其他模型参考：当前不可用/);
  assert.match(summary, /simple-status unavailable/);
  assert.match(summary, /点击查看检测图/);
  assert.match(summary, /不能代表 gpt6 独立可用性/);
  view.toggleSimpleChart(keys[0].name);
  const chart = view.simpleStatusMarkup(row, keys[0].name);
  assert.match(chart, /其他模型 · 参考/);
  assert.match(chart, /availability-bars/);
  assert.match(chart, /点击恢复文字展示/);
  assert.equal((chart.match(/class="availability-sample /g) || []).length, 18);
  assert.match(chart, /background:hsl\(24.0 72% 42%\)/);
  view.toggleSimpleChart(keys[0].name);
  assert.equal(view.simpleStatusMarkup(row, keys[0].name), summary);

  for (const [state, color] of [['available', 'available'], ['degraded', 'degraded']]) {
    const result = View.simpleStatus({ ...row, state, last: { at: NOW, state, ok: state === 'available' } }, NOW);
    assert.equal(result.color, color);
    assert.match(result.message, /^其他模型参考：当前可用/);
  }
  for (const state of ['auth-required', 'error', 'stale', 'no-data']) {
    const unavailable = { ...row, state };
    assert.equal(View.simpleStatus(unavailable, NOW).color, 'unknown');
    assert.doesNotMatch(view.simpleStatusMarkup(unavailable, keys[0].name), /<button/);
  }
  const exact = readBlackaicodingStatus(fixture(), MODELS)[MODELS[1]];
  assert.doesNotMatch(View.simpleStatus({ ...exact, state: 'unavailable' }, NOW).message, /参考/);
  const { health } = require('../auto-switch-policy');
  assert.equal(health(row, NOW).rank, null, 'reference data must still be excluded from automatic switching');
});

test('renamed groups, mismatched grouping and malformed coverage or data fail closed', () => {
  for (const mutate of [
    value => { value.code = 1; },
    value => { value.data.group_by = 'platform'; },
    value => { value.data.coverage.bucket_seconds = 0; },
    value => { value.data.coverage.requested_end = 'not a date'; },
    value => { value.data.items[0].group_name = 'another group'; },
    value => { value.data.items.push(value.data.items[0]); },
    value => { value.data.items[0].metrics.error_rate = 2; },
    value => { value.data.items[0].health.overall = 'operational'; },
    value => { value.data.items[0].buckets.push(value.data.items[0].buckets[0]); },
  ]) { const value = fixture(); mutate(value); assert.throws(() => readBlackaicodingStatus(value, MODELS)); }
});

test('authorization is required; no old public monitor or relay API keys are used', async () => {
  let calls = 0;
  const monitor = new Availability({}, { request: async () => { calls++; throw new Error('unexpected'); } });
  const result = await monitor.snapshot(keys.slice(0, 2));
  assert.equal(result.rows[0].state, 'auth-required');
  assert.equal(result.rows[0].source.url, MONITOR_URL);
  assert.equal(result.rows[0].authorizationSite, 'blackaicoding');
  assert.equal(calls, 0);
  assert.equal(adapterFor('https://blackaicoding.com.evil.example'), null);
  monitor.close();
});

test('protected adapters isolate credentials; 401 retains only explicitly stale data', async () => {
  let now = NOW, fail = false;
  const calls = [];
  const monitor = new Availability({}, { clock: () => now, auth: { read: async () => ({ token: TOKEN }) }, request: async (url, options) => {
    calls.push(url);
    if (url === BALANCE_ENDPOINT) {
      assert.equal(options.token, TOKEN);
      return { code: 0, data: { balance: 12.34 } };
    }
    if (url === ENDPOINT) {
      assert.equal(options.token, TOKEN);
      if (fail) throw Object.assign(new Error('secret must not leak'), { status: 401 });
      return fixture();
    }
    assert.fail('INPUT must not use code for me authorization');
  } });
  const [astra, sol] = await Promise.all([monitor.snapshot(keys), monitor.snapshot(keys, MODELS[1])]);
  assert.equal(calls.length, 2);
  assert.equal(astra.rows[0].state, 'unavailable');
  assert.equal(astra.rows[2].state, 'auth-required');
  assert.equal(sol.rows[0].uptimePct, 70);
  now += REFRESH_MS; fail = true;
  const expired = (await monitor.snapshot(keys)).rows[0];
  assert.equal(expired.state, 'auth-required');
  assert.equal(expired.history.length, 18);
  assert.ok(!JSON.stringify(expired).includes(TOKEN));
  assert.ok(!JSON.stringify(expired).includes('secret'));
  monitor.close();
});

test('credentials persist privately, expire, clear and remain confined to the selected directory', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'monitor-auth-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const auth = new MonitorAuth(home);
  assert.equal(await auth.read(), null);
  await auth.save(TOKEN);
  assert.equal((await new MonitorAuth(home).read()).token, TOKEN);
  if (process.platform !== 'win32') assert.equal((await fs.stat(auth.file)).mode & 0o777, 0o600);
  assert.equal(await new MonitorAuth(path.join(home, 'other')).read(), null);
  await assert.rejects(auth.save('sk-not-a-login-token'));
  assert.throws(() => validateToken(jwt(1)));
  await fs.writeFile(auth.file, JSON.stringify({ token: jwt(1) }));
  assert.equal(await auth.read(), null);
  await auth.clear(); assert.equal(await auth.read(), null);
});

test('transport attaches monitor token only to the fixed authorized endpoint, and never follows redirects', async t => {
  let calls = 0;
  t.mock.method(https, 'get', (url, options) => {
    calls++; assert.equal(url, ENDPOINT); assert.equal(options.headers.authorization, 'Bearer ' + TOKEN);
    const request = new EventEmitter(); request.destroy = () => {};
    setImmediate(() => { const response = new PassThrough(); response.statusCode = 302; request.emit('response', response); response.end(); });
    return request;
  });
  const options = { outbound: { resolve: async () => ({}), agent: () => false }, signal: new AbortController().signal, token: TOKEN };
  await assert.rejects(requestJson('https://status.input.im/api/status', options), /target rejected/);
  assert.equal(calls, 0);
  await assert.rejects(requestJson(ENDPOINT, options), error => error.status === 302);
  assert.equal(calls, 1);
});

test('local authorization API validates before saving, rejects cross-origin requests and does not return credentials', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'monitor-api-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  await fs.writeFile(path.join(home, 'config.toml'), 'model_provider="relay"\n[model_providers.relay]\nbase_url="https://blackaicoding.com"\n');
  await fs.writeFile(path.join(home, 'key_config.json'), JSON.stringify({ keys: keys.slice(0, 2) }));
  let reject = true;
  const app = await start({ home, proxyPort: 0, uiPort: 0, availabilityOptions: { clock: () => NOW, request: async () => {
    if (reject) throw Object.assign(new Error('unauthorized'), { status: 401 });
    return fixture();
  } }, log: () => {} });
  t.after(() => app.close());
  const auth = new MonitorAuth(home, 'blackaicoding', require('../relay-identity').accountId(keys[0]));
  const post = (token, origin = app.uiUrl) => fetch(app.uiUrl + '/api/availability/authorization', {
    method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ site: 'blackaicoding', name: keys[0].name, token }),
  });
  assert.equal((await post(TOKEN, 'https://other.example')).status, 403);
  assert.equal((await post(TOKEN)).status, 400);
  assert.equal(await auth.read(), null);
  reject = false;
  const saved = await post(TOKEN); assert.equal(saved.status, 200);
  assert.ok(!(await saved.text()).includes(TOKEN));
  assert.equal((await auth.read()).token, TOKEN);
  const snapshot = await (await fetch(app.uiUrl + '/api/availability')).json();
  assert.equal(snapshot.rows[0].state, 'unavailable');
  assert.equal((await post('')).status, 200);
  assert.equal((await (await fetch(app.uiUrl + '/api/availability')).json()).rows[0].state, 'auth-required');
});
