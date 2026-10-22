const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../../managed-relay-public/app.js'), 'utf8');
const functions = ['officialMode', 'officialConnectionText', 'renderOfficialNetwork', 'renderAccountMode', 'renderCurrentRoute', 'renderControls', 'renderLaunch']
  .map(name => {
    const start = source.indexOf('function ' + name + '(');
    assert.ok(start >= 0, name + ' is present');
    return source.slice(start, source.indexOf('\n}', start) + 2);
  }).join('\n');

function setup(accountSwitch) {
  const elements = new Map();
  function element(selector) {
    if (!elements.has(selector)) elements.set(selector, {
      textContent: '', hidden: false, disabled: false, title: '', dataset: {}, attributes: {}, elements: [],
      classList: { toggle() {} }, setAttribute(name, value) { this.attributes[name] = value; },
    });
    return elements.get(selector);
  }
  const groups = {
    '[data-account-mode]': ['official', 'relay'].map(mode => Object.assign(element('account-' + mode), { dataset: { accountMode: mode } })),
    '[data-launch]': ['app', 'cli'].map(target => Object.assign(element('launch-' + target), { dataset: { launch: target } })),
    '[data-official-network]': ['auto', 'wifi'].map(mode => Object.assign(element('official-network-' + mode), { dataset: { officialNetwork: mode } })),
    '.mode-button': [element('mode-direct'), element('mode-proxy')],
    '.select-button': [Object.assign(element('select'), { dataset: { name: 'backup' } })],
    '.pin-button': [element('pin')], '.account-bind-button': [element('bind')],
    '.edit-button': [element('edit')], '.drag-handle': [element('drag')],
  };
  const state = {
    accountSwitch, home: '/fixture', officialNetwork: { mode: 'auto', source: 'system', label: '当前使用设备代理', proxyUrl: 'http://127.0.0.1:7892' }, keys: [{ name: 'relay' }], activeName: 'relay', selectedProxyName: 'relay',
    proxyInstalled: false, launch: { available: true }, writeBlocked: false,
    listActionsAvailable: true, editAvailable: true, accountBindingAvailable: true,
  };
  const context = {
    state, loaded: true, busy: false, networkBusy: false, launchBusy: false, cliCwdInitialized: true,
    viewMode: 'proxy', search: '', feedback: { phase: 'idle', message: '' }, accountFeedback: { phase: 'idle', message: '' },
    officialNetworkFeedback: { phase: 'idle', message: '' },
    document: { querySelector: element, querySelectorAll: selector => groups[selector] || [] },
    currentRoute: element('#current-route'), currentRouteName: element('#current-route-name'),
    installButton: element('#install-button'), restoreButton: element('#restore-button'), installFeedback: element('#install-feedback'),
    list: element('#route-list'), listFeedback: element('#list-feedback'), addForm: element('#add-form'), cliCwd: element('#cli-cwd'),
    intelligence: { sync() {} }, renderNetwork() {}, renderHome() {}, renderAppPath() {},
  };
  const ui = vm.runInNewContext(functions + '\n({ renderControls, renderAccountMode, renderLaunch });', context);
  return { ui, state, element, groups };
}

test('official mode enables App and CLI without proxy or relay selection while keeping list management', () => {
  const { ui, state, element, groups } = setup({ available: true, mode: 'official', officialLoggedIn: false, relaySaved: true });
  state.selectedProxyName = null;
  ui.renderControls();
  assert.equal(element('#current-route-name').textContent, '官方 ChatGPT');
  assert.match(element('#current-route-mode').textContent, /待登录/);
  assert.ok(groups['[data-launch]'].every(button => !button.disabled));
  assert.match(element('#launch-status').textContent, /登录自己的 ChatGPT/);
  assert.ok(groups['.select-button'].every(button => button.disabled));
  assert.ok(groups['.mode-button'].every(button => button.disabled));
  assert.equal(element('#install-button').disabled, true);
  assert.equal(element('#restore-button').disabled, true);
  for (const selector of ['.edit-button', '.pin-button', '.account-bind-button', '.drag-handle']) {
    assert.ok(groups[selector].every(button => !button.disabled));
  }
  assert.equal(element('#add-open').disabled, false);
});

