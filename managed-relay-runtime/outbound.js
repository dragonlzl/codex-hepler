const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const { ProxyAgent } = require('proxy-agent');
const { getProxyForUrl } = require('proxy-from-env');
const { atomicWrite, problem } = require('./config-store');
const { readWindowsProxies } = require('./windows-proxy');
const { PackyDns, HOST: PACKY_HOST } = require('./packy-dns');
const { readMacProxies, detectFlyingBirdProxy, systemProxyFor, bypasses, loopback } = require('./system-proxy');

function labelProxy(url) {
  if (!url) return 'DIRECT';
  const pac = url.startsWith('pac+');
  const parsed = new URL(pac ? url.slice(4) : url);
  return (pac ? 'PAC ' : '') + `${parsed.protocol}//${parsed.host}`;
}

function safeError(error) {
  const valid = code => typeof code === 'string' && /^[A-Z0-9_]{1,64}$/.test(code) ? code : null;
  return { errorCode: valid(error?.code) || 'UPSTREAM_ERROR', causeCodes: [...new Set((error?.errors || []).map(e => valid(e.code)).filter(Boolean))] };
}

class Outbound {
  constructor(home, options = {}) {
    this.file = path.join(home, 'relay-ui-runtime', 'network.json');
    this.readSystem = options.readSystem || (process.platform === 'win32' ? readWindowsProxies : readMacProxies);
    this.readFlyingBird = options.readFlyingBird || (() => detectFlyingBirdProxy(options.flyingbird));
    this.envProxy = options.envProxy || getProxyForUrl;
    this.clock = options.clock || Date.now;
    this.cacheMs = options.cacheMs ?? 2000;
    this.systemCache = null;
    this.pendingSystem = null;
    this.flyingbirdCache = null;
    this.pendingFlyingBird = null;
    this.flyingbirdCacheMs = options.flyingbirdCacheMs ?? 2000;
    this.agents = new Map();
    this.activeAgents = new Set();
    this.localPorts = new Set(options.localPorts || []);
    this.closed = false;
    this.packyDns = new PackyDns(options.packyDnsOptions);
  }

  async settings() {
    try { return this.validate(JSON.parse(await fs.readFile(this.file, 'utf8'))); }
    catch (error) { if (error.code === 'ENOENT') return { mode: 'auto', proxyUrl: '' }; throw error; }
  }

