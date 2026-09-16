const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { start } = require('../../managed-relay-server');
const { settingsPath, readSettings, writeSettings, resolveHome, displayPath } = require('../settings');
const { loadCodexConfig, resolveCodexPaths } = require('../codex-config');

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
  const previous = { settings: process.env.RELAY_UI_SETTINGS, codex: process.env.CODEX_HOME, tool: process.env.CODEX_TOOL_CONFIG, app: process.env.CODEX_APP_PATH };
  process.env.RELAY_UI_SETTINGS = file;
  process.env.CODEX_TOOL_CONFIG = config;
  delete process.env.CODEX_HOME;
  delete process.env.CODEX_APP_PATH;
  t.after(() => {
    if (previous.settings === undefined) delete process.env.RELAY_UI_SETTINGS; else process.env.RELAY_UI_SETTINGS = previous.settings;
    if (previous.codex === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous.codex;
    if (previous.tool === undefined) delete process.env.CODEX_TOOL_CONFIG; else process.env.CODEX_TOOL_CONFIG = previous.tool;
    if (previous.app === undefined) delete process.env.CODEX_APP_PATH; else process.env.CODEX_APP_PATH = previous.app;
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

test('displayPath keeps abbreviated paths available for error messages', () => {
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

test('default guidance stays abbreviated until the user saves a directory', async t => {
  await isolatedSettings(t);
  const userHome = await tempHome(t);
  const home = path.join(userHome, '.codex');
  await fs.mkdir(home);
  await fs.copyFile(path.join(userHome, 'config.toml'), path.join(home, 'config.toml'));
  await fs.copyFile(path.join(userHome, 'key_config.json'), path.join(home, 'key_config.json'));
  t.mock.method(os, 'homedir', () => userHome);
  const app = await start({ proxyPort: 0, uiPort: 0, log: () => {} });
  t.after(() => app.close());
  const initial = await status(app);
  assert.equal(initial.home, '~' + path.sep + '.codex');
  assert.equal(initial.homeSource, 'default');
  const saved = await post(app, '/api/home', { home: initial.home });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.status.home, home);
  assert.equal(saved.body.status.homeSource, 'saved');
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

test('a JSON-supplied directory is displayed in full and page edits persist in that JSON across restarts', async t => {
  const { config, file: settingsFile } = await isolatedSettings(t);
  const home = await tempHome(t);
  const nextHome = await tempHome(t);
  // 模拟路径位于用户主目录内，回归 ~ 缩写导致用户无法核对目录的问题。
  t.mock.method(os, 'homedir', () => path.dirname(home));
  const appPath = String.raw`C:\Program Files\ChatGPT\ChatGPT.exe`;
  const source = `{"codex_home":${JSON.stringify(home)},"codexAppPath":"${appPath}","$comment":"initial","future":{"enabled":true}}`;
  await fs.writeFile(config, source);
  const app = await start({ proxyPort: 0, uiPort: 0, log: () => {} });
  t.after(() => app.close());
  const state = await status(app);
  assert.equal(state.home, home, '配置文件里的目录应生效，不需要在页面重新填写');
  assert.equal(state.homeSource, 'config');
  assert.equal(state.homeLocked, false);
  assert.equal(state.configPath, displayPath(config), '自动生成的配置文件提示仍可缩写');
  assert.equal(state.codexAppPath, appPath);
  const rejected = await post(app, '/api/home', { home: path.join(home, 'missing') });
  assert.equal(rejected.status, 400);
  assert.equal(await fs.readFile(config, 'utf8'), source, '无效目录不能改写配置');

  await fs.writeFile(config, source.replace('initial', 'edited while running'));
  const saved = await post(app, '/api/home', { home: nextHome });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.status.home, nextHome);
  assert.equal(saved.body.status.homeSource, 'config');
  assert.equal(saved.body.status.homeLocked, false);
  assert.deepEqual(JSON.parse(await fs.readFile(config, 'utf8')), {
    codex_home: nextHome, codexHome: nextHome, codexAppPath: appPath,
    $comment: 'edited while running', future: { enabled: true },
  }, '写回最新配置并保留应用路径和其它字段；保存后的反斜杠符合标准 JSON');
  await assert.rejects(fs.access(settingsFile), 'JSON 作为保存来源时不另外写用户级设置');
  await app.close();
  const restarted = await start({ proxyPort: 0, uiPort: 0, log: () => {} });
  t.after(() => restarted.close());
  assert.equal((await status(restarted)).home, nextHome);
  assert.equal((await status(restarted)).homeSource, 'config');
});

test('damaged JSON and failed writes keep the current directory and allow a later retry', async t => {
  const { config } = await isolatedSettings(t);
  const home = await tempHome(t);
  const nextHome = await tempHome(t);
  const source = JSON.stringify({ codexHome: home, codexAppPath: '/opt/ChatGPT.exe' });
  await fs.writeFile(config, source);
  const app = await start({ proxyPort: 0, uiPort: 0, log: () => {} });
  t.after(() => app.close());
  await fs.writeFile(config, '{ broken');
  const damaged = await post(app, '/api/home', { home: nextHome });
  assert.equal(damaged.status, 409);
  assert.match(damaged.body.error, /配置已损坏/);
  assert.equal(await fs.readFile(config, 'utf8'), '{ broken');
  assert.equal((await status(app)).home, home);

  await fs.writeFile(config, source);
  const rename = fs.rename;
  const failure = t.mock.method(fs, 'rename', async (from, to) => {
    if (to === config) throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
    return rename(from, to);
  });
  const denied = await post(app, '/api/home', { home: nextHome });
  assert.equal(denied.status, 500);
  assert.match(denied.body.error, /写入权限/);
  assert.equal(await fs.readFile(config, 'utf8'), source);
  assert.equal((await status(app)).home, home);
  failure.mock.restore();
  const retry = await post(app, '/api/home', { home: nextHome });
  assert.equal(retry.status, 200);
  assert.equal(retry.body.status.home, nextHome);
});

test('concurrent directory saves cannot overwrite the in-progress selection', async t => {
  const { config } = await isolatedSettings(t);
  const home = await tempHome(t);
  const nextHome = await tempHome(t);
  await fs.writeFile(config, JSON.stringify({ codexHome: home }));
  const app = await start({ proxyPort: 0, uiPort: 0, log: () => {} });
  t.after(() => app.close());
  let release;
  let entered;
  const writing = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const rename = fs.rename;
  t.mock.method(fs, 'rename', async (from, to) => {
    if (to === config) { entered(); await gate; }
    return rename(from, to);
  });
  const first = post(app, '/api/home', { home: nextHome });
  try {
    await writing;
    const conflict = await post(app, '/api/home', { home });
    assert.equal(conflict.status, 409);
    assert.match(conflict.body.error, /正在保存/);
    const appConflict = await post(app, '/api/app-path', { appPath: home });
    assert.equal(appConflict.status, 409, '目录和应用路径共享同一个配置文件，不能并发覆盖');
  } finally { release(); }
  assert.equal((await first).status, 200);
  assert.equal((await status(app)).home, nextHome);
  assert.equal(JSON.parse(await fs.readFile(config, 'utf8')).codexHome, nextHome);
});

test('application and home paths save independently, survive restart and allow automatic app detection', async t => {
  const { config } = await isolatedSettings(t);
  const home = await tempHome(t);
  const nextHome = await tempHome(t);
  const executable = path.join(home, 'ChatGPT.exe');
  await fs.writeFile(executable, 'fixture');
  await fs.writeFile(config, JSON.stringify({ codexHome: home, codex_app_path: '', $comment: 'keep this' }));
  const app = await start({ proxyPort: 0, uiPort: 0, log: () => {} });
  t.after(() => app.close());
  assert.equal((await status(app)).appPathLocked, false);
  const source = await fs.readFile(config, 'utf8');
  for (const invalid of [null, 123, path.join(home, 'missing.exe')]) {
    assert.equal((await post(app, '/api/app-path', { appPath: invalid })).status, 400);
    assert.equal(await fs.readFile(config, 'utf8'), source);
  }
  for (const target of [executable, home]) {
    const saved = await post(app, '/api/app-path', { appPath: target });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.status.codexAppPath, target);
    assert.equal(saved.body.status.appPathSource, 'config');
    assert.equal(saved.body.status.home, home);
    assert.equal(resolveCodexPaths({ env: {}, file: config }).appPath, target, '启动脚本能读取页面保存的路径');
  }
  const switched = await post(app, '/api/home', { home: nextHome });
  assert.equal(switched.status, 200);
  assert.equal(switched.body.status.codexAppPath, home);
  assert.deepEqual(JSON.parse(await fs.readFile(config, 'utf8')), {
    codexHome: nextHome, codexAppPath: home, codex_app_path: home, $comment: 'keep this',
  });
  await app.close();
  const restarted = await start({ proxyPort: 0, uiPort: 0, log: () => {} });
  t.after(() => restarted.close());
  assert.equal((await status(restarted)).codexAppPath, home);
  assert.equal((await status(restarted)).home, nextHome);
  const reset = await post(restarted, '/api/app-path', { appPath: '' });
  assert.equal(reset.status, 200);
  assert.equal(reset.body.status.codexAppPath, null);
  assert.equal(reset.body.status.appPathSource, null);
  assert.deepEqual(loadCodexConfig(config), { codexHome: nextHome }, '清空时同时清掉别名，才能恢复自动查找');
});

test('application path saving can create a missing config but never overwrites a damaged config', async t => {
  const { config } = await isolatedSettings(t);
  const home = await tempHome(t);
  const app = await start({ home, proxyPort: 0, uiPort: 0, log: () => {} });
  t.after(() => app.close());
  const saved = await post(app, '/api/app-path', { appPath: home });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.status.homeLocked, true, '目录来自启动参数不影响应用路径单独保存');
  assert.deepEqual(JSON.parse(await fs.readFile(config, 'utf8')), { codexAppPath: home });
  await fs.writeFile(config, '{ damaged');
  assert.equal((await post(app, '/api/app-path', { appPath: '' })).status, 409);
  assert.equal(await fs.readFile(config, 'utf8'), '{ damaged');
  assert.equal((await status(app)).codexAppPath, home);
});

test('CODEX_APP_PATH locks only the application control and blocks config writes', async t => {
  const { config } = await isolatedSettings(t);
  const home = await tempHome(t);
  process.env.CODEX_APP_PATH = path.join(home, 'ChatGPT.exe');
  const app = await start({ home, proxyPort: 0, uiPort: 0, log: () => {} });
  t.after(() => app.close());
  const state = await status(app);
  assert.equal(state.codexAppPath, process.env.CODEX_APP_PATH);
  assert.equal(state.appPathSource, 'env');
  assert.equal(state.appPathLocked, true);
  assert.equal((await post(app, '/api/app-path', { appPath: '' })).status, 409);
  await assert.rejects(fs.access(config));
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
