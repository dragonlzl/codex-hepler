class RelayAvailability {
  constructor({ list, select, getState, getView = () => 'advanced', isDragging, onChange, mutateBalanceSource, mutateStatusMode, mutateAigoStatusMode }) {
    Object.assign(this, { list, select, getState, getView, isDragging, onChange });
    this.model = 'gpt-6-astra';
    this.rows = new Map();
    this.signature = '';
    this.request = null;
    this.error = '';
    this.refreshFailures = 0;
    this.rowFailures = new Map();
    this.rowIdentities = new Map();
    this.retryAt = 0;
    this.timer = null;
    this.balancePoll = null;
    this.packy = new PackyBalanceControls(list, () => { this.reset(); this.paint(); this.refresh(); }, { getState, mutateBalanceSource });
    this.timicc = new TimiccStatusControls(list, () => { this.reset(); this.paint(); this.refresh(); }, { getState, mutateStatusMode });
    this.aigo = new AigoStatusControls(list, () => { this.reset(); this.paint(); this.refresh(); }, { getState, mutateStatusMode: mutateAigoStatusMode });
    this.expandedChannels = new Set();
    this.simpleCharts = new Set();
    try {
      const saved = JSON.parse(localStorage.getItem('relay-aigo-expanded-pools') || '[]');
      if (Array.isArray(saved)) saved.forEach(key => this.expandedChannels.add(String(key)));
    } catch { /* Browser storage may be disabled. */ }
    const authorization = new MonitorAuthorization(async () => { this.reset(); await this.refresh(); });
    list.addEventListener('click', event => {
      const chartToggle = event.target.closest('.simple-availability-toggle');
      if (chartToggle) { this.toggleSimpleChart(chartToggle.dataset.name); return; }
      const toggle = event.target.closest('.aigo-channels-toggle');
      if (toggle) { this.toggleAigoChannels(toggle.dataset.name); return; }
      const button = event.target.closest('.monitor-auth-button, .simple-login-button');
      if (!button) return;
      const account = button.closest('.provider-account');
      if (account) {
        authorization.open(button.dataset.site, account.dataset.name, account.dataset.accountId);
        return;
      }
      const row = button.closest('.simple-route');
      const entry = row && this.getState().keys.find(item => item.name === row.dataset.name);
      if (entry) authorization.open(button.dataset.site, entry.name, entry.accountId);
    });
    try {
      const saved = localStorage.getItem('relay-availability-model');
      if (['gpt-6-astra', 'gpt-5.6-sol'].includes(saved)) this.model = saved;
    } catch { /* Browser storage may be disabled. */ }
    select.value = this.model;
    select.addEventListener('change', () => {
      this.model = select.value;
      try { localStorage.setItem('relay-availability-model', this.model); } catch { /* Optional preference. */ }
      this.sync();
    });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.cancel(); else this.refresh();
    });
    window.addEventListener('pagehide', () => this.cancel());
    window.addEventListener('pageshow', () => { this.start(); this.refresh(); });
    this.start();
  }

  aigoExpansionKey(name) { return JSON.stringify([this.getState().home || '', name]); }

  simpleChartKey(name) {
    const entry = this.getState().keys.find(item => item.name === name);
    return JSON.stringify([this.getState().home || '', name, entry?.baseurl, entry?.naturalAccountId]);
  }

  toggleSimpleChart(name) {
    const key = this.simpleChartKey(name);
    if (this.simpleCharts.has(key)) this.simpleCharts.delete(key); else this.simpleCharts.add(key);
    this.paint();
  }

  toggleAigoChannels(name) {
    const key = this.aigoExpansionKey(name);
    if (this.expandedChannels.has(key)) this.expandedChannels.delete(key); else this.expandedChannels.add(key);
    try { localStorage.setItem('relay-aigo-expanded-pools', JSON.stringify([...this.expandedChannels])); } catch { /* Optional preference. */ }
    this.paint();
  }

  start(delay = 15000) {
    clearTimeout(this.timer);
    this.timer = null;
    if (!document.hidden) this.timer = setTimeout(() => { this.timer = null; return this.refresh(); }, delay);
  }

  cancel() {
    this.request?.abort();
    this.request = null;
    if (this.timer !== undefined) { clearTimeout(this.timer); this.timer = null; }
    clearTimeout(this.balancePoll); this.balancePoll = null;
  }

  reset() {
    this.cancel();
    // Refresh the same route in place. Only sync() invalidates changed identities.
    this.error = '';
    this.refreshFailures = 0;
    this.retryAt = 0;
    this.rowFailures.clear();
    if (!this.isDragging()) this.onChange?.();
  }

  reconcileRows(state) {
    const identities = new Map(state.keys.map(entry => {
      const key = JSON.stringify([entry.name, entry.baseurl]);
      const mode = ['timicc', 'aigo'].includes(entry.merchantId)
        ? this.getView() === 'simple' ? 'api-key' : entry.statusMode || 'all' : null;
      return [key, JSON.stringify([state.home, entry.revision, entry.naturalAccountId, entry.accountId,
        state.accountBindingsRevision, entry.balanceSource, mode])];
    }));
    for (const key of this.rows.keys()) {
      if (!identities.has(key) || identities.get(key) !== this.rowIdentities.get(key)) {
        this.rows.delete(key); this.rowFailures.delete(key);
      }
    }
    if (![...identities].some(([key, id]) => this.rowIdentities.get(key) === id)) {
      this.refreshFailures = 0; this.error = ''; this.retryAt = 0;
    }
    this.rowIdentities = identities;
  }

  static statusNeedsLogin(row) {
    return row?.state === 'auth-required' || row?.requiresLogin || row?.channels?.some(channel => channel.state === 'auth-required');
  }

  static statusRefreshFailed(row) {
    return !RelayAvailability.statusNeedsLogin(row) && Boolean(row?.failure || row?.state === 'error' ||
      row?.channels?.some(channel => channel.failure || channel.state === 'error'));
  }

  acceptRows(rows) {
    const now = Date.now();
    const next = new Map();
    for (const row of rows) {
      const key = JSON.stringify([row.name, row.baseurl]);
      if (!RelayAvailability.statusRefreshFailed(row)) {
        this.rowFailures.delete(key);
        next.set(key, { ...row, displayAt: now });
        continue;
      }
      const attempts = (this.rowFailures.get(key) || 0) + 1;
      this.rowFailures.set(key, attempts);
      next.set(key, { ...row, displayAt: now });
      if (attempts > 3) this.rowFailures.delete(key);
    }
    for (const key of this.rowFailures.keys()) if (!next.has(key)) this.rowFailures.delete(key);
    this.rows = next;
  }

  static sampleColor(sample) {
    return ({ available: 'ok', degraded: 'warn', unavailable: 'bad', maintenance: 'maintenance', 'no-data': 'unknown' })[sample?.state]
      || (sample?.ok === true ? 'ok' : sample?.ok === false ? 'bad' : 'unknown');
  }

  static filterState(status) {
    if (Array.isArray(status?.channels)) {
      const states = status.channels.map(channel => channel.state === 'maintenance' ? null : RelayAvailability.filterState(channel));
      return states.includes('unavailable') ? 'unavailable' : states.length && states.every(state => state === 'available') ? 'available' : null;
    }
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
    const signature = JSON.stringify([this.model, this.getView(), state.home, state.accountBindingsRevision, state.availabilityAvailable, state.network?.mode, state.network?.proxyUrl,
      state.keys.map(entry => [entry.name, entry.baseurl, entry.revision, entry.balanceSource, entry.statusMode]).sort((a, b) => a[0].localeCompare(b[0]))]);
    this.select.disabled = !state.availabilityAvailable;
    if (signature !== this.signature) {
      this.signature = signature;
      this.reconcileRows(state);
      this.reset();
      this.refresh();
    }
    this.paint();
  }

  async refresh() {
    if (this.request || document.hidden || !this.getState().availabilityAvailable) return;
    if (Date.now() < this.retryAt) { this.start(this.retryAt - Date.now()); return; }
    if (this.timer !== undefined) { clearTimeout(this.timer); this.timer = null; }
    const controller = new AbortController();
    this.request = controller;
    if (!this.isDragging()) this.onChange?.();
    const signature = this.signature;
    const model = this.model;
    try {
      const response = await fetch('/api/availability?model=' + encodeURIComponent(model) + (this.getView?.() === 'simple' ? '&view=simple' : ''), {
        cache: 'no-store', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(12000)]),
      });
      if (!response.ok) throw Object.assign(new Error('Status request failed'), { status: response.status });
      const data = await response.json();
      if (this.request !== controller || signature !== this.signature || model !== this.model) return;
      if (data.model !== model || !Array.isArray(data.rows)) throw new Error('Invalid status response');
      this.acceptRows(data.rows);
      this.error = '';
      this.refreshFailures = 0;
    } catch (error) {
      if (this.request !== controller || controller.signal.aborted) return;
      this.refreshFailures = (this.refreshFailures || 0) + 1;
      this.error = [401, 403].includes(error.status) ? '登录或授权已失效，请重新登录' : error.name === 'TimeoutError' ? '管理服务响应超时（12 秒）'
        : error.status ? '管理服务返回 HTTP ' + error.status : '无法取得管理服务的刷新结果';
    } finally {
      if (this.request === controller) {
        this.request = null; this.paint();
        clearTimeout(this.balancePoll); this.balancePoll = null;
        const rowRetrying = [...(this.rowFailures?.values() || [])].some(attempts => attempts <= 3);
        const retrying = !this.error && (this.refreshFailures > 0 || rowRetrying);
        this.retryAt = retrying ? Date.now() + 15000 : 0;
        const balancePending = !retrying && [...this.rows.values()].some(row => row.balance?.kind === 'packy-key' && row.balance.refreshing);
        if (balancePending) this.balancePoll = setTimeout(() => this.refresh(), 2000);
        if (this.timer !== undefined) this.start(balancePending ? 2000 : 15000);
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
    for (const target of this.list.querySelectorAll('.provider-availability, .account-availability, .simple-availability')) {
      const status = statusFor(target.dataset.name);
      const html = !state.availabilityAvailable ? '<span class="availability-empty">可用性展示需重启管理服务</span>' :
        target.classList.contains('simple-availability') ? this.simpleStatusMarkup(status, target.dataset.name) : this.markup(status, target.dataset.name);
      if (target.innerHTML !== html) {
        const focused = target.contains(document.activeElement);
        target.innerHTML = html;
        if (focused) target.querySelector('.simple-availability-toggle')?.focus({ preventScroll: true });
      }
    }
    for (const account of this.list.querySelectorAll('.provider-account')) {
      const status = statusFor(account.dataset.name);
      const modeControl = account.querySelector('.account-status-mode');
      if (modeControl) this.timicc.paint(modeControl, account.dataset.name);
      const aigoModeControl = account.querySelector('.aigo-status-mode');
      if (aigoModeControl) this.aigo.paint(aigoModeControl, account.dataset.name);
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
      const loginHint = '<button type="button" class="monitor-auth-button account-login-hint" data-site="' + escapeHtml(status?.authorizationSite || '') + '">登录后查看余额' + (subscription ? '与订阅额度' : '') + '</button>';
      const html = (needsLogin ? status?.authorizationSite ? loginHint : '<span class="account-login-hint">登录后查看余额' + (subscription ? '与订阅额度' : '') + '</span>' : balanceHtml + subscriptionHtml) +
        (status?.state === 'unsupported' ? '<span class="availability-empty">该站点暂不支持自动查询余额</span>' : '');
      if (target.dataset.markup !== html) {
        target.innerHTML = html; target.dataset.markup = html;
      }
    }
    for (const row of this.list.querySelectorAll('.simple-route')) {
      const status = statusFor(row.dataset.name);
      const balance = row.querySelector('.simple-balance');
      const subscription = row.querySelector('.simple-subscription');
      const balanceHtml = this.simpleBalanceMarkup(status?.balance, status);
      const subscriptionHtml = this.simpleSubscriptionMarkup(status?.subscriptions, status);
      if (balance && balance.innerHTML !== balanceHtml) balance.innerHTML = balanceHtml;
      if (subscription && subscription.innerHTML !== subscriptionHtml) subscription.innerHTML = subscriptionHtml;
    }
    this.onChange?.();
  }

  static simpleStatus(status, now = Date.now()) {
    const unknown = message => ({ color: 'unknown', message: message || '当前状态未知' });
    if (!status) return unknown('尚未检测');
    if (['stale', 'error', 'auth-required', 'unsupported', 'no-data'].includes(status.state)) {
      return unknown(({ stale: '状态已过期', error: '状态获取失败', 'auth-required': '需登录后检测', unsupported: '站点未适配' })[status.state] || status.message);
    }
    if (status.referenceOnly) {
      const summary = RelayAvailability.simpleStatus({ ...status, referenceOnly: false }, now);
      return summary.color === 'unknown' ? summary : { ...summary, message: '其他模型参考：' + summary.message };
    }
    // Never substitute an arbitrary channel when the API Key mapping is unavailable.
    if (Array.isArray(status.channels)) {
      if (status.channels.length !== 1) return unknown(status.channels.length ? '无法确认 API Key 对应检测' : status.message);
      return RelayAvailability.simpleStatus({ ...status.channels[0], sampleIntervalMs: status.sampleIntervalMs }, now);
    }
    if (status.state === 'unavailable') return { color: 'unavailable', message: '当前不可用' };
    if (status.state === 'maintenance') return { color: 'maintenance', message: '当前不可用（维护中）' };
    const history = (status.history || []).filter(sample => Number.isFinite(sample.at) && sample.at <= now).sort((a, b) => a.at - b.at);
    const last = status.last || history.at(-1);
    if (!last || !Number.isFinite(last.at) || last.at > now) return unknown();
    const interval = status.sampleIntervalMs || 60000;
    if (now - last.at > (status.staleAfterMs || interval + 180000)) return unknown('状态已过期');
    const color = RelayAvailability.sampleColor(last);
    if (color === 'bad') return { color: 'unavailable', message: '当前不可用' };
    if (color === 'maintenance') return { color: 'maintenance', message: '当前不可用（维护中）' };
    if (!['ok', 'warn'].includes(color)) return unknown('暂无有效检测');
    if (!history.some(sample => sample.at === last.at)) history.push(last);
    history.sort((a, b) => a.at - b.at);
    const recentFailure = minutes => history.some(sample => sample.at >= now - minutes * 60000 && RelayAvailability.sampleColor(sample) === 'bad');
    const recent3 = recentFailure(3), recent10 = recentFailure(10);
    let message = '当前可用';
    if (recent3) message += '，3分钟内存在不可用';
    else if (recent10) message += '，10分钟内存在不可用';
    // Require coverage across the whole window. Empty buckets, long gaps and coarse
    // hourly aggregates cannot establish ten minutes of continuous availability.
    const anchor = history.findLastIndex(sample => sample.at < now - 10 * 60000);
    const covered = anchor >= 0 ? history.slice(anchor) : [];
    const tolerance = interval + 15000;
    const continuous = interval <= 10 * 60000 && covered.length > 1 && now - last.at <= tolerance &&
      covered.every((sample, index) => ['ok', 'warn'].includes(RelayAvailability.sampleColor(sample)) &&
        (!index || sample.at - covered[index - 1].at <= tolerance));
    if (!recent10 && continuous) message = '持续可用超过10分钟';
    return { color: color === 'warn' ? 'degraded' : 'available', message };
  }

  simpleStatusMarkup(status, entryName = '') {
    const summary = this.error || status?.refreshFailed ? { color: 'unknown', message: '获取失败' }
      : RelayAvailability.simpleStatus(status, status?.displayAt ?? Date.now());
    const channel = Array.isArray(status?.channels) ? status.channels.length === 1 ? status.channels[0] : null : status;
    const canToggle = summary.color !== 'unknown' && channel?.history?.some(sample =>
      Number.isFinite(sample.at) && RelayAvailability.sampleColor(sample) !== 'unknown');
    if (!canToggle) return '<span class="simple-status ' + summary.color + '" title="' + escapeHtml(this.error || status?.failure?.message || status?.modelNote || status?.message || summary.message) + '">' + escapeHtml(summary.message) + '</span>';
    const chart = this.simpleCharts?.has(this.simpleChartKey(entryName));
    const action = chart ? '点击恢复文字展示' : '点击查看检测图';
    const reference = status?.referenceOnly ? '<span class="simple-history-reference">其他模型 · 参考</span>' : '';
    return '<button type="button" class="simple-availability-toggle ' + (chart ? 'simple-history-frame' : 'simple-status ' + summary.color) + '" data-name="' + escapeHtml(entryName) +
      '" aria-pressed="' + Boolean(chart) + '" aria-label="' + escapeHtml(entryName + ' · ' + summary.message + ' · ' + action) + '" title="' + escapeHtml([status?.modelNote, action].filter(Boolean).join(' · ')) + '">' +
      (chart ? reference + this.markup(channel, entryName, true) : escapeHtml(summary.message)) + '</button>';
  }

  simpleLoginMarkup(status, label) {
    if (!status?.authorizationSite) return '<span class="simple-muted">需登录</span>';
    return '<button type="button" class="simple-login-button" data-site="' + escapeHtml(status.authorizationSite) + '">' + escapeHtml(label || '登录账号') + '</button>';
  }

  simpleBalanceMarkup(balance, status) {
    const loginRequired = status?.balance?.state === 'auth-required' || status?.subscriptions?.state === 'auth-required';
    if (loginRequired) {
      if (!Number.isFinite(balance?.amount) || balance.currency !== 'USD') return this.simpleLoginMarkup(status, '登录查看');
      const stale = Boolean(this.error) || balance.state !== 'available';
      return '<div class="simple-balance-login"><strong class="simple-value' + (stale ? ' stale' : '') + '">' + escapeHtml(this.money(balance.amount)) + '</strong>' +
        (stale ? '<span class="simple-data-note">上次余额</span>' : '') + this.simpleLoginMarkup(status, '重新登录') + '</div>';
    }
    if (!balance) return '<span class="simple-muted">—</span>';
    if (balance.kind === 'packy-key') {
      if (balance.unlimited) return '<strong class="simple-value">无限额度</strong>';
      return Number.isFinite(balance.amount) ? '<strong class="simple-value">' + escapeHtml(this.money(balance.amount)) + '</strong>' : '<span class="simple-muted">—</span>';
    }
    return Number.isFinite(balance.amount) && balance.currency === 'USD'
      ? '<strong class="simple-value">' + escapeHtml(this.money(balance.amount)) + '</strong>'
      : '<span class="simple-muted">—</span>';
  }

  simpleSubscriptionMarkup(subscriptions, status) {
    const loginRequired = status?.balance?.state === 'auth-required' || status?.subscriptions?.state === 'auth-required';
    if (loginRequired) return this.simpleLoginMarkup(status, '登录查看');
    if (!subscriptions) return '<span class="simple-muted">—</span>';
    const items = subscriptions.hideExpired && Array.isArray(subscriptions.items)
      ? subscriptions.items.filter(item => item.expiresAt > Date.now()) : subscriptions.items;
    if (!Array.isArray(items) || !items.length) return '<span class="simple-muted">无订阅</span>';
    const date = value => value === null ? '无到期时间' : new Date(value).toLocaleString('zh-CN', { hour12: false });
    const quotaLabel = { daily: '日额度', weekly: '周额度', monthly: '月额度', total: '套餐额度', recent7d: '近7天套餐用量', credits: '积分额度' };
    const format = (quota, value) => quota.unit ? (Number.isFinite(value) ? value.toLocaleString() + (quota.unit === 'requests' ? ' 次' : ' credits') : '—') : this.money(value);
    return items.map(item => '<div class="simple-subscription-item"><div>到期 ' + escapeHtml(date(item.expiresAt)) + '</div>' +
      (item.quotas || []).map(quota => '<div class="simple-quota"><span>' + escapeHtml(quotaLabel[quota.period] || quota.period || '额度') + ' · 已用 ' + escapeHtml(format(quota, quota.used)) + ' / ' + escapeHtml(format(quota, quota.limit)) + '</span><span>剩余 ' + escapeHtml(format(quota, quota.remaining)) + '</span></div>' +
        (Number.isFinite(quota.used) && Number.isFinite(quota.limit) && quota.limit > 0 ? '<div class="simple-quota-bar"><span style="width:' + Math.max(0, Math.min(100, quota.used / quota.limit * 100)).toFixed(2) + '%"></span></div>' : '')).join('') +
      (!(item.quotas || []).length ? '<div>不限额度</div>' : '') + '</div>').join('');
  }

  money(value) {
    return Number.isFinite(value) ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value) : '—';
  }

  markup(status, entryName = '', historyOnly = false) {
    if (Array.isArray(status?.channels)) {
      const collapsible = Boolean(status.collapsibleChannels && status.channels.length > 2);
      const expanded = collapsible && this.expandedChannels.has(this.aigoExpansionKey(entryName));
      const channels = collapsible && !expanded ? status.channels.slice(0, 2) : status.channels;
      const toggle = collapsible ? '<button type="button" class="aigo-channels-toggle" data-name="' + escapeHtml(entryName) + '" aria-expanded="' + expanded + '">' + (expanded ? '收起号池' : '展开全部号池') + '（' + status.channels.length + '）</button>' : '';
      return '<div class="availability-channels"><p class="availability-model-note">' + escapeHtml(status.modelNote || '') + '</p>' + toggle +
        '<div class="availability-channel-grid">' + channels.map(channel => '<section class="availability-channel" aria-label="' + escapeHtml(channel.groupLabel) + '">' + this.markup({ ...channel, source: status.source, failure: status.failure || channel.failure }, entryName) + '</section>').join('') + '</div></div>';
    }
    if (status?.state === 'unsupported') return '<span class="availability-empty">可用性 · 站点未适配</span>';
    const retryFailed = Boolean(status?.refreshFailed);
    const stale = this.error || retryFailed || ['stale', 'auth-required'].includes(status?.state);
    const message = retryFailed ? '获取失败'
      : this.error ? '刷新失败：' + this.error + (status?.history?.length ? '，保留上次样本' : '')
      : status?.failure ? (status.state === 'auth-required' ? '监控授权失效：' : '刷新失败：') + status.failure.message
        : status?.message || '正在读取状态';
    const kind = stale ? 'stale' : status?.state || 'loading';
    const capacity = Number.isInteger(status?.historyLength) && status.historyLength >= 1 && status.historyLength <= 120 ? status.historyLength : 60;
    const samples = (status?.history || []).slice(-capacity);
    const parts = Array.from({ length: capacity - samples.length }, () => '<span class="availability-sample empty" aria-hidden="true"></span>');
    for (const sample of samples) {
      const label = sample.statusLabel || ({ available: '可用', degraded: '降级', unavailable: '异常', maintenance: '维护中', 'no-data': '无数据' })[sample.state] || (sample.ok ? '可用' : '异常');
      const detail = sample.label || new Date(sample.at).toLocaleString() + ' · ' + label +
        (sample.uptimePct == null ? '' : ' · 成功率 ' + sample.uptimePct.toFixed(2) + '%') +
        (sample.healthScore == null ? '' : ' · 整体健康度 ' + sample.healthScore.toFixed(1)) +
        (sample.latencyMs == null ? '' : ' · 平均延迟 ' + sample.latencyMs + ' ms') +
        (sample.ttftMs == null ? '' : ' · TTFT ' + sample.ttftMs + ' ms') +
        (sample.tps == null ? '' : ' · TPS ' + sample.tps.toFixed(1) + ' t/s') + (sample.error ? '\n' + sample.error : '');
      const color = RelayAvailability.sampleColor(sample);
      const styles = [];
      if (Number.isFinite(sample.healthScore)) styles.push('background:hsl(' + (Math.max(0, Math.min(100, sample.healthScore)) * 1.2).toFixed(1) + ' 72% 42%)');
      if (Number.isFinite(sample.barHeightPct)) styles.push('height:' + Math.max(0, Math.min(100, sample.barHeightPct)).toFixed(2) + '%', 'min-height:1px', 'align-self:end');
      parts.push('<span class="availability-sample ' + color + '"' + (styles.length ? ' style="' + styles.join(';') + '"' : '') + ' title="' + escapeHtml(detail) + '" aria-hidden="true"></span>');
    }
    const pct = status?.uptimePct;
    const summary = (status?.summaryLabel || (status?.uptimeLabel || '可用率') + ' ' + (pct == null ? '—' : pct.toFixed(2) + '%')) + ' · ' + (status?.historyLabel || '样本') + ' ' + (status?.sampleCount ?? samples.length) + '/' + capacity;
    const time = at => new Date(at).toLocaleTimeString();
    const sampledAt = status?.sourceUpdatedAtLabel ? '快照时间 ' + status.sourceUpdatedAtLabel : Number.isFinite(status?.last?.at) ? (status.sampleTimeLabel || '最近采样') + ' ' + time(status.last.at) : '';
    const metrics = status?.metrics;
    const seconds = value => value == null ? '—' : (value / 1000).toFixed(2) + ' s';
    // Both views use the same samples, colours, tooltips and time labels. Spans let
    // the compact chart live inside a native button for mouse/keyboard toggling.
    const tag = historyOnly ? 'span' : 'div';
    const timeline = samples.length ? '<' + tag + ' class="availability-bars' + (stale ? ' stale' : '') + '" data-columns="' + capacity + '" style="--availability-columns:' + capacity + ';grid-template-columns:repeat(' + capacity + ',minmax(0,1fr))" role="img" aria-label="' + escapeHtml(this.model + ' · ' + (status?.sourceModelLabel || '') + ' · ' + (status?.groupLabel || '') + ' · ' + message + ' · ' + summary) + '">' + parts.join('') + '</' + tag + '>' +
      '<' + tag + ' class="availability-axis"><span>' + escapeHtml(samples[0].timeLabel || time(samples[0].at)) + '</span><span>' + escapeHtml(samples.at(-1).endTimeLabel || time(samples.at(-1).at)) + '</span></' + tag + '>' : '';
    if (historyOnly) return timeline;
    return '<div class="availability-meta"><code>' + escapeHtml(status?.modelLabel || this.model) + '</code>' +
      (status?.sourceModelLabel ? '<span class="availability-source-model">' + escapeHtml(status.sourceModelLabel) + '</span>' : '') +
      (status?.groupLabel ? '<span class="availability-group">' + escapeHtml(status.groupLabel) + '</span>' : '') +
      '<span class="availability-state ' + kind + '">' + escapeHtml(message) + '</span>' +
      (status?.source ? '<a href="' + escapeHtml(status.source.url) + '" target="_blank" rel="noopener noreferrer">站点状态 ↗</a>' : '') +
      '</div>' +
      (status?.modelNote ? '<p class="availability-model-note">' + escapeHtml(status.modelNote) + '</p>' : '') +
      '<div class="availability-stats"><span>' + (stale ? '上次样本 · ' : '') + escapeHtml(summary) + '</span>' +
      (sampledAt ? '<span>' + escapeHtml(sampledAt) + '</span>' : '') + '</div>' +
      (metrics ? '<div class="availability-metrics">' + (metrics.hideTps ? '' : '<span>' + escapeHtml(metrics.tpsLabel || 'TPS') + ' ' + (metrics.tps == null ? '—' : metrics.tps.toFixed(1) + ' t/s') + '</span>') + (metrics.hideTtft ? '' : '<span>' + escapeHtml(metrics.ttftLabel || '首 Token') + ' ' + seconds(metrics.ttftMs) + '</span>') +
        (metrics.hideLatency ? '' : '<span>' + escapeHtml(metrics.latencyLabel || '平均延迟') + ' ' + seconds(metrics.latencyMs) + '</span>') +
        (Number.isFinite(metrics.pingMs) ? '<span>端点 PING ' + metrics.pingMs.toFixed(0) + ' ms</span>' : '') +
        (metrics.cacheRatePct == null ? '' : '<span>缓存率 ' + metrics.cacheRatePct.toFixed(1) + '%</span>') + '</div>' : '') +
      timeline;
  }

  balanceMarkup(balance) {
    if (!balance) return '';
    if (balance.kind === 'packy-key') return this.packyMarkup(balance);
    const hasAmount = Number.isFinite(balance.amount) && balance.currency === 'USD';
    const stale = Boolean(this.error) || balance.state !== 'available';
    const amount = hasAmount ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(balance.amount) : '—';
    const message = balance.state === 'auth-required' ? '需重新登录' : stale ? '刷新失败' +
      ((this.error || balance.failure?.message) ? '：' + (this.error || balance.failure.message) : '') : '';
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
    const message = subscriptions.state === 'auth-required' ? '需重新登录' : stale ? '刷新失败' +
      ((this.error || subscriptions.failure?.message) ? '：' + (this.error || subscriptions.failure.message) : '') : '';
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
