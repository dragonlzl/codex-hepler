const ENDPOINT = 'https://status.timicc.com/api/group/CodeX%20%E9%80%9A%E9%81%93?trendPeriod=7d';
const POOLS = ['Codex Team/Plus号池', 'Codex Pro号池'];
const SOURCE_STATES = {
  operational: ['available', '正常'], degraded: ['degraded', '延迟'],
  failed: ['unavailable', '异常'], error: ['unavailable', '错误'],
  validation_failed: ['degraded', '验证失败'], maintenance: ['maintenance', '维护中'],
};

function timestamp(value) {
  if (typeof value !== 'string' || !/(Z|[+-]\d\d:\d\d)$/.test(value) || !Number.isFinite(Date.parse(value))) throw new Error('Invalid timiCC sample time');
  return Date.parse(value);
}
function latency(value) {
  if (value == null) return null;
  if (!Number.isFinite(value) || value < 0) throw new Error('Invalid timiCC latency');
  return value;
}
function matchesPool(name, pool) {
  if (typeof name !== 'string' || !name.startsWith(pool)) return false;
  const suffix = name.slice(pool.length);
  return !suffix || /^(?:\s|-|gpt-)/.test(suffix);
}
function sample(item, id, now) {
  if (!item || item.id !== id || !Object.hasOwn(SOURCE_STATES, item.status)) throw new Error('Invalid timiCC check');
  const at = timestamp(item.checkedAt);
  if (at > now + 300000) throw new Error('Future timiCC check');
  const [state, statusLabel] = SOURCE_STATES[item.status];
  return { at, state, statusLabel, ok: state === 'available', latencyMs: latency(item.latencyMs), pingMs: latency(item.pingLatencyMs) };
}

function readTimiccStatus(payload, models, now = Date.now()) {
  if (payload?.groupName !== 'CodeX 通道' || !Array.isArray(payload.providerTimelines)) throw new Error('Invalid timiCC channel response');
  const channels = POOLS.map(pool => {
    const channel = { groupLabel: pool, modelLabel: '渠道状态', historyLength: 60, historyLabel: '最近检测', uptimeLabel: '7 天可用率',
      history: [], sampleCount: 0, last: null, uptimePct: null, staleAfterMs: 15 * 60000 };
    const matches = payload.providerTimelines.filter(row => row?.latest?.groupName === 'CodeX 通道' && matchesPool(row.latest.name, pool));
    if (matches.length > 1) throw new Error('Ambiguous timiCC pool');
    const timeline = matches[0];
    if (!timeline) return channel;
    if (typeof timeline.id !== 'string' || !timeline.id || !Array.isArray(timeline.items) || timeline.items.length > 1000) throw new Error('Invalid timiCC history');
    const latest = sample(timeline.latest, timeline.id, now);
    const history = new Map();
    for (const item of timeline.items) {
      const point = sample(item, timeline.id, now);
      if (history.has(point.at)) throw new Error('Duplicate timiCC check');
      history.set(point.at, point);
    }
    if ([...history.keys()].some(at => at > latest.at)) throw new Error('Invalid timiCC latest check');
    history.set(latest.at, latest);
    channel.history = [...history.values()].sort((a, b) => a.at - b.at).slice(-60);
    channel.last = latest; channel.sampleCount = channel.history.length;
    channel.sourceModelLabel = typeof timeline.latest.model === 'string' ? '站点探测：' + timeline.latest.model.slice(0, 100) : '站点渠道探测';
    channel.metrics = { hideTps: true, hideTtft: true, latencyLabel: '对话延迟', latencyMs: latest.latencyMs, pingMs: latest.pingMs };
    const stats = payload.availabilityStats?.[timeline.id];
    if (stats !== undefined && !Array.isArray(stats)) throw new Error('Invalid timiCC availability stats');
    const periods = (stats || []).filter(item => item?.period === '7d');
    if (periods.length > 1) throw new Error('Duplicate timiCC statistics');
    if (periods.length) {
      const value = periods[0];
      if (!Number.isSafeInteger(value.totalChecks) || value.totalChecks < 0 || !Number.isSafeInteger(value.operationalCount) || value.operationalCount < 0 ||
          value.operationalCount > value.totalChecks || !Number.isFinite(value.availabilityPct) || value.availabilityPct < 0 || value.availabilityPct > 100) throw new Error('Invalid timiCC availability');
      channel.uptimePct = value.totalChecks > 0 ? value.availabilityPct : null;
    }
    return channel;
  });
  return Object.fromEntries(models.map(model => [model, { channels,
    modelNote: 'gpt-6-astra 与 gpt-5.6-sol 共用以下号池状态；站点约每 5 分钟探测，工具每 15 秒刷新。' }]));
}

function channelSnapshot(status, entry, now) {
  if (!status.channels.length) return { channels: [], state: status.state || 'no-data', message: status.message || '暂无号池分组信息' };
  const channels = status.channels.map(channel => {
    const state = entry.error ? channel.last ? 'stale' : 'error' : !channel.last ? 'no-data'
      : now - channel.last.at > channel.staleAfterMs ? 'stale' : channel.last.state;
    const message = entry.error ? channel.last ? '刷新失败，保留上次样本' : '状态源暂时无法连接' : state === 'stale' ? '状态源样本已过期'
      : state === 'no-data' ? '状态源暂无该号池样本' : channel.last.statusLabel;
    return { ...channel, state, message };
  });
  const states = channels.map(channel => channel.state);
  const state = ['error', 'stale', 'unavailable', 'no-data', 'maintenance', 'degraded', 'available'].find(state => states.includes(state));
  return { channels, state, message: ({ error: '状态源暂时无法连接', stale: '部分号池状态未更新', unavailable: '部分号池异常',
    'no-data': '部分号池暂无样本', maintenance: '部分号池维护中', degraded: '部分号池延迟升高', available: '号池正常' })[state] };
}

module.exports = { ENDPOINT, POOLS, readTimiccStatus, channelSnapshot };
