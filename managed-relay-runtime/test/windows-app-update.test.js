const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { findWinApp } = require('../codex-launch');
const { resolveAppPath, writeConfigAppPath } = require('../settings');

const WINDOWS_APPS = String.raw`C:\Program Files\WindowsApps`;
const flatApp = version => path.win32.join(WINDOWS_APPS, `OpenAI.Codex_${version}_x64__2p2nqsd0c76g0`, 'app');
const splitApp = version => path.win32.join(WINDOWS_APPS, 'OpenAI.Codex', `_${version}`, '_x64', '_', '_2p2nqsd0c76g0', 'app');
const OLD = '26.908.9136.0';
const NEW = '26.915.3509.0';

// 将 Windows 路径映射到临时目录，使用真实的 stat / readdir / access 验证更新行为。
async function installation(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'windows-app-update-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const local = target => {
    assert.equal(path.win32.parse(target).root.toLowerCase(), 'c:\\');
    return path.join(root, ...path.win32.relative('C:\\', target).split('\\'));
  };
  const scans = [];
  const io = {
    stat: target => fs.stat(local(target)),
    access: target => fs.access(local(target)),
    readdir: (target, options) => {
      scans.push(target);
      return fs.readdir(local(target), options);
    },
  };
  const add = async (directory, names = ['ChatGPT.exe']) => {
    await fs.mkdir(local(directory), { recursive: true });
    for (const name of names) await fs.writeFile(local(path.win32.join(directory, name)), 'fixture');
  };
  const find = target => findWinApp({ env: {}, config: { codexAppPath: target }, ...io });
  return { root, local, scans, io, add, find };
}

for (const [label, appDirectory] of [['flat package', flatApp], ['supplied split path', splitApp]]) {
  test(`${label}: an existing configured installation wins without scanning`, async t => {
    const fixture = await installation(t);
    await fixture.add(appDirectory(OLD));
    await fixture.add(appDirectory(NEW));
    const expected = path.win32.join(appDirectory(OLD), 'ChatGPT.exe');
    assert.deepEqual(await fixture.find(appDirectory(OLD)), { app: expected, executable: expected });
    assert.deepEqual(fixture.scans, []);
  });

  for (const name of [null, 'ChatGPT.exe', 'Codex.exe']) {
    test(`${label}: a removed ${name || 'directory'} resolves to the updated installation`, async t => {
      const fixture = await installation(t);
      await fixture.add(appDirectory(NEW), ['Codex.exe', 'ChatGPT.exe']);
      const target = name ? path.win32.join(appDirectory(OLD), name) : appDirectory(OLD);
      const executable = path.win32.join(appDirectory(NEW), name || 'ChatGPT.exe');
      assert.deepEqual(await fixture.find(target), { app: executable, executable });
      assert.deepEqual(fixture.scans, [label === 'flat package' ? WINDOWS_APPS : path.win32.join(WINDOWS_APPS, 'OpenAI.Codex')]);
    });
  }

  test(`${label}: forward slashes and a trailing separator work after an update`, async t => {
    const fixture = await installation(t);
    await fixture.add(appDirectory(NEW));
    const target = appDirectory(OLD).replaceAll('\\', '/') + '/';
    assert.equal((await fixture.find(target)).executable, path.win32.join(appDirectory(NEW), 'ChatGPT.exe'));
  });

  test(`${label}: update remnants and unrelated packages do not count as valid matches`, async t => {
    const fixture = await installation(t);
    await fixture.add(appDirectory(OLD), []);
    await fixture.add(appDirectory(NEW), ['Codex.exe']);
    await fixture.add(appDirectory('26.900.0.0'), []);
    await fs.mkdir(fixture.local(path.win32.join(appDirectory('26.900.0.0'), 'ChatGPT.exe')));
    await fixture.add(appDirectory('26.999.0.0').replace('OpenAI.Codex', 'OpenAI.Other'));
    assert.equal((await fixture.find(appDirectory(OLD))).executable, path.win32.join(appDirectory(NEW), 'Codex.exe'));
  });

  test(`${label}: multiple usable packages require an explicit selection`, async t => {
    const fixture = await installation(t);
    const other = appDirectory('26.916.0.0');
    await fixture.add(appDirectory(NEW));
    await fixture.add(other, ['Codex.exe']);
    await assert.rejects(fixture.find(appDirectory(OLD)), error => {
      assert.match(error.message, /多个可用.*请选择/);
      assert.ok(error.message.includes(appDirectory(NEW)));
      assert.ok(error.message.includes(other));
      return true;
    });
  });
}

