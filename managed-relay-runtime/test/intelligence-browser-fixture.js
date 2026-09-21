// Local-only end-to-end fixture: real Responses transport, persistence and Chrome screenshots.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { start } = require('../../managed-relay-server');

(async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-intelligence-browser-'));
  let sequence = 0;
  const upstream = http.createServer(async (req, res) => {
    if (!req.url.endsWith('/responses')) { res.end('{}'); return; }
    let body = ''; for await (const chunk of req) body += chunk;
    const input = JSON.parse(body), number = ++sequence;
    const reviewing = input.input?.[0]?.content?.some(item => item.type === 'input_image');
    if (input.model === 'fixture-fail') { res.writeHead(429); res.end('{"error":"fixture"}'); return; }
    if (reviewing && input.model === 'fixture-review-fail') { res.writeHead(503); res.end('{}'); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(': fixture generating\n\n');
    const timer = setTimeout(() => {
      if (reviewing) {
        const degraded = req.url.startsWith('/b/');
        const result = { status: 'completed', verdict: degraded ? '降智' : '正常',
          summary: degraded ? '本地验证：主体可辨识，但缺少与曲柄配合的踩踏动作。' : '本地验证：主体结构完整，整体完成度接近基准。',
          findings: [{ dimension: '动画实现', source: '截图与代码', observation: degraded ? '测试样本的腿部路径固定，车轮旋转不能代替腿脚踩踏。' : '用于验证自评标签与详情展示，非真实模型结论。' }],
          limitations: ['单张截图不能验证动画连续性。'] };
        const response = { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: input.model === 'fixture-review-invalid' ? '不是 JSON' : JSON.stringify(result) }] }], usage: { total_tokens: 2100 + number } };
        res.end('data: ' + JSON.stringify({ type: 'response.completed', response }) + '\n\n'); return;
      }
      const html = '<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;background:#edf5f4;font-family:system-ui}svg{display:block;width:100vw;height:100vh}.wheel{transform-box:fill-box;transform-origin:center;animation:spin 2s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}</style></head><body>' +
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 800"><rect width="1280" height="800" fill="#edf5f4"/><text x="70" y="90" fill="#276954" font-size="34">SVG 动画 · 本地验证样本 ' + number + '</text><path d="M0 650 H1280" stroke="#99b8af" stroke-width="8"/>' +
        '<g fill="none" stroke="#285a50" stroke-width="12"><g class="wheel"><circle cx="440" cy="555" r="90"/><path d="M350 555 H530 M440 465 V645"/></g><g class="wheel"><circle cx="790" cy="555" r="90"/><path d="M700 555 H880 M790 465 V645"/></g><path d="M440 555 L540 390 L635 555 Z M540 390 H730 L635 555 M790 555 L720 355 H765"/></g>' +
        '<ellipse cx="550" cy="305" rx="135" ry="95" fill="white" stroke="#9bb6af" stroke-width="4"/><path d="M600 260 Q640 150 710 190 L675 315" fill="white"/><circle cx="703" cy="195" r="8" fill="#193e36"/><path d="M720 202 L885 242 L715 251 Z" fill="#eba848"/><path d="M550 388 L605 440 L625 515" fill="none" stroke="#d99d44" stroke-width="20"/><path d="M540 285 Q600 300 715 368" fill="none" stroke="#9bb6af" stroke-width="12"/></svg>' +
        '<script>document.body.dataset.animated="yes";</script></body></html>';
      const response = { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '```html\n' + html + '\n```' }] }], usage: { total_tokens: 1200 + number } };
      res.end('data: ' + JSON.stringify({ type: 'response.completed', response }) + '\n\n');
    }, input.model === 'fixture-slow' ? 15000 : reviewing ? 6000 : 1800);
    res.on('close', () => clearTimeout(timer));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + upstream.address().port;
  const keys = [{ name: '测试中转 A', baseurl: base + '/a/v1', value: 'fixture-a' }, { name: '测试中转 B', baseurl: base + '/b/v1', value: 'fixture-b' }];
  await fs.writeFile(path.join(home, 'config.toml'), 'model_provider="fixture"\n[model_providers.fixture]\nbase_url="' + keys[0].baseurl + '"\n');
  await fs.writeFile(path.join(home, 'key_config.json'), JSON.stringify({ keys }));
  const app = await start({ home, uiPort: 0, proxyPort: 0, log: () => {} });
  console.log(app.uiUrl);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => {
    await app.close(); upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve));
    await fs.rm(home, { recursive: true, force: true }); process.exit(0);
  });
})().catch(error => { console.error(error); process.exit(1); });
