const https = require('node:https');
const fs = require('node:fs/promises');
const { providerId, accountId: naturalAccountId } = require('./relay-identity');
const { problem } = require('./config-store');
const { networkAccessError } = require('./network-error');
const { readBlackaicodingStatus, MONITOR_URL, ENDPOINT: BLACKAICODING_ENDPOINT } = require('./availability-blackaicoding');
const { readBlackaicodingBalance, ENDPOINT: BLACKAICODING_BALANCE_ENDPOINT } = require('./balance-blackaicoding');
const { MonitorAuth, validateSiteToken } = require('./monitor-auth');
const { MonitorLogin } = require('./monitor-login');
const { AixorLogin } = require('./login-aixor');
const { KrillLogin } = require('./login-krill');
const { RightcodeLogin } = require('./login-rightcode');
const rightcode = require('./account-rightcode');
const rightcodeStatus = require('./availability-rightcode');
const timiccStatus = require('./availability-timicc');
const timiccKeys = require('./timicc-key-groups');
const aigoStatus = require('./availability-aigo');
const aigoKeys = require('./aigo-key-groups');
const { BrowserLogin } = require('./browser-login');
const aixor = require('./account-aixor');
const krill = require('./account-krill');
const packy = require('./account-packycode');
const { ACCOUNT_SITES, accountSite, loginEndpoints } = require('./account-sites');
const { BALANCE_ENDPOINT: INPUT_BALANCE_ENDPOINT, SUBSCRIPTIONS_ENDPOINT: INPUT_SUBSCRIPTIONS_ENDPOINT, readInputBalance, readInputSubscriptions } = require('./account-input');
const { readPerformanceStatus } = require('./availability-perf-metrics');
const { readKrillStatus } = require('./availability-krill');
const { PackyBalance } = require('./balance-packycode');

const MODELS = Object.freeze(['gpt-6-astra', 'gpt-5.6-sol']);
const REFRESH_MS = 15000;
const HISTORY_LENGTH = 60;
const STALE_MS = 180000;
const TIMICC_BALANCE_ENDPOINT = 'https://timicc.com/api/v1/auth/me';
const AIGO_BALANCE_ENDPOINT = 'https://api.aigo0.com/api/v1/auth/me';

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

