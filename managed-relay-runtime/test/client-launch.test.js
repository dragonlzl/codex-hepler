const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { EventEmitter } = require('node:events');
const { launch, launchContext } = require('../codex-launch');
const { findCli, cliCommand } = require('../codex-cli-launch');
const { createLauncher, openTerminal, findITerm } = require('../codex-launcher');
const { start } = require('../../managed-relay-server');
const run = promisify(execFile);

async function fixture(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "codex launch ' $ test-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  await fs.writeFile(path.join(home, 'config.toml'), 'model_provider="relay"\n[model_providers.relay]\nbase_url="https://example.invalid/v1"\n');
  await fs.writeFile(path.join(home, 'key_config.json'), JSON.stringify({ keys: [{ name: 'test', value: 'dummy', baseurl: 'https://example.invalid/v1' }] }));
  return { home, status: { home, mode: 'proxy', proxyInstalled: true, selectedProxyName: 'test', proxyUrl: 'http://127.0.0.1:3211/v1' } };
}

test('launch context preserves bypasses, uses the managed home and rejects mismatches and direct mode', async t => {
  const { home, status } = await fixture(t);
  const context = await launchContext({ env: { NO_PROXY: '.internal', no_proxy: 'localhost' }, status });
  assert.equal(context.env.CODEX_HOME, home);
  assert.equal(context.env.NO_PROXY, '.internal,localhost,127.0.0.1,::1');
  assert.equal(context.env.no_proxy, context.env.NO_PROXY);
  await assert.rejects(launchContext({ env: { CODEX_HOME: '/different' }, status }), /不同/);
  await assert.rejects(launchContext({ status: { ...status, proxyInstalled: false } }), /尚未接入/);
  await assert.rejects(launchContext({ status: { ...status, writeBlocked: true } }), /未完成/);
});

for (const platform of ['darwin', 'win32']) {
  test(`${platform} refuses to launch an already running App and passes the managed home on a fresh launch`, async t => {
    const { home, status } = await fixture(t);
    let running = true, calls = [];
    const adapter = {
      findApp: async () => ({ app: '/test/Codex.app', executable: '/test/Codex' }),
      isRunning: async () => running,
      inheritedBypass: async () => ['.inherited'],
      launch: async (...args) => calls.push(args), quitHint: '请完全退出',
    };
    await assert.rejects(launch({ status, env: {}, adapter, platform }), /Codex App 正在运行/);
    assert.equal(calls.length, 0);
    await launch({ status, env: {}, adapter, platform, argv: ['--check'] });
    assert.equal(calls.length, 0);
    running = false;
    await launch({ status, env: {}, adapter, platform });
    assert.equal(calls.length, 1);
    if (platform === 'darwin') assert.ok(calls[0][1].includes('CODEX_HOME=' + home));
    else { assert.equal(calls[0][1].CODEX_HOME, home); assert.match(calls[0][1].NO_PROXY, /\.inherited/); }
  });
}

test('CLI discovery prefers explicit paths and Windows npm wrappers use PowerShell literals', async t => {
  const { home } = await fixture(t);
  const binary = path.join(home, 'codex');
  await fs.writeFile(binary, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  assert.equal(await findCli({ platform: 'darwin', env: { PATH: home }, config: {} }), binary);
  await assert.rejects(findCli({ platform: 'darwin', env: { PATH: home, CODEX_CLI_PATH: path.join(home, 'missing') }, config: {} }), /未找到/);
  const executable = "C:\\a b'&$\\codex.cmd";
  const command = cliCommand(executable, ["it's a test", '$(bad)'], 'win32', {});
  const decoded = Buffer.from(command.args.at(-1), 'base64').toString('utf16le');
  assert.match(decoded, /& 'C:\\a b''&\$\\codex.cmd'/);
  assert.match(decoded, /'it''s a test' '\$\(bad\)'/);
  const found = await findCli({ platform: 'win32', env: { Path: 'C:\\npm' }, config: {}, stat: async file => ({ isFile: () => file.endsWith('.cmd') }), access: async () => {} });
  assert.equal(found, 'C:\\npm\\codex.cmd');
});

test('terminal launch uses fixed macOS open arguments and Windows falls back when wt is unavailable', async () => {
  const job = { command: "/tmp/a ' $/Codex CLI.command", manifest: "C:\\a b'&$\\launch.json" };
  const calls = [];
  await openTerminal(job, { platform: 'darwin', detectITerm: async () => null, runCommand: async (...args) => calls.push(args) });
  assert.deepEqual(calls[0].slice(0, 2), ['/usr/bin/open', ['-a', 'Terminal', job.command]]);
  let fallback;
  await openTerminal(job, { platform: 'win32', env: {}, runCommand: async () => { throw new Error('ENOENT'); }, spawnProcess: (...args) => {
    fallback = args;
    const child = new EventEmitter(); child.unref = () => {};
    queueMicrotask(() => child.emit('spawn'));
    return child;
  } });
  assert.equal(fallback[2].detached, true);
  assert.equal(fallback[2].windowsHide, false);
  assert.match(Buffer.from(fallback[1].at(-1), 'base64').toString('utf16le'), /'C:\\a b''&\$\\launch.json'/);
});

test('macOS prefers installed iTerm and falls back to Terminal when automation is denied', async () => {
  const job = { command: "/tmp/a ' $/Codex CLI.command" };
  const commands = [];
  const result = await openTerminal(job, { platform: 'darwin', detectITerm: async () => '/Applications/iTerm.app', runCommand: async (...args) => commands.push(args) });
  assert.equal(result.terminal, 'iTerm');
  assert.deepEqual(commands[0].slice(0, 2), ['/usr/bin/open', ['-a', '/Applications/iTerm.app']]);
  assert.equal(commands[1][0], '/usr/bin/osascript');
  assert.match(commands[1][1][1], /create window with default profile command \(item 1 of argv\)/);
  assert.ok(!commands[1][1][1].includes(job.command));
  const fallbackCalls = [];
  const fallback = await openTerminal(job, { platform: 'darwin', detectITerm: async () => '/Applications/iTerm.app', runCommand: async (...args) => {
    fallbackCalls.push(args);
    if (args[0] === '/usr/bin/osascript') throw new Error('Not authorized to send Apple events');
  } });
  assert.deepEqual(fallback, { terminal: 'Terminal', fallback: true });
  assert.deepEqual(fallbackCalls.at(-1).slice(0, 2), ['/usr/bin/open', ['-a', 'Terminal', job.command]]);
});

test('iTerm detection checks standard installs and nonstandard Spotlight locations', async () => {
  assert.equal(await findITerm({ access: async file => { if (file !== '/Applications/iTerm.app') throw new Error(); } }), '/Applications/iTerm.app');
  assert.equal(await findITerm({ access: async file => { if (file !== '/Custom/iTerm.app') throw new Error(); }, runCommand: async () => ({ stdout: '/Missing/iTerm.app\n/Custom/iTerm.app\n' }) }), '/Custom/iTerm.app');
  assert.equal(await findITerm({ access: async () => { throw new Error(); }, runCommand: async () => ({ stdout: '' }) }), null);
});

test('page launch API rejects missing/cross origin and extra commands, and reports already-running App errors', async t => {
  const { home } = await fixture(t);
  let calls = 0;
  const app = await start({ home, proxyPort: 0, uiPort: 0, log: () => {}, launcher: {
    snapshot: async () => ({ available: true }),
    start: async (target, context) => {
      calls++;
      assert.equal(target, 'app'); assert.equal(context.env.CODEX_HOME, home);
      assert.equal(context.env.RELAY_UI_PORT, new URL(app.uiUrl).port);
      throw new Error('Codex App 正在运行。请先完全退出。');
    },
  } });
  t.after(() => app.close());
  const request = (payload, origin) => fetch(app.uiUrl + '/api/launch', { method: 'POST', headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) }, body: JSON.stringify(payload) });
  assert.equal((await request({ target: 'app' })).status, 403);
  assert.equal((await request({ target: 'app' }, 'http://evil.invalid')).status, 403);
  assert.equal((await request({ target: 'app', command: 'touch /tmp/bad' }, app.uiUrl)).status, 400);
  assert.equal((await request(null, app.uiUrl)).status, 400);
  const response = await request({ target: 'app' }, app.uiUrl);
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /App 正在运行/);
  assert.equal(calls, 1);
});

