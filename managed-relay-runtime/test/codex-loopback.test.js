const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

test('installed Codex honors NO_PROXY for a local relay while HTTP_PROXY is set', {
  skip: !process.env.CODEX_LOOPBACK_TEST_BIN,
  timeout: 25000,
}, async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-loopback-test-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  for (const bypass of [false, true]) {
    let finish;
    const arrived = new Promise(resolve => { finish = resolve; });
    const upstream = http.createServer((req, res) => {
      req.resume(); res.end('{}'); finish('relay');
    });
    const proxy = http.createServer((req, res) => {
      req.resume(); res.writeHead(502); res.end();
      if (req.url.includes(`127.0.0.1:${upstream.address().port}`)) finish('proxy');
    });
    proxy.on('connect', (req, socket) => {
      socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      if (req.url === `127.0.0.1:${upstream.address().port}`) finish('proxy');
    });
    await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
    await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
    const proxyUrl = `http://127.0.0.1:${proxy.address().port}`;
    const env = {
      PATH: process.env.PATH,
      CODEX_HOME: home,
      CODEX_LOOPBACK_KEY: 'dummy-local-test-key',
      HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl, ALL_PROXY: proxyUrl,
      NO_PROXY: bypass ? '127.0.0.1,localhost,::1' : '',
      no_proxy: bypass ? '127.0.0.1,localhost,::1' : '',
    };
    const args = ['exec', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check', '--sandbox', 'read-only', '--color', 'never', '-C', home,
      '-c', 'model_provider="loopback"', '-c', 'model="local-proxy-test"',
      '-c', 'model_providers.loopback.name="Local test"',
      '-c', `model_providers.loopback.base_url="http://127.0.0.1:${upstream.address().port}/v1"`,
      '-c', 'model_providers.loopback.wire_api="responses"',
      '-c', 'model_providers.loopback.env_key="CODEX_LOOPBACK_KEY"',
      'Reply OK.'];
    const child = spawn(process.env.CODEX_LOOPBACK_TEST_BIN, args, { cwd: home, env, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-2000); });
    const exited = new Promise(resolve => { child.once('exit', resolve); child.once('error', resolve); });
    let timer;
    try {
      const result = await Promise.race([
        arrived,
        exited.then(() => { throw new Error('Codex exited before making a request: ' + stderr); }),
        new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error('No local request within 10s: ' + stderr)), 10000); }),
      ]);
      assert.equal(result, bypass ? 'relay' : 'proxy');
    } finally {
      clearTimeout(timer);
      child.kill('SIGTERM');
      const killTimer = setTimeout(() => child.kill('SIGKILL'), 1000);
      await exited;
      clearTimeout(killTimer);
      upstream.closeAllConnections(); proxy.closeAllConnections();
      await Promise.all([new Promise(resolve => upstream.close(resolve)), new Promise(resolve => proxy.close(resolve))]);
    }
  }
});
