class RelayIntelligence {
  constructor({ list, getState, request, blocked }) {
    Object.assign(this, { list, getState, request, blocked });
    this.pending = new Set();
    this.open = new Set();
    this.messages = new Map();
    this.latest = null;
    this.model = document.querySelector('#intelligence-model');
    this.effort = document.querySelector('#intelligence-effort');
    this.reviewEnabled = document.querySelector('#intelligence-review-enabled');
    this.globalButton = document.querySelector('#global-intelligence-test');
    try {
      const settings = JSON.parse(localStorage.getItem('relay-intelligence-settings') || 'null');
      if (settings?.model) this.model.value = settings.model;
      if (['low', 'medium', 'high', 'xhigh'].includes(settings?.effort)) this.effort.value = settings.effort;
      if (typeof settings?.reviewEnabled === 'boolean') this.reviewEnabled.checked = settings.reviewEnabled;
    } catch {}
    for (const input of [this.model, this.effort, this.reviewEnabled]) input.addEventListener('change', () => {
      try { localStorage.setItem('relay-intelligence-settings', JSON.stringify({ model: this.model.value.trim(), effort: this.effort.value, reviewEnabled: this.reviewEnabled.checked })); } catch {}
    });
    list.addEventListener('click', event => {
      const button = event.target.closest('.intelligence-button');
      if (button && !button.disabled) this.start(button.dataset.name);
      const reviewButton = event.target.closest('.intelligence-review-button');
      if (reviewButton && !reviewButton.disabled) this.startReview(reviewButton.closest('.route').dataset.name);
    });
    list.addEventListener('toggle', event => {
      const details = event.target;
      if (!details.matches('.intelligence-details') || !details.isConnected) return;
      if (details.open) this.open.add(details.dataset.id); else this.open.delete(details.dataset.id);
    }, true);
    this.globalButton?.addEventListener('click', () => this.startAll());
  }

