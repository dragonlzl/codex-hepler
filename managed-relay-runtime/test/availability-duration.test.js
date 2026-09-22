const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../../managed-relay-public/availability.js'), 'utf8');
const View = vm.runInNewContext(source + '\nRelayAvailability;', {});
const NOW = Date.parse('2026-09-22T02:00:00Z');
const MINUTE = 60000;

function available(duration, interval = MINUTE) {
  const history = [];
  for (let at = NOW - duration; at < NOW; at += interval) history.push({ at, ok: true });
  history.push({ at: NOW, ok: true });
  return { state: 'available', sampleIntervalMs: interval, history, last: history.at(-1) };
}

test('compact availability selects the highest duration strictly exceeded by observed history', () => {
  for (const [minutes, previous, next] of [
    [10, '当前可用', '持续可用超过10分钟'],
    [60, '持续可用超过10分钟', '持续可用超过1小时'],
    [480, '持续可用超过1小时', '持续可用超过8小时'],
    [1440, '持续可用超过8小时', '持续可用超过24小时'],
  ]) {
    assert.equal(View.simpleStatus(available(minutes * MINUTE - 1), NOW).message, previous);
    assert.equal(View.simpleStatus(available(minutes * MINUTE), NOW).message, previous);
    assert.equal(View.simpleStatus(available(minutes * MINUTE + 1), NOW).message, next);
  }
});

test('unavailable, missing and maintenance samples or gaps restart the observed continuous period', () => {
  for (const [minutes, expected] of [[30, '持续可用超过10分钟'], [120, '持续可用超过1小时'], [600, '持续可用超过8小时']]) {
    for (const state of ['unavailable', 'no-data', 'maintenance', 'gap']) {
      const status = available(1500 * MINUTE);
      const index = status.history.findIndex(sample => sample.at === NOW - minutes * MINUTE);
      if (state === 'gap') status.history.splice(index, 1);
      else status.history[index] = { at: status.history[index].at, state, ok: state === 'no-data' ? null : false };
      assert.equal(View.simpleStatus(status, NOW).message, expected, minutes + ' / ' + state);
    }
  }
});

test('recent failures retain their existing descriptions and latest failures override a long history', () => {
  for (const [minutes, expected] of [[2, '当前可用，3分钟内存在不可用'], [5, '当前可用，10分钟内存在不可用']]) {
    const status = available(1500 * MINUTE);
    status.history.find(sample => sample.at === NOW - minutes * MINUTE).ok = false;
    assert.equal(View.simpleStatus(status, NOW).message, expected);
  }
  const status = available(1500 * MINUTE);
  status.last.ok = false;
  assert.equal(View.simpleStatus(status, NOW).message, '当前不可用');
});

test('duration requires fresh evidence, enough history and a sampling interval no longer than the tier', () => {
  const status = available(1500 * MINUTE);
  assert.equal(View.simpleStatus(status, NOW + 5 * MINUTE).message, '状态已过期');
  assert.equal(View.simpleStatus(status, NOW + 2 * MINUTE).message, '当前可用');
  assert.equal(View.simpleStatus({ ...status, state: 'auth-required' }, NOW).message, '需登录后检测');
  assert.equal(View.simpleStatus(available(59 * MINUTE), NOW).message, '持续可用超过10分钟');
  assert.equal(View.simpleStatus(available(30 * MINUTE, 60 * MINUTE), NOW).message, '当前可用');
  assert.equal(View.simpleStatus(available(9 * 60 * MINUTE, 60 * MINUTE), NOW).message, '持续可用超过8小时');
  assert.equal(View.simpleStatus(available(25 * 60 * MINUTE, 60 * MINUTE), NOW).message, '持续可用超过24小时');
});

test('single-channel and reference displays retain duration tiers without changing degraded color', () => {
  const channel = available(500 * MINUTE, 5 * MINUTE);
  channel.last.state = 'degraded'; channel.last.ok = false;
  const summary = View.simpleStatus({ channels: [channel], sampleIntervalMs: 5 * MINUTE }, NOW);
  assert.equal(summary.message, '持续可用超过8小时');
  assert.equal(summary.color, 'degraded');
  assert.equal(View.simpleStatus({ ...channel, referenceOnly: true }, NOW).message, '其他模型参考：持续可用超过8小时');
  assert.equal(View.simpleStatus({ channels: [channel, channel] }, NOW).color, 'unknown');
});
