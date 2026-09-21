const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const https = require('node:https');
const { execFileSync } = require('node:child_process');
const { requestResponse } = require('../intelligence-generation');

let directory, cert, key;
before(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'intelligence-tls-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', path.join(directory, 'key.pem'), '-out', path.join(directory, 'cert.pem'),
    '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
  [cert, key] = await Promise.all(['cert.pem', 'key.pem'].map(file => fs.readFile(path.join(directory, file))));
});
after(async () => { if (directory) await fs.rm(directory, { recursive: true, force: true }); });

async function fixture(t, { dropHandshakes = 1, handle } = {}) {
  const requests = [], signals = [], sockets = new Set();
  let connections = 0;
  const remember = socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {}); return socket; };
  const server = https.createServer({ cert, key }, async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    requests.push({ body: JSON.parse(raw), authorization: req.headers.authorization });
    if (handle) { handle(req, res); return; }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'OK' }] }] }));
  });
  server.on('connection', remember);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const gate = net.createServer(socket => {
    remember(socket);
    if (++connections <= dropHandshakes) { socket.destroy(); return; }
    const upstream = remember(net.connect(server.address().port, '127.0.0.1'));
    socket.pipe(upstream).pipe(socket);
    socket.on('close', () => upstream.destroy()); upstream.on('close', () => socket.destroy());
  });
  await new Promise(resolve => gate.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await Promise.all([gate, server].map(item => new Promise(resolve => item.close(resolve))));
  });
  const entry = { baseurl: 'https://127.0.0.1:' + gate.address().port + '/v1', value: 'private-test-key' };
  const outbound = {
    resolve: async () => ({ label: 'DIRECT' }),
    agent: (_route, signal) => {
      signals.push(signal);
      const agent = new https.Agent({ ca: cert, keepAlive: false });
      if (signal.aborted) agent.destroy(); else signal.addEventListener('abort', () => agent.destroy(), { once: true });
      return agent;
    },
  };
  return { requests, signals, connections: () => connections,
    call: (signal = new AbortController().signal) => requestResponse(entry, { model: 'test-model', effort: 'high' }, outbound, signal,
      [{ role: 'user', content: [{ type: 'input_text', text: '只回复 OK' }] }]) };
}

test('a TLS reset before sending HTTP reconnects once and submits exactly one model request', async t => {
  const f = await fixture(t);
  assert.equal((await f.call()).text, 'OK');
  assert.equal(f.connections(), 2);
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].authorization, 'Bearer private-test-key');
  assert.equal(f.requests[0].body.input[0].content[0].text, '只回复 OK');
  assert.equal(f.signals.length, 2);
  assert.ok(f.signals.every(signal => signal.aborted), 'each attempt releases its agent');
});

test('repeated pre-handshake resets stop after two connections with a specific, safe error', async t => {
  const f = await fixture(t, { dropHandshakes: Infinity });
  await assert.rejects(f.call(), error => error.status === 502 && /HTTPS 握手.*ECONNRESET.*尚未发送.*重连 1 次/.test(error.message));
  assert.equal(f.connections(), 2); assert.equal(f.requests.length, 0);
  assert.ok(f.signals.every(signal => signal.aborted));
});

test('a reset after receiving the model request never resubmits it', async t => {
  const f = await fixture(t, { dropHandshakes: 0, handle: req => req.socket.destroy() });
  await assert.rejects(f.call(), error => error.status === 502 && /连接被重置.*ECONNRESET/.test(error.message) && !error.message.includes('private-test-key'));
  assert.equal(f.connections(), 1); assert.equal(f.requests.length, 1);
});

test('an interrupted response stream never starts a second request', async t => {
  const f = await fixture(t, { dropHandshakes: 0, handle: (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"type":"response.output_text.delta","delta":"partial"}\n\n');
    setImmediate(() => res.destroy());
  } });
  await assert.rejects(f.call());
  assert.equal(f.connections(), 1); assert.equal(f.requests.length, 1);
});

test('cancelling between handshake attempts prevents reconnection', async t => {
  const f = await fixture(t, { dropHandshakes: Infinity });
  const controller = new AbortController();
  const pending = assert.rejects(f.call(controller.signal), { name: 'AbortError' });
  for (let i = 0; i < 100 && !f.signals[0]?.aborted; i++) await new Promise(resolve => setTimeout(resolve, 2));
  assert.equal(f.signals[0]?.aborted, true);
  controller.abort();
  await pending;
  assert.equal(f.connections(), 1); assert.equal(f.requests.length, 0);
});
