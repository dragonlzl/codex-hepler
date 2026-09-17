const { test } = require('node:test');
const assert = require('node:assert/strict');
const { networkAccessError } = require('../network-error');
const { MonitorLogin, loginError } = require('../monitor-login');
const { Availability } = require('../availability');
const fixture = require('./monitor-login-fixture');

test('connection failures suggest VPN without reflecting exception messages or credentials', () => {
  for (const code of ['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'ETIMEDOUT']) {
    const result = networkAccessError(Object.assign(new Error('private-key-and-password'), { code }));
    assert.match(result.message, /无法访问该站点.*请开启 VPN 或配置可用代理/);
    assert.ok(!result.message.includes('private-key-and-password'));
    assert.equal(result.status, code === 'ETIMEDOUT' ? 504 : 502);
  }
  assert.match(networkAccessError({ cause: { code: 'ECONNRESET' } }).message, /连接被重置/);
  assert.equal(networkAccessError({ name: 'TimeoutError' }).status, 504);
});

test('auth failures, rate limits, certificates and local file errors keep their own remedies', () => {
  for (const code of ['EACCES', 'EPERM', 'ENOENT', 'EROFS', 'ENOSPC', 'CERT_HAS_EXPIRED']) assert.equal(networkAccessError({ code }), null);
  for (const status of [400, 401, 403, 429, 500]) {
    assert.equal(networkAccessError({ status }), null);
    assert.ok(!loginError({ status }, false).message.includes('VPN'));
  }
  assert.equal(networkAccessError(new Error('unrecognized')), null);
});

test('password login and authorization verification both surface actionable network errors', async t => {
  const request = async () => { throw Object.assign(new Error('private upstream detail'), { code: 'ECONNRESET' }); };
  const login = new MonitorLogin(request);
  t.after(() => login.clear());
  await assert.rejects(login.login({ username: 'normal', password: fixture.PASSWORD }, new AbortController().signal), error => error.status === 502 && /无法访问.*VPN/.test(error.message));
  const monitor = new Availability({}, { request });
  t.after(() => monitor.close());
  await assert.rejects(monitor.authorize('input', fixture.INPUT_TOKEN), error => error.status === 502 && /无法访问 INPUT.*VPN/.test(error.message));
});
