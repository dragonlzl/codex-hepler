const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { start } = require('../../managed-relay-server');

(async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-browser-'));
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const baseurl = `http://127.0.0.1:${upstream.address().port}/v1`;
  await fs.writeFile(path.join(home, 'config.toml'), `model_provider="original"\nmodel="test-model"\n[model_providers.original]\nname="Original identity"\nbase_url="${baseurl}"\nwire_api="responses"\nrequires_openai_auth=true\n`);
  await fs.writeFile(path.join(home, 'auth.json'), '{"OPENAI_API_KEY":"sk-test-0"}');
  await fs.writeFile(path.join(home, 'key_config.json'), JSON.stringify({ keys: Array.from({ length: 15 }, (_, i) => ({ name: i === 0 ? '中转站甲' : i === 1 ? '备用线路✨' : `测试中转 ${i}`, value: `sk-test-${i}`, baseurl })) }));
  const app = await start({ home, uiPort: 3791, proxyPort: 3212 });
  console.log(JSON.stringify({ ui: app.uiUrl, proxy: app.proxyUrl, home }));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => {
    await app.close();
    await new Promise(resolve => { upstream.close(resolve); upstream.closeAllConnections(); });
    await fs.rm(home, { recursive: true, force: true });
    process.exit(0);
  });
})().catch(error => { console.error(error); process.exitCode = 1; });
