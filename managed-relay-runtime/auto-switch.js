const { defaults, validateSettings, evaluate, choose, GRACE_MS, WINDOW_MS, REFRESH_MS } = require('./auto-switch-policy');

class AutoSwitch {
  constructor(store, availability, { clock = Date.now, intervalMs = REFRESH_MS, record = () => {} } = {}) {
    Object.assign(this, { store, availability, clock, intervalMs, record });
    this.generation = 0;
    this.closed = false;
    this.pending = null;
    this.failures = new Map();
    this.observationVersion = 0;
    this.waiting = null;
    this.signature = null;
    this.state = { phase: 'disabled', message: '自动切换已关闭', candidates: [], checkedAt: null, lastSwitch: null };
  }

  snapshot() { return structuredClone(this.state); }

  start() {
    if (this.closed || this.timer) return;
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    this.timer.unref?.();
    this.tick();
  }

  invalidate() {
    this.generation++;
    this.state = { ...this.state, phase: 'checking', message: '设置已变化，等待重新检测', waitUntil: null, candidates: [] };
  }

  observe(event) {
    if (this.closed || !this.settings?.enabled || !event.provider || event.status === 499 || event.outcome === 'cancelled') return;
    const key = this.keys?.find(key => key.name === event.provider);
    if (!key || event.routeId !== key.naturalAccountId) return;
    const at = Date.parse(event.at), startedAt = Date.parse(event.startedAt);
    if (!Number.isFinite(at) || startedAt < this.startedAt) return;
    const prior = this.failures.get(event.provider);
    if (prior && startedAt < prior.at) return;
    if ([401, 403].includes(event.upstreamStatus)) {
      this.failures.set(event.provider, { at, hard: true });
    } else if ((event.upstreamStatus >= 500 || event.upstreamStatus === 429 || event.outcome === 'failed') &&
      !['configuration', 'proxy-selection'].includes(event.phase) && event.errorCode !== 'PROXY_CONNECT_REJECTED') {
      this.failures.set(event.provider, { at, hard: false });
    } else if (event.outcome === 'completed' && event.status >= 200 && event.status < 300 && event.responseComplete) {
      this.failures.delete(event.provider);
    } else return;
    this.observationVersion++;
    this.tick();
  }

  tick() {
    if (this.closed) return Promise.resolve();
    if (this.pending) return this.pending;
    const generation = this.generation;
    this.pending = this.run(generation).catch(() => {
      if (generation === this.generation && !this.closed) {
        this.waiting = null;
        this.state = { ...this.state, phase: 'error', waitUntil: null, message: '自动检测或路由写入失败，保留当前路由并稍后重试' };
      }
    }).finally(() => { this.pending = null; });
    return this.pending;
  }

