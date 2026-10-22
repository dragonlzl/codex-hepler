const fs = require('node:fs/promises');
const { parseTOML, getStaticTOMLValue } = require('toml-eslint-parser');

const fail = message => Object.assign(new Error(message), { status: 409 });
const jsonText = value => `${JSON.stringify(value, null, 2)}\n`;
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const sameUrl = (a, b) => typeof a === 'string' && typeof b === 'string' && a.replace(/\/$/, '') === b.replace(/\/$/, '');
const rootRouting = new Set(['model_provider', 'profile', 'model', 'base_url', 'openai_base_url', 'chatgpt_base_url', 'forced_login_method']);

function parseConfig(text) {
  try {
    const ast = parseTOML(text);
    return { ast, config: getStaticTOMLValue(ast) };
  } catch { throw fail('账号配置不是有效的 TOML，未进行修改。'); }
}

function context(text) {
  const { config } = parseConfig(text);
  const profile = config.profile && config.profiles?.[config.profile];
  const id = profile?.model_provider || config.model_provider || 'openai';
  const provider = config.model_providers?.[id];
  const custom = provider?.base_url || config.base_url || config.openai_base_url || config.chatgpt_base_url || profile?.base_url || profile?.openai_base_url || profile?.chatgpt_base_url;
  // Read the actual active provider each time; a previous tool selection is not authoritative.
  const mode = id === 'openai' && !custom ? 'official' : 'relay';
  return { config, profile, id, provider, mode };
}

function blockedReason(text) {
  const { config, profile, provider } = context(text);
  const credentialStore = profile?.cli_auth_credentials_store ?? config.cli_auth_credentials_store;
  if (credentialStore !== undefined && credentialStore !== 'file') return '当前认证存储不是 file（使用了系统钥匙串或临时存储），无法安全备份登录状态。请先在 Codex 中改用 file 存储。';
  const headers = { ...(provider?.http_headers || {}), ...(provider?.env_http_headers || {}) };
  const fixed = Object.keys(headers).some(key => ['authorization', 'api-key', 'x-api-key'].includes(key.toLowerCase()));
  if (provider?.env_key || provider?.experimental_bearer_token || provider?.auth || fixed || profile?.experimental_bearer_token) return '当前提供方使用环境变量、认证命令或固定认证请求头，无法完整保存认证状态。请先改为文件中的认证。';
  if (process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY || process.env.OPENAI_BASE_URL || process.env.OPENAI_API_BASE || process.env.CHATGPT_BASE_URL) return '工具进程包含 OpenAI 认证或地址环境变量，无法安全切换。请去掉这些环境变量后重新启动工具。';
  return null;
}

function loggedIn(auth) {
  return object(auth?.tokens) && ['access_token', 'id_token', 'refresh_token'].some(key => typeof auth.tokens[key] === 'string' && auth.tokens[key].length > 0);
}

function parseAuth(text) {
  if (text === null) return {};
  try {
    const auth = JSON.parse(text);
    if (!object(auth)) throw new Error();
    return auth;
  } catch { throw fail('账号认证备份损坏，未写入任何配置。'); }
}

// Keep unrelated settings and their comments byte-for-byte. Inactive provider/profile
// definitions may remain, but the official mode never selects or overrides them.
function officialConfig(text) {
  const { ast } = parseConfig(text);
  const ranges = [];
  function visit(node, prefix = []) {
    if (node.type === 'TOMLTable') {
      const keys = node.resolvedKey;
      if (keys[0] === 'model_providers' && keys[1] === 'openai') { ranges.push(node.range); return; }
      for (const child of node.body) visit(child, keys);
    } else if (node.type === 'TOMLKeyValue') {
      const keys = [...prefix, ...node.key.keys.map(key => key.type === 'TOMLBare' ? key.name : key.value)];
      if ((keys.length === 1 && rootRouting.has(keys[0])) ||
          (keys[0] === 'model_providers' && (keys.length === 1 || keys[1] === 'openai'))) ranges.push(node.range);
    } else if (node.body) for (const child of node.body) visit(child, prefix);
  }
  visit(ast);
  let result = text;
  for (const [start, end] of ranges.sort((a, b) => b[0] - a[0])) result = result.slice(0, start) + result.slice(end);
  result = `model_provider = "openai"\nforced_login_method = "chatgpt"\n${result}`;
  if (context(result).mode !== 'official') throw fail('无法安全生成官方账号配置，未进行修改。');
  return result;
}

