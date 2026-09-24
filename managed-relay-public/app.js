const state = { mode: 'direct', activeName: null, selectedProxyName: null, proxyInstalled: false, proxyUrl: '', keys: [] };
let viewMode = null;
let busy = false;
let loaded = false;
let feedback = { phase: 'idle', message: '' };
const list = document.querySelector('#route-list');
const simpleList = document.querySelector('#simple-route-list');
const routesPanel = document.querySelector('#routes-panel');
const simpleRouteView = document.querySelector('#simple-route-view');
const advancedRouteView = document.querySelector('#advanced-route-view');
const listFeedback = document.querySelector('#list-feedback');
const currentRoute = document.querySelector('#current-route');
const currentRouteName = document.querySelector('#current-route-name');
const addDialog = document.querySelector('#add-dialog');
const addForm = document.querySelector('#add-form');
let search = '';
let statusFilter = 'all';
let routeView = 'simple';
try {
  const savedRouteView = localStorage.getItem('relay-route-view');
  if (savedRouteView === 'advanced' || savedRouteView === 'simple') routeView = savedRouteView;
} catch {}
let draggedProvider = false;
let expanded = {};
try { expanded = JSON.parse(localStorage.getItem('relay-expanded-providers') || '{}') || {}; } catch {}
if (typeof expanded !== 'object' || Array.isArray(expanded)) expanded = {};
function expansionKey(id) { return JSON.stringify([state.home || '', id]); }
function saveExpansion(id, open) {
  expanded[expansionKey(id)] = open;
  try { localStorage.setItem('relay-expanded-providers', JSON.stringify(expanded)); } catch {}
}
let renderedList = '';
let mutationVersion = 0;
const connection = document.querySelector('#service-connection');
const notice = document.querySelector('#notice');
const formMessage = document.querySelector('#form-message');
const installButton = document.querySelector('#install-button');
const restoreButton = document.querySelector('#restore-button');
const installFeedback = document.querySelector('#install-feedback');
let networkDirty = false;
let networkBusy = false;
let draggedName = null;
const networkForm = document.querySelector('#network-form');
const networkResult = document.querySelector('#network-result');
const editDialog = document.querySelector('#edit-dialog');
const editForm = document.querySelector('#edit-form');
const editFeedback = document.querySelector('#edit-feedback');
let editing = null;
let editBusy = false;
const homeForm = document.querySelector('#home-form');
const homeResult = document.querySelector('#home-result');
let homeDirty = false;
const appPathForm = document.querySelector('#app-path-form');
const appPathResult = document.querySelector('#app-path-result');
let appPathDirty = false;
let launchBusy = false;
let cliCwdInitialized = false;
const cliCwd = document.querySelector('#cli-cwd');
const cliCwdHelp = document.querySelector('#cli-cwd-help');
const cliCwdStorageKey = 'relay-cli-cwd';
try {
  const saved = localStorage.getItem(cliCwdStorageKey);
  if (saved?.trim()) { cliCwd.value = saved; cliCwdInitialized = true; }
} catch {
  cliCwdHelp.textContent = '浏览器存储不可用，工作目录只能在本次页面中保留。';
}
cliCwd.addEventListener('input', () => {
  // Protect edits made before the first status response from default backfill.
  cliCwdInitialized = true;
  try {
    if (cliCwd.value.trim()) localStorage.setItem(cliCwdStorageKey, cliCwd.value);
    else localStorage.removeItem(cliCwdStorageKey);
    cliCwdHelp.textContent = cliCwd.value.trim() ? '工作目录已保存到当前浏览器，刷新后保留。' : '已清除保存的目录，下次打开使用默认目录。';
  } catch {
    cliCwdHelp.textContent = '浏览器存储不可用，工作目录只能在本次页面中保留。';
  }
});
const launchFeedback = document.querySelector('#launch-feedback');
const intelligence = new RelayIntelligence({ list: routesPanel, getState: () => state, request: api,
  blocked: () => !loaded || busy || networkBusy || Boolean(draggedName) });
const availability = new RelayAvailability({
  getView: () => routeView,
  list: routesPanel, select: document.querySelector('#availability-model'), getState: () => state, isDragging: () => Boolean(draggedName), onChange: applyAvailabilityFilter,
  mutateBalanceSource: async payload => {
    if (busy || networkBusy || draggedName) throw new Error('请等待当前操作完成。');
    busy = true; mutationVersion++; renderControls();
    try {
      const data = await api('/api/packycode/balance/source', payload);
      Object.assign(state, data.status); loaded = true; render();
    } finally { busy = false; renderControls(); }
  },
  mutateStatusMode: async payload => {
    if (busy || networkBusy || draggedName) throw new Error('请等待当前操作完成。');
    busy = true; mutationVersion++; renderControls();
    try {
      const data = await api('/api/timicc/status/mode', payload);
      Object.assign(state, data.status); loaded = true; render();
    } finally { busy = false; renderControls(); }
  },
  mutateAigoStatusMode: async payload => {
    if (busy || networkBusy || draggedName) throw new Error('请等待当前操作完成。');
    busy = true; mutationVersion++; renderControls();
    try {
      const data = await api('/api/aigo/status/mode', payload);
      Object.assign(state, data.status); loaded = true; render();
    } finally { busy = false; renderControls(); }
  },
  mutateInputStatusMode: async payload => {
    if (busy || networkBusy || draggedName) throw new Error('请等待当前操作完成。');
    busy = true; mutationVersion++; renderControls();
    try {
      const data = await api('/api/input/status/mode', payload);
      Object.assign(state, data.status); loaded = true; render();
    } finally { busy = false; renderControls(); }
  },
});

new AccountBindings({ list: routesPanel, getState: () => state, mutate: async (endpoint, payload) => {
  if (busy || networkBusy || draggedName) throw new Error('请等待当前操作完成。');
  busy = true; mutationVersion++; renderControls();
  try {
    const data = await api(endpoint, payload);
    Object.assign(state, data.status); loaded = true;
    const target = state.keys.find(entry => entry.name === (payload.targetName || payload.name));
    if (target) saveExpansion(RelayGroups.provider(target), true);
    render(); showMessage(data.message, true);
  } finally { busy = false; renderControls(); }
} });

