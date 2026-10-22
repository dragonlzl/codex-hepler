const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { ConfigStore, atomicWrite, inspectConfig } = require('../config-store');
const { officialConfig } = require('../account-mode');

const relay = `# common comment\nmodel_provider = "third"\nmodel = "third-only-model"\nforced_login_method = "api"\n[model_providers.third]\nname = "Third"\nbase_url = "https://third.example/v1"\nrequires_openai_auth = true\n[projects."/tmp/keep"]\ntrust_level = "trusted" # project comment\n[mcp_servers.keep]\ncommand = "node"\n`;
const authKey = '{"OPENAI_API_KEY":"sk-relay-secret","extra":"preserve"}\n';
const officialAuth = value => JSON.stringify({ auth_mode: 'chatgpt', OPENAI_API_KEY: null, tokens: { access_token: `${value}-access`, refresh_token: `${value}-refresh`, id_token: `${value}-id` } });
async function fixture(t, config = relay, auth = authKey) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'codextool-account-mode-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const store = new ConfigStore(home, 'http://127.0.0.1:3211/v1');
  await fs.writeFile(store.configPath, config);
  if (auth !== null) await fs.writeFile(store.authPath, auth);
  await fs.writeFile(store.keysPath, JSON.stringify({ keys: [{ name: 'third', baseurl: 'https://third.example/v1', value: 'sk-relay-secret' }] }));
  await fs.writeFile(store.statePath, JSON.stringify({ activeName: 'third', directName: 'third', order: ['third'], pinned: ['third'] }));
  return { home, store, read: file => fs.readFile(file, 'utf8') };
}
async function files(store) {
  const values = {};
  for (const file of [store.configPath, store.authPath, store.statePath, store.sessionPath, store.accountProfilesPath]) {
    try { values[file] = await fs.readFile(file, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; values[file] = null; }
  }
  return values;
}

test('real account roundtrip restores fresh official tokens and exact relay bytes without exposing secrets', async t => {
  const f = await fixture(t);
  assert.equal((await f.store.status()).accountSwitch.mode, 'relay');
  const first = await f.store.switchAccountMode('official');
  assert.equal(first.restartRequired, true);
  const text = await f.read(f.store.configPath);
  assert.equal(inspectConfig(text).id, 'openai');
  assert.match(text, /forced_login_method = "chatgpt"/);
  assert.doesNotMatch(text, /model = "third-only-model"/);
  assert.match(text, /# common comment/);
  assert.match(text, /trust_level = "trusted" # project comment/);
  assert.match(text, /\[mcp_servers.keep\]/);
  assert.deepEqual(JSON.parse(await f.read(f.store.authPath)), {});
  await fs.writeFile(f.store.authPath, officialAuth('first'));
  await f.store.switchAccountMode('relay');
  assert.equal(await f.read(f.store.configPath), relay);
  assert.equal(await f.read(f.store.authPath), authKey);
  await f.store.switchAccountMode('official');
  assert.equal(await f.read(f.store.authPath), officialAuth('first'));
  await fs.writeFile(f.store.authPath, officialAuth('refreshed'));
  const noOpBefore = await files(f.store);
  assert.equal((await f.store.switchAccountMode('official')).restartRequired, false);
  assert.deepEqual(await files(f.store), noOpBefore);
  await f.store.switchAccountMode('relay');
  await f.store.switchAccountMode('official');
  assert.equal(await f.read(f.store.authPath), officialAuth('refreshed'));
  const status = await f.store.status();
  assert.equal(status.accountSwitch.officialLoggedIn, true);
  assert.equal(status.accountSwitch.officialSaved, true);
  assert.equal(status.accountSwitch.relaySaved, true);
  const serialized = JSON.stringify(status);
  for (const secret of ['sk-relay-secret', 'refreshed-access', 'refreshed-refresh', 'refreshed-id']) assert.ok(!serialized.includes(secret));
  assert.equal((await fs.stat(f.store.accountProfilesPath)).mode & 0o777, 0o600);
  for (const name of await fs.readdir(f.store.runtimeDir)) if (name.startsWith('backup-')) assert.equal((await fs.stat(path.join(f.store.runtimeDir, name))).mode & 0o777, 0o600);
});

test('proxy session restores and preserves updated unrelated UI state; automatic switching remains off', async t => {
  const f = await fixture(t);
  await f.store.install('third');
  const installed = await f.read(f.store.configPath), session = await f.read(f.store.sessionPath);
  await fs.writeFile(f.store.statePath, JSON.stringify({ activeName: 'third', order: ['third'], pinned: ['third'], autoSwitch: { enabled: true, pool: [{ name: 'third' }] } }));
  await f.store.switchAccountMode('official');
  await assert.rejects(f.store.activeEntry(), /官方/);
  await assert.rejects(f.store.install('third'), /官方/);
  await assert.rejects(f.store.select('third', 'direct'), /官方/);
  await fs.writeFile(f.store.statePath, JSON.stringify({ order: ['new', 'third'], pinned: [], unrelated: 'latest', autoSwitch: { enabled: false } }));
  await f.store.switchAccountMode('relay');
  assert.equal(await f.read(f.store.configPath), installed);
  assert.equal(await f.read(f.store.sessionPath), session);
  const state = JSON.parse(await f.read(f.store.statePath));
  assert.deepEqual(state.order, ['new', 'third']);
  assert.deepEqual(state.pinned, []);
  assert.equal(state.unrelated, 'latest');
  assert.equal(state.activeName, 'third');
  assert.equal(state.autoSwitch.enabled, false);
  assert.deepEqual(state.autoSwitch.pool, [{ name: 'third' }]);
  await f.store.restore();
  assert.equal(await f.read(f.store.configPath), relay);
});

test('snapshot of missing auth restores its absence and proxy port changes keep direct restore valid', async t => {
  const f = await fixture(t, relay, null);
  await f.store.install('third');
  await f.store.switchAccountMode('official');
  const reopened = new ConfigStore(f.home, 'http://127.0.0.1:4321/v1');
  await reopened.switchAccountMode('relay');
  assert.equal(inspectConfig(await f.read(reopened.configPath)).baseUrl, reopened.proxyUrl);
  await assert.rejects(fs.readFile(reopened.authPath), { code: 'ENOENT' });
  assert.equal((await reopened.status()).canRestore, true);
  await reopened.restore();
  assert.equal(await f.read(reopened.configPath), relay);
});

test('restart before switching accounts discovers old proxy port from the trusted live session', async t => {
  const f = await fixture(t);
  await f.store.install('third');
  const restarted = new ConfigStore(f.home, 'http://127.0.0.1:4321/v1');
  assert.equal((await restarted.status()).proxyInstalled, false);
  await restarted.switchAccountMode('official');
  const saved = JSON.parse(await f.read(restarted.accountProfilesPath));
  assert.equal(saved.profiles.relay.proxyUrl, f.store.proxyUrl);
  await restarted.switchAccountMode('relay');
  assert.equal(inspectConfig(await f.read(restarted.configPath)).baseUrl, restarted.proxyUrl);
  assert.equal((await restarted.status()).canRestore, true);
  await restarted.restore();
  assert.equal(await f.read(restarted.configPath), relay);
});

test('old local proxy with externally edited installation is blocked instead of saved as direct', async t => {
  const f = await fixture(t);
  await f.store.install('third');
  await fs.appendFile(f.store.configPath, '# external change after installation\n');
  const restarted = new ConfigStore(f.home, 'http://127.0.0.1:4321/v1');
  const before = await files(restarted);
  await assert.rejects(restarted.switchAccountMode('official'), /代理地址已过期/);
  assert.deepEqual(await files(restarted), before);
});

test('fresh official login can construct a safe first relay from a saved route and restore tokens', async t => {
  const config = '# keep official\nmodel = "official-model"\n[mcp_servers.keep]\ncommand="node"\n';
  const auth = officialAuth('official-initial');
  const f = await fixture(t, config, auth);
  await f.store.switchAccountMode('relay');
  const actual = inspectConfig(await f.read(f.store.configPath));
  assert.equal(actual.id, 'codextool_relay');
  assert.equal(actual.baseUrl, 'https://third.example/v1');
  assert.deepEqual(JSON.parse(await f.read(f.store.authPath)), { OPENAI_API_KEY: 'sk-relay-secret' });
  await f.store.switchAccountMode('official');
  assert.equal(await f.read(f.store.configPath), config);
  assert.equal(await f.read(f.store.authPath), auth);
});

test('official API key state upgrades to ChatGPT mode without saving API key as official auth', async t => {
  const f = await fixture(t, 'model_provider="openai"\nforced_login_method="api"\n', authKey);
  await f.store.switchAccountMode('official');
  assert.deepEqual(JSON.parse(await f.read(f.store.authPath)), {});
  assert.match(await f.read(f.store.configPath), /forced_login_method = "chatgpt"/);
  const profiles = JSON.parse(await f.read(f.store.accountProfilesPath));
  assert.deepEqual(JSON.parse(profiles.profiles.official.authText), {});
});

test('mode follows external config changes rather than persisted state and snapshots latest original bytes', async t => {
  const f = await fixture(t);
  await f.store.switchAccountMode('official');
  const changed = relay.replace('third-only-model', 'external-model');
  await fs.writeFile(f.store.configPath, changed);
  await fs.writeFile(f.store.authPath, authKey.replace('sk-relay-secret', 'sk-new-secret'));
  assert.equal((await f.store.status()).accountSwitch.mode, 'relay');
  await f.store.switchAccountMode('official');
  await f.store.switchAccountMode('relay');
  assert.equal(await f.read(f.store.configPath), changed);
  assert.equal(JSON.parse(await f.read(f.store.authPath)).OPENAI_API_KEY, 'sk-new-secret');
});

test('corrupt snapshots and unsupported stores block writes, with actionable status and no credential leakage', async t => {
  for (const extra of ['cli_auth_credentials_store="keyring"\n', 'cli_auth_credentials_store="auto"\n', 'cli_auth_credentials_store="ephemeral"\n']) {
    const f = await fixture(t, extra + relay);
    const before = await files(f.store);
    assert.match((await f.store.status()).accountSwitch.blockedReason, /存储/);
    await assert.rejects(f.store.switchAccountMode('official'), /存储/);
    assert.deepEqual(await files(f.store), before);
  }
  const f = await fixture(t);
  await fs.mkdir(f.store.runtimeDir);
  await fs.writeFile(f.store.accountProfilesPath, '{broken with sk-test-secret');
  const before = await files(f.store);
  assert.match((await f.store.status()).accountSwitch.blockedReason, /损坏/);
  await assert.rejects(f.store.switchAccountMode('official'), /损坏/);
  assert.deepEqual(await files(f.store), before);
  assert.ok(!JSON.stringify(await f.store.status()).includes('sk-test-secret'));
});

test('env/fixed auth guards block account switch and saved official tokens cannot be restored into a relay', async t => {
  for (const extra of ['env_key="CUSTOM_KEY"\n', 'http_headers={Authorization="Bearer test"}\n', 'env_http_headers={"X-API-Key"="CUSTOM_KEY"}\n']) {
    const f = await fixture(t, relay.replace('requires_openai_auth = true\n', `requires_openai_auth = true\n${extra}`));
    const before = await files(f.store);
    await assert.rejects(f.store.switchAccountMode('official'), /认证/);
    assert.deepEqual(await files(f.store), before);
  }
  const f = await fixture(t);
  await f.store.switchAccountMode('official');
  const saved = JSON.parse(await f.read(f.store.accountProfilesPath));
  saved.profiles.relay.authText = officialAuth('mixed');
  await fs.writeFile(f.store.accountProfilesPath, JSON.stringify(saved));
  const before = await files(f.store);
  await assert.rejects(f.store.switchAccountMode('relay'), /混入/);
  assert.deepEqual(await files(f.store), before);
});

test('failure after saving profiles rolls back all files and removes pending journal', async t => {
  const f = await fixture(t);
  const before = await files(f.store);
  let writes = 0;
  const failing = new ConfigStore(f.home, f.store.proxyUrl, async (file, text) => {
    if (++writes === 3) throw new Error('failed config write');
    return atomicWrite(file, text);
  });
  await assert.rejects(failing.switchAccountMode('official'), /已回滚/);
  assert.deepEqual(await files(f.store), before);
  await assert.rejects(fs.readFile(f.store.journalPath), { code: 'ENOENT' });
});

test('external token refresh during transaction preflight wins and rejects stale snapshot write', async t => {
  const f = await fixture(t);
  const beforeConfig = await f.read(f.store.configPath);
  const originalCommit = f.store.commit.bind(f.store);
  f.store.commit = async changes => {
    await fs.writeFile(f.store.authPath, '{"OPENAI_API_KEY":"sk-external"}');
    return originalCommit(changes);
  };
  await assert.rejects(f.store.switchAccountMode('official'), /其他程序/);
  assert.equal(await f.read(f.store.configPath), beforeConfig);
  assert.deepEqual(JSON.parse(await f.read(f.store.authPath)), { OPENAI_API_KEY: 'sk-external' });
  await assert.rejects(fs.readFile(f.store.accountProfilesPath), { code: 'ENOENT' });
});

test('external login creating auth file aborts a relay restoration whose planned auth change is a no-op', async t => {
  const f = await fixture(t, relay, null);
  await f.store.switchAccountMode('official');
  await fs.unlink(f.store.authPath);
  const before = await files(f.store);
  const externalAuth = officialAuth('external-login');
  const originalCommit = f.store.commit.bind(f.store);
  f.store.commit = async changes => {
    const authChange = changes.find(change => change.file === f.store.authPath);
    assert.equal(authChange.before, null);
    assert.equal(authChange.after, null);
    await fs.writeFile(f.store.authPath, externalAuth);
    return originalCommit(changes);
  };
  await assert.rejects(f.store.switchAccountMode('relay'), /其他程序/);
  const after = await files(f.store);
  assert.equal(after[f.store.authPath], externalAuth);
  for (const file of Object.keys(before)) if (file !== f.store.authPath) assert.equal(after[file], before[file]);
  assert.equal((await f.store.status()).accountSwitch.mode, 'official');
});

test('commit checks unchanged config and state before writing the transaction', async t => {
  const f = await fixture(t);
  const authText = await f.read(f.store.authPath);
  const configText = await f.read(f.store.configPath);
  const stateText = await f.read(f.store.statePath);
  for (const [guardFile, expected] of [[f.store.configPath, configText], [f.store.statePath, stateText]]) {
    await fs.writeFile(guardFile, `${expected}\n`);
    await assert.rejects(f.store.commit([
      { file: guardFile, before: expected, after: expected },
      { file: f.store.authPath, before: authText, after: '{"OPENAI_API_KEY":"sk-should-not-write"}' },
    ]), /其他程序/);
    assert.equal(await f.read(f.store.authPath), authText);
    await fs.writeFile(guardFile, expected);
  }
});

test('external login after saving profiles is caught at unchanged auth step and rolls profiles back', async t => {
  const f = await fixture(t, relay, null);
  await f.store.switchAccountMode('official');
  await fs.unlink(f.store.authPath);
  const before = await files(f.store);
  const externalAuth = officialAuth('login-after-profile');
  const guarded = new ConfigStore(f.home, f.store.proxyUrl, async (file, text) => {
    await atomicWrite(file, text);
    if (file === f.store.accountProfilesPath) await fs.writeFile(f.store.authPath, externalAuth);
  });
  await assert.rejects(guarded.switchAccountMode('relay'), /已回滚/);
  const after = await files(f.store);
  assert.equal(after[f.store.authPath], externalAuth);
  for (const file of Object.keys(before)) if (file !== f.store.authPath) assert.equal(after[file], before[file]);
  await assert.rejects(fs.readFile(f.store.journalPath), { code: 'ENOENT' });
  assert.equal((await f.store.status()).accountSwitch.mode, 'official');
});

test('official normalization handles dotted, inline, and nested OpenAI override definitions', () => {
  for (const config of [
    'model_provider="openai"\nmodel_providers.openai.base_url="https://custom.example"\n',
    'model_providers={openai={base_url="https://custom.example"}}\n',
    'profile="custom"\n[profiles.custom]\nmodel_provider="third"\n[model_providers.openai]\nbase_url="https://custom.example"\n[model_providers.openai.http_headers]\nAuthorization="Bearer custom"\n',
  ]) {
    const text = officialConfig(config);
    assert.equal(inspectConfig(text).id, 'openai');
    assert.equal(inspectConfig(text).baseUrl, null);
    assert.doesNotMatch(text, /Bearer custom/);
  }
});
