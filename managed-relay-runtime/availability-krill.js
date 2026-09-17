const DAY_MS = 24 * 3600000;
const SEGMENTS = 72;
const STATES = { 0: 'unavailable', 1: 'available', 2: 'degraded' };
const PRIORITY = { 'no-data': 0, available: 1, degraded: 2, unavailable: 3 };

function stateOf(value) {
  if (![0, 1, 2].includes(value)) throw new Error('Invalid Krill status');
  return STATES[value];
}

function timestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) throw new Error('Invalid Krill timestamp');
  // Krill's own component appends Z to these strings: timestamps are UTC.
  const at = Date.parse(value.replace(' ', 'T') + 'Z');
  if (!Number.isFinite(at) || new Date(at).toISOString().slice(0, 19).replace('T', ' ') !== value) throw new Error('Invalid Krill timestamp');
  return at;
}

function metric(value) {
  if (value == null) return null;
  if (!Number.isFinite(value) || value < 0) throw new Error('Invalid Krill metric');
  return value;
}

function readKrillStatus(payload, models, now = Date.now()) {
  const data = payload?.data;
  if (payload?.success !== true || !Array.isArray(data?.channels) || (data.perf != null && !Array.isArray(data.perf))) throw new Error('Invalid Krill response');
  const result = {};
  for (const model of models) {
    const matches = data.channels.filter(item => item?.model_name === model);
    if (!matches.length) continue;
    // Do not silently choose or combine routes if the source adds another channel for this model.
    if (matches.length !== 1) throw new Error('Ambiguous Krill model channel');
    const channel = matches[0];
    if (!Array.isArray(channel.history) || typeof channel.channel_key !== 'string' || typeof channel.channel !== 'string') throw new Error('Invalid Krill channel');
    const fixed = channel.fixed_status != null;
    const current = stateOf(fixed ? channel.fixed_status : channel.current_status);
    const start = now - DAY_MS;
    const history = Array.from({ length: SEGMENTS }, (_, index) => ({
      at: start + index * DAY_MS / SEGMENTS, state: fixed ? current : 'no-data', ok: fixed ? current === 'available' : null,
    }));
    history[0].timeLabel = '24 小时前';
    history[SEGMENTS - 1].endTimeLabel = '现在';
    let latest = null;
    for (const item of channel.history) {
      const at = timestamp(item?.ts);
      const state = stateOf(item.s);
      if (at > now) continue;
      if (latest == null || at > latest) latest = at;
      if (fixed || at < start) continue;
      const index = Math.min(Math.floor((at - start) / (DAY_MS / SEGMENTS)), SEGMENTS - 1);
      if (PRIORITY[state] > PRIORITY[history[index].state]) Object.assign(history[index], { state, ok: state === 'available' });
    }
    const perf = (data.perf || []).filter(item => item?.channel_key === channel.channel_key);
    if (perf.length > 1) throw new Error('Ambiguous Krill metrics');
    const status = {
      groupLabel: channel.channel, summaryLabel: fixed ? '站点固定状态 · 最近 24 小时' : '最近 24 小时 · 每格 20 分钟',
      historyLength: SEGMENTS, historyLabel: fixed ? '时段' : '有数据时段', history,
      sampleCount: history.filter(item => item.state !== 'no-data').length, uptimePct: null,
      last: latest == null && !fixed ? null : { at: latest, state: current, ok: current === 'available' },
      staleAfterMs: 5 * 60000,
    };
    if (perf.length) {
      const cacheRate = metric(perf[0].cache_rate);
      if (cacheRate > 1) throw new Error('Invalid Krill cache rate');
      status.metrics = {
        tps: metric(perf[0].throughput_p50_tps ?? perf[0].throughput_avg_tps),
        tpsLabel: perf[0].throughput_p50_tps != null ? '吞吐 P50' : '平均吞吐',
        ttftMs: metric(perf[0].ttft_p99_ms), hideLatency: true,
        cacheRatePct: cacheRate == null ? null : cacheRate * 100,
      };
    }
    result[model] = status;
  }
  return result;
}

module.exports = { readKrillStatus };
