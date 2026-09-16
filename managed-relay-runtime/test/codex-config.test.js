const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
  CONFIG_FILENAME, configPath, loadCodexConfig, readCodexConfig, resolveCodexPaths, expandPath, configHint,
  parseLooseJson,
} = require('../codex-config');

async function tempConfig(t, content) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-config-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, CONFIG_FILENAME);
  if (content !== undefined) await fs.writeFile(file, typeof content === 'string' ? content : JSON.stringify(content));
  return file;
}

// 从资源管理器复制出来的是单反斜杠路径。String.raw 让这些字符串保持“粘贴进来”的原始形态。
const PASTED_APP = String.raw`C:\Users\you\AppData\Local\Programs\Codex\Codex.exe`;
const PASTED_HOME = String.raw`C:\Users\you\.codex`;
const WINDOWS_APPS = String.raw`C:\Program Files\WindowsApps\OpenAI.Codex\_26.908.9136.0\_x64\_\_2p2nqsd0c76g0\app`;

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
  const pasted = await tempConfig(t, String.raw`{"codexAppPath":"  C:\u0061  ","codexHome":"  \\server\share\new  "}`);
  assert.deepEqual(loadCodexConfig(pasted), { codexAppPath: String.raw`C:\u0061`, codexHome: String.raw`\\server\share\new` });
});

// ---------------------------------------------------- 粘贴 Windows 路径的转义容错
// 用户从资源管理器复制的是单反斜杠路径，粘进 JSON 后 \U 会直接报错、\t 会变成制表符。

test('a pasted single-backslash path parses as written', async t => {
  const file = await tempConfig(t, `{\n  "codexAppPath": "${PASTED_APP}",\n  "codexHome": "${PASTED_HOME}"\n}\n`);
  assert.deepEqual(loadCodexConfig(file), { codexAppPath: PASTED_APP, codexHome: PASTED_HOME });
});

test('the supplied WindowsApps directory survives both pasted and standard JSON forms', async t => {
  const sources = [
    `{"codexAppPath":"${WINDOWS_APPS}"}`,
    JSON.stringify({ codexAppPath: WINDOWS_APPS }),
    JSON.stringify({ codexAppPath: WINDOWS_APPS.replaceAll('\\', '/') }),
  ];
  for (const source of sources) {
    const file = await tempConfig(t, source);
    const result = resolveCodexPaths({ env: {}, file });
    assert.equal(path.win32.normalize(result.appPath), WINDOWS_APPS);
    assert.equal(result.appSource, 'config');
  }
});

test('a pasted path whose folder is a JSON escape name (\\t, \\n) is still read correctly', async t => {
  const cases = [
    [String.raw`C:\temp\Codex.exe`, 'C:\\temp\\Codex.exe'],
    [String.raw`C:\newfolder\Codex.exe`, 'C:\\newfolder\\Codex.exe'],
    [String.raw`C:\Users\me\AppData\Roaming\npm\codex.cmd`, 'C:\\Users\\me\\AppData\\Roaming\\npm\\codex.cmd'],
    [String.raw`C:\temp\new\back\form\run`, String.raw`C:\temp\new\back\form\run`],
    [String.raw`C:\目录\new`, String.raw`C:\目录\new`],
    [String.raw`C:\Program Files (x64)\new`, String.raw`C:\Program Files (x64)\new`],
    [String.raw`C:\u0061`, String.raw`C:\u0061`],
    [String.raw`C:\unicode\app`, String.raw`C:\unicode\app`],
    [String.raw`%LOCALAPPDATA%\u0061`, String.raw`%LOCALAPPDATA%\u0061`],
  ];
  for (const [pasted, expected] of cases) {
    const file = await tempConfig(t, `{ "codexAppPath": "${pasted}" }`);
    assert.deepEqual(loadCodexConfig(file), { codexAppPath: expected }, pasted);
  }
});

test('properly escaped JSON stays unchanged and is never double-escaped', async t => {
  const config = { codexAppPath: 'C:\\Tools\\Codex.exe', codexHome: 'C:\\Users\\me\\.codex' };
  assert.deepEqual(loadCodexConfig(await tempConfig(t, config)), config);
  const escapedUnicode = String.raw`{"codexHome":"C:\\\u7528\u6237\\.codex", "codexAppPath":"C:\/Tools\/Codex.exe"}`;
  assert.deepEqual(parseLooseJson(escapedUnicode), JSON.parse(escapedUnicode));
});

