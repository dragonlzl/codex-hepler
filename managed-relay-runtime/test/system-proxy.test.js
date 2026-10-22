const { test } = require('node:test');
const assert = require('node:assert/strict');
const { detectFlyingBirdProxy, systemProxyFor, bypasses, loopback } = require('../system-proxy');

function detector(output) {
  const calls = [];
  const options = {
    platform: 'darwin',
    run: async (executable, args) => {
      calls.push({ executable, args });
      return { stdout: executable.endsWith('/pgrep') ? '1404' : output };
    },
  };
  return { options, calls };
}

test('FlyingBird detection requires an owned listening port without opening connections', async () => {
  const { options, calls } = detector('FlyingBir 1404 user 10u IPv4 abc 0t0 TCP 127.0.0.1:7892 (LISTEN)\n');
  assert.deepEqual(await detectFlyingBirdProxy(options), {
    proxyUrl: 'http://127.0.0.1:7892', source: 'flyingbird-auto', port: 7892, pid: 1404,
  });
  assert.deepEqual(calls.map(call => call.executable), ['/usr/bin/pgrep', '/usr/sbin/lsof']);
  assert.deepEqual(calls[1].args, ['-nP', '-a', '-p', '1404', '-iTCP', '-sTCP:LISTEN']);
});

for (const state of ['ESTABLISHED', 'FIN_WAIT_2', 'CLOSE_WAIT', 'CLOSED']) {
  test(`FlyingBird detection rejects an existing ${state} connection without a listener`, async () => {
    const { options } = detector(`FlyingBir 1404 user 10u IPv4 abc 0t0 TCP 127.0.0.1:7892->127.0.0.1:54008 (${state})\n`);
    assert.equal(await detectFlyingBirdProxy(options), null);
  });
}

test('FlyingBird detection rejects a remote port match, a different listener and missing processes', async () => {
  for (const output of [
    'FlyingBir 1404 user 10u IPv4 abc 0t0 TCP 127.0.0.1:54008->203.0.113.1:7892 (ESTABLISHED)\n',
    'FlyingBir 1404 user 10u IPv4 abc 0t0 TCP 127.0.0.1:78920 (LISTEN)\n',
    '',
  ]) {
    assert.equal(await detectFlyingBirdProxy(detector(output).options), null);
  }
  assert.equal(await detectFlyingBirdProxy({ platform: 'darwin', run: async () => { throw new Error('missing process'); } }), null);
});

test('FlyingBird detection avoids commands on unsupported platforms or invalid ports', async () => {
  const run = async () => { assert.fail('must not inspect processes'); };
  assert.equal(await detectFlyingBirdProxy({ platform: 'win32', run }), null);
  for (const port of [-1, 65536, 'invalid']) {
    assert.equal(await detectFlyingBirdProxy({ platform: 'darwin', port, run }), null);
  }
});

test('system proxy extraction preserves route selection, bypasses and error status', () => {
  const target = new URL('wss://chatgpt.com/backend-api/codex/responses');
  assert.deepEqual(systemProxyFor(target, { HTTPSEnable: 1, HTTPSProxy: '127.0.0.1', HTTPSPort: 7892 }), {
    proxyUrl: 'http://127.0.0.1:7892', source: 'system-https',
  });
  assert.equal(systemProxyFor(target, { SOCKSEnable: 1, SOCKSProxy: '::1', SOCKSPort: 7892 }).proxyUrl, 'socks5h://[::1]:7892');
  assert.equal(systemProxyFor(target, { ProxyAutoConfigEnable: 1, ProxyAutoConfigURLString: 'https://proxy.invalid/config.pac' }).source, 'system-pac');
  assert.equal(loopback('[::1]'), true);
  assert.equal(bypasses('api.example.test', { ExceptionsList: ['*.example.test'] }), true);
  assert.equal(bypasses('apiXexampleXtest', { ExceptionsList: ['*.example.test'] }), false);
  for (const settings of [
    { ProxyAutoDiscoveryEnable: 1 },
    { HTTPSEnable: 1, HTTPSProxy: '', HTTPSPort: 7892 },
    { ProxyAutoConfigEnable: 1, ProxyAutoConfigURLString: 'ftp://proxy.invalid/config.pac' },
  ]) {
    assert.throws(() => systemProxyFor(target, settings), error => error instanceof Error && error.status === 503);
  }
});
