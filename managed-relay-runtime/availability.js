const https = require('node:https');
const { problem } = require('./config-store');
const { readBlackaicodingStatus } = require('./availability-blackaicoding');
const { readPerformanceStatus } = require('./availability-perf-metrics');

const MODELS = Object.freeze(['gpt-6-astra', 'gpt-5.6-sol']);
const REFRESH_MS = 15000;
const HISTORY_LENGTH = 60;
const STALE_MS = 180000;

function sample(value) {
  if (!value || !Number.isFinite(value.ts) || value.ts <= 0 || value.ts > 8640000000000 || typeof value.ok !== 'boolean') {
    throw new Error('Invalid status sample');
  }
  return {
    at: value.ts * 1000, ok: value.ok,
    latencyMs: Number.isFinite(value.latency_ms) && value.latency_ms >= 0 ? value.latency_ms : null,
    error: typeof value.error === 'string' ? value.error.slice(0, 500) : null,
  };
}

function readInputStatus(data) {
  if (!Array.isArray(data?.services)) throw new Error('Invalid status response');
  const models = {};
  for (const model of MODELS) {
    const service = data.services.find(item => item?.model === model);
    if (!service) continue;
    if (!Array.isArray(service.history)) throw new Error('Invalid status history');
    const history = service.history.map(sample).sort((a, b) => a.at - b.at).slice(-HISTORY_LENGTH);
    const last = service.last == null ? history.at(-1) || null : sample(service.last);
    models[model] = {
      history, last,
      uptimePct: history.length ? history.filter(item => item.ok).length / history.length * 100 : null,
    };
  }
  return models;
}

// Only registered public endpoints can be fetched; relay credentials never enter adapters.
const ADAPTERS = Object.freeze([{
  id: 'input', hosts: ['ai.input.im'],
  source: { name: 'AI.INPUT.IM', url: 'https://status.input.im/' },
  endpoint: 'https://status.input.im/api/status',
  parse: readInputStatus,
}, {
  id: 'blackaicoding', hosts: ['blackaicoding.com', 'www.blackaicoding.com'],
  source: { name: 'code for me', url: 'https://blackaicoding.com/custom/bdba7e5ab409e0b5' },
  endpoint: 'https://status.blackaicoding.com/',
  request: requestText,
  parse: (data, now) => readBlackaicodingStatus(data, MODELS, now),
}, {
  id: 'aixor', hosts: ['aixor.org', 'aixor.cc', 'www.aixor.org', 'www.aixor.cc'],
  source: { name: 'Aixor', url: 'https://aixor.cc/pricing' },
  endpoint: model => {
    const url = new URL('https://aixor.cc/api/perf-metrics');
    url.searchParams.set('model', model);
    url.searchParams.set('hours', '24');
    return url.href;
  },
  parse: (data, now, model) => readPerformanceStatus(data, model, { groupName: 'Premium-gpt' }, now),
}, {
  id: 'packycode', hosts: ['packyapi.com', 'www.packyapi.com', 'cf.api.fan', 'codex-api.packycode.com'],
  source: { name: 'Packycode', url: 'https://www.packyapi.com/pricing' },
  endpoint: model => {
    const url = new URL('https://www.packyapi.com/api/perf-metrics');
    url.searchParams.set('model', model);
    url.searchParams.set('hours', '24');
    return url.href;
  },
  parse: (data, now, model) => readPerformanceStatus(data, model, {
    groupName: 'codex', rateSource: 'group', healthyRate: 99, degradedRate: 90,
  }, now),
}]);

function adapterFor(baseurl) {
  try {
    const url = new URL(baseurl);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port) return null;
    return ADAPTERS.find(adapter => adapter.hosts.includes(url.hostname)) || null;
  } catch { return null; }
}

