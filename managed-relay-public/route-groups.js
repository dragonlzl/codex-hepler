/* Shared display rules; only opaque server account IDs are compared, never masked keys. */
const RelayGroups = (() => {
  const packyHosts = new Set(['packyapi.com', 'www.packyapi.com', 'cf.api.fan', 'slb-v1.api.fan', 'codex-api.packycode.com']);
  const krillHosts = new Set(['krill-code.com', 'www.krill-code.com', 'api-slb.krill-code.net', 'api.cdn-krill-ai.com']);
  function endpoint(entry) {
    try { return new URL(entry.baseurl).href.replace(/\/+$/, ''); }
    catch { return String(entry.baseurl || ''); }
  }
  function isKrill(entry) {
    try {
      const url = new URL(entry.baseurl);
      return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.port && krillHosts.has(url.hostname);
    } catch { return false; }
  }
  function providerLabel(id) {
    if (id.startsWith('merchant:')) {
      const merchant = id.slice('merchant:'.length);
      return ({ input: 'INPUT', blackaicoding: 'code for me', aixor: 'Aixor', packycode: 'packycode', krill: 'Krill' })[merchant] || providerLabel(merchant);
    }
    if (id === 'krill') return 'Krill';
    try {
      const url = new URL(id);
      return packyHosts.has(url.hostname) ? 'packycode' : url.host;
    } catch { return '未配置地址'; }
  }
  function routeLabel(entry) {
    if (isKrill(entry)) return entry.name.replace(/^krill[\s·:：/_—-]*/i, '').trim() || '默认线路';
    if (providerLabel(provider(entry)) !== 'packycode') return entry.name;
    // The provider heading already supplies the brand; keep the distinct configuration suffix.
    return entry.name.replace(/^packycode[\s·:：/_—-]*/i, '').trim() || '默认配置';
  }
  function provider(entry) {
    if (entry.displayProviderId) return entry.displayProviderId;
    if (isKrill(entry)) return 'krill';
    return entry.providerId || endpoint(entry);
  }
  function group(keys) {
    const groups = new Map();
    for (const entry of keys) {
      const id = provider(entry);
      if (!groups.has(id)) groups.set(id, { id, entries: [], accounts: new Map() });
      const item = groups.get(id);
      item.entries.push(entry);
      const account = entry.accountId || entry.name;
      if (!item.accounts.has(account)) item.accounts.set(account, []);
      item.accounts.get(account).push(entry);
    }
    return [...groups.values()];
  }
  function reorder(keys, sourceName, targetName, wholeProvider = false) {
    const source = keys.find(entry => entry.name === sourceName);
    const target = keys.find(entry => entry.name === targetName);
    if (!source || !target || source === target) return null;
    if (wholeProvider) {
      const groups = group(keys);
      const from = groups.findIndex(item => item.id === provider(source));
      const to = groups.findIndex(item => item.id === provider(target));
      if (from === to || groups[from].entries.some(entry => entry.pinned) !== groups[to].entries.some(entry => entry.pinned)) return null;
      groups.splice(to, 0, groups.splice(from, 1)[0]);
      return groups.flatMap(item => item.entries.map(entry => entry.name));
    }
    if (Boolean(source.pinned) !== Boolean(target.pinned)) return null;
    // Crossing provider boundaries moves the complete provider; entries never change ownership.
    if (provider(source) !== provider(target)) return reorder(keys, sourceName, targetName, true);
    // Accounts render as contiguous blocks with one shared balance/subscription area.
    // Move aliases within that block, or move the complete account between blocks.
    const accounts = [...group(keys).find(item => item.id === provider(source)).accounts.values()];
    const from = accounts.findIndex(items => items.includes(source));
    const to = accounts.findIndex(items => items.includes(target));
    if (from === to) {
      const items = accounts[from];
      items.splice(items.indexOf(target), 0, items.splice(items.indexOf(source), 1)[0]);
    } else {
      if (accounts[from].some(entry => entry.pinned) !== accounts[to].some(entry => entry.pinned)) return null;
      accounts.splice(to, 0, accounts.splice(from, 1)[0]);
    }
    const names = accounts.flatMap(items => items.map(entry => entry.name));
    let index = 0;
    return keys.map(entry => provider(entry) === provider(source) ? names[index++] : entry.name);
  }
  return { provider, providerLabel, routeLabel, endpoint, group, reorder };
})();
if (typeof module !== 'undefined') module.exports = RelayGroups;
