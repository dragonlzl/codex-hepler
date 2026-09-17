const ENDPOINT = 'https://www.rightapi.ai/models/availability?upstream_prefix=%2Fcodex&window=24h';
const CATALOG_ENDPOINT = 'https://www.rightapi.ai/models/public';
const HOUR = 3600000;

function codexCatalog(payload) {
  if (!Array.isArray(payload?.upstreams)) throw new Error('Invalid RC model catalog');
  const groups = payload.upstreams.filter(group => group?.prefix === '/codex');
  if (groups.length !== 1 || !Array.isArray(groups[0].models)) throw new Error('Missing RC Codex catalog');
  const models = {};
  for (const item of groups[0].models) {
    if (typeof item?.name !== 'string' || typeof item.is_available !== 'boolean' || Object.hasOwn(models, item.name)) throw new Error('Invalid RC model flag');
    Object.defineProperty(models, item.name, { value: item.is_available, enumerable: true });
  }
  return models;
}

function seconds(value) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 8640000000000) throw new Error('Invalid RC timestamp');
  return value * 1000;
}

function readRightcodeStatus(payload, models, now = Date.now(), catalog = {}) {
  if (payload?.upstream_prefix !== '/codex' || payload.window !== '24h' || !Array.isArray(payload.models)) throw new Error('Invalid RC Codex status');
  const generatedAt = seconds(payload.generated_at);
  if (generatedAt > now + 300000) throw new Error('Invalid RC generation time');
  const result = {};
  for (const model of models) {
    const rows = payload.models.filter(item => item?.model === model);
    if (rows.length > 1) throw new Error('Duplicate RC model');
    const base = { groupLabel: 'Codex', historyLength: 24, historyLabel: '有请求时段', uptimeLabel: '24 小时可用率',
      sampleTimeLabel: '最近时段', staleAfterMs: HOUR + 180000, history: [], last: null, sampleCount: 0, uptimePct: null };
    result[model] = base;
    if (!Object.hasOwn(catalog, model)) continue;
    if (catalog[model] === false) { base.disabled = true; continue; }
    const row = rows[0];
    if (!row) continue;
    if (!Array.isArray(row.points) || row.points.length > 120) throw new Error('Invalid RC history');
    const seen = new Set();
    const points = row.points.map(point => {
      const at = seconds(point?.start_at), endAt = seconds(point?.end_at);
      if (at % HOUR || endAt < at || endAt > at + HOUR || endAt > generatedAt + 300000 || seen.has(at) ||
          typeof point.no_sample !== 'boolean' || !Number.isFinite(point.availability) || point.availability < 0 || point.availability > 100) throw new Error('Invalid RC availability point');
      seen.add(at);
      const rate = point.availability;
      const state = point.no_sample ? 'no-data' : rate >= 90 ? 'available' : rate >= 60 ? 'degraded' : 'unavailable';
      // Match the source's logarithmic bars; keep 0% visible as a minimal red mark.
      const height = Math.max(1, Math.round((1 - Math.log(101 - rate) / Math.log(101)) * 24));
      return { at, endAt, state, ok: point.no_sample ? null : state === 'available', uptimePct: point.no_sample ? null : rate,
        barHeightPct: point.no_sample ? 12 : height / 24 * 100, sourceRate: rate };
    }).sort((a, b) => a.at - b.at).slice(-24);
    base.sampleCount = points.filter(point => point.state !== 'no-data').length;
    // RC displays the mean of all supplied hourly percentages, including no-sample
    // placeholders. Keep that denominator, but never advertise all-empty data as healthy.
    base.uptimePct = base.sampleCount ? points.reduce((sum, point) => sum + point.sourceRate, 0) / points.length : null;
    base.history = points.map(({ sourceRate, ...point }) => point);
    base.last = base.history.at(-1) || null;
    if (points.some(point => point.state === 'no-data')) base.modelNote = '灰色时段无请求；24 小时均值沿用站点统计口径。';
  }
  return result;
}

module.exports = { ENDPOINT, CATALOG_ENDPOINT, codexCatalog, readRightcodeStatus };
