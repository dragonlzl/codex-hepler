const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { accountId, providerId, merchantId } = require('./relay-identity');
const { bindingModel, updateBindingsForEdit } = require('./account-bindings');
const { parseTOML, getStaticTOMLValue } = require('toml-eslint-parser');

const problem = (message, status = 409) => Object.assign(new Error(message), { status });
const jsonText = value => `${JSON.stringify(value, null, 2)}\n`;
const sameUrl = (a, b) => typeof a === 'string' && typeof b === 'string' && a.replace(/\/$/, '') === b.replace(/\/$/, '');

async function readText(file, optional = false) {
  try { return await fs.readFile(file, 'utf8'); }
  catch (error) { if (optional && error.code === 'ENOENT') return null; throw error; }
}

async function atomicWrite(file, text) {
  if (text === null) { await fs.unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error; }); return; }
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    const handle = await fs.open(temp, 'wx', 0o600);
    try { await handle.writeFile(text, 'utf8'); await handle.sync(); } finally { await handle.close(); }
    await fs.rename(temp, file);
  } finally { await fs.unlink(temp).catch(() => {}); }
}

function inspectConfig(text) {
  let ast;
  try { ast = parseTOML(text); } catch { throw problem('Codex 配置不是有效的 TOML，未进行修改。'); }
  const config = getStaticTOMLValue(ast);
  const profile = config.profile && config.profiles?.[config.profile];
  const id = profile?.model_provider || config.model_provider || 'openai';
  const provider = config.model_providers?.[id];
  const values = new Map();
  function visit(node, prefix = []) {
    if (node.type === 'TOMLTable') {
      for (const child of node.body) visit(child, node.resolvedKey);
    } else if (node.type === 'TOMLKeyValue') {
      const keys = [...prefix, ...node.key.keys.map(key => key.type === 'TOMLBare' ? key.name : key.value)];
      values.set(JSON.stringify(keys), node.value);
      if (node.value.type === 'TOMLInlineTable') for (const child of node.value.body) visit(child, keys);
    } else if (node.body) {
      for (const child of node.body) visit(child, prefix);
    }
  }
  visit(ast);
  const baseNode = values.get(JSON.stringify(['model_providers', id, 'base_url']));
  return { id, provider, baseUrl: provider?.base_url || null, baseNode, text };
}

function patchBase(info, url, rawValue = JSON.stringify(url)) {
  if (!info.baseNode || typeof info.baseUrl !== 'string') throw problem('当前 provider 没有可编辑的 base_url。请先配置一个中转 provider。');
  const [start, end] = info.baseNode.range;
  const text = info.text.slice(0, start) + rawValue + info.text.slice(end);
  const next = inspectConfig(text);
  if (next.id !== info.id || next.baseUrl !== url) throw problem('配置校验失败，未进行修改。');
  return text;
}

function validateEntry(entry) {
  for (const key of ['name', 'value', 'baseurl']) {
    if (typeof entry?.[key] !== 'string' || !entry[key].trim() || entry[key].length > 2000) throw problem(`请填写有效的 ${key}（最多 2000 字符）。`, 400);
  }
  if (!/^[\x21-\x7e]+$/.test(entry.value.trim())) throw problem('API Key 不能包含空白或非 ASCII 字符。', 400);
  try {
    const url = new URL(entry.baseurl.trim());
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
  } catch { throw problem('Base URL 必须是无凭据、查询参数和片段的 HTTP(S) 地址。', 400); }
  return { name: entry.name.trim(), value: entry.value.trim(), baseurl: entry.baseurl.trim().replace(/\/$/, '') };
}

function mask(value) { return value ? `${value.slice(0, 3)}********${value.slice(-4)}` : ''; }
function entryRevision(entry) { return crypto.createHash('sha256').update(JSON.stringify(entry)).digest('hex'); }
function packyBalanceSource(state, name) {
  return Object.hasOwn(state.packyBalanceSources || {}, name) && state.packyBalanceSources[name] === 'account' ? 'account' : 'api-key';
}

