const { problem } = require('./config-store');
const BALANCE_ENDPOINT = 'https://aixor.cc/api/user/self';
const SUBSCRIPTIONS_ENDPOINT = 'https://aixor.cc/api/subscription/self';
const PLANS_ENDPOINT = 'https://aixor.cc/api/subscription/plans';
const SETTINGS_ENDPOINT = 'https://aixor.cc/api/status';

function data(payload) {
  if (payload?.success !== true) {
    const expired = /^AUTH_/.test(payload?.code || '') || /未登录|登录.*(?:过期|失效)|not logged|session expired/i.test(payload?.message || '');
    throw Object.assign(new Error('Invalid Aixor account response'), expired ? { status: 401 } : {});
  }
  return payload.data;
}

function readAixorIdentity(payload) {
  const user = data(payload);
  if (!Number.isSafeInteger(user?.id) || user.id <= 0 || !Number.isFinite(user.quota)) throw new Error('Invalid Aixor account');
  return { userId: user.id, quota: user.quota };
}

function readAixorSettings(payload) {
  const settings = data(payload);
  const scale = Number(settings?.quota_per_unit);
  if (!Number.isFinite(scale) || scale <= 0 || settings.quota_display_type !== 'USD') throw new Error('Unsupported Aixor quota conversion');
  return { scale };
}

function readAixorPlans(payload) {
  const plans = data(payload);
  if (!Array.isArray(plans) || plans.length > 1000) throw new Error('Invalid Aixor plans');
  return Object.fromEntries(plans.map(item => {
    if (!Number.isSafeInteger(item?.plan?.id) || typeof item.plan.title !== 'string') throw new Error('Invalid Aixor plan');
    return [item.plan.id, item.plan.title.slice(0, 500)];
  }));
}

function readAixorBalance(payload, now, model, dependencies) {
  return { amount: readAixorIdentity(payload).quota / dependencies.settings.scale, currency: 'USD' };
}

function seconds(value, optional = false) {
  if (optional && (value == null || value === 0)) return null;
  if (!Number.isSafeInteger(value) || value <= 0 || value > 8640000000000) throw new Error('Invalid Aixor subscription time');
  return value * 1000;
}

function readAixorSubscriptions(payload, now, model, dependencies) {
  const subscriptions = data(payload);
  const rows = subscriptions?.all_subscriptions ?? subscriptions?.subscriptions;
  if (!Array.isArray(rows) || rows.length > 1000) throw new Error('Invalid Aixor subscriptions');
  const items = [];
  for (const row of rows) {
    const sub = row?.subscription;
    if (!sub || typeof sub.status !== 'string') throw new Error('Invalid Aixor subscription');
    if (sub.status === 'expired' || sub.status === 'cancelled' || sub.end_time === 0) continue;
    const expiresAt = seconds(sub.end_time);
    if (expiresAt <= now) continue;
    if (!Number.isSafeInteger(sub.id) || sub.id <= 0 || !Number.isSafeInteger(sub.plan_id)) throw new Error('Invalid Aixor subscription id');
    if (![sub.amount_total, sub.amount_used].every(value => Number.isFinite(value) && value >= 0)) throw new Error('Invalid Aixor subscription quota');
    const limit = sub.amount_total / dependencies.settings.scale, used = sub.amount_used / dependencies.settings.scale;
    const startsAt = seconds(sub.start_time, true);
    items.push({ id: sub.id, name: dependencies.plans?.[sub.plan_id] || '订阅 #' + sub.id,
      state: sub.status === 'active' ? (startsAt && startsAt > now ? 'pending' : 'active') : 'unknown', startsAt, expiresAt, currency: 'USD',
      unlimitedLabel: '不限总额度', quotas: limit > 0 ? [{ period: 'total', limit, used, remaining: Math.max(0, limit - used),
        resetsAt: seconds(sub.next_reset_time, true), noReset: !sub.next_reset_time }] : [] });
  }
  if (new Set(items.map(item => item.id)).size !== items.length) throw new Error('Duplicate Aixor subscription');
  return { items, hideExpired: true, emptyLabel: '暂无未过期订阅' };
}

function validateAixorSession(value) {
  const cookie = typeof value?.cookie === 'string' ? value.cookie.trim() : '';
  const userId = typeof value?.userId === 'string' && /^\d+$/.test(value.userId) ? Number(value.userId) : value?.userId;
  if (!cookie || cookie.length > 16000 || !cookie.split(/;\s*/).every(part => /^[!#$%&'*+.^_`|~0-9A-Za-z-]+=[\x21-\x3A\x3C-\x7E]+$/.test(part))) throw problem('请粘贴有效的 Cookie 请求头，不包含 Cookie: 前缀。', 400);
  if (!Number.isSafeInteger(userId) || userId <= 0) throw problem('请填写 New-Api-User 中的数字用户 ID。', 400);
  return { cookie, userId, expiresAt: null };
}

function sessionOptions(site, credential) {
  return ['aixor', 'packycode'].includes(site) ? { site, session: credential } : { site, token: credential.token };
}

module.exports = { BALANCE_ENDPOINT, SUBSCRIPTIONS_ENDPOINT, PLANS_ENDPOINT, SETTINGS_ENDPOINT, readAixorIdentity,
  readAixorSettings, readAixorPlans, readAixorBalance, readAixorSubscriptions, validateAixorSession, sessionOptions };
