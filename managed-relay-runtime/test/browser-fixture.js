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
  const keys = process.env.RELAY_AVAILABILITY_FIXTURE
    ? [{ name: 'AI.INPUT.IM', value: 'sk-test-input', baseurl: 'https://ai.input.im' },
      { name: 'INPUT 备用', value: 'sk-test-input-backup', baseurl: 'https://ai.input.im/v1' },
      { name: 'code for me', value: 'sk-test-code-for-me', baseurl: 'https://blackaicoding.com' },
      { name: 'Aixor', value: 'sk-test-aixor', baseurl: 'https://aixor.org/v1' },
      { name: 'Aixor 备用', value: 'sk-test-aixor-backup', baseurl: 'https://aixor.cc/v1' },
      { name: 'packycode项目用', value: 'sk-test-packycode', baseurl: 'https://cf.api.fan/v1' },
      { name: 'packycode备用', value: 'sk-test-packycode-backup', baseurl: 'https://cf.api.fan/v1' },
      { name: 'Packycode 按量卡', value: 'sk-test-packycode-metered', baseurl: 'https://codex-api.packycode.com/v1' },
      { name: 'Krill', value: 'sk-test-krill', baseurl: 'https://api-slb.krill-code.net/codex/v1' },
      { name: 'Krill 周卡', value: 'sk-test-krill-weekly', baseurl: 'https://api.cdn-krill-ai.com/coding/v1' },
      { name: 'Krill 月卡', value: 'sk-test-krill-monthly', baseurl: 'https://api.cdn-krill-ai.com/codex/v1' },
      { name: 'rightcode', value: 'sk-test-rightcode', baseurl: 'https://www.rightapi.ai/v1' },
      { name: 'RC 备用', value: 'sk-test-rightcode-backup', baseurl: 'https://www.rightapi.ai/v1' },
      { name: 'timi', value: 'sk-test-timicc', baseurl: 'https://timicc.com' },
      { name: '其他中转', value: 'sk-test-other', baseurl }]
    : Array.from({ length: 15 }, (_, i) => ({ name: i === 0 ? '中转站甲' : i === 1 ? '备用线路✨' : `测试中转 ${i}`, value: `sk-test-${i}`, baseurl }));
  if (process.env.RELAY_GROUPING_FIXTURE) {
    keys[1].baseurl = keys[0].baseurl;
    keys.splice(1, 0, { ...keys[0], name: 'INPUT 团队共享' });
    keys.splice(4, 0, { ...keys[3], name: 'code for me 备用' });
    const config = await fs.readFile(path.join(home, 'config.toml'), 'utf8');
    await fs.writeFile(path.join(home, 'config.toml'), config.replace(baseurl, keys[0].baseurl));
    await fs.writeFile(path.join(home, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: keys[0].value }));
  }
  await fs.writeFile(path.join(home, 'key_config.json'), JSON.stringify({ keys }));
  const app = await start({ home, uiPort: Number(process.env.RELAY_UI_PORT || 3791), proxyPort: Number(process.env.RELAY_PROXY_PORT || 3212),
    ...(process.env.RELAY_LOGIN_FIXTURE ? { availabilityOptions: { request: require('./monitor-login-fixture').request,
      packyBalanceOptions: { request: async (url, { apiKey }) => ({ code: true, data: { name: 'Packycode 演示 Key', total_available: 200000000,
        total_granted: 250000000, total_used: 90000000, unlimited_quota: apiKey.endsWith('metered') } }) } } } : {}) });
  console.log(JSON.stringify({ ui: app.uiUrl, proxy: app.proxyUrl, home }));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => {
    await app.close();
    await new Promise(resolve => { upstream.close(resolve); upstream.closeAllConnections(); });
    await fs.rm(home, { recursive: true, force: true });
    process.exit(0);
  });
})().catch(error => { console.error(error); process.exitCode = 1; });
