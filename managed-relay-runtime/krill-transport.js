const https = require('node:https');

const ORIGIN = 'https://www.krill-code.com';
const GET_URLS = new Set(['/api/auth/me', '/api/credits', '/api/subscription', '/api/public/channel-status?hours=24'].map(path => ORIGIN + path));
const POST_URLS = new Set(['/api/auth/login', '/api/auth/login/totp', '/api/subscription/quota-usage'].map(path => ORIGIN + path));
const MAX_ATTEMPTS = 4;
const MAX_BYTES = 1024 * 1024;
const HANDSHAKE_FAILURES = new Set(['EPROTO', 'ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR']);

function isHandshakeFailure(error) {
  return HANDSHAKE_FAILURES.has(error?.code);
}

function isKrillUrl(url) {
  return typeof url === 'string' && (GET_URLS.has(url) || POST_URLS.has(url));
}

// A failed TLS handshake cannot have delivered the HTTP request. Once TLS is
// established, any failure is final, including failures before response headers.
function attempt(url, options, body, signal) {
  return new Promise(resolve => {
    let request, response, socket, settled = false, secure = false, sent = false, responding = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      socket?.removeListener('secureConnect', connected);
      if (error) {
        response?.destroy();
        request?.destroy();
        socket?.destroy();
      }
      resolve(error ? { error, retry: isHandshakeFailure(error) && !secure && !responding && !signal.aborted } : { value });
    };
    const abort = () => finish(signal.reason || Object.assign(new Error('Krill request aborted'), { name: 'AbortError' }));
    const connected = () => {
      if (settled || sent) return;
      secure = true;
      if (socket?.encrypted !== true || socket.authorized !== true) {
        finish(Object.assign(new Error('Krill TLS connection was not verified'), { code: 'KRILL_TLS_UNVERIFIED' }));
        return;
      }
      sent = true;
      request.end(body);
    };
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    try {
      request = https.request(url, { ...options, signal, method: body === undefined ? 'GET' : 'POST' });
      request.on('error', error => finish(error));
      request.once('socket', value => {
        if (settled) { value.destroy(); return; }
        socket = value;
        if (socket.encrypted !== true) {
          finish(Object.assign(new Error('Krill requires a TLS connection'), { code: 'KRILL_TLS_REQUIRED' }));
          return;
        }
        // Keep-alive sockets have completed certificate verification already.
        if (socket.authorized === true) connected();
        else socket.once('secureConnect', connected);
      });
      request.once('response', incoming => {
        if (settled) { incoming.destroy(); return; }
        responding = true;
        response = incoming;
        const chunks = [];
        let bytes = 0;
        incoming.on('data', chunk => {
          if (settled) return;
          bytes += Buffer.byteLength(chunk);
          if (bytes > MAX_BYTES) { finish(new Error('Krill response too large')); return; }
          chunks.push(Buffer.from(chunk));
        });
        incoming.on('error', error => finish(error));
        incoming.once('aborted', () => finish(new Error('Incomplete Krill response')));
        incoming.once('end', () => finish(null, {
          statusCode: incoming.statusCode,
          headers: incoming.headers,
          text: Buffer.concat(chunks).toString('utf8'),
        }));
      });
    } catch (error) { finish(error); }
  });
}

async function krillRequest(url, { agent, signal = AbortSignal.timeout(10000), lookup, headers } = {}, body) {
  if (!isKrillUrl(url) || !(body === undefined ? GET_URLS : POST_URLS).has(url) || (body !== undefined && typeof body !== 'string')) {
    throw new Error('Krill request target rejected');
  }
  for (let index = 0; index < MAX_ATTEMPTS; index++) {
    signal.throwIfAborted();
    const result = await attempt(url, { agent, lookup, headers }, body, signal);
    if (!result.error) return result.value;
    if (!result.retry || index === MAX_ATTEMPTS - 1) throw result.error;
  }
}

module.exports = { krillRequest, isKrillUrl, isHandshakeFailure, MAX_ATTEMPTS };