function sourceLabel(source) {
  return ({
    'flyingbird-auto': 'FlyingBird 自动代理',
    'system-http': '系统 HTTP 代理',
    'system-https': '系统 HTTPS 代理',
    'system-socks': '系统 SOCKS 代理',
    'system-pac': '系统 PAC',
    environment: '环境代理',
    direct: 'DIRECT',
    loopback: '本机直连',
    manual: '指定代理',
  })[source] || source || '未知';
}

function diagnosticText(d) {
  return (d.at ? new Date(d.at).toLocaleTimeString() + ' · ' : '') +
    d.provider + ' · ' + (d.route || '出站未确定') + ' · ' + sourceLabel(d.source) + ' · ' +
    (d.reachable ? 'HTTP ' + d.status + (d.status === 200 ? '，已收到上游响应' : '，网络已连接，请检查认证或上游响应')
      : '连接失败：' + d.errorCode + (d.causeCodes?.length ? ' / ' + d.causeCodes.join(', ') : '')) + ' · ' + d.durationMs + 'ms';
}

function renderNetwork() {
  const network = state.network;
  if (network && !networkDirty) {
    networkForm.elements.mode.value = network.mode;
    networkForm.elements.proxyUrl.value = network.proxyUrl || '';
  }
  document.querySelector('#network-proxy-field').hidden = networkForm.elements.mode.value !== 'proxy';
  for (const control of networkForm.elements) control.disabled = !network || networkBusy || busy;
  networkForm.elements.proxyUrl.disabled = !network || networkBusy || busy || networkForm.elements.mode.value !== 'proxy';
  document.querySelector('#network-test').disabled = !network || networkBusy || busy || !state.selectedProxyName || networkDirty;
  document.querySelector('#network-status').textContent = !network
    ? '当前服务尚未加载网络设置功能，请在本轮结束后重启中转服务。'
    : network.error || ('所选中转出站：' + (network.effective || '尚未选择中转') + ' · ' + sourceLabel(network.source || network.mode) +
      (network.flyingbird?.available ? ' · 已发现 FlyingBird：' + network.flyingbird.route : ''));
  if (!networkBusy && !networkResult.textContent && state.lastDiagnostic) networkResult.textContent = diagnosticText(state.lastDiagnostic);
}

function renderHome() {
  const input = homeForm.elements.home;
  // 输入框有未保存内容时不回填，避免轮询覆盖用户正在编辑的路径。
  if (state.home && !homeDirty) input.value = state.home;
  const locked = Boolean(state.homeLocked);
  input.disabled = locked || busy || !loaded;
  homeForm.querySelector('button').disabled = locked || busy || !loaded;
  const source = state.homeSource === 'saved' ? '页面保存，重启服务后仍生效'
    : state.homeSource === 'arg' || state.homeSource === 'argument' ? '启动参数指定，页面不能修改'
      : state.homeSource === 'env' ? 'CODEX_HOME 环境变量指定，页面不能修改'
        : state.homeSource === 'config' ? 'JSON 配置文件，保存会更新该文件'
          : '默认位置，保存后会记住';
  const rows = state.home ? [['当前目录', state.home, true], ['配置来源', source]] : [['目录设置', '尚未读取到目录设置。']];
  if (state.home && state.homeSource === 'config') rows.push(['配置文件', state.configPath || '—', true]);
  else if (state.home && !locked) rows.push(['保存位置', state.settingsPath || '—', true]);
  const html = rows.map(([label, value, isPath]) => `<div><dt>${label}</dt><dd${isPath ? ' class="home-detail-path"' : ''}>${escapeHtml(value)}</dd></div>`).join('');
  const details = document.querySelector('#home-status');
  if (details.innerHTML !== html) details.innerHTML = html;
}

function renderAppPath() {
  if (!appPathDirty) appPathForm.elements.appPath.value = state.codexAppPath || '';
  for (const control of appPathForm.elements) control.disabled = busy || !loaded || Boolean(state.appPathLocked);
  const rows = !loaded ? [['应用路径', '正在读取应用路径。']]
    : state.appPathLocked ? [['配置来源', 'CODEX_APP_PATH 环境变量指定，页面不能修改']]
      : [['配置来源', state.appPathSource === 'config' ? 'JSON 配置文件，保存会更新该文件' : '自动查找 ChatGPT，找不到再查找 Codex'],
        ['保存位置', state.configPath || '—', true]];
  if (loaded && state.codexAppPath) rows.unshift(['当前应用', state.codexAppPath, true]);
  const html = rows.map(([label, value, isPath]) => `<div><dt>${label}</dt><dd${isPath ? ' class="home-detail-path"' : ''}>${escapeHtml(value)}</dd></div>`).join('');
  const details = document.querySelector('#app-path-status');
  if (details.innerHTML !== html) details.innerHTML = html;
}

function escapeHtml(value) { return String(value).replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char])); }

