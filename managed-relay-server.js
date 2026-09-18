const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { ConfigStore, problem } = require('./managed-relay-runtime/config-store');
const { createProxy } = require('./managed-relay-runtime/proxy');
const { Outbound } = require('./managed-relay-runtime/outbound');
const { Diagnostics } = require('./managed-relay-runtime/diagnostics');
const { Availability } = require('./managed-relay-runtime/availability');
const { networkAccessError } = require('./managed-relay-runtime/network-error');
const { settingsPath, readSettings, writeSettings, writeConfigHome, writeConfigAppPath, resolveAppPath, resolveHome, displayPath } = require('./managed-relay-runtime/settings');
const { configPath, loadCodexConfig, resolveCodexPaths } = require('./managed-relay-runtime/codex-config');

const PUBLIC_DIR = path.join(__dirname, 'managed-relay-public');
const TYPES = { '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };

function json(res, status, body) {
  if (res.destroyed) return;
  if (res.headersSent) { res.destroy(); return; }
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function body(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64 * 1024) throw problem('请求内容过大。', 413);
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
  catch { throw problem('请求 JSON 无效。', 400); }
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  });
}

function close(server) {
  return new Promise(resolve => { server.close(resolve); server.closeProxyConnections?.(); server.closeAllConnections?.(); });
}

