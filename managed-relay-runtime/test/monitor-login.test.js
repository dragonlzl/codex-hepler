const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const https = require('node:https');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { MonitorLogin, LOGIN_ENDPOINT, TOTP_ENDPOINT } = require('../monitor-login');
const { MonitorAuth } = require('../monitor-auth');
const { Availability, requestJson } = require('../availability');
const { ENDPOINT } = require('../availability-blackaicoding');
const { start } = require('../../managed-relay-server');
const fixture = require('./monitor-login-fixture');
const credentials = { site: 'blackaicoding', username: 'normal', password: fixture.PASSWORD };

async function tempHome(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'monitor-login-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  return home;
}

test('password login verifies monitor access and persists only the access token with private permissions', async t => {
  const home = await tempHome(t);
  const calls = [];
  const monitor = new Availability({}, { home, request: async (url, options) => {
    calls.push(url);
    if (url === LOGIN_ENDPOINT) {
      assert.deepEqual(options.json, { email: 'normal', password: fixture.PASSWORD });
      assert.equal(options.token, undefined);
    } else {
      assert.equal(options.json, undefined);
      assert.equal(options.token, fixture.TOKEN);
    }
    return fixture.request(url, options);
  } });
  t.after(() => monitor.close());
  const result = await monitor.login({ ...credentials, username: ' normal ' });
  assert.deepEqual(calls, [LOGIN_ENDPOINT, ENDPOINT]);
  assert.ok(result.expiresAt > Date.now());
  const auth = new MonitorAuth(home);
  const disk = JSON.parse(await fs.readFile(auth.file, 'utf8'));
  assert.deepEqual(Object.keys(disk).sort(), ['expiresAt', 'token']);
  assert.equal(disk.token, fixture.TOKEN);
  if (process.platform !== 'win32') assert.equal((await fs.stat(auth.file)).mode & 0o777, 0o600);
  const serialized = JSON.stringify(result);
  for (const secret of [fixture.TOKEN, fixture.PASSWORD, fixture.REFRESH_TOKEN]) assert.ok(!serialized.includes(secret));
});

test('failed login or monitor verification preserves existing credentials without reflecting provider secrets', async t => {
  const home = await tempHome(t);
  const auth = new MonitorAuth(home);
  await auth.save(fixture.TOKEN);
  for (const request of [
    async () => { throw Object.assign(new Error(fixture.PASSWORD), { status: 401 }); },
    async url => url === LOGIN_ENDPOINT ? { code: 0, data: { access_token: fixture.TOKEN } } : Promise.reject(Object.assign(new Error(fixture.TOKEN), { status: 403 })),
    async () => ({ code: 'INVALID_CREDENTIALS', message: fixture.PASSWORD }),
    async () => ({ code: 0, data: { access_token: 'not-a-token' } }),
  ]) {
    const monitor = new Availability({}, { home, request });
    await assert.rejects(monitor.login(credentials), error => !error.message.includes(fixture.PASSWORD) && !error.message.includes(fixture.TOKEN));
    assert.equal((await auth.read()).token, fixture.TOKEN);
    monitor.close();
  }
});

test('two-factor login keeps provider challenge on server, permits code retry, and is single use', async t => {
  const monitor = new Availability({}, { home: await tempHome(t), request: fixture.request });
  t.after(() => monitor.close());
  const challenge = await monitor.login({ ...credentials, username: 'otp' });
  assert.equal(challenge.requires2fa, true);
  assert.ok(!JSON.stringify(challenge).includes(fixture.TEMP_TOKEN));
  assert.equal(await monitor.auths.get('blackaicoding').read(), null);
  const step = { site: 'blackaicoding', challengeId: challenge.challengeId, code: '000000' };
  await assert.rejects(monitor.login(step), /验证码无效/);
  await monitor.login({ ...step, code: '123456' });
  assert.equal((await monitor.auths.get('blackaicoding').read()).token, fixture.TOKEN);
  await assert.rejects(monitor.login({ ...step, code: '123456' }), error => error.status === 410);
  assert.equal(monitor.loginClients.get('blackaicoding').challenges.size, 0);
});

test('challenge cancel, expiry, clearing authorization and closing invalidate two-factor state', async t => {
  let now = Date.now();
  const monitor = new Availability({}, { home: await tempHome(t), clock: () => now, request: fixture.request });
  t.after(() => monitor.close());
  for (const invalidate of [
    id => monitor.cancelLogin('blackaicoding', id),
    () => { now += 300001; },
    () => monitor.authorize('blackaicoding', ''),
  ]) {
    const challenge = await monitor.login({ ...credentials, username: 'otp' });
    await invalidate(challenge.challengeId);
    await assert.rejects(monitor.login({ site: 'blackaicoding', challengeId: challenge.challengeId, code: '123456' }), error => error.status === 410);
  }
  await monitor.login({ ...credentials, username: 'otp' });
  monitor.close();
  assert.equal(monitor.loginClients.get('blackaicoding').challenges.size, 0);
  await assert.rejects(monitor.login(credentials));
});

