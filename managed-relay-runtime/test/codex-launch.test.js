const { test } = require('node:test');
const assert = require('node:assert/strict');
const { bypassList, launchArguments } = require('../codex-launch');

test('Codex launch preserves both existing bypass lists and adds local addresses once', () => {
  assert.equal(bypassList('.internal,127.0.0.1', 'localhost, 10.0.0.0/8'), '.internal,127.0.0.1,localhost,10.0.0.0/8,::1');
  assert.deepEqual(launchArguments('/Applications/Codex.app', [undefined, '']), [
    '-a', '/Applications/Codex.app', '--env', 'NO_PROXY=127.0.0.1,localhost,::1', '--env', 'no_proxy=127.0.0.1,localhost,::1',
  ]);
});
