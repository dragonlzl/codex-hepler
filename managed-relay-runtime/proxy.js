const http = require('node:http');
const https = require('node:https');
const { randomUUID } = require('node:crypto');
const { safeError } = require('./outbound');
const { accountId } = require('./relay-identity');

function cleanHeaders(headers) {
  const cleaned = { ...headers };
  const connection = String(headers.connection || '').split(',').map(value => value.trim().toLowerCase());
  for (const key of [...connection, 'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']) delete cleaned[key];
  return cleaned;
}

function targetUrl(baseUrl, requestPath) {
  const base = new URL(baseUrl);
  const incoming = new URL(requestPath, 'http://local.invalid');
  const suffix = incoming.pathname.replace(/^\/v1(?=\/|$)/, '').replace(/^\//, '');
  base.pathname = `${base.pathname.replace(/\/$/, '')}/${suffix}`;
  base.search = incoming.search;
  return base;
}

function sendError(res, status, message) {
  if (res.destroyed) return;
  if (res.headersSent) { res.destroy(); return; }
  for (const name of res.getHeaderNames()) res.removeHeader(name);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify({ error: { message, type: 'relay_error' } }));
}

function createProxy(store, observe = () => {}, timeoutMs = 120000, outbound, connectTimeoutMs = 15000, observeStart = () => {}) {
  function received(req) {
    const startedAt = new Date().toISOString();
    const pathname = new URL(req.url, 'http://localhost').pathname.replace(/^\/v1(?=\/|$)/, '');
    const endpoint = ['/responses', '/responses/compact', '/models'].includes(pathname) ? pathname : 'other';
    const context = { requestId: randomUUID(), startedAt, method: req.method, endpoint };
    observeStart({ ...context, at: startedAt, phase: 'received' });
    return context;
  }
  const server = http.createServer((req, res) => {
    forward(req, res).catch(() => sendError(res, 502, '本地代理请求失败，请检查中转配置。'));
  });
  const sockets = new Set();
  server.on('connection', socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.closeProxyConnections = () => { for (const socket of sockets) socket.destroy(); };

  async function forward(req, res) {
    const context = received(req);
    const started = Date.now();
    let entry;
    try { entry = await store.activeEntry(); }
    catch (error) {
      observe({ ...context, at: new Date().toISOString(), status: error.status || 503, outcome: 'failed', phase: 'configuration', ...safeError(error), durationMs: Date.now() - started });
      sendError(res, error.status || 503, error.message); return;
    }
    context.routeId = accountId(entry);
    const target = targetUrl(entry.baseurl, req.url);
    let route;
    try { route = outbound ? await outbound.resolve(target) : { label: 'DIRECT', source: 'direct', proxyUrl: '' }; }
    catch (error) {
      observe({ ...context, provider: entry.name, at: new Date().toISOString(), status: 502, outcome: 'failed', phase: 'proxy-selection', ...safeError(error), durationMs: Date.now() - started });
      sendError(res, 502, '出站代理配置不可用，请检查网络设置。');
      return;
    }
    if (res.destroyed) return;
    const headers = cleanHeaders(req.headers);
    headers.host = target.host;
    headers.authorization = `Bearer ${entry.value}`;
    delete headers['api-key'];
    delete headers['x-api-key'];
    const transport = target.protocol === 'https:' ? https : http;
    let reported = false;
    let phase = route.proxyUrl ? 'proxy-connect' : 'connect';
    let connectStatus;
    let pacResult;
    let upstreamStatus;
    let headersMs;
    let responseBytes = 0;
    let responseComplete = false;
    const report = (status, outcome, error) => {
      if (reported) return;
      reported = true;
      observe({ ...context, provider: entry.name, at: new Date().toISOString(), status, outcome, phase, outbound: route.label, outboundSource: route.source, proxyConnectStatus: connectStatus, pacResult, upstreamStatus, headersMs, responseBytes, responseComplete, ...(error ? safeError(error) : {}), durationMs: Date.now() - started });
    };
    let connectTimer;
    let headersTimer;
    const controller = new AbortController();
    const clearTimers = () => { clearTimeout(connectTimer); clearTimeout(headersTimer); };
    const fail = error => { if (reported) return; clearTimers(); report(502, 'failed', error); sendError(res, 502, '中转请求失败（' + safeError(error).errorCode + '），请检查出站网络。'); };
    const upstream = transport.request(target, { method: req.method, headers, signal: controller.signal, agent: outbound ? outbound.agent(route, controller.signal) : false }, response => {
      clearTimers();
      if (connectStatus && connectStatus !== 200) {
        fail({ code: 'PROXY_CONNECT_REJECTED' }); response.resume(); return;
      }
      phase = 'response';
      upstreamStatus = response.statusCode;
      headersMs = Date.now() - started;
      response.on('data', chunk => { responseBytes += chunk.length; });
      response.on('end', () => { responseComplete = true; });
      response.on('error', fail);
      response.on('aborted', () => fail({ code: 'UPSTREAM_ABORTED' }));
      try {
        const outgoing = cleanHeaders(response.headers);
        // HTTP headers cannot carry arbitrary Unicode. Keep names reversible and ASCII-only.
        outgoing['x-relay-ui-provider'] = encodeURIComponent(entry.name);
        res.writeHead(response.statusCode || 502, outgoing);
        res.flushHeaders();
        response.pipe(res);
        res.once('finish', () => report(response.statusCode, 'completed'));
      } catch (error) { fail(error); response.destroy(); }
    });
    const abort = error => { fail(error); controller.abort(error); upstream.destroy(error); };
    connectTimer = setTimeout(() => abort(Object.assign(new Error('connect timeout'), { code: 'CONNECT_TIMEOUT' })), connectTimeoutMs);
    headersTimer = setTimeout(() => abort(Object.assign(new Error('headers timeout'), { code: 'HEADERS_TIMEOUT' })), timeoutMs);
    upstream.on('socket', socket => {
      const connected = () => { clearTimeout(connectTimer); phase = 'waiting-headers'; };
      socket.once('lookup', error => { if (!error) phase = route.proxyUrl ? 'proxy-connect' : 'tcp-connect'; });
      if (socket.encrypted && !socket.authorized) { phase = 'tls-handshake'; socket.once('secureConnect', connected); }
      else if (socket.connecting) socket.once('connect', () => {
        if (target.protocol === 'https:' && socket.encrypted) { phase = 'tls-handshake'; socket.once('secureConnect', connected); }
        else connected();
      });
      else connected();
    });
    upstream.on('proxyConnect', response => { connectStatus = response.statusCode; });
    upstream.on('proxy', event => { pacResult = String(event.proxy).split(' ')[0]; });
    upstream.on('error', fail);
    upstream.setTimeout(timeoutMs, () => abort(Object.assign(new Error('upstream idle timeout'), { code: 'UPSTREAM_IDLE_TIMEOUT' })));
    req.on('error', () => upstream.destroy());
    req.on('aborted', () => upstream.destroy());
    res.on('close', () => { clearTimers(); if (!res.writableFinished) { report(499, 'cancelled', { code: 'CLIENT_DISCONNECTED' }); upstream.destroy(); } controller.abort(); });
    req.pipe(upstream);
  }

  // A WebSocket is pinned to one upstream for its lifetime, just like an SSE request.
  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => {});
    (async () => {
      const context = received(req);
      const entry = await store.activeEntry();
      context.routeId = accountId(entry);
      const target = targetUrl(entry.baseurl, req.url);
      const route = outbound ? await outbound.resolve(target) : { label: 'DIRECT', source: 'direct', proxyUrl: '' };
      if (socket.destroyed) return;
      const started = Date.now();
      let reported = false;
      let upstreamStatus;
      const report = (status, outcome, error) => {
        if (reported) return;
        reported = true;
        observe({ ...context, provider: entry.name, at: new Date().toISOString(), status, upstreamStatus, outcome, phase: 'websocket', outbound: route.label, outboundSource: route.source, ...(error ? safeError(error) : {}), durationMs: Date.now() - started });
      };
      const headers = cleanHeaders(req.headers);
      Object.assign(headers, { host: target.host, authorization: `Bearer ${entry.value}`, connection: 'Upgrade', upgrade: 'websocket' });
      delete headers['api-key'];
      delete headers['x-api-key'];
      const transport = target.protocol === 'https:' ? https : http;
      const controller = new AbortController();
      const upstream = transport.request(target, { method: req.method, headers, signal: controller.signal, agent: outbound ? outbound.agent(route, controller.signal) : false });
      const timer = setTimeout(() => { const error = Object.assign(new Error('upgrade timeout'), { code: 'UPGRADE_TIMEOUT' }); report(502, 'failed', error); controller.abort(error); upstream.destroy(error); socket.destroy(); }, connectTimeoutMs);
      upstream.on('error', error => { clearTimeout(timer); report(502, 'failed', error); socket.destroy(); });
      upstream.setTimeout(timeoutMs, () => upstream.destroy(Object.assign(new Error('upstream idle timeout'), { code: 'UPSTREAM_IDLE_TIMEOUT' })));
      socket.on('close', () => { clearTimeout(timer); report(499, 'cancelled', { code: 'CLIENT_DISCONNECTED' }); controller.abort(); upstream.destroy(); });
      upstream.on('response', response => { clearTimeout(timer); upstreamStatus = response.statusCode; report(response.statusCode, 'failed', { code: 'UPGRADE_REJECTED' }); response.resume(); socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n'); });
      upstream.on('upgrade', (response, upstreamSocket, upstreamHead) => {
        upstreamStatus = response.statusCode;
        clearTimeout(timer);
        upstreamSocket.on('error', () => socket.destroy());
        upstreamSocket.on('close', () => socket.destroy());
        socket.on('close', () => upstreamSocket.destroy());
        const lines = [];
        for (let i = 0; i < response.rawHeaders.length; i += 2) lines.push(`${response.rawHeaders[i]}: ${response.rawHeaders[i + 1]}`);
        socket.write(`HTTP/1.1 101 Switching Protocols\r\n${lines.join('\r\n')}\r\n\r\n`);
        if (upstreamHead.length) socket.write(upstreamHead);
        if (head.length) upstreamSocket.write(head);
        socket.pipe(upstreamSocket).pipe(socket);
        report(101, 'upgraded');
      });
      upstream.end();
    })().catch(() => socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n'));
  });
  return server;
}

module.exports = { createProxy, cleanHeaders, targetUrl };
