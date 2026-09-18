const { readBlackaicodingBalance } = require('./balance-blackaicoding');

const BALANCE_ENDPOINT = 'https://ai.input.im/api/v1/auth/me';
const SUBSCRIPTIONS_ENDPOINT = 'https://ai.input.im/api/v1/subscriptions';

function timestamp(value) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || !/(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) throw new Error('Invalid subscription timestamp');
  return Date.parse(value);
}

function amount(value) {
  if (value == null) return null;
  if (!Number.isFinite(value) || value < 0) throw new Error('Invalid subscription quota');
  return value;
}

function readInputSubscriptions(payload, now = Date.now()) {
  if (payload?.code !== 0 || !Array.isArray(payload.data) || payload.data.length > 500) throw new Error('Invalid subscriptions response');
  const items = payload.data.map(item => {
    if (!item || !Number.isSafeInteger(item.id) || item.id <= 0 || typeof item.status !== 'string') throw new Error('Invalid subscription');
    const group = item.group;
    if (!group || typeof group.name !== 'string' || !group.name.trim() || group.name.length > 500) throw new Error('Missing subscription group');
    const startsAt = timestamp(item.starts_at), expiresAt = timestamp(item.expires_at);
    let state = ['active', 'expired', 'revoked', 'cancelled', 'suspended', 'pending'].includes(item.status) ? item.status : 'unknown';
    if (state === 'active' && expiresAt !== null && expiresAt <= now) state = 'expired';
    else if (state === 'active' && startsAt !== null && startsAt > now) state = 'pending';
    const quotas = ['daily', 'weekly', 'monthly'].map((period, index) => {
      const limit = amount(group[period + '_limit_usd']);
      const used = amount(item[period + '_usage_usd']);
      const windowStart = timestamp(item[period + '_window_start']);
      // Source uses rolling 24h / 7d / 30d windows; one-day packages end with the subscription.
      const endsWithSubscription = period === 'daily' && startsAt !== null && expiresAt !== null && expiresAt <= startsAt + 86400000;
      const resetsAt = windowStart === null ? null : endsWithSubscription ? expiresAt : windowStart + [24, 168, 720][index] * 3600000;
      return { period, limit, used, remaining: limit > 0 && used !== null ? Math.max(0, limit - used) : null,
        resetsAt, endsWithSubscription };
    }).filter(quota => quota.limit > 0);
    const limits = ['daily', 'weekly', 'monthly'].map(period => group[period + '_limit_usd']);
    const quotaUnknown = limits.some(value => value === null);
    const unlimited = !quotaUnknown && !quotas.length && limits.some(value => value === 0);
    return { id: item.id, name: group.name, state, startsAt, expiresAt, quotas, currency: 'USD',
      ...(unlimited ? { unlimited: true } : {}), ...(quotaUnknown ? { quotaUnknown: true } : {}) };
  });
  if (new Set(items.map(item => item.id)).size !== items.length) throw new Error('Duplicate subscription');
  return { items };
}

module.exports = { BALANCE_ENDPOINT, SUBSCRIPTIONS_ENDPOINT, readInputBalance: readBlackaicodingBalance, readInputSubscriptions };
