const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const { createHash } = require('node:crypto');
const bundled = require('./assets/codex-models.json');

const CATALOG_SUFFIX = '/codex/models';
const catalogUrl = baseUrl => baseUrl.replace(/\/$/, '') + CATALOG_SUFFIX;
const failure = (message, status = 502) => Object.assign(new Error(message), { status });
const routeKey = entry => createHash('sha256').update(JSON.stringify([entry.baseurl, entry.value])).digest('hex');
const local = value => { try { return ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(value).hostname); } catch { return false; } };
const managedCatalog = info => local(info.baseUrl) && info.provider?.model_catalog_url === catalogUrl(info.baseUrl);

function catalogStatus(info, proxyUrl) {
  const profile = info.config?.profile && info.config.profiles?.[info.config.profile];
  const existing = info.provider?.model_catalog_url;
  const reason = profile?.model_catalog_json || info.config?.model_catalog_json
    ? '当前已配置自定义模型目录文件，请保留或先在 Codex 中调整该配置。'
    : (profile?.features?.api_key_model_discovery ?? info.config?.features?.api_key_model_discovery) === false
      ? 'Codex 配置已关闭 API Key 模型发现，请先在 Codex 中启用该设置。'
    : existing && !managedCatalog(info) && existing !== catalogUrl(proxyUrl)
      ? '当前提供方已配置自定义模型目录地址，工具会保留该配置。' : null;
  return { available: !reason, enabled: managedCatalog(info) && info.baseUrl.replace(/\/$/, '') === proxyUrl.replace(/\/$/, ''), blockedReason: reason };
}

function compatible(model) {
  // Use complete, model-specific metadata. Never infer a new model's capabilities from its name.
  return model && typeof model.slug === 'string' && typeof model.display_name === 'string' &&
    Array.isArray(model.supported_reasoning_levels) && typeof model.shell_type === 'string' &&
    ['list', 'hide'].includes(model.visibility) && typeof model.supported_in_api === 'boolean' &&
    Number.isInteger(model.priority) && typeof model.support_verbosity === 'boolean' &&
    model.truncation_policy && Array.isArray(model.experimental_supported_tools) &&
    (typeof model.model_messages?.instructions_template === 'string' || typeof model.base_instructions === 'string');
}

function buildCatalog(payload, metadata) {
  const entries = Array.isArray(payload?.data) ? payload.data : payload?.models;
  if (!Array.isArray(entries)) throw failure('上游模型列表格式无效，需要 data 或 models 数组。');
  const ids = new Set(entries.map(model => typeof model === 'string' ? model : model?.id || model?.slug));
  const models = metadata.filter(model => compatible(model) && model.supported_in_api && ids.has(model.slug));
  if (!models.some(model => model.visibility === 'list')) throw failure('上游未列出具有 Codex 元数据的可选模型，已保留现有配置。');
  return { models };
}

class CodexModelCatalog {
  constructor(home, store, outbound, options = {}) {
    this.home = home;
    this.store = store;
    this.outbound = outbound;
    this.clock = options.clock || Date.now;
    this.cacheMs = options.cacheMs ?? 60000;
    this.timeoutMs = options.timeoutMs ?? 10000;
    this.maxBytes = options.maxBytes ?? 2 * 1024 * 1024;
    this.cache = new Map();
    this.pending = new Map();
    this.controllers = new Set();
    this.closed = false;
  }

  async metadata() {
    const models = new Map(bundled.models.map(model => [model.slug, model]));
    try {
      const file = path.join(this.home, 'models_cache.json');
      if ((await fs.stat(file)).size <= 8 * 1024 * 1024) {
        const cached = JSON.parse(await fs.readFile(file, 'utf8'));
        for (const model of cached.models || []) if (!models.has(model.slug) && compatible(model)) models.set(model.slug, model);
      }
    } catch { /* An absent or damaged optional cache does not replace the bundled catalog. */ }
    return [...models.values()];
  }

  async fetchModels(entry) {
    const controller = new AbortController();
    this.controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const target = new URL(entry.baseurl);
      target.pathname = target.pathname.replace(/\/$/, '') + '/models';
      const route = await this.outbound.resolve(target);
      if (this.closed || controller.signal.aborted) throw failure('读取上游模型列表已取消或超时。');
      const payload = await new Promise((resolve, reject) => {
        const request = (target.protocol === 'https:' ? https : http).get(target, {
          signal: controller.signal, agent: this.outbound.agent(route, controller.signal),
          headers: { authorization: `Bearer ${entry.value}`, accept: 'application/json', 'user-agent': 'CodexTool/1.0', 'accept-encoding': 'identity' },
        }, response => {
          if (response.statusCode !== 200) {
            response.destroy();
            reject(failure(`上游模型列表返回 HTTP ${response.statusCode}。`, [401, 403].includes(response.statusCode) ? response.statusCode : 502));
            return;
          }
          const chunks = [];
          let size = 0;
          response.on('data', chunk => {
            size += chunk.length;
            if (size > this.maxBytes) { reject(failure('上游模型列表超过大小限制。')); response.destroy(); }
            else chunks.push(chunk);
          });
          response.on('end', () => {
            try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
            catch { reject(failure('上游模型列表不是有效的 JSON。')); }
          });
          response.on('error', () => reject(failure('上游模型列表读取中断。')));
          response.on('aborted', () => reject(failure('上游模型列表读取中断。')));
        });
        request.on('error', () => reject(failure(controller.signal.aborted ? '读取上游模型列表已取消或超时。' : '无法连接上游模型列表，请检查网络设置。')));
      });
      return buildCatalog(payload, await this.metadata());
    } finally { clearTimeout(timer); this.controllers.delete(controller); }
  }

  async snapshot({ force = false } = {}) {
    if (this.closed) throw failure('模型目录服务已关闭。', 503);
    const entry = await this.store.activeEntry();
    const key = routeKey(entry);
    let cached = this.cache.get(key);
    if (force || !cached || cached.expiresAt <= this.clock()) {
      if (!this.pending.has(key)) {
        const pending = this.fetchModels(entry).then(catalog => {
          const result = { catalog, expiresAt: this.clock() + this.cacheMs };
          if (!this.closed) {
            this.cache.delete(key);
            this.cache.set(key, result);
            if (this.cache.size > 16) this.cache.delete(this.cache.keys().next().value);
          }
          return result;
        }).catch(error => { this.cache.delete(key); throw error; }).finally(() => this.pending.delete(key));
        this.pending.set(key, pending);
      }
      cached = await this.pending.get(key);
    }
    if (this.closed || routeKey(await this.store.activeEntry()) !== key) throw failure('中转配置已切换，请重新同步或打开模型选择器。', 409);
    return { catalog: cached.catalog, routeKey: key };
  }

  close() {
    this.closed = true;
    for (const controller of this.controllers) controller.abort();
    this.cache.clear();
  }
}

module.exports = { CodexModelCatalog, buildCatalog, compatible, catalogUrl, catalogStatus, managedCatalog, routeKey, CATALOG_SUFFIX };
