const state = { mode: 'direct', activeName: null, selectedProxyName: null, proxyInstalled: false, proxyUrl: '', keys: [] };
let viewMode = null;
let busy = false;
let loaded = false;
let feedback = { phase: 'idle', message: '' };
const list = document.querySelector('#route-list');
const listFeedback = document.querySelector('#list-feedback');
const currentRoute = document.querySelector('#current-route');
const currentRouteName = document.querySelector('#current-route-name');
let renderedList = '';
let mutationVersion = 0;
const connection = document.querySelector('#connection');
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
const availability = new RelayAvailability({
  list, select: document.querySelector('#availability-model'), getState: () => state, isDragging: () => Boolean(draggedName),
});

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

function renderControls() {
  // Use the configured route, not a proxy selection that is still awaiting installation.
  const activeName = loaded ? state.activeName : null;
  const activeLabel = loaded ? activeName || '未匹配到中转站' : '状态读取失败';
  currentRoute.dataset.active = String(Boolean(activeName));
  if (currentRouteName.textContent !== activeLabel) currentRouteName.textContent = activeLabel;
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
  document.querySelectorAll('.edit-button').forEach(button => {
    button.disabled = busy || networkBusy || !loaded || state.writeBlocked || !state.editAvailable;
    button.title = state.editAvailable ? '编辑' : '编辑功能需重启中转服务后生效';
  });
  document.querySelectorAll('.drag-handle').forEach(handle => { handle.draggable = !listDisabled; });
  list.setAttribute('aria-busy', String(busy));
  if (loaded && !state.listActionsAvailable) listFeedback.textContent = '排序与置顶需重启中转服务后生效。';
  document.querySelector('#add-form button').disabled = busy || !loaded || state.writeBlocked;
  renderNetwork();
  renderHome();
  renderAppPath();
}

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

function render() {
  document.querySelector('#count').textContent = state.keys.length;
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
  const markup = state.keys.map(entry => {
    const chosen = viewMode === 'proxy' && entry.name === state.selectedProxyName;
    const tag = entry.active ? '配置选中' : chosen ? '待接入' : '';
    return '<article class="route' + (entry.pinned ? ' is-pinned' : '') + '" data-pinned="' + Boolean(entry.pinned) + '" data-name="' + escapeHtml(entry.name) + '"><div class="drag-handle" title="拖动排序" aria-label="拖动排序">⋮⋮</div><div class="route-name"><small>名称</small>' + escapeHtml(entry.name) +
      '</div><div class="route-field"><small>API KEY · BASE URL</small><code>' + escapeHtml(entry.maskedValue) +
      '</code><code class="url">' + escapeHtml(entry.baseurl) + '</code></div><div class="route-actions">' +
      (tag ? '<span class="active-tag">' + tag + '</span>' : '') +
      '<button type="button" class="pin-button' + (entry.pinned ? ' pinned' : '') + '" data-name="' + escapeHtml(entry.name) + '" data-pinned="' + Boolean(entry.pinned) + '" aria-pressed="' + Boolean(entry.pinned) + '" title="' + (entry.pinned ? '取消置顶' : '置顶') + '" aria-label="' + (entry.pinned ? '取消置顶' : '置顶') + '"><span class="pin-icon" aria-hidden="true"></span></button>' +
      '<button type="button" class="edit-button" data-name="' + escapeHtml(entry.name) + '" title="编辑" aria-label="编辑"><span class="edit-icon" aria-hidden="true"></span></button>' +
      '<button class="select-button" data-name="' + escapeHtml(entry.name) + '">切换</button></div><div class="route-availability"></div></article>';
  }).join('');
  // Keep DOM nodes stable during polling, so drag and keyboard focus survive.
  if (markup !== renderedList && !draggedName) { list.innerHTML = markup; renderedList = markup; }
  availability.sync();
  renderControls();
}

async function api(endpoint, payload) {
  const response = await fetch(endpoint, {
    ...(payload === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }),
    signal: AbortSignal.timeout(15000),
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
list.addEventListener('click', async event => {
  const edit = event.target.closest('.edit-button');
  if (edit) {
    if (edit.disabled || busy || networkBusy || draggedName) return;
    const entry = state.keys.find(item => item.name === edit.dataset.name);
    if (!entry) return;
    editing = { originalName: entry.name, revision: entry.revision, focusName: entry.name };
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
    [...list.querySelectorAll('.pin-button')].find(button => button.dataset.name === name)?.focus({ preventScroll: true });
    return;
  }
  const button = event.target.closest('.select-button');
  if (button) await perform('/api/select', { name: button.dataset.name, mode: viewMode });
});
document.querySelector('#edit-cancel').addEventListener('click', () => { if (!editBusy) editDialog.close(); });
editDialog.addEventListener('cancel', event => { if (editBusy) event.preventDefault(); });
editDialog.addEventListener('close', () => {
  const name = editing?.focusName;
  editing = null;
  editForm.reset();
  editForm.elements.value.value = '';
  [...list.querySelectorAll('.edit-button')].find(button => button.dataset.name === name)?.focus({ preventScroll: true });
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
list.addEventListener('dragstart', event => {
  const row = event.target.closest('.route');
  if (!row || busy || networkBusy || !loaded || state.writeBlocked || !state.listActionsAvailable) { event.preventDefault(); return; }
  draggedName = row.dataset.name;
  row.classList.add('dragging');
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/plain', draggedName);
});
list.addEventListener('dragover', event => {
  const row = event.target.closest('.route');
  document.querySelectorAll('.route.drop-target').forEach(item => item.classList.remove('drop-target'));
  if (!row || !draggedName || row.dataset.name === draggedName) return;
  const source = state.keys.find(entry => entry.name === draggedName);
  if (row.dataset.pinned !== String(Boolean(source?.pinned))) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
  row.classList.add('drop-target');
});
list.addEventListener('drop', async event => {
  event.preventDefault();
  const target = event.target.closest('.route');
  if (!target || !draggedName || target.dataset.name === draggedName || busy) return;
  const source = state.keys.find(entry => entry.name === draggedName);
  if (target.dataset.pinned !== String(Boolean(source?.pinned))) return;
  const names = state.keys.map(entry => entry.name);
  const from = names.indexOf(draggedName);
  const to = names.indexOf(target.dataset.name);
  if (from < 0 || to < 0) return;
  names.splice(from, 1);
  names.splice(to, 0, draggedName);
  draggedName = null;
  document.querySelectorAll('.route.dragging,.route.drop-target').forEach(row => row.classList.remove('dragging', 'drop-target'));
  await perform('/api/reorder', { names });
});
list.addEventListener('dragend', () => {
  draggedName = null;
  document.querySelectorAll('.route.dragging,.route.drop-target').forEach(row => row.classList.remove('dragging', 'drop-target'));
});
installButton.addEventListener('click', () => perform('/api/proxy/install', { name: state.selectedProxyName }, true));
restoreButton.addEventListener('click', () => perform('/api/proxy/restore', {}, true));
document.querySelector('#refresh-status').addEventListener('click', load);
document.querySelector('#add-form').addEventListener('submit', async event => {
  event.preventDefault();
  formMessage.textContent = '';
  if (await perform('/api/keys', Object.fromEntries(new FormData(event.target).entries()))) event.target.reset();
});
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
    viewMode = null;
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
