const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../../managed-relay-public/availability.js'), 'utf8');

function view(fetch) {
  const View = vm.runInNewContext(source + '\nRelayAvailability;', { Intl, Date, AbortController, AbortSignal, fetch,
    document: { hidden: false }, clearTimeout, setTimeout,
    escapeHtml: value => String(value).replace(/[&<>"']/g, c => '&#' + c.charCodeAt(0) + ';') });
  return Object.assign(Object.create(View.prototype), { model: 'gpt-6-astra', error: '', rows: new Map(), signature: 'current',
    rowFailures: new Map(), request: null, getState: () => ({ availabilityAvailable: true }), isDragging: () => false, paint: () => {} });
}

test('a local refresh failure is distinguished from provider errors and keeps prior rows', async () => {
  const v = view(async () => ({ ok: false, status: 503 }));
  const previous = { state: 'available', history: [{ ok: true, at: Date.now() }], message: '可用' };
  v.rows.set('previous', previous);
  await v.refresh();
  assert.match(v.error, /管理服务返回 HTTP 503/);
  assert.equal(v.rows.get('previous'), previous);
  assert.match(v.markup(previous), /保留上次样本/);
  const timedOut = view(async () => { throw Object.assign(new Error('private'), { name: 'TimeoutError' }); });
  await timedOut.refresh();
  assert.match(timedOut.error, /管理服务响应超时/);
  assert.ok(!timedOut.error.includes('private'));
});

test('first status failure immediately replaces green display while retaining independent balance and history', () => {
  const client = view();
  const sample = { at: Date.now(), ok: true };
  const healthy = { name: 'project', baseurl: 'https://cf.api.fan/v1', state: 'available', history: [sample],
    last: sample, balance: { state: 'available', amount: 118, currency: 'USD' } };
  client.acceptRows([healthy]);
  const failed = { ...healthy, state: 'stale', message: '刷新失败，保留上次样本',
    failure: { code: 'REFRESH_TIMEOUT', message: '查询超时（10 秒）' }, balance: { ...healthy.balance, amount: 117 } };
  for (let attempt = 0; attempt < 5; attempt++) {
    client.acceptRows([failed]);
    const displayed = client.rows.get(JSON.stringify([healthy.name, healthy.baseurl]));
    assert.equal(displayed.state, 'stale'); assert.equal(displayed.balance.amount, 117);
    assert.equal(displayed.history[0], sample);
    assert.match(client.markup(displayed), /刷新失败：查询超时/);
    assert.match(client.markup(displayed), /上次样本/);
  }
  client.acceptRows([healthy]);
  const recovered = client.rows.get(JSON.stringify([healthy.name, healthy.baseurl]));
  assert.equal(recovered.state, 'available'); assert.equal(recovered.failure, undefined);
});

test('status, balance and subscriptions display their own safe failure reason', () => {
  const v = view();
  const failure = { code: 'ECONNRESET', message: '连接被重置（ECONNRESET）' };
  assert.match(v.markup({ state: 'stale', history: [], failure }), /刷新失败：连接被重置/);
  assert.match(v.balanceMarkup({ state: 'stale', amount: 20, currency: 'USD', failure }), /上次余额.*ECONNRESET/);
  assert.match(v.subscriptionsMarkup({ state: 'stale', items: [], failure }), /ECONNRESET/);
  assert.ok(!v.balanceMarkup({ state: 'available', amount: 20, currency: 'USD' }).includes('刷新失败'));
});