  async run(generation) {
    const status = await this.store.status();
    if (generation !== this.generation || this.closed) return;
    const settings = validateSettings(status.autoSwitchSettings || defaults(), status.keys);
    this.settings = settings;
    const signature = JSON.stringify([settings, this.availability.authorizationVersion,
      status.keys.map(key => [key.name, key.revision, key.accountId, key.balanceSource])]);
    if (signature !== this.signature) {
      this.waiting = null;
      this.failures.clear();
      this.startedAt = this.clock();
      this.signature = signature;
    }
    this.keys = status.keys;
    if (!settings.enabled || !status.proxyInstalled || status.writeBlocked) {
      this.waiting = null;
      this.state = { ...this.state, candidates: [], waitUntil: null, phase: !settings.enabled ? 'disabled' : 'paused',
        message: !settings.enabled ? '自动切换已关闭' : status.writeBlocked ? '配置写入被阻止，自动切换已暂停' : '尚未接入本地代理，自动切换已暂停' };
      return;
    }
    const authVersion = this.availability.authorizationVersion;
    const observationVersion = this.observationVersion;
    const keys = status.keys.filter(key => settings.pool.some(item => item.name === key.name));
    const result = await this.availability.snapshot(keys, settings.model, { automatic: true, allKeys: status.keys });
    const valid = () => !this.closed && generation === this.generation && authVersion === this.availability.authorizationVersion && observationVersion === this.observationVersion;
    if (!valid()) return;
    const now = this.clock();
    const candidates = evaluate(settings, status.keys, result.rows, now);
    for (const candidate of candidates) {
      const failure = this.failures.get(candidate.name);
      if (!failure) continue;
      if (!failure.hard && now - failure.at >= WINDOW_MS && candidate.sampleAt > failure.at && candidate.eligible) {
        this.failures.delete(candidate.name);
        continue;
      }
      candidate.eligible = false;
      candidate.currentHealth = 'unavailable';
      if (failure.hard) candidate.qualified = false;
      candidate.reason = failure.hard ? '调用 Key 认证失败，请修正 Key 或重新授权' : '实际调用失败，等待恢复检测或新的成功请求';
    }
    const active = candidates.find(item => item.name === status.activeName);
    // The recovery window governs entering a route. A recovered incumbent can keep
    // serving without being ejected merely because its own earlier red sample remains.
    const incumbent = active?.qualified && ['available', 'degraded'].includes(active.currentHealth)
      ? { ...active, eligible: true, healthRank: active.currentHealth === 'available' ? 0 : 1 } : null;
    const target = choose(candidates.map(item => item.name === incumbent?.name ? incumbent : item), status.activeName);
    this.state = { ...this.state, checkedAt: now, candidates, waitUntil: null };
    if (active?.qualified && ['unavailable', 'unknown'].includes(active.currentHealth)) {
      if (this.waiting?.name !== active.name) this.waiting = { name: active.name, since: now };
      const waitUntil = this.waiting.since + GRACE_MS;
      if (now < waitUntil) {
        this.state = { ...this.state, phase: 'waiting', waitUntil, message: active.currentHealth === 'unknown'
          ? '当前渠道状态无法确认，连续异常满 3 分钟后再切换' : '当前渠道不可用，持续检测满 3 分钟后再切换' };
        return;
      }
    } else this.waiting = null;
    if (!target) {
      this.state = { ...this.state, phase: 'no-candidate', message: '无合格候选，保留最后使用的路由并持续检测' };
      return;
    }
    if (target.name === status.activeName) {
      this.state = { ...this.state, phase: 'active', message: `正在使用${target.healthRank === 0 ? '绿色' : '黄色'}候选 · ${target.source === 'subscription' ? '订阅' : '余额'}入口` };
      return;
    }
    const reason = !active ? '选择池中最优入口' : !active.qualified ? active.reason
      : active.currentHealth === 'unavailable' ? '当前渠道持续不可用已满 3 分钟'
        : active.currentHealth === 'unknown' ? '当前渠道状态持续无法确认已满 3 分钟'
        : target.healthRank < (active.healthRank ?? 2) ? '绿色候选优先' : '优先级或订阅入口恢复';
    if (await this.store.selectAutomatic(target.name, status.autoSwitchGuard, valid)) {
      const lastSwitch = { at: now, from: status.activeName, to: target.name, reason, source: target.source };
      this.waiting = null;
      this.state = { ...this.state, phase: 'active', message: `已切换至「${target.name}」`, lastSwitch };
      this.record({ event: 'relay_auto_switch', at: new Date(now).toISOString(), provider: target.name,
        previousProvider: status.activeName, switchReason: reason, fundingSource: target.source });
    } else {
      this.state = { ...this.state, phase: 'checking', message: '配置已变化，等待下一轮重新检测' };
    }
  }

  stop() {
    this.closed = true;
    this.generation++;
    clearInterval(this.timer);
    this.timer = null;
  }

  async close() { this.stop(); await this.pending; }
}

module.exports = { AutoSwitch };
