const { test } = require('node:test');
const assert = require('node:assert/strict');
const https = require('node:https');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { krillRequest, isKrillUrl, isHandshakeFailure, MAX_ATTEMPTS } = require('../krill-transport');

const LOGIN = 'https://www.krill-code.com/api/auth/login';
const IDENTITY = 'https://www.krill-code.com/api/auth/me';
const tlsFailure = () => Object.assign(new Error('Private TLS detail'), { code: 'EPROTO' });

function mockTransport(t, steps) {
  const calls = [], sends = [];
  t.mock.method(https, 'request', (url, options) => {
    const index = calls.length, step = steps[index];
    assert.ok(step, 'unexpected extra connection');
    const socket = new EventEmitter();
    socket.encrypted = true; socket.authorized = false;
    socket.destroy = () => { socket.destroyed = true; };
    const request = new EventEmitter();
    request.destroy = () => { request.destroyed = true; };
    request.end = body => {
      assert.equal(socket.authorized, true, 'no HTTP data before verified TLS');
      sends.push({ index, body });
      step.send?.({ request, socket, body });
      if (step.respond !== false && !request.destroyed) queueMicrotask(() => {
        const response = new PassThrough();
        response.statusCode = step.status ?? 200;
        response.headers = { 'content-type': 'application/json' };
        calls[index].response = response;
        request.emit('response', response);
        if (step.response) step.response(response);
        else response.end(step.text ?? '{"ok":true}');
      });
    };
    calls.push({ url, options, request, socket });
    queueMicrotask(() => {
      request.emit('socket', socket);
      if (step.reused) { /* The socket was marked verified before delivery below. */ }
      else if (step.failure) request.emit('error', step.failure);
      else if (step.connect !== false) {
        socket.authorized = step.authorized ?? true;
        socket.emit('secureConnect');
      }
      step.after?.({ request, socket });
    });
    if (step.reused) socket.authorized = true;
    return request;
  });
  return { calls, sends };
}

test('pre-handshake TLS failures recover without sending the login more than once', async t => {
  const { calls, sends } = mockTransport(t, [{ failure: tlsFailure() }, { failure: tlsFailure() }, {}]);
  const agent = { destroy: () => assert.fail('the shared agent must remain alive') };
  const body = '{"email":"fixture","password":"private-password"}';
  const result = await krillRequest(LOGIN, { agent, headers: { accept: 'application/json' } }, body);
  assert.deepEqual(result, { statusCode: 200, headers: { 'content-type': 'application/json' }, text: '{"ok":true}' });
  assert.equal(calls.length, 3);
  assert.deepEqual(sends, [{ index: 2, body }]);
  assert.ok(calls.slice(0, 2).every(call => call.request.destroyed && call.socket.destroyed));
  assert.equal(calls[2].request.destroyed, undefined);
  assert.equal(calls[2].socket.destroyed, undefined);
  assert.ok(calls.every(call => call.options.agent === agent && call.options.rejectUnauthorized === undefined));
});

test('handshake attempts stop at the fixed bound and preserve the final TLS error', async t => {
  const errors = Array.from({ length: MAX_ATTEMPTS }, tlsFailure);
  const { calls, sends } = mockTransport(t, errors.map(failure => ({ failure })));
  await assert.rejects(krillRequest(IDENTITY), error => error === errors.at(-1));
  assert.equal(calls.length, MAX_ATTEMPTS);
  assert.deepEqual(sends, []);
});

test('TLS alert 80 recovers before HTTP transmission without accepting unrelated SSL errors', async t => {
  const failure = Object.assign(new Error('TLS alert 80'), { code: 'ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR' });
  const { calls, sends } = mockTransport(t, [{ failure }, {}]);
  assert.equal(isHandshakeFailure(failure), true);
  assert.equal(isHandshakeFailure(tlsFailure()), true);
  for (const code of ['CERT_HAS_EXPIRED', 'ERR_TLS_CERT_ALTNAME_INVALID', 'ERR_SSL_UNSUPPORTED_PROTOCOL', 'ECONNRESET']) {
    assert.equal(isHandshakeFailure({ code }), false);
  }
  assert.equal((await krillRequest(LOGIN, {}, '{}')).statusCode, 200);
  assert.equal(calls.length, 2);
  assert.deepEqual(sends, [{ index: 1, body: '{}' }]);
});

