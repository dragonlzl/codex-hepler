const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Availability, MODELS, REFRESH_MS, adapterFor } = require('../availability');

const NOW = Date.parse('2026-09-16T10:20:00Z');
const HOUR = 3600000;
const LATEST = Date.parse('2026-09-16T10:00:00Z');
const adapter = adapterFor('https://cf.api.fan/v1');
const keys = [
  { name: 'packycode项目用', baseurl: 'https://cf.api.fan/v1', value: 'sk-private' },
  { name: '按量卡', baseurl: 'https://codex-api.packycode.com/v1', value: 'sk-private-2' },
];
function payload(model = MODELS[0]) {
  const group = (name, successRate) => ({
    group: name, success_rate: successRate, avg_ttft_ms: 1670, avg_latency_ms: 16150, avg_tps: 20.9,
    series: [100, 98.999, 90, 89.99].map((rate, index) => ({ ts: (LATEST - index * HOUR) / 1000, success_rate: rate })),
  });
  return { success: true, data: { model_name: model, groups: [group('codex-sale', 0), group('codex', 99.999397), group('azure-officially', 1)] } };
}

test('Packycode recognizes current relay endpoints without using entry names or loose hostname matches', () => {
  for (const host of ['packyapi.com', 'www.packyapi.com', 'cf.api.fan', 'codex-api.packycode.com']) {
    assert.equal(adapterFor('https://' + host + '/v1').id, 'packycode');
  }
  for (const host of ['www.packyapi.com.evil.example', 'other.api.fan', 'other.packycode.com']) assert.equal(adapterFor('https://' + host), null);
});

test('Packycode uses exact codex group aggregate, raw hourly rates and source color thresholds', () => {
  const data = adapter.parse(payload(), NOW, MODELS[0])[MODELS[0]];
  assert.equal(data.groupLabel, 'codex');
  assert.equal(data.uptimePct, 99.999397);
  assert.equal(data.sampleCount, 4);
  assert.equal(data.history.length, 24);
  assert.deepEqual(data.history.slice(-4).map(sample => sample.state), ['unavailable', 'degraded', 'degraded', 'available']);
  assert.equal(data.history.at(-2).uptimePct, 98.999);
  assert.equal(data.history[0].state, 'no-data');
  assert.deepEqual(data.metrics, { tps: 20.9, ttftMs: 1670, latencyMs: 16150 });
});

test('missing codex is not substituted with codex-sale and absent aggregates stay unknown', () => {
  const absent = payload();
  absent.data.groups.splice(1, 1);
  const missing = adapter.parse(absent, NOW, MODELS[0])[MODELS[0]];
  assert.equal(missing.groupLabel, 'codex');
  assert.deepEqual(missing.history, []);
  assert.equal(missing.uptimePct, null);
  const noRate = payload();
  delete noRate.data.groups[1].success_rate;
  assert.equal(adapter.parse(noRate, NOW, MODELS[0])[MODELS[0]].uptimePct, null);
  for (const rate of [-1, 101, '99', Infinity]) {
    const invalid = payload(); invalid.data.groups[1].success_rate = rate;
    assert.throws(() => adapter.parse(invalid, NOW, MODELS[0]));
  }
  assert.throws(() => adapter.parse(payload(MODELS[1]), NOW, MODELS[0]));
});

test('Packycode and Aixor use separate group policies for identical payload shapes', () => {
  const data = payload();
  const aixorGroup = { ...data.data.groups[1], group: 'Premium-gpt', avg_tps: 31.6 };
  data.data.groups.push(aixorGroup);
  const packy = adapter.parse(data, NOW, MODELS[0])[MODELS[0]];
  const aixor = adapterFor('https://aixor.cc').parse(data, NOW, MODELS[0])[MODELS[0]];
  assert.equal(packy.metrics.tps, 20.9);
  assert.equal(aixor.metrics.tps, 31.6);
  assert.notEqual(packy.uptimePct, aixor.uptimePct);
  assert.equal(packy.history.at(-2).state, 'degraded');
  assert.equal(aixor.history.at(-2).state, 'available');
});

test('Packycode shares requests across endpoints while separating models and sites', async () => {
  let now = NOW;
  let fail = false;
  const calls = [];
  const monitor = new Availability({}, { clock: () => now, request: async endpoint => {
    const url = new URL(endpoint);
    calls.push(endpoint);
    assert.equal(url.pathname, '/api/perf-metrics');
    assert.equal(url.searchParams.get('hours'), '24');
    const model = url.searchParams.get('model');
    assert.ok(MODELS.includes(model));
    if (url.hostname === 'www.packyapi.com') {
      if (fail) throw new Error('Source unavailable');
      const data = payload(model);
      if (model === MODELS[1]) data.data.groups[1].success_rate = 88;
      return data;
    }
    assert.equal(url.hostname, 'aixor.cc');
    const data = payload(model);
    data.data.groups[1].group = 'Premium-gpt';
    return data;
  } });
  const routes = [...keys, { name: 'Aixor', baseurl: 'https://aixor.org/v1' }];
  const [astra, sol] = await Promise.all([monitor.snapshot(routes), monitor.snapshot(routes, MODELS[1])]);
  assert.equal(calls.length, 4);
  assert.equal(astra.rows[0].groupLabel, 'codex');
  assert.equal(astra.rows[2].groupLabel, 'Premium-gpt');
  assert.equal(astra.rows[0].source.url, 'https://www.packyapi.com/pricing');
  assert.deepEqual(astra.rows[0].history, astra.rows[1].history);
  assert.equal(sol.rows[0].uptimePct, 88);
  assert.equal(astra.rows[0].uptimePct, 99.999397);
  assert.ok(!JSON.stringify(astra).includes('sk-private'));
  await monitor.snapshot(routes);
  assert.equal(calls.length, 4);
  now += REFRESH_MS; fail = true;
  const failed = await monitor.snapshot(routes);
  assert.equal(failed.rows[0].state, 'stale');
  assert.equal(failed.rows[0].history.length, 24);
  assert.equal(failed.rows[2].state, 'available');
  monitor.close();
});
