const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { bypassList, launchArguments, macLaunchProxy, macProcessArguments, findWinApp, findMacApp, describeConfig } = require('../codex-launch');

test('Codex launch preserves both existing bypass lists and adds local addresses once', () => {
  assert.equal(bypassList('.internal,127.0.0.1', 'localhost, 10.0.0.0/8'), '.internal,127.0.0.1,localhost,10.0.0.0/8,::1');
  assert.deepEqual(launchArguments('/Applications/Codex.app', [undefined, '']), [
    '-a', '/Applications/Codex.app', '--env', 'NO_PROXY=127.0.0.1,localhost,::1', '--env', 'no_proxy=127.0.0.1,localhost,::1',
  ]);
});

test('macOS app launch maps the system HTTPS proxy into process proxy variables', async () => {
  const { environment } = await macLaunchProxy({ env: {}, readSystemProxy: async () => ({
    HTTPEnable: 1, HTTPProxy: '127.0.0.1', HTTPPort: 7892,
    HTTPSEnable: 1, HTTPSProxy: '127.0.0.1', HTTPSPort: 7892,
    ExceptionsList: ['localhost', '127.*'],
  }) });
  assert.deepEqual(environment, {
    HTTP_PROXY: 'http://127.0.0.1:7892',
    http_proxy: 'http://127.0.0.1:7892',
    HTTPS_PROXY: 'http://127.0.0.1:7892',
    https_proxy: 'http://127.0.0.1:7892',
    ALL_PROXY: 'http://127.0.0.1:7892',
    all_proxy: 'http://127.0.0.1:7892',
  });
});

test('official macOS launch uses the system proxy before inherited environment or FlyingBird', async () => {
  const route = await macLaunchProxy({
    env: { HTTPS_PROXY: 'http://stale.invalid:8080' },
    readSystemProxy: async () => ({ HTTPSEnable: 1, HTTPSProxy: '127.0.0.1', HTTPSPort: 7892 }),
    readFlyingBirdProxy: async () => { throw new Error('unexpected FlyingBird detection'); },
  });
  assert.equal(route.source, 'system');
  assert.equal(route.proxyUrl, 'http://127.0.0.1:7892');
  for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) {
    assert.equal(route.environment[name], route.proxyUrl);
  }
});

test('official macOS launch preserves environment proxies before discovering FlyingBird', async () => {
  for (const name of ['https_proxy', 'HTTPS_PROXY', 'all_proxy', 'ALL_PROXY']) {
    const route = await macLaunchProxy({
      env: { [name]: 'http://127.0.0.1:8080' },
      readSystemProxy: async () => ({}),
      readFlyingBirdProxy: async () => { throw new Error('unexpected FlyingBird detection'); },
    });
    assert.equal(route.source, 'environment');
    assert.equal(route.environment.HTTPS_PROXY, 'http://127.0.0.1:8080');
    assert.equal(route.environment.https_proxy, route.environment.HTTPS_PROXY);
  }
});

test('official macOS launch uses confirmed FlyingBird or reports no explicit proxy', async () => {
  const options = { env: {}, readSystemProxy: async () => ({}) };
  const route = await macLaunchProxy({ ...options, readFlyingBirdProxy: async () => ({ proxyUrl: 'http://127.0.0.1:7892', source: 'flyingbird-auto' }) });
  assert.equal(route.source, 'flyingbird-auto');
  assert.equal(route.environment.ALL_PROXY, 'http://127.0.0.1:7892');
  const direct = await macLaunchProxy({ ...options, readFlyingBirdProxy: async () => null });
  assert.deepEqual(direct, { proxyUrl: '', source: 'direct', environment: {} });
});

test('Wi-Fi mode skips device proxy discovery even with stale proxy environment variables', async () => {
  const route = await macLaunchProxy({ officialNetworkMode: 'wifi', env: { HTTPS_PROXY: 'invalid stale proxy' },
    readSystemProxy: async () => assert.fail('Wi-Fi mode must not read the device proxy'),
    readFlyingBirdProxy: async () => assert.fail('Wi-Fi mode must not discover FlyingBird'),
  });
  assert.deepEqual(route, { proxyUrl: '', source: 'wifi', environment: {} });
});