// Account adapters use site login credentials. Packycode key balances have a separate transport.
const ADAPTERS = Object.freeze([{
  id: 'input', hosts: ['ai.input.im'],
  source: { name: 'AI.INPUT.IM', url: 'https://status.input.im/' },
  endpoint: 'https://status.input.im/api/status',
  parse: readInputStatus,
  balance: { endpoint: INPUT_BALANCE_ENDPOINT, parse: readInputBalance, requiresAuthorization: true },
  subscriptions: { endpoint: INPUT_SUBSCRIPTIONS_ENDPOINT, parse: readInputSubscriptions, requiresAuthorization: true },
  verifyAuthorization: { endpoint: INPUT_BALANCE_ENDPOINT, parse: readInputBalance },
}, {
  id: 'blackaicoding', hosts: ['blackaicoding.com', 'www.blackaicoding.com'],
  source: { name: 'code for me', url: MONITOR_URL },
  endpoint: BLACKAICODING_ENDPOINT,
  requiresAuthorization: true,
  parse: (data, now) => readBlackaicodingStatus(data, MODELS, now),
  balance: { endpoint: BLACKAICODING_BALANCE_ENDPOINT, parse: readBlackaicodingBalance },
  verifyAuthorization: { endpoint: BLACKAICODING_ENDPOINT, parse: data => readBlackaicodingStatus(data, MODELS) },
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
  settings: { endpoint: aixor.SETTINGS_ENDPOINT, parse: aixor.readAixorSettings },
  plans: { endpoint: aixor.PLANS_ENDPOINT, parse: aixor.readAixorPlans, requiresAuthorization: true },
  balance: { endpoint: aixor.BALANCE_ENDPOINT, parse: aixor.readAixorBalance, requiresAuthorization: true, dependencies: ['settings'] },
  subscriptions: { endpoint: aixor.SUBSCRIPTIONS_ENDPOINT, parse: aixor.readAixorSubscriptions, requiresAuthorization: true, dependencies: ['settings', 'plans'] },
  verifyAuthorization: { endpoint: aixor.BALANCE_ENDPOINT, parse: aixor.readAixorIdentity },
}, {
  id: 'packycode', hosts: ['packyapi.com', 'www.packyapi.com', 'cf.api.fan', 'slb-v1.api.fan', 'codex-api.packycode.com'],
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
  settings: { endpoint: packy.SETTINGS_ENDPOINT, parse: packy.readSettings },
  balance: { endpoint: packy.BALANCE_ENDPOINT, parse: packy.readBalance, requiresAuthorization: true, dependencies: ['settings'] },
  verifyAuthorization: { endpoint: packy.BALANCE_ENDPOINT, parse: packy.readIdentity },
}, {
  id: 'krill', hosts: ['www.krill-code.com', 'krill-code.com', 'api-slb.krill-code.net', 'api.cdn-krill-ai.com'],
  source: { name: 'Krill', url: 'https://www.krill-code.com/status' },
  endpoint: 'https://www.krill-code.com/api/public/channel-status?hours=24',
  parse: (data, now) => readKrillStatus(data, MODELS, now),
  balance: { endpoint: krill.BALANCE_ENDPOINT, parse: krill.readKrillBalance, requiresAuthorization: true },
  usage: { endpoint: krill.USAGE_ENDPOINT, body: krill.usageBody, parse: krill.readKrillUsage, requiresAuthorization: true },
  subscriptions: { endpoint: krill.SUBSCRIPTIONS_ENDPOINT, parse: krill.readKrillSubscriptions, requiresAuthorization: true, dependencies: ['usage'] },
  verifyAuthorization: { endpoint: krill.IDENTITY_ENDPOINT, parse: krill.readKrillIdentity },
}, {
  id: 'rightcode', hosts: ['rightapi.ai', 'www.rightapi.ai'],
  source: { name: 'RC', url: 'https://www.rightapi.ai/models' },
  endpoint: rightcodeStatus.ENDPOINT,
  dependencies: ['catalog'],
  parse: (data, now, model, dependencies) => rightcodeStatus.readRightcodeStatus(data, MODELS, now, dependencies.catalog),
  catalog: { endpoint: rightcodeStatus.CATALOG_ENDPOINT, parse: rightcodeStatus.codexCatalog },
  balance: { endpoint: rightcode.BALANCE_ENDPOINT, parse: rightcode.readRightcodeBalance, requiresAuthorization: true },
  verifyAuthorization: { endpoint: rightcode.BALANCE_ENDPOINT, parse: rightcode.readRightcodeBalance },
}, {
  id: 'timicc', hosts: ['timicc.com', 'www.timicc.com'],
  source: { name: 'timiCC', url: 'https://status.timicc.com/' },
  endpoint: timiccStatus.ENDPOINT,
  parse: (data, now) => timiccStatus.readTimiccStatus(data, MODELS, now),
  snapshot: timiccStatus.channelSnapshot,
  keys: { endpoint: timiccKeys.endpoint(1), load: timiccKeys.readKeyGroups, parse: value => value, requiresAuthorization: true },
  balance: { endpoint: TIMICC_BALANCE_ENDPOINT, parse: readBlackaicodingBalance, requiresAuthorization: true },
  verifyAuthorization: { endpoint: TIMICC_BALANCE_ENDPOINT, parse: readBlackaicodingBalance },
}, {
  id: 'aigo', hosts: ['api.aigo0.com'],
  source: { name: '派大星', url: 'https://api.aigo0.com/monitor' },
  endpoint: aigoStatus.ENDPOINT,
  requiresAuthorization: true,
  accountScopedStatus: true,
  parse: (data, now) => aigoStatus.readAigoStatus(data, MODELS, now),
  snapshot: aigoStatus.channelSnapshot,
  keys: { endpoint: aigoKeys.keyEndpoint(1), load: aigoKeys.readKeyGroups, parse: value => value, requiresAuthorization: true },
  balance: { endpoint: AIGO_BALANCE_ENDPOINT, parse: readBlackaicodingBalance, requiresAuthorization: true },
  verifyAuthorization: { endpoint: AIGO_BALANCE_ENDPOINT, parse: readBlackaicodingBalance },
}]);

function adapterFor(baseurl) {
  try {
    const url = new URL(baseurl);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port) return null;
    return ADAPTERS.find(adapter => adapter.hosts.includes(url.hostname)) || null;
  } catch { return null; }
}

