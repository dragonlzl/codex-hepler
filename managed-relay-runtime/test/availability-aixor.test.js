const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readPerformanceStatus } = require('../availability-perf-metrics');
const readAixorStatus = (data, model, now) => readPerformanceStatus(data, model, { groupName: 'Premium-gpt' }, now);
const { Availability, MODELS, REFRESH_MS, adapterFor } = require('../availability');

const HOUR = 3600000;
const NOW = Date.parse('2026-09-16T10:20:00Z');
const LATEST = Date.parse('2026-09-16T10:00:00Z');
const keys = [
  { name: 'Aixor', baseurl: 'https://aixor.org/v1', value: 'sk-private' },
  { name: 'Aixor backup', baseurl: 'https://aixor.cc/v1', value: 'sk-private-2' },
];
function bucket(offset, success_rate) {
  return { ts: (LATEST - offset * HOUR) / 1000, success_rate, avg_latency_ms: 37370, avg_ttft_ms: 10570, avg_tps: 31.6 };
}
function payload(model = MODELS[0]) {
  return { success: true, data: { model_name: model, groups: [
    { group: 'default', success_rate: 100, series: [bucket(0, 100)] },
    { group: 'Premium-gpt', success_rate: 7, avg_latency_ms: 37370, avg_ttft_ms: 10570, avg_tps: 31.6,
      series: [bucket(0, 95.205479), bucket(2, 46.540880), bucket(3, 100), bucket(4, 82.089552)] },
    { group: 'Premium-gpt-backup', success_rate: 100, series: [bucket(0, 100)] },
  ] } };
}
const premium = value => value.data.groups[1];

test('Aixor domains and API paths share a registered adapter, without matching lookalikes', () => {
  for (const base of ['https://aixor.org/v1', 'https://aixor.cc', 'https://www.aixor.org', 'https://www.aixor.cc/v1']) {
    assert.equal(adapterFor(base).id, 'aixor');
  }
  assert.equal(adapterFor('https://aixor.org.evil.example/v1'), null);
  assert.equal(adapterFor('https://other.example/aixor.cc'), null);
});

test('only Premium-gpt contributes to the hourly timeline and its source-page average', () => {
  const parsed = readAixorStatus(payload(), MODELS[0], NOW)[MODELS[0]];
  assert.equal(parsed.groupLabel, 'Premium-gpt');
  assert.equal(parsed.history.length, 24);
  assert.equal(parsed.historyLength, 24);
  assert.equal(parsed.sampleCount, 4);
  assert.ok(Math.abs(parsed.uptimePct - 80.96) < 1e-10);
  assert.notEqual(parsed.uptimePct, premium(payload()).success_rate);
  assert.equal(parsed.history[0].at, LATEST - 23 * HOUR);
  assert.equal(parsed.last.at, LATEST);
  assert.equal(parsed.last.uptimePct, 95.21);
  assert.deepEqual(parsed.history.slice(-5).map(item => item.state), ['degraded', 'available', 'unavailable', 'no-data', 'available']);
  assert.deepEqual(parsed.metrics, { tps: 31.6, ttftMs: 10570, latencyMs: 37370 });
});

test('source color thresholds match 90 and 70 percent and gaps never count as failures', () => {
  const value = payload();
  premium(value).series = [bucket(0, 100), bucket(1, 90), bucket(2, 89.99), bucket(3, 70), bucket(4, 69.99), bucket(5, 0)];
  const parsed = readAixorStatus(value, MODELS[0], NOW)[MODELS[0]];
  assert.deepEqual(parsed.history.slice(-6).map(item => item.state), ['unavailable', 'unavailable', 'degraded', 'degraded', 'available', 'available']);
  assert.equal(parsed.history[0].ok, null);
  assert.equal(parsed.history[0].uptimePct, null);
  assert.equal(parsed.sampleCount, 6);
});

test('missing or empty Premium-gpt does not fall back to another group', () => {
  const value = payload();
  value.data.groups.splice(1, 1);
  const missing = readAixorStatus(value, MODELS[0], NOW)[MODELS[0]];
  assert.deepEqual(missing.history, []);
  assert.equal(missing.last, null);
  assert.equal(missing.uptimePct, null);
  const empty = payload();
  premium(empty).series = [];
  assert.equal(readAixorStatus(empty, MODELS[0], NOW)[MODELS[0]].sampleCount, 0);
});

