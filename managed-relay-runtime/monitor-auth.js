const fs = require('node:fs/promises');
const path = require('node:path');
const { atomicWrite, problem } = require('./config-store');
const { accountSite } = require('./account-sites');
const { validateAixorSession } = require('./account-aixor');

function validateToken(value, now = Date.now()) {
  if (typeof value !== 'string' || value.length > 16000) throw problem('请填写有效的账号访问令牌。', 400);
  const token = value.trim();
  if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) throw problem('请填写网站登录后的访问令牌，而不是中转 API Key。', 400);
  let claims;
  try { claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')); } catch { throw problem('账号访问令牌格式无效。', 400); }
  if (!Number.isSafeInteger(claims.exp) || claims.exp * 1000 <= now) throw problem('账号访问令牌已过期，请重新登录。', 400);
  return { token, expiresAt: claims.exp * 1000 };
}

class MonitorAuth {
  constructor(home, site = 'blackaicoding', accountId = '') {
    accountSite(site);
    if (accountId && !/^[a-f0-9]{64}$/.test(accountId)) throw problem('账号标识无效。', 400);
    this.site = site;
    this.file = home ? path.join(home, 'relay-ui-runtime', site + (accountId ? '-' + accountId : '') + '-monitor-auth.json') : null;
  }
  async read() {
    if (!this.file) return null;
    try {
      const value = JSON.parse(await fs.readFile(this.file, 'utf8'));
      return accountSite(this.site).session ? validateAixorSession(value) : validateToken(value.token);
    } catch { return null; }
  }
  async save(value) {
    if (!this.file) throw problem('账号凭据目录未配置。', 409);
    const credential = accountSite(this.site).session ? validateAixorSession(value) : validateToken(value);
    await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    await atomicWrite(this.file, JSON.stringify(credential) + '\n');
    return credential.expiresAt;
  }
  async clear() { if (this.file) await atomicWrite(this.file, null); }
}

module.exports = { MonitorAuth, validateToken };
