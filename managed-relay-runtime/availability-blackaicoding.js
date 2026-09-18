const GROUP_ID = 2;
const GROUP_NAME = 'codex混合渠道--低价';
const MONITOR_URL = 'https://blackaicoding.com/monitor?range=90m&platform=openai&group=2&group_by=platform_group_model&health_mode=overall&tab=models';
const ENDPOINT = 'https://blackaicoding.com/api/v1/channel-monitor-v2/matrix?range=90m&platform=openai&group_id=2&group_by=platform_group_model';

function time(value) {
  if (typeof value !== 'string' || !/(?:Z|[+-]\d{2}:\d{2})$/.test(value)) throw new Error('Invalid monitor timestamp');
  const at = Date.parse(value);
  if (!Number.isFinite(at)) throw new Error('Invalid monitor timestamp');
  return at;
}

function number(value, max = Infinity) {
  if (value == null) return null;
  if (!Number.isFinite(value) || value < 0 || value > max) throw new Error('Invalid monitor metric');
  return value;
}

function health(value) {
  if (!value || !['healthy', 'warning', 'critical', 'unknown'].includes(value.overall)) throw new Error('Invalid monitor health');
  const score = number(value.score, 100);
  return { state: ({ healthy: 'available', warning: 'degraded', critical: 'unavailable', unknown: 'no-data' })[value.overall], score };
}

function metrics(value) {
  if (!value || typeof value !== 'object') throw new Error('Missing monitor metrics');
  const errorRate = number(value.error_rate, 1);
  return {
    // The monitor UI displays 1 - error_rate (success_rate uses a different denominator).
    uptimePct: errorRate == null ? null : (1 - errorRate) * 100,
    ttftMs: number(value.ttft?.avg_ms), latencyMs: number(value.duration?.avg_ms),
    cacheRatePct: value.cache_rate == null ? null : number(value.cache_rate, 1) * 100,
  };
}

function readBlackaicodingStatus(payload, models) {
  const data = payload?.data;
  if (payload?.code !== 0 || data?.group_by !== 'platform_group_model' || !Array.isArray(data.items)) throw new Error('Invalid monitor matrix');
  const coverage = data.coverage;
  const step = number(coverage?.bucket_seconds, 5400) * 1000;
  const start = time(coverage?.requested_start);
  const end = time(coverage?.requested_end);
  const dataThrough = time(coverage?.data_through);
  if (step < 60000 || end <= start || end - start !== 90 * 60000 || start % step || dataThrough > end) throw new Error('Invalid monitor coverage');
  const count = Math.ceil((end - start) / step);
  if (count > 90) throw new Error('Invalid monitor bucket count');
  const rows = data.items.filter(item => item?.platform === 'openai' && item.group_id === GROUP_ID);
  if (rows.some(item => item.group_name !== GROUP_NAME)) throw new Error('Monitor group changed');
  const result = {};
  for (const model of models) {
    let candidates = rows.filter(item => item.model === model);
    const fallback = candidates.length === 0 && model === 'gpt-6-astra';
    if (fallback) candidates = rows.filter(item => item.model === '__other__');
    if (candidates.length > 1) throw new Error('Ambiguous monitor model');
    const row = candidates[0];
    const status = {
      groupLabel: GROUP_NAME, historyLength: count, historyLabel: '有数据时段',
      uptimeLabel: '90 分钟成功率', history: [], last: null, uptimePct: null, sampleCount: 0,
      sampleTimeLabel: '统计截至', staleAfterMs: step + 180000, sampleIntervalMs: step,
      noDataMessage: '样本不足，整体健康度未知',
      ...(fallback && row ? { referenceOnly: true, sourceModelLabel: 'OpenAI · 其他模型（参考）',
        modelNote: '源站未单列 gpt-6-astra；此处为“其他模型”混合统计，不能代表 gpt6 独立可用性。' } : {}),
    };
    result[model] = status;
    if (!row) continue;
    if (!Array.isArray(row.buckets)) throw new Error('Invalid monitor buckets');
    const buckets = new Map();
    for (const bucket of row.buckets) {
      const at = time(bucket?.bucket_start);
      if (at < start || at >= end || at % step || buckets.has(at)) throw new Error('Invalid monitor bucket time');
      const { state, score } = health(bucket.health);
      const values = metrics(bucket.metrics);
      buckets.set(at, { at, state, ok: state === 'available', ...values, healthScore: score });
    }
    status.history = Array.from({ length: count }, (_, index) => {
      const at = start + index * step;
      return buckets.get(at) || { at, state: 'no-data', ok: null };
    });
    status.history[0].timeLabel = '90 分钟前';
    status.history.at(-1).endTimeLabel = '现在';
    status.sampleCount = buckets.size;
    if (!buckets.size) continue;
    const current = health(row.health);
    const aggregate = metrics(row.metrics);
    status.uptimePct = aggregate.uptimePct;
    status.metrics = { ttftMs: aggregate.ttftMs, latencyMs: aggregate.latencyMs, cacheRatePct: aggregate.cacheRatePct, hideTps: true, ttftLabel: '平均首 Token' };
    status.last = { at: dataThrough, state: current.state, ok: current.state === 'available' };
  }
  return result;
}

module.exports = { readBlackaicodingStatus, MONITOR_URL, ENDPOINT };
