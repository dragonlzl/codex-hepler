const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { atomicWrite } = require('./config-store');

// Only confirmed negative funding evidence is retained. It never qualifies an
// unknown candidate or treats an old positive amount as currently spendable.
class AutoSwitchFunding {
  constructor(home) {
    this.file = path.join(home, 'relay-ui-runtime', 'auto-switch-funding.json');
    this.records = new Map();
    this.loaded = false;
    this.dirty = false;
    this.warning = '';
  }

  async load() {
    if (this.loaded) return;
    let value;
    try { value = JSON.parse(await fs.readFile(this.file, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (value !== undefined) {
      if (value?.version !== 1 || !Array.isArray(value.records) || value.records.length > 500) throw new Error('Invalid funding evidence');
      const records = new Map();
      for (const record of value.records) {
        if (!/^[a-f0-9]{64}$/.test(record?.id) || records.has(record.id) ||
          !Number.isFinite(record.fetchedAt) || record.fetchedAt < 0 ||
          !Number.isFinite(record.confirmedAt) || record.confirmedAt < 0 ||
          !['insufficient', 'inactive'].includes(record.issue) ||
          (record.issue === 'insufficient' && !Number.isFinite(record.remaining)) ||
          typeof record.reason !== 'string' || record.reason.length > 500) throw new Error('Invalid funding evidence');
        records.set(record.id, record);
      }
      this.records = records;
    }
    this.loaded = true;
  }

  identity(item, keys) {
    const key = keys.find(key => key.name === item.name);
    if (!key?.naturalAccountId || !key.accountId) return null;
    const keyBalance = item.source === 'balance' && key.merchantId === 'packycode' && key.balanceSource !== 'account';
    const sourceKey = keyBalance && key.accountBindingId ? keys.find(entry => entry.name === key.accountSourceName) : key;
    return createHash('sha256').update(JSON.stringify([
      key.naturalAccountId, key.accountId, item.source,
      item.source === 'subscription' ? item.subscriptionId : key.balanceSource || 'account',
      keyBalance ? sourceKey?.naturalAccountId : null,
    ])).digest('hex');
  }

  reconcile(settings, keys) {
    const current = new Set(settings.pool.map(item => this.identity(item, keys)).filter(Boolean));
    for (const id of this.records.keys()) if (!current.has(id)) {
      this.records.delete(id);
      this.dirty = true;
    }
  }

  apply(settings, keys, candidates, now) {
    for (const candidate of candidates) {
      const id = this.identity(candidate, keys);
      if (!id) continue;
      let record = this.records.get(id);
      const fetchedAt = candidate.fundingFetchedAt;
      if (candidate.fundingState === 'unavailable' && candidate.fundingIssue && Number.isFinite(fetchedAt) &&
        (!record || fetchedAt >= record.fetchedAt)) {
        // Refreshing the same cached result is not a new confirmation.
        if (!record || fetchedAt > record.fetchedAt || candidate.fundingIssue !== record.issue || candidate.remaining !== record.remaining) {
          record = { id, fetchedAt, confirmedAt: now, issue: candidate.fundingIssue,
            remaining: candidate.remaining, reason: candidate.fundingReason };
          this.records.set(id, record);
          this.dirty = true;
        }
      } else if (record && candidate.fundingState === 'available' && fetchedAt > record.fetchedAt) {
        this.records.delete(id);
        this.dirty = true;
        record = null;
      }
      if (!record) continue;
      const minimum = candidate.source === 'subscription' ? settings.subscriptionMinimum : settings.balanceMinimum;
      // A user lowering M/N can make the old amount cease to be negative
      // evidence. It still does not make a failed query qualify a candidate.
      if (record.issue === 'insufficient' && record.remaining > 0 && record.remaining >= minimum) continue;
      candidate.fundingConfirmedAt = record.confirmedAt;
      if (candidate.fundingState === 'unavailable' && fetchedAt >= record.fetchedAt) continue;
      const label = record.issue === 'inactive' ? '套餐失效' : '额度不足';
      const reason = '上次确认' + label + '（' + record.reason + '），尚未确认恢复；等待重新查询';
      Object.assign(candidate, { fundingState: 'unavailable', fundingIssue: record.issue,
        fundingReason: reason, reason, qualified: false, eligible: false, fundingRetained: true,
        remaining: record.remaining, unlimited: false });
    }
  }

  async save() {
    if (!this.dirty) return;
    try {
      await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      await atomicWrite(this.file, JSON.stringify({ version: 1, records: [...this.records.values()] }) + '\n');
      this.dirty = false;
      this.warning = '';
    } catch {
      // A disk error must not delay a confirmed failover. Keep the evidence in
      // memory and retry persistence on the next cycle without claiming success.
      this.warning = '额度排除记录保存失败，本次运行仍保留；重启后可能丢失';
    }
  }
}

module.exports = { AutoSwitchFunding };
