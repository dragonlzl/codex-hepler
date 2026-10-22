const net = require('node:net');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const run = promisify(execFile);
const problem = (message, status = 409) => Object.assign(new Error(message), { status });
const SYSTEM_PROXY_SCRIPT = `ObjC.import('Foundation');
$.NSBundle.bundleWithPath('/System/Library/Frameworks/SystemConfiguration.framework').load;
ObjC.bindFunction('SCDynamicStoreCopyProxies', ['id', ['void *']]);
JSON.stringify(ObjC.deepUnwrap($.SCDynamicStoreCopyProxies(null)));`;
const FLYINGBIRD_PROCESS = '/Applications/FlyingBird-Lite.app/Contents/MacOS/FlyingBirdCore';
const FLYINGBIRD_PORT = 7892;

async function readMacProxies() {
  if (process.platform !== 'darwin') return {};
  try {
    const { stdout } = await run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', SYSTEM_PROXY_SCRIPT], { timeout: 3000, maxBuffer: 128 * 1024 });
    const data = JSON.parse(stdout);
    if (!data || typeof data !== 'object') throw new Error();
    return data;
  } catch { throw problem('无法读取 macOS 系统代理，请选择直连或指定代理。', 503); }
}

async function detectFlyingBirdProxy(options = {}) {
  if ((options.platform || process.platform) !== 'darwin') return null;
  const runCommand = options.run || run;
  const processPath = options.processPath || FLYINGBIRD_PROCESS;
  const port = Number(options.port || FLYINGBIRD_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  let stdout;
  try {
    ({ stdout } = await runCommand('/usr/bin/pgrep', ['-f', processPath], { timeout: 1500, maxBuffer: 16 * 1024 }));
  } catch { return null; }
  const pids = stdout.split(/\s+/).map(Number).filter(Number.isInteger);
  for (const pid of pids) {
    try {
      const result = await runCommand('/usr/sbin/lsof', ['-nP', '-a', '-p', String(pid), '-iTCP', '-sTCP:LISTEN'], { timeout: 1500, maxBuffer: 32 * 1024 });
      if (new RegExp(`TCP\\s+[^\\n]*:${port}\\s+\\(LISTEN\\)`).test(result.stdout)) {
        return { proxyUrl: `http://127.0.0.1:${port}`, source: 'flyingbird-auto', port, pid };
      }
    } catch { /* Process may exit while the app is toggling. */ }
  }
  return null;
}

function loopback(host) {
  const value = host.toLowerCase().replace(/^\[|\]$/g, '');
  return value === 'localhost' || value.endsWith('.localhost') || value === '::1' || value.startsWith('::ffff:127.') || /^127\./.test(value);
}

function bypasses(hostname, settings) {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (settings.ExcludeSimpleHostnames && !host.includes('.') && !host.includes(':')) return true;
  return (settings.ExceptionsList || []).some(value => {
    if (typeof value !== 'string') return false;
    const pattern = value.toLowerCase();
    if (pattern.includes('/')) {
      const [address, prefix] = pattern.split('/');
      const version = net.isIP(address);
      if (!version || net.isIP(host) !== version) return false;
      try { const block = new net.BlockList(); block.addSubnet(address, Number(prefix), version === 4 ? 'ipv4' : 'ipv6'); return block.check(host, version === 4 ? 'ipv4' : 'ipv6'); } catch { return false; }
    }
    if (pattern === '<local>') return !host.includes('.');
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    return new RegExp(`^${escaped}$`, 'i').test(host);
  });
}

function systemProxyFor(target, settings) {
  if (loopback(target.hostname) || bypasses(target.hostname, settings)) return { proxyUrl: '', source: 'system-bypass' };
  if (settings.ProxyAutoConfigEnable && settings.ProxyAutoConfigURLString) {
    const pac = new URL(settings.ProxyAutoConfigURLString);
    if (!['http:', 'https:', 'file:'].includes(pac.protocol)) throw problem('系统 PAC 地址协议不支持。', 503);
    return { proxyUrl: 'pac+' + pac.href, source: 'system-pac' };
  }
  const prefix = ['https:', 'wss:'].includes(target.protocol) ? 'HTTPS' : 'HTTP';
  const kind = settings[prefix + 'Enable'] ? prefix : settings.SOCKSEnable ? 'SOCKS' : null;
  if (!kind) {
    if (settings.ProxyAutoDiscoveryEnable) throw problem('当前只启用了 WPAD 自动发现，请指定 VPN 的本机代理地址。', 503);
    return { proxyUrl: '', source: 'direct' };
  }
  const host = settings[kind + 'Proxy'];
  const port = Number(settings[kind + 'Port']);
  if (typeof host !== 'string' || !host || !Number.isInteger(port) || port < 1 || port > 65535) throw problem('系统代理地址或端口无效。', 503);
  const hostPart = net.isIP(host) === 6 ? `[${host}]` : host;
  // macOS HTTPSProxy is an HTTP CONNECT proxy, not necessarily TLS to the proxy itself.
  const protocol = settings[kind + 'Protocol'] || (kind === 'SOCKS' ? 'socks5h' : 'http');
  return { proxyUrl: `${protocol}://${hostPart}:${port}`, source: 'system-' + kind.toLowerCase() };
}

module.exports = { readMacProxies, detectFlyingBirdProxy, systemProxyFor, bypasses, loopback };