function requestContent(url, { outbound, signal }, accept) {
  return new Promise((resolve, reject) => {
    let request;
    let response;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      response?.destroy();
      request?.destroy();
      if (error) reject(error); else resolve(value);
    };
    const abort = () => finish(signal.reason || new Error('Status request aborted'));
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    (async () => {
      const route = await outbound.resolve(url);
      if (settled) return;
      request = https.get(url, {
        agent: outbound.agent(route, signal), signal,
        headers: { accept, 'cache-control': 'no-cache' },
      });
      request.on('error', error => finish(error));
      request.on('response', incoming => {
        response = incoming;
        if (incoming.statusCode !== 200) { finish(new Error('Status HTTP error')); return; }
        const chunks = [];
        let bytes = 0;
        incoming.on('data', chunk => {
          bytes += chunk.length;
          if (bytes > 1024 * 1024) { finish(new Error('Status response too large')); return; }
          chunks.push(chunk);
        });
        incoming.on('error', error => finish(error));
        incoming.on('aborted', () => finish(new Error('Incomplete status response')));
        incoming.on('end', () => {
          finish(null, Buffer.concat(chunks).toString('utf8'));
        });
      });
    })().catch(error => finish(error));
  });
}

async function requestJson(url, options) { return JSON.parse(await requestContent(url, options, 'application/json')); }
function requestText(url, options) { return requestContent(url, options, 'text/html'); }

class Availability {
  constructor(outbound, options = {}) {
    this.outbound = outbound;
    this.request = options.request;
    this.clock = options.clock || Date.now;
    this.timeoutMs = options.timeoutMs ?? 10000;
    this.cache = new Map();
    this.controller = new AbortController();
  }

  async read(adapter, model) {
    const perModel = typeof adapter.endpoint === 'function';
    const key = perModel ? adapter.id + ':' + model : adapter.id;
    let entry = this.cache.get(key);
    if (entry?.pending) return entry.pending;
    if (entry && this.clock() - entry.at < REFRESH_MS) return entry;
    entry ||= { models: null, fetchedAt: null };
    this.cache.set(key, entry);
    entry.at = this.clock();
    entry.pending = (async () => {
      const controller = new AbortController();
      const signal = AbortSignal.any([controller.signal, this.controller.signal]);
      const timer = setTimeout(() => controller.abort(new Error('Status timeout')), this.timeoutMs);
      try {
        const endpoint = perModel ? adapter.endpoint(model) : adapter.endpoint;
        const data = await (this.request || adapter.request || requestJson)(endpoint, { outbound: this.outbound, signal });
        signal.throwIfAborted();
        entry.models = adapter.parse(data, this.clock(), model);
        entry.fetchedAt = this.clock();
        entry.error = false;
      } catch {
        entry.error = true;
      } finally {
        clearTimeout(timer);
        controller.abort();
      }
      return entry;
    })().finally(() => { entry.pending = null; });
    return entry.pending;
  }

  async snapshot(keys, model = MODELS[0]) {
    if (!MODELS.includes(model)) throw problem('不支持的可用性模型。', 400);
    const rows = await Promise.all(keys.map(async ({ name, baseurl }) => {
      const adapter = adapterFor(baseurl);
      const row = { name, baseurl, model, history: [], last: null, uptimePct: null };
      if (!adapter) return { ...row, state: 'unsupported', message: '站点未适配' };
      const entry = await this.read(adapter, model);
      const status = entry.models?.[model];
      Object.assign(row, { source: adapter.source, fetchedAt: entry.fetchedAt }, status);
      if (entry.error) return { ...row, state: status ? 'stale' : 'error', message: status ? '刷新失败，保留上次样本' : '状态源暂时无法连接' };
      if (!status?.last) return { ...row, state: 'no-data', message: '状态源暂无该模型样本' };
      if (status.stale || (Number.isFinite(status.last.at) && this.clock() - status.last.at > (status.staleAfterMs ?? STALE_MS))) return { ...row, state: 'stale', message: '状态源样本已过期' };
      if (status.last.state === 'degraded') return { ...row, state: 'degraded', message: '降级' };
      if (status.last.state === 'no-data') return { ...row, state: 'no-data', message: '最近时段无请求' };
      return { ...row, state: status.last.ok ? 'available' : 'unavailable', message: status.last.ok ? '可用' : '异常' };
    }));
    return { model, models: MODELS, refreshMs: REFRESH_MS, historyLength: HISTORY_LENGTH, rows };
  }

  close() {
    this.controller.abort();
    this.cache.clear();
  }
}

module.exports = { Availability, MODELS, REFRESH_MS, adapterFor, readInputStatus, requestJson, requestText };
