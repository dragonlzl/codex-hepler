const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../../managed-relay-public/monitor-auth.js'), 'utf8');

function setup() {
  const elements = new Map(), requests = [], verifications = [], toasts = [];
  let options = { agreement: false, privacy: false, captcha: { appId: '123', aidEncrypted: 'fixture' } }, reads = 0;
  function element(selector) {
    if (!elements.has(selector)) {
      const listeners = new Map();
      elements.set(selector, {
        hidden: false, disabled: false, checked: false, value: '', innerHTML: '', textContent: '',
        addEventListener: (event, listener) => listeners.set(event, listener),
        focus() { this.focused = true; }, setAttribute() {},
        querySelector: child => element(selector + ' ' + child),
        showModal() { this.open = true; },
        close() { this.open = false; listeners.get('close')?.(); },
      });
    }
    return elements.get(selector);
  }
  const form = element('#monitor-auth-form');
  const fields = Object.fromEntries(['username', 'password', 'agreement', 'code', 'token', 'userId'].map(name => [name, element(name)]));
  form.elements = Object.assign(Object.values(fields), fields);
  form.reset = () => { for (const control of form.elements) { control.value = ''; control.checked = false; } };
  const View = vm.runInNewContext(source + '\nMonitorAuthorization;', {
    document: { querySelector: element }, window: { addEventListener() {} },
    setTimeout, clearTimeout, AbortSignal,
    fetch: async () => ({ ok: true }),
    ProjectedLogin: class { enableControls() {} stop() {} },
    PackyLoginChallenge: class {
      async options() { reads++; if (options instanceof Error) throw options; return options; }
      async verify(captcha) { verifications.push(captcha); return { ticket: 'fixture-ticket', randstr: 'fixture-rand' }; }
    },
  });
  const view = new View(async () => {});
  view.showToast = message => toasts.push(message);
  view.send = async (endpoint, payload) => { requests.push({ endpoint, payload }); return { message: '已保存授权' }; };
  return { view, fields, element, requests, verifications, toasts, reads: () => reads, options: value => { options = value; } };
}

test('Packy terms are visible before submitting and declining sends no requests or captcha', async () => {
  const client = setup();
  client.view.open('packycode', 'Packy A');
  assert.equal(client.element('#monitor-auth-agreement').hidden, false);
  assert.equal(client.fields.agreement.required, true);
  assert.equal(client.fields.agreement.checked, false);
  const links = client.element('#monitor-agreement-links').innerHTML;
  assert.deepEqual([...links.matchAll(/href="([^"]+)"/g)].map(match => match[1]), [
    'https://www.packyapi.com/terms', 'https://www.packyapi.com/usage-policy',
    'https://www.packyapi.com/supported-regions', 'https://www.packyapi.com/service-specific-terms',
  ]);
  client.fields.username.value = 'normal'; client.fields.password.value = 'fixture-password';
  await client.view.login();
  assert.match(client.view.feedback.textContent, /请先阅读并同意/);
  assert.equal(client.fields.password.value, 'fixture-password');
  assert.equal(client.reads(), 0); assert.equal(client.requests.length, 0); assert.equal(client.verifications.length, 0);
  client.view.dialog.close();
  assert.equal(client.fields.password.value, '');
});

test('new terms consent proceeds through captcha when both legacy agreement flags are disabled', async () => {
  const client = setup();
  client.view.open('packycode', 'Packy A');
  client.fields.username.value = 'normal'; client.fields.password.value = 'fixture-password'; client.fields.agreement.checked = true;
  await client.view.login();
  assert.equal(client.reads(), 1); assert.equal(client.verifications.length, 1); assert.equal(client.requests.length, 1);
  const { endpoint, payload } = client.requests[0];
  assert.equal(endpoint, '/api/availability/login');
  assert.equal(payload.agreement, true); assert.equal(payload.password, 'fixture-password');
  assert.equal(payload.captcha.ticket, 'fixture-ticket');
  assert.equal(client.view.dialog.open, false); assert.equal(client.fields.password.value, '');
  assert.deepEqual(client.toasts, ['已保存授权']);
});

