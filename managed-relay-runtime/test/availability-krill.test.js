const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readKrillStatus } = require('../availability-krill');
const { Availability, MODELS, REFRESH_MS, adapterFor } = require('../availability');
const NOW = Date.parse('2026-09-17T02:20:00Z');
const stamp = at => new Date(at).toISOString().slice(0, 19).replace('T', ' ');
const sample = (ago, s) => ({ ts: stamp(NOW - ago * 60000), s });
const keys = ['https://api-slb.krill-code.net/codex/v1', 'https://api.cdn-krill-ai.com/coding/v1', 'https://api.cdn-krill-ai.com/codex/v1'].map((baseurl, i) => ({ name: 'Krill ' + i, baseurl, value: 'sk-private' }));
function payload() {
  return { success: true, data: {
    channels: MODELS.map((model, i) => ({ channel_key: 'channel-' + i, model_name: model, channel: 'OpenAI 官渠',
      current_status: i ? 2 : 1, history: [sample(1, 1), sample(3, 2), sample(4, 0), sample(21, 1), sample(22, 2), sample(41, 1)] })),
    perf: [{ channel_key: 'channel-0', ttft_p99_ms: 406, throughput_p50_tps: 23.48, cache_rate: 0.9275 },
      { channel_key: 'channel-1', ttft_p99_ms: 375, throughput_p50_tps: 35.2, cache_rate: 0.934 }],
  } };
}

test('Krill recognizes the saved monthly and weekly endpoints with strict hostname matching', () => {
  for (const entry of keys) assert.equal(adapterFor(entry.baseurl).id, 'krill');
  assert.equal(adapterFor('https://www.krill-code.com').id, 'krill');
  assert.equal(adapterFor('https://api.cdn-krill-ai.com.evil.example/v1'), null);
  assert.equal(adapterFor('https://other.krill-code.net'), null);
});

test('UTC history aggregates into 72 segments with failure above degraded above available', () => {
  const parsed = readKrillStatus(payload(), MODELS, NOW);
  const astra = parsed[MODELS[0]];
  assert.equal(astra.history.length, 72);
  assert.deepEqual(astra.history.slice(-3).map(item => item.state), ['available', 'degraded', 'unavailable']);
  assert.equal(astra.history[0].state, 'no-data');
  assert.equal(astra.history[0].ok, null);
  assert.equal(astra.sampleCount, 3);
  assert.equal(astra.last.at, NOW - 60000);
  assert.equal(astra.last.state, 'available');
  assert.equal(parsed[MODELS[1]].last.state, 'degraded');
  assert.equal(astra.uptimePct, null); // The source does not publish a success rate.
  assert.equal(astra.metrics.tps, 23.48);
  assert.equal(astra.metrics.ttftMs, 406);
  assert.equal(astra.metrics.cacheRatePct, 92.75);
  assert.equal(parsed[MODELS[1]].metrics.tps, 35.2);
});

test('missing models and empty history remain unknown without borrowing another channel', () => {
  const data = payload(); data.data.channels.shift();
  assert.equal(readKrillStatus(data, MODELS, NOW)[MODELS[0]], undefined);
  data.data.channels[0].history = [];
  const sol = readKrillStatus(data, MODELS, NOW)[MODELS[1]];
  assert.equal(sol.last, null);
  assert.equal(sol.sampleCount, 0);
  assert.ok(sol.history.every(item => item.state === 'no-data'));
});

test('old and future points do not color current windows; duplicates and ambiguous channels reject', () => {
  const data = payload();
  data.data.channels[0].history = [sample(1500, 0), sample(-1, 0), sample(0, 1)];
  const parsed = readKrillStatus(data, MODELS, NOW)[MODELS[0]];
  assert.equal(parsed.sampleCount, 1);
  assert.equal(parsed.last.at, NOW);
  for (const mutate of [
    data => { data.success = false; },
    data => { data.data.channels[0].history[0].ts = '2026-02-30 00:00:00'; },
    data => { data.data.channels[0].history[0].s = '1'; },
    data => { data.data.channels[0].current_status = 4; },
    data => { data.data.channels.push(data.data.channels[0]); },
    data => { data.data.perf.push(data.data.perf[0]); },
    data => { data.data.perf[0].cache_rate = 1.5; },
  ]) { const invalid = payload(); mutate(invalid); assert.throws(() => readKrillStatus(invalid, MODELS, NOW)); }
});

test('fixed status is labeled as such and is not converted to made-up sample timestamps', () => {
  const data = payload();
  data.data.channels[0].fixed_status = 2;
  data.data.channels[0].history = [];
  const parsed = readKrillStatus(data, MODELS, NOW)[MODELS[0]];
  assert.ok(parsed.history.every(item => item.state === 'degraded'));
  assert.equal(parsed.last.at, null);
  assert.match(parsed.summaryLabel, /固定状态/);
});

test('one public request serves both models and all Krill routes, with stale history on errors', async () => {
  let now = NOW, calls = 0, fail = false;
  const monitor = new Availability({}, { clock: () => now, request: async (url, options) => {
    calls++;
    assert.equal(url, 'https://www.krill-code.com/api/public/channel-status?hours=24');
    assert.deepEqual(Object.keys(options).sort(), ['outbound', 'signal']);
    if (fail) throw new Error('Unavailable');
    return payload();
  } });
  const [astra, sol] = await Promise.all([monitor.snapshot(keys), monitor.snapshot(keys, MODELS[1])]);
  assert.equal(calls, 1);
  assert.equal(astra.rows[0].state, 'available');
  assert.equal(sol.rows[0].state, 'degraded');
  assert.deepEqual(astra.rows[0].history, astra.rows[2].history);
  assert.equal(astra.rows[0].source.url, 'https://www.krill-code.com/status');
  assert.ok(!JSON.stringify(astra).includes('sk-private'));
  now += REFRESH_MS; fail = true;
  const stale = (await monitor.snapshot(keys)).rows[0];
  assert.equal(stale.state, 'stale');
  assert.equal(stale.history.length, 72);
  now = NOW + 6 * 60000; fail = false;
  assert.equal((await monitor.snapshot(keys)).rows[0].state, 'stale');
  monitor.close();
});
