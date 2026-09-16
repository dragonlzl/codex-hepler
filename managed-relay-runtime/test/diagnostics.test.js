const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const { Diagnostics } = require('../diagnostics');
const { createProxy } = require('../proxy');

test('diagnostics persist metadata with private permissions and rotate bounded files', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-diagnostics-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const log = new Diagnostics(home, { maxBytes: 230 });
  for (let n = 0; n < 6; n++) log.record({
    event: 'relay_request', requestId: String(n), status: 200, responseBytes: 10,
    authorization: 'Bearer secret', body: 'private prompt', url: '/responses?key=secret',
  });
  await log.close();
  const current = await fs.readFile(log.file, 'utf8');
  const previous = await fs.readFile(log.file + '.1', 'utf8');
  assert.ok(Buffer.byteLength(current) <= 230);
  assert.ok(Buffer.byteLength(previous) <= 230);
  assert.equal(JSON.parse(current.trim().split('\n').at(-1)).requestId, '5');
  assert.equal(/secret|private prompt/.test(current + previous), false);
  assert.equal((await fs.stat(log.file)).mode & 0o777, 0o600);
  assert.equal(log.snapshot().logError, null);
});

test('a log write failure stays observable and does not reject the request path', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-diagnostics-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  await fs.writeFile(path.join(home, 'relay-ui-runtime'), 'blocked');
  const log = new Diagnostics(home);
  assert.doesNotThrow(() => log.record({ event: 'relay_request', status: 200 }));
  await log.close();
  assert.ok(log.snapshot().logError);
  assert.equal(log.snapshot().events[0].status, 200);
});

test('arrival is observed before route lookup; cancellation retains actual upstream status and bytes', async t => {
  const starts = [];
  const results = [];
  let release;
  const ready = new Promise(resolve => { release = resolve; });
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: partial\n\n');
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const proxy = createProxy({ activeEntry: async () => {
    await ready;
    return { name: 'test', value: 'private-key', baseurl: `http://127.0.0.1:${upstream.address().port}` };
  } }, entry => results.push(entry), 2000, undefined, 1000, entry => starts.push(entry));
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    proxy.closeProxyConnections(); upstream.closeAllConnections();
    await Promise.all([new Promise(resolve => proxy.close(resolve)), new Promise(resolve => upstream.close(resolve))]);
  });
  const req = http.get(`http://127.0.0.1:${proxy.address().port}/v1/responses?token=secret`);
  const response = once(req, 'response');
  for (let n = 0; n < 50 && !starts.length; n++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(starts.length, 1);
  assert.equal(starts[0].phase, 'received');
  assert.equal(starts[0].endpoint, '/responses');
  assert.equal(JSON.stringify(starts).includes('secret'), false);
  assert.equal(results.length, 0);
  release();
  const [res] = await response;
  await once(res, 'data');
  res.destroy();
  for (let n = 0; n < 50 && !results.length; n++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(results[0].requestId, starts[0].requestId);
  assert.equal(results[0].status, 499);
  assert.equal(results[0].upstreamStatus, 200);
  assert.equal(results[0].responseBytes, Buffer.byteLength('data: partial\n\n'));
  assert.equal(results[0].responseComplete, false);
  assert.equal(JSON.stringify(results).includes('private-key'), false);
});
