const { createHash } = require('node:crypto');
const { POOLS, KEY_PAGE_SIZE, keyEndpoint, isKeyEndpoint, poolForName } = require('./availability-aigo');

const keyHash = key => createHash('sha256').update(key).digest('hex');

async function readKeyGroups(request, url, options) {
  if (url !== keyEndpoint(1)) throw new Error('Invalid 派大星 keys endpoint');
  const groups = {};
  let pages = 1;
  for (let page = 1; page <= pages; page++) {
    const payload = await request(keyEndpoint(page), options);
    options.signal.throwIfAborted();
    const data = payload?.data;
    if (payload?.code !== 0 || !Array.isArray(data?.items) || !Number.isSafeInteger(data.pages) || data.pages < 0 || data.pages > 100 ||
        data.page !== page || data.page_size !== KEY_PAGE_SIZE || data.items.length > KEY_PAGE_SIZE) throw new Error('Invalid 派大星 keys page');
    if (page === 1) pages = data.pages;
    else if (data.pages !== pages) throw new Error('派大星 keys changed during pagination');
    for (const item of data.items) {
      if (typeof item?.key !== 'string' || !item.key || item.key.length > 2000) throw new Error('Missing complete 派大星 API key');
      const groupName = typeof item.group?.name === 'string' ? item.group.name.slice(0, 200) : typeof item.group_name === 'string' ? item.group_name.slice(0, 200) : '';
      const hash = keyHash(item.key);
      if (Object.hasOwn(groups, hash)) throw new Error('Duplicate 派大星 API key');
      groups[hash] = { groupName, pool: poolForName(groupName) };
    }
  }
  return groups;
}

module.exports = { POOLS, keyHash, keyEndpoint, isKeyEndpoint, readKeyGroups };
