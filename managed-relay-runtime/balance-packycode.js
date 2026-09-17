const fs = require('node:fs/promises');
const path = require('node:path');
const https = require('node:https');
const { createHash } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { atomicWrite, problem } = require('./config-store');

const USAGE_PATH = '/api/usage/token/';
const DEFAULTS = Object.freeze({ api_base_url: 'https://slb-v1.api.fan', request_timeout_seconds: 10, refresh_interval_seconds: 1800 });
const RETRY_DELAYS = [1000, 3000, 5000];
const NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

function normalizeApiBaseUrl(value) {
  if (typeof value !== 'string' || value.length > 2000) throw problem('请填写有效的 Packycode 余额查询地址。', 400);
  const text = value.trim().replace(/\/+$/, '').replace(/\/api\/usage\/token$/i, '').replace(/\/v1$/i, '').replace(/\/+$/, '');
  let url;
  try { url = new URL(text); } catch { throw problem('余额查询地址格式无效。', 400); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !url.hostname || /\s/.test(text)) throw problem('余额查询地址必须是无账号、查询参数和片段的 HTTPS 地址。', 400);
  return url.href.replace(/\/+$/, '');
}

function validateConfig(value) {
  const timeout = value?.request_timeout_seconds ?? DEFAULTS.request_timeout_seconds;
  const interval = value?.refresh_interval_seconds ?? DEFAULTS.refresh_interval_seconds;
  if (!Number.isFinite(timeout) || timeout < 1 || timeout > 60) throw problem('单次超时须为 1～60 秒。', 400);
  if (!Number.isFinite(interval) || interval < 15 || interval > 86400) throw problem('自动刷新间隔须为 15～86400 秒。', 400);
  return { api_base_url: normalizeApiBaseUrl(value?.api_base_url ?? DEFAULTS.api_base_url), request_timeout_seconds: timeout, refresh_interval_seconds: interval };
}

function numeric(value) {
  if (typeof value !== 'number' && !(typeof value === 'string' && NUMBER.test(value.trim()))) throw new Error('Invalid Packycode quota');
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new Error('Invalid Packycode quota');
  return number;
}

function parsePackyUsage(body) {
  const object = value => value && typeof value === 'object' && !Array.isArray(value);
  if (!object(body)) throw new Error('Invalid Packycode usage response');
  const source = object(body.data) ? body.data : body;
  if (body.code === false || source.code === false || Object.hasOwn(body, 'error') || Object.hasOwn(source, 'error')) throw new Error('Packycode usage error');
  const first = (...keys) => {
    for (const entry of [source, body]) for (const key of keys) if (entry[key] != null) return entry[key];
    return undefined;
  };
  const unlimited = first('unlimited_quota', 'unlimitedQuota') === true;
  const tokenName = first('name', 'token_name', 'tokenName');
  const summary = { unlimited, currency: 'USD', tokenName: typeof tokenName === 'string' ? tokenName.slice(0, 200) : '' };
  // The live API uses a negative available sentinel for unlimited keys. No numeric
  // balance exists in this mode, so do not convert sentinel quotas to dollars.
  if (unlimited) return { ...summary, amount: null, maximum: null, usedAmount: null, remainingPercent: null };
  const available = first('total_available', 'totalAvailable');
  // A missing available quota must never turn a malformed response into a zero balance.
  const totalAvailable = numeric(available);
  const totalGranted = numeric(first('total_granted', 'totalGranted') ?? 0);
  const totalUsed = numeric(first('total_used', 'totalUsed') ?? 0);
  return { amount: totalAvailable / 500000, maximum: totalGranted / 500000, usedAmount: totalUsed / 500000,
    remainingPercent: totalGranted <= 0 ? null : Math.min(100, Math.max(0, totalAvailable / totalGranted * 100)), ...summary };
}

function retryAfter(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 60) : null;
}

