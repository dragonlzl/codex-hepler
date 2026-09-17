const { createHash } = require('node:crypto');

const MERCHANT_HOSTS = {
  input: ['ai.input.im'],
  blackaicoding: ['blackaicoding.com', 'www.blackaicoding.com'],
  aixor: ['aixor.org', 'www.aixor.org', 'aixor.cc', 'www.aixor.cc'],
  packycode: ['packyapi.com', 'www.packyapi.com', 'cf.api.fan', 'slb-v1.api.fan', 'codex-api.packycode.com'],
  krill: ['krill-code.com', 'www.krill-code.com', 'api-slb.krill-code.net', 'api.cdn-krill-ai.com'],
  rightcode: ['rightapi.ai', 'www.rightapi.ai'],
  timicc: ['timicc.com', 'www.timicc.com'],
};

function merchantId(baseurl) {
  try {
    const url = new URL(baseurl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return providerId(baseurl);
    if (!url.port) for (const [id, hosts] of Object.entries(MERCHANT_HOSTS)) if (hosts.includes(url.hostname)) return id;
    return url.origin;
  } catch { return providerId(baseurl); }
}

function providerId(baseurl) {
  try { return new URL(baseurl.trim()).href.replace(/\/+$/, ''); }
  catch { return String(baseurl || ''); } // Keep incomplete legacy entries editable.
}

// Names and display masks cannot identify an account. Never send the key itself to the UI.
function accountId(entry) {
  const key = typeof entry.value === 'string' && entry.value.trim() ? entry.value.trim() : ['missing-key', entry.name];
  return createHash('sha256').update(JSON.stringify([providerId(entry.baseurl), key])).digest('hex');
}

module.exports = { providerId, accountId, merchantId };