function routeMarkup(entry, accountLabel = '', address = '', keyHint = '') {
  const chosen = viewMode === 'proxy' && entry.name === state.selectedProxyName;
  const tag = entry.name === state.activeName ? '当前使用' : chosen ? '待接入' : '';
  return '<article class="route' + (entry.pinned ? ' is-pinned' : '') + (entry.name === state.activeName ? ' is-active' : '') + '" data-pinned="' + Boolean(entry.pinned) + '" data-name="' + escapeHtml(entry.name) + '"><button type="button" class="drag-handle" title="拖动排序；也可用 Alt + 上下方向键调整" aria-label="调整 ' + escapeHtml(entry.name) + ' 的顺序">⠿</button><div class="route-name" title="' + escapeHtml(entry.name) + '">' + escapeHtml(RelayGroups.routeLabel(entry)) +
    (accountLabel ? '<span class="route-account-label">' + escapeHtml(accountLabel) + '</span>' : '') +
    (address ? '<code class="route-endpoint">' + escapeHtml(address) + '</code>' : '') +
    (keyHint ? '<code class="route-key">API Key · ' + escapeHtml(keyHint) + '</code>' : '') + '</div>' +
    (tag ? '<span class="active-tag">' + tag + '</span>' : '<span></span>') + '<div class="route-actions">' +
    '<button type="button" class="intelligence-button" data-name="' + escapeHtml(entry.name) + '">智力测试</button>' +
    '<button type="button" class="pin-button' + (entry.pinned ? ' pinned' : '') + '" data-name="' + escapeHtml(entry.name) + '" data-pinned="' + Boolean(entry.pinned) + '" aria-pressed="' + Boolean(entry.pinned) + '" title="' + (entry.pinned ? '取消置顶' : '置顶') + '" aria-label="' + (entry.pinned ? '取消置顶' : '置顶') + '"><span class="pin-icon" aria-hidden="true"></span></button>' +
    '<button type="button" class="edit-button" data-name="' + escapeHtml(entry.name) + '" title="编辑" aria-label="编辑"><span class="edit-icon" aria-hidden="true"></span></button>' +
    '<button class="select-button" data-name="' + escapeHtml(entry.name) + '">' + (tag === '当前使用' ? '已选中' : tag === '待接入' ? '已选择' : '切换') + '</button></div><div class="intelligence-result" hidden></div></article>';
}

function simpleRouteMarkup(entry) {
  const chosen = viewMode === 'proxy' && entry.name === state.selectedProxyName;
  const active = entry.name === state.activeName;
  const tag = active ? '当前使用' : chosen ? '待接入' : '';
  const name = escapeHtml(entry.name);
  const provider = escapeHtml(RelayGroups.provider(entry));
  return '<div class="simple-route' + (active ? ' is-active' : '') + '" data-name="' + name + '" data-provider="' + provider + '" role="row">' +
    '<div class="simple-route-alias" role="cell"><strong title="' + name + '">' + name + '</strong><small>' + escapeHtml(RelayGroups.providerLabel(RelayGroups.provider(entry))) + (tag ? ' · ' + tag : '') + '</small></div>' +
    '<div class="simple-availability" role="cell" data-name="' + name + '"><span class="simple-status unknown">读取中…</span></div>' +
    '<div class="simple-balance" role="cell"><span class="simple-muted">—</span></div>' +
    '<div class="simple-subscription" role="cell"><span class="simple-muted">—</span></div>' +
    '<div class="simple-intelligence" role="cell"></div>' +
    '<div class="simple-test-action" role="cell"><button type="button" class="intelligence-button" data-name="' + name + '" aria-label="智力测试：' + name + '">智力测试</button></div>' +
    '<div class="simple-switch-action" role="cell"><button type="button" class="select-button" data-name="' + name + '" aria-label="切换：' + name + '">' + (active ? '已选中' : chosen ? '已选择' : '切换') + '</button></div></div>';
}

function renderSimpleList() {
  const entries = state.keys.filter(entry => (entry.name + ' ' + entry.baseurl).toLowerCase().includes(search));
  const selectedName = viewMode === 'proxy' ? state.selectedProxyName : state.activeName;
  const selected = entries.find(entry => entry.name === selectedName);
  const ordered = selected ? [selected, ...entries.filter(entry => entry !== selected)] : entries;
  const simpleMarkup = ordered.map(simpleRouteMarkup).join('');
  if (simpleMarkup !== simpleList._markup && !draggedName) { simpleList.innerHTML = simpleMarkup; simpleList._markup = simpleMarkup; }
  const empty = document.querySelector('#simple-route-empty');
  empty.hidden = entries.length > 0;
  simpleList.parentElement.hidden = !entries.length;
  empty.querySelector('strong').textContent = !loaded ? '正在读取中转配置…' : state.keys.length ? '没有匹配的中转' : '还没有中转配置';
  empty.querySelector('p').textContent = !loaded ? '请稍候。' : state.keys.length ? '试试其他名称或地址。' : '点击右上角「新增中转」，添加第一个请求入口。';
}

function renderRouteViews() {
  const simple = routeView === 'simple';
  simpleRouteView.hidden = !simple;
  advancedRouteView.hidden = simple;
  document.querySelectorAll('.route-view-tab').forEach(button => {
    const selected = button.dataset.routeView === routeView;
    button.setAttribute('aria-selected', String(selected));
    button.tabIndex = selected ? 0 : -1;
  });
}

