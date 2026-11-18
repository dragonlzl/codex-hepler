const { problem } = require('./config-store');

// Classify connectivity failures without inferring whether a VPN is in use.
// Authentication and local file errors keep their own remedies; raw exceptions stay private.
function networkAccessError(error, site = '该站点', signal) {
  const reasons = {
    ECONNRESET: '连接被重置，ECONNRESET', ECONNREFUSED: '连接被拒绝，ECONNREFUSED',
    ENOTFOUND: '域名解析失败，ENOTFOUND', EAI_AGAIN: '域名解析暂时失败，EAI_AGAIN',
    ENETUNREACH: '网络不可达，ENETUNREACH', EHOSTUNREACH: '站点不可达，EHOSTUNREACH',
    EPIPE: '连接已断开，EPIPE', EPROTO: 'TLS 握手失败，EPROTO',
    ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR: 'TLS 握手失败，ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR',
    PACKY_DNS_FAILED: 'Packycode 安全域名解析失败', PACKY_DNS_TIMEOUT: 'Packycode 安全域名解析超时',
  };
  const code = error?.code || error?.cause?.code;
  const timeout = signal?.aborted || ['AbortError', 'TimeoutError'].includes(error?.name) ||
    ['ETIMEDOUT', 'ESOCKETTIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT'].includes(code);
  const reason = timeout ? '请求超时' : Object.hasOwn(reasons, code) ? reasons[code] : null;
  if (!reason) return null;
  const guidance = !timeout && ['EPROTO', 'ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR'].includes(code)
    ? '当前网络与站点的 TLS 协商失败，不代表账号密码错误。Wi-Fi 或路由器已提供 VPN 时可保持直连，无需叠加本机代理。请稍后重试或检查「运行与连接 → 上游网络」。'
    : '请检查当前网络及「运行与连接 → 上游网络」设置后重试；需要代理时，请确认所选线路可用。';
  return problem('无法访问' + site + '（' + reason + '）。' + guidance, timeout ? 504 : 502);
}

module.exports = { networkAccessError };
