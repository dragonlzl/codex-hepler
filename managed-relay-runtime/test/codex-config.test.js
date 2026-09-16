const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { CONFIG_FILENAME, configPath, loadCodexConfig, resolveCodexPaths, expandPath, configHint } = require('../codex-config');

async function tempConfig(t, content) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-config-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, CONFIG_FILENAME);
  if (content !== undefined) await fs.writeFile(file, typeof content === 'string' ? content : JSON.stringify(content));
  return file;
}

test('configPath honours CODEX_TOOL_CONFIG and stays inside the project by default', () => {
  const override = path.join(os.tmpdir(), 'explicit-config.json');
  assert.equal(configPath({ CODEX_TOOL_CONFIG: override }), override);
  // 仓库根目录里已经放了 codex-relay.config.json，默认应解析到它。
  assert.equal(configPath({}), path.resolve(__dirname, '..', '..', CONFIG_FILENAME));
});

test('configPath falls back to the platform user config directory', () => {
  // 仓库里存在 codex-relay.config.json 时，任何环境下都应先命中项目内的这份。
  assert.equal(configPath({ XDG_CONFIG_HOME: path.join(os.tmpdir(), 'relay-xdg') }),
    path.resolve(__dirname, '..', '..', CONFIG_FILENAME));
  // CODEX_TOOL_CONFIG 优先级最高，用来显式指定任意位置的配置文件。
  assert.equal(configPath({ CODEX_TOOL_CONFIG: 'relative/config.json' }, 'win32'), path.resolve('relative/config.json'));
});

test('loadCodexConfig tolerates missing, corrupt and wrongly typed files', async t => {
  const missing = path.join(os.tmpdir(), 'relay-config-missing-' + Date.now() + '.json');
  assert.deepEqual(loadCodexConfig(missing), {});
  assert.deepEqual(loadCodexConfig(await tempConfig(t, '{ not json')), {});
  assert.deepEqual(loadCodexConfig(await tempConfig(t, {})), {});
  assert.deepEqual(loadCodexConfig(await tempConfig(t, [])), {}, '数组不是有效配置');
  assert.deepEqual(loadCodexConfig(await tempConfig(t, { codexAppPath: 42, codexHome: null })), {});
});

test('loadCodexConfig trims values and accepts snake_case aliases', async t => {
  const camel = await tempConfig(t, { codexAppPath: '  C:\\Tools\\Codex.exe  ', codexHome: ' C:\\Users\\me\\.codex ' });
  assert.deepEqual(loadCodexConfig(camel), { codexAppPath: 'C:\\Tools\\Codex.exe', codexHome: 'C:\\Users\\me\\.codex' });
  const snake = await tempConfig(t, { codex_app_path: 'C:\\Tools\\Codex.exe', codex_home: 'C:\\Users\\me\\.codex' });
  assert.deepEqual(loadCodexConfig(snake), { codexAppPath: 'C:\\Tools\\Codex.exe', codexHome: 'C:\\Users\\me\\.codex' });
});

test('resolveCodexPaths prefers the environment over the config file and reports the source', () => {
  const config = { codexAppPath: '/opt/Codex/Codex.exe', codexHome: '/opt/codex-home' };
  const fromConfig = resolveCodexPaths({ env: {}, config, file: '/tmp/c.json' });
  assert.deepEqual(fromConfig, {
    configFile: '/tmp/c.json',
    appPath: path.resolve('/opt/Codex/Codex.exe'),
    appSource: 'config',
    home: path.resolve('/opt/codex-home'),
    homeSource: 'config',
  });
  const fromEnv = resolveCodexPaths({ env: { CODEX_APP_PATH: '/env/Codex.exe', CODEX_HOME: '/env/home' }, config, file: '/tmp/c.json' });
  assert.equal(fromEnv.appPath, path.resolve('/env/Codex.exe'));
  assert.equal(fromEnv.appSource, 'env');
  assert.equal(fromEnv.home, path.resolve('/env/home'));
  assert.equal(fromEnv.homeSource, 'env');
  const empty = resolveCodexPaths({ env: {}, config: {}, file: '/tmp/c.json' });
  assert.equal(empty.appPath, null);
  assert.equal(empty.appSource, null);
  assert.equal(empty.home, null);
});

test('expandPath handles ~, ~/x and %WINDIR%-style variables', () => {
  assert.equal(expandPath('~/codex', {}), path.join(os.homedir(), 'codex'));
  assert.equal(expandPath('~', {}), os.homedir());
  // 盘符路径不做 path.resolve：在 macOS 上拼接工作目录只会得到一个错误路径。
  assert.equal(expandPath('%LOCALAPPDATA%\\Programs\\Codex\\Codex.exe', { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' }),
    'C:\\Users\\me\\AppData\\Local\\Programs\\Codex\\Codex.exe');
  assert.equal(expandPath('%UNKNOWN%/Codex.exe', {}), path.resolve('%UNKNOWN%/Codex.exe'), '未知变量保持原样');
  assert.equal(expandPath('   ', {}), null);
  assert.equal(expandPath(undefined, {}), null);
});

test('configHint points at the JSON config file', () => {
  assert.match(configHint({ CODEX_TOOL_CONFIG: '/tmp/relay.json' }), /\/tmp\/relay\.json/);
  assert.match(configHint({ CODEX_TOOL_CONFIG: '/tmp/relay.json' }), /codexAppPath/);
});
