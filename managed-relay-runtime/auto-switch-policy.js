// Policy consumes normalized monitor data; it never reads credentials or writes routes.
// Recovery evidence for entering a candidate, never a delay before leaving a failed route.
const WINDOW_MS = 3 * 60000;
const REFRESH_MS = 15000;
const MODELS = ['gpt-6-astra', 'gpt-5.6-sol'];
const currencyFormat = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 20 });
const defaults = () => ({ enabled: false, model: MODELS[0], subscriptionMinimum: 1, balanceMinimum: 1, pool: [] });
const invalid = message => Object.assign(new Error(message), { status: 400 });

function validateSettings(value, keys) {
  if (!value || typeof value.enabled !== 'boolean' || !MODELS.includes(value.model)) throw invalid('请选择自动切换开关和检测模型。');
  for (const field of ['subscriptionMinimum', 'balanceMinimum']) {
    if (!Number.isFinite(value[field]) || value[field] < 0 || value[field] > 1e12) throw invalid('M 和 N 必须是非负美元金额。');
  }
  if (!Array.isArray(value.pool) || value.pool.length > 500) throw invalid('自动切换池无效。');
  const names = new Set(), priorities = new Map();
  const pool = value.pool.map(item => {
    const key = keys.find(key => key.name === item?.name);
    if (!key || names.has(item.name)) throw invalid('池子中存在重复或已删除的配置，请刷新。');
    names.add(item.name);
    if (!Number.isSafeInteger(item.priority) || item.priority < 1 || item.priority > 9999) throw invalid('优先级必须是 1～9999 的整数。');
    if (!['balance', 'subscription'].includes(item.source)) throw invalid('请指定入口实际使用的余额或订阅。');
    if (item.source === 'subscription' && (!Number.isSafeInteger(item.subscriptionId) || item.subscriptionId < 1)) throw invalid('订阅入口需要关联一个已查询到的套餐。');
    const merchant = key.merchantId;
    if (priorities.has(merchant) && priorities.get(merchant) !== item.priority) throw invalid('同一中转商的入口必须使用相同优先级。');
    priorities.set(merchant, item.priority);
    return { name: item.name, priority: item.priority, source: item.source,
      ...(item.source === 'subscription' ? { subscriptionId: item.subscriptionId } : {}) };
  });
  if (value.enabled && !pool.length) throw invalid('请先将至少一个入口加入自动切换池。');
  return { enabled: value.enabled, model: value.model, subscriptionMinimum: value.subscriptionMinimum,
    balanceMinimum: value.balanceMinimum, pool };
}

function fresh(resource, now) {
  const age = now - resource?.fetchedAt;
  return resource?.state === 'available' && Number.isFinite(resource.fetchedAt) && age >= -5000 && age <= Math.max(60000, resource.refreshMs || 0) + REFRESH_MS;
}

function color(sample) {
  return sample?.state || (sample?.ok === true ? 'available' : sample?.ok === false ? 'unavailable' : 'no-data');
}

function health(row, now) {
  const unknown = { current: 'unknown', rank: null, reason: '状态未知、过期或无法读取' };
  if (row?.state === 'auth-required' || row?.requiresLogin) return { ...unknown, reason: '监控未登录或登录已过期，不代表 API Key 失效' };
  if (row?.failure) return { ...unknown, reason: '状态查询失败：' + (row.failure.message || '原因未知') };
  if (!row || row.referenceOnly || ['unsupported', 'error', 'stale', 'no-data'].includes(row.state)) return unknown;
  if (Array.isArray(row.channels)) {
    // Automatic monitoring requests the exact API-key pool, independently of display settings.
    if (row.channels.length !== 1) return { ...unknown, reason: '无法确认 API Key 对应号池' };
    return health(row.channels[0], now);
  }
  const last = row.last;
  if (!Number.isFinite(last?.at) || last.at > now + 5000 || now - last.at > (row.staleAfterMs || 180000)) return unknown;
  const current = color(last);
  if (['unavailable', 'maintenance'].includes(current) || row.state === 'unavailable') {
    return { current: 'unavailable', rank: null, reason: '当前检测不可用' };
  }
  if (!['available', 'degraded'].includes(current)) return unknown;
  const history = (row.history || []).filter(sample => Number.isFinite(sample.at) && sample.at <= now);
  const interval = row.sampleIntervalMs || 0;
  const samples = interval > WINDOW_MS ? [history.at(-1) || last] : history.filter(sample => sample.at >= now - WINDOW_MS);
  if (!samples.some(sample => sample.at === last.at)) samples.push(last);
  const states = samples.map(color);
  if (states.some(state => !['available', 'degraded'].includes(state))) {
    return { current, rank: null, reason: '最近 3 分钟内仍有异常或未知检测，等待恢复' };
  }
  return { current, rank: states.includes('degraded') ? 1 : 0,
    reason: states.includes('degraded') ? '黄色可用' : '绿色可用' };
}