function groupMarkup(group, index) {
  const open = Boolean(search || expanded[expansionKey(group.id)]);
  const visible = open ? group.entries : group.entries.slice(0, 1);
  const accounts = [...group.accounts.values()];
  const active = group.entries.find(entry => entry.name === state.activeName);
  const id = 'provider-entries-' + index;
  const host = RelayGroups.providerLabel(group.id);
  const krill = group.id === 'krill';
  const endpoints = [...new Set(group.entries.map(RelayGroups.endpoint))];
  const accountLabel = items => {
    if (items[0].accountBindingId && items[0].boundAccountCount > 1) return '共用账号';
    if (!krill) return accounts.length > 1 ? '账号 ' + (accounts.findIndex(account => account[0].accountId === items[0].accountId) + 1) : '中转账号';
    const address = RelayGroups.endpoint(items[0]);
    const peers = accounts.filter(account => RelayGroups.endpoint(account[0]) === address);
    return '线路 ' + (endpoints.indexOf(address) + 1) + (peers.length > 1 ? ' · 账号 ' + (peers.indexOf(items) + 1) : '');
  };
  // Balance source and pool choice belong to each configuration, even with a shared login.
  const displayAccounts = accounts.flatMap(items => ['packycode', 'input', 'timicc', 'aigo'].includes(items[0].merchantId) ? items.map(entry => [entry]) : [items]);
  const accountRows = displayAccounts.filter(items => items.some(entry => visible.includes(entry))).map(items => {
    const entry = items[0];
    const shared = entry.accountBindingId && entry.boundAccountCount > 1;
    const routes = items.filter(item => visible.includes(item)).map(item => routeMarkup(item,
      krill ? '线路 ' + (endpoints.indexOf(RelayGroups.endpoint(item)) + 1) : accounts.length > 1 ? accountLabel(items) : '',
      krill || endpoints.length > 1 ? RelayGroups.endpoint(item) : '', shared ? item.maskedValue : '')).join('');
    const canBind = entry.accountBindingId || state.keys.some(other => other.merchantId === entry.merchantId && other.accountId !== entry.accountId);
    const bindings = canBind ? '<button class="account-bind-button" type="button"' + (!state.accountBindingAvailable ? ' disabled title="重启管理服务后可设置账号绑定"' : '') + '>' + (entry.accountBindingId ? '管理绑定' : '设为同一账号') + '</button>' : '';
    return '<section class="provider-account" data-name="' + escapeHtml(entry.name) + '" data-account-id="' + escapeHtml(entry.accountId || '') + '"><div class="account-routes">' + routes + '</div><div class="account-summary"><div class="account-heading"><strong>' + escapeHtml(accountLabel(items)) + '</strong>' +
      (shared ? '<span class="binding-tag">' + entry.boundAccountCount + ' 个账号已绑定</span>' : '<code>' + escapeHtml(entry.maskedValue) + '</code>') +
      (items.length > 1 ? '<span>' + items.length + ' 个配置共用</span>' : '') + '<span class="account-tools">' + bindings + '<span class="account-auth"></span></span></div>' +
      (entry.accountBindingId ? '<p class="account-source">共享信息来源：' + escapeHtml(entry.accountSourceName) + '</p>' : '') +
      (entry.merchantId === 'packycode' ? '<div class="account-balance-source"></div>' : '') + '<div class="account-data"></div>' +
      (entry.merchantId === 'timicc' ? '<div class="account-status-mode"></div><div class="account-availability" data-name="' + escapeHtml(entry.name) + '"></div>' : '') +
      (entry.merchantId === 'aigo' ? '<div class="aigo-status-mode"></div><div class="account-availability" data-name="' + escapeHtml(entry.name) + '"></div>' : '') +
      (entry.merchantId === 'input' ? '<div class="input-status-mode"></div><div class="account-availability" data-name="' + escapeHtml(entry.name) + '"></div>' : '') + '</div></section>';
  }).join('');
  return '<section class="provider-card' + (active ? ' has-active' : '') + '" data-provider="' + escapeHtml(group.id) + '" data-name="' + escapeHtml(group.entries[0].name) + '"><header class="provider-heading"><button type="button" class="drag-handle provider-drag" title="拖动中转商排序；Alt + 上下方向键调整" aria-label="调整中转商 ' + escapeHtml(host) + ' 的顺序">⠿</button><span class="provider-avatar" aria-hidden="true">' + escapeHtml(host[0].toUpperCase()) + '</span><div class="provider-identity"><h3>' + escapeHtml(host) + '</h3><code>' + escapeHtml(krill ? endpoints.length + ' 条线路 · 按 Base URL 区分' : group.id.startsWith('merchant:') ? endpoints.length + ' 个接口地址' : group.id) + '</code></div><div class="provider-labels">' + (group.entries.some(entry => entry.pinned) ? '<span class="provider-pin">已置顶</span>' : '') + (active ? '<span class="active-tag">使用中' + (!visible.includes(active) ? ' · ' + escapeHtml(active.name) : '') + '</span>' : '') + '<span>' + group.entries.length + ' 个配置</span></div>' + (group.entries.length > 1 ? '<button type="button" class="group-toggle" data-provider="' + escapeHtml(group.id) + '" aria-expanded="' + open + '" aria-controls="' + id + '">' + (open ? '收起' : '展开全部') + '<span aria-hidden="true">' + (open ? '⌃' : '⌄') + '</span></button>' : '') + '</header>' + (['input', 'timicc', 'aigo'].includes(group.entries[0].merchantId) ? '' : '<div class="provider-availability" data-name="' + escapeHtml(group.entries[0].name) + '"></div>') + '<div id="' + id + '" class="provider-accounts">' + accountRows + '</div></section>';
}

function renderCurrentRoute() {
  const entry = loaded ? state.keys.find(item => item.name === state.activeName) : null;
  currentRoute.dataset.active = String(Boolean(entry));
  currentRouteName.disabled = !entry;
  currentRouteName.textContent = entry?.name || (loaded ? '尚未选择中转' : '正在读取…');
  document.querySelector('#current-route-mode').textContent = state.proxyInstalled ? '本地代理 · 即时切换' : '直接配置 · 换站需重启 Codex';
}

function renderControls() {
  intelligence.sync();
  renderCurrentRoute();
  installButton.disabled = busy || !loaded || state.writeBlocked || !state.selectedProxyName;
  restoreButton.disabled = busy || !loaded || state.writeBlocked || !state.proxyInstalled;
  installButton.hidden = viewMode !== 'proxy';
  installButton.setAttribute('aria-busy', String(busy));
  installButton.textContent = busy ? '正在处理…' : state.proxyInstalled ? '重新接入本地代理' : '接入本地代理';
  installFeedback.className = 'install-feedback ' + feedback.phase;
  installFeedback.textContent = feedback.message || (state.writeBlocked
    ? '检测到未完成的配置写入，已暂停写入。'
    : state.proxyInstalled
      ? 'Codex 配置已指向代理；是否已重启加载，请结合实际请求记录确认。'
      : 'Codex 当前配置为直连。');
  document.querySelectorAll('.mode-button').forEach(button => { button.disabled = busy || !loaded || state.writeBlocked; });
  document.querySelectorAll('.select-button').forEach(button => {
    const chosen = viewMode === 'proxy' ? state.selectedProxyName : state.activeName;
    button.disabled = busy || state.writeBlocked || button.dataset.name === chosen;
  });
  const listDisabled = busy || networkBusy || !loaded || state.writeBlocked || !state.listActionsAvailable;
  document.querySelectorAll('.pin-button').forEach(button => { button.disabled = listDisabled; });
  document.querySelectorAll('.account-bind-button').forEach(button => { button.disabled = listDisabled || !state.accountBindingAvailable; });
  document.querySelectorAll('.edit-button').forEach(button => {
    button.disabled = busy || networkBusy || !loaded || state.writeBlocked || !state.editAvailable;
    button.title = state.editAvailable ? '编辑' : '编辑功能需重启中转服务后生效';
  });
  document.querySelectorAll('.drag-handle').forEach(handle => { handle.draggable = !listDisabled && !search; handle.disabled = listDisabled || Boolean(search); });
  list.setAttribute('aria-busy', String(busy));
  if (loaded && !state.listActionsAvailable) listFeedback.textContent = '排序与置顶需重启中转服务后生效。';
  document.querySelector('#add-open').disabled = busy || !loaded || state.writeBlocked;
  for (const control of addForm.elements) control.disabled = busy || !loaded || state.writeBlocked;
  renderNetwork();
  renderHome();
  renderAppPath();
  renderLaunch();
}

