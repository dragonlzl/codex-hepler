const { MonitorLogin } = require('./monitor-login');

class KrillLogin extends MonitorLogin {
  constructor(request, clock) {
    super(async (url, options) => {
      const json = Object.hasOwn(options.json, 'temp_token')
        ? { pending_token: options.json.temp_token, totp_code: options.json.totp_code } : options.json;
      const response = await request(url, { ...options, json });
      if (response?.success !== true || response.code !== 0) return { code: 'LOGIN_FAILED' };
      const data = response.data;
      return { code: 0, data: data?.requires_totp === true ? { requires_2fa: true, temp_token: data.pending_token }
        : { access_token: data?.token } };
    }, clock, 'krill');
  }
}

module.exports = { KrillLogin };