function requestPackyUsage(endpoint, { apiKey, outbound, signal }) {
  // The caller supplies the configured endpoint; never redirect or rewrite its host.
  if (endpoint !== normalizeApiBaseUrl(endpoint) + USAGE_PATH) return Promise.reject(new Error('Invalid Packycode endpoint'));
  if (typeof apiKey !== 'string' || !/^[\x21-\x7e]{1,2000}$/.test(apiKey)) return Promise.reject(new Error('Invalid Packycode API Key'));
  return new Promise((resolve, reject) => {
    let request, response, settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      response?.destroy(); request?.destroy();
      if (error) reject(error); else resolve(value);
    };
    const abort = () => finish(signal.reason || new Error('Packycode request aborted'));
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    (async () => {
      const route = await outbound.resolve(endpoint);
      if (settled) return;
      request = https.get(endpoint, { signal, agent: outbound.agent(route, signal), headers: {
        accept: 'application/json', authorization: 'Bearer ' + apiKey, 'user-agent': 'CodexTool/1.0', 'cache-control': 'no-cache',
      } });
      request.on('error', error => finish(error));
      request.on('response', incoming => {
        response = incoming;
        if (incoming.statusCode !== 200) {
          finish(Object.assign(new Error('Packycode HTTP error'), { status: incoming.statusCode, retryAfterSeconds: retryAfter(incoming.headers['retry-after']) }));
          return;
        }
        const chunks = []; let bytes = 0;
        incoming.on('data', chunk => {
          bytes += chunk.length;
          if (bytes > 1024 * 1024) { finish(new Error('Packycode response too large')); return; }
          chunks.push(chunk);
        });
        incoming.on('error', error => finish(error));
        incoming.on('aborted', () => finish(new Error('Incomplete Packycode response')));
        incoming.on('end', () => {
          try { finish(null, JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
          catch { finish(new Error('Invalid Packycode JSON')); }
        });
      });
    })().catch(error => finish(error));
  });
}

function safeFailure(error) {
  if (error.status === 429) return '查询受限（HTTP 429），请稍后刷新。';
  if ([401, 403].includes(error.status)) return '余额接口拒绝访问（HTTP ' + error.status + '），请检查该 Key 或查询地址。';
  if (Number.isInteger(error.status) && error.status >= 100 && error.status <= 599) return '余额接口返回 HTTP ' + error.status + '。';
  return '余额查询失败，请检查网络或查询地址。';
}

class PackyBalance {
  constructor({ home, outbound, getEntry, isPacky, request = requestPackyUsage, clock = Date.now, wait = (ms, signal) => delay(ms, undefined, { signal }) }) {
    Object.assign(this, { outbound, getEntry, isPacky, request, clock, wait });
    this.file = home ? path.join(home, 'relay-ui-runtime', 'packycode-balance.json') : null;
    this.cache = new Map();
    this.controller = new AbortController();
    this.configPromise = null;
    this.configQueue = Promise.resolve();
    this.generation = 0;
    this.closed = false;
    this.allowedNames = null;
  }

  settings() {
    return this.configPromise ??= (async () => {
      if (!this.file) return { ...DEFAULTS };
      try { return validateConfig(JSON.parse(await fs.readFile(this.file, 'utf8'))); }
      catch (error) { if (error.code === 'ENOENT') return { ...DEFAULTS }; throw problem('Packycode 余额设置无效，请在余额设置中重新保存。', 400); }
    })();
  }

  saveSettings(value) {
    const action = this.configQueue.then(async () => {
      this.controller.signal.throwIfAborted();
      const config = validateConfig(value);
      if (!this.file) throw problem('余额配置目录未指定。', 409);
      await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      await atomicWrite(this.file, JSON.stringify(config, null, 2) + '\n');
      if (this.closed) throw problem('管理服务已关闭，请重试。', 409);
      this.generation++;
      this.controller.abort(); this.controller = new AbortController();
      this.cache.clear(); this.configPromise = Promise.resolve(config);
      return { settings: config, message: 'Packycode 余额设置已保存。' };
    });
    this.configQueue = action.catch(() => {});
    return action;
  }

  async read(name, { force = false, baseurl } = {}) {
    this.controller.signal.throwIfAborted();
    const generation = this.generation;
    const [entry, config] = await Promise.all([this.getEntry(name), this.settings()]);
    this.controller.signal.throwIfAborted();
    if (generation !== this.generation) return this.read(name, { force, baseurl });
    if (!this.isPacky(entry.baseurl) || (baseurl !== undefined && baseurl !== entry.baseurl)) throw problem('中转配置已变化，请刷新列表后重试。', 400);
    if (this.allowedNames && !this.allowedNames.has(name)) throw problem('该子项已切换余额来源。', 409);
    const endpoint = config.api_base_url + USAGE_PATH;
    const key = createHash('sha256').update(endpoint + '\0' + entry.value).digest('hex');
    let cached = this.cache.get(key);
    if (!cached) {
      cached = { value: null, fetchedAt: null, nextFetchAt: 0, cooldownUntil: 0, pending: null, error: '', names: new Set() };
      this.cache.set(key, cached);
    }
    cached.names.add(name);
    if (!cached.pending && this.clock() >= cached.cooldownUntil && (force || this.clock() >= cached.nextFetchAt)) {
      cached.controller = new AbortController();
      cached.pending = this.refresh(cached, endpoint, entry.value, config, AbortSignal.any([this.controller.signal, cached.controller.signal])).finally(() => { cached.pending = null; });
    }
    // Bound inactive key revisions; active requests remain deduplicated.
    if (this.cache.size > 256) for (const [oldKey, old] of this.cache) {
      if (oldKey !== key && !old.pending) this.cache.delete(oldKey);
      if (this.cache.size <= 256) break;
    }
    return { kind: 'packy-key', ...cached.value, fetchedAt: cached.fetchedAt, refreshing: Boolean(cached.pending),
      state: cached.error ? (cached.value ? 'stale' : 'error') : cached.value ? 'available' : 'loading',
      message: cached.error, refreshMs: config.refresh_interval_seconds * 1000, nextRefreshAt: cached.nextFetchAt || null };
  }

  retainSources(names) {
    this.allowedNames = new Set(names);
    for (const cached of this.cache.values()) {
      if (![...cached.names].some(name => this.allowedNames.has(name))) cached.controller?.abort();
    }
  }

  async refresh(cached, endpoint, apiKey, config, signal) {
    try {
      for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
        signal.throwIfAborted();
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(new Error('Packycode request timeout')), config.request_timeout_seconds * 1000);
        let failure;
        try {
          const payload = await this.request(endpoint, { apiKey, outbound: this.outbound, signal: AbortSignal.any([signal, controller.signal]) });
          signal.throwIfAborted(); controller.signal.throwIfAborted();
          const parsed = parsePackyUsage(payload);
          parsed.tokenName = parsed.tokenName.replaceAll(apiKey, '[已隐藏]');
          cached.value = parsed; cached.fetchedAt = this.clock(); cached.error = '';
          cached.nextFetchAt = this.clock() + config.refresh_interval_seconds * 1000;
          return;
        } catch (error) { failure = error; }
        finally { clearTimeout(timer); controller.abort(); }
        signal.throwIfAborted();
        const seconds = failure.status === 429 ? retryAfter(failure.retryAfterSeconds) : null;
        if (seconds) cached.cooldownUntil = this.clock() + seconds * 1000;
        if (attempt === RETRY_DELAYS.length) {
          cached.error = safeFailure(failure);
          cached.nextFetchAt = this.clock() + config.refresh_interval_seconds * 1000;
          return;
        }
        await this.wait(seconds ? seconds * 1000 : RETRY_DELAYS[attempt], signal);
      }
    } catch {
      // Directory changes, configuration changes and service shutdown cancel all retries.
      if (!signal.aborted) { cached.error = '余额查询未完成，请稍后重试。'; cached.nextFetchAt = this.clock() + config.refresh_interval_seconds * 1000; }
    }
  }

  close() { this.closed = true; this.generation++; this.controller.abort(); this.cache.clear(); }
}

module.exports = { PackyBalance, DEFAULTS, USAGE_PATH, normalizeApiBaseUrl, validateConfig, parsePackyUsage, retryAfter, requestPackyUsage };