function requestContent(url, { outbound, signal, token, json, site = 'blackaicoding', session, captureCookies }, accept) {
  const targets = { blackaicoding: [BLACKAICODING_ENDPOINT, BLACKAICODING_BALANCE_ENDPOINT], input: [INPUT_BALANCE_ENDPOINT, INPUT_SUBSCRIPTIONS_ENDPOINT],
    krill: [krill.IDENTITY_ENDPOINT, krill.BALANCE_ENDPOINT, krill.SUBSCRIPTIONS_ENDPOINT, krill.USAGE_ENDPOINT], rightcode: [rightcode.BALANCE_ENDPOINT],
    timicc: [TIMICC_BALANCE_ENDPOINT], aigo: [AIGO_BALANCE_ENDPOINT] };
  const usageQuery = site === 'krill' && url === krill.USAGE_ENDPOINT && token && !session;
  const aixorTargets = [aixor.BALANCE_ENDPOINT, aixor.SUBSCRIPTIONS_ENDPOINT, aixor.PLANS_ENDPOINT];
  const sessionTargets = site === 'aixor' ? aixorTargets : site === 'packycode' ? [packy.BALANCE_ENDPOINT] : [];
  const loginTarget = Object.hasOwn(ACCOUNT_SITES, site) && (site === 'packycode' ? packy.isLoginUrl(url) : Object.values(loginEndpoints(site)).includes(url));
  if (token && !targets[site]?.includes(url) && !(site === 'timicc' && timiccKeys.isKeyEndpoint(url)) && !(site === 'aigo' && (aigoKeys.isKeyEndpoint(url) || aigoStatus.isMonitorEndpoint(url)))) return Promise.reject(new Error('Monitor credential target rejected'));
  if (session && (!ACCOUNT_SITES[site]?.session || token || !(json === undefined ? sessionTargets : [loginEndpoints(site).totp]).includes(url))) return Promise.reject(new Error('Session credential target rejected'));
  if (captureCookies && (!ACCOUNT_SITES[site]?.session || !loginTarget || json === undefined)) return Promise.reject(new Error('Login cookie target rejected'));
  if (json !== undefined && !usageQuery && (token || !loginTarget)) return Promise.reject(new Error('Login credential target rejected'));
  if (usageQuery && (!json || Object.keys(json).sort().join(',') !== 'end_time,start_time' || ![json.start_time, json.end_time].every(value => typeof value === 'string' && Number.isFinite(Date.parse(value))) || Date.parse(json.end_time) - Date.parse(json.start_time) !== 7 * 86400000)) return Promise.reject(new Error('Invalid usage query'));
  if (session) aixor.validateAixorSession({ ...session, userId: json === undefined ? session.userId : 1 });
  const body = json === undefined ? undefined : JSON.stringify(json);
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
      const options = {
        agent: outbound.agent(route, signal), signal,
        headers: { accept, 'cache-control': 'no-cache', ...(token ? { authorization: 'Bearer ' + token } : {}),
          ...(ACCOUNT_SITES[site]?.session ? { 'user-agent': 'Mozilla/5.0 CodexTool' } : {}),
          ...(session ? { cookie: session.cookie, ...(json === undefined ? { 'New-Api-User': String(session.userId) } : {}) } : {}),
          ...(body === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }) },
      };
      request = body === undefined ? https.get(url, options) : https.request(url, { ...options, method: 'POST' });
      request.on('error', error => finish(error));
      request.on('response', incoming => {
        response = incoming;
        if (incoming.statusCode !== 200) { finish(Object.assign(new Error('Status HTTP error'), { status: incoming.statusCode })); return; }
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
          const text = Buffer.concat(chunks).toString('utf8');
          finish(null, captureCookies ? { text, cookies: incoming.headers['set-cookie'] || [] } : text);
        });
      });
      if (body !== undefined) request.end(body);
    })().catch(error => finish(error));
  });
}

async function requestJson(url, options) {
  const response = await requestContent(url, options, 'application/json');
  return options.captureCookies ? { payload: JSON.parse(response.text), cookies: response.cookies } : JSON.parse(response);
}
function requestText(url, options) { return requestContent(url, options, 'text/html'); }

