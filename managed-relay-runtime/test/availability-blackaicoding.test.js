const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readBlackaicodingStatus } = require('../availability-blackaicoding');
const { Availability, MODELS, REFRESH_MS, adapterFor } = require('../availability');

const NOW = Date.parse('2026-09-16T00:00:27Z');
const keys = [
  { name: 'code for me', baseurl: 'https://blackaicoding.com', value: 'sk-private' },
  { name: 'renamed relay', baseurl: 'https://www.blackaicoding.com/v1', value: 'sk-private-2' },
  { name: 'INPUT', baseurl: 'https://ai.input.im' },
];

function fixture({ warning = false, updated = '2026-09-16 00:00:27', states = ['good', 'unknown', 'bad', 'watch'] } = {}) {
  const row = (model, rate, ticks) => `<tr><td><span class="model-name">${model}</span></td>
    <td><div class="timeline">${ticks.map(kind => `<span title="${kind} &amp; &lt;sample&gt;" class="tick ${kind}"></span>`).join('')}</div></td>
    <td class="num">${rate}</td><td class="num">1200ms</td></tr>`;
  return `<html><div class="meta"><div>更新时间：${updated}</div></div>
    ${warning ? '<div class="warn">数据刷新暂时延迟</div>' : ''}
    <table><thead><tr><th>组件</th><th>最近 30 分钟</th><th>1 小时可用率</th><th>平均首字</th></tr></thead><tbody>
      ${row('gpt-6-astra', '83.69%', states)}${row('gpt-5.6-sol', '84.22%', ['good'])}
      ${row('gpt-6-astra-alias', '100.00%', ['good'])}</tbody></table></html>`;
}

test('code for me matches exact known hosts, regardless of route name or API path', () => {
  for (const url of ['https://blackaicoding.com', 'https://www.blackaicoding.com/v1']) assert.equal(adapterFor(url).id, 'blackaicoding');
  for (const url of ['https://blackaicoding.com.evil.example', 'https://other.example/blackaicoding.com']) assert.equal(adapterFor(url), null);
});

test('HTML adapter preserves partial availability, empty windows and the source hourly percentage', () => {
  const models = readBlackaicodingStatus(fixture(), MODELS, NOW);
  assert.deepEqual(Object.keys(models), MODELS);
  const astra = models[MODELS[0]];
  assert.deepEqual(astra.history.map(item => item.state), ['available', 'no-data', 'unavailable', 'degraded']);
  assert.deepEqual(astra.history.map(item => item.ok), [true, null, false, null]);
  assert.equal(astra.uptimePct, 83.69);
  assert.equal(models[MODELS[1]].uptimePct, 84.22);
  assert.equal(astra.history[0].timeLabel, '23:58:30');
  assert.equal(astra.last.endTimeLabel, '00:00:30');
  assert.ok(astra.history[0].label.startsWith('2026-09-15'));
  assert.ok(astra.last.label.includes('watch & <sample>'));
  assert.equal(astra.last.at, null);
  assert.equal(astra.sourceUpdatedAtLabel, '2026-09-16 00:00:27');
  assert.equal(astra.stale, false);
});

test('source warning and unambiguously old snapshots are stale, even after a successful fetch', () => {
  assert.equal(readBlackaicodingStatus(fixture({ warning: true }), MODELS, NOW)[MODELS[0]].stale, true);
  assert.equal(readBlackaicodingStatus(fixture({ updated: '2026-09-08 07:52:27' }), MODELS, NOW)[MODELS[0]].stale, true);
});

test('malformed page, timestamp, states and metrics reject instead of yielding healthy data', () => {
  for (const html of ['<html>Challenge</html>', fixture().replace('2026-09-16', '2026-99-16'),
    fixture().replace('83.69%', '101%'), fixture().replace('tick watch', 'tick unexpected'),
    fixture().replace('1 小时可用率', 'Other metric'), fixture().replace('class="timeline"', 'class="missing"')]) {
    assert.throws(() => readBlackaicodingStatus(html, MODELS, NOW));
  }
  assert.equal(readBlackaicodingStatus(fixture().replace('83.69%', '-'), MODELS, NOW)[MODELS[0]].uptimePct, null);
  assert.equal(readBlackaicodingStatus(fixture().replace('gpt-6-astra</span>', 'unlisted</span>'), MODELS, NOW)[MODELS[0]], undefined);
});

test('adapter limits history to the most recent 60 windows', () => {
  const states = ['bad', ...Array(60).fill('good')];
  const history = readBlackaicodingStatus(fixture({ states }), MODELS, NOW)[MODELS[0]].history;
  assert.equal(history.length, 60);
  assert.ok(history.every(item => item.state === 'available'));
});

test('both adapters cache independently and preserve the global model selection', async () => {
  let now = NOW;
  let states = ['watch'];
  let warning = false;
  let fail = false;
  const calls = [];
  const monitor = new Availability({}, { clock: () => now, request: async url => {
    calls.push(url);
    if (url === 'https://status.blackaicoding.com/') {
      if (fail) throw new Error('Source failed');
      return fixture({ states, warning });
    }
    return { services: [{ model: MODELS[0], history: [{ ts: now / 1000, ok: true }] }] };
  } });
  const [astra, sol] = await Promise.all([monitor.snapshot(keys), monitor.snapshot(keys, MODELS[1])]);
  assert.equal(calls.length, 2);
  assert.equal(astra.rows[0].state, 'degraded');
  assert.equal(astra.rows[0].source.url, 'https://blackaicoding.com/custom/bdba7e5ab409e0b5');
  assert.deepEqual(astra.rows[0].history, astra.rows[1].history);
  assert.equal(astra.rows[2].state, 'available');
  assert.equal(sol.rows[0].state, 'available');
  assert.equal(sol.rows[2].state, 'no-data');
  assert.ok(!JSON.stringify(astra).includes('sk-private'));
  for (const [kind, expected] of [['unknown', 'no-data'], ['bad', 'unavailable'], ['good', 'available']]) {
    states = [kind]; now += REFRESH_MS;
    assert.equal((await monitor.snapshot(keys)).rows[0].state, expected);
  }
  warning = true; now += REFRESH_MS;
  assert.equal((await monitor.snapshot(keys)).rows[0].state, 'stale');
  fail = true; now += REFRESH_MS;
  const stale = (await monitor.snapshot(keys)).rows[0];
  assert.equal(stale.state, 'stale');
  assert.equal(stale.history.length, 1);
  assert.match(stale.message, /刷新失败/);
  monitor.close();
});
