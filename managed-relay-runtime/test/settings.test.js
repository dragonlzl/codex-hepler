const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { start } = require('../../managed-relay-server');
const { settingsPath, readSettings, writeSettings, resolveHome, displayPath } = require('../settings');

const CONFIG = 'model_provider = "relay"\n\n[model_providers.relay]\nname = "relay"\nbase_url = "https://api.example.com/v1"\nwire_api = "responses"\n';

async function tempHome(t, { config = true, keys = true } = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-home-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  if (config) await fs.writeFile(path.join(home, 'config.toml'), CONFIG);
  if (keys) await fs.writeFile(path.join(home, 'key_config.json'), '{"keys":[]}');
  return home;
}

// 让 start() 走"设置文件"分支，同时保证测试绝不读写真实用户的配置目录，
// 也不读取仓库里的 codex-relay.config.json。
async function isolatedSettings(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-settings-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'settings.json');
  const config = path.join(dir, 'codex-relay.config.json');
  const previous = { settings: process.env.RELAY_UI_SETTINGS, codex: process.env.CODEX_HOME, tool: process.env.CODEX_TOOL_CONFIG };
  process.env.RELAY_UI_SETTINGS = file;
  process.env.CODEX_TOOL_CONFIG = config;
  delete process.env.CODEX_HOME;
  t.after(() => {
    if (previous.settings === undefined) delete process.env.RELAY_UI_SETTINGS; else process.env.RELAY_UI_SETTINGS = previous.settings;
    if (previous.codex === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous.codex;
    if (previous.tool === undefined) delete process.env.CODEX_TOOL_CONFIG; else process.env.CODEX_TOOL_CONFIG = previous.tool;
  });
  return { file, config };
}

const status = app => fetch(app.uiUrl + '/api/status').then(response => response.json());
async function post(app, endpoint, payload) {
  const response = await fetch(app.uiUrl + endpoint, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
  });
  return { status: response.status, body: await response.json() };
}

test('settings file is stored outside the Codex directory and honours RELAY_UI_SETTINGS', () => {
  const file = settingsPath({});
  assert.match(file, /settings\.json$/);
  assert.equal(file.startsWith(path.join(os.homedir(), '.codex') + path.sep), false);
  assert.equal(settingsPath({ RELAY_UI_SETTINGS: path.join(os.tmpdir(), 'relay-override.json') }), path.join(os.tmpdir(), 'relay-override.json'));
});

test('readSettings tolerates a missing or corrupt settings file', async t => {
  const { file } = await isolatedSettings(t);
  assert.deepEqual(await readSettings(), {});
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, '{ not json');
  assert.deepEqual(await readSettings(), {}, '损坏的设置文件不应阻止启动');
  await writeSettings({ home: '/tmp/example' });
  assert.deepEqual(await readSettings(), { home: '/tmp/example' });
});

test('resolveHome rejects paths that are not Codex config directories', async t => {
  await assert.rejects(resolveHome(path.join(os.tmpdir(), 'relay-missing-' + Date.now())), /目录不存在/);
  await assert.rejects(resolveHome(await tempHome(t, { config: false })), /config\.toml/);
  await assert.rejects(resolveHome('   '), /请填写/);
});

test('resolveHome expands a leading ~ before reporting a missing directory', async () => {
  await assert.rejects(resolveHome('~/definitely-missing-relay-dir-xyz'), error => {
    // 展开成功才会折叠成 ~/xxx；若未展开，路径里会多出一层当前工作目录。
    assert.equal(error.message, '目录不存在或不是文件夹：~/definitely-missing-relay-dir-xyz');
    return true;
  });
});

test('displayPath collapses the home prefix so pages never show the real user name', () => {
  assert.equal(displayPath('/Users/example/.codex', '/Users/example'), '~/.codex');
  assert.equal(displayPath('/Users/example/.config/codex-relay-ui/settings.json', '/Users/example'), '~/.config/codex-relay-ui/settings.json');
  assert.equal(displayPath('/Users/example', '/Users/example'), '~');
  assert.equal(displayPath('C:\\Users\\example\\.codex', 'C:\\Users\\example'), '~\\.codex', 'Windows 分隔符同样适用');
  assert.equal(displayPath('/Volumes/data/.codex', '/Users/example'), '/Volumes/data/.codex', '主目录之外保持原样');
  assert.equal(displayPath('/Users/examplefoo/.codex', '/Users/example'), '/Users/examplefoo/.codex', '同前缀的其它用户名不应被折叠');
  assert.equal(displayPath(undefined, '/Users/example'), undefined);
});

test('resolveHome reports failures as ~ when the target is inside the home directory', async () => {
  // 只构造路径字符串，不创建任何文件。
  const insideHome = path.join(os.homedir(), 'relay-missing-' + Date.now());
  await assert.rejects(resolveHome(insideHome), error => {
    assert.match(error.message, /^目录不存在或不是文件夹：~/);
    assert.equal(error.message.includes(os.homedir()), false, '报错不应包含真实主目录');
    return true;
  });
});

