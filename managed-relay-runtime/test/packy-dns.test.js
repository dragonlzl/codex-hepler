const { test } = require('node:test');
const assert = require('node:assert/strict');
const https = require('node:https');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { PackyDns, HOST, parseAnswers, requestDns } = require('../packy-dns');
const { Outbound } = require('../outbound');

const answer = (ttl = 60) => ({ Status: 0, Answer: [
  { name: HOST, type: 1, TTL: ttl, data: '104.18.25.163' },
  { name: HOST, type: 1, TTL: ttl, data: '104.18.24.163' },
] });
const lookup = (resolver, options = { all: true }) => new Promise((resolve, reject) => {
  resolver.lookup(HOST, options, (error, addresses, family) => error ? reject(error) : resolve({ addresses, family }));
});

test('secure Packy DNS deduplicates simultaneous requests and respects TTL and address families', async t => {
  let now = 0, calls = 0;
  const resolver = new PackyDns({ clock: () => now, request: async () => { calls++; return answer(); } });
  t.after(() => resolver.close());
  const [first, second] = await Promise.all([lookup(resolver), lookup(resolver)]);
  assert.deepEqual(first, second);
  assert.deepEqual(first.addresses, [{ address: '104.18.25.163', family: 4 }, { address: '104.18.24.163', family: 4 }]);
  assert.equal(calls, 1);
  assert.deepEqual(await lookup(resolver, 4), { addresses: '104.18.25.163', family: 4 });
  now = 60000;
  await lookup(resolver); assert.equal(calls, 2);
  await assert.rejects(lookup(resolver, { family: 6 }), { code: 'PACKY_DNS_FAILED' });
});

test('DNS answers validate owners, aliases, response codes and expiry', () => {
  for (const payload of [{ Status: 3 }, { ...answer(), TC: true },
    { Status: 0, Answer: [{ name: 'other.invalid', type: 1, TTL: 60, data: '104.18.25.163' }] },
    answer(-1), { Status: 0, Answer: [{ name: HOST, type: 5, TTL: 60, data: HOST }] }]) {
    assert.throws(() => parseAnswers(payload), { code: 'PACKY_DNS_FAILED' });
  }
  const payload = { Status: 0, Answer: [{ name: HOST + '.', type: 5, TTL: 20, data: 'edge.example.' },
    { name: 'edge.example', type: 1, TTL: 60, data: '104.18.25.163' }] };
  assert.deepEqual(parseAnswers(payload), { addresses: ['104.18.25.163'], ttlMs: 20000 });
  assert.equal(parseAnswers(answer(3600)).ttlMs, 300000);
  assert.equal(parseAnswers(answer(0)).ttlMs, 0);
});

test('secure DNS fails over on a bounded deadline and never reuses expired data', async t => {
  let now = 0, fail = false;
  const endpoints = [];
  const resolver = new PackyDns({ timeoutMs: 10, clock: () => now, request: async (endpoint, signal) => {
    endpoints.push(endpoint);
    if (fail) return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    if (endpoint.includes('1.1.1.1')) throw new Error('unavailable');
    return answer(1);
  } });
  t.after(() => resolver.close());
  await lookup(resolver);
  assert.deepEqual(endpoints, ['https://1.1.1.1/dns-query', 'https://1.0.0.1/dns-query']);
  now = 1000; fail = true;
  await assert.rejects(lookup(resolver), { code: 'PACKY_DNS_TIMEOUT' });
  fail = false;
  await lookup(resolver);
});

test('service close cancels a pending resolver and prevents another resolver request', async () => {
  let calls = 0, began;
  const started = new Promise(resolve => { began = resolve; });
  const resolver = new PackyDns({ request: async (endpoint, signal) => {
    calls++; began();
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  } });
  const pending = lookup(resolver);
  await started; resolver.close();
  await assert.rejects(pending); assert.equal(calls, 1);
  await assert.rejects(lookup(resolver));
});

test('only direct Packy console traffic receives the secure lookup', t => {
  const outbound = new Outbound('unused'); t.after(() => outbound.close());
  assert.equal(outbound.lookup('https://' + HOST + '/api/user/self', {}), outbound.packyDns.lookup);
  for (const url of ['https://cf.api.fan/v1', 'https://slb-v1.api.fan/api/usage/token/', 'https://other.invalid', 'http://' + HOST]) {
    assert.equal(outbound.lookup(url, {}), undefined);
  }
  assert.equal(outbound.lookup('https://' + HOST, { proxyUrl: 'http://127.0.0.1:7890' }), undefined);
});

test('DoH transport sends only the DNS question, refuses redirects and bounds response size', async t => {
  let mode = 'ok';
  t.mock.method(https, 'get', (url, options, onResponse) => {
    assert.equal(url, 'https://1.1.1.1/dns-query?name=' + HOST + '&type=A');
    assert.deepEqual(options.headers, { accept: 'application/dns-json' });
    assert.equal(options.rejectUnauthorized, undefined);
    assert.equal(options.agent, false);
    const request = new EventEmitter(); request.destroy = () => {};
    setImmediate(() => {
      const response = new PassThrough(); response.statusCode = mode === 'redirect' ? 302 : 200;
      onResponse(response);
      if (mode !== 'redirect') response.end(mode === 'large' ? 'x'.repeat(65537) : JSON.stringify(answer()));
    });
    return request;
  });
  assert.deepEqual(await requestDns('https://1.1.1.1/dns-query', new AbortController().signal), answer());
  for (mode of ['redirect', 'large']) {
    await assert.rejects(requestDns('https://1.1.1.1/dns-query', new AbortController().signal), { code: 'PACKY_DNS_FAILED' });
  }
});
