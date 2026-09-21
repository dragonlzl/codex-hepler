const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { Outbound, readMacProxies, systemProxyFor } = require('../outbound');
const { readWindowsProxies, windowsProxySettings } = require('../windows-proxy');

async function outboundFor(t, options = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-windows-proxy-'));
  const outbound = new Outbound(home, { readFlyingBird: async () => null, envProxy: () => '', ...options });
  t.after(async () => { outbound.close(); await fs.rm(home, { recursive: true, force: true }); });
  return outbound;
}

test('Windows shared proxy handles HTTPS through HTTP CONNECT and preserves IPv6', () => {
  for (const [address, expected] of [['127.0.0.1:7890', 'http://127.0.0.1:7890'], ['[::1]:7890', 'http://[::1]:7890'], ['proxy.example:80', 'http://proxy.example:80']]) {
    const settings = windowsProxySettings({ ProxyServer: address });
    assert.deepEqual(systemProxyFor(new URL('http://upstream.invalid'), settings), { proxyUrl: expected, source: 'system-http' });
    assert.deepEqual(systemProxyFor(new URL('https://www.packyapi.com/api/status'), settings), { proxyUrl: expected, source: 'system-https' });
  }
});

test('Windows protocol-specific proxy entries preserve protocol and SOCKS semantics', () => {
  const settings = windowsProxySettings({ ProxyServer: 'http=127.0.0.1:7890; https=127.0.0.1:7891;ftp=unused.invalid:21;socks=127.0.0.1:1080' });
  assert.equal(systemProxyFor(new URL('http://upstream.invalid'), settings).proxyUrl, 'http://127.0.0.1:7890');
  assert.equal(systemProxyFor(new URL('https://upstream.invalid'), settings).proxyUrl, 'http://127.0.0.1:7891');
  const socks = windowsProxySettings({ ProxyServer: 'socks=127.0.0.1:1080' });
  assert.equal(systemProxyFor(new URL('https://upstream.invalid'), socks).proxyUrl, 'socks4://127.0.0.1:1080');
  for (const protocol of ['socks4a', 'socks5', 'socks5h']) {
    const explicit = windowsProxySettings({ ProxyServer: `socks=${protocol}://[::1]:1081` });
    assert.equal(systemProxyFor(new URL('https://upstream.invalid'), explicit).proxyUrl, `${protocol}://[::1]:1081`);
  }
  const secure = windowsProxySettings({ ProxyServer: 'https=https://proxy.example:443' });
  assert.equal(systemProxyFor(new URL('https://upstream.invalid'), secure).proxyUrl, 'https://proxy.example:443');
});

test('Windows PAC and bypass settings are honored before manual proxy entries', () => {
  const settings = windowsProxySettings({ AutoConfigURL: 'http://127.0.0.1:7890/proxy.pac', ProxyServer: '127.0.0.1:7891', ProxyOverride: ' *.internal.example ; <local> ; 192.168.* ;' });
  assert.deepEqual(systemProxyFor(new URL('https://upstream.invalid'), settings), { source: 'system-pac', proxyUrl: 'pac+http://127.0.0.1:7890/proxy.pac' });
  for (const host of ['api.internal.example', 'printer', '192.168.1.2', 'localhost']) {
    assert.equal(systemProxyFor(new URL('https://' + host), settings).source, 'system-bypass');
  }
  assert.equal(systemProxyFor(new URL('https://apiXinternalXexample'), settings).source, 'system-bypass');
  assert.equal(systemProxyFor(new URL('https://api.internalXexample.com'), settings).source, 'system-pac');
});

test('invalid Windows settings are rejected rather than converted into a direct route', () => {
  for (const address of ['127.0.0.1:0', '127.0.0.1:70000', 'user:password@proxy.example:7890', 'http://proxy.example/path', 'https=', 'file:///private', 'http://proxy.example?token=private']) {
    assert.throws(() => windowsProxySettings({ ProxyServer: address }));
  }
  assert.throws(() => windowsProxySettings({ AutoConfigURL: 'javascript:private' }));
  assert.throws(() => windowsProxySettings({ AutoConfigURL: 'https://user:password@proxy.example/proxy.pac' }));
  for (const value of [null, [], 'invalid']) assert.throws(() => windowsProxySettings(value));
});