test('CLI terminal job executes with its cwd/home/bypasses, reports exit, rejects duplicate opens and is single use', { skip: process.platform !== 'darwin' }, async t => {
  const { home } = await fixture(t);
  const binary = path.join(home, 'fake-codex');
  const captured = path.join(home, 'capture.json');
  // Only a local probe is executed; it cannot send model requests or modify user config.
  await fs.writeFile(binary, '#!' + process.execPath + '\nrequire("node:fs").writeFileSync(' + JSON.stringify(captured) + ', JSON.stringify({cwd:process.cwd(), home:process.env.CODEX_HOME, bypass:process.env.NO_PROXY}));\n', { mode: 0o700 });
  const app = await start({ home, proxyPort: 0, uiPort: 0, log: () => {} });
  t.after(() => app.close());
  await app.store.install('test');
  let job;
  const launcher = createLauncher({ platform: 'darwin', openTerminal: async value => { job = value; } });
  const context = { status: { ...await app.status(), home }, env: { PATH: process.env.PATH, RELAY_UI_PORT: new URL(app.uiUrl).port, NO_PROXY: '.internal', CODEX_CLI_PATH: binary }, cwd: home };
  await launcher.start('cli', context);
  t.after(() => fs.rm(job.dir, { recursive: true, force: true }));
  assert.equal((await launcher.snapshot()).cli.state, 'pending');
  await assert.rejects(launcher.start('cli', context), /已有终端/);
  await run('/bin/sh', [job.command], { env: { ...process.env, NO_PROXY: '', no_proxy: '' } });
  const data = JSON.parse(await fs.readFile(captured, 'utf8'));
  assert.deepEqual(data, { cwd: await fs.realpath(home), home, bypass: '.internal,127.0.0.1,localhost,::1' });
  assert.equal((await launcher.snapshot()).cli.state, 'exited');
  await assert.rejects(fs.access(job.manifest));
});

test('CLI independent shell entry supports --check and preserves working directory', { skip: process.platform !== 'darwin' }, async t => {
  const { home } = await fixture(t);
  const binary = path.join(home, 'fake-codex');
  await fs.writeFile(binary, '#!/bin/sh\npwd\nexit 7\n', { mode: 0o700 });
  const app = await start({ home, proxyPort: 0, uiPort: 0, log: () => {} });
  t.after(() => app.close());
  const env = { ...process.env, CODEX_HOME: home, CODEX_CLI_PATH: binary, RELAY_UI_PORT: new URL(app.uiUrl).port };
  const entry = path.resolve(__dirname, '../../start-codex-cli.sh');
  await assert.rejects(run('/bin/sh', [entry, '--check'], { cwd: home, env }), /尚未接入/);
  await app.store.install('test');
  const checked = await run('/bin/sh', [entry, '--check'], { cwd: home, env });
  assert.match(checked.stdout, /检查通过/);
  const canonicalHome = await fs.realpath(home);
  await assert.rejects(run('/bin/sh', [entry], { cwd: home, env }), error => error.code === 7 && error.stdout.trim() === canonicalHome);
});