async function start(options = {}) {
  const proxyPort = Number(options.proxyPort ?? process.env.RELAY_PROXY_PORT ?? 3211);
  const uiPort = Number(options.uiPort ?? process.env.RELAY_UI_PORT ?? 3790);
  for (const port of [proxyPort, uiPort]) if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid port');
  // 目录优先级：启动参数 > CODEX_HOME > 项目 JSON 配置文件 > 已保存的设置 > 默认 ~/.codex。
  // 前两者视为外部显式指定，此时既不读也不写设置文件，避免污染用户配置。
  // 配置文件是随项目分发的，所以它比“已保存的设置”优先：换项目后不用重新填目录。
  const externalHome = options.home || process.env.CODEX_HOME || null;
  const fileConfig = loadCodexConfig(configPath(process.env));
  const paths = resolveCodexPaths({ env: process.env, config: fileConfig });
  const savedHome = externalHome || paths.home ? null : (await readSettings()).home;
  const initialHome = externalHome || paths.home || savedHome || path.join(os.homedir(), '.codex');
  const homeLocked = Boolean(externalHome);
  let homeSource = options.home ? 'argument' : process.env.CODEX_HOME ? 'env' : paths.home ? 'config' : savedHome ? 'saved' : 'default';
  const settingsFile = settingsPath();
  let appPath = paths.appPath;
  let appPathSource = paths.appSource;
  const appPathLocked = paths.appSource === 'env';

  const build = (target, injected) => {
    const store = new ConfigStore(target, 'http://127.0.0.1:' + proxyPort + '/v1');
    const outbound = injected || new Outbound(target, { localPorts: [proxyPort, uiPort] });
    return { store, outbound, diagnostics: new Diagnostics(target), availability: new Availability(outbound, {
      ...options.availabilityOptions, home: target, getEntry: name => store.entry(name), getEntries: async () => (await store.status()).keys,
    }) };
  };
  // holder 的字段会被原地替换；下面的 facade 让代理与请求处理器始终读到当前目录的对象。
  const holder = { home: initialHome, ...build(initialHome, options.outbound) };
  const live = key => new Proxy({}, {
    get: (_target, prop) => {
      const value = holder[key][prop];
      return typeof value === 'function' ? value.bind(holder[key]) : value;
    },
    set: (_target, prop, value) => { holder[key][prop] = value; return true; },
  });
  const store = live('store');
  const outbound = live('outbound');
  const diagnostics = live('diagnostics');
  const availability = live('availability');
  const record = entry => {
    const safe = diagnostics.record(entry);
    (options.log || console.log)(JSON.stringify(safe));
  };
  let lastRequest = null;
  let lastDiagnostic = null;
  let boundPorts = [];
  const proxy = createProxy(store, entry => {
    lastRequest = entry;
    record({ event: 'relay_request', ...entry });
  }, options.timeoutMs, outbound, options.connectTimeoutMs, entry => record({ event: 'relay_request_started', ...entry }));
  const lockReason = '当前目录由环境变量或启动参数指定，不能在页面修改。';
  const status = async () => {
    const current = await store.status();
    const entry = current.keys.find(item => item.name === current.selectedProxyName);
    return { ...current, home: homeSource === 'default' ? displayPath(holder.home) : path.resolve(holder.home),
      homeSource, homeLocked, settingsPath: displayPath(settingsFile),
      configPath: displayPath(paths.configFile), codexAppPath: appPath || null, appPathSource, appPathLocked,
      lastRequest, lastDiagnostic, diagnosticsAvailable: true, availabilityAvailable: true, accountGroupingAvailable: true, network: await outbound.status(entry?.baseurl) };
  };
  // 切换目录：先构建并验证新目录确实可用，再落盘，最后替换，任何一步失败都不会留下不一致状态。
  let savingPaths = false;
  const switchHome = async target => {
    if (homeLocked) throw problem(lockReason, 409);
    if (savingPaths) throw problem('目录或应用路径正在保存，请稍后重试。', 409);
    savingPaths = true;
    let next;
    try {
      const { home: resolved, created } = await resolveHome(target);
      next = build(resolved);
      next.store.proxyUrl = 'http://127.0.0.1:' + proxy.address().port + '/v1';
      for (const port of boundPorts) next.outbound.localPorts.add(port);
      await next.store.status();
      const fromConfig = homeSource === 'config';
      if (fromConfig) await writeConfigHome(paths.configFile, resolved);
      else await writeSettings({ home: resolved });
      const previous = { outbound: holder.outbound, diagnostics: holder.diagnostics, availability: holder.availability };
      Object.assign(holder, { home: resolved, ...next });
      next = null;
      homeSource = fromConfig ? 'config' : 'saved';
      await previous.availability.close();
      previous.outbound.close();
      await previous.diagnostics.close();
      lastRequest = null;
      lastDiagnostic = null;
      return { message: `已切换到 ${resolved}，已保存到${fromConfig ? ' JSON 配置文件' : '目录设置'}${created ? '，并创建了空的 key_config.json' : ''}。` };
    } finally {
      if (next) { await next.availability.close(); next.outbound.close(); await next.diagnostics.close(); }
      savingPaths = false;
    }
  };
  const switchAppPath = async target => {
    if (appPathLocked) throw problem('应用路径由 CODEX_APP_PATH 环境变量指定，不能在页面修改。', 409);
    if (savingPaths) throw problem('目录或应用路径正在保存，请稍后重试。', 409);
    savingPaths = true;
    try {
      const resolved = await resolveAppPath(target);
      await writeConfigAppPath(paths.configFile, resolved || '');
      appPath = resolved;
      appPathSource = resolved ? 'config' : null;
      return { message: resolved ? '应用路径已保存，下次通过启动脚本启动时生效。' : '已保存，下次启动时自动查找 ChatGPT，找不到再查找 Codex。' };
    } finally { savingPaths = false; }
  };
  let uiUrl;
  const ui = http.createServer((req, res) => {
    (async () => {
      if (req.headers.host !== new URL(uiUrl).host) throw problem('Host 不允许。', 403);
      const url = new URL(req.url, uiUrl);
      if (req.method === 'POST') {
        if (req.headers.origin && req.headers.origin !== uiUrl) throw problem('跨站请求不允许。', 403);
        if (!String(req.headers['content-type']).startsWith('application/json')) throw problem('需要 JSON 请求。', 415);
        const payload = await body(req);
        if (url.pathname.startsWith('/api/availability/browser-login/')) {
          const action = url.pathname.slice('/api/availability/browser-login/'.length);
          const result = action === 'start' ? await availability.startBrowserLogin(payload)
            : action === 'status' ? availability.browserLoginStatus(payload.id)
              : action === 'frame' ? await availability.browserLoginSurface(payload.id)
                : action === 'input' ? await availability.browserLoginSurface(payload.id, payload.event ?? null)
              : action === 'cancel' ? availability.cancelBrowserLogin(payload.id) : null;
          if (!result) throw problem('接口不存在。', 404);
          json(res, 200, result); return;
        }
        let result;
        if (url.pathname === '/api/select') result = await store.select(payload.name, payload.mode);
        else if (url.pathname === '/api/proxy/install') result = await store.install(payload.name);
        else if (url.pathname === '/api/proxy/restore') result = await store.restore();
        else if (url.pathname === '/api/keys') result = await store.add(payload);
        else if (url.pathname === '/api/keys/edit') result = await store.edit(payload.originalName, payload);
        else if (url.pathname === '/api/reorder') result = await store.reorder(payload.names);
        else if (url.pathname === '/api/pin') result = await store.pin(payload.name, payload.pinned);
        else if (url.pathname === '/api/accounts/bind') result = await availability.changeBindings(prepare => store.bindAccounts(payload, prepare));
        else if (url.pathname === '/api/accounts/unbind') result = await availability.changeBindings(() => store.unbindAccount(payload));
        else if (url.pathname === '/api/availability/authorization') result = await availability.authorize(payload.site, payload.token, payload.userId, payload);
        else if (url.pathname === '/api/availability/login') result = await availability.login(payload);
        else if (url.pathname === '/api/availability/login/cancel') result = await availability.cancelLogin(payload.site, payload.challengeId, payload);
        else if (url.pathname === '/api/packycode/balance/refresh') result = { balance: await availability.refreshPackyBalance(payload.name) };
        else if (url.pathname === '/api/packycode/balance/settings') result = await availability.packyBalance.saveSettings(payload);
        else if (url.pathname === '/api/packycode/balance/source') result = await availability.changeBalanceSource(() => store.setPackyBalanceSource(payload));
        else if (url.pathname === '/api/timicc/status/mode') result = await availability.changeStatusMode(() => store.setTimiccStatusMode(payload));
        else if (url.pathname === '/api/aigo/status/mode') result = await availability.changeStatusMode(() => store.setAigoStatusMode(payload));
        else if (url.pathname === '/api/network') result = await outbound.save(payload);
        else if (url.pathname === '/api/network/test') {
          const entry = await store.entry(payload.name);
          lastDiagnostic = { at: new Date().toISOString(), ...await outbound.test(entry) };
          record({ event: 'relay_diagnostic', ...lastDiagnostic });
          result = { diagnostic: lastDiagnostic };
        }
        else if (url.pathname === '/api/home') result = await switchHome(payload.home);
        else if (url.pathname === '/api/app-path') result = await switchAppPath(payload.appPath);
        else throw problem('接口不存在。', 404);
        json(res, 200, { ...result, status: await status() });
        return;
      }
      if (req.method !== 'GET') throw problem('方法不允许。', 405);
      if (url.pathname === '/api/status') { json(res, 200, await status()); return; }
      if (url.pathname === '/api/packycode/balance/settings') { json(res, 200, { settings: await availability.packyBalance.settings() }); return; }
      if (url.pathname === '/api/availability/login/options') { json(res, 200, await availability.loginOptions(url.searchParams.get('site'))); return; }
      if (url.pathname === '/api/availability') {
        const current = holder;
        const monitor = current.availability;
        const { keys } = await current.store.status();
        json(res, 200, await monitor.snapshot(keys, url.searchParams.get('model') ?? undefined));
        return;
      }
      if (url.pathname === '/api/diagnostics') { json(res, 200, diagnostics.snapshot()); return; }
      const requested = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      const file = path.resolve(PUBLIC_DIR, requested);
      if (!file.startsWith(PUBLIC_DIR + path.sep)) throw problem('Forbidden', 403);
      const content = await fs.readFile(file).catch(() => { throw problem('Not found', 404); });
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(content);
    })().catch(error => {
      const failure = error.status ? error : networkAccessError(error) || error;
      json(res, failure.status || 500, { error: failure.status ? failure.message : '本地服务操作失败，请检查配置文件及权限。' });
    });
  });
  try {
    await listen(proxy, proxyPort);
    store.proxyUrl = 'http://127.0.0.1:' + proxy.address().port + '/v1';
    await store.status();
    await listen(ui, uiPort);
    uiUrl = 'http://127.0.0.1:' + ui.address().port;
    boundPorts = [proxy.address().port, ui.address().port];
    outbound.localPorts.add(proxy.address().port);
    outbound.localPorts.add(ui.address().port);
  } catch (error) { await availability.close(); await close(proxy); await close(ui); outbound.close(); await diagnostics.close(); throw error; }
  return { uiUrl, proxyUrl: store.proxyUrl, store, outbound, status, close: async () => { await availability.close(); await close(ui); await close(proxy); outbound.close(); await diagnostics.close(); } };
}

if (require.main === module) {
  start().then(async app => {
    console.log('Relay UI: ' + app.uiUrl);
    console.log('Local proxy: ' + app.proxyUrl);
    const state = await app.status();
    console.log('Configured mode: ' + state.mode + '; selected proxy route: ' + (state.selectedProxyName || 'none'));
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await app.close(); process.exit(0); });
  }).catch(error => { console.error('Relay UI startup failed: ' + (error.code || error.message)); process.exitCode = 1; });
}

module.exports = { start };