class Availability {
  constructor(outbound, options = {}) {
    this.outbound = outbound;
    this.home = options.home;
    this.getEntries = options.getEntries;
    this.getEntry = options.getEntry;
    this.request = options.request;
    this.clock = options.clock || Date.now;
    this.timeoutMs = options.timeoutMs ?? 10000;
    this.auths = new Map(Object.keys(ACCOUNT_SITES).map(site => [site,
      options.auths?.[site] || (site === 'blackaicoding' && options.auth) || new MonitorAuth(options.home, site)]));
    this.cache = new Map();
    this.controller = new AbortController();
    this.authorizationQueue = Promise.resolve();
    this.authorizationVersion = 0;
    this.browserLogin = new BrowserLogin(options.browserLoginOptions);
    this.packyBalance = options.getEntry ? new PackyBalance({ ...options.packyBalanceOptions, home: options.home, outbound,
      getEntry: options.getEntry, isPacky: baseurl => adapterFor(baseurl)?.id === 'packycode' }) : null;
    this.loginClients = new Map(Object.keys(ACCOUNT_SITES).map(site => [site,
      new (ACCOUNT_SITES[site].session ? AixorLogin : site === 'krill' ? KrillLogin : site === 'rightcode' ? RightcodeLogin : MonitorLogin)((url, settings) => (this.request || requestJson)(url, { outbound: this.outbound, ...settings, site }), this.clock, site)]));
  }

  accountScope(site, entry) {
    if (!this.getEntries) return site;
    if (!/^[a-f0-9]{64}$/.test(entry?.accountId)) throw problem('账号信息已变化，请刷新页面。', 409);
    const scope = site + ':' + entry.accountId;
    if (!this.auths.has(scope)) {
      // Legacy site-wide credentials have no reliable key association. Keep them untouched.
      this.auths.set(scope, new MonitorAuth(this.home, site, entry.accountId));
      this.loginClients.set(scope, new (ACCOUNT_SITES[site].session ? AixorLogin : site === 'krill' ? KrillLogin : site === 'rightcode' ? RightcodeLogin : MonitorLogin)(
        (url, settings) => (this.request || requestJson)(url, { outbound: this.outbound, ...settings, site }), this.clock, site));
    }
    return scope;
  }

  async resolveScope(site, payload = {}) {
    accountSite(site);
    if (!this.getEntries) return site;
    const keys = (await this.getEntries()).filter(entry => adapterFor(entry.baseurl)?.id === site);
    const entry = payload.name ? keys.find(entry => entry.name === payload.name)
      : new Set(keys.map(entry => entry.accountId)).size === 1 ? keys[0] : null;
    if (!entry) throw problem('请选择需要登录的中转账号。', 400);
    if (site === 'packycode' && entry.balanceSource !== 'account') throw problem('请先将该子项的余额来源切换为登录账号余额。', 409);
    if (payload.accountId && payload.accountId !== entry.accountId) throw problem('账号或绑定关系已变化，请关闭弹窗并重新登录。', 409);
    return this.accountScope(site, entry);
  }

