const http = require('node:http');
const https = require('node:https');
const { randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { createGunzip, createInflate, createBrotliDecompress } = require('node:zlib');
const { problem } = require('./config-store');
const { targetUrl } = require('./proxy');
const { merchantId } = require('./relay-identity');
const { networkAccessError } = require('./network-error');

const PROMPT = '创建一个HTML，内容是SVG绘制一个鹈鹕骑自行车的2D动画，你不需要任何测试';
const MAX_OUTPUT_TOKENS = 16384;
const MAX_BYTES = 4 * 1024 * 1024;

function responseFailure(type, response, upstreamError) {
  const reason = response?.incomplete_details?.reason;
  if (type === 'response.incomplete') {
    const detail = reason === 'max_output_tokens' ? '达到输出上限（' + MAX_OUTPUT_TOKENS + ' tokens，包含推理用量）'
      : reason === 'content_filter' ? '上游内容过滤' : '上游未提供可识别的中断原因';
    return problem('上游返回 response.incomplete，输出不完整：' + detail + '。本次未生成完整结果，请重新执行。', 502);
  }
  const reasons = { server_error: '上游服务内部错误', internal_server_error: '上游服务内部错误', upstream_error: '中转的上游调用失败',
    rate_limit_exceeded: '上游请求频率受限', insufficient_quota: '上游额度不足', context_length_exceeded: '输入超出模型上下文限制',
    model_not_found: '模型不存在或无权使用', invalid_api_key: '上游密钥无效', permission_denied: '上游权限不足' };
  const code = (upstreamError || response?.error)?.code;
  const detail = Object.hasOwn(reasons, code) ? reasons[code] + '（' + code + '）' : '上游未提供可识别的失败原因';
  // Do not reflect arbitrary upstream messages: they can include request bodies or keys.
  return problem('上游返回 ' + type + '，模型生成失败：' + detail + '。请稍后重试。', 502);
}

function outputText(response) {
  if (response?.status === 'incomplete') throw responseFailure('response.incomplete', response);
  if (response?.status === 'failed') throw responseFailure('response.failed', response);
  if (response?.status !== 'completed') throw problem('模型未完整生成结果，可能达到输出上限，请重新执行。', 502);
  const messages = (response.output || []).filter(item => item.type === 'message');
  const final = messages.filter(item => item.phase === 'final_answer');
  const text = (final.length ? final : messages)
    .flatMap(item => item.content || []).filter(item => item.type === 'output_text').map(item => item.text || '').join('\n');
  if (!text) throw problem('模型没有返回可用的文本。', 502);
  return text;
}

function extractHtml(text) {
  const blocks = [...text.matchAll(/```(?:html)?\s*\n([\s\S]*?)```/gi)].map(match => match[1]);
  const candidate = blocks.find(block => /<html[\s>]/i.test(block)) || text;
  const match = candidate.match(/(?:<!doctype\s+html[^>]*>\s*)?<html[\s>][\s\S]*<\/html\s*>/i);
  if (!match || !/<svg[\s>]/i.test(match[0])) throw problem('模型未返回包含 SVG 的完整 HTML，未生成预览。', 502);
  return match[0];
}

function readHttpFailure(response) {
  const status = response.statusCode;
  const generic = () => problem('中转返回 HTTP ' + status + '，请检查模型权限、额度或连接。', 502);
  if (status !== 403) { response.destroy(); return Promise.resolve(generic()); }
  // Only inspect a small, bounded error body to identify a known client restriction.
  // Never echo upstream error text, which may contain credentials or request details.
  return new Promise(resolve => {
    let body = '', bytes = 0, finished = false;
    const finish = (complete = false) => {
      if (finished) return;
      finished = true; clearTimeout(timer);
      let error = generic();
      if (complete) {
        try {
          const upstream = JSON.parse(body)?.error;
          if (upstream?.type === 'packy_api_error' && typeof upstream.message === 'string' &&
              /标准\s*Codex\s*客户端|standard\s+Codex\s+client/i.test(upstream.message)) {
            error = problem('Packycode 返回 HTTP 403：上游提示“请使用标准 Codex 客户端”，当前 API 请求未通过客户端校验。请核对该入口的接入要求或联系站点。', 502);
            error.code = 'PACKY_CODEX_CLIENT_REQUIRED';
          }
        } catch { /* Unknown error bodies retain the generic, credential-free message. */ }
      }
      response.destroy(); resolve(error);
    };
    const timer = setTimeout(() => finish(), 2000);
    response.setEncoding('utf8');
    response.on('data', chunk => { bytes += Buffer.byteLength(chunk); if (bytes > 16384) finish(); else body += chunk; });
    response.once('end', () => finish(true));
    response.once('error', () => finish());
    response.once('close', () => finish());
  });
}

// Parse the Responses protocol ourselves: the existing proxy deliberately does not inspect bodies.
// A terminal completed event is required; truncated streams must not become successful results.
async function readResponse(response) {
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw await readHttpFailure(response);
  }
  let stream = response;
  const encoding = response.headers['content-encoding'];
  const decoder = encoding === 'gzip' ? createGunzip() : encoding === 'deflate' ? createInflate() : encoding === 'br' ? createBrotliDecompress() : null;
  if (decoder) { response.on('error', error => decoder.destroy(error)); stream = response.pipe(decoder); }
  else if (encoding && encoding !== 'identity') throw problem('中转返回不支持的内容编码。', 502);
  stream.setEncoding('utf8');
  const sse = String(response.headers['content-type']).includes('text/event-stream');
  let size = 0, buffer = '', terminal;
  const completedItems = new Map();
  const result = () => {
    // Some Codex-compatible streams put their final text only in output_item.done;
    // response.completed still supplies the authoritative completion status and usage.
    const hasText = terminal?.output?.some(item => item.type === 'message' && item.content?.some(part => part.type === 'output_text' && part.text));
    const response = hasText ? terminal : { ...terminal, output: [...completedItems.entries()].sort(([a], [b]) => a - b).map(([, item]) => item) };
    return { text: outputText(response), usage: terminal.usage };
  };
  const event = raw => {
    const data = raw.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (!data || data === '[DONE]') return;
    let value;
    try { value = JSON.parse(data); } catch { throw problem('中转返回了无效的流式响应。', 502); }
    if (['response.failed', 'response.incomplete', 'error'].includes(value.type)) throw responseFailure(value.type, value.response, value.error);
    if (value.type === 'response.output_item.done' && Number.isInteger(value.output_index) && value.output_index >= 0 && value.item?.type === 'message' &&
        (value.item.status === undefined || value.item.status === 'completed')) {
      completedItems.set(value.output_index, value.item);
    }
    if (value.type === 'response.completed') terminal = value.response;
  };
  try {
    for await (const chunk of stream) {
      size += Buffer.byteLength(chunk);
      if (size > MAX_BYTES) throw problem('模型响应过大，已停止本次测试。', 502);
      buffer += chunk;
      if (!sse) continue;
      let boundary;
      while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
        event(buffer.slice(0, boundary.index));
        buffer = buffer.slice(boundary.index + boundary[0].length);
        if (terminal) return result();
      }
    }
    if (sse) {
      if (buffer.trim()) event(buffer);
      if (!terminal) throw problem('中转响应提前中断，未收到完整生成结果。', 502);
    } else {
      try { terminal = JSON.parse(buffer); } catch { throw problem('中转返回了无效的 JSON。', 502); }
    }
    return result();
  } finally { if (decoder) decoder.destroy(); response.destroy(); }
}