test('timestamps are ordered and history stays within 24 hours of the source latest sample', () => {
  const value = payload();
  premium(value).series = [bucket(25, 0), bucket(0, 100), bucket(23, 90), bucket(3, 80)];
  const parsed = readAixorStatus(value, MODELS[0], NOW)[MODELS[0]];
  assert.equal(parsed.history.length, 24);
  assert.equal(parsed.sampleCount, 3);
  assert.equal(parsed.uptimePct, 90);
});

test('wrong models, failed payloads and malformed selected group data are rejected', () => {
  for (const mutate of [
    value => { value.success = false; },
    value => { value.data.model_name = MODELS[1]; },
    value => { value.data.groups = null; },
    value => { value.data.groups.push(premium(value)); },
    value => { premium(value).series = null; },
    value => { premium(value).series.push(premium(value).series[0]); },
    value => { premium(value).series[0].ts++; },
    value => { premium(value).series[0].ts += 86400; },
    value => { premium(value).series[0].success_rate = '95'; },
    value => { premium(value).series[0].success_rate = 101; },
    value => { premium(value).series[0].success_rate = -1; },
    value => { premium(value).avg_tps = -1; },
  ]) {
    const value = payload(); mutate(value);
    assert.throws(() => readAixorStatus(value, MODELS[0], NOW));
  }
});

test('requests use exact official model IDs, cache per model, and deduplicate Aixor accounts', async () => {
  const calls = [];
  let now = NOW;
  let failSol = false;
  const monitor = new Availability({}, { clock: () => now, request: async endpoint => {
    calls.push(endpoint);
    const url = new URL(endpoint);
    assert.equal(url.origin + url.pathname, 'https://aixor.cc/api/perf-metrics');
    assert.equal(url.searchParams.get('hours'), '24');
    const model = url.searchParams.get('model');
    assert.ok(MODELS.includes(model));
    if (model === MODELS[1] && failSol) throw new Error('Sol unavailable');
    const value = payload(model);
    if (model === MODELS[1]) premium(value).series = [bucket(0, 0)];
    return value;
  } });
  const [astra, sol] = await Promise.all([monitor.snapshot(keys), monitor.snapshot(keys, MODELS[1])]);
  assert.equal(calls.length, 2);
  assert.deepEqual(astra.rows[0].history, astra.rows[1].history);
  assert.equal(astra.rows[0].state, 'available');
  assert.equal(sol.rows[0].state, 'unavailable');
  assert.equal(astra.rows[0].source.url, 'https://aixor.cc/pricing');
  assert.ok(!JSON.stringify(astra).includes('sk-private'));
  await monitor.snapshot(keys);
  assert.equal(calls.length, 2);
  now += REFRESH_MS;
  failSol = true;
  assert.equal((await monitor.snapshot(keys, MODELS[1])).rows[0].state, 'stale');
  assert.equal((await monitor.snapshot(keys)).rows[0].state, 'available');
  assert.equal(calls.length, 4);
  monitor.close();
});

test('hourly buckets stay current within their hour and become stale after the next-hour grace period', async () => {
  let now = NOW;
  const monitor = new Availability({}, { clock: () => now, request: async () => payload() });
  assert.equal((await monitor.snapshot(keys)).rows[0].state, 'available');
  now = LATEST + HOUR + 179999;
  assert.equal((await monitor.snapshot(keys)).rows[0].state, 'available');
  now = LATEST + HOUR + 180001;
  assert.equal((await monitor.snapshot(keys)).rows[0].state, 'stale');
  monitor.close();
});

test('absent Premium-gpt reports no data with its group label', async () => {
  const value = payload();
  value.data.groups.splice(1, 1);
  const monitor = new Availability({}, { clock: () => NOW, request: async () => value });
  const row = (await monitor.snapshot(keys)).rows[0];
  assert.equal(row.state, 'no-data');
  assert.equal(row.groupLabel, 'Premium-gpt');
  assert.deepEqual(row.history, []);
  monitor.close();
});
