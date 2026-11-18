const { test } = require('node:test');
const assert = require('node:assert/strict');
const { networkAccessError } = require('../network-error');
const { MonitorLogin, loginError } = require('../monitor-login');
const { Availability } = require('../availability');
const fixture = require('./monitor-login-fixture');

test('connection failures explain network checks without assuming VPN status or reflecting private errors', () => {
  for (const code of ['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'ETIMEDOUT', 'EPROTO']) {
    const result = networkAccessError(Object.assign(new Error('private-key-and-password'), { code }));
    assert.match(result.message, /无法访问该站点.*运行与连接 → 上游网络/);
    assert.ok(!result.message.includes('请开启 VPN'));
    assert.ok(!result.message.includes('private-key-and-password'));
    assert.equal(result.status, code === 'ETIMEDOUT' ? 504 : 502);
  }
  assert.match(networkAccessError({ cause: { code: 'ECONNRESET' } }).message, /连接被重置/);
  const tlsFailure = networkAccessError({ cause: { code: 'EPROTO', message: 'private upstream detail' } });
  assert.match(tlsFailure.message, /TLS 握手失败，EPROTO/);
  assert.match(tlsFailure.message, /TLS 协商失败，不代表账号密码错误/);
  assert.match(tlsFailure.message, /Wi-Fi 或路由器已提供 VPN 时可保持直连，无需叠加本机代理/);
  assert.match(tlsFailure.message, /运行与连接 → 上游网络/);
  assert.ok(!tlsFailure.message.includes('private upstream detail'));
  const internalTlsFailure = networkAccessError({ code: 'ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR', message: 'private TLS alert' });
  assert.equal(internalTlsFailure.status, 502);
  assert.match(internalTlsFailure.message, /TLS 握手失败.*不代表账号密码错误.*保持直连/);
  assert.ok(!internalTlsFailure.message.includes('private TLS alert'));
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

test('password login and authorization verification distinguish TLS failure from rejected credentials', async t => {
  const request = async () => { throw Object.assign(new Error('private upstream detail'), { code: 'EPROTO' }); };
  const login = new MonitorLogin(request);
  t.after(() => login.clear());
  await assert.rejects(login.login({ username: 'normal', password: fixture.PASSWORD }, new AbortController().signal), error => error.status === 502 && /TLS 握手失败，EPROTO.*不代表账号密码错误/.test(error.message) && !error.message.includes('private upstream detail'));
  const monitor = new Availability({}, { request });
  t.after(() => monitor.close());
  await assert.rejects(monitor.authorize('input', fixture.INPUT_TOKEN), error => error.status === 502 && /无法访问 INPUT.*TLS 握手失败，EPROTO.*不代表账号密码错误/.test(error.message) && !error.message.includes('private upstream detail'));
});
