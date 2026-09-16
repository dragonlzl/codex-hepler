const HOUR_MS = 3600000;
const HOURS = 24;

function metric(value) {
  if (value == null) return null;
  if (!Number.isFinite(value) || value < 0) throw new Error('Invalid performance metric');
  return value;
}

function readPerformanceStatus(payload, model, { groupName, rateSource = 'hourly-mean', healthyRate = 90, degradedRate = 70 }, now = Date.now()) {
  const data = payload?.data;
  if (payload?.success !== true || data?.model_name !== model || !Array.isArray(data.groups)) {
    throw new Error('Invalid performance model response');
  }
  const groups = data.groups.filter(item => item?.group === groupName);
  if (groups.length > 1) throw new Error('Duplicate performance group');
  const group = groups[0];
  const result = {
    groupLabel: groupName, historyLength: HOURS, historyLabel: '有数据时段', sampleCount: 0,
    uptimeLabel: '24 小时成功率', history: [], last: null, uptimePct: null,
    sampleTimeLabel: '最近时段', staleAfterMs: HOUR_MS + 180000,
  };
  if (!group) return { [model]: result };
  if (!Array.isArray(group.series)) throw new Error('Invalid performance group series');
  const buckets = new Map();
  for (const item of group.series) {
    if (!item || !Number.isSafeInteger(item.ts) || item.ts <= 0 || item.ts % 3600 !== 0 || item.ts * 1000 > now + HOUR_MS ||
        !Number.isFinite(item.success_rate) || item.success_rate < 0 || item.success_rate > 100 || buckets.has(item.ts * 1000)) {
      throw new Error('Invalid performance hourly sample');
    }
    // Aixor rounds buckets before averaging; Packy uses raw buckets and the group aggregate.
    const uptimePct = rateSource === 'group' ? item.success_rate : Math.round(item.success_rate * 100) / 100;
    const state = uptimePct >= healthyRate ? 'available' : uptimePct >= degradedRate ? 'degraded' : 'unavailable';
    buckets.set(item.ts * 1000, {
      at: item.ts * 1000, state, ok: state === 'available', uptimePct,
      latencyMs: metric(item.avg_latency_ms), ttftMs: metric(item.avg_ttft_ms), tps: metric(item.avg_tps),
    });
  }
  result.metrics = { tps: metric(group.avg_tps), ttftMs: metric(group.avg_ttft_ms), latencyMs: metric(group.avg_latency_ms) };
  if (!buckets.size) return { [model]: result };
  const latest = Math.max(...buckets.keys());
  result.history = Array.from({ length: HOURS }, (_, index) => {
    const at = latest - (HOURS - 1 - index) * HOUR_MS;
    return buckets.get(at) || { at, state: 'no-data', ok: null, uptimePct: null, latencyMs: null };
  });
  const observed = result.history.filter(item => item.state !== 'no-data');
  result.sampleCount = observed.length;
  result.last = result.history.at(-1);
  result.uptimePct = rateSource === 'group' ? metric(group.success_rate) : observed.reduce((total, item) => total + item.uptimePct, 0) / observed.length;
  if (result.uptimePct > 100) throw new Error('Invalid group success rate');
  return { [model]: result };
}

module.exports = { readPerformanceStatus };