async function readOptional(file) {
  try { return await fs.readFile(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function validateSnapshot(snapshot, mode) {
  if (!object(snapshot) || typeof snapshot.configText !== 'string' || !(snapshot.authText === null || typeof snapshot.authText === 'string') ||
      !(snapshot.sessionText === null || typeof snapshot.sessionText === 'string') || !object(snapshot.route)) throw fail('账号切换备份格式损坏，未写入任何配置。');
  if (context(snapshot.configText).mode !== mode) throw fail('账号切换备份与提供方不匹配，未写入任何配置。');
  parseAuth(snapshot.authText);
  for (const field of ['activeName', 'directName']) if (snapshot.route[field] !== undefined && snapshot.route[field] !== null && typeof snapshot.route[field] !== 'string') throw fail('账号路由备份损坏，未写入任何配置。');
  if (snapshot.sessionText !== null) {
    let session;
    try { session = JSON.parse(snapshot.sessionText); } catch { throw fail('代理恢复备份损坏，未写入任何配置。'); }
    if (!object(session) || session.version !== 1 || typeof session.providerId !== 'string' || typeof session.baseUrl !== 'string' || typeof session.configBefore !== 'string' || typeof session.configApplied !== 'string' || typeof session.rawBaseValue !== 'string') throw fail('代理恢复备份损坏，未写入任何配置。');
    parseConfig(session.configBefore); parseConfig(session.configApplied);
  }
  if (snapshot.proxyUrl !== undefined && snapshot.proxyUrl !== null && typeof snapshot.proxyUrl !== 'string') throw fail('代理地址备份损坏，未写入任何配置。');
  if (snapshot.route.autoSwitch !== undefined && !object(snapshot.route.autoSwitch)) throw fail('自动切换备份损坏，未写入任何配置。');
  return snapshot;
}

async function readProfiles(file) {
  const raw = await readOptional(file);
  if (raw === null) return { raw, data: { version: 1, profiles: {} } };
  let data;
  try { data = JSON.parse(raw); } catch { throw fail('账号切换备份文件损坏，已暂停切换。请保留备份并修复后重试。'); }
  if (!object(data) || data.version !== 1 || !object(data.profiles) || Object.keys(data.profiles).some(mode => !['official', 'relay'].includes(mode))) throw fail('账号切换备份版本或格式不受支持，已暂停切换。');
  for (const mode of Object.keys(data.profiles)) validateSnapshot(data.profiles[mode], mode);
  return { raw, data };
}

async function accountStatus(store, current) {
  const mode = context(current.info.text).mode;
  let data = { profiles: {} }, reason = blockedReason(current.info.text);
  try { ({ data } = await readProfiles(store.accountProfilesPath)); }
  catch (error) { reason = error.message; }
  return { available: true, mode, officialSaved: !!data.profiles.official, relaySaved: !!data.profiles.relay,
    officialLoggedIn: mode === 'official' ? loggedIn(current.auth) : loggedIn(parseAuth(data.profiles.official?.authText ?? null)), blockedReason: reason };
}

function snapshotOf(current, sessionText, proxyUrl) {
  const route = {};
  for (const field of ['activeName', 'directName', 'autoSwitch']) if (Object.hasOwn(current.state, field)) route[field] = current.state[field];
  let savedProxyUrl = current.proxyInstalled ? proxyUrl : null;
  // A tool restart can change the listening port before the live config has
  // been reapplied. Trust the recorded installation, not just today's port.
  if (!savedProxyUrl && sessionText !== null) {
    let session;
    try { session = JSON.parse(sessionText); } catch { throw fail('代理恢复备份损坏，未写入任何配置。'); }
    const configuredUrl = current.info.baseUrl;
    let local = false;
    try { local = ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(configuredUrl).hostname); } catch { /* A direct remote provider is not a tool proxy. */ }
    if (local && session?.version === 1 && session.providerId === current.info.id && typeof session.configApplied === 'string') {
      const recorded = context(session.configApplied);
      if (sameUrl(recorded.provider?.base_url, configuredUrl)) {
        if (session.configApplied !== current.info.text || sameUrl(session.baseUrl, configuredUrl)) throw fail('本地代理地址已过期，且配置与代理恢复记录不一致。请先恢复或重新接入代理，再切换账号。');
        savedProxyUrl = configuredUrl;
      }
    }
  }
  return { configText: current.info.text, authText: current.authText, sessionText, route,
    proxyUrl: savedProxyUrl };
}

function firstRelay(store, current, entries) {
  const names = [current.state.activeName, current.state.directName];
  const candidates = [...names.map(name => entries.find(entry => entry.name === name)), ...entries].filter(Boolean);
  let selected;
  for (const entry of candidates) { try { selected = store.validateRoute(entry); break; } catch { /* Try another usable saved route. */ } }
  if (!selected) throw fail('尚无可用的中转配置。请先新增一个有效的中转地址和 API Key，再切换到第三方。');
  const template = officialConfig(current.info.text);
  const config = parseConfig(template).config;
  let id = 'codextool_relay', suffix = 1;
  while (config.model_providers?.[id]) id = `codextool_relay_${suffix++}`;
  const stripped = template.replace(/^model_provider = "openai"\nforced_login_method = "chatgpt"\n/, '');
  const configText = `model_provider = ${JSON.stringify(id)}\n${stripped}\n[model_providers.${id}]\nname = "CodexTool Relay"\nbase_url = ${JSON.stringify(selected.baseurl)}\nwire_api = "responses"\nrequires_openai_auth = true\n`;
  return { configText, authText: jsonText({ OPENAI_API_KEY: selected.value }), sessionText: null,
    route: { activeName: selected.name, directName: selected.name }, proxyUrl: null };
}

async function switchAccountMode(store, mode, inspectConfig, patchBase) {
  if (!['official', 'relay'].includes(mode)) throw Object.assign(new Error('账号模式无效，请选择官方账号或第三方中转。'), { status: 400 });
  const current = await store.read();
  const currentMode = context(current.info.text).mode;
  const reason = blockedReason(current.info.text);
  if (reason) throw fail(reason);
  const saved = await readProfiles(store.accountProfilesPath);
  const officialApi = currentMode === 'official' && (current.auth.OPENAI_API_KEY || context(current.info.text).config.forced_login_method === 'api');
  if (mode === currentMode && !(mode === 'official' && officialApi)) return {
    restartRequired: false, message: mode === 'official' ? '当前已是官方账号模式，保留现有登录状态。' : '当前已是第三方中转模式，保留现有配置。', accountMode: mode,
  };
  const sessionText = await readOptional(store.sessionPath);
  const previous = snapshotOf(current, sessionText, store.proxyUrl);
  if (currentMode === 'official' && officialApi) {
    const auth = loggedIn(current.auth) ? { ...current.auth } : {};
    delete auth.OPENAI_API_KEY;
    if (auth.auth_mode === 'apikey' && loggedIn(auth)) auth.auth_mode = 'chatgpt';
    previous.configText = officialConfig(current.info.text); previous.authText = jsonText(auth); previous.sessionText = null;
  }
  validateSnapshot(previous, currentMode);
  const profiles = { ...saved.data.profiles, [currentMode]: previous };
  let target = profiles[mode];
  if (mode === 'official' && mode === currentMode) target = { ...previous, route: {}, proxyUrl: null };
  if (mode === 'official' && !target) target = { configText: officialConfig(current.info.text), authText: jsonText({}), sessionText: null, route: {}, proxyUrl: null };
  if (mode === 'relay' && !target) target = firstRelay(store, current, (await store.keys()).config.keys);
  validateSnapshot(target, mode);
  const targetBlock = blockedReason(target.configText);
  if (targetBlock) throw fail(targetBlock);
  if (mode === 'relay' && parseAuth(target.authText).tokens) throw fail('第三方备份中混入了 ChatGPT 登录令牌，已拒绝恢复，避免将官方凭据用于中转。请修复中转备份后重试。');
  if (mode === 'official' && parseAuth(target.authText).OPENAI_API_KEY) throw fail('官方账号备份包含 API Key，请先修复备份后再切换。');
  // A restarted daemon may bind a new port. Only update a proven saved proxy
  // route, preserving the original direct URL used by the restore action.
  if (mode === 'relay' && target.proxyUrl && !sameUrl(target.proxyUrl, store.proxyUrl)) {
    const info = inspectConfig(target.configText);
    if (!sameUrl(info.baseUrl, target.proxyUrl) || !target.sessionText) throw fail('代理地址备份不完整，无法安全恢复到当前端口。');
    const session = JSON.parse(target.sessionText);
    if (session.providerId !== info.id || session.configApplied !== target.configText) throw fail('代理恢复记录与中转备份不匹配，请检查备份后重试。');
    target = { ...target, configText: patchBase(info, store.proxyUrl), proxyUrl: store.proxyUrl };
    target.sessionText = jsonText({ ...session, configApplied: target.configText });
  }
  profiles[mode] = target;
  const nextState = { ...current.state };
  for (const field of ['activeName', 'directName']) {
    delete nextState[field];
    if (typeof target.route[field] === 'string') nextState[field] = target.route[field];
  }
  const autoSwitch = target.route.autoSwitch || current.state.autoSwitch;
  if (autoSwitch) nextState.autoSwitch = { ...autoSwitch, enabled: false };
  await store.commit([
    { file: store.accountProfilesPath, before: saved.raw, after: jsonText({ version: 1, profiles }) },
    { file: store.authPath, before: current.authText, after: target.authText },
    { file: store.configPath, before: current.info.text, after: target.configText },
    { file: store.sessionPath, before: sessionText, after: target.sessionText },
    { file: store.statePath, before: current.stateText, after: jsonText(nextState) },
  ]);
  return { restartRequired: true, accountMode: mode, message: mode === 'official'
    ? (loggedIn(parseAuth(target.authText)) ? '已恢复官方账号配置和登录状态。请完整退出并重启 Codex。' : '已切换到官方账号模式。请完整退出并重启 Codex，再使用 ChatGPT 账号登录。')
    : '已恢复第三方中转配置和对应凭据。请完整退出并重启 Codex。自动切换保持关闭。' };
}

module.exports = { accountStatus, switchAccountMode, accountMode: text => context(text).mode, officialConfig, blockedReason };
