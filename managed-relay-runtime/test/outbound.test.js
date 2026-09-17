const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { once } = require('node:events');
const { Outbound, systemProxyFor, bypasses, safeError } = require('../outbound');
const { createProxy } = require('../proxy');

async function temp(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-outbound-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

async function listen(t, server) {
  const sockets = new Set();
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}`;
}

function request(url, agent, options = {}) {
  return new Promise((resolve, reject) => {
    const req = (url.startsWith('https:') ? https : http).get(url, { ...options, agent }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    const timer = setTimeout(() => req.destroy(Object.assign(new Error('test timeout'), { code: 'TEST_TIMEOUT' })), 5000);
    req.on('error', reject); req.on('close', () => clearTimeout(timer));
  });
}

test('macOS proxy selection supports HTTP CONNECT, SOCKS, PAC and exceptions', () => {
  const target = new URL('https://upstream.invalid/models');
  assert.deepEqual(systemProxyFor(target, { HTTPSEnable: 1, HTTPSProxy: '127.0.0.1', HTTPSPort: 7892 }), { source: 'system-https', proxyUrl: 'http://127.0.0.1:7892' });
  assert.equal(systemProxyFor(target, { SOCKSEnable: 1, SOCKSProxy: '::1', SOCKSPort: 7892 }).proxyUrl, 'socks5h://[::1]:7892');
  assert.equal(systemProxyFor(target, { ProxyAutoConfigEnable: 1, ProxyAutoConfigURLString: 'http://127.0.0.1:7892/proxy.pac' }).source, 'system-pac');
  assert.equal(bypasses('api.example.test', { ExceptionsList: ['*.example.test'] }), true);
  assert.equal(bypasses('apiXexampleXtest', { ExceptionsList: ['*.example.test'] }), false);
  assert.equal(bypasses('192.168.2.8', { ExceptionsList: ['192.168.0.0/16'] }), true);
  assert.equal(bypasses('::1', { ExceptionsList: ['::1/128'] }), true);
  assert.equal(bypasses('printer', { ExcludeSimpleHostnames: 1 }), true);
  assert.throws(() => systemProxyFor(target, { ProxyAutoDiscoveryEnable: 1 }), /WPAD/);
});

test('auto re-reads system proxy on VPN toggle; local endpoints never enter VPN proxy', async t => {
  let clock = 0;
  let reads = 0;
  let settings = {};
  const o = new Outbound(await temp(t), { readSystem: async () => { reads++; return settings; }, readFlyingBird: async () => null, envProxy: () => '', clock: () => clock, cacheMs: 2000 });
  t.after(() => o.close());
  assert.equal((await o.resolve('https://upstream.invalid')).source, 'direct');
  settings = { HTTPSEnable: 1, HTTPSProxy: '127.0.0.1', HTTPSPort: 7892 };
  clock = 2001;
  assert.equal((await o.resolve('https://upstream.invalid')).source, 'system-https');
  assert.equal((await o.resolve('http://127.0.0.1:3211/v1')).source, 'loopback');
  assert.equal((await o.resolve('http://[::1]:3211')).source, 'loopback');
  assert.equal(reads, 2);
  settings = {}; clock = 4002;
  assert.equal((await o.resolve('https://upstream.invalid')).source, 'direct');
});

test('auto mode uses a confirmed FlyingBird mixed port when system and environment proxies are absent', async t => {
  let probes = 0;
  const o = new Outbound(await temp(t), {
    readSystem: async () => ({}),
    envProxy: () => '',
    readFlyingBird: async () => { probes++; return { proxyUrl: 'http://127.0.0.1:7892', source: 'flyingbird-auto', port: 7892, pid: 1234 }; },
  });
  t.after(() => o.close());
  assert.deepEqual(await o.resolve('https://vpn-only.invalid/models'), {
    proxyUrl: 'http://127.0.0.1:7892', source: 'flyingbird-auto', label: 'http://127.0.0.1:7892',
  });
  assert.equal((await o.resolve('http://127.0.0.1:3211/v1')).source, 'loopback');
  assert.equal(probes, 1);
});

test('auto mode falls back to confirmed FlyingBird when an enabled system proxy is inapplicable to the target', async t => {
  const o = new Outbound(await temp(t), {
    readSystem: async () => ({ HTTPEnable: 1, HTTPProxy: '127.0.0.1', HTTPPort: 7891 }),
    envProxy: () => '',
    readFlyingBird: async () => ({ proxyUrl: 'http://127.0.0.1:7892', source: 'flyingbird-auto' }),
  });
  t.after(() => o.close());
  assert.equal((await o.resolve('https://vpn-only.invalid/models')).source, 'flyingbird-auto');
});

test('manual settings persist separately; reject own ports; do not silently use direct on system read error', async t => {
  const home = await temp(t);
  const o = new Outbound(home, { localPorts: [3211, 3790], readSystem: async () => { throw new Error('read failed'); }, envProxy: () => '' });
  t.after(() => o.close());
  await assert.rejects(o.resolve('https://upstream.invalid'), /read failed/);
  await assert.rejects(o.save({ mode: 'proxy', proxyUrl: 'http://127.0.0.1:3211' }), /自己/);
  await assert.rejects(o.save({ mode: 'proxy', proxyUrl: 'http://secret:password@127.0.0.1:7892' }), /账号密码/);
  await o.save({ mode: 'proxy', proxyUrl: 'socks5h://127.0.0.1:7892' });
  assert.equal((await o.resolve('https://upstream.invalid')).source, 'manual');
  assert.equal((await fs.stat(o.file)).mode & 0o777, 0o600);
  await o.save({ mode: 'direct' });
  assert.equal((await o.resolve('https://upstream.invalid')).source, 'direct');
});

test('environment proxy and system exclusions are respected without leaking credentials', async t => {
  const o = new Outbound(await temp(t), { readSystem: async () => ({}), readFlyingBird: async () => null, envProxy: url => url.includes('bypass.invalid') ? '' : 'http://user:password@127.0.0.1:9999' });
  t.after(() => o.close());
  assert.equal((await o.resolve('https://upstream.invalid')).label, 'http://127.0.0.1:9999');
  assert.equal((await o.resolve('https://bypass.invalid')).label, 'DIRECT');
  const error = safeError({ code: 'ECONNREFUSED', message: 'Bearer secret', errors: [{ code: 'ETIMEDOUT', message: 'password' }] });
  assert.deepEqual(error, { errorCode: 'ECONNREFUSED', causeCodes: ['ETIMEDOUT'] });
  assert.equal(JSON.stringify(error).includes('secret'), false);
});

test('HTTP forwarding actually uses the system proxy and preserves body and upstream key', async t => {
  let captured;
  const server = http.createServer((req, res) => {
    let body = ''; req.on('data', c => body += c); req.on('end', () => {
      captured = { url: req.url, auth: req.headers.authorization, body };
      res.end('via-flyingbird-compatible-proxy');
    });
  });
  const url = await listen(t, server);
  const o = new Outbound(await temp(t), { readSystem: async () => ({ HTTPEnable: 1, HTTPProxy: '127.0.0.1', HTTPPort: Number(new URL(url).port) }), envProxy: () => '' });
  t.after(() => o.close());
  const logs = [];
  const relay = createProxy({ activeEntry: async () => ({ name: '中转测试', value: 'sk-upstream', baseurl: 'http://unresolvable.invalid/v1' }) }, log => logs.push(log), 3000, o);
  const local = await listen(t, relay);
  const response = await fetch(local + '/v1/responses', { method: 'POST', body: 'body-content', headers: { authorization: 'Bearer client-key' } });
  assert.equal(await response.text(), 'via-flyingbird-compatible-proxy');
  assert.deepEqual(captured, { url: 'http://unresolvable.invalid/v1/responses', auth: 'Bearer sk-upstream', body: 'body-content' });
  assert.equal(logs[0].outboundSource, 'system-http');
  assert.equal(logs[0].outbound, url);
  assert.equal(JSON.stringify(logs).includes('sk-upstream'), false);
});

test('HTTPS uses CONNECT and verifies TLS using the configured CA', async t => {
  const dir = await temp(t);
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem'), '-days', '1', '-subj', '/CN=upstream.invalid', '-addext', 'subjectAltName=DNS:upstream.invalid'], { stdio: 'ignore' });
  const cert = await fs.readFile(path.join(dir, 'cert.pem'));
  const tls = https.createServer({ cert, key: await fs.readFile(path.join(dir, 'key.pem')) }, (req, res) => res.end('tls-ok'));
  await listen(t, tls);
  let connectHost;
  const proxy = http.createServer();
  proxy.on('connect', (req, socket, head) => {
    connectHost = req.url;
    const upstream = net.connect(tls.address().port, '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    socket.on('error', () => upstream.destroy()); socket.on('close', () => upstream.destroy()); upstream.on('error', () => socket.destroy());
  });
  const proxyUrl = await listen(t, proxy);
  const o = new Outbound(dir, { envProxy: () => '', readSystem: async () => ({}) });
  t.after(() => o.close());
  await o.save({ mode: 'proxy', proxyUrl });
  const route = await o.resolve('https://upstream.invalid/models');
  const response = await request('https://upstream.invalid/models', o.agent(route), { ca: cert });
  assert.equal(response.body, 'tls-ok');
  assert.equal(connectHost, 'upstream.invalid:443');
  await assert.rejects(request('https://upstream.invalid/models', o.agent(route)), error => /CERT/.test(error.code));
});

test('PAC smart rule is evaluated and routes an unresolvable host through its chosen proxy', async t => {
  const proxyUrl = await listen(t, http.createServer((req, res) => res.end('pac-ok')));
  const script = 'function FindProxyForURL(url, host) { return "PROXY 127.0.0.1:' + new URL(proxyUrl).port + '"; }';
  const pacUrl = await listen(t, http.createServer((req, res) => { res.setHeader('content-type', 'application/x-ns-proxy-autoconfig'); res.end(script); }));
  const o = new Outbound(await temp(t), { readSystem: async () => ({ ProxyAutoConfigEnable: 1, ProxyAutoConfigURLString: pacUrl + '/proxy.pac' }), envProxy: () => '' });
  t.after(() => o.close());
  const route = await o.resolve('http://unresolvable.invalid/models');
  assert.equal(route.source, 'system-pac');
  assert.equal((await request('http://unresolvable.invalid/models', o.agent(route))).body, 'pac-ok');
});

test('SOCKS5h sends the destination hostname to the VPN for remote DNS', async t => {
  const upstream = http.createServer((req, res) => res.end('socks-ok'));
  await listen(t, upstream);
  let host;
  const socks = net.createServer(socket => {
    let buffer = Buffer.alloc(0); let stage = 'greeting';
    const onData = chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      if (stage === 'greeting') {
        if (buffer.length < 2 || buffer.length < 2 + buffer[1]) return;
        buffer = buffer.subarray(2 + buffer[1]); stage = 'request'; socket.write(Buffer.from([5, 0]));
      }
      if (stage === 'request') {
        if (buffer.length < 5) return;
        assert.equal(buffer[3], 3);
        const end = 5 + buffer[4]; if (buffer.length < end + 2) return;
        host = buffer.subarray(5, end).toString();
        socket.removeListener('data', onData);
        const target = net.connect(upstream.address().port, '127.0.0.1', () => {
          socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 80]));
          if (buffer.length > end + 2) target.write(buffer.subarray(end + 2));
          socket.pipe(target).pipe(socket);
        });
        socket.on('close', () => target.destroy()); socket.on('error', () => target.destroy()); target.on('error', () => socket.destroy());
      }
    }; socket.on('data', onData);
  });
  await listen(t, socks);
  const o = new Outbound(await temp(t)); t.after(() => o.close());
  await o.save({ mode: 'proxy', proxyUrl: 'socks5h://127.0.0.1:' + socks.address().port });
  const route = await o.resolve('http://unresolvable.invalid/models');
  assert.equal((await request('http://unresolvable.invalid/models', o.agent(route))).body, 'socks-ok');
  assert.equal(host, 'unresolvable.invalid');
});

test('stalled proxy CONNECT has a deadline and logs an error instead of waiting indefinitely', async t => {
  const stuck = http.createServer(); stuck.on('connect', () => {});
  const proxyUrl = await listen(t, stuck);
  const o = new Outbound(await temp(t)); t.after(() => o.close());
  await o.save({ mode: 'proxy', proxyUrl });
  const logs = [];
  const relay = createProxy({ activeEntry: async () => ({ name: 'VPN中转', value: 'sk-secret', baseurl: 'https://unresolvable.invalid/v1' }) }, record => logs.push(record), 1000, o, 100);
  const url = await listen(t, relay);
  const response = await fetch(url + '/v1/responses');
  assert.equal(response.status, 502);
  assert.equal(logs[0].errorCode, 'CONNECT_TIMEOUT');
  assert.equal(logs[0].phase, 'proxy-connect');
  assert.equal(logs.length, 1);
});

test('proxy refusal is not retried directly and cancellation is explicitly attributed to the client', async t => {
  const refusing = http.createServer(); let attempts = 0;
  refusing.on('connect', (req, socket) => { attempts++; socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n'); });
  const proxyUrl = await listen(t, refusing);
  const o = new Outbound(await temp(t)); t.after(() => o.close());
  await o.save({ mode: 'proxy', proxyUrl });
  const logs = [];
  const relay = createProxy({ activeEntry: async () => ({ name: 'VPN中转', value: 'sk-secret', baseurl: 'https://unresolvable.invalid/v1' }) }, record => logs.push(record), 1000, o, 500);
  const local = await listen(t, relay);
  assert.equal((await fetch(local + '/v1/responses')).status, 502);
  assert.equal(logs[0].proxyConnectStatus, 407);
  assert.equal(logs[0].errorCode, 'PROXY_CONNECT_REJECTED');
  assert.equal(attempts, 1);
  const waiting = http.createServer((req, res) => { res.writeHead(200); res.write('partial'); });
  const target = await listen(t, waiting);
  const cancelLogs = [];
  const relay2 = createProxy({ activeEntry: async () => ({ name: 'local', value: 'sk-key', baseurl: target }) }, record => cancelLogs.push(record), 1000, o);
  const local2 = await listen(t, relay2);
  const req = http.get(local2 + '/v1/responses');
  const [response] = await once(req, 'response'); response.destroy();
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(cancelLogs[0].status, 499);
  assert.equal(cancelLogs[0].errorCode, 'CLIENT_DISCONNECTED');
});

test('WebSocket upgrades use the same outbound proxy and retain upstream auth', async t => {
  const target = http.createServer();
  target.on('upgrade', (req, socket) => {
    assert.equal(req.headers.authorization, 'Bearer sk-ws-key');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
    socket.on('data', data => socket.write(data));
  });
  await listen(t, target);
  let connections = 0;
  const tunnel = http.createServer();
  tunnel.on('connect', (req, socket, head) => {
    connections++;
    assert.equal(req.url, 'unresolvable.invalid:80');
    const peer = net.connect(target.address().port, '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) peer.write(head);
      socket.pipe(peer).pipe(socket);
    });
    socket.on('error', () => peer.destroy()); socket.on('close', () => peer.destroy()); peer.on('error', () => socket.destroy());
  });
  const proxyUrl = await listen(t, tunnel);
  const o = new Outbound(await temp(t)); t.after(() => o.close());
  await o.save({ mode: 'proxy', proxyUrl });
  const relay = createProxy({ activeEntry: async () => ({ name: 'WebSocket', value: 'sk-ws-key', baseurl: 'http://unresolvable.invalid/v1' }) }, () => {}, 3000, o);
  const local = await listen(t, relay);
  const client = net.connect(Number(new URL(local).port), '127.0.0.1');
  client.setTimeout(3000, () => client.destroy());
  await once(client, 'connect');
  client.write('GET /v1/responses HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
  const [response] = await once(client, 'data');
  assert.match(response.toString(), /101 Switching/);
  client.write('echo-frame');
  const [echo] = await once(client, 'data');
  assert.equal(echo.toString(), 'echo-frame');
  client.destroy();
  assert.equal(connections, 1);
});

test('diagnostics use the saved proxy route and do not expose upstream secrets', async t => {
  const proxy = http.createServer((req, res) => {
    assert.equal(req.url, 'http://unresolvable.invalid/v1/models');
    assert.equal(req.headers.authorization, 'Bearer sk-diag-secret');
    res.end('{"data":[]}');
  });
  const proxyUrl = await listen(t, proxy);
  const o = new Outbound(await temp(t)); t.after(() => o.close());
  await o.save({ mode: 'proxy', proxyUrl });
  const result = await o.test({ name: '测试', value: 'sk-diag-secret', baseurl: 'http://unresolvable.invalid/v1' });
  assert.equal(result.status, 200);
  assert.equal(result.source, 'manual');
  assert.equal(JSON.stringify(result).includes('sk-diag-secret'), false);
});