function subscriptionRemaining(plan, merchant, now) {
  if (!plan || plan.quotaUnknown || plan.state !== 'active' || (plan.startsAt != null && plan.startsAt > now) ||
      (plan.expiresAt != null && plan.expiresAt <= now) || plan.currency !== 'USD') return null;
  const quotas = (plan.quotas || []).filter(quota => quota.period !== 'recent7d');
  if (!quotas.length) return plan.unlimited === true ? Infinity : null;
  if (quotas.some(quota => quota.unit || !Number.isFinite(quota.remaining) ||
    (quota.resetsAt != null && quota.resetsAt <= now))) return null;
  // Krill carryover is additional spendable quota, not another simultaneous cap.
  const carry = merchant === 'krill' ? quotas.find(quota => quota.period === 'carryover') : null;
  const limits = quotas.filter(quota => quota !== carry).map(quota => quota.remaining +
    (carry && ['daily', 'weekly'].includes(quota.period) ? carry.remaining : 0));
  return limits.length ? Math.min(...limits) : null;
}

function evaluate(settings, keys, rows, now) {
  return settings.pool.map(item => {
    const key = keys.find(key => key.name === item.name);
    const row = rows.find(row => row.name === item.name);
    const state = health(row, now);
    let reason = null;
    let fundingState = 'available';
    let fundingIssue = null;
    const exclude = (message, confirmed = false, issue = null) => {
      reason = message;
      fundingState = confirmed ? 'unavailable' : 'unknown';
      fundingIssue = issue;
    };
    if (!key) exclude('配置已删除', true);
    let remaining = null;
    if (!reason && item.source === 'subscription') {
      // Only the selected funding source decides eligibility. Website login
      // failure is missing telemetry, not evidence that the API key cannot work.
      if (!fresh(row?.subscriptions, now)) exclude(row?.subscriptions?.state === 'auth-required'
        ? '订阅查询需重新登录' : '订阅无法读取或数据已过期');
      else {
        const plan = row.subscriptions.items?.find(plan => plan.id === item.subscriptionId);
        remaining = subscriptionRemaining(plan, key.merchantId, now);
        const unusable = (!plan && Array.isArray(row.subscriptions.items)) || (plan &&
          (['expired', 'pending', 'revoked', 'cancelled', 'suspended', 'frozen'].includes(plan.state) ||
            (Number.isFinite(plan.startsAt) && plan.startsAt > now) || (Number.isFinite(plan.expiresAt) && plan.expiresAt <= now)));
        if (unusable) exclude('关联套餐不存在、未生效或已失效', true, 'inactive');
        else if (remaining === null) exclude('套餐额度未知或不是美元额度');
        else if (remaining <= 0 || remaining < settings.subscriptionMinimum) exclude(`订阅剩余低于 ${currencyFormat.format(settings.subscriptionMinimum)} 或已耗尽`, true, 'insufficient');
      }
    } else if (!reason) {
      if (!fresh(row?.balance, now)) exclude(row?.balance?.state === 'auth-required'
        ? '余额查询需重新登录' : '余额无法确认或数据已过期');
      else if (row.balance.currency !== 'USD' && !row.balance.unlimited) exclude('余额单位无法换算为美元');
      else if (!row.balance.unlimited && !Number.isFinite(row.balance.amount)) exclude('余额未知');
    }
    if (!reason && item.source !== 'subscription') {
      remaining = row.balance.unlimited ? Infinity : row.balance.amount;
      if (remaining <= 0 || remaining < settings.balanceMinimum) exclude(`余额低于 ${currencyFormat.format(settings.balanceMinimum)} 或已耗尽`, true, 'insufficient');
    }
    return { ...item, merchantId: key?.merchantId, currentHealth: state.current, healthRank: state.rank,
      fundingState, fundingReason: reason, fundingIssue,
      fundingFetchedAt: row?.[item.source === 'subscription' ? 'subscriptions' : 'balance']?.fetchedAt ?? null,
      healthReason: state.reason,
      qualified: !reason, eligible: !reason && state.rank !== null, reason: reason || state.reason,
      remaining: Number.isFinite(remaining) ? remaining : null, unlimited: remaining === Infinity,
      sampleAt: row?.channels?.[0]?.last?.at ?? row?.last?.at ?? null };
  });
}

function choose(candidates, activeName) {
  return candidates.filter(item => item.eligible).sort((a, b) => a.healthRank - b.healthRank || a.priority - b.priority ||
    String(a.merchantId).localeCompare(String(b.merchantId)) ||
    (a.source === 'subscription' ? 0 : 1) - (b.source === 'subscription' ? 0 : 1) ||
    (a.name === activeName ? -1 : b.name === activeName ? 1 : a.name.localeCompare(b.name)))[0] || null;
}

module.exports = { defaults, validateSettings, health, evaluate, choose, subscriptionRemaining, WINDOW_MS, REFRESH_MS };
