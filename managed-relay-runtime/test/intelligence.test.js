const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { PassThrough } = require('node:stream');
const { gzipSync } = require('node:zlib');
const { IntelligenceTests, routeId } = require('../intelligence-tests');
const { PROMPT, generate, extractHtml, readResponse } = require('../intelligence-generation');
const { CSP, previewDocument } = require('../intelligence-preview');
const { accountId } = require('../relay-identity');
const { start } = require('../../managed-relay-server');

const HTML = '<!doctype html><html><body><svg xmlns="http://www.w3.org/2000/svg"><text>鹈鹕</text></svg></body></html>';
const IMAGE = 'iVBORw0KGgo=';
const completed = html => ({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: html }] }], usage: { total_tokens: 123 } });
const outbound = { resolve: async () => ({ label: 'DIRECT' }), agent: () => false };
const publicEntry = entry => ({ name: entry.name, naturalAccountId: accountId(entry) });
async function until(read) {
  for (let i = 0; i < 300; i++) { const value = await read(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw new Error('Test did not settle');
}
async function fixture(t, options = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-intelligence-'));
  const entries = [{ name: '中转甲', value: 'private-key-a', baseurl: 'https://a.invalid/v1' },
    { name: '中转乙', value: 'private-key-b', baseurl: 'https://b.invalid/v1' }];
  const manager = new IntelligenceTests(home, async name => entries.find(entry => entry.name === name), outbound,
    { generate: async () => ({ html: HTML }), screenshot: async () => IMAGE, ...options });
  t.after(async () => { await manager.close(); await fs.rm(home, { recursive: true, force: true }); });
  const keys = entries.map(publicEntry);
  const run = index => manager.start({ scope: manager.scope, routeId: routeId(entries[index]), name: entries[index].name, model: 'test-model', effort: 'high', reviewEnabled: false });
  const row = async index => (await manager.snapshot(keys)).rows[index].result;
  return { home, entries, keys, manager, run, row };
}

test('Responses parsing handles chunked SSE, gzip JSON, truncation and incomplete output', async () => {
  for (const encoding of ['sse', 'gzip']) {
    const response = new PassThrough(); response.statusCode = 200;
    response.headers = encoding === 'sse' ? { 'content-type': 'text/event-stream' } : { 'content-encoding': 'gzip' };
    const pending = readResponse(response);
    const data = encoding === 'sse' ? Buffer.from(': ping\r\n\r\nevent: response.completed\r\ndata: ' + JSON.stringify({ type: 'response.completed', response: completed(HTML) }) + '\r\n\r\n') : gzipSync(JSON.stringify(completed(HTML)));
    for (let i = 0; i < data.length; i += 7) response.write(data.subarray(i, i + 7));
    response.end(); assert.equal((await pending).text, HTML);
  }
  for (const event of [{ type: 'response.output_text.delta', delta: HTML }, { type: 'response.incomplete' }, { type: 'error', message: 'private-key-a' }]) {
    const response = new PassThrough(); response.statusCode = 200; response.headers = { 'content-type': 'text/event-stream' };
    const pending = readResponse(response); response.end('data: ' + JSON.stringify(event) + '\n\n');
    await assert.rejects(pending, error => !error.message.includes('private-key-a'));
  }
  assert.equal(extractHtml('这里是结果：\n```html\n' + HTML + '\n```'), HTML);
  assert.throws(() => extractHtml('<html><body>incomplete'), /完整 HTML/);
});

test('Codex-style streams retain final output_item.done text when the completion envelope omits output', async () => {
  const item = (text, phase) => ({ type: 'message', status: 'completed', role: 'assistant', phase, content: [{ type: 'output_text', text }] });
  const done = (output_index, text, phase = 'final_answer') => ({ type: 'response.output_item.done', output_index, item: item(text, phase) });
  const completedEvent = output => ({ type: 'response.completed', response: { status: 'completed', output, usage: { total_tokens: 42 } } });
  async function read(events) {
    const response = new PassThrough(); response.statusCode = 200; response.headers = { 'content-type': 'text/event-stream' };
    const pending = readResponse(response);
    response.end(events.map(event => 'data: ' + JSON.stringify(event) + '\n\n').join(''));
    return pending;
  }
  const events = [done(0, 'Preparing HTML', 'commentary'), done(1, HTML)];
  const result = await read([...events, completedEvent([])]);
  assert.equal(result.text, HTML); assert.deepEqual(result.usage, { total_tokens: 42 });
  assert.equal((await read([done(1, HTML), done(1, HTML), completedEvent([])])).text, HTML);
  assert.equal((await read([...events, completedEvent([item('authoritative final', 'final_answer')])])).text, 'authoritative final');
  await assert.rejects(read(events), /提前中断/);
  await assert.rejects(read([...events, { type: 'response.incomplete' }]), /不完整/);
  await assert.rejects(read([{ ...done(0, HTML), item: { ...item(HTML, 'final_answer'), status: 'in_progress' } }, completedEvent([])]), /没有返回可用的文本/);
});

test('upstream failures distinguish output limits, explicit errors and transport failure without exposing raw messages', async () => {
  for (const sse of [true, false]) {
    for (const [body, expected] of [
      [{ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }, /response.incomplete.*16384.*推理用量/],
      [{ status: 'incomplete', incomplete_details: { reason: 'content_filter' } }, /上游内容过滤/],
      [{ status: 'failed', error: { code: 'server_error', message: 'private-key' } }, /response.failed.*上游服务内部错误/],
      [{ status: 'failed', error: { code: 'private-key', message: 'private-key' } }, /上游未提供可识别的失败原因/],
    ]) {
      const response = new PassThrough(); response.statusCode = 200; response.headers = { 'content-type': sse ? 'text/event-stream' : 'application/json' };
      const pending = readResponse(response);
      response.end(sse ? 'data: ' + JSON.stringify({ type: 'response.' + body.status, response: body }) + '\n\n' : JSON.stringify(body));
      await assert.rejects(pending, error => expected.test(error.message) && !error.message.includes('private-key'));
    }
  }
});

test('Packycode client-only rejection is actionable without disclosing the upstream body', async () => {
  for (const message of ['请使用标准 Codex 客户端请求。private-key-a', 'Please use the standard Codex client for requests. private-key-a']) {
    const response = new PassThrough(); response.statusCode = 403; response.headers = { 'content-type': 'text/event-stream' };
    const pending = readResponse(response);
    const data = Buffer.from(JSON.stringify({ error: { type: 'packy_api_error', code: 'api_error', message } }));
    for (let i = 0; i < data.length; i += 5) response.write(data.subarray(i, i + 5));
    response.end();
    await assert.rejects(pending, error => error.code === 'PACKY_CODEX_CLIENT_REQUIRED' && /标准 Codex 客户端/.test(error.message) && !error.message.includes('private-key-a'));
    assert.equal(response.destroyed, true);
  }
  for (const body of ['<html>private-key-a</html>', JSON.stringify({ error: { type: 'packy_api_error', message: '额度不足 private-key-a' } }), 'x'.repeat(17000)]) {
    const response = new PassThrough(); response.statusCode = 403; response.headers = {};
    const pending = readResponse(response); response.end(body);
    await assert.rejects(pending, error => /HTTP 403/.test(error.message) && !error.code && !error.message.includes('private-key-a'));
  }
  const broken = new PassThrough(); broken.statusCode = 403; broken.headers = {};
  const pending = readResponse(broken); broken.destroy(new Error('private-key-a'));
  await assert.rejects(pending, error => /HTTP 403/.test(error.message) && !error.message.includes('private-key-a'));
});

test('generation pins the requested URL/key, sends the exact prompt and creates a fresh conversation', async t => {
  let request;
  const server = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    request = { url: req.url, headers: req.headers, payload: JSON.parse(body) };
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(completed(HTML)));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const entry = { name: '测试', baseurl: 'http://127.0.0.1:' + server.address().port + '/codex/v1', value: 'private-key-a' };
  const result = await generate(entry, { model: 'test-model', effort: 'high' }, outbound, new AbortController().signal);
  assert.equal(result.html, HTML); assert.equal(request.url, '/codex/v1/responses');
  assert.equal(request.headers.authorization, 'Bearer private-key-a');
  assert.deepEqual(request.payload.input, [{ role: 'user', content: [{ type: 'input_text', text: PROMPT }] }]);
  assert.equal(request.payload.previous_response_id, undefined); assert.equal(request.payload.store, false);
});

test('routes run concurrently; replacing a run cannot let its late completion overwrite the latest', async t => {
  const waiting = [], seen = [];
  const f = await fixture(t, { generate: async (entry, settings, transport, signal) => {
    seen.push({ entry, signal }); return new Promise(resolve => waiting.push(resolve));
  } });
  const first = await f.run(0); await f.run(1);
  await until(() => seen.length === 2);
  const replacement = await f.run(0); await until(() => seen.length === 3);
  assert.equal(seen[0].signal.aborted, true); assert.equal(seen[1].signal.aborted, false);
  waiting[2]({ html: HTML }); waiting[1]({ html: HTML });
  await until(async () => (await f.row(0))?.state === 'completed' && (await f.row(1))?.state === 'completed');
  waiting[0]({ html: HTML.replace('鹈鹕', 'OLD') });
  await until(() => f.manager.running.size === 0);
  assert.equal((await f.row(0)).runId, replacement.runId);
  await assert.rejects(f.manager.artifact(first.routeId, first.runId, 'index.html', f.keys), /取代/);
  const artifact = await f.manager.artifact(replacement.routeId, replacement.runId, 'index.html', f.keys);
  assert.ok(!artifact.body.includes('OLD')); assert.equal(artifact.csp, CSP);
  const saved = await fs.readFile(path.join(f.manager.directory, replacement.routeId + '.json'), 'utf8');
  assert.ok(!saved.includes('private-key')); assert.equal((await fs.readdir(f.manager.directory)).length, 2);
});

test('latest failure replaces old success; screenshots persist, restart restores results and interrupts unfinished work', async t => {
  let fail = false;
  const f = await fixture(t, { generate: async () => { if (fail) throw new Error('private-key-a'); return { html: HTML }; } });
  const first = await f.run(0); await until(async () => (await f.row(0))?.state === 'completed');
  const reopened = new IntelligenceTests(f.home, f.manager.getEntry, outbound); t.after(() => reopened.close());
  const saved = (await reopened.snapshot(f.keys)).rows[0].result;
  assert.equal(saved.runId, first.runId); assert.equal(saved.state, 'completed'); assert.ok(saved.screenshotUrl);
  fail = true; await f.run(0); await until(async () => (await f.row(0))?.state === 'failed');
  const failed = await f.row(0); assert.equal(failed.resultUrl, null); assert.equal(failed.screenshotUrl, null);
  assert.ok(!JSON.stringify(failed).includes('private-key-a'));
  await fs.writeFile(path.join(f.manager.directory, first.routeId + '.json'), JSON.stringify({ version: 1, ...first, state: 'generating' }));
  const interrupted = new IntelligenceTests(f.home, f.manager.getEntry, outbound); t.after(() => interrupted.close());
  const restored = (await interrupted.snapshot(f.keys)).rows[0].result;
  assert.equal(restored.state, 'failed'); assert.match(restored.error, /重启/);
});

test('screenshot failure still exposes HTML; shutdown aborts jobs and key edits invalidate old links', async t => {
  const f = await fixture(t, { screenshot: async () => { throw new Error('Chrome unavailable'); } });
  const job = await f.run(0); await until(async () => (await f.row(0))?.state === 'preview_failed');
  assert.ok((await f.row(0)).resultUrl); assert.equal((await f.row(0)).screenshotUrl, null);
  f.entries[0].value = 'new-key';
  await assert.rejects(f.manager.artifact(job.routeId, job.runId, 'index.html', f.entries.map(publicEntry)), /中转已变化/);
  f.manager.generate = (entry, settings, transport, signal) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  await f.run(1); await until(async () => (await f.row(1))?.state === 'generating');
  await f.manager.close(); assert.equal((await f.row(1)).state, 'failed');
  assert.match((await f.row(1)).error, /服务已停止/);
});

test('timeout releases the running request; forgetting a changed route prevents late files from returning', async t => {
  const f = await fixture(t, { timeoutMs: 25, generate: (entry, settings, transport, signal) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }) });
  await f.run(0); await until(async () => (await f.row(0))?.state === 'failed');
  assert.match((await f.row(0)).error, /超过/); assert.equal(f.manager.generationSlots.active, 0);
  let finish;
  f.manager.timeoutMs = 1000;
  f.manager.generate = () => new Promise(resolve => { finish = resolve; });
  const job = await f.run(1); await until(() => finish);
  await f.manager.forget(f.entries[1]); finish({ html: HTML });
  await until(() => f.manager.running.size === 0);
  assert.equal(await f.manager.read(job.routeId), null);
  await assert.rejects(fs.access(path.join(f.manager.directory, job.routeId + '.json')), { code: 'ENOENT' });
});

