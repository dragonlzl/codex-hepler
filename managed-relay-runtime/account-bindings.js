const { createHash } = require('node:crypto');
const { accountId, merchantId, providerId } = require('./relay-identity');

const invalid = () => Object.assign(new Error('账号绑定设置无效，请检查本地绑定配置。'), { status: 409 });
const isId = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

// The binding is an additive overlay: natural identities and original credentials stay intact.
function bindingModel(keys, state, context = '') {
  const records = structuredClone(state.accountBindings || []);
  if (!Array.isArray(records)) throw invalid();
  const byNatural = new Map(), ids = new Set(), natural = new Map();
  for (const entry of keys) {
    const id = accountId(entry);
    if (!natural.has(id)) natural.set(id, []);
    natural.get(id).push(entry);
  }
  for (const record of records) {
    if (!record || typeof record !== 'object' || !isId(record.id) || ids.has(record.id) || natural.has(record.id) || typeof record.merchant !== 'string' ||
      !Array.isArray(record.members) || !record.members.length || !record.members.every(isId) || !record.members.includes(record.sourceId)) throw invalid();
    // Before the RC adapter existed, its bindings used the origin as merchant ID.
    // Preserve the existing account IDs and credentials when recognizing this site.
    if (['https://rightapi.ai', 'https://www.rightapi.ai'].includes(record.merchant)) record.merchant = 'rightcode';
    if (['https://timicc.com', 'https://www.timicc.com'].includes(record.merchant)) record.merchant = 'timicc';
    if (record.merchant === 'https://api.aigo0.com') record.merchant = 'aigo';
    ids.add(record.id);
    for (const id of record.members) {
      if (byNatural.has(id) || natural.get(id)?.some(entry => merchantId(entry.baseurl) !== record.merchant)) throw invalid();
      byNatural.set(id, record);
    }
  }
  const grouped = new Set(records.filter(record => record.members.some(id => natural.has(id))).map(record => record.merchant));
  const revision = createHash('sha256').update(JSON.stringify([context, keys.map(entry => [entry.name, accountId(entry)]), records])).digest('hex');
  function describe(entry) {
    const id = accountId(entry), merchant = merchantId(entry.baseurl), binding = byNatural.get(id);
    const liveMembers = binding?.members.filter(id => natural.has(id)) || [];
    const source = binding && (natural.get(binding.sourceId)?.[0] || natural.get(liveMembers[0])?.[0]);
    return {
      naturalAccountId: id, accountId: binding?.id || id, merchantId: merchant,
      accountBindingId: binding?.id || null, boundAccountCount: liveMembers.length,
      accountSourceName: source?.name || entry.name,
      displayProviderId: merchant === 'krill' ? 'krill' : grouped.has(merchant) ? 'merchant:' + merchant : providerId(entry.baseurl),
    };
  }
  return { records, byNatural, natural, revision, describe };
}

function updateBindingsForEdit(model, original, updated, keys) {
  const before = accountId(original), after = accountId(updated);
  const binding = model.byNatural.get(before);
  if (!binding || before === after) return model.records;
  const destination = model.byNatural.get(after);
  if (destination && destination.id !== binding.id) {
    throw Object.assign(new Error('新的地址与 Key 已属于另一个绑定账号，请先解绑再编辑。'), { status: 409 });
  }
  if (merchantId(updated.baseurl) === binding.merchant && !binding.members.includes(after)) binding.members.push(after);
  if (!keys.some(entry => accountId(entry) === before)) {
    binding.members = binding.members.filter(id => id !== before);
    if (binding.sourceId === before) binding.sourceId = binding.members.includes(after) ? after : binding.members[0];
  }
  return model.records.filter(record => record.members.length);
}

module.exports = { bindingModel, updateBindingsForEdit };