test('HTTP responses are returned once without retrying login, authorization or upstream failures', async t => {
  for (const status of [302, 400, 401, 403, 429, 500]) {
    const ctx = mockTransport(t, [{ status }]);
    assert.equal((await krillRequest(LOGIN, {}, '{}')).statusCode, status);
    assert.equal(ctx.calls.length, 1);
    assert.equal(ctx.sends.length, 1);
    t.mock.restoreAll();
  }
});

test('TLS failures after a verified handshake never repeat a submitted login', async t => {
  const error = tlsFailure();
  const { calls, sends } = mockTransport(t, [{ respond: false, send: ({ request }) => queueMicrotask(() => request.emit('error', error)) }]);
  await assert.rejects(krillRequest(LOGIN, {}, '{}'), value => value === error);
  assert.equal(calls.length, 1);
  assert.equal(sends.length, 1);
});

test('certificate validation failures never retry or send credentials', async t => {
  const error = Object.assign(new Error('Certificate expired'), { code: 'CERT_HAS_EXPIRED' });
  const { calls, sends } = mockTransport(t, [{ failure: error }]);
  await assert.rejects(krillRequest(LOGIN, {}, '{}'), value => value === error);
  assert.equal(calls.length, 1);
  assert.deepEqual(sends, []);
});

test('unverified TLS sockets cannot send credentials', async t => {
  const { calls, sends } = mockTransport(t, [{ authorized: false }]);
  await assert.rejects(krillRequest(LOGIN, {}, '{}'), { code: 'KRILL_TLS_UNVERIFIED' });
  assert.equal(calls.length, 1);
  assert.deepEqual(sends, []);
});

test('already verified keep-alive sockets send once and survive successful response consumption', async t => {
  const { calls, sends } = mockTransport(t, [{ reused: true }]);
  await krillRequest(IDENTITY);
  assert.deepEqual(sends, [{ index: 0, body: undefined }]);
  assert.equal(calls[0].socket.destroyed, undefined);
  assert.equal(calls[0].request.destroyed, undefined);
});

test('abort before or during a handshake stops attempts and releases only its connection', async t => {
  const controller = new AbortController(), reason = new Error('Cancelled by caller');
  const ctx = mockTransport(t, [{ connect: false, after: () => controller.abort(reason) }]);
  await assert.rejects(krillRequest(LOGIN, { signal: controller.signal }, '{}'), error => error === reason);
  assert.equal(ctx.calls.length, 1);
  assert.equal(ctx.calls[0].request.destroyed, true);
  assert.equal(ctx.calls[0].socket.destroyed, true);
  assert.deepEqual(ctx.sends, []);
  await assert.rejects(krillRequest(LOGIN, { signal: controller.signal }, '{}'), error => error === reason);
  assert.equal(ctx.calls.length, 1);
});

test('abort after a failed handshake prevents the next recovery attempt', async t => {
  const controller = new AbortController(), reason = new Error('Caller deadline');
  const { calls, sends } = mockTransport(t, [{ failure: tlsFailure(), after: () => controller.abort(reason) }]);
  await assert.rejects(krillRequest(LOGIN, { signal: controller.signal }, '{}'), error => error === reason);
  assert.equal(calls.length, 1);
  assert.deepEqual(sends, []);
});

test('response truncation and oversize responses do not repeat a completed handshake', async t => {
  for (const response of [res => res.emit('aborted'), res => res.write(Buffer.alloc(1024 * 1024 + 1))]) {
    const ctx = mockTransport(t, [{ response }]);
    await assert.rejects(krillRequest(IDENTITY), /Incomplete Krill response|response too large/);
    assert.equal(ctx.calls.length, 1);
    assert.equal(ctx.sends.length, 1);
    assert.equal(ctx.calls[0].socket.destroyed, true);
    t.mock.restoreAll();
  }
});

test('transport accepts only fixed Krill endpoints with their intended methods', async t => {
  const ctx = mockTransport(t, []);
  for (const url of ['https://www.krill-code.com/api/auth/me?x=1', 'https://www.krill-code.com/api/subscription/reset-credits',
    'https://www.krill-code.com.evil.example/api/auth/login', 'https://api.kbsfdxc.com/api/auth/login', 'http://www.krill-code.com/api/auth/me',
    'https://user@www.krill-code.com/api/auth/me', 'https://www.krill-code.com:8443/api/auth/me']) {
    assert.equal(isKrillUrl(url), false);
    await assert.rejects(krillRequest(url, {}, '{}'), /target rejected/);
  }
  await assert.rejects(krillRequest(IDENTITY, {}, '{}'), /target rejected/);
  await assert.rejects(krillRequest(LOGIN), /target rejected/);
  assert.equal(ctx.calls.length, 0);
});