function orderedKeys(keys, state) {
  const byName = new Map(keys.map(entry => [entry.name, entry]));
  const order = Array.isArray(state?.order) ? state.order : [];
  const result = [];
  for (const name of order) {
    const entry = byName.get(name);
    if (entry) { result.push(entry); byName.delete(name); }
  }
  const all = [...result, ...byName.values()];
  const pinned = new Set(Array.isArray(state?.pinned) ? state.pinned : []);
  return [...all.filter(entry => pinned.has(entry.name)), ...all.filter(entry => !pinned.has(entry.name))];
}

class ConfigStore {
  constructor(home, proxyUrl, write = atomicWrite) {
    this.home = home;
    this.proxyUrl = proxyUrl;
    this.configPath = path.join(home, 'config.toml');
    this.authPath = path.join(home, 'auth.json');
    this.keysPath = path.join(home, 'key_config.json');
    this.statePath = path.join(home, 'relay-ui-state.json');
    this.runtimeDir = path.join(home, 'relay-ui-runtime');
    this.sessionPath = path.join(this.runtimeDir, 'proxy-session.json');
    this.journalPath = path.join(this.runtimeDir, 'pending-write.json');
    this.write = write;
    this.queue = Promise.resolve();
  }

  serialize(action) {
    const next = this.queue.then(action);
    this.queue = next.catch(() => {});
    return next;
  }

  async keys() {
    const raw = await readText(this.keysPath);
    const config = JSON.parse(raw);
    if (!Array.isArray(config?.keys)) throw problem('中转列表缺少 keys 数组。');
    return { raw, config };
  }

  async read() {
    const info = inspectConfig(await readText(this.configPath));
    const authText = await readText(this.authPath, true);
    const auth = authText === null ? {} : JSON.parse(authText);
    const stateText = await readText(this.statePath, true);
    const state = stateText === null ? {} : JSON.parse(stateText);
    return { info, auth, authText, state, stateText, proxyInstalled: sameUrl(info.baseUrl, this.proxyUrl) };
  }

  directEntry(keys, current) {
    const matches = entry => sameUrl(entry.baseurl, current.info.baseUrl) && entry.value === current.auth.OPENAI_API_KEY;
    return keys.find(entry => entry.name === current.state.directName && matches(entry)) || keys.find(matches) || null;
  }

  async status() {
    await this.queue;
    const current = await this.read();
    const { config } = await this.keys();
    const selected = config.keys.find(entry => entry.name === current.state.activeName);
    const direct = this.directEntry(config.keys, current);
    const active = current.proxyInstalled ? selected : direct;
    const ordered = orderedKeys(config.keys, current.state);
    const pinned = new Set(Array.isArray(current.state?.pinned) ? current.state.pinned : []);
    const bindings = bindingModel(config.keys, current.state, this.home);
    const sessionText = await readText(this.sessionPath, true);
    const session = sessionText === null ? null : JSON.parse(sessionText);
    return {
      mode: current.proxyInstalled ? 'proxy' : 'direct', activeName: active?.name || null,
      selectedProxyName: selected?.name || direct?.name || null,
      proxyInstalled: current.proxyInstalled, proxyUrl: this.proxyUrl,
      providerId: current.info.id, providerName: current.info.provider?.name || current.info.id,
      configuredBaseUrl: current.info.baseUrl,
      canRestore: !!(current.proxyInstalled && session?.version === 1 && session.providerId === current.info.id),
      writeBlocked: (await readText(this.journalPath, true)) !== null,
      listActionsAvailable: true,
      editAvailable: true,
      accountBindingAvailable: true, accountBindingsRevision: bindings.revision,
      packyBalanceSourceAvailable: true,
      keys: ordered.map(entry => ({ name: entry.name, baseurl: entry.baseurl, providerId: providerId(entry.baseurl), ...bindings.describe(entry),
        ...(merchantId(entry.baseurl) === 'packycode' ? { balanceSource: packyBalanceSource(current.state, entry.name) } : {}),
        maskedValue: mask(entry.value), revision: entryRevision(entry), active: entry.name === active?.name, pinned: pinned.has(entry.name) })),
    };
  }