test('the same pasted JSON path survives consecutive updates without being rewritten', async t => {
  const fixture = await installation(t);
  const config = path.join(fixture.root, 'config.json');
  const source = `{"codexAppPath":"${splitApp(OLD)}"}`;
  await fs.writeFile(config, source);
  await fixture.add(splitApp(NEW));
  const options = { env: { CODEX_TOOL_CONFIG: config }, ...fixture.io };
  assert.equal((await findWinApp(options)).executable, path.win32.join(splitApp(NEW), 'ChatGPT.exe'));
  await fs.rm(fixture.local(path.win32.join(WINDOWS_APPS, 'OpenAI.Codex', `_${NEW}`)), { recursive: true });
  await fixture.add(splitApp('26.920.0.0'));
  assert.equal((await findWinApp(options)).executable, path.win32.join(splitApp('26.920.0.0'), 'ChatGPT.exe'));
  assert.equal(await fs.readFile(config, 'utf8'), source);
});

test('an explicit executable keeps its name even when another supported executable is available', async t => {
  const fixture = await installation(t);
  await fixture.add(flatApp(NEW));
  await assert.rejects(fixture.find(path.win32.join(flatApp(OLD), 'Codex.exe')), /未找到可用的替代版本/);
});

test('unrelated paths and executable names never trigger a package scan', async t => {
  const fixture = await installation(t);
  await fixture.add(flatApp(NEW));
  for (const target of [
    String.raw`C:\Tools\OpenAI.Codex_old\app`,
    flatApp(OLD).replace('OpenAI.Codex', 'OpenAI.Other'),
    path.win32.join(flatApp(OLD), 'Other.exe'),
    path.win32.dirname(flatApp(OLD)),
  ]) await assert.rejects(fixture.find(target), /指定的 Codex 应用不可用/);
  assert.deepEqual(fixture.scans, []);
});

test('an inaccessible package is ignored and an unreadable parent explains the permission problem', async t => {
  const fixture = await installation(t);
  await fixture.add(flatApp(NEW));
  const denied = Object.assign(new Error('denied'), { code: 'EACCES' });
  const options = { env: {}, config: { codexAppPath: flatApp(OLD) }, ...fixture.io };
  await assert.rejects(findWinApp({ ...options, access: async () => { throw denied; } }), /未找到可用的替代版本/);
  await assert.rejects(findWinApp({ ...options, readdir: async () => { throw denied; } }), /无法读取 WindowsApps.*访问权限/);
});

test('an outdated environment path still outranks a usable config path', async t => {
  const fixture = await installation(t);
  await fixture.add(flatApp(NEW));
  await fixture.add(String.raw`C:\Tools\Codex`);
  const app = await findWinApp({
    env: { CODEX_APP_PATH: flatApp(OLD) },
    config: { codexAppPath: String.raw`C:\Tools\Codex` },
    ...fixture.io,
  });
  assert.equal(app.executable, path.win32.join(flatApp(NEW), 'ChatGPT.exe'));
});

test('Windows settings can save the old directory or executable as a reusable search seed', async t => {
  const fixture = await installation(t);
  await fixture.add(flatApp(NEW));
  for (const target of [flatApp(OLD), path.win32.join(flatApp(OLD), 'ChatGPT.exe')]) {
    const resolved = await resolveAppPath(target, { platform: 'win32', ...fixture.io });
    assert.equal(resolved, target);
    const config = path.join(fixture.root, 'saved-config.json');
    await writeConfigAppPath(config, resolved);
    assert.equal(JSON.parse(await fs.readFile(config, 'utf8')).codexAppPath, target);
    assert.equal((await findWinApp({ env: { CODEX_TOOL_CONFIG: config }, ...fixture.io })).executable,
      path.win32.join(flatApp(NEW), 'ChatGPT.exe'));
  }
});

test('settings reject missing or ambiguous replacements and do not scan on macOS', async t => {
  const fixture = await installation(t);
  const target = splitApp(OLD);
  const options = { platform: 'win32', ...fixture.io };
  await assert.rejects(resolveAppPath(target, options), /应用路径不存在/);
  await fixture.add(splitApp(NEW));
  fixture.scans.length = 0;
  await assert.rejects(resolveAppPath(target, { ...options, platform: 'darwin' }), /应用路径不存在/);
  assert.deepEqual(fixture.scans, []);
  await fixture.add(splitApp('26.916.0.0'));
  await assert.rejects(resolveAppPath(target, options), error => /多个可用/.test(error.message) && error.status === 400);
});
