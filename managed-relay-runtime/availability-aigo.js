const ENDPOINT = 'https://api.aigo0.com/api/v1/channel-monitors';
const ORIGIN = 'https://api.aigo0.com';
const KEY_PAGE_SIZE = 100;
const POOLS = Object.freeze(['CX009-PLUS', 'CX008', 'CX00035', 'CX012', 'CX009-BUG', 'CX015']);
const POOL_ALIASES = Object.freeze({ CX00035: ['CX00035', 'CX0035'] });
const SOURCE_STATES = {
  operational: ['available', '正常'],
  degraded: ['degraded', '降级'],
  failed: ['unavailable', '异常'],
  error: ['unavailable', '错误'],
  maintenance: ['maintenance', '维护中'],
  empty: ['no-data', '无数据'],
};

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

function timestamp(value, now) {
  if (typeof value !== 'string' || !/(Z|[+-]\d\d:\d\d)$/.test(value)) throw new Error('Invalid 派大星 sample time');
  const at = Date.parse(value);
  if (!Number.isFinite(at) || at > now + 300000) throw new Error('Invalid 派大星 sample time');
  return at;
}

function finite(value) {
  if (value == null) return null;
  if (!Number.isFinite(value) || value < 0) throw new Error('Invalid 派大星 metric');
  return value;
}

function timelineSample(item, now) {
  if (!item || typeof item.status !== 'string' || !Object.hasOwn(SOURCE_STATES, item.status)) throw new Error('Invalid 派大星 check');
  const [state, statusLabel] = SOURCE_STATES[item.status];
  return { at: timestamp(item.checked_at, now), state, statusLabel, ok: state === 'available', latencyMs: finite(item.latency_ms), pingMs: finite(item.ping_latency_ms) };
}

function itemForPool(items, pool) {
  const matches = items.filter(item => poolForName(item?.name) === pool && (item?.provider == null || item.provider === 'openai'));
  if (matches.length > 1) {
    throw new Error('Ambiguous 派大星 pool monitor');
  }
  return matches[0] || null;
}

function readAigoStatus(payload, models, now = Date.now()) {
  const data = payload?.data;
  if (payload?.code !== 0 || !Array.isArray(data?.items) || data.items.length > 1000) throw new Error('Invalid 派大星 monitor response');
  const channels = POOLS.map(pool => {
    const item = itemForPool(data.items, pool);
    const channel = { groupLabel: pool, modelLabel: '渠道状态', historyLength: 60, historyLabel: '最近检测',
      uptimeLabel: '7 天可用率', history: [], sampleCount: 0, last: null, uptimePct: null, staleAfterMs: 15 * 60000 };
    if (!item) return channel;
    if (!Array.isArray(item.timeline) || item.timeline.length > 120) throw new Error('Invalid 派大星 history');
    const seen = new Set();
    for (const point of item.timeline) {
      const sample = timelineSample(point, now);
      if (seen.has(sample.at)) throw new Error('Duplicate 派大星 check');
      seen.add(sample.at); channel.history.push(sample);
    }
    channel.history.sort((a, b) => a.at - b.at); channel.history = channel.history.slice(-60);
    if (item.primary_status != null && !Object.hasOwn(SOURCE_STATES, item.primary_status)) throw new Error('Invalid 派大星 current state');
    const latest = channel.history.at(-1) || null;
    channel.last = latest; channel.sampleCount = channel.history.length;
    channel.sourceModelLabel = typeof item.primary_model === 'string' ? '站点探测：' + item.primary_model.slice(0, 100) : '站点渠道探测';
    channel.metrics = { hideTps: true, hideTtft: true, latencyLabel: '对话延迟', latencyMs: finite(item.primary_latency_ms), pingMs: finite(item.primary_ping_latency_ms) };
    const availability = item.availability_7d;
    if (availability != null) {
      if (!Number.isFinite(availability) || availability < 0 || availability > 100) throw new Error('Invalid 派大星 availability');
      channel.uptimePct = availability;
    }
    return channel;
  });
  return Object.fromEntries(models.map(model => [model, { channels,
    modelNote: 'gpt-6-astra 与 gpt-5.6-sol 共用以下号池状态；工具每 15 秒刷新。' }]));
}

function channelSnapshot(status, entry, now) {
  if (!status.channels?.length) return { channels: [], state: status.state || 'no-data', message: status.message || '暂无号池分组信息' };
  const channels = (status.channels || []).map(channel => {
    const state = entry.authRequired ? 'auth-required' : entry.error ? channel.last ? 'stale' : 'error' : !channel.last ? 'no-data'
      : now - channel.last.at > channel.staleAfterMs ? 'stale' : channel.last.state;
    const message = entry.authRequired ? '监控授权已失效，请重新登录' : entry.error ? channel.last ? '刷新失败，保留上次样本' : '状态源暂时无法连接' : state === 'stale' ? '状态源样本已过期'
      : state === 'no-data' ? '状态源暂无该号池样本' : channel.last.statusLabel;
    return { ...channel, state, message };
  });
  const states = channels.map(channel => channel.state);
  const state = ['auth-required', 'error', 'stale', 'unavailable', 'no-data', 'maintenance', 'degraded', 'available'].find(value => states.includes(value)) || 'no-data';
  return { channels, state, message: ({ 'auth-required': '监控授权已失效，请重新登录', error: '状态源暂时无法连接', stale: '部分号池状态未更新', unavailable: '部分号池异常',
    'no-data': '部分号池暂无样本', maintenance: '部分号池维护中', degraded: '部分号池延迟升高', available: '号池正常' })[state] };
}

module.exports = { ENDPOINT, ORIGIN, POOLS, POOL_ALIASES, KEY_PAGE_SIZE, keyEndpoint, isMonitorEndpoint, isKeyEndpoint,
  poolForName, readAigoStatus, channelSnapshot };
