const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { launchContext } = require('./codex-launch');
const { configPath, loadCodexConfig, expandPath } = require('./codex-config');

// PowerShell literals are data, including spaces, apostrophes and shell metacharacters.
const psQuote = value => "'" + String(value).replace(/'/g, "''") + "'";
const encodedCommand = text => Buffer.from(text, 'utf16le').toString('base64');
const powershellPath = env => path.win32.join(env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

async function findCli({ env = process.env, platform = process.platform, config = loadCodexConfig(configPath(env)), stat = fs.stat, access = fs.access } = {}) {
  const explicit = expandPath(env.CODEX_CLI_PATH || config.codexCliPath, env);
  const names = platform === 'win32' ? ['codex.exe', 'codex.cmd'] : ['codex'];
  const p = platform === 'win32' ? path.win32 : path;
  const searchPath = env.PATH || env.Path || '';
  const dirs = searchPath.split(platform === 'win32' ? ';' : ':').map(s => s.replace(/^"|"$/g, '')).filter(Boolean);
  if (platform === 'darwin') dirs.push(path.join(os.homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin');
  if (platform === 'win32' && env.APPDATA) dirs.push(p.join(env.APPDATA, 'npm'));
  const candidates = explicit ? [explicit] : [...new Set(dirs)].flatMap(dir => names.map(name => p.join(dir, name)));
  for (const file of candidates) {
    if (platform === 'win32' && !/\.(exe|cmd)$/i.test(file)) continue;
    try {
      if (!(await stat(file)).isFile()) continue;
      await access(file, platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
      return file;
    } catch { /* Try next PATH entry. */ }
  }
  throw new Error('未找到可运行的 Codex CLI。请先安装 CLI，或设置 CODEX_CLI_PATH / 配置文件中的 codexCliPath 为可执行文件完整路径，然后重启中转服务。');
}

async function workingDirectory(value = process.cwd()) {
  if (typeof value !== 'string' || !value.trim() || /[\0\r\n]/.test(value)) throw new Error('请填写有效的 CLI 工作目录。');
  const cwd = expandPath(value);
  if (!(await fs.stat(cwd).catch(() => null))?.isDirectory()) throw new Error('CLI 工作目录不存在或不是文件夹。');
  return cwd;
}

function cliCommand(executable, args = [], platform = process.platform, env = process.env) {
  // npm installs a .cmd shim on Windows; invoke it inside PowerShell without
  // interpolating unquoted paths into cmd.exe or enabling shell:true.
  if (platform === 'win32' && /\.cmd$/i.test(executable)) {
    return { file: powershellPath(env), args: ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand',
      encodedCommand(`& ${[executable, ...args].map(psQuote).join(' ')}; exit $LASTEXITCODE`)] };
  }
  return { file: executable, args };
}

async function launchCli(options = {}) {
  const platform = options.platform || process.platform;
  if (!['darwin', 'win32'].includes(platform)) throw new Error('此启动入口仅支持 macOS 和 Windows。');
  const context = await launchContext(options);
  const executable = await findCli({ ...options, env: context.env });
  const cwd = await workingDirectory(options.cwd);
  const argv = options.argv || [];
  if (argv.length === 1 && argv[0] === '--check') return { message: '检查通过：Codex CLI 与本地代理可用。', executable, home: context.home, cwd, code: 0 };
  const args = argv[0] === '--' ? argv.slice(1) : argv;
  const command = cliCommand(executable, args, platform, context.env);
  const code = await new Promise((resolve, reject) => {
    const child = (options.spawn || spawn)(command.file, command.args, { cwd, env: context.env, stdio: 'inherit' });
    // The foreground terminal sends Ctrl+C to both processes; keep the wrapper
    // alive until the CLI exits so session status remains accurate.
    const onInterrupt = () => {};
    process.on('SIGINT', onInterrupt);
    child.once('error', error => { process.off('SIGINT', onInterrupt); reject(error); });
    child.once('exit', (exitCode, signal) => { process.off('SIGINT', onInterrupt); resolve(exitCode ?? (signal === 'SIGINT' ? 130 : 1)); });
  });
  return { code, executable, cwd, home: context.home };
}

if (require.main === module) launchCli({ argv: process.argv.slice(2) }).then(result => {
  if (result.message) { console.log(result.message); console.log('CLI：' + result.executable); console.log('工作目录：' + result.cwd); console.log('Codex 配置目录：' + result.home); }
  process.exitCode = result.code;
}).catch(error => { console.error(error.message); process.exitCode = 1; });

module.exports = { findCli, workingDirectory, cliCommand, launchCli, psQuote, encodedCommand, powershellPath };
