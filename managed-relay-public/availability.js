class RelayAvailability {
  constructor({ list, select, getState, isDragging }) {
    Object.assign(this, { list, select, getState, isDragging });
    this.model = 'gpt-6-astra';
    this.rows = new Map();
    this.signature = '';
    this.request = null;
    this.error = '';
    this.timer = null;
    try {
      const saved = localStorage.getItem('relay-availability-model');
      if (['gpt-6-astra', 'gpt-5.6-sol'].includes(saved)) this.model = saved;
    } catch { /* Browser storage may be disabled. */ }
    select.value = this.model;
    select.addEventListener('change', () => {
      this.model = select.value;
      try { localStorage.setItem('relay-availability-model', this.model); } catch { /* Optional preference. */ }
      this.reset();
      this.paint();
      this.refresh();
    });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.cancel(); else this.refresh();
    });
    window.addEventListener('pagehide', () => { this.cancel(); clearInterval(this.timer); this.timer = null; });
    window.addEventListener('pageshow', () => { this.start(); this.refresh(); });
    this.start();
  }

  start() { this.timer ??= setInterval(() => this.refresh(), 15000); }

  cancel() {
    this.request?.abort();
    this.request = null;
  }

  reset() {
    this.cancel();
    this.rows.clear();
    this.error = '';
  }

  sync() {
    const state = this.getState();
    const signature = JSON.stringify([state.home, state.availabilityAvailable, state.network?.mode, state.network?.proxyUrl,
      state.keys.map(entry => [entry.name, entry.baseurl]).sort((a, b) => a[0].localeCompare(b[0]))]);
    this.select.disabled = !state.availabilityAvailable;
    if (signature !== this.signature) {
      this.signature = signature;
      this.reset();
      this.refresh();
    }
    this.paint();
  }

  async refresh() {
    if (this.request || document.hidden || !this.getState().availabilityAvailable) return;
    const controller = new AbortController();
    this.request = controller;
    const signature = this.signature;
    const model = this.model;
    try {
      const response = await fetch('/api/availability?model=' + encodeURIComponent(model), {
        cache: 'no-store', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(12000)]),
      });
      if (!response.ok) throw new Error('Status request failed');
      const data = await response.json();
      if (this.request !== controller || signature !== this.signature || model !== this.model) return;
      if (data.model !== model || !Array.isArray(data.rows)) throw new Error('Invalid status response');
      this.rows = new Map(data.rows.map(row => [JSON.stringify([row.name, row.baseurl]), row]));
      this.error = '';
    } catch {
      if (this.request !== controller || controller.signal.aborted) return;
      this.error = '可用性刷新失败';
    } finally {
      if (this.request === controller) { this.request = null; this.paint(); }
    }
  }

  paint() {
    if (this.isDragging()) return;
    const state = this.getState();
    for (const row of this.list.querySelectorAll('.route')) {
      const target = row.querySelector('.route-availability');
      const entry = state.keys.find(item => item.name === row.dataset.name);
      if (!target || !entry) continue;
      const status = this.rows.get(JSON.stringify([entry.name, entry.baseurl]));
      const html = !state.availabilityAvailable
        ? '<span class="availability-empty">可用性展示需重启管理服务</span>'
        : this.markup(status);
      if (target.innerHTML !== html) target.innerHTML = html;
    }
  }

  markup(status) {
    if (status?.state === 'unsupported') return '<span class="availability-empty">可用性 · 站点未适配</span>';
    const stale = this.error || status?.state === 'stale';
    const message = this.error ? (status?.history.length ? '刷新失败，保留上次样本' : this.error) : status?.message || '正在读取状态';
    const kind = stale ? 'stale' : status?.state || 'loading';
    const capacity = status?.historyLength === 24 ? 24 : 60;
    const samples = (status?.history || []).slice(-capacity);
    const parts = Array.from({ length: capacity - samples.length }, () => '<span class="availability-sample empty" aria-hidden="true"></span>');
    for (const sample of samples) {
      const label = ({ available: '可用', degraded: '降级', unavailable: '异常', 'no-data': '无数据' })[sample.state] || (sample.ok ? '可用' : '异常');
      const detail = sample.label || new Date(sample.at).toLocaleString() + ' · ' + label +
        (sample.uptimePct == null ? '' : ' · 成功率 ' + sample.uptimePct.toFixed(2) + '%') +
        (sample.latencyMs == null ? '' : ' · 平均延迟 ' + sample.latencyMs + ' ms') +
        (sample.ttftMs == null ? '' : ' · TTFT ' + sample.ttftMs + ' ms') +
        (sample.tps == null ? '' : ' · TPS ' + sample.tps.toFixed(1) + ' t/s') + (sample.error ? '\n' + sample.error : '');
      const color = ({ available: 'ok', degraded: 'warn', unavailable: 'bad', 'no-data': 'unknown' })[sample.state] || (sample.ok ? 'ok' : 'bad');
      parts.push('<span class="availability-sample ' + color + '" title="' + escapeHtml(detail) + '" aria-hidden="true"></span>');
    }
    const pct = status?.uptimePct;
    const summary = (status?.uptimeLabel || '可用率') + ' ' + (pct == null ? '—' : pct.toFixed(2) + '%') + ' · ' + (status?.historyLabel || '样本') + ' ' + (status?.sampleCount ?? samples.length) + '/' + capacity;
    const time = at => new Date(at).toLocaleTimeString();
    const sampledAt = status?.sourceUpdatedAtLabel ? '快照时间 ' + status.sourceUpdatedAtLabel : status?.last ? (status.sampleTimeLabel || '最近采样') + ' ' + time(status.last.at) : '';
    const metrics = status?.metrics;
    const seconds = value => value == null ? '—' : (value / 1000).toFixed(2) + ' s';
    return '<div class="availability-meta"><code>' + escapeHtml(this.model) + '</code>' +
      (status?.groupLabel ? '<span class="availability-group">' + escapeHtml(status.groupLabel) + '</span>' : '') +
      '<span class="availability-state ' + kind + '">' + escapeHtml(message) + '</span>' +
      (status?.source ? '<a href="' + escapeHtml(status.source.url) + '" target="_blank" rel="noopener noreferrer">站点状态 ↗</a>' : '') + '</div>' +
      '<div class="availability-stats"><span>' + (stale ? '上次样本 · ' : '') + escapeHtml(summary) + '</span>' +
      (sampledAt ? '<span>' + escapeHtml(sampledAt) + '</span>' : '') + '</div>' +
      (metrics ? '<div class="availability-metrics"><span>TPS ' + (metrics.tps == null ? '—' : metrics.tps.toFixed(1) + ' t/s') + '</span><span>首 Token ' + seconds(metrics.ttftMs) + '</span><span>平均延迟 ' + seconds(metrics.latencyMs) + '</span></div>' : '') +
      '<div class="availability-bars' + (stale ? ' stale' : '') + '" data-columns="' + capacity + '" role="img" aria-label="' + escapeHtml(this.model + ' · ' + (status?.groupLabel || '') + ' · ' + message + ' · ' + summary) + '">' + parts.join('') + '</div>' +
      '<div class="availability-axis"><span>' + (samples.length ? escapeHtml(samples[0].timeLabel || time(samples[0].at)) : '暂无采样') + '</span><span>' + (samples.length ? escapeHtml(samples.at(-1).endTimeLabel || time(samples.at(-1).at)) : '—') + '</span></div>';
  }
}