test('automatic mode falls back to confirmed FlyingBird when system proxy reading fails', async () => {
  const route = await macLaunchProxy({ env: {}, readSystemProxy: async () => { throw new Error('system proxy unavailable'); },
    readFlyingBirdProxy: async () => ({ proxyUrl: 'http://127.0.0.1:7892', source: 'flyingbird-auto' }),
  });
  assert.equal(route.source, 'flyingbird-auto');
  assert.equal(route.proxyUrl, 'http://127.0.0.1:7892');
});

test('official macOS launch respects system PAC and explicit bypass rules', async () => {
  for (const [settings, source] of [
    [{ ProxyAutoConfigEnable: 1, ProxyAutoConfigURLString: 'http://127.0.0.1:7892/proxy.pac' }, 'system-pac'],
    [{ HTTPSEnable: 1, HTTPSProxy: '127.0.0.1', HTTPSPort: 7892, ExceptionsList: ['chatgpt.com'] }, 'system-bypass'],
  ]) {
    const route = await macLaunchProxy({ env: {}, readSystemProxy: async () => settings,
      readFlyingBirdProxy: async () => { throw new Error('unexpected FlyingBird detection'); },
    });
    assert.deepEqual(route, { proxyUrl: '', source, environment: {} });
  }
});

test('official macOS launch rejects invalid or authenticated environment proxies without exposing their values', async () => {
  for (const proxy of ['invalid-fixture-secret', 'ftp://127.0.0.1:7892', 'http://127.0.0.1:7892/fixture-secret']) {
    await assert.rejects(macLaunchProxy({ env: { HTTPS_PROXY: proxy }, readSystemProxy: async () => ({}) }), error =>
      /代理地址无效/.test(error.message) && !error.message.includes('fixture-secret'));
  }
  await assert.rejects(macLaunchProxy({ env: { HTTPS_PROXY: 'http://user:fixture-secret@127.0.0.1:7892' }, readSystemProxy: async () => ({}) }), error =>
    /账号密码/.test(error.message) && !error.message.includes('fixture-secret'));
});

test('Chromium proxy arguments preserve bypasses and convert SOCKS protocols without exposing credentials', () => {
  assert.deepEqual(macProcessArguments(''), []);
  assert.deepEqual(macProcessArguments('http://127.0.0.1:7892', 'localhost,127.0.0.1,::1,.internal'), [
    '--proxy-server=http://127.0.0.1:7892', '--proxy-bypass-list=localhost;127.0.0.1;[::1];.internal',
  ]);
  assert.equal(macProcessArguments('socks5h://127.0.0.1:7892')[0], '--proxy-server=socks5://127.0.0.1:7892');
  assert.equal(macProcessArguments('socks4a://127.0.0.1:7892')[0], '--proxy-server=socks4://127.0.0.1:7892');
  assert.deepEqual(macProcessArguments('http://user:fixture-password@127.0.0.1:7892'), []);
});

// 只假装这些路径存在，不接触真实文件系统。
const allow = (...allowed) => async target => {
  if (!allowed.includes(target)) throw new Error('ENOENT: ' + target);
};
const WINDOWS_APPS_DIR = String.raw`C:\Program Files\WindowsApps\OpenAI.Codex\_26.908.9136.0\_x64\_\_2p2nqsd0c76g0\app`;

test('Windows reads the supplied ChatGPT.exe path from a pasted JSON configuration', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-launch-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'config.json');
  const executable = path.win32.join(WINDOWS_APPS_DIR, 'ChatGPT.exe');
  await fs.writeFile(file, `{"codexAppPath":"${executable}"}`);
  const app = await findWinApp({
    env: { CODEX_TOOL_CONFIG: file },
    access: allow(executable),
    stat: async target => {
      assert.equal(target, executable);
      return { isDirectory: () => false };
    },
  });
  assert.deepEqual(app, { app: executable, executable });
});