test('invalid inputs never reach upstream; bounded challenges and safe throttling/captcha errors', async () => {
  let calls = 0;
  const signal = new AbortController().signal;
  const client = new MonitorLogin(async (...args) => { calls++; return fixture.request(...args); });
  for (const value of [{}, { username: '', password: fixture.PASSWORD }, { username: 'normal', password: '' }, { challengeId: 'unknown', code: '123456' }]) {
    await assert.rejects(client.login(value, signal));
  }
  assert.equal(calls, 0);
  for (let i = 0; i < 10; i++) await client.login({ ...credentials, username: 'otp' }, signal);
  assert.equal(client.challenges.size, 8);
  client.clear();
  for (const [request, pattern] of [
    [async () => { throw Object.assign(new Error(fixture.PASSWORD), { status: 429 }); }, /频繁/],
    [async () => ({ code: 'CAPTCHA_REQUIRED', message: fixture.PASSWORD }), /人机验证/],
    [async () => ({ code: 0, data: { requires_2fa: true } }), /响应异常/],
  ]) await assert.rejects(new MonitorLogin(request).login(credentials, signal), pattern);
});

test('closing or cancelling while upstream is pending cannot grant authorization', async t => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const monitor = new Availability({}, { home: await tempHome(t), request: async () => pending });
  const login = monitor.login(credentials);
  await new Promise(resolve => setImmediate(resolve));
  monitor.close();
  release({ code: 0, data: { access_token: fixture.TOKEN } });
  await assert.rejects(login);
  assert.equal(await monitor.auths.get('blackaicoding').read(), null);

  let releaseOtp;
  const client = new MonitorLogin((url, options) => url === TOTP_ENDPOINT ? new Promise(resolve => { releaseOtp = resolve; }) : fixture.request(url, options));
  const signal = new AbortController().signal;
  const challenge = await client.login({ ...credentials, username: 'otp' }, signal);
  const verification = client.login({ challengeId: challenge.challengeId, code: '123456' }, signal);
  client.cancel(challenge.challengeId);
  releaseOtp({ code: 0, data: { access_token: fixture.TOKEN } });
  await assert.rejects(verification, error => error.status === 410);
});

test('login POST transport is confined to exact TLS endpoints, refuses redirects and excludes bearer headers', async t => {
  let calls = 0, status = 200;
  t.mock.method(https, 'request', (url, options) => {
    calls++;
    assert.ok([LOGIN_ENDPOINT, TOTP_ENDPOINT].includes(url));
    assert.equal(options.method, 'POST');
    assert.equal(options.headers.authorization, undefined);
    assert.equal(options.headers['content-type'], 'application/json');
    const request = new EventEmitter();
    request.destroy = () => {};
    request.end = body => {
      assert.equal(options.headers['content-length'], Buffer.byteLength(body));
      assert.deepEqual(JSON.parse(body), { email: 'normal', password: fixture.PASSWORD });
      setImmediate(() => {
        const response = new PassThrough(); response.statusCode = status;
        request.emit('response', response); response.end('{"code":0}');
      });
    };
    return request;
  });
  const options = { outbound: { resolve: async () => ({}), agent: () => false }, signal: new AbortController().signal, json: { email: 'normal', password: fixture.PASSWORD } };
  for (const url of [ENDPOINT, 'https://blackaicoding.com.evil.example/api/v1/auth/login', LOGIN_ENDPOINT + '?redirect=1', LOGIN_ENDPOINT.replace('https:', 'http:')]) {
    await assert.rejects(requestJson(url, options), /target rejected/);
  }
  await assert.rejects(requestJson(LOGIN_ENDPOINT, { ...options, token: fixture.TOKEN }), /target rejected/);
  assert.equal(calls, 0);
  assert.deepEqual(await requestJson(LOGIN_ENDPOINT, options), { code: 0 });
  status = 302;
  await assert.rejects(requestJson(LOGIN_ENDPOINT, options), error => error.status === 302);
  assert.equal(calls, 2);
});

test('local login API protects origin and exposes neither login secrets nor tokens in responses or logs', async t => {
  const home = await tempHome(t);
  await fs.writeFile(path.join(home, 'config.toml'), 'model_provider="relay"\n[model_providers.relay]\nbase_url="https://blackaicoding.com"\n');
  await fs.writeFile(path.join(home, 'key_config.json'), JSON.stringify({ keys: [{ name: 'code for me', baseurl: 'https://blackaicoding.com', value: 'sk-fixture' }] }));
  const logs = [];
  const app = await start({ home, uiPort: 0, proxyPort: 0, availabilityOptions: { request: fixture.request }, log: entry => logs.push(entry) });
  t.after(() => app.close());
  const post = (body, origin = app.uiUrl, endpoint = '/api/availability/login') => fetch(app.uiUrl + endpoint, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify(body) });
  assert.equal((await post(credentials, 'https://evil.example')).status, 403);
  const challengeResponse = await post({ ...credentials, username: 'otp' });
  assert.equal(challengeResponse.status, 200);
  const challenge = await challengeResponse.json();
  const complete = await post({ site: 'blackaicoding', challengeId: challenge.challengeId, code: '123456' });
  assert.equal(complete.status, 200);
  const result = await complete.json();
  const snapshot = await (await fetch(app.uiUrl + '/api/availability')).json();
  assert.equal(snapshot.rows[0].state, 'available');
  assert.deepEqual(Object.keys(snapshot.rows[0].balance).sort(), ['amount', 'currency', 'fetchedAt', 'state']);
  assert.equal(snapshot.rows[0].balance.amount, 1234.56789);
  for (const secret of [fixture.PASSWORD, fixture.TEMP_TOKEN, fixture.TOKEN, fixture.REFRESH_TOKEN]) {
    assert.ok(!JSON.stringify({ challenge, result, logs, snapshot }).includes(secret));
  }
  assert.equal((await post({ site: 'blackaicoding', token: '' }, app.uiUrl, '/api/availability/authorization')).status, 200);
  assert.equal((await (await fetch(app.uiUrl + '/api/availability')).json()).rows[0].state, 'auth-required');
});
