const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { problem } = require('./config-store');

const run = promisify(execFile);
const SYSTEM_PROXY_SCRIPT = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class RelayWindowsProxy {
    [StructLayout(LayoutKind.Sequential)]
    public struct Configuration {
        [MarshalAs(UnmanagedType.Bool)] public bool AutoDetect;
        public IntPtr AutoConfigUrl;
        public IntPtr Proxy;
        public IntPtr ProxyBypass;
    }
    [DllImport("winhttp.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool WinHttpGetIEProxyConfigForCurrentUser(out Configuration config);
    [DllImport("kernel32.dll")]
    public static extern IntPtr GlobalFree(IntPtr memory);
}
'@
$config = New-Object RelayWindowsProxy+Configuration
if (-not [RelayWindowsProxy]::WinHttpGetIEProxyConfigForCurrentUser([ref]$config)) {
    if ([Runtime.InteropServices.Marshal]::GetLastWin32Error() -eq 2) { Write-Output '{}'; exit 0 }
    throw 'Unable to read Windows proxy settings'
}
try {
    [ordered]@{
        AutoConfigURL = [Runtime.InteropServices.Marshal]::PtrToStringUni($config.AutoConfigUrl)
        ProxyServer = [Runtime.InteropServices.Marshal]::PtrToStringUni($config.Proxy)
        ProxyOverride = [Runtime.InteropServices.Marshal]::PtrToStringUni($config.ProxyBypass)
    } | ConvertTo-Json -Compress
} finally {
    foreach ($pointer in @($config.AutoConfigUrl, $config.Proxy, $config.ProxyBypass)) {
        if ($pointer -ne [IntPtr]::Zero) { [void][RelayWindowsProxy]::GlobalFree($pointer) }
    }
}
`;

function windowsProxySettings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Windows proxy settings');
  const settings = {};
  if (value.ProxyOverride) settings.ExceptionsList = value.ProxyOverride.split(';').map(entry => entry.trim()).filter(Boolean);
  if (value.AutoConfigURL) {
    const pac = new URL(value.AutoConfigURL);
    if (!['http:', 'https:', 'file:'].includes(pac.protocol) || pac.username || pac.password) throw new Error('Invalid Windows PAC URL');
    settings.ProxyAutoConfigEnable = 1;
    settings.ProxyAutoConfigURLString = pac.href;
    return settings;
  }
  for (const entry of (value.ProxyServer || '').split(';').map(entry => entry.trim()).filter(Boolean)) {
    const assignment = /^([a-z][a-z0-9+.-]*)\s*=/i.exec(entry);
    const kind = assignment ? assignment[1].toUpperCase() : null;
    if (kind && !['HTTP', 'HTTPS', 'SOCKS'].includes(kind)) continue;
    const address = assignment ? entry.slice(assignment[0].length).trim() : entry;
    const url = new URL(address.includes('://') ? address : `${kind === 'SOCKS' ? 'socks4' : 'http'}://${address}`);
    const socks = ['socks:', 'socks4:', 'socks4a:', 'socks5:', 'socks5h:'].includes(url.protocol);
    if ((!socks && !['http:', 'https:'].includes(url.protocol)) || !url.hostname || url.username || url.password ||
        url.search || url.hash || (url.pathname && url.pathname !== '/') || (kind === 'SOCKS' && !socks)) throw new Error('Invalid Windows proxy address');
    const port = Number(url.port || (socks ? 1080 : url.protocol === 'https:' ? 443 : 80));
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid Windows proxy port');
    for (const prefix of socks ? ['SOCKS'] : kind ? [kind] : ['HTTP', 'HTTPS']) {
      settings[prefix + 'Enable'] = 1;
      settings[prefix + 'Proxy'] = url.hostname.replace(/^\[|\]$/g, '');
      settings[prefix + 'Port'] = port;
      settings[prefix + 'Protocol'] = url.protocol.slice(0, -1);
    }
  }
  return settings;
}

async function readWindowsProxies(options = {}) {
  if ((options.platform || process.platform) !== 'win32') return {};
  try {
    const { stdout } = await (options.run || run)('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', SYSTEM_PROXY_SCRIPT], {
      timeout: 3000, maxBuffer: 128 * 1024, windowsHide: true, encoding: 'utf8',
    });
    return windowsProxySettings(JSON.parse(stdout.replace(/^\uFEFF/, '')));
  } catch { throw problem('无法读取 Windows 系统代理，请选择直连或指定代理。', 503); }
}

module.exports = { readWindowsProxies, windowsProxySettings };