function renderLaunch() {
  const launch = state.launch;
  if (!cliCwdInitialized && launch?.defaultCwd) { cliCwd.value = launch.defaultCwd; cliCwdInitialized = true; }
  const ready = loaded && launch?.available && state.proxyInstalled && !state.writeBlocked && state.selectedProxyName;
  document.querySelectorAll('[data-launch]').forEach(button => {
    button.disabled = !ready || busy || networkBusy || launchBusy || launch?.busy ||
      (button.dataset.launch === 'cli' && ['pending', 'running'].includes(launch?.cli?.state));
    button.setAttribute('aria-busy', String(launchBusy));
  });
  cliCwd.disabled = busy || launchBusy;
  const status = document.querySelector('#launch-status');
  status.textContent = !loaded ? '无法连接管理服务，请确认服务仍在运行。'
    : !launch ? '启动功能需要重启中转服务后生效。'
      : !launch.available ? '页面启动支持 macOS 和 Windows。'
        : !state.proxyInstalled ? '请先在「运行与连接」中接入本地代理。'
          : state.writeBlocked ? '请先处理未完成的配置写入。'
            : !state.selectedProxyName ? '请先选择一个中转站。'
              : launch.cli?.state === 'pending' ? '正在等待终端中的 CLI 启动…'
                : launch.cli?.state === 'running' ? '本工具启动的 CLI 正在运行，请使用已有终端。'
                  : '已接入本地代理，可以启动。';
  if (!launchBusy && launch?.cli?.state === 'failed') status.textContent = launch.cli.message;
  if (!launchBusy && ready && launch?.cli?.state === 'exited') status.textContent = 'CLI 已退出，可以再次启动。';
}

async function startClient(target) {
  if (busy || launchBusy) return;
  busy = true; launchBusy = true; mutationVersion++;
  launchFeedback.className = '';
  launchFeedback.textContent = target === 'app' ? '正在检查 App 并请求启动…' : '正在打开终端…';
  renderControls();
  try {
    const result = await api('/api/launch', { target, ...(target === 'cli' ? { cwd: cliCwd.value } : {}) });
    Object.assign(state, result.status);
    launchFeedback.textContent = result.message;
    launchFeedback.className = 'success';
    render();
  } catch (error) { launchFeedback.textContent = errorMessage(error); launchFeedback.className = 'error'; }
  finally { busy = false; launchBusy = false; renderControls(); }
}

document.querySelector('#launch-app').addEventListener('click', () => startClient('app'));
document.querySelector('#launch-cli-form').addEventListener('submit', event => { event.preventDefault(); startClient('cli'); });

function showFeedback(phase, message) {
  feedback = { phase, message };
  renderControls();
  installFeedback.scrollIntoView({ block: 'nearest', behavior: 'instant' });
}

function showMessage(text, success = false) {
  notice.textContent = text;
  notice.hidden = !text;
  notice.className = success ? 'notice success' : 'notice';
  notice.scrollIntoView({ block: 'nearest', behavior: 'instant' });
}

function applyAvailabilityFilter() {
  if (draggedName) return;
  const counts = { all: 0, available: 0, unavailable: 0 };
  let visible = 0, configurations = 0;
  const groups = new Map(RelayGroups.group(state.keys).map(group => [group.id, group]));
  for (const card of list.querySelectorAll('.provider-card')) {
    const group = groups.get(card.dataset.provider);
    const representative = ['input', 'timicc', 'aigo'].includes(group?.entries[0]?.merchantId) ? group.entries.find(entry => entry.name === state.activeName) || group.entries[0] : group?.entries[0];
    const category = availability.filterFor(representative);
    counts.all++;
    if (category) counts[category]++;
    card.hidden = statusFilter !== 'all' && category !== statusFilter;
    if (!card.hidden) { visible++; configurations += group?.entries.length || 0; }
  }
  document.querySelectorAll('[data-status-filter]').forEach(button => {
    button.setAttribute('aria-pressed', String(button.dataset.statusFilter === statusFilter));
  });
  document.querySelectorAll('[data-filter-count]').forEach(badge => { badge.textContent = counts[badge.dataset.filterCount]; });
  document.querySelector('#count').textContent = routeView === 'simple' ? simpleList.children.length + ' 个配置' : visible + ' 个中转商 / ' + configurations + ' 个配置';
  const empty = document.querySelector('#route-empty');
  empty.hidden = visible > 0;
  let title, detail;
  if (!state.keys.length) {
    title = loaded ? '还没有中转配置' : '正在读取中转配置…';
    detail = loaded ? '点击右上角「新增中转」，添加第一个请求入口。' : '请稍候。';
  } else if (!counts.all) {
    title = '没有匹配的中转'; detail = '试试其他名称或地址。';
  } else {
    title = statusFilter === 'available' ? '没有当前可用的中转' : '没有当前不可用的中转';
    detail = availability.request ? '正在读取所选模型的检测状态…' : '无检测记录的中转只在「全部」中显示，可切换筛选或模型查看。';
  }
  const heading = empty.querySelector('strong'), description = empty.querySelector('p');
  if (heading.textContent !== title) heading.textContent = title;
  if (description.textContent !== detail) description.textContent = detail;
}