  escape(value) { return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char])); }

  reviewBadge(review) {
    if (!review) return '';
    const active = ['queued', 'reviewing'].includes(review.state);
    const label = review.state === 'completed' ? '自评：' + review.verdict : active ? (review.state === 'queued' ? '自评排队中' : '自评中') : '自评失败';
    const color = active ? 'pending' : review.state === 'failed' ? 'failed' : review.verdict === '正常' ? 'normal' : 'degraded';
    return '<span class="intelligence-verdict ' + color + '">' + this.escape(label) + '</span>';
  }

  reviewMarkup(result, pending) {
    if (!result.screenshotUrl) return '';
    const review = result.review, active = ['queued', 'reviewing'].includes(review?.state);
    const action = active ? '评审中…' : review?.state === 'failed' ? '重试评审' : review ? '重新评审' : '评审已有结果';
    let markup = '<section class="intelligence-review" aria-label="模型自评"><div class="intelligence-review-heading"><strong>模型自评</strong>' +
      '<button class="intelligence-review-button" type="button"' + (pending || active || this.blocked() ? ' disabled' : '') + '>' + action + '</button></div>';
    if (review) {
      const meta = review.model + ' · ' + review.effort + ' · ' + new Date(review.completedAt || review.startedAt).toLocaleString('zh-CN', { hour12: false }) +
        (review.durationMs != null ? ' · ' + (review.durationMs / 1000).toFixed(1) + ' 秒' : '');
      markup += '<p class="intelligence-help">' + this.escape(meta) + '</p>';
      if (review.transport === 'codex-cli') markup += '<p class="intelligence-help">评审通道：Codex CLI 兼容通道</p>';
      if (review.transport === 'packy-api') markup += '<p class="intelligence-help">评审通道：Packycode 纯 API</p>';
      markup += '<p class="' + (review.state === 'failed' ? 'intelligence-error' : 'intelligence-review-summary') + '">' +
        this.escape(active ? '正在由本次被测中转和模型，对照固定 INPUT 基准图评审截图及完整 HTML。' : review.summary) + '</p>';
      if (review.findings?.length) markup += '<ul class="intelligence-findings">' + review.findings.map(item => '<li><strong>' + this.escape(item.dimension) +
        '</strong><span class="intelligence-evidence">' + this.escape(item.source) + '</span><p>' + this.escape(item.observation) + '</p></li>').join('') + '</ul>';
      if (review.limitations?.length) markup += '<p class="intelligence-help">无法确认：' + review.limitations.map(item => this.escape(item)).join('；') + '</p>';
      if (review.usage?.total_tokens != null) markup += '<p class="intelligence-help">评审用量：' + this.escape(review.usage.total_tokens) + ' tokens</p>';
    } else markup += '<p class="intelligence-help">' + (result.reviewEnabled ? '此结果尚未评审。' : '此结果未进行自动智力判断，可单独发起评审。') + '</p>';
    return markup + '</section>';
  }

  sync() {
    const snapshot = this.getState().intelligence;
    if (snapshot && snapshot.scope !== this.latest?.scope) { this.latest = snapshot; this.open.clear(); this.messages.clear(); }
    else if (snapshot && snapshot.revision >= this.latest.revision) this.latest = snapshot;
    const rows = new Map((this.latest?.rows || []).map(row => [row.name, row]));
    const labels = { queued: '等待执行', generating: '生成中', rendering: '截图中', completed: '已完成', preview_failed: '截图失败', failed: '执行失败' };
    const providerRows = new Map(), providerOwners = new Map();
    const simpleEntries = [...(this.getState().keys || [])];
    const selectedName = this.getState().activeName || this.getState().selectedProxyName;
    const selectedEntry = simpleEntries.find(entry => entry.name === selectedName);
    const orderedEntries = selectedEntry ? [selectedEntry, ...simpleEntries.filter(entry => entry !== selectedEntry)] : simpleEntries;
    for (const entry of orderedEntries) {
      const provider = RelayGroups.provider(entry);
      if (!providerRows.has(provider)) { providerRows.set(provider, []); providerOwners.set(provider, entry.name); }
      const row = rows.get(entry.name);
      if (row) providerRows.get(provider).push(row);
    }
    const providerResults = new Map();
    const resultTime = result => Date.parse(result?.completedAt || result?.startedAt || '') || 0;
    for (const [provider, providerEntries] of providerRows) {
      const successes = [], completed = [];
      let active = false;
      for (const row of providerEntries) {
        const result = row.result;
        if (['queued', 'generating', 'rendering'].includes(result?.state) || ['queued', 'reviewing'].includes(result?.review?.state)) active = true;
        if (result?.state === 'completed') successes.push(result);
        if (result?.lastSuccessful?.state === 'completed') successes.push(result.lastSuccessful);
        if (result) completed.push(result);
      }
      successes.sort((a, b) => resultTime(b) - resultTime(a));
      completed.sort((a, b) => resultTime(b) - resultTime(a));
      providerResults.set(provider, { success: successes[0] || null, latest: completed[0] || null, active });
    }
    if (this.globalButton) {
      const total = rows.size;
      const pending = this.pending.size;
      this.globalButton.disabled = this.blocked() || !total || (pending >= total);
      this.globalButton.textContent = pending ? '智力测试中 ' + pending + '/' + total : '全部智力测试';
      this.globalButton.setAttribute('aria-busy', String(Boolean(pending)));
    }
    for (const button of this.list.querySelectorAll('.intelligence-button')) {
      const row = rows.get(button.dataset.name), result = row?.result;
      button.disabled = this.blocked() || !row || this.pending.has(row.routeId);
      button.textContent = this.pending.has(row?.routeId) ? '提交中…' : result ? '重新测试' : '智力测试';
      button.title = result ? '重新执行并替换此中转的旧任务与结果' : '使用固定题目测试此中转';
      const simpleHost = button.closest('.simple-route')?.querySelector('.simple-intelligence');
      if (simpleHost) {
        const provider = button.closest('.simple-route')?.dataset.provider;
        const shared = providerResults.get(provider) || { success: null, latest: result, active: false };
        if (providerOwners.get(provider) && providerOwners.get(provider) !== button.dataset.name) {
          const markup = '<span class="simple-shared-intelligence">共用首行结果</span>';
          if (simpleHost.innerHTML !== markup) simpleHost.innerHTML = markup;
          continue;
        }
        const successful = shared.success;
        const displayResult = successful || shared.latest;
        const active = shared.active;
        const verdict = successful?.review?.verdict;
        const label = successful ? verdict ? '自评：' + verdict : '测试完成（未评审）' : displayResult ? '暂无成功测试结果' : '未进行测试';
        const color = verdict === '降智' ? 'degraded' : verdict === '正常' ? 'normal' : 'unknown';
        const date = successful?.completedAt || successful?.startedAt;
        const failed = !successful && ['failed', 'preview_failed'].includes(displayResult?.state);
        const note = active ? '测试中…' : failed ? '本次测试失败' : '';
        const statusMarkup = successful?.screenshotUrl
          ? '<a class="simple-intelligence-link" href="' + this.escape(successful.screenshotUrl) + '" target="_blank" rel="noopener noreferrer" title="打开生成截图">' + this.escape(label) + '</a>'
          : '<span class="simple-intelligence-state ' + color + '" title="' + this.escape(successful?.review?.summary || '') + '">' + this.escape(label) + '</span>';
        const markup = statusMarkup +
          (date ? '<time datetime="' + this.escape(date) + '">' + this.escape(new Date(date).toLocaleString('zh-CN', { hour12: false })) + '</time>' : '') +
          (note ? '<small class="simple-intelligence-note" role="status">' + this.escape(note) + '</small>' : '');
        if (simpleHost.innerHTML !== markup) simpleHost.innerHTML = markup;
        button.disabled ||= active;
        if (active) button.textContent = '测试中…';
        continue;
      }
      const host = button.closest('.route').querySelector('.intelligence-result');
      const message = this.messages.get(row?.routeId) || row?.error;
      let markup = message ? '<p class="intelligence-error" role="status">' + this.escape(message) + '</p>' : '';
      if (result) {
        const date = new Date(result.completedAt || result.startedAt).toLocaleString('zh-CN', { hour12: false });
        const meta = this.escape(result.model + ' · ' + result.effort + ' · ' + date + (result.durationMs != null ? ' · ' + (result.durationMs / 1000).toFixed(1) + ' 秒' : ''));
        markup += '<details class="intelligence-details" data-id="' + row.routeId + '"><summary><span class="intelligence-state ' + result.state + '">' + labels[result.state] +
          '</span>' + this.reviewBadge(result.review) + '<span>测试结果</span><span class="intelligence-meta">' + meta + '</span></summary><div class="intelligence-content">' +
          (result.error ? '<p class="intelligence-error">' + this.escape(result.error) + '</p>' : '') +
          (result.transport === 'codex-cli' ? '<p class="intelligence-help">生成通道：Codex CLI 兼容通道 · 输出上限由 CLI 管理</p>' : '') +
          (result.transport === 'packy-api' ? '<p class="intelligence-help">生成通道：Packycode 纯 API</p>' : '') +
          this.reviewMarkup(result, this.pending.has(row.routeId)) +
          (result.resultUrl ? '<a class="intelligence-link" href="' + this.escape(result.resultUrl) + '" target="_blank" rel="noopener noreferrer">打开动画页面 ↗</a>' : '') +
          (result.screenshotUrl ? '<a href="' + this.escape(result.resultUrl) + '" target="_blank" rel="noopener noreferrer" aria-label="打开此中转生成的动画"><img class="intelligence-image" src="' +
            this.escape(result.screenshotUrl) + '" alt="' + this.escape(row.name) + ' · 鹈鹕骑自行车动画截图" loading="lazy" width="1280" height="800"></a>' :
            ['queued', 'generating', 'rendering'].includes(result.state) ? '<p class="intelligence-help">任务在后台独立执行，可以继续测试其他中转。</p>' : '') +
          (result.usage?.total_tokens != null ? '<p class="intelligence-help">用量：' + this.escape(result.usage.total_tokens) + ' tokens</p>' : '') + '</div></details>';
      }
      if (host._markup !== markup) {
        const wasOpen = host.querySelector('details')?.open || this.open.has(row?.routeId);
        host.innerHTML = markup; host._markup = markup;
        if (wasOpen && host.querySelector('details')) host.querySelector('details').open = true;
      }
      host.hidden = !markup;
    }
  }

  async start(name) {
    const row = this.latest?.rows.find(row => row.name === name);
    if (!row || this.pending.has(row.routeId) || this.blocked()) return;
    this.model.value = this.model.value.trim();
    if (!this.model.checkValidity()) { this.model.closest('details').open = true; this.model.reportValidity(); return; }
    const scope = this.latest.scope;
    this.pending.add(row.routeId); this.messages.delete(row.routeId); this.sync();
    try {
      const data = await this.request('/api/intelligence/start', { scope, name, routeId: row.routeId, model: this.model.value, effort: this.effort.value, reviewEnabled: this.reviewEnabled.checked });
      if (this.getState().intelligence?.scope !== scope) return;
      row.result = data.result;
      const snapshot = await this.request('/api/intelligence');
      if (this.getState().intelligence?.scope === scope && snapshot.scope === scope) this.getState().intelligence = snapshot;
    } catch (error) {
      if (this.getState().intelligence?.scope === scope) this.messages.set(row.routeId, error.message);
    } finally { this.pending.delete(row.routeId); this.sync(); }
  }

  async startAll() {
    if (this.blocked()) return;
    const rows = this.latest?.rows || [];
    await Promise.all(rows.map(row => this.start(row.name)));
  }

  async startReview(name) {
    const row = this.latest?.rows.find(row => row.name === name);
    if (!row?.result || this.pending.has(row.routeId) || this.blocked()) return;
    const scope = this.latest.scope;
    this.pending.add(row.routeId); this.messages.delete(row.routeId); this.sync();
    try {
      const data = await this.request('/api/intelligence/review', { scope, name, routeId: row.routeId, runId: row.result.runId });
      if (this.getState().intelligence?.scope !== scope) return;
      row.result = data.result;
      const snapshot = await this.request('/api/intelligence');
      if (this.getState().intelligence?.scope === scope && snapshot.scope === scope) this.getState().intelligence = snapshot;
    } catch (error) {
      if (this.getState().intelligence?.scope === scope) this.messages.set(row.routeId, error.message);
    } finally { this.pending.delete(row.routeId); this.sync(); }
  }
}
