const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const { requestResponse, generate, PROMPT, MAX_OUTPUT_TOKENS } = require('../intelligence-generation');
const { review, REVIEW_PROMPT, loadBaseline } = require('../intelligence-review');

const settings = { model: 'test-model', effort: 'high' };
const HTML = '<!doctype html><html><body><svg><text>鹈鹕</text></svg></body></html>';
const NORMAL = { status: 'completed', verdict: '正常', summary: '达到基准。', findings: [], limitations: [] };
const INPUT = [{ role: 'user', content: [{ type: 'input_text', text: '只回复 OK' }] }];
function emit(res, text) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const item = { type: 'message', status: 'completed', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text }] };
  res.end('data: ' + JSON.stringify({ type: 'response.output_item.done', output_index: 0, item }) + '\n\n' +
    'data: ' + JSON.stringify({ type: 'response.completed', response: { status: 'completed', output: [], usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } }) + '\n\n');
}
async function fixture(t, handle = (_req, res) => emit(res, 'OK')) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); requests.push({ headers: req.headers, path: req.url, body });
    handle(req, res, body);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const agent = new http.Agent();
  // Preserve the configured vendor URL/Host while keeping the test entirely local.
  agent.createConnection = (_options, callback) => net.createConnection({ host: '127.0.0.1', port: server.address().port }, callback);
  t.after(async () => { agent.destroy(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { requests, outbound: { resolve: async () => ({ label: 'DIRECT' }), agent: () => agent },
    entry: { name: 'Packy', baseurl: 'http://cf.api.fan/v1', value: 'test-private-key' } };
}

test('Packy pure API uses its own client identity, a fresh cache key and the ordinary output limit', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 2; i++) {
    const result = await requestResponse(f.entry, settings, f.outbound, new AbortController().signal, INPUT);
    assert.equal(result.text, 'OK'); assert.equal(result.transport, 'packy-api'); assert.equal(result.maxOutputTokens, MAX_OUTPUT_TOKENS);
    assert.equal(result.usage.total_tokens, 15);
  }
  assert.equal(f.requests.length, 2);
  for (const request of f.requests) {
    assert.equal(request.path, '/v1/responses'); assert.equal(request.headers.authorization, 'Bearer test-private-key');
    assert.equal(request.headers['user-agent'], 'CodexTool/1.0'); assert.equal(request.headers.originator, undefined);
    assert.equal(request.body.model, settings.model); assert.deepEqual(request.body.reasoning, { effort: settings.effort });
    assert.deepEqual(request.body.input, INPUT); assert.equal(request.body.instructions, '请完成用户请求。');
    assert.equal(request.body.max_output_tokens, 16384); assert.equal(request.body.store, false);
    assert.match(request.body.prompt_cache_key, /^[a-f0-9-]{36}$/);
    for (const key of ['client_metadata', 'tools', 'tool_choice', 'parallel_tool_calls', 'previous_response_id', 'conversation']) assert.equal(request.body[key], undefined);
  }
  assert.notEqual(f.requests[0].body.prompt_cache_key, f.requests[1].body.prompt_cache_key);
});

test('Packy generation and image review share pure API transport without changing approved inputs', async t => {
  const f = await fixture(t, (_req, res, body) => emit(res, body.input[0].content.some(part => part.type === 'input_image') ? JSON.stringify(NORMAL) : HTML));
  const result = await generate(f.entry, settings, f.outbound, new AbortController().signal);
  assert.equal(result.html, HTML); assert.equal(result.transport, 'packy-api');
  assert.equal(f.requests[0].body.input[0].content[0].text, PROMPT);
  const baseline = await loadBaseline(), image = baseline.toString('base64');
  const judged = await review(f.entry, { ...settings, html: HTML, image }, f.outbound, new AbortController().signal);
  assert.equal(judged.verdict, '正常'); assert.equal(judged.transport, 'packy-api');
  const body = f.requests[1].body;
  assert.equal(body.instructions, REVIEW_PROMPT); assert.equal(body.input[0].content[0].text, REVIEW_PROMPT);
  assert.deepEqual(body.input[0].content.filter(part => part.type === 'input_image').map(part => part.image_url), ['data:image/png;base64,' + image, 'data:image/png;base64,' + image]);
  assert.equal(JSON.parse(body.input[0].content.at(-1).text.split('\n').slice(1).join('\n')), HTML);
});

test('Packy adaptation matches only registered hosts and does not change other relay requests', async t => {
  const f = await fixture(t);
  for (const host of ['slb-v1.api.fan', 'codex-api.packycode.com', 'cf.api.fan.evil.example', 'krill-code.com']) {
    const known = ['slb-v1.api.fan', 'codex-api.packycode.com'].includes(host);
    const result = await requestResponse({ ...f.entry, baseurl: 'http://' + host + '/v1' }, settings, f.outbound, new AbortController().signal, INPUT, 'custom instructions');
    const request = f.requests.at(-1);
    assert.equal(result.transport, known ? 'packy-api' : 'responses-api');
    assert.equal(request.body.instructions, 'custom instructions');
    assert.equal(Boolean(request.body.prompt_cache_key), known); assert.equal(Boolean(request.headers['user-agent']), known);
  }
});

test('a rejected Packy request remains an explicit failure without retries or a CLI fallback', async t => {
  const f = await fixture(t, (_req, res) => {
    res.writeHead(403, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { type: 'packy_api_error', message: '请使用标准 Codex 客户端请求。' } }));
  });
  await assert.rejects(requestResponse(f.entry, settings, f.outbound, new AbortController().signal, INPUT), { code: 'PACKY_CODEX_CLIENT_REQUIRED' });
  assert.equal(f.requests.length, 1);
});
