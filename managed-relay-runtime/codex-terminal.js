const fs = require('node:fs/promises');
const { launchCli } = require('./codex-cli-launch');
const { bypassList } = require('./codex-launch');

async function report(file, value) {
  await fs.writeFile(file + '.tmp', JSON.stringify(value), { mode: 0o600 });
  await fs.rename(file + '.tmp', file);
}

// This runner stays with the foreground CLI, independent of the relay server.
// It receives only a local, private manifest created by the launcher.
async function runTerminal(file) {
  const job = JSON.parse(await fs.readFile(file, 'utf8'));
  await fs.unlink(file); // A delayed/repeated terminal open cannot reuse the job.
  if (Date.now() > job.expiresAt) throw new Error('启动请求已过期，请回到页面重新启动 CLI。');
  try {
    await report(job.report, { state: 'running', pid: process.pid, cwd: job.cwd });
    const bypass = bypassList(process.env.NO_PROXY, process.env.no_proxy, job.env.NO_PROXY, job.env.no_proxy);
    const result = await launchCli({ env: { ...process.env, ...job.env, NO_PROXY: bypass, no_proxy: bypass }, cwd: job.cwd, argv: [] });
    await report(job.report, { state: 'exited', code: result.code });
    process.exitCode = result.code;
  } catch (error) {
    await report(job.report, { state: 'failed', message: error.message });
    throw error;
  }
}

if (require.main === module) runTerminal(process.argv[2]).catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { runTerminal, report };
