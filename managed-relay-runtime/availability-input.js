const { readChannelMonitors, channelSnapshot } = require('./channel-monitors');
const ENDPOINT = 'https://ai.input.im/api/v1/channel-monitors';
const POOLS = Object.freeze(['CodeX 余额-1', 'CodeX 余额-2', 'CodeX 余额-3']);

function poolForName(value) {
  const normalize = text => text.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
  return typeof value === 'string' ? POOLS.find(pool => normalize(pool) === normalize(value)) || null : null;
}

function readInputStatus(payload, models, now = Date.now()) {
  return readChannelMonitors(payload, models, now, { pools: POOLS, poolForName, staleAfterMs: 180000 });
}

module.exports = { ENDPOINT, POOLS, poolForName, readInputStatus, channelSnapshot };