test('Windows app detection uses the config file when no candidate path exists', async () => {
  const app = await findWinApp({
    env: { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' },
    config: { codexAppPath: 'C:\\Tools\\Codex\\Codex.exe' },
    access: allow('C:\\Tools\\Codex\\Codex.exe'),
    stat: async () => ({ isDirectory: () => false }),
  });
  assert.deepEqual(app, { app: 'C:\\Tools\\Codex\\Codex.exe', executable: 'C:\\Tools\\Codex\\Codex.exe' });
});

test('Windows app detection prefers ChatGPT.exe when a directory contains both names', async () => {
  const app = await findWinApp({
    env: {},
    config: { codexAppPath: 'C:\\Tools\\Codex' },
    access: allow(path.win32.join('C:\\Tools\\Codex', 'Codex.exe'), path.win32.join('C:\\Tools\\Codex', 'ChatGPT.exe')),
    stat: async () => ({ isDirectory: () => true }),
  });
  assert.equal(app.executable, path.win32.join('C:\\Tools\\Codex', 'ChatGPT.exe'));
});

test('a configured directory still supports legacy Codex.exe when ChatGPT.exe is absent', async () => {
  const executable = path.win32.join(WINDOWS_APPS_DIR, 'Codex.exe');
  const app = await findWinApp({
    env: {},
    config: { codexAppPath: WINDOWS_APPS_DIR },
    access: allow(executable),
    stat: async () => ({ isDirectory: () => true }),
  });
  assert.equal(app.executable, executable);
});

test('a configured WindowsApps directory can contain only ChatGPT.exe', async () => {
  const executable = path.win32.join(WINDOWS_APPS_DIR, 'ChatGPT.exe');
  const app = await findWinApp({
    env: {},
    config: { codexAppPath: WINDOWS_APPS_DIR },
    access: allow(executable),
    stat: async () => ({ isDirectory: () => true }),
  });
  assert.deepEqual(app, { app: executable, executable });
});

test('an unavailable explicit directory reports both names instead of launching a default app', async () => {
  const checked = [];
  await assert.rejects(findWinApp({
    env: { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' },
    config: { codexAppPath: WINDOWS_APPS_DIR },
    access: async target => { checked.push(target); throw new Error('ENOENT'); },
    stat: async () => ({ isDirectory: () => true }),
    readdir: async () => [],
    packageLocations: [],
  }), error => /Codex\.exe/.test(error.message) && /ChatGPT\.exe/.test(error.message) && /codexAppPath/.test(error.message));
  assert.deepEqual(checked, [path.win32.join(WINDOWS_APPS_DIR, 'ChatGPT.exe'), path.win32.join(WINDOWS_APPS_DIR, 'Codex.exe')]);
});

test('CODEX_APP_PATH still outranks the config file on Windows', async () => {
  const app = await findWinApp({
    env: { CODEX_APP_PATH: 'D:\\Portable\\ChatGPT.exe' },
    config: { codexAppPath: 'C:\\Tools\\Codex.exe' },
    access: allow('D:\\Portable\\ChatGPT.exe'),
    stat: async () => ({ isDirectory: () => false }),
  });
  assert.equal(app.executable, 'D:\\Portable\\ChatGPT.exe');
});

test('Windows app detection still probes the default layouts before failing', async () => {
  const base = 'C:\\Users\\me\\AppData\\Local';
  const app = await findWinApp({
    env: { LOCALAPPDATA: base },
    config: {},
    access: allow(path.win32.join(base, 'Programs', 'Codex', 'Codex.exe')),
    stat: async () => ({ isDirectory: () => false }),
  });
  assert.equal(app.executable, path.win32.join(base, 'Programs', 'Codex', 'Codex.exe'));
});

test('Windows auto-detection accepts ChatGPT.exe in both Codex and ChatGPT installation directories', async () => {
  const base = 'C:\\Users\\me\\AppData\\Local';
  for (const directory of ['Codex', 'ChatGPT']) {
    const executable = path.win32.join(base, 'Programs', directory, 'ChatGPT.exe');
    const app = await findWinApp({ env: { LOCALAPPDATA: base }, config: {}, access: allow(executable) });
    assert.equal(app.executable, executable);
  }
});

test('Windows auto-detection prioritizes ChatGPT.exe across directories and prefers ChatGPT installations', async () => {
  const env = { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local', PROGRAMFILES: 'C:\\Program Files' };
  const chatGptApp = path.win32.join(env.PROGRAMFILES, 'ChatGPT', 'ChatGPT.exe');
  const codexPackageChatGpt = path.win32.join(env.PROGRAMFILES, 'Codex', 'ChatGPT.exe');
  const legacyApp = path.win32.join(env.LOCALAPPDATA, 'Programs', 'ChatGPT', 'Codex.exe');
  const preferred = await findWinApp({ env, config: {}, access: allow(chatGptApp, codexPackageChatGpt, legacyApp) });
  assert.equal(preferred.executable, chatGptApp, '优先 ChatGPT 安装目录中的 ChatGPT.exe');
  const otherDirectory = await findWinApp({ env, config: {}, access: allow(codexPackageChatGpt, legacyApp) });
  assert.equal(otherDirectory.executable, codexPackageChatGpt, '先找遍 ChatGPT.exe，再回退旧名称');
});

test('a missing Windows app points users at CODEX_APP_PATH and the JSON config file', async () => {
  await assert.rejects(
    findWinApp({ env: { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' }, config: {}, access: allow(), stat: async () => ({ isDirectory: () => false }) }),
    error => {
      assert.match(error.message, /未找到 Codex 桌面应用/);
      assert.match(error.message, /CODEX_APP_PATH/);
      assert.match(error.message, /codex-relay\.config\.json/, '应给出可编辑的配置文件路径');
      assert.match(error.message, /codexAppPath/);
      assert.match(error.message, /Codex CLI/, 'CLI 用户仍应看到原有提示');
      return true;
    },
  );
});

test('a missing macOS app also points at the JSON config file', async () => {
  await assert.rejects(
    findMacApp({ env: {}, config: {}, access: allow() }),
    error => /codex-relay\.config\.json/.test(error.message),
  );
});

test('describeConfig reports which values came from the config file', () => {
  const line = describeConfig({ CODEX_TOOL_CONFIG: path.join(os.tmpdir(), 'relay.json') }, { codexAppPath: path.join(os.tmpdir(), 'Codex', 'Codex.exe') });
  assert.match(line, /codexAppPath=/);
  assert.match(line, /来自配置文件/);
  assert.match(line, /配置文件/);
  assert.equal(describeConfig({}, {}), null, '没有配置值时不应输出空行');
});

// Windows 批处理的三个坑：默认代码页 936 会把 UTF-8 中文显示成乱码；
// 报错后窗口立即关闭则看不到原因；chcp 之前的行仍按旧代码页解码。
// 这几个断言防止以后改回去。
for (const name of ['start-managed-relay.cmd', 'start-codex-local.cmd']) {
  test(`${name} switches to UTF-8 and pauses before closing`, async () => {
    const file = path.resolve(__dirname, '..', '..', name);
    const bytes = await fs.readFile(file);
    assert.equal(bytes[0], 0x40, '批处理不应带 BOM：cmd 会把 BOM 当作命令前缀');
    const text = bytes.toString('utf8');
    assert.match(text, /^@echo off\r?\n/, '首行必须是 @echo off');
    assert.match(text, /^\s*chcp 65001/m, '必须切到 UTF-8 代码页，否则中文提示会显示成乱码');
    assert.match(text, /^\s*if not defined RELAY_NO_PAUSE pause\s*$/m, '结束时必须 pause，避免报错一闪而过');
    const head = text.slice(0, text.indexOf('chcp 65001'));
    assert.equal(/[^\x00-\x7F]/.test(head), false,
      'chcp 之前的行仍按旧代码页解码，必须是纯 ASCII，否则可能出现多余字符甚至被当成命令分隔符');
    const tail = text.slice(text.indexOf('chcp 65001'));
    assert.equal(/[^\x00-\x7F]/.test(tail), false, '批处理文件保持 ASCII，避免 cmd 读取编码不一致时把中文行当成命令');
  });
}
