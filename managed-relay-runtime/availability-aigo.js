const { readChannelMonitors, channelSnapshot } = require('./channel-monitors');
const ENDPOINT = 'https://api.aigo0.com/api/v1/channel-monitors';
const ORIGIN = 'https://api.aigo0.com';
const KEY_PAGE_SIZE = 100;
const POOLS = Object.freeze(['CX009-PLUS', 'CX008', 'CX00035', 'CX012', 'CX009-BUG', 'CX015']);
const POOL_ALIASES = Object.freeze({ CX00035: ['CX00035', 'CX0035'] });
const keyEndpoint = page => ORIGIN + '/api/v1/keys?page=' + page + '&page_size=' + KEY_PAGE_SIZE;

function normalized(value) {
  return typeof value === 'string' ? value.normalize('NFKC').trim().replace(/\s+/g, ' ').toUpperCase() : '';
}

function poolForName(value) {
  const name = normalized(value);
  return POOLS.find(pool => (POOL_ALIASES[pool] || [pool]).some(alias => name.startsWith(alias) && !/^[A-Z0-9]/.test(name.slice(alias.length)))) || null;
}

function isMonitorEndpoint(url) {
  return url === ENDPOINT;
}

function isKeyEndpoint(url) {
  const match = new RegExp('^' + ORIGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/api/v1/keys\\?page=([1-9]\\d{0,2})&page_size=' + KEY_PAGE_SIZE + '$').exec(url);
  return Boolean(match && Number(match[1]) <= 100);
}

function readAigoStatus(payload, models, now = Date.now()) {
  return readChannelMonitors(payload, models, now, { pools: POOLS, poolForName, staleAfterMs: 15 * 60000 });
}

module.exports = { ENDPOINT, ORIGIN, POOLS, POOL_ALIASES, KEY_PAGE_SIZE, keyEndpoint, isMonitorEndpoint, isKeyEndpoint,
  poolForName, readAigoStatus, channelSnapshot };
