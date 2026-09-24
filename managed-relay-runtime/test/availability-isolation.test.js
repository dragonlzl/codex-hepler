const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { Availability } = require('../availability');
const { Outbound } = require('../outbound');
const { requestResponse } = require('../intelligence-generation');

test('refresh timeout and monitor shutdown leave an ongoing model stream on the shared proxy alive', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'availability-isolation-'));
  let modelResponse, ready;
  const started = new Promise(resolve => { ready = resolve; });
  const proxy = http.createServer((req, res) => {
    if (req.url.endsWith('/responses')) {
      req.resume(); modelResponse = res;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(': waiting for model\n\n'); ready();
    } // The independent status request deliberately hangs until the monitor times out.
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const outbound = new Outbound(home);
  const route = { proxyUrl: 'http://127.0.0.1:' + proxy.address().port };
  await outbound.save({ mode: 'proxy', proxyUrl: route.proxyUrl });
  const monitor = new Availability(outbound, { timeoutMs: 50, auths: { input: { read: async () => ({ token: 'fixture' }) } }, request: (_url, { signal, outbound }) => new Promise((resolve, reject) => {
    // Both consumers use the real shared Outbound/ProxyAgent; HTTP keeps this local
    // fixture independent of external DNS, credentials and certificate trust.
    const req = http.get('http://status.invalid/api/status', { signal, agent: outbound.agent(route, signal) }, res => {
      res.resume(); res.on('end', () => resolve({}));
    });
    req.on('error', reject);
  }) });
  const controller = new AbortController();
  t.after(async () => {
    controller.abort(); await monitor.close(); outbound.close(); proxy.closeAllConnections();
    await new Promise(resolve => proxy.close(resolve));
    await fs.rm(home, { recursive: true, force: true });
  });
  const result = requestResponse({ name: 'Model', baseurl: 'http://model.invalid/v1', value: 'private-key' },
    { model: 'test-model', effort: 'high' }, outbound, controller.signal, [{ role: 'user', content: [{ type: 'input_text', text: 'OK' }] }]);
  await started;
  const snapshot = await monitor.snapshot([{ name: 'INPUT', baseurl: 'https://ai.input.im' }]);
  assert.equal(snapshot.rows[0].failure.code, 'REFRESH_TIMEOUT');
  assert.match(snapshot.rows[0].failure.message, /查询超时/);
  await monitor.close();
  assert.equal(controller.signal.aborted, false);
  assert.equal(modelResponse.destroyed, false);
  assert.equal(outbound.activeAgents.size, 1, 'only the model request agent remains active');
  modelResponse.end('data: ' + JSON.stringify({ type: 'response.completed', response: { status: 'completed',
    output: [{ type: 'message', content: [{ type: 'output_text', text: 'OK' }] }] } }) + '\n\n');
  assert.equal((await result).text, 'OK');
  assert.equal(outbound.activeAgents.size, 0);
});