const automatic = new AutoSwitchControls({ getState: () => state, request: api, mutate: async (endpoint, payload) => {
  if (busy || networkBusy || launchBusy) throw new Error('请等待当前操作完成。');
  busy = true; mutationVersion++; renderControls();
  try {
    const data = await api(endpoint, payload);
    Object.assign(state, data.status); loaded = true; render();
    return data;
  } finally { busy = false; renderControls(); }
} });

function render() {
  const groups = RelayGroups.group(state.keys);
  renderSimpleList();
  renderRouteViews();
  document.querySelector('#nav-count').textContent = groups.length;
  document.querySelector('#proxy-url').textContent = state.proxyUrl || '—';
  document.querySelector('#mode-description').textContent = state.proxyInstalled
    ? '当前配置：本地代理。接入与恢复直连后需重启一次 Codex。'
    : viewMode === 'proxy' ? '当前配置：直连，待接入本地代理。' : '当前配置：直连，换站后需重启 Codex。';
  document.querySelector('#provider-identity').textContent = 'Codex provider：' + (state.providerName || '—');
  const last = state.lastRequest;
  document.querySelector('#last-request').textContent = last
    ? '最近代理请求：' + last.provider + ' · HTTP ' + last.status + ' · ' + new Date(last.at).toLocaleTimeString() +
      (last.outcome === 'failed' ? ' · 请求失败' : last.outcome === 'cancelled' ? ' · 客户端已断开' : '') +
      (last.upstreamStatus ? ' · 上游 HTTP ' + last.upstreamStatus : '') +
      (last.responseBytes != null ? ' · 已收到 ' + last.responseBytes + ' 字节' : '') +
      (last.outbound ? ' · ' + last.outbound : '') + (last.errorCode ? ' · ' + last.errorCode : '') + (last.phase ? ' · ' + last.phase : '')
    : '本次服务启动后尚未收到代理请求。';
  document.querySelectorAll('.mode-button').forEach(button => {
    button.classList.toggle('active', button.dataset.mode === viewMode);
    button.setAttribute('aria-pressed', String(button.dataset.mode === viewMode));
  });
  const matches = groups.filter(group => group.entries.some(entry => (entry.name + ' ' + entry.baseurl).toLowerCase().includes(search)));
  const markup = matches.map(groupMarkup).join('');
  // Keep DOM nodes stable during polling, so drag and keyboard focus survive.
  if (markup !== renderedList && !draggedName) { list.innerHTML = markup; renderedList = markup; }
  renderControls();
  availability.sync();
  automatic.sync();
}

async function api(endpoint, payload) {
  const response = await fetch(endpoint, {
    ...(payload === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }),
    signal: AbortSignal.timeout(endpoint === '/api/launch' ? 60000 : 15000),
  });
  const data = await response.json().catch(() => { throw new Error('服务返回异常，操作结果尚未确认，请刷新检查。'); });
  if (!response.ok) throw new Error(data.error || '操作失败。');
  return data;
}

function errorMessage(error) {
  return error.name === 'TimeoutError' ? '请求超时，操作结果尚未确认，请刷新检查。'
    : error instanceof TypeError ? '无法连接本地服务，请确认服务仍在运行。' : error.message;
}

async function load() {
  if (busy || networkBusy || draggedName) return;
  const version = mutationVersion;
  try {
    const current = await api('/api/status');
    if (version !== mutationVersion || busy || networkBusy || draggedName) return;
    Object.assign(state, current);
    loaded = true;
    viewMode ??= state.mode;
    connection.className = 'connection ready';
    connection.innerHTML = '<span></span>服务已启动';
    render();
  } catch (error) {
    if (version !== mutationVersion || busy || networkBusy || draggedName) return;
    loaded = false;
    connection.className = 'connection';
    connection.innerHTML = '<span></span>服务异常';
    renderControls();
    showMessage(errorMessage(error));
  }
}

async function perform(endpoint, payload, localFeedback = false) {
  if (busy) return false;
  busy = true;
  mutationVersion++;
  const listAction = endpoint === '/api/pin' || endpoint === '/api/reorder';
  if (listAction) listFeedback.textContent = '正在保存…';
  if (localFeedback) showFeedback('pending', '正在更新 Codex 配置，请稍候…');
  else renderControls();
  try {
    const data = await api(endpoint, payload);
    Object.assign(state, data.status);
    loaded = true;
    if (endpoint === '/api/proxy/restore') viewMode = 'direct';
    if (endpoint === '/api/proxy/install') viewMode = 'proxy';
    render();
    if (localFeedback) showFeedback('success', data.message);
    else if (listAction) listFeedback.textContent = data.message;
    else showMessage(data.message, true);
    return true;
  } catch (error) {
    if (localFeedback) showFeedback('error', errorMessage(error));
    else if (listAction) listFeedback.textContent = errorMessage(error);
    else showMessage(errorMessage(error));
    return false;
  } finally { busy = false; renderControls(); }
}