  validate(value) {
    if (!value || !['auto', 'direct', 'proxy'].includes(value.mode)) throw problem('请选择有效的出站方式。', 400);
    const proxyUrl = typeof value.proxyUrl === 'string' ? value.proxyUrl.trim() : '';
    if (proxyUrl) {
      let url;
      try { url = new URL(proxyUrl); } catch { throw problem('代理地址无效。', 400); }
      if (!['http:', 'https:', 'socks:', 'socks4:', 'socks4a:', 'socks5:', 'socks5h:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash || (url.pathname && url.pathname !== '/')) {
        throw problem('请输入不含账号密码的 HTTP(S) 或 SOCKS 代理地址。', 400);
      }
      this.guardLoop(url);
    }
    if (value.mode === 'proxy' && !proxyUrl) throw problem('请填写 VPN 提供的代理地址和端口。', 400);
    return { mode: value.mode, proxyUrl };
  }

  guardLoop(url) {
    if (loopback(url.hostname) && this.localPorts.has(Number(url.port || (url.protocol === 'https:' ? 443 : 80)))) throw problem('出站代理不能指向本工具自己的端口。', 400);
  }

  async save(value) {
    const settings = this.validate(value);
    await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    await atomicWrite(this.file, JSON.stringify(settings, null, 2) + '\n');
    this.systemCache = null;
    return { message: '出站设置已保存，后续请求生效，无需重启 Codex。' };
  }

  async system() {
    if (this.systemCache && this.clock() - this.systemCache.at < this.cacheMs) return this.systemCache.value;
    if (!this.pendingSystem) {
      this.pendingSystem = this.readSystem().then(value => {
        this.systemCache = { value, at: this.clock() }; return value;
      }).finally(() => { this.pendingSystem = null; });
    }
    return this.pendingSystem;
  }

  async flyingbird() {
    if (this.flyingbirdCache && this.clock() - this.flyingbirdCache.at < this.flyingbirdCacheMs) return this.flyingbirdCache.value;
    if (!this.pendingFlyingBird) {
      this.pendingFlyingBird = this.readFlyingBird().then(value => {
        this.flyingbirdCache = { value, at: this.clock() }; return value;
      }).catch(() => null).finally(() => { this.pendingFlyingBird = null; });
    }
    return this.pendingFlyingBird;
  }

  async resolve(target, options = {}) {
    target = new URL(target);
    if (loopback(target.hostname)) return { proxyUrl: '', source: 'loopback', label: 'DIRECT' };
    const settings = options.settings || await this.settings();
    let route = { proxyUrl: '', source: 'direct' };
    if (settings.mode === 'proxy') route = { proxyUrl: settings.proxyUrl, source: 'manual' };
    else if (settings.mode === 'auto') {
      // On macOS the active VPN configuration wins over stale shell proxy variables.
      const system = await this.system();
      const enabled = ['HTTPEnable', 'HTTPSEnable', 'SOCKSEnable', 'ProxyAutoConfigEnable', 'ProxyAutoDiscoveryEnable'].some(key => system[key]);
      if (enabled) {
        route = systemProxyFor(target, system);
        // FlyingBird can briefly leave macOS with an enabled but target-inapplicable
        // proxy while refreshing smart-connection state. Use its confirmed mixed port
        // instead of silently falling back to direct for that window.
        if (!route.proxyUrl && route.source === 'direct') {
          const flyingbird = await this.flyingbird();
          if (flyingbird) route = { proxyUrl: flyingbird.proxyUrl, source: flyingbird.source };
        }
      }
      else {
        const url = this.envProxy(target.href);
        if (url) route = { proxyUrl: url, source: 'environment' };
        else {
          const flyingbird = await this.flyingbird();
          if (flyingbird) route = { proxyUrl: flyingbird.proxyUrl, source: flyingbird.source };
        }
      }
    }
    if (route.proxyUrl && !route.proxyUrl.startsWith('pac+')) this.guardLoop(new URL(route.proxyUrl));
    return { ...route, label: labelProxy(route.proxyUrl) };
  }

  lookup(target, route) {
    const url = new URL(target);
    return !route.proxyUrl && url.protocol === 'https:' && url.hostname === PACKY_HOST ? this.packyDns.lookup : undefined;
  }

  agent(route, signal) {
    if (this.closed) throw new Error('Outbound closed');
    if (!route.proxyUrl) return false;
    if (signal) {
      const agent = new ProxyAgent({ getProxyForUrl: () => route.proxyUrl, keepAlive: false, signal, socketOptions: { signal }, fallbackToDirect: false });
      const release = () => { agent.destroy(); agent.httpAgent.destroy(); agent.httpsAgent.destroy(); this.activeAgents.delete(agent); };
      if (signal.aborted) release();
      else { this.activeAgents.add(agent); signal.addEventListener('abort', release, { once: true }); }
      return agent;
    }
    if (!this.agents.has(route.proxyUrl)) this.agents.set(route.proxyUrl, new ProxyAgent({
      getProxyForUrl: () => route.proxyUrl, keepAlive: false, timeout: 10000,
      fallbackToDirect: false,
    }));
    return this.agents.get(route.proxyUrl);
  }

  async status(target) {
    const settings = await this.settings();
    const flyingbird = settings.mode === 'auto' ? await this.flyingbird() : null;
    try {
      const route = target ? await this.resolve(target, { settings }) : null;
      return {
        ...settings,
        effective: route?.label || null,
        source: route?.source || null,
        flyingbird: flyingbird ? { available: true, route: labelProxy(flyingbird.proxyUrl) } : { available: false },
      };
    } catch (error) { return { ...settings, error: error.message }; }
  }

  async test(entry) {
    const start = Date.now();
    let route;
    const controller = new AbortController();
    try {
      const target = new URL(entry.baseurl);
      target.pathname = target.pathname.replace(/\/$/, '') + '/models';
      route = await this.resolve(target);
      const status = await new Promise((resolve, reject) => {
        const request = (target.protocol === 'https:' ? https : http).get(target, {
          agent: this.agent(route, controller.signal), signal: controller.signal, headers: { authorization: `Bearer ${entry.value}`, accept: 'application/json' },
        });
        const timer = setTimeout(() => {
          const error = Object.assign(new Error('diagnostic timeout'), { code: 'DIAGNOSTIC_TIMEOUT' });
          reject(error); controller.abort(error); request.destroy(error);
        }, 10000);
        request.on('response', response => { clearTimeout(timer); resolve(response.statusCode); response.destroy(); });
        request.on('error', error => { clearTimeout(timer); reject(error); });
      });
      return { provider: entry.name, reachable: true, status, route: route.label, source: route.source, durationMs: Date.now() - start };
    } catch (error) { return { provider: entry.name, reachable: false, route: route?.label, source: route?.source, ...safeError(error), durationMs: Date.now() - start }; }
    finally { controller.abort(); }
  }

  close() { this.closed = true; this.packyDns.close(); for (const agent of [...this.agents.values(), ...this.activeAgents]) { agent.destroy(); agent.httpAgent?.destroy(); agent.httpsAgent?.destroy(); } this.agents.clear(); this.activeAgents.clear(); }
}

module.exports = { Outbound, readMacProxies, detectFlyingBirdProxy, systemProxyFor, bypasses, loopback, safeError, labelProxy };
