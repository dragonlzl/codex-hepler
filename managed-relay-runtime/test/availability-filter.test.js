const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../../managed-relay-public/availability.js'), 'utf8');
const View = vm.runInNewContext(source + '\nRelayAvailability;', {});

test('availability filters follow the last history slot instead of aggregate state or earlier failures', () => {
  assert.equal(View.filterState({ state: 'available', last: { ok: true }, history: [{ ok: true }, { ok: false }] }), 'unavailable');
  assert.equal(View.filterState({ state: 'unavailable', last: { ok: false }, history: [{ ok: false }, { ok: true }] }), 'available');
  assert.equal(View.filterState({ state: 'stale', history: [{ state: 'unavailable', ok: false }] }), 'unavailable');
  assert.equal(View.filterState({ state: 'error', history: [{ state: 'available', ok: true }] }), 'available');
});

test('yellow and grey final slots are non-red and use the same classification as rendered bars', () => {
  const yellow = { state: 'degraded', ok: false };
  const grey = { state: 'no-data', ok: null };
  assert.equal(View.sampleColor(yellow), 'warn');
  assert.equal(View.sampleColor(grey), 'unknown');
  assert.equal(View.filterState({ history: [yellow] }), 'available');
  assert.equal(View.filterState({ history: [{ state: 'unavailable', ok: false }, grey], sampleCount: 1 }), 'available');
  assert.equal(View.filterState({ history: [{ state: 'no-data', healthScore: null }], sampleCount: 1 }), 'available');
});

test('unsupported, loading, empty, and entirely empty grid histories belong only in all', () => {
  for (const row of [undefined, {}, { state: 'unsupported' }, { state: 'auth-required', history: [] },
    { state: 'available', last: { ok: true }, history: [] },
    { history: [{ state: 'no-data', ok: null }], sampleCount: 0 },
    { history: [{ state: 'no-data', ok: null }] }]) {
    assert.equal(View.filterState(row), null);
  }
});
