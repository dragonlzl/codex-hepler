const https = require('node:https');
const { isIPv4 } = require('node:net');

const HOST = 'www.packyapi.com';
const RESOLVERS = ['https://1.1.1.1/dns-query', 'https://1.0.0.1/dns-query'];
const failure = code => Object.assign(new Error('Packycode secure DNS lookup failed'), { code });

function requestDns(endpoint, signal) {
  return new Promise((resolve, reject) => {
    let response, settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      response?.destroy(); request.destroy();
      if (error) reject(error); else resolve(value);
    };
    const request = https.get(endpoint + '?name=' + HOST + '&type=A', {
      agent: false, signal, headers: { accept: 'application/dns-json' },
    }, incoming => {
      response = incoming;
      if (incoming.statusCode !== 200) { finish(failure('PACKY_DNS_FAILED')); return; }
      const chunks = [];
      let bytes = 0;
      incoming.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > 65536) { finish(failure('PACKY_DNS_FAILED')); return; }
        chunks.push(chunk);
      });
      incoming.on('error', error => finish(error));
      incoming.on('aborted', () => finish(failure('PACKY_DNS_FAILED')));
      incoming.on('end', () => {
        try { finish(null, JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { finish(failure('PACKY_DNS_FAILED')); }
      });
    });
    request.on('error', error => finish(error));
  });
}

function parseAnswers(payload) {
  if (payload?.Status !== 0 || payload.TC || !Array.isArray(payload.Answer)) throw failure('PACKY_DNS_FAILED');
  const name = value => typeof value === 'string' ? value.toLowerCase().replace(/\.$/, '') : '';
  let owner = HOST, ttl = 300;
  const visited = new Set();
  while (!visited.has(owner) && visited.size < 8) {
    visited.add(owner);
    const records = payload.Answer.filter(record => name(record.name) === owner);
    const addresses = records.filter(record => record.type === 1 && isIPv4(record.data));
    const aliases = records.filter(record => record.type === 5);
    const used = addresses.length ? addresses : aliases;
    if (!used.length || used.some(record => !Number.isFinite(record.TTL) || record.TTL < 0)) break;
    ttl = Math.min(ttl, ...used.map(record => record.TTL));
    if (addresses.length) return { addresses: [...new Set(addresses.map(record => record.data))], ttlMs: ttl * 1000 };
    if (aliases.length !== 1 || !name(aliases[0].data)) break;
    owner = name(aliases[0].data);
  }
  throw failure('PACKY_DNS_FAILED');
}

class PackyDns {
  constructor({ request = requestDns, clock = Date.now, timeoutMs = 2000 } = {}) {
    Object.assign(this, { request, clock, timeoutMs });
    this.controller = new AbortController();
    this.cached = null;
    this.pending = null;
    this.lookup = this.lookup.bind(this);
  }

  async addresses() {
    this.controller.signal.throwIfAborted();
    if (this.cached && this.clock() < this.cached.expiresAt) return this.cached.addresses;
    if (this.pending) return this.pending;
    this.pending = (async () => {
      let errorCode = 'PACKY_DNS_FAILED';
      for (const endpoint of RESOLVERS) {
        this.controller.signal.throwIfAborted();
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);
        try {
          const signal = AbortSignal.any([controller.signal, this.controller.signal]);
          const payload = await this.request(endpoint, signal);
          signal.throwIfAborted();
          const parsed = parseAnswers(payload);
          this.cached = { addresses: parsed.addresses, expiresAt: this.clock() + parsed.ttlMs };
          return parsed.addresses;
        } catch {
          errorCode = controller.signal.aborted ? 'PACKY_DNS_TIMEOUT' : 'PACKY_DNS_FAILED';
        } finally { clearTimeout(timer); controller.abort(); }
      }
      throw failure(errorCode);
    })().finally(() => { this.pending = null; });
    return this.pending;
  }

  lookup(hostname, options, callback) {
    if (typeof options === 'function') { callback = options; options = {}; }
    if (hostname !== HOST || options === 6 || options?.family === 6) {
      callback(failure('PACKY_DNS_FAILED')); return;
    }
    this.addresses().then(addresses => {
      if (options?.all) callback(null, addresses.map(address => ({ address, family: 4 })));
      else callback(null, addresses[0], 4);
    }, error => callback(error));
  }

  close() { this.controller.abort(); this.cached = null; }
}

module.exports = { PackyDns, HOST, parseAnswers, requestDns };
