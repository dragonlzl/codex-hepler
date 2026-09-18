const fs = require('node:fs/promises');
const path = require('node:path');

const FIELDS = new Set([
  'event', 'at', 'startedAt', 'requestId', 'provider', 'endpoint', 'method',
  'status', 'outcome', 'phase', 'outbound', 'outboundSource', 'proxyConnectStatus',
  'pacResult', 'errorCode', 'causeCodes', 'durationMs', 'upstreamStatus',
  'responseBytes', 'responseComplete', 'headersMs', 'reachable', 'route', 'source',
  'previousProvider', 'switchReason', 'fundingSource',
]);

class Diagnostics {
  constructor(home, { maxBytes = 1024 * 1024 } = {}) {
    this.file = path.join(home, 'relay-ui-runtime', 'requests.jsonl');
    this.maxBytes = maxBytes;
    this.events = [];
    this.pending = 0;
    this.queue = Promise.resolve();
    this.errorCode = null;
  }

  record(event) {
    // Never persist request bodies, credentials, arbitrary headers or query strings.
    const entry = Object.fromEntries(Object.entries(event).filter(([key]) => FIELDS.has(key)));
    this.events.push(entry);
    if (this.events.length > 100) this.events.shift();
    if (this.pending >= 100) { this.errorCode = 'LOG_QUEUE_FULL'; return entry; }
    this.pending++;
    this.queue = this.queue.then(async () => {
      await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const line = JSON.stringify(entry) + '\n';
      const size = await fs.stat(this.file).then(s => s.size, error => { if (error.code === 'ENOENT') return 0; throw error; });
      if (size + Buffer.byteLength(line) > this.maxBytes) await fs.rename(this.file, this.file + '.1').catch(error => { if (error.code !== 'ENOENT') throw error; });
      await fs.appendFile(this.file, line, { mode: 0o600 });
      this.errorCode = null;
    }).catch(error => {
      this.errorCode = /^[A-Z0-9_]+$/.test(error.code || '') ? error.code : 'LOG_WRITE_FAILED';
    }).finally(() => { this.pending--; });
    return entry;
  }

  snapshot() { return { events: this.events.slice(), logError: this.errorCode }; }
  async close() { await this.queue; }
}

module.exports = { Diagnostics };
