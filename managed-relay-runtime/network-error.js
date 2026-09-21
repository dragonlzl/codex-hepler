const { problem } = require('./config-store');

// Only connectivity failures suggest VPN use. Authentication, rate limits and
// local file errors must keep their own remedies. Never expose raw exceptions.
function networkAccessError(error, site = '该站点', signal) {
  const reasons = {
    ECONNRESET: '连接被重置，ECONNRESET', ECONNREFUSED: '连接被拒绝，ECONNREFUSED',
    ENOTFOUND: '域名解析失败，ENOTFOUND', EAI_AGAIN: '域名解析暂时失败，EAI_AGAIN',
    ENETUNREACH: '网络不可达，ENETUNREACH', EHOSTUNREACH: '站点不可达，EHOSTUNREACH',
    EPIPE: '连接已断开，EPIPE',
    PACKY_DNS_FAILED: 'Packycode 安全域名解析失败', PACKY_DNS_TIMEOUT: 'Packycode 安全域名解析超时',
  };
  const code = error?.code || error?.cause?.code;
  const timeout = signal?.aborted || ['AbortError', 'TimeoutError'].includes(error?.name) ||
    ['ETIMEDOUT', 'ESOCKETTIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT'].includes(code);
  const reason = timeout ? '请求超时' : Object.hasOwn(reasons, code) ? reasons[code] : null;
  if (!reason) return null;
  return problem('无法访问' + site + '（' + reason + '）。请开启 VPN 或配置可用代理后重试；已开启 VPN 时，请检查「运行与连接 → 上游网络」的代理设置。', timeout ? 504 : 502);
}

module.exports = { networkAccessError };