test('Windows reader runs hidden without shell profiles and bounds execution', async () => {
  const settings = await readWindowsProxies({ platform: 'win32', run: async (command, args, options) => {
    assert.equal(command, 'powershell.exe');
    assert.deepEqual(args.slice(0, 4), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command']);
    assert.match(args[4], /WinHttpGetIEProxyConfigForCurrentUser/);
    assert.match(args[4], /GlobalFree/);
    assert.equal(options.windowsHide, true);
    assert.equal(options.timeout, 3000);
    assert.equal(options.encoding, 'utf8');
    return { stdout: '\uFEFF' + JSON.stringify({ ProxyServer: '127.0.0.1:7890' }) };
  } });
  assert.equal(systemProxyFor(new URL('https://www.packyapi.com/api/status'), settings).proxyUrl, 'http://127.0.0.1:7890');
  assert.deepEqual(await readWindowsProxies({ platform: 'darwin', run: async () => { throw new Error('must not run'); } }), {});
});

test('Windows reader failures are actionable and never reveal raw errors', async () => {
  for (const run of [async () => { throw new Error('private proxy credentials'); }, async () => ({ stdout: 'private invalid JSON' }), async () => ({ stdout: 'null' })]) {
    await assert.rejects(readWindowsProxies({ platform: 'win32', run }), error => {
      assert.equal(error.status, 503);
      assert.match(error.message, /Windows.*指定代理/);
      assert.ok(!error.message.includes('private'));
      return true;
    });
  }
});

test('default system reader selects Windows or macOS for the current platform', async t => {
  const outbound = await outboundFor(t);
  assert.equal(outbound.readSystem, process.platform === 'win32' ? readWindowsProxies : readMacProxies);
});

test('Windows proxy toggle refreshes cached routes and respects system exclusions over environment', async t => {
  let now = 0;
  let reads = 0;
  let configuration = { ProxyServer: '127.0.0.1:7890', ProxyOverride: '*.internal.example' };
  const outbound = await outboundFor(t, { clock: () => now, envProxy: () => 'http://127.0.0.1:9999', readSystem: async () => { reads++; return windowsProxySettings(configuration); } });
  assert.equal((await outbound.resolve('https://www.packyapi.com/api/status')).label, 'http://127.0.0.1:7890');
  assert.equal((await outbound.resolve('https://api.internal.example')).source, 'system-bypass');
  assert.equal((await outbound.resolve('http://127.0.0.1:3790')).source, 'loopback');
  assert.equal(reads, 1);
  configuration = { ProxyServer: '127.0.0.1:7891' };
  now = 2001;
  assert.equal((await outbound.resolve('https://www.packyapi.com/api/status')).label, 'http://127.0.0.1:7891');
  configuration = {};
  now = 4002;
  assert.equal((await outbound.resolve('https://www.packyapi.com/api/status')).source, 'environment');
  assert.equal(reads, 3);
});

test('Windows default auto-detection without a proxy keeps environment and direct fallback available', async t => {
  const outbound = await outboundFor(t, { readSystem: async () => windowsProxySettings({ AutoDetect: true, ProxyServer: null, AutoConfigURL: null }) });
  assert.equal((await outbound.resolve('https://www.packyapi.com/api/status')).source, 'direct');
});

test('manual and direct modes do not depend on successful system proxy reads', async t => {
  const outbound = await outboundFor(t, { readSystem: async () => { throw new Error('system reader unavailable'); } });
  await outbound.save({ mode: 'direct' });
  assert.equal((await outbound.resolve('https://www.packyapi.com/api/status')).source, 'direct');
  await outbound.save({ mode: 'proxy', proxyUrl: 'http://127.0.0.1:7890' });
  assert.equal((await outbound.resolve('https://www.packyapi.com/api/status')).source, 'manual');
});

test('Windows normalized settings send actual requests through the selected proxy', async t => {
  const server = http.createServer((request, response) => {
    assert.equal(request.url, 'http://unresolvable.invalid/api/status');
    response.end('windows-proxy-ok');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const outbound = await outboundFor(t, { readSystem: async () => windowsProxySettings({ ProxyServer: '127.0.0.1:' + server.address().port }) });
  const target = 'http://unresolvable.invalid/api/status';
  const route = await outbound.resolve(target);
  const body = await new Promise((resolve, reject) => {
    const request = http.get(target, { agent: outbound.agent(route), signal: AbortSignal.timeout(3000) }, response => {
      let text = '';
      response.on('data', chunk => { text += chunk; });
      response.on('error', reject);
      response.on('end', () => resolve(text));
    });
    request.on('error', reject);
  });
  assert.equal(body, 'windows-proxy-ok');
});