  async prepareBindingAuthorization({ target, binding }) {
    const site = adapterFor(target.baseurl)?.id;
    if (!Object.hasOwn(ACCOUNT_SITES, site) || target.accountId === binding.id) return [];
    const credential = await new MonitorAuth(this.home, site, target.accountId).read();
    if (!credential) return [];
    const destination = new MonitorAuth(this.home, site, binding.id);
    const before = await fs.readFile(destination.file, 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    return [{ file: destination.file, before, after: JSON.stringify(credential) + '\n' }];
  }

  changeBindings(operation) {
    return this.queueAuthorization(async () => {
      const result = await operation(plan => this.prepareBindingAuthorization(plan));
      this.authorizationVersion++;
      this.cache.clear();
      for (const id of result.affectedAccounts) this.loginClients.get(result.merchant + ':' + id)?.clear();
      return { message: result.message };
    });
  }

  async refreshPackyBalance(name) {
    const keys = this.getEntries && await this.getEntries();
    if (keys) this.retainPackySources(keys);
    const entry = keys && keys.find(entry => entry.name === name);
    if (this.getEntries && !entry) throw problem('中转配置已变化，请刷新后重试。', 409);
    if (entry?.balanceSource === 'account') throw problem('该子项使用登录账号余额，将随检测自动刷新。', 409);
    return this.packyBalance.read(entry?.accountBindingId ? entry.accountSourceName : name, { force: true });
  }

  changeBalanceSource(operation) {
    return this.queueAuthorization(async () => {
      const result = await operation();
      this.authorizationVersion++;
      if (this.getEntries) this.retainPackySources(await this.getEntries());
      return result;
    });
  }

  changeStatusMode(operation) {
    return this.queueAuthorization(async () => { const result = await operation(); this.authorizationVersion++; return result; });
  }

  async selectTimiccPool(status, entry, groups) {
    if (entry.statusMode !== 'api-key') return { ...status, statusMode: 'all' };
    const unknown = message => ({ ...status, statusMode: 'api-key', channels: [], state: 'no-data', message, modelNote: message });
    if (groups.authRequired) return unknown('请登录 timiCC 账号，以识别该 API Key 的分组。');
    // A stale group mapping must not silently display the old pool after a group change.
    if (groups.error) return unknown('API Key 分组查询失败，请检查网络或授权后重试；可切换为全部号池。');
    let key;
    try { key = await this.getEntry(entry.name); } catch { return unknown('无法读取该子项的 API Key，请刷新列表。'); }
    if (typeof key?.value !== 'string' || !key.value) return unknown('无法读取该子项的 API Key，请刷新列表。');
    if (entry.naturalAccountId && naturalAccountId(key) !== entry.naturalAccountId) return unknown('API Key 已变更，请刷新列表。');
    const group = groups.value?.[timiccKeys.keyHash(key.value)];
    if (!group) return unknown('未在授权账号中找到该 API Key，请登录对应账号；可切换为全部号池。');
    const groupName = group.groupName.replaceAll(key.value, '[已隐藏]');
    if (!group.pool) return unknown('该 API Key 的分组' + (groupName ? '「' + groupName + '」' : '') + '不对应 Team/Plus 或 Pro 号池；可切换为全部号池。');
    return { ...status, statusMode: 'api-key', keyGroup: groupName, channels: status.channels.filter(channel => channel.groupLabel === group.pool),
      modelNote: '跟随 API Key 分组「' + groupName + '」；gpt-6-astra 与 gpt-5.6-sol 共用该号池状态。' };
  }

  async selectAigoPools(status, entry, groups) {
    const unknown = message => ({ ...status, statusMode: 'api-key', channels: [], state: 'no-data', message, modelNote: message });
    const all = (extra = {}) => ({ ...status, statusMode: 'all', collapsibleChannels: true, ...extra });
    let key;
    try { key = await this.getEntry(entry.name); } catch { key = null; }
    if (typeof key?.value !== 'string' || !key.value) {
      return entry.statusMode === 'api-key' ? unknown('无法读取该子项的 API Key，请刷新列表。') : all();
    }
    if (entry.naturalAccountId && naturalAccountId(key) !== entry.naturalAccountId) {
      return entry.statusMode === 'api-key' ? unknown('API Key 已变更，请刷新列表。') : all({ modelNote: '无法确认当前 API Key 分组，全部号池按指定顺序展示。' });
    }
    if (groups?.authRequired) return entry.statusMode === 'api-key' ? unknown('请登录派大星账号，以识别该 API Key 的号池。') : all({ modelNote: '请登录派大星账号，以将当前 API Key 对应号池置顶。' });
    if (groups?.error) return entry.statusMode === 'api-key' ? unknown('API Key 号池查询失败，请检查网络或授权后重试；可切换为全部号池。') : all({ modelNote: 'API Key 号池暂时无法确认，全部号池按指定顺序展示。' });
    const group = groups?.value?.[aigoKeys.keyHash(key.value)];
    if (!group) return entry.statusMode === 'api-key' ? unknown('未在授权账号中找到该 API Key，请登录对应账号；可切换为全部号池。') : all({ modelNote: '未找到当前 API Key 的号池，全部号池按指定顺序展示。' });
    const groupName = String(group.groupName || '').replaceAll(key.value, '[已隐藏]');
    if (!group.pool) return entry.statusMode === 'api-key' ? unknown('该 API Key 的号池' + (groupName ? '「' + groupName + '」' : '') + '不在已配置的派大星监测范围内；可切换为全部号池。') : all({ modelNote: '当前 API Key 不属于已配置监测号池，全部号池按指定顺序展示。' });
    const ordered = [...status.channels].sort((a, b) => (a.groupLabel === group.pool ? -1 : b.groupLabel === group.pool ? 1 : 0));
    if (entry.statusMode === 'api-key') return { ...status, statusMode: 'api-key', keyGroup: groupName, channels: ordered.filter(channel => channel.groupLabel === group.pool),
      modelNote: '跟随 API Key 号池「' + groupName + '」；gpt-6-astra 与 gpt-5.6-sol 共用该号池状态。' };
    return { ...status, statusMode: 'all', keyGroup: groupName, channels: ordered, collapsibleChannels: true,
      modelNote: '全部号池；当前 API Key 对应「' + groupName + '」已置顶。gpt-6-astra 与 gpt-5.6-sol 共用以下号池状态。' };
  }

  retainPackySources(keys) {
    this.packyBalance?.retainSources(keys.filter(entry => adapterFor(entry.baseurl)?.id === 'packycode' && entry.balanceSource !== 'account')
      .map(entry => entry.accountBindingId ? entry.accountSourceName : entry.name));
  }

  async loginOptions(site) {
    if (site !== 'packycode') throw problem('该站点无需登录验证配置。', 400);
    const signal = AbortSignal.any([this.controller.signal, AbortSignal.timeout(this.timeoutMs)]);
    return packy.loginOptions((url, settings) => (this.request || requestJson)(url, { outbound: this.outbound, ...settings, site }), signal);
  }

  async read(adapter, model, resource = 'status', scope = adapter.id, statusScope = adapter.id) {
    const source = resource === 'status' ? adapter : adapter[resource];
    const requiresAuthorization = source.requiresAuthorization ?? adapter.requiresAuthorization;
    const perModel = typeof source.endpoint === 'function';
    const owner = resource === 'status' ? statusScope : requiresAuthorization ? scope : adapter.id;
    const key = resource !== 'status' ? owner + ':' + resource : perModel ? owner + ':' + model : owner;
    let entry = this.cache.get(key);
    if (entry?.pending) return entry.pending;
    if (entry && this.clock() - entry.at < REFRESH_MS) return entry;
    entry ||= { value: null, fetchedAt: null };
    this.cache.set(key, entry);
    entry.at = this.clock();
    entry.pending = (async () => {
      const controller = new AbortController();
      const signal = AbortSignal.any([controller.signal, this.controller.signal]);
      const timer = setTimeout(() => controller.abort(new Error('Status timeout')), this.timeoutMs);
      try {
        const credential = requiresAuthorization ? await this.auths.get(scope).read() : null;
        if (requiresAuthorization && !credential) throw Object.assign(new Error('Account authorization required'), { status: 401 });
        const endpoint = perModel ? source.endpoint(model) : source.endpoint;
        const requestedAt = this.clock();
        const request = this.request || source.request || requestJson;
        const settings = { outbound: this.outbound, signal, ...(ACCOUNT_SITES[adapter.id]?.session ? { site: adapter.id } : {}),
          ...(credential ? aixor.sessionOptions(adapter.id, credential) : {}), ...(source.body ? { json: source.body(requestedAt) } : {}) };
        const [data, dependencies] = await Promise.all([
          source.load ? source.load(request, endpoint, settings) : request(endpoint, settings),
          Promise.all((source.dependencies || []).map(async resource => {
            const entry = await this.read(adapter, model, resource, scope, statusScope);
            // Plan names are optional; quota conversion must be current and valid.
            if (entry.error && resource !== 'plans') throw Object.assign(new Error('Account metadata unavailable'), entry.authRequired ? { status: 401 } : {});
            return [resource, entry.error ? null : entry.value];
          })),
        ]);
        signal.throwIfAborted();
        entry.value = source.parse(data, source.body ? requestedAt : this.clock(), model, Object.fromEntries(dependencies));
        entry.fetchedAt = this.clock();
        entry.error = false;
        entry.authRequired = false;
      } catch (error) {
        entry.error = true;
        entry.authRequired = requiresAuthorization && [401, 403].includes(error.status);
      } finally {
        clearTimeout(timer);
        controller.abort();
      }
      return entry;
    })().finally(() => { entry.pending = null; });
    return entry.pending;
  }

  async snapshot(keys, model = MODELS[0], options = {}) {
    if (!MODELS.includes(model)) throw problem('不支持的可用性模型。', 400);
    const authorizationVersion = this.authorizationVersion;
    this.retainPackySources(options.allKeys || keys);
    if (options.automatic) keys = keys.map(entry => ['timicc', 'aigo'].includes(adapterFor(entry.baseurl)?.id) ? { ...entry, statusMode: 'api-key' } : entry);
    // Status belongs to a provider; balances and subscriptions belong to a key account.
    const monitors = new Map();
    const statusGroup = entry => entry.displayProviderId || providerId(entry.baseurl);
    for (const key of keys) {
      const adapter = adapterFor(key.baseurl);
      if (!adapter?.verifyAuthorization) continue;
      const scope = this.accountScope(adapter.id, key);
      const provider = statusGroup(key);
      const credential = adapter.requiresAuthorization ? await this.auths.get(scope).read() : null;
      if (!monitors.has(provider) || credential) monitors.set(provider, scope);
    }
    const rows = await Promise.all(keys.map(async (routeEntry) => {
      const { name, baseurl, accountId, accountBindingId, accountSourceName, displayProviderId, balanceSource } = routeEntry;
      const adapter = adapterFor(baseurl);
      const row = { name, baseurl, model, history: [], last: null, uptimePct: null,
        sampleIntervalMs: ({ input: 60000, timicc: 300000, aigo: 300000, krill: 1200000,
          aixor: 3600000, packycode: 3600000, rightcode: 3600000 })[adapter?.id] || null };
      if (!adapter) return { ...row, state: 'unsupported', message: '站点未适配' };
      const keyBalance = adapter.id === 'packycode' && balanceSource !== 'account';
      if (adapter.id === 'packycode') row.balanceSource = keyBalance ? 'api-key' : 'account';
      if (keyBalance && this.packyBalance) row.balance = await this.packyBalance.read(accountBindingId ? accountSourceName : name, accountBindingId ? {} : { baseurl }).catch(() => ({
        kind: 'packy-key', state: 'error', message: '余额配置或中转 Key 无效，请检查余额设置。', fetchedAt: null,
      }));
      const scope = adapter.verifyAuthorization ? this.accountScope(adapter.id, { accountId }) : adapter.id;
      // Krill's different subscription endpoints share one public channel monitor.
      const provider = statusGroup({ baseurl, displayProviderId });
      const statusScope = adapter.accountScopedStatus ? scope + ':status' : this.getEntries && !['krill', 'timicc'].includes(adapter.id) ? adapter.id + ':provider:' + provider : adapter.id;
      const [entry, accounts, keyGroups] = await Promise.all([
        this.read(adapter, model, 'status', adapter.accountScopedStatus ? scope : monitors.get(provider) || scope, statusScope),
        Promise.all(['balance', 'subscriptions'].map(resource => !keyBalance && adapter[resource] ? this.read(adapter, model, resource, scope, statusScope) : null)),
        adapter.id === 'timicc' && routeEntry.statusMode === 'api-key' ? this.read(adapter, model, 'keys', scope, statusScope)
          : adapter.id === 'aigo' ? this.read(adapter, model, 'keys', scope, statusScope) : null,
      ]);
      let status = entry.value?.[model];
      if (adapter.id === 'timicc' && status) status = await this.selectTimiccPool(status, routeEntry, keyGroups);
      if (adapter.id === 'aigo' && status) status = await this.selectAigoPools(status, routeEntry, keyGroups);
      accounts.forEach((account, index) => {
        if (account) row[['balance', 'subscriptions'][index]] = {
          ...account.value, fetchedAt: account.fetchedAt,
          state: account.authRequired ? 'auth-required' : account.error ? (account.value ? 'stale' : 'error') : 'available',
        };
      });
      if (row.subscriptions?.hideExpired) row.subscriptions.items = row.subscriptions.items.filter(item => item.expiresAt > this.clock());
      Object.assign(row, { source: adapter.source, fetchedAt: entry.fetchedAt, ...(adapter.verifyAuthorization && !keyBalance ? { authorizationSite: adapter.id } : {}) }, status);
      if (adapter.snapshot && status) return { ...row, ...adapter.snapshot(status, entry, this.clock()) };
      if (entry.authRequired) return { ...row, state: 'auth-required', message: '监控需要授权或授权已过期' };
      if (entry.error) return { ...row, state: status ? 'stale' : 'error', message: status ? '刷新失败，保留上次样本' : '状态源暂时无法连接' };
      if (status?.disabled) return { ...row, state: 'unavailable', message: '站点标记该模型不可用' };
      if (!status?.last) return { ...row, state: 'no-data', message: '状态源暂无该模型样本' };
      if (status.stale || (Number.isFinite(status.last.at) && this.clock() - status.last.at > (status.staleAfterMs ?? STALE_MS))) return { ...row, state: 'stale', message: '状态源样本已过期' };
      if (status.last.state === 'degraded') return { ...row, state: 'degraded', message: '降级' };
      if (status.last.state === 'no-data') return { ...row, state: 'no-data', message: status.noDataMessage || '最近时段无请求' };
      return { ...row, state: status.last.ok ? 'available' : 'unavailable', message: status.last.ok ? '可用' : '异常' };
    }));
    // An account change during a refresh must not return the previous account's balance.
    if (authorizationVersion !== this.authorizationVersion) return this.snapshot(this.getEntries ? await this.getEntries() : keys, model, options);
    return { model, models: MODELS, refreshMs: REFRESH_MS, historyLength: HISTORY_LENGTH, rows };
  }

  invalidateAuthorization(site, scope = site) {
    this.authorizationVersion++;
    for (const key of this.cache.keys()) {
      if (key === site || key.startsWith(site + ':provider:') || key.startsWith(scope + ':')) this.cache.delete(key);
    }
  }

  authorize(site, token, userId, payload) {
    return this.queueAuthorization(async () => this.saveAuthorization(site,
      accountSite(site).session && token !== '' ? { cookie: token, userId } : token, await this.resolveScope(site, payload)));
  }

  queueAuthorization(operation) {
    const action = this.authorizationQueue.then(() => { this.controller.signal.throwIfAborted(); return operation(); });
    this.authorizationQueue = action.catch(() => {});
    return action;
  }

  login(payload) {
    return this.queueAuthorization(async () => {
      const scope = await this.resolveScope(payload.site, payload);
      const controller = new AbortController();
      const signal = AbortSignal.any([this.controller.signal, controller.signal]);
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      let result;
      try { result = await this.loginClients.get(scope).login(payload, signal); }
      finally { clearTimeout(timer); controller.abort(); }
      if (result.requires2fa) return result;
      if (scope !== await this.resolveScope(payload.site, payload)) throw problem('账号或绑定关系已变化，请重新登录。', 409);
      return this.saveAuthorization(payload.site, result.credential || result.token, scope);
    });
  }

  async startBrowserLogin(payload) {
    if (payload.site !== 'aigo') throw problem('该站点不使用浏览器登录。', 400);
    const scope = await this.resolveScope(payload.site, payload);
    const version = this.authorizationVersion;
    const original = this.getEntry ? naturalAccountId(await this.getEntry(payload.name)) : null;
    return this.browserLogin.start(scope, (token, signal) => this.queueAuthorization(async () => {
      signal.throwIfAborted();
      if (version !== this.authorizationVersion || scope !== await this.resolveScope(payload.site, payload) ||
          (original && original !== naturalAccountId(await this.getEntry(payload.name)))) throw problem('账号配置或授权已变化，请重新打开登录窗口。', 409);
      return this.saveAuthorization(payload.site, token, scope, signal);
    }), { presentation: payload.presentation, viewport: payload.viewport });
  }

  browserLoginStatus(id) { return this.browserLogin.status(id); }
  browserLoginSurface(id, event) { return this.browserLogin.surface(id, event); }
  cancelBrowserLogin(id) { return this.browserLogin.cancel(id); }

  cancelLogin(site, challengeId, payload) {
    accountSite(site);
    const cancel = scope => { this.loginClients.get(scope).cancel(challengeId); return { message: '已取消二次验证。' }; };
    return this.getEntries ? this.resolveScope(site, payload).then(cancel) : cancel(site);
  }

  async saveAuthorization(site, token, scope = site, externalSignal) {
    const definition = accountSite(site);
    const auth = this.auths.get(scope), login = this.loginClients.get(scope);
    if (token === '') {
      login.clear();
      await auth.clear();
      this.invalidateAuthorization(site, scope);
      return { message: '已清除 ' + definition.name + ' 账号授权。' };
    }
    const credential = definition.session ? aixor.validateAixorSession(token) : validateSiteToken(site, token);
    const controller = new AbortController();
    const signal = AbortSignal.any([this.controller.signal, controller.signal, ...(externalSignal ? [externalSignal] : [])]);
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const verification = ADAPTERS.find(adapter => adapter.id === site).verifyAuthorization;
      const data = await (this.request || requestJson)(verification.endpoint, { outbound: this.outbound, signal, ...aixor.sessionOptions(site, credential) });
      signal.throwIfAborted();
      const verified = verification.parse(data);
      if (definition.session && verified.userId !== credential.userId) throw new Error('Account identity mismatch');
    } catch (error) {
      const networkError = networkAccessError(error, ' ' + definition.name, signal);
      if (networkError) throw networkError;
      throw problem([401, 403].includes(error.status) ? '账号授权无效或无访问权限，请重新登录。' : '未能验证账号授权，请稍后重试。', 400);
    } finally { clearTimeout(timer); controller.abort(); }
    externalSignal?.throwIfAborted();
    await auth.save(definition.session ? credential : credential.token);
    login.clear();
    this.invalidateAuthorization(site, scope);
    return { message: definition.name + ' 账号授权已保存，过期后可在这里重新登录。', expiresAt: credential.expiresAt };
  }

  async close() {
    this.controller.abort();
    this.packyBalance?.close();
    for (const client of this.loginClients.values()) client.clear();
    this.cache.clear();
    await this.browserLogin.close();
  }
}

module.exports = { Availability, MODELS, REFRESH_MS, adapterFor, readInputStatus, requestJson, requestText };
