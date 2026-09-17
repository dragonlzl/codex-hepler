class RelayAvailability {
  constructor({ list, select, getState, isDragging, onChange, mutateBalanceSource }) {
    Object.assign(this, { list, select, getState, isDragging, onChange });
    this.model = 'gpt-6-astra';
    this.rows = new Map();
    this.signature = '';
    this.request = null;
    this.error = '';
    this.timer = null;
    this.balancePoll = null;
    this.packy = new PackyBalanceControls(list, () => { this.reset(); this.paint(); this.refresh(); }, { getState, mutateBalanceSource });
    const authorization = new MonitorAuthorization(async () => { this.reset(); await this.refresh(); });
    list.addEventListener('click', event => {
      const button = event.target.closest('.monitor-auth-button');
      if (!button) return;
      const account = button.closest('.provider-account');
      authorization.open(button.dataset.site, account.dataset.name, account.dataset.accountId);
    });
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
    window.addEventListener('pagehide', () => { this.cancel(); clearInterval(this.timer); clearTimeout(this.balancePoll); this.timer = null; this.balancePoll = null; });
    window.addEventListener('pageshow', () => { this.start(); this.refresh(); });
    this.start();
  }

  start() { this.timer ??= setInterval(() => this.refresh(), 15000); }

  cancel() {
    this.request?.abort();
    this.request = null;
    clearTimeout(this.balancePoll); this.balancePoll = null;
  }

  reset() {
    this.cancel();
    this.rows.clear();
    this.error = '';
    if (!this.isDragging()) this.onChange?.();
  }

  static sampleColor(sample) {
    return ({ available: 'ok', degraded: 'warn', unavailable: 'bad', 'no-data': 'unknown' })[sample?.state]
      || (sample?.ok === true ? 'ok' : sample?.ok === false ? 'bad' : 'unknown');
  }

  static filterState(status) {
    const history = status?.history;
    if (status?.state === 'unsupported' || !Array.isArray(history) || !history.length) return null;
    // Empty grid slots are not detections. Once a history exists, use its final
    // displayed slot, even if that slot is yellow/grey or the overall state differs.
    const hasDetection = Number.isInteger(status.sampleCount) ? status.sampleCount > 0
      : history.some(sample => RelayAvailability.sampleColor(sample) !== 'unknown');
    if (!hasDetection) return null;
    return RelayAvailability.sampleColor(history.at(-1)) === 'bad' ? 'unavailable' : 'available';
  }

  filterFor(entry) {
    if (!entry || !this.getState().availabilityAvailable) return null;
    return RelayAvailability.filterState(this.rows.get(JSON.stringify([entry.name, entry.baseurl])));
  }

  sync() {
    const state = this.getState();
    const signature = JSON.stringify([state.home, state.accountBindingsRevision, state.availabilityAvailable, state.network?.mode, state.network?.proxyUrl,
      state.keys.map(entry => [entry.name, entry.baseurl, entry.revision, entry.balanceSource]).sort((a, b) => a[0].localeCompare(b[0]))]);
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
    if (!this.isDragging()) this.onChange?.();
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
      if (this.request === controller) {
        this.request = null; this.paint();
        clearTimeout(this.balancePoll); this.balancePoll = null;
        if ([...this.rows.values()].some(row => row.balance?.kind === 'packy-key' && row.balance.refreshing)) this.balancePoll = setTimeout(() => this.refresh(), 2000);
      }
    }
  }

  paint() {
    if (this.isDragging()) return;
    const state = this.getState();
    const statusFor = name => {
      const entry = state.keys.find(item => item.name === name);
      return entry && this.rows.get(JSON.stringify([entry.name, entry.baseurl]));
    };
    for (const target of this.list.querySelectorAll('.provider-availability')) {
      const status = statusFor(target.dataset.name);
      const html = !state.availabilityAvailable ? '<span class="availability-empty">可用性展示需重启管理服务</span>' : this.markup(status);
      if (target.innerHTML !== html) target.innerHTML = html;
    }
    for (const account of this.list.querySelectorAll('.provider-account')) {
      const status = statusFor(account.dataset.name);
      const sourceControl = account.querySelector('.account-balance-source');
      if (sourceControl) this.packy.paintSource(sourceControl, account.dataset.name, status);
      const auth = account.querySelector('.account-auth');
      if (!state.accountGroupingAvailable) {
        auth.innerHTML = '';
        account.querySelector('.account-data').textContent = '请重启中转管理服务，以启用按 API Key 隔离的账号余额。';
        continue;
      }
      const authHtml = status?.authorizationSite ? '<button type="button" class="monitor-auth-button" data-site="' + escapeHtml(status.authorizationSite) + '">' + (status.balance?.state === 'auth-required' ? '登录账号' : '账号授权') + '</button>' : '';
      if (auth.innerHTML !== authHtml) auth.innerHTML = authHtml;
      const target = account.querySelector('.account-data');
      const subscription = status?.subscriptions;
      const needsLogin = status?.balance?.state === 'auth-required' && !Number.isFinite(status.balance.amount) && !Array.isArray(subscription?.items);
      const balanceHtml = needsLogin ? '' : this.balanceMarkup(status?.balance);
      const hasPlans = subscription?.items?.length > 0;
      const subscriptionHtml = subscription && !needsLogin && (hasPlans || subscription.state !== 'available' || !balanceHtml) ? this.subscriptionsMarkup(subscription) : '';
      target.classList.toggle('has-both', Boolean(balanceHtml && subscriptionHtml));
      const html = (needsLogin ? '<span class="account-login-hint">登录后查看余额' + (subscription ? '与订阅额度' : '') + '</span>' : balanceHtml + subscriptionHtml) +
        (status?.state === 'unsupported' ? '<span class="availability-empty">该站点暂不支持自动查询余额</span>' : '');
      if (target.dataset.markup !== html) {
        target.innerHTML = html; target.dataset.markup = html;
      }
    }
    this.onChange?.();
  }

  markup(status) {
    if (status?.state === 'unsupported') return '<span class="availability-empty">可用性 · 站点未适配</span>';
    const stale = this.error || ['stale', 'auth-required'].includes(status?.state);
    const message = this.error ? (status?.history.length ? '刷新失败，保留上次样本' : this.error) : status?.message || '正在读取状态';
    const kind = stale ? 'stale' : status?.state || 'loading';
    const capacity = Number.isInteger(status?.historyLength) && status.historyLength >= 1 && status.historyLength <= 120 ? status.historyLength : 60;
    const samples = (status?.history || []).slice(-capacity);
    const parts = Array.from({ length: capacity - samples.length }, () => '<span class="availability-sample empty" aria-hidden="true"></span>');
    for (const sample of samples) {
      const label = ({ available: '可用', degraded: '降级', unavailable: '异常', 'no-data': '无数据' })[sample.state] || (sample.ok ? '可用' : '异常');
      const detail = sample.label || new Date(sample.at).toLocaleString() + ' · ' + label +
        (sample.uptimePct == null ? '' : ' · 成功率 ' + sample.uptimePct.toFixed(2) + '%') +
        (sample.healthScore == null ? '' : ' · 整体健康度 ' + sample.healthScore.toFixed(1)) +
        (sample.latencyMs == null ? '' : ' · 平均延迟 ' + sample.latencyMs + ' ms') +
        (sample.ttftMs == null ? '' : ' · TTFT ' + sample.ttftMs + ' ms') +
        (sample.tps == null ? '' : ' · TPS ' + sample.tps.toFixed(1) + ' t/s') + (sample.error ? '\n' + sample.error : '');
      const color = RelayAvailability.sampleColor(sample);
      const healthColor = Number.isFinite(sample.healthScore) ? ' style="background:hsl(' + (Math.max(0, Math.min(100, sample.healthScore)) * 1.2).toFixed(1) + ' 72% 42%)"' : '';
      parts.push('<span class="availability-sample ' + color + '"' + healthColor + ' title="' + escapeHtml(detail) + '" aria-hidden="true"></span>');
    }
    const pct = status?.uptimePct;
    const summary = (status?.summaryLabel || (status?.uptimeLabel || '可用率') + ' ' + (pct == null ? '—' : pct.toFixed(2) + '%')) + ' · ' + (status?.historyLabel || '样本') + ' ' + (status?.sampleCount ?? samples.length) + '/' + capacity;
    const time = at => new Date(at).toLocaleTimeString();
    const sampledAt = status?.sourceUpdatedAtLabel ? '快照时间 ' + status.sourceUpdatedAtLabel : Number.isFinite(status?.last?.at) ? (status.sampleTimeLabel || '最近采样') + ' ' + time(status.last.at) : '';
    const metrics = status?.metrics;
    const seconds = value => value == null ? '—' : (value / 1000).toFixed(2) + ' s';
    return '<div class="availability-meta"><code>' + escapeHtml(this.model) + '</code>' +
      (status?.sourceModelLabel ? '<span class="availability-source-model">' + escapeHtml(status.sourceModelLabel) + '</span>' : '') +
      (status?.groupLabel ? '<span class="availability-group">' + escapeHtml(status.groupLabel) + '</span>' : '') +
      '<span class="availability-state ' + kind + '">' + escapeHtml(message) + '</span>' +
      (status?.source ? '<a href="' + escapeHtml(status.source.url) + '" target="_blank" rel="noopener noreferrer">站点状态 ↗</a>' : '') +
      '</div>' +
      (status?.modelNote ? '<p class="availability-model-note">' + escapeHtml(status.modelNote) + '</p>' : '') +
      '<div class="availability-stats"><span>' + (stale ? '上次样本 · ' : '') + escapeHtml(summary) + '</span>' +
      (sampledAt ? '<span>' + escapeHtml(sampledAt) + '</span>' : '') + '</div>' +
      (metrics ? '<div class="availability-metrics">' + (metrics.hideTps ? '' : '<span>' + escapeHtml(metrics.tpsLabel || 'TPS') + ' ' + (metrics.tps == null ? '—' : metrics.tps.toFixed(1) + ' t/s') + '</span>') + '<span>' + escapeHtml(metrics.ttftLabel || '首 Token') + ' ' + seconds(metrics.ttftMs) + '</span>' +
        (metrics.hideLatency ? '' : '<span>平均延迟 ' + seconds(metrics.latencyMs) + '</span>') +
        (metrics.cacheRatePct == null ? '' : '<span>缓存率 ' + metrics.cacheRatePct.toFixed(1) + '%</span>') + '</div>' : '') +
      (samples.length ? '<div class="availability-bars' + (stale ? ' stale' : '') + '" data-columns="' + capacity + '" style="grid-template-columns:repeat(' + capacity + ',minmax(0,1fr))" role="img" aria-label="' + escapeHtml(this.model + ' · ' + (status?.sourceModelLabel || '') + ' · ' + (status?.groupLabel || '') + ' · ' + message + ' · ' + summary) + '">' + parts.join('') + '</div>' +
      '<div class="availability-axis"><span>' + (samples.length ? escapeHtml(samples[0].timeLabel || time(samples[0].at)) : '暂无采样') + '</span><span>' + (samples.length ? escapeHtml(samples.at(-1).endTimeLabel || time(samples.at(-1).at)) : '—') + '</span></div>' : '');
  }

  balanceMarkup(balance) {
    if (!balance) return '';
    if (balance.kind === 'packy-key') return this.packyMarkup(balance);
    const hasAmount = Number.isFinite(balance.amount) && balance.currency === 'USD';
    const stale = Boolean(this.error) || balance.state !== 'available';
    const amount = hasAmount ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(balance.amount) : '—';
    const message = balance.state === 'auth-required' ? '需重新登录' : stale ? '刷新失败' : '';
    const updated = Number.isFinite(balance.fetchedAt) ? (stale ? '上次更新 ' : '更新于 ') + new Date(balance.fetchedAt).toLocaleTimeString() : '';
    return '<div class="account-balance' + (stale ? ' stale' : hasAmount && balance.amount <= 0 ? ' depleted' : '') + '">' +
      '<span>账号余额</span><strong>' + escapeHtml(amount) + '</strong>' +
      (message ? '<span>' + (hasAmount ? '上次余额 · ' : '') + escapeHtml(message) + '</span>' : '') +
      (updated ? '<span class="account-balance-time">' + escapeHtml(updated) + '</span>' : '') + '</div>';
  }

  packyMarkup(balance) {
    const stale = Boolean(this.error) || ['stale', 'error'].includes(balance.state);
    const amount = value => Number.isFinite(value) ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value) : '—';
    const updated = Number.isFinite(balance.fetchedAt) ? new Date(balance.fetchedAt).toLocaleString() : '尚未成功查询';
    const hasAmount = Number.isFinite(balance.amount) || balance.unlimited;
    return '<div class="packy-balance' + (stale ? ' stale' : '') + '"><div class="packy-balance-heading"><span>当前 Key 余额</span><strong>' +
      (balance.unlimited ? '无限额度' : escapeHtml(amount(balance.amount) + ' / ' + amount(balance.maximum))) + '</strong>' +
      '<button type="button" class="packy-refresh"' + (balance.refreshing ? ' disabled' : '') + '>' + (balance.refreshing ? '查询中…' : '刷新余额') + '</button>' +
      '<button type="button" class="packy-settings">余额设置</button></div>' +
      '<div class="packy-balance-detail"><span>剩余比例 ' + (balance.unlimited ? '—' : Number.isFinite(balance.remainingPercent) ? balance.remainingPercent.toFixed(2) + '%' : '—') + '</span>' +
      '<span>自动查询 ' + ((balance.refreshMs || 1800000) / 60000).toLocaleString() + ' 分钟</span></div>' +
      (balance.tokenName ? '<div class="packy-balance-detail">Key 名称：' + escapeHtml(balance.tokenName) + '</div>' : '') +
      '<div class="packy-balance-detail">' + (stale && hasAmount ? '上次余额 · ' : '') + '最后成功：' + escapeHtml(updated) + '</div>' +
      (stale ? '<p class="packy-balance-error">' + escapeHtml(this.error ? '余额刷新失败，数据未更新。' : balance.message || '余额查询失败，数据未更新。') + '</p>' : '') + '</div>';
  }

  subscriptionsMarkup(subscriptions) {
    if (!subscriptions) return '';
    const stale = Boolean(this.error) || subscriptions.state !== 'available';
    const items = subscriptions.hideExpired && Array.isArray(subscriptions.items) ? subscriptions.items.filter(item => item.expiresAt > Date.now()) : subscriptions.items;
    const message = subscriptions.state === 'auth-required' ? '需重新登录' : stale ? '刷新失败' : '';
    const updated = Number.isFinite(subscriptions.fetchedAt) ? (stale ? '上次更新 ' : '更新于 ') + new Date(subscriptions.fetchedAt).toLocaleTimeString() : '';
    const money = value => Number.isFinite(value) ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value) : '—';
    const date = value => new Date(value).toLocaleString();
    const cards = Array.isArray(items) ? items.map(item => {
      const state = ({ active: '生效中', expired: '已到期', pending: '未生效', revoked: '已撤销', cancelled: '已取消', suspended: '已停用', frozen: '已冻结' })[item.state] || '状态未知';
      const quotas = item.quotas.map(quota => {
        const period = ({ daily: '日额度', weekly: '周额度', monthly: '月额度', total: '套餐额度', recent7d: '近 7 天套餐用量',
          carryover: '结转额度', credits: '积分额度', requests5h: '5 小时次数', requestsWeekly: '周次数', requestsMonthly: '月次数' })[quota.period];
        const format = value => quota.unit ? (Number.isFinite(value) ? value.toLocaleString() + (quota.unit === 'requests' ? ' 次' : ' credits') : '—') : money(value);
        const progress = Number.isFinite(quota.used) && Number.isFinite(quota.limit) && quota.limit > 0 ? Math.max(0, Math.min(100, quota.used / quota.limit * 100)) : null;
        const reset = quota.resetLabel || (quota.noReset ? '未提供下次重置时间' : quota.resetsAt === null ? '计费窗口未开始' : quota.endsWithSubscription ? '额度随套餐到期' : quota.resetsAt <= Date.now() ? '等待站点更新计费窗口' : '重置于 ' + date(quota.resetsAt));
        return '<div class="subscription-quota"><div><span>' + escapeHtml(period) + ' · 已用 ' + escapeHtml(format(quota.used)) + ' / ' + escapeHtml(format(quota.limit)) + '</span><span>' + escapeHtml(quota.remainingLabel || '剩余') + ' ' + escapeHtml(format(quota.remaining)) + '</span></div>' +
          (progress !== null ? '<div class="subscription-quota-bar" aria-hidden="true"><span style="width:' + progress.toFixed(2) + '%" class="' + (progress >= 90 ? 'high' : progress >= 70 ? 'medium' : '') + '"></span></div>' : '') +
          '<small>' + escapeHtml(reset) + '</small></div>';
      }).join('');
      return '<section class="subscription-item"><div class="subscription-title"><strong>' + escapeHtml(item.name) + '</strong><span class="subscription-state ' + (item.state === 'active' ? 'active' : '') + '">' + escapeHtml(state) + '</span></div>' +
        '<p class="subscription-expiry">' + (item.state === 'pending' && item.startsAt !== null ? '生效于 ' + escapeHtml(date(item.startsAt)) + ' · ' : '') +
        (item.expiresAt === null ? '无到期时间' : '到期 ' + escapeHtml(date(item.expiresAt))) + '</p>' +
        (item.note ? '<p class="subscription-expiry">' + escapeHtml(item.note) + '</p>' : '') +
        (quotas || '<p class="subscription-unlimited">' + escapeHtml(item.unlimitedLabel || '不限日／周／月额度') + '</p>') + '</section>';
    }).join('') : '';
    return '<div class="account-subscriptions' + (stale ? ' stale' : '') + '"><div class="subscription-heading"><span>' + escapeHtml(subscriptions.headingLabel || '登录账号订阅') + (Array.isArray(items) ? ' · ' + items.length + ' 项' : '') + '</span>' +
      (message ? '<span>' + (Array.isArray(items) ? '上次数据 · ' : '') + escapeHtml(message) + '</span>' : '') +
      (updated ? '<span class="account-balance-time">' + escapeHtml(updated) + '</span>' : '') + '</div>' +
      (Number.isFinite(subscriptions.windowStartAt) && Number.isFinite(subscriptions.windowEndAt) ? '<p class="subscription-expiry">近 7 天统计：' + escapeHtml(date(subscriptions.windowStartAt) + ' — ' + date(subscriptions.windowEndAt)) + '</p>' : '') +
      (cards || (Array.isArray(items) ? '<p class="subscription-empty">' + escapeHtml(subscriptions.emptyLabel || '暂无订阅') + '</p>' : '')) + '</div>';
  }
}