async function requestResponse(entry, settings, outbound, signal, input, instructions) {
  const target = targetUrl(entry.baseurl, '/v1/responses');
  const route = await outbound.resolve(target);
  signal.throwIfAborted();
  const packy = merchantId(entry.baseurl) === 'packycode';
  const payload = JSON.stringify({ model: settings.model, reasoning: { effort: settings.effort },
    input, ...(instructions ? { instructions } : packy ? { instructions: '请完成用户请求。' } : {}),
    // Packycode requires a client identifier and cache key; neither requires a CLI process.
    // A fresh key keeps each independent generation/review request separate.
    ...(packy ? { prompt_cache_key: randomUUID() } : {}),
    stream: true, store: false, max_output_tokens: MAX_OUTPUT_TOKENS });
  let result;
  for (let attempt = 0; attempt < 2; attempt++) {
    // A separate signal releases this attempt's proxy agent even when we reconnect.
    const controller = new AbortController();
    const attemptSignal = AbortSignal.any([signal, controller.signal]);
    let tlsPending = false, responseStarted = false;
    try {
      result = await new Promise((resolve, reject) => {
        const request = (target.protocol === 'https:' ? https : http).request(target, {
          method: 'POST', signal: attemptSignal, agent: outbound.agent(route, attemptSignal),
          headers: { authorization: 'Bearer ' + entry.value, 'content-type': 'application/json',
            accept: packy ? 'text/event-stream' : 'text/event-stream, application/json',
            ...(packy ? { 'user-agent': 'CodexTool/1.0' } : {}),
            'accept-encoding': 'identity', 'content-length': Buffer.byteLength(payload) },
        }, response => { responseStarted = true; readResponse(response).then(resolve, reject); });
        request.on('socket', socket => {
          // HTTPS buffers the HTTP request until secureConnect. Only this observed
          // pre-handshake state proves that reconnecting cannot duplicate a model call.
          tlsPending = target.protocol === 'https:' && socket.encrypted === true && socket.secureConnecting === true;
          socket.once('secureConnect', () => { tlsPending = false; });
        });
        request.on('error', reject);
        request.end(payload);
      });
      break;
    } catch (error) {
      signal.throwIfAborted();
      const resetBeforeSend = tlsPending && !responseStarted && error.code === 'ECONNRESET';
      if (!resetBeforeSend || attempt === 1) {
        if (resetBeforeSend) throw problem('HTTPS 握手阶段连接被重置（ECONNRESET），模型请求尚未发送；自动重连 1 次后仍失败。请检查「运行与连接 → 上游网络」的代理或 VPN 后重试。', 502);
        throw error.status ? error : networkAccessError(error, '被测中转') || error;
      }
    } finally { controller.abort(); }
    // Keep the selected route and payload. Never retry HTTP errors, an interrupted
    // response, or a reset after TLS connected: the upstream may already be billing.
    await delay(250, undefined, { signal });
  }
  const usage = result.usage;
  return { text: result.text, transport: packy ? 'packy-api' : 'responses-api', maxOutputTokens: MAX_OUTPUT_TOKENS, usage: usage ? Object.fromEntries(
    ['input_tokens', 'output_tokens', 'total_tokens'].filter(key => Number.isFinite(usage[key])).map(key => [key, usage[key]])) : null };
}

async function generate(entry, settings, outbound, signal) {
  const result = await requestResponse(entry, settings, outbound, signal,
    [{ role: 'user', content: [{ type: 'input_text', text: PROMPT }] }]);
  return { html: extractHtml(result.text), usage: result.usage, transport: result.transport, maxOutputTokens: result.maxOutputTokens };
}

module.exports = { PROMPT, MAX_OUTPUT_TOKENS, generate, extractHtml, readResponse, requestResponse };