document.querySelectorAll('.mode-button').forEach(button => button.addEventListener('click', async () => {
  if (busy) return;
  if (button.dataset.mode === 'direct' && state.proxyInstalled) {
    await perform('/api/proxy/restore', {}, true);
  } else {
    viewMode = button.dataset.mode;
    feedback = { phase: 'idle', message: '' };
    render();
  }
}));
document.querySelectorAll('.route-view-tab').forEach(button => button.addEventListener('click', () => {
  routeView = button.dataset.routeView === 'advanced' ? 'advanced' : 'simple';
  try { localStorage.setItem('relay-route-view', routeView); } catch {}
  renderRouteViews();
  applyAvailabilityFilter();
  availability.sync();
  if (location.hash !== '#routes/' + routeView) location.hash = 'routes/' + routeView;
}));
document.querySelector('.route-view-tabs').addEventListener('keydown', event => {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const tabs = [...document.querySelectorAll('.route-view-tab')];
  const index = event.key === 'Home' ? 0 : event.key === 'End' ? 1 : routeView === 'simple' ? 1 : 0;
  tabs[index].click(); tabs[index].focus();
});
routesPanel.addEventListener('click', async event => {
  const focusRoot = list;
  const toggle = event.target.closest('.group-toggle');
  if (toggle) {
    saveExpansion(toggle.dataset.provider, toggle.getAttribute('aria-expanded') !== 'true');
    search = ''; document.querySelector('#route-search').value = ''; render();
    [...list.querySelectorAll('.group-toggle')].find(button => button.dataset.provider === toggle.dataset.provider)?.focus({ preventScroll: true });
    return;
  }
  const edit = event.target.closest('.edit-button');
  if (edit) {
    if (edit.disabled || busy || networkBusy || draggedName) return;
    const entry = state.keys.find(item => item.name === edit.dataset.name);
    if (!entry) return;
    editing = { originalName: entry.name, revision: entry.revision, focusName: entry.name, focusRoot };
    editForm.reset();
    editForm.elements.name.value = entry.name;
    editForm.elements.baseurl.value = entry.baseurl;
    editFeedback.textContent = '';
    editDialog.showModal();
    return;
  }
  const pin = event.target.closest('.pin-button');
  if (pin) {
    if (pin.disabled || networkBusy || draggedName) return;
    const name = pin.dataset.name;
    await perform('/api/pin', { name, pinned: pin.dataset.pinned !== 'true' });
    [...focusRoot.querySelectorAll('.pin-button')].find(button => button.dataset.name === name)?.focus({ preventScroll: true });
    return;
  }
  const button = event.target.closest('.select-button');
  if (button) await perform('/api/select', { name: button.dataset.name, mode: viewMode });
});
document.querySelector('#edit-cancel').addEventListener('click', () => { if (!editBusy) editDialog.close(); });
editDialog.addEventListener('cancel', event => { if (editBusy) event.preventDefault(); });
editDialog.addEventListener('close', () => {
  const name = editing?.focusName;
  const focusRoot = editing?.focusRoot || list;
  editing = null;
  editForm.reset();
  editForm.elements.value.value = '';
  [...focusRoot.querySelectorAll('.edit-button')].find(button => button.dataset.name === name)?.focus({ preventScroll: true });
});
editForm.addEventListener('submit', async event => {
  event.preventDefault();
  if (!editing || busy || editBusy) return;
  const payload = { originalName: editing.originalName, revision: editing.revision, ...Object.fromEntries(new FormData(editForm)) };
  editBusy = true;
  busy = true;
  mutationVersion++;
  for (const control of editForm.elements) control.disabled = true;
  editForm.setAttribute('aria-busy', 'true');
  editFeedback.textContent = '正在保存…';
  renderControls();
  try {
    const data = await api('/api/keys/edit', payload);
    Object.assign(state, data.status);
    loaded = true;
    editing.focusName = payload.name.trim();
    render();
    listFeedback.textContent = data.message;
    editDialog.close();
  } catch (error) { editFeedback.textContent = errorMessage(error); }
  finally {
    editBusy = false;
    busy = false;
    for (const control of editForm.elements) control.disabled = false;
    editForm.setAttribute('aria-busy', 'false');
    renderControls();
  }
});
function dragTarget(event) { return event.target.closest(draggedProvider ? '.provider-card' : '.route') || (!draggedProvider && event.target.closest('.provider-account')) || event.target.closest('.provider-card'); }
function clearDrag() {
  draggedName = null; draggedProvider = false;
  list.querySelectorAll('.dragging,.drop-target').forEach(row => row.classList.remove('dragging', 'drop-target'));
}
routesPanel.addEventListener('dragstart', event => {
  const handle = event.target.closest('.drag-handle');
  const row = handle?.closest('.route') || handle?.closest('.provider-card');
  if (!row || handle.disabled || busy || networkBusy) { event.preventDefault(); return; }
  draggedProvider = handle.classList.contains('provider-drag');
  draggedName = row.dataset.name;
  row.classList.add('dragging');
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/plain', draggedName);
});
list.addEventListener('dragover', event => {
  list.querySelectorAll('.drop-target').forEach(item => item.classList.remove('drop-target'));
  const row = dragTarget(event);
  if (!row || !draggedName || !RelayGroups.reorder(state.keys, draggedName, row.dataset.name, draggedProvider)) return;
  event.preventDefault(); event.dataTransfer.dropEffect = 'move'; row.classList.add('drop-target');
});
list.addEventListener('drop', async event => {
  event.preventDefault();
  const row = dragTarget(event);
  const names = row && draggedName && RelayGroups.reorder(state.keys, draggedName, row.dataset.name, draggedProvider);
  clearDrag();
  if (names && !busy) await perform('/api/reorder', { names });
});
routesPanel.addEventListener('dragend', () => { clearDrag(); availability.paint(); });
list.addEventListener('keydown', async event => {
  const handle = event.target.closest('.drag-handle');
  if (!handle || handle.disabled || !event.altKey || !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
  event.preventDefault();
  const provider = handle.classList.contains('provider-drag');
  const row = handle.closest(provider ? '.provider-card' : '.route');
  const rows = [...list.querySelectorAll(provider ? '.provider-card' : '.route')].filter(row => !row.closest('.provider-card').hidden);
  const target = rows[rows.indexOf(row) + (event.key === 'ArrowUp' ? -1 : 1)];
  const names = target && RelayGroups.reorder(state.keys, row.dataset.name, target.dataset.name, provider);
  if (names) {
    await perform('/api/reorder', { names });
    [...list.querySelectorAll(provider ? '.provider-card' : '.route')].find(item => item.dataset.name === row.dataset.name)?.querySelector('.drag-handle').focus({ preventScroll: true });
  }
});
installButton.addEventListener('click', () => perform('/api/proxy/install', { name: state.selectedProxyName }, true));
restoreButton.addEventListener('click', () => perform('/api/proxy/restore', {}, true));
document.querySelector('#refresh-status').addEventListener('click', load);
document.querySelector('#add-open').addEventListener('click', () => { addForm.reset(); formMessage.textContent = ''; addDialog.showModal(); });
document.querySelector('#add-cancel').addEventListener('click', () => { if (!busy) addDialog.close(); });
addDialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
addDialog.addEventListener('close', () => { addForm.reset(); document.querySelector('#add-open').focus(); });
addForm.addEventListener('submit', async event => {
  event.preventDefault();
  if (busy) return;
  const payload = Object.fromEntries(new FormData(addForm));
  busy = true; mutationVersion++; renderControls(); formMessage.textContent = '正在保存…';
  try {
    const data = await api('/api/keys', payload);
    Object.assign(state, data.status); loaded = true; render(); addDialog.close();
    showMessage(data.message, true);
  } catch (error) { formMessage.textContent = errorMessage(error); }
  finally { busy = false; renderControls(); }
});
document.querySelectorAll('[data-status-filter]').forEach(button => button.addEventListener('click', () => {
  statusFilter = button.dataset.statusFilter; applyAvailabilityFilter();
}));
document.querySelector('#route-search').addEventListener('input', event => { search = event.target.value.trim().toLowerCase(); render(); });
currentRouteName.addEventListener('click', () => {
  const entry = state.keys.find(item => item.name === state.activeName);
  if (!entry) return;
  search = ''; statusFilter = 'all'; document.querySelector('#route-search').value = '';
  saveExpansion(RelayGroups.provider(entry), true); render();
  const root = routeView === 'simple' ? simpleList : list;
  const row = [...root.querySelectorAll('.route, .simple-route')].find(row => row.dataset.name === entry.name);
  row?.scrollIntoView({ block: 'center', behavior: 'smooth' }); row?.querySelector('.edit-button, .intelligence-button')?.focus({ preventScroll: true });
});
let currentPage = null;
const pageScroll = new Map();
function navigate() {
  const names = { routes: '中转站', connection: '运行与连接', settings: '必要设置' };
  const [requestedPage, requestedView] = location.hash.slice(1).split('/');
  const page = Object.hasOwn(names, requestedPage) ? requestedPage : 'routes';
  if (page === 'routes' && ['simple', 'advanced'].includes(requestedView)) {
    routeView = requestedView;
    try { localStorage.setItem('relay-route-view', routeView); } catch {}
    renderRouteViews(); applyAvailabilityFilter(); availability.sync();
  }
  const content = document.querySelector('main');
  if (currentPage && currentPage !== page) pageScroll.set(currentPage, content.scrollTop);
  document.querySelectorAll('.page').forEach(panel => { panel.hidden = panel.id !== 'page-' + page; });
  document.querySelectorAll('nav [data-page]').forEach(link => {
    if (link.dataset.page === page) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
  });
  document.querySelector('#page-breadcrumb').textContent = names[page];
  if (currentPage !== page) content.scrollTop = pageScroll.get(page) || 0;
  currentPage = page;
}
window.addEventListener('hashchange', navigate);
navigate();
networkForm.addEventListener('input', () => { networkDirty = true; renderNetwork(); });
networkForm.addEventListener('submit', async event => {
  event.preventDefault();
  if (networkBusy) return;
  const mode = networkForm.elements.mode.value;
  const payload = { mode, proxyUrl: mode === 'proxy' ? networkForm.elements.proxyUrl.value : '' };
  networkBusy = true;
  renderNetwork();
  networkResult.textContent = '正在保存出站设置…';
  try {
    const data = await api('/api/network', payload);
    Object.assign(state, data.status);
    networkDirty = false;
    networkResult.textContent = data.message;
    render();
  } catch (error) { networkResult.textContent = errorMessage(error); }
  finally { networkBusy = false; renderNetwork(); }
});
document.querySelector('#network-test').addEventListener('click', async () => {
  if (networkBusy || !state.selectedProxyName) return;
  networkBusy = true;
  renderNetwork();
  networkResult.textContent = '正在检查所选中转的模型列表连接…';
  try {
    const data = await api('/api/network/test', { name: state.selectedProxyName });
    Object.assign(state, data.status);
    networkResult.textContent = diagnosticText(data.diagnostic);
    render();
  } catch (error) { networkResult.textContent = errorMessage(error); }
  finally { networkBusy = false; renderNetwork(); }
});
homeForm.addEventListener('input', () => { homeDirty = true; });
homeForm.addEventListener('submit', async event => {
  event.preventDefault();
  if (busy) return;
  const target = homeForm.elements.home.value;
  busy = true;
  mutationVersion++;
  homeResult.className = '';
  homeResult.textContent = '正在切换目录…';
  renderControls();
  try {
    const data = await api('/api/home', { home: target });
    Object.assign(state, data.status);
    loaded = true;
    // 目录变了：运行方式、列表、出站设置和反馈都要按新目录重算。
    homeDirty = false;
    networkDirty = false;
    viewMode = state.mode;
    draggedName = null;
    renderedList = '';
    feedback = { phase: 'idle', message: '' };
    homeResult.className = 'success';
    homeResult.textContent = data.message;
    render();
  } catch (error) {
    homeResult.className = 'error';
    homeResult.textContent = errorMessage(error);
  } finally { busy = false; renderControls(); }
});
appPathForm.addEventListener('input', () => { appPathDirty = true; });
appPathForm.addEventListener('submit', async event => {
  event.preventDefault();
  if (busy || !loaded || state.appPathLocked) return;
  const target = appPathForm.elements.appPath.value;
  busy = true;
  mutationVersion++;
  appPathResult.className = '';
  appPathResult.textContent = '正在保存应用路径…';
  renderControls();
  try {
    const data = await api('/api/app-path', { appPath: target });
    Object.assign(state, data.status);
    appPathDirty = false;
    appPathResult.className = 'success';
    appPathResult.textContent = data.message;
    render();
  } catch (error) {
    appPathResult.className = 'error';
    appPathResult.textContent = errorMessage(error);
  } finally { busy = false; renderControls(); }
});
load();
setInterval(() => { if (!document.hidden && loaded) load(); }, 5000);
