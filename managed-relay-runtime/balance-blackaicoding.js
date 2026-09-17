const ENDPOINT = 'https://blackaicoding.com/api/v1/auth/me';

function readBlackaicodingBalance(payload) {
  // Dashboard reads auth/me's balance directly and formats it as dollars.
  // Zero and negative balances are valid; absent or malformed values are unknown.
  const amount = payload?.data?.balance;
  if (payload?.code !== 0 || !Number.isFinite(amount)) throw new Error('Invalid account balance');
  return { amount, currency: 'USD' };
}

module.exports = { ENDPOINT, readBlackaicodingBalance };