test('newly enabled legacy documents require fresh consent without clearing entered credentials', async () => {
  const client = setup();
  client.view.open('packycode', 'Packy A');
  client.options({ agreement: true, privacy: true, captcha: null });
  client.fields.username.value = 'normal'; client.fields.password.value = 'fixture-password'; client.fields.agreement.checked = true;
  await client.view.login();
  const links = client.element('#monitor-agreement-links').innerHTML;
  assert.match(links, /\/terms"/); assert.match(links, /\/user-agreement"/); assert.match(links, /\/privacy-policy"/);
  assert.equal(client.fields.agreement.checked, false); assert.equal(client.fields.password.value, 'fixture-password');
  assert.equal(client.view.busy, false); assert.equal(client.verifications.length, 0); assert.equal(client.requests.length, 0);
  assert.match(client.view.feedback.textContent, /重新勾选/);
  client.fields.agreement.checked = true;
  await client.view.login();
  assert.equal(client.requests.length, 1); assert.equal(client.requests[0].payload.agreement, true);
});

test('failed bootstrap can retry with the entered password and explicit consent intact', async () => {
  const client = setup();
  client.view.open('packycode', 'Packy A');
  client.fields.username.value = 'normal'; client.fields.password.value = 'fixture-password'; client.fields.agreement.checked = true;
  client.options(new Error('无法读取登录设置'));
  await client.view.login();
  assert.equal(client.view.busy, false); assert.equal(client.fields.password.value, 'fixture-password');
  assert.equal(client.fields.agreement.checked, true); assert.equal(client.requests.length, 0);
  assert.match(client.view.feedback.textContent, /无法读取登录设置/);
  client.options({ agreement: false, privacy: false, captcha: null });
  await client.view.login();
  assert.equal(client.requests.length, 1);
});

test('two-factor continuation uses the existing challenge without a second terms or captcha step', async () => {
  const client = setup();
  client.view.open('packycode', 'Packy A');
  client.view.send = async (endpoint, payload) => {
    client.requests.push({ endpoint, payload });
    return payload.challengeId ? { message: '已保存授权' } : { requires2fa: true, challengeId: 'fixture-challenge', message: '请输入验证码' };
  };
  client.fields.username.value = 'otp'; client.fields.password.value = 'fixture-password'; client.fields.agreement.checked = true;
  await client.view.login();
  assert.equal(client.view.challengeId, 'fixture-challenge'); assert.equal(client.view.loginFields.hidden, true);
  assert.equal(client.fields.password.value, '');
  client.fields.code.value = '123456';
  await client.view.login();
  assert.equal(client.reads(), 1); assert.equal(client.verifications.length, 1); assert.equal(client.requests.length, 2);
  assert.equal(client.requests[1].payload.code, '123456'); assert.equal(client.requests[1].payload.agreement, undefined);
  assert.equal(client.view.dialog.open, false);
});

test('reopening or switching accounts does not reuse Packy consent or change other provider requirements', () => {
  const client = setup();
  client.view.open('packycode', 'Packy A'); client.fields.agreement.checked = true;
  client.view.dialog.close(); client.view.open('packycode', 'Packy B');
  assert.equal(client.fields.agreement.checked, false);
  client.view.dialog.close(); client.view.open('input', 'INPUT');
  assert.equal(client.element('#monitor-auth-agreement').hidden, true); assert.equal(client.fields.agreement.required, false);
  client.view.dialog.close(); client.view.open('aixor', 'Aixor');
  assert.equal(client.element('#monitor-auth-agreement').hidden, false); assert.equal(client.fields.agreement.required, true);
  assert.match(client.element('#monitor-agreement-links').innerHTML, /https:\/\/aixor.cc\/user-agreement/);
});