test('the repair pass only touches the two path fields and keeps other values intact', () => {
  const raw = String.raw`{"$comment":"keep\nnewline\tand\u0041", "nested":{"codexHome":"keep\nnewline"}, "codexHome":"C:\目录\new", "codexAppPath":"C:\\\u7528\u6237\\Codex.exe"}`;
  assert.deepEqual(parseLooseJson(raw), {
    $comment: 'keep\nnewline\tandA', nested: { codexHome: 'keep\nnewline' },
    codexHome: String.raw`C:\目录\new`, codexAppPath: 'C:\\用户\\Codex.exe',
  });
  assert.equal(parseLooseJson(String.raw`{"$comment":"C:\Users", "codexHome":"C:\Users\you\.codex"}`), null,
    '非路径字段中的非法转义不能被偷偷修正');
  assert.equal(parseLooseJson(String.raw`{"nested":{"codexHome":"C:\Users"}, "codexHome":"C:\temp"}`), null);
  const comment = String.raw`"codexHome": "C:\Users"`;
  assert.deepEqual(parseLooseJson(`{"$comment":${JSON.stringify(comment)},"codexHome":"${PASTED_HOME}"}`), {
    $comment: comment, codexHome: PASTED_HOME,
  });
});

test('UNC paths, %VARS% and forward slashes are all accepted', async t => {
  // JSON 里写 "\\\\server\\share\\x" 解析出来是 \\server\share\x；两种写法都要能读。
  const escapedUnc = await tempConfig(t, '{ "codexAppPath": "\\\\\\\\server\\\\share\\\\Codex.exe" }');
  assert.deepEqual(loadCodexConfig(escapedUnc), { codexAppPath: '\\\\server\\share\\Codex.exe' });

  for (const unc of [String.raw`\\server\share\Codex.exe`, String.raw`\\server\new\temp`, String.raw`\\server\u0061`]) {
    assert.deepEqual(loadCodexConfig(await tempConfig(t, `{"codexAppPath":"${unc}"}`)), { codexAppPath: unc });
  }

  const variable = await tempConfig(t, `{ "codexAppPath": "${String.raw`%LOCALAPPDATA%\Programs\Codex\Codex.exe`}" }`);
  assert.deepEqual(loadCodexConfig(variable), { codexAppPath: '%LOCALAPPDATA%\\Programs\\Codex\\Codex.exe' });

  const slashes = await tempConfig(t, '{ "codexAppPath": "C:/Users/you/Codex.exe" }');
  assert.deepEqual(loadCodexConfig(slashes), { codexAppPath: 'C:/Users/you/Codex.exe' });
});

test('snake_case aliases also survive pasted backslashes', async t => {
  const file = await tempConfig(t, `{ "codex_app_path": "${PASTED_APP}", "codex_home": "${PASTED_HOME}" }`);
  assert.deepEqual(loadCodexConfig(file), { codexAppPath: PASTED_APP, codexHome: PASTED_HOME });
});

test('pasted directories may end in a backslash before another field or the closing brace', () => {
  const app = WINDOWS_APPS + '\\';
  const home = PASTED_HOME + '\\';
  assert.deepEqual(parseLooseJson(`{"codexAppPath":"${app}","codexHome":"${home}"}`), {
    codexAppPath: app, codexHome: home,
  });
  assert.deepEqual(parseLooseJson('{"codexHome":"C:\\"}'), { codexHome: 'C:\\' });
});

test('path fields can appear in either order or more than once', () => {
  const raw = String.raw`{"codexHome": "C:\a\.codex", "codexAppPath": "D:\b\Codex.exe"}`;
  assert.deepEqual(parseLooseJson(raw), { codexHome: String.raw`C:\a\.codex`, codexAppPath: String.raw`D:\b\Codex.exe` });
  assert.deepEqual(parseLooseJson(String.raw`{"codexHome":"C:\Users", "codexHome":"D:\new"}`), {
    codexHome: String.raw`D:\new`,
  });
});

test('unrecoverable or truncated JSON still falls back to auto-detection', async t => {
  assert.deepEqual(loadCodexConfig(await tempConfig(t, String.raw`{"codexAppPath": "C:\Users`)), {});
  assert.deepEqual(loadCodexConfig(await tempConfig(t, '{"codexAppPath": "C:\\Users\\you"')), {});
  assert.deepEqual(loadCodexConfig(await tempConfig(t, '{"codexHome":"C:\\temp\nnew"}')), {}, '实际换行不是路径分隔符');
  assert.deepEqual(loadCodexConfig(await tempConfig(t, String.raw`{"codexHome":"C:\Users",}`)), {}, '不修复无关 JSON 语法错误');
});

test('readCodexConfig reports whether the file existed', async t => {
  const missing = path.join(os.tmpdir(), 'relay-config-absent-' + Date.now() + '.json');
  assert.deepEqual(readCodexConfig(missing), { config: {}, file: missing, present: false });
  const file = await tempConfig(t, {});
  assert.equal(readCodexConfig(file).present, true);
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