test('saved official credentials show a login state and allow switching to an unsaved relay with existing keys', () => {
  const { ui, element } = setup({ available: true, mode: 'official', officialLoggedIn: true, relaySaved: false });
  ui.renderControls();
  assert.match(element('#current-route-mode').textContent, /已有登录状态/);
  assert.equal(element('account-official').disabled, true);
  assert.equal(element('account-relay').disabled, false);
  assert.match(element('#account-mode-status').textContent, /登录过期/);
});

test('official connection labels keep the current proxy visible until Wi-Fi is applied by restart', () => {
  const { ui, state, element, groups } = setup({ available: true, mode: 'official', officialLoggedIn: true });
  state.launch.appNetwork = { ...state.officialNetwork, home: state.home };
  ui.renderControls();
  assert.equal(element('#current-network').textContent, '当前使用设备代理');
  assert.equal(element('#official-network-panel').hidden, false);
  state.officialNetwork = { mode: 'wifi', source: 'wifi', proxyUrl: '', label: '当前使用 Wi-Fi' };
  ui.renderControls();
  assert.match(element('#current-network').textContent, /^当前使用设备代理。待重启：使用 Wi-Fi/);
  assert.equal(groups['[data-official-network]'][1].attributes['aria-pressed'], 'true');
  state.launch.appNetwork = { ...state.officialNetwork, home: state.home };
  ui.renderControls();
  assert.equal(element('#current-network').textContent, '当前使用 Wi-Fi');
  assert.equal(element('#launch-network-status').textContent, '当前使用 Wi-Fi');
});

test('connection preview never claims an untracked App is already using the selected network', () => {
  const { ui, state, element } = setup({ available: true, mode: 'official' });
  ui.renderControls();
  assert.match(element('#current-network').textContent, /^下次启动：使用设备代理/);
  assert.match(element('#current-network').textContent, /当前 App 连接待确认/);
  state.accountSwitch.mode = 'relay';
  ui.renderControls();
  assert.equal(element('#official-network-panel').hidden, true);
  assert.equal(element('#current-network').hidden, true);
});

test('returning to relay mode restores relay controls and launch requires local proxy', () => {
  const { ui, state, element, groups } = setup({ available: true, mode: 'relay', officialLoggedIn: false, relaySaved: true });
  ui.renderControls();
  assert.equal(element('#current-route-name').textContent, 'relay');
  assert.ok(groups['.select-button'].every(button => !button.disabled));
  assert.ok(groups['.mode-button'].every(button => !button.disabled));
  assert.equal(element('#install-button').disabled, false);
  assert.ok(groups['[data-launch]'].every(button => button.disabled));
  state.proxyInstalled = true;
  ui.renderControls();
  assert.ok(groups['[data-launch]'].every(button => !button.disabled));
});

test('unavailable or blocked account switching is visible and cannot be activated', () => {
  const { ui, state, element, groups } = setup({ available: true, mode: 'relay', blockedReason: '当前凭据存储不支持文件切换' });
  ui.renderAccountMode();
  assert.equal(element('#account-mode-status').textContent, state.accountSwitch.blockedReason);
  assert.ok(groups['[data-account-mode]'].every(button => button.disabled));
  state.accountSwitch = undefined;
  ui.renderAccountMode();
  assert.match(element('#account-mode-status').textContent, /重启管理服务/);
  assert.ok(groups['[data-account-mode]'].every(button => button.disabled));
});

test('blocked official state cannot launch while blocked snapshots do not stop normal relay launches', () => {
  const { ui, state, element, groups } = setup({ available: true, mode: 'official', blockedReason: '当前凭据存储不支持文件切换' });
  ui.renderControls();
  assert.ok(groups['[data-launch]'].every(button => button.disabled));
  assert.equal(element('#launch-status').textContent, state.accountSwitch.blockedReason);
  state.accountSwitch.mode = 'relay';
  state.proxyInstalled = true;
  ui.renderControls();
  assert.ok(groups['[data-launch]'].every(button => !button.disabled));
});
