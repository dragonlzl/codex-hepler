const IDENTITY_ENDPOINT = 'https://www.krill-code.com/api/auth/me';
const BALANCE_ENDPOINT = 'https://www.krill-code.com/api/credits';
const SUBSCRIPTIONS_ENDPOINT = 'https://www.krill-code.com/api/subscription';
const USAGE_ENDPOINT = 'https://www.krill-code.com/api/subscription/quota-usage';
const WEEK_MS = 7 * 86400000;

function data(payload) {
  if (payload?.success !== true || payload.code !== 0 || !payload.data || typeof payload.data !== 'object') throw new Error('Invalid Krill account response');
  return payload.data;
}

function decimal(value, optional = false) {
  if (optional && value == null) return null;
  if (typeof value !== 'number' && !(typeof value === 'string' && /^-?\d+(?:\.\d+)?$/.test(value))) throw new Error('Invalid Krill amount');
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error('Invalid Krill amount');
  return number;
}

function timestamp(value, optional = false) {
  if (optional && value == null) return null;
  if (typeof value !== 'string' || !/(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) throw new Error('Invalid Krill timestamp');
  return Date.parse(value);
}

function id(value) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Invalid Krill subscription id');
  return value;
}

function name(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 500) throw new Error('Invalid Krill plan name');
  return value;
}

function readKrillIdentity(payload) {
  const user = data(payload);
  return { userId: id(user.id) };
}

function readKrillBalance(payload) {
  return { amount: decimal(data(payload).balance_usd), currency: 'USD' };
}

function usageBody(now) {
  return { start_time: new Date(now - WEEK_MS).toISOString(), end_time: new Date(now).toISOString() };
}

function readKrillUsage(payload, now) {
  const usage = data(payload);
  if (!Array.isArray(usage.items) || usage.items.length > 500) throw new Error('Invalid Krill usage');
  const items = usage.items.map(item => {
    const used = decimal(item.used_usd), limit = decimal(item.limit_usd);
    if (used < 0 || limit < 0) throw new Error('Invalid Krill usage quota');
    return { id: id(item.subscription_id), name: name(item.plan_name), used, limit };
  });
  if (new Set(items.map(item => item.id)).size !== items.length) throw new Error('Duplicate Krill usage');
  return { items, startAt: now - WEEK_MS, endAt: now };
}

function quota(period, usedValue, limitValue, options = {}) {
  const used = decimal(usedValue, true), limit = decimal(limitValue, true);
  if ((used !== null && used < 0) || (limit !== null && limit < 0)) throw new Error('Invalid Krill quota');
  return { period, used, limit, remaining: used !== null && limit !== null ? Math.max(0, limit - used) : null,
    resetsAt: null, resetLabel: '以站点计费窗口为准', ...options };
}

function currentQuotas(item, sharedRequestQuota) {
  const plan = item.plan, value = item.quota;
  if (item.status === 'frozen') return [];
  if (plan.billing_type === 'request_count') {
    if (!sharedRequestQuota) return [];
    return [['requests5h', '5h'], ['requestsWeekly', 'weekly'], ['requestsMonthly', 'monthly']].map(([period, key]) =>
      quota(period, sharedRequestQuota['used_' + key], sharedRequestQuota['limit_' + key], { unit: 'requests', resetLabel: '账号共享请求次数额度' }));
  }
  if (!value || typeof value !== 'object') return [];
  const resetAt = timestamp(value.window_reset_at, true);
  const timing = resetAt === null ? {} : { resetsAt: resetAt, resetLabel: null };
  if (plan.total_credits != null || value.limit_credits != null) {
    const limit = decimal(value.limit_credits, true), remaining = decimal(value.remaining_credits, true);
    return [quota('credits', limit !== null && remaining !== null ? Math.max(0, limit - remaining) : null, limit, { ...timing, unit: 'credits' })];
  }
  const daily = plan.billing_type === 'usd_daily', monthly = plan.billing_type === 'usd_monthly', weekly = plan.billing_type === 'usd_weekly';
  const quotas = [quota(daily || monthly ? 'total' : weekly ? 'weekly' : 'daily',
    daily ? item.total_used_usd : value.used_usd, daily ? item.total_limit_usd : value.daily_limit_usd, timing)];
  if (!monthly && !daily && decimal(value.forwarded_limit_usd, true) > 0) quotas.unshift(quota('carryover', value.forwarded_used_usd, value.forwarded_limit_usd));
  if (weekly && Number(plan.duration_days) >= 14) {
    const limit = decimal(item.total_limit_usd, true), remaining = decimal(item.total_remaining_usd, true);
    quotas.push(quota('total', limit !== null && remaining !== null ? Math.max(0, limit - remaining) : null, limit));
  }
  return quotas;
}

function readKrillSubscriptions(payload, now, model, dependencies) {
  const subscription = data(payload);
  if (!Array.isArray(subscription.subscriptions) || subscription.subscriptions.length > 500) throw new Error('Invalid Krill subscriptions');
  const usage = dependencies.usage;
  const usageById = new Map(usage.items.map(item => [item.id, item]));
  const items = [];
  for (const item of subscription.subscriptions) {
    const itemId = id(item.subscription_id), expiresAt = timestamp(item.subscription_end_at);
    if (expiresAt <= now || ['expired', 'cancelled', 'revoked'].includes(item.status)) continue;
    const startsAt = timestamp(item.subscription_start_at, true);
    const state = item.status === 'frozen' ? 'frozen' : item.status === 'active' ? (startsAt && startsAt > now ? 'pending' : 'active') : 'unknown';
    const quotas = currentQuotas(item, subscription.request_count_quota);
    const recent = usageById.get(itemId);
    const recentQuota = quota('recent7d', recent?.used ?? null, recent?.limit ?? null, {
      remainingLabel: '区间余量', resetLabel: '统计区间额度，非套餐剩余额度',
    });
    quotas.push(recentQuota);
    items.push({ id: itemId, name: name(item.plan?.name), state, startsAt, expiresAt, currency: 'USD', quotas,
      note: state === 'frozen' ? '套餐已冻结；近 7 天用量保留历史统计' : undefined });
  }
  if (new Set(items.map(item => item.id)).size !== items.length) throw new Error('Duplicate Krill subscription');
  return { items, hideExpired: true, emptyLabel: '暂无有效套餐', headingLabel: '登录账号套餐',
    windowStartAt: usage.startAt, windowEndAt: usage.endAt };
}

module.exports = { IDENTITY_ENDPOINT, BALANCE_ENDPOINT, SUBSCRIPTIONS_ENDPOINT, USAGE_ENDPOINT, usageBody,
  readKrillIdentity, readKrillBalance, readKrillUsage, readKrillSubscriptions };
