const { problem } = require('./config-store');
const BALANCE_ENDPOINT = 'https://www.rightapi.ai/auth/me';

function validateRightcodeToken(value) {
  const token = typeof value === 'string' ? value.trim() : '';
  if (!/^[A-Za-z0-9._~+-]{16,16000}$/.test(token) || token.startsWith('sk-')) throw problem('请填写 RC 登录后的 userToken，而不是中转 API Key。', 400);
  // RC uses an opaque account token; expiry is determined by /auth/me, not guessed.
  return { token, expiresAt: null };
}

function readRightcodeBalance(payload) {
  const value = payload?.balance;
  if (!payload || payload.error || payload.status >= 400 ||
      !(typeof value === 'number' || typeof value === 'string' && /^-?\d+(?:\.\d+)?$/.test(value.trim())) || !Number.isFinite(Number(value))) {
    throw new Error('Invalid RC account balance');
  }
  return { amount: Number(value), currency: 'USD' };
}

module.exports = { BALANCE_ENDPOINT, validateRightcodeToken, readRightcodeBalance };