  async entry(name) {
    const { config } = await this.keys();
    const entry = config.keys.find(entry => entry.name === name);
    if (!entry) throw problem('指定的中转站不存在，请重新选择。', 400);
    return this.validateRoute(entry);
  }

  validateRoute(entry) {
    const valid = validateEntry(entry);
    const url = new URL(valid.baseurl);
    const local = new URL(this.proxyUrl);
    if (['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && url.port === local.port) throw problem('上游地址不能指向本地代理自身。', 400);
    return valid;
  }

  async activeEntry() {
    // A request keeps this entry for its entire lifetime, including SSE streams.
    await this.queue;
    const { state } = await this.read();
    return this.entry(state.activeName);
  }

  async commit(changes) {
    if (await readText(this.journalPath, true)) throw problem('上次配置写入未完成，已暂停自动写入。请先检查恢复记录。');
    const changed = changes.filter(change => change.before !== change.after);
    if (!changed.length) return;
    await fs.mkdir(this.runtimeDir, { recursive: true, mode: 0o700 });
    for (const change of changed) {
      if (await readText(change.file, true) !== change.before) throw problem('配置已被其他程序修改，请刷新后重试。');
    }
    const record = { at: new Date().toISOString(), changes: changed };
    const backup = path.join(this.runtimeDir, `backup-${Date.now()}-${crypto.randomUUID()}.json`);
    await atomicWrite(backup, jsonText(record));
    await atomicWrite(this.journalPath, jsonText(record));
    const applied = [];
    try {
      for (const change of changed) {
        if (await readText(change.file, true) !== change.before) throw problem('配置被其他程序修改，已取消写入。');
        await this.write(change.file, change.after);
        applied.push(change);
      }
      await fs.unlink(this.journalPath);
    } catch {
      let rolledBack = true;
      for (const change of applied.reverse()) {
        try {
          if (await readText(change.file, true) !== change.after) throw new Error('external change');
          await atomicWrite(change.file, change.before);
        } catch { rolledBack = false; }
      }
      if (rolledBack) await fs.unlink(this.journalPath);
      throw problem(rolledBack ? '写入失败，已回滚本次修改。' : '写入失败且检测到外部修改，已保留备份并暂停写入。', 500);
    }
  }

  select(name, mode) {
    return this.serialize(async () => {
      if (!['proxy', 'direct'].includes(mode)) throw problem('切换模式无效。', 400);
      const entry = await this.entry(name);
      const current = await this.read();
      if (mode === 'proxy') {
        await this.commit([{ file: this.statePath, before: current.stateText, after: jsonText({ ...current.state, version: 2, activeName: entry.name }) }]);
        return { restartRequired: !current.proxyInstalled, message: current.proxyInstalled ? `后续代理请求将使用「${entry.name}」。` : `已选择「${entry.name}」，尚未接入 Codex。` };
      }
      if (current.proxyInstalled) throw problem('请先切回直接配置，再选择直连中转站。');
      const provider = current.info.provider;
      const fixedAuth = Object.keys(provider?.http_headers || {}).some(key => ['authorization', 'api-key', 'x-api-key'].includes(key.toLowerCase()));
      if (provider?.env_key || provider?.experimental_bearer_token || fixedAuth || current.auth.tokens) throw problem('当前认证使用环境变量、固定请求头或 ChatGPT 登录，不能直接替换 API Key。');
      const updated = patchBase(current.info, entry.baseurl);
      await this.commit([
        { file: this.authPath, before: current.authText, after: jsonText({ ...current.auth, OPENAI_API_KEY: entry.value }) },
        { file: this.configPath, before: current.info.text, after: updated },
        { file: this.statePath, before: current.stateText, after: jsonText({ ...current.state, version: 2, directName: entry.name }) },
      ]);
      return { restartRequired: true, message: `已写入「${entry.name}」的直连配置，请重启 Codex。` };
    });
  }

  install(name) {
    return this.serialize(async () => {
      const current = await this.read();
      const { config } = await this.keys();
      const entry = await this.entry(name || current.state.activeName || this.directEntry(config.keys, current)?.name);
      const changes = [{ file: this.statePath, before: current.stateText, after: jsonText({ ...current.state, version: 2, activeName: entry.name }) }];
      if (!current.proxyInstalled) {
        const updated = patchBase(current.info, this.proxyUrl);
        const [start, end] = current.info.baseNode.range;
        const session = { version: 1, providerId: current.info.id, baseUrl: current.info.baseUrl, rawBaseValue: current.info.text.slice(start, end), configBefore: current.info.text, configApplied: updated };
        changes.unshift(
          { file: this.sessionPath, before: await readText(this.sessionPath, true), after: jsonText(session) },
          { file: this.configPath, before: current.info.text, after: updated },
        );
      }
      await this.commit(changes);
      return { restartRequired: true, message: '代理配置已写入，原 provider 身份和认证保持不变。请完整重启一次 Codex。' };
    });
  }

  restore() {
    return this.serialize(async () => {
      const current = await this.read();
      if (!current.proxyInstalled) return { restartRequired: false, message: '当前配置已是直连，未覆盖现有配置。' };
      const raw = await readText(this.sessionPath, true);
      const session = raw && JSON.parse(raw);
      if (session?.version !== 1 || session.providerId !== current.info.id || sameUrl(session.baseUrl, this.proxyUrl)) throw problem('没有本次接入前的恢复记录，不能自动恢复。请保留或手动恢复你自己的配置。');
      // Restore exact bytes when possible; preserve unrelated edits made since installation.
      const restored = current.info.text === session.configApplied ? session.configBefore : patchBase(current.info, session.baseUrl, session.rawBaseValue);
      await this.commit([{ file: this.configPath, before: current.info.text, after: restored }]);
      return { restartRequired: true, message: '已恢复本次接入前的直连配置，请完整重启 Codex。' };
    });
  }

  add(payload) {
    return this.serialize(async () => {
      const entry = validateEntry(payload);
      const { raw, config } = await this.keys();
      if (config.keys.some(item => item.name === entry.name)) throw problem('已存在同名中转站。');
      config.keys.push(entry);
      await this.commit([{ file: this.keysPath, before: raw, after: jsonText(config) }]);
      return { message: '中转站已保存。' };
    });
  }

  edit(originalName, payload) {
    return this.serialize(async () => {
      if (typeof originalName !== 'string' || !payload || typeof payload !== 'object') throw problem('编辑参数无效。', 400);
      const { raw, config } = await this.keys();
      const index = config.keys.findIndex(entry => entry.name === originalName);
      if (index < 0) throw problem('该中转已被删除或重命名，请关闭编辑并刷新后重试。');
      const original = config.keys[index];
      if (payload.revision !== entryRevision(original)) throw problem('该中转已被修改，请关闭编辑并刷新后重试。');
      const entry = this.validateRoute({
        name: payload.name, baseurl: payload.baseurl,
        value: payload.value === undefined || payload.value === '' ? original.value : payload.value,
      });
      if (config.keys.some((item, i) => i !== index && item.name === entry.name)) throw problem('已存在同名中转站。');
      const current = await this.read();
      const bindings = bindingModel(config.keys, current.state, this.home);
      config.keys[index] = { ...original, ...entry };
      const changes = [{ file: this.keysPath, before: raw, after: jsonText(config) }];
      const state = { ...current.state };
      if (Object.hasOwn(state.packyBalanceSources || {}, originalName)) {
        state.packyBalanceSources = { ...state.packyBalanceSources };
        delete state.packyBalanceSources[originalName];
        if (merchantId(entry.baseurl) === 'packycode') state.packyBalanceSources = { ...state.packyBalanceSources, [entry.name]: packyBalanceSource(current.state, originalName) };
      }
      if (current.state.accountBindings) state.accountBindings = updateBindingsForEdit(bindings, original, entry, config.keys);
      if (entry.name !== originalName) {
        if (state.activeName === originalName) state.activeName = entry.name;
        if (state.directName === originalName) state.directName = entry.name;
        for (const field of ['order', 'pinned']) {
          if (Array.isArray(state[field])) state[field] = state[field].filter(name => name !== entry.name).map(name => name === originalName ? entry.name : name);
        }
      }
      if (JSON.stringify(state) !== JSON.stringify(current.state)) changes.push({ file: this.statePath, before: current.stateText, after: jsonText(state) });
      await this.commit(changes);
      const connectionChanged = entry.value !== original.value || !sameUrl(entry.baseurl, original.baseurl);
      const activeProxy = current.proxyInstalled && current.state.activeName === originalName;
      return {
        message: activeProxy && connectionChanged ? '中转信息已保存，后续代理请求将使用新配置，无需重启 Codex。'
          : !current.proxyInstalled && connectionChanged ? '中转信息已保存。要应用到 Codex，请点击该中转的“切换”，再重启 Codex。'
            : '中转信息已保存。',
      };
    });
  }

  setPackyBalanceSource(payload) {
    return this.serialize(async () => {
      if (!['api-key', 'account'].includes(payload?.source)) throw problem('请选择 API Key 限额或登录账号余额。', 400);
      const { config } = await this.keys(), current = await this.read();
      const entry = config.keys.find(entry => entry.name === payload.name);
      if (!entry || merchantId(entry.baseurl) !== 'packycode') throw problem('请选择 Packycode 子项。', 400);
      if (payload.revision !== entryRevision(entry) || payload.previousSource !== packyBalanceSource(current.state, entry.name)) throw problem('子项配置已变化，请刷新后重试。', 409);
      const next = { ...current.state, packyBalanceSources: { ...current.state.packyBalanceSources, [entry.name]: payload.source } };
      await this.commit([{ file: this.statePath, before: current.stateText, after: jsonText(next) }]);
      return { message: '已保存该子项的余额来源。' };
    });
  }

  bindAccounts(payload, prepareAuthorization = async () => []) {
    return this.serialize(async () => {
      if (typeof payload?.targetName !== 'string' || !Array.isArray(payload.names) || !payload.names.length || payload.names.some(name => typeof name !== 'string')) throw problem('请选择要绑定的账号。', 400);
      const { config } = await this.keys();
      const current = await this.read();
      const model = bindingModel(config.keys, current.state, this.home);
      if (payload.revision !== model.revision) throw problem('账号或绑定关系已变化，请关闭弹窗并重新选择。');
      const find = name => {
        const entry = config.keys.find(entry => entry.name === name);
        if (!entry) throw problem('中转配置已变化，请刷新后重试。');
        return { name: entry.name, baseurl: entry.baseurl, ...model.describe(entry) };
      };
      const target = find(payload.targetName), selected = payload.names.map(find);
      if (selected.some(entry => entry.merchantId !== target.merchantId)) throw problem('只能绑定同一中转商的账号。', 400);
      const owners = new Set([target.accountId, ...selected.map(entry => entry.accountId)]);
      if (owners.size < 2) throw problem('这些配置已经属于同一账号。', 400);
      const existing = model.records.find(record => record.id === target.accountBindingId);
      const consumed = model.records.filter(record => owners.has(record.id));
      const members = [...new Set([...consumed.flatMap(record => record.members), ...[target, ...selected].map(entry => entry.naturalAccountId)])];
      const binding = { id: existing?.id || crypto.randomBytes(32).toString('hex'), merchant: target.merchantId,
        members, sourceId: existing?.sourceId || target.naturalAccountId };
      const records = model.records.filter(record => !owners.has(record.id)); records.push(binding);
      const next = { ...current.state, version: 2, accountBindings: records };
      bindingModel(config.keys, next, this.home); // Validate ownership before copying credentials or committing.
      const changes = await prepareAuthorization({ target, binding });
      await this.commit([...changes, { file: this.statePath, before: current.stateText, after: jsonText(next) }]);
      return { message: '已设为同一账号，登录、余额和订阅将共用。', merchant: target.merchantId, affectedAccounts: [...owners, binding.id] };
    });
  }

  unbindAccount(payload) {
    return this.serialize(async () => {
      const { config } = await this.keys();
      const current = await this.read();
      const model = bindingModel(config.keys, current.state, this.home);
      if (payload?.revision !== model.revision) throw problem('账号或绑定关系已变化，请关闭弹窗并重新选择。');
      const entry = config.keys.find(entry => entry.name === payload.name);
      const binding = entry && model.byNatural.get(accountId(entry));
      if (!binding || binding.id !== payload.accountId) throw problem('该账号的绑定关系已变化，请刷新后重试。');
      if (payload.all !== undefined && typeof payload.all !== 'boolean') throw problem('解绑参数无效。', 400);
      let records = model.records;
      if (payload.all) records = records.filter(record => record.id !== binding.id);
      else {
        const id = accountId(entry);
        binding.members = binding.members.filter(member => member !== id);
        if (binding.sourceId === id) binding.sourceId = binding.members.find(member => model.natural.has(member)) || binding.members[0];
        records = records.filter(record => record.members.length);
      }
      const next = { ...current.state, version: 2, accountBindings: records };
      await this.commit([{ file: this.statePath, before: current.stateText, after: jsonText(next) }]);
      return { message: payload.all ? '已全部解绑，各账号恢复原有独立授权。' : '已解绑该账号，其余成员继续共用授权。',
        merchant: binding.merchant, affectedAccounts: [binding.id, ...binding.members, accountId(entry)] };
    });
  }

  reorder(names) {
    return this.serialize(async () => {
      if (!Array.isArray(names) || names.some(name => typeof name !== 'string')) throw problem('中转排序数据无效。', 400);
      const { config } = await this.keys();
      const known = new Set(config.keys.map(entry => entry.name));
      if (names.length !== known.size || new Set(names).size !== names.length || names.some(name => !known.has(name))) {
        throw problem('中转排序与当前列表不一致，请刷新后重试。', 409);
      }
      const current = await this.read();
      const pins = new Set(Array.isArray(current.state?.pinned) ? current.state.pinned : []);
      const groups = [names.filter(name => !pins.has(name)), names.filter(name => pins.has(name))];
      const indices = [0, 0];
      // Reorder within each group while keeping pinned slots in the base order.
      // Unpinning then restores placement without promoting other pinned entries.
      const order = orderedKeys(config.keys, { order: current.state.order }).map(entry => {
        const group = Number(pins.has(entry.name));
        return groups[group][indices[group]++];
      });
      const nextState = { ...current.state, version: 2, order };
      await this.commit([{ file: this.statePath, before: current.stateText, after: jsonText(nextState) }]);
      return { message: '中转站排序已保存。' };
    });
  }

  pin(name, pinned = true) {
    return this.serialize(async () => {
      if (typeof name !== 'string' || typeof pinned !== 'boolean') throw problem('置顶参数无效。', 400);
      const { config } = await this.keys();
      if (!config.keys.some(entry => entry.name === name)) throw problem('指定的中转站不存在，请刷新后重试。', 400);
      const current = await this.read();
      const pins = new Set(Array.isArray(current.state?.pinned) ? current.state.pinned : []);
      if (pinned) pins.add(name); else pins.delete(name);
      const nextState = { ...current.state, version: 2, pinned: [...pins] };
      await this.commit([{ file: this.statePath, before: current.stateText, after: jsonText(nextState) }]);
      return { message: pinned ? `已将「${name}」置顶。` : `已取消「${name}」置顶。` };
    });
  }
}

module.exports = { ConfigStore, inspectConfig, patchBase, validateEntry, orderedKeys, atomicWrite, sameUrl, problem };
