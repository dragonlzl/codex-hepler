const { test } = require('node:test');
const assert = require('node:assert/strict');
const { BrowserLoginSurface, inputCommands, viewport } = require('../browser-login-surface');
const { BrowserLogin } = require('../browser-login');

const size = { width: 760, height: 780 };

test('projected login allows only bounded pointer, scroll, text and keyboard operations', () => {
  assert.deepEqual(viewport(), size);
  for (const value of [{ width: 0 }, { width: 760.5 }, { height: 5000 }]) assert.throws(() => viewport(value), /尺寸/);
  const commands = inputCommands({ type: 'text', text: 'a@example.invalid' }, size);
  assert.deepEqual(commands, [['Input.insertText', { text: 'a@example.invalid' }]]);
  assert.equal(inputCommands({ type: 'click', x: 200, y: 150 }, size).length, 2);
  assert.equal(inputCommands({ type: 'key', key: 'Tab', shift: true }, size)[0][1].modifiers, 8);
  for (const event of [{ type: 'evaluate', expression: 'private' }, { type: 'navigate', url: 'https://other.invalid' },
    { type: 'key', key: 'F12' }, { type: 'click', x: -1, y: 0 }, { type: 'click', x: 760, y: 10 },
    { type: 'scroll', x: 0, y: 0, deltaY: 900 }, { type: 'text', text: 'a'.repeat(4097) }]) assert.throws(() => inputCommands(event, size));
});

test('projection restricts input and screenshots to the official origin', async () => {
  let origin = 'https://api.aigo0.com', screenshots = 0;
  const calls = [];
  const surface = new BrowserLoginSurface(async (method, params) => {
    calls.push({ method, params });
    if (method === 'Runtime.evaluate') return { result: { value: origin } };
    if (method === 'Page.captureScreenshot') { screenshots++; return { data: 'YWlnbw==' }; }
    return {};
  }, 'private-cdp-session', size);
  await surface.setup();
  const [a, b] = await Promise.all([surface.frame(), surface.frame()]);
  assert.deepEqual(a, b); assert.equal(screenshots, 1);
  assert.deepEqual(Object.keys(a).sort(), ['height', 'image', 'mimeType', 'showingDocument', 'width']);
  await surface.input({ type: 'text', text: 'transient-value' });
  assert.ok(calls.some(call => call.method === 'Input.insertText'));
  origin = 'https://other.invalid'; calls.length = 0;
  await assert.rejects(surface.input({ type: 'text', text: 'never-send' }), /页面尚未就绪/);
  await assert.rejects(surface.frame(), /页面尚未就绪/);
  assert.ok(calls.every(call => call.method === 'Runtime.evaluate'));
});

test('terms documents open in the projected view and return closes only its document tabs', async () => {
  const targets = [{ targetId: 'login', type: 'page', url: 'https://api.aigo0.com/login' },
    { targetId: 'terms', type: 'page', url: 'https://api.aigo0.com/legal/terms' },
    { targetId: 'outside', type: 'page', url: 'https://other.invalid/legal/terms' }];
  const closed = [], sessions = [];
  const surface = new BrowserLoginSurface(async (method, params, sessionId) => {
    if (method === 'Target.getTargets') return { targetInfos: targets.filter(t => !closed.includes(t.targetId)) };
    if (method === 'Target.attachToTarget') return { sessionId: 'terms-session' };
    if (method === 'Target.closeTarget') { closed.push(params.targetId); return {}; }
    if (method === 'Runtime.evaluate') return { result: { value: 'https://api.aigo0.com' } };
    if (method === 'Page.captureScreenshot') { sessions.push(sessionId); return { data: 'YWlnbw==' }; }
    return {};
  }, 'login-session', size, 'login');
  assert.equal((await surface.frame()).showingDocument, true);
  assert.deepEqual(sessions, ['terms-session']);
  await surface.input({ type: 'back-to-login' });
  assert.equal((await surface.frame()).showingDocument, false);
  assert.deepEqual(closed, ['terms']); assert.equal(sessions.at(-1), 'login-session');
});

test('input stays ordered, while malformed input never reaches the browser', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const texts = [];
  const surface = new BrowserLoginSurface(async (method, params) => {
    if (method === 'Runtime.evaluate') return { result: { value: 'https://api.aigo0.com' } };
    if (method === 'Input.insertText') { texts.push(params.text); if (params.text === 'first') await gate; }
    return {};
  }, 'session', size);
  const a = surface.input({ type: 'text', text: 'first' }), b = surface.input({ type: 'text', text: 'second' });
  await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(texts, ['first']);
  release(); await Promise.all([a, b]); assert.deepEqual(texts, ['first', 'second']);
  assert.throws(() => surface.input({ type: 'text', text: '\0' }));
});

test('completed and window-only sessions cannot receive projected input or retain frames', async t => {
  let closed = 0, inputs = 0;
  const manager = new BrowserLogin({ launch: async (signal, options) => {
    assert.equal(options.presentation, 'embedded');
    return { readToken: async () => null, frame: async () => ({ ...size, image: 'YWlnbw==', mimeType: 'image/jpeg' }),
      input: async () => { inputs++; return { accepted: true }; }, close: async () => { closed++; } };
  } });
  t.after(() => manager.close());
  const { browserLoginId: id } = await manager.start('account', async () => {}, { presentation: 'embedded' });
  assert.equal((await manager.surface(id)).mimeType, 'image/jpeg');
  await manager.surface(id, { type: 'click', x: 1, y: 2 });
  manager.cancel(id);
  await assert.rejects(manager.surface(id), /已结束/);
  await assert.rejects(manager.surface(id, { type: 'text', text: 'not-forwarded' }), /已结束/);
  assert.equal(inputs, 1); assert.equal(closed, 1);
  assert.ok(!JSON.stringify(manager.status(id)).includes('image'));
});