test('a corrupt saved result cannot break management status and a new run repairs it', async t => {
  const f = await fixture(t);
  await fs.mkdir(f.manager.directory, { recursive: true });
  await fs.writeFile(path.join(f.manager.directory, routeId(f.entries[0]) + '.json'), 'broken');
  const snapshot = await f.manager.snapshot(f.keys);
  assert.match(snapshot.rows[0].error, /无法读取/); assert.equal(snapshot.rows[1].error, undefined);
  await f.run(0); await until(async () => (await f.row(0))?.state === 'completed');
  assert.equal((await f.manager.snapshot(f.keys)).rows[0].error, undefined);
});

test('HTTP integration enforces origin/scope and serves isolated results without exposing keys', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.home, 'config.toml'), 'model_provider="relay"\n[model_providers.relay]\nbase_url="https://a.invalid/v1"\n');
  await fs.writeFile(path.join(f.home, 'key_config.json'), JSON.stringify({ keys: f.entries }));
  const app = await start({ home: f.home, uiPort: 0, proxyPort: 0, log: () => {}, intelligenceOptions: { generate: async () => ({ html: HTML }), screenshot: async () => IMAGE } });
  t.after(() => app.close());
  const state = await app.status(), row = state.intelligence.rows[0];
  const payload = { scope: state.intelligence.scope, name: row.name, routeId: row.routeId, model: 'test-model', effort: 'high', reviewEnabled: false };
  const post = (origin, data = payload) => fetch(app.uiUrl + '/api/intelligence/start', { method: 'POST', headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) }, body: JSON.stringify(data) });
  assert.equal((await post()).status, 403); assert.equal((await post('https://evil.invalid')).status, 403);
  assert.equal((await post(app.uiUrl, { ...payload, scope: 'stale' })).status, 409);
  const response = await post(app.uiUrl); assert.equal(response.status, 202);
  const result = await until(async () => { const snapshot = await (await fetch(app.uiUrl + '/api/intelligence')).json(); return snapshot.rows[0].result?.state === 'completed' && snapshot.rows[0].result; });
  assert.ok(!JSON.stringify(result).includes('private-key'));
  const html = await fetch(app.uiUrl + result.resultUrl);
  assert.match(html.headers.get('content-security-policy'), /connect-src 'none'/);
  assert.match(await html.text(), /sandbox="allow-scripts"/);
  const png = await fetch(app.uiUrl + result.screenshotUrl); assert.equal(png.headers.get('content-type'), 'image/png');
  assert.equal((await fetch(app.uiUrl + '/intelligence-results/invalid')).status, 404);
  assert.ok(previewDocument('</iframe><script>alert(1)</script>').includes('&lt;/iframe&gt;'));
  const edit = await fetch(app.uiUrl + '/api/keys/edit', { method: 'POST', headers: { 'content-type': 'application/json', origin: app.uiUrl },
    body: JSON.stringify({ originalName: row.name, name: ' 改名后 ', value: '', baseurl: f.entries[0].baseurl, revision: state.keys[0].revision }) });
  assert.equal(edit.status, 200);
  assert.equal((await fetch(app.uiUrl + result.resultUrl)).status, 404);
  await assert.rejects(fs.access(path.join(f.manager.directory, row.routeId + '.json')), { code: 'ENOENT' });
});
