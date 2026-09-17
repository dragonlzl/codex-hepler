const { problem } = require('./config-store');

const ACCOUNT_SITES = Object.freeze({
  blackaicoding: Object.freeze({ name: 'code for me', origin: 'https://blackaicoding.com' }),
  input: Object.freeze({ name: 'INPUT', origin: 'https://ai.input.im' }),
  aixor: Object.freeze({ name: 'Aixor', origin: 'https://aixor.cc', session: true }),
  packycode: Object.freeze({ name: 'Packycode', origin: 'https://www.packyapi.com', session: true }),
  krill: Object.freeze({ name: 'Krill', origin: 'https://www.krill-code.com' }),
  rightcode: Object.freeze({ name: 'RC', origin: 'https://www.rightapi.ai' }),
  timicc: Object.freeze({ name: 'timiCC', origin: 'https://timicc.com' }),
});

function accountSite(id) {
  if (!Object.hasOwn(ACCOUNT_SITES, id)) throw problem('该站点不支持账号授权。', 400);
  return ACCOUNT_SITES[id];
}

function loginEndpoints(id) {
  const origin = accountSite(id).origin;
  if (id === 'aixor') return { login: origin + '/api/user/login?turnstile=', totp: origin + '/api/user/login/2fa' };
  if (id === 'packycode') return { login: origin + '/api/user/login', totp: origin + '/api/user/login/2fa' };
  if (id === 'krill') return { login: origin + '/api/auth/login', totp: origin + '/api/auth/login/totp' };
  if (id === 'rightcode') return { login: origin + '/auth/login' };
  return { login: origin + '/api/v1/auth/login', totp: origin + '/api/v1/auth/login/2fa' };
}

module.exports = { ACCOUNT_SITES, accountSite, loginEndpoints };