test('resolveHome creates a missing key_config.json so a new device can start', async t => {
  const home = await tempHome(t, { keys: false });
  assert.deepEqual(await resolveHome(home), { home, created: true });
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(home, 'key_config.json'), 'utf8')), { keys: [] });
  assert.deepEqual(await resolveHome(home), { home, created: false }, '第二次不应重复创建');
});

test('saved Codex directory survives a restart and can be switched from the page', async t => {
  const { file: settingsFile } = await isolatedSettings(t);
  const homeA = await tempHome(t);
  const homeB = await tempHome(t, { keys: false });
  await fs.writeFile(settingsFile, JSON.stringify({ home: homeA }));

  const first = await start({ proxyPort: 0, uiPort: 0, log: () => {} });
  t.after(() => first.close());
  const initial = await status(first);
  assert.equal(initial.home, homeA);
  assert.equal(initial.homeSource, 'saved');
  assert.equal(initial.homeLocked, false);
  assert.equal(initial.settingsPath, settingsFile);

  // 非法目录必须被拒绝，且不能破坏当前状态。
  const rejected = await post(first, '/api/home', { home: path.join(os.tmpdir(), 'relay-nope-' + Date.now()) });
  assert.equal(rejected.status, 400);
  assert.equal((await status(first)).home, homeA);

  const switched = await post(first, '/api/home', { home: homeB });
  assert.equal(switched.status, 200);
  assert.equal(switched.body.status.home, homeB);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(homeB, 'key_config.json'), 'utf8')), { keys: [] });
  assert.deepEqual(JSON.parse(await fs.readFile(settingsFile, 'utf8')), { home: homeB });

  await first.close();
  const second = await start({ proxyPort: 0, uiPort: 0, log: () => {} });
  t.after(() => second.close());
  assert.equal((await status(second)).home, homeB, '重启后应恢复已保存的目录');
});

test('an explicit home locks the page control and never writes the settings file', async t => {
  const { file: settingsFile } = await isolatedSettings(t);
  const homeA = await tempHome(t);
  const homeB = await tempHome(t);
  const app = await start({ home: homeA, proxyPort: 0, uiPort: 0, log: () => {} });
  t.after(() => app.close());
  const state = await status(app);
  assert.equal(state.home, homeA);
  assert.equal(state.homeSource, 'argument');
  assert.equal(state.homeLocked, true);
  assert.equal((await post(app, '/api/home', { home: homeB })).status, 409);
  await assert.rejects(fs.access(settingsFile), '外部指定的目录不应落盘');
});

test('CODEX_HOME locks the page control and is reported as the source', async t => {
  await isolatedSettings(t);
  const home = await tempHome(t);
  process.env.CODEX_HOME = home;
  const app = await start({ proxyPort: 0, uiPort: 0, log: () => {} });
  t.after(() => app.close());
  const state = await status(app);
  assert.equal(state.home, home);
  assert.equal(state.homeSource, 'env');
  assert.equal(state.homeLocked, true);
});

test('codexRelay config file supplies the Codex directory and locks the page control', async t => {
  const { config } = await isolatedSettings(t);
  const home = await tempHome(t);
  await fs.writeFile(config, JSON.stringify({ codexHome: home, codexAppPath: '/opt/Codex/Codex.exe' }));
  const app = await start({ proxyPort: 0, uiPort: 0, log: () => {} });
  t.after(() => app.close());
  const state = await status(app);
  assert.equal(state.home, home, '配置文件里的目录应生效，不需要在页面重新填写');
  assert.equal(state.homeSource, 'config');
  assert.equal(state.homeLocked, true);
  assert.equal(state.configPath, config);
  assert.equal(state.codexAppPath, '/opt/Codex/Codex.exe');
  const rejected = await post(app, '/api/home', { home: home });
  assert.equal(rejected.status, 409, '配置文件指定时页面不能改目录');
});

test('CODEX_HOME still outranks the config file directory', async t => {
  await isolatedSettings(t);
  const fromEnv = await tempHome(t);
  const fromFile = await tempHome(t);
  process.env.CODEX_HOME = fromEnv;
  // 绕开真实配置文件，直接替换 start() 内部的配置文件读取结果。
  const Module = require('node:module');
  const original = Module._load;
  Module._load = function (request) {
    const loaded = original.apply(this, arguments);
    if (request === './managed-relay-runtime/codex-config') return { ...loaded, loadCodexConfig: () => ({ codexHome: fromFile }) };
    return loaded;
  };
  t.after(() => { Module._load = original; });
  const app = await start({ proxyPort: 0, uiPort: 0, log: () => {} });
  t.after(() => app.close());
  const state = await status(app);
  assert.equal(state.home, fromEnv);
  assert.equal(state.homeSource, 'env');
});
