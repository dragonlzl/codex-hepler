class PackyBalanceControls {
  constructor(list, onChange, { getState, mutateBalanceSource } = {}) {
    this.onChange = onChange;
    this.getState = getState;
    this.mutateBalanceSource = mutateBalanceSource;
    this.sourceBusy = new Set();
    this.sourceErrors = new Map();
    this.dialog = document.querySelector('#packy-balance-dialog');
    this.form = document.querySelector('#packy-balance-form');
    this.feedback = document.querySelector('#packy-balance-feedback');
    this.busy = false;
    list.addEventListener('click', event => {
      if (event.target.closest('.packy-settings')) this.open();
      const refresh = event.target.closest('.packy-refresh');
      if (refresh) this.refresh(refresh, refresh.closest('.provider-account').dataset.name);
    });
    list.addEventListener('change', event => {
      if (event.target.matches('.packy-source-option')) this.setSource(event.target);
    });
    this.form.addEventListener('submit', event => { event.preventDefault(); this.save(); });
    document.querySelector('#packy-balance-cancel').addEventListener('click', () => { if (!this.busy) this.dialog.close(); });
    this.dialog.addEventListener('cancel', event => { if (this.busy) event.preventDefault(); });
  }

  paintSource(target, name, status) {
    const state = this.getState(), entry = state.keys.find(item => item.name === name);
    if (!entry) return;
    const source = status?.balanceSource || entry.balanceSource || 'api-key';
    const disabled = this.sourceBusy.has(name) || !state.packyBalanceSourceAvailable;
    const html = '<fieldset class="packy-source"' + (disabled ? ' disabled' : '') + '><legend>余额来源</legend>' +
      [['api-key', 'API Key 限额'], ['account', '登录账号余额']].map(([value, label]) => '<label><input class="packy-source-option" type="radio" name="packy-source-' + escapeHtml(encodeURIComponent(name)) + '" value="' + value + '"' + (source === value ? ' checked' : '') + ' />' + label + '</label>').join('') + '</fieldset>' +
      (this.sourceErrors.has(name) ? '<p class="packy-source-error" role="status">' + escapeHtml(this.sourceErrors.get(name)) + '</p>' : '') +
      (!state.packyBalanceSourceAvailable ? '<p class="packy-source-error">请重启管理服务以启用余额来源切换。</p>' : '');
    if (target.dataset.markup !== html) { target.innerHTML = html; target.dataset.markup = html; }
  }

  async setSource(input) {
    const account = input.closest('.provider-account'), name = account.dataset.name;
    if (this.sourceBusy.has(name)) return;
    const entry = this.getState().keys.find(item => item.name === name);
    if (!entry) return;
    const target = account.querySelector('.account-balance-source');
    this.sourceBusy.add(name); this.sourceErrors.delete(name);
    input.closest('fieldset').disabled = true;
    try {
      await this.mutateBalanceSource({ name, source: input.value, previousSource: entry.balanceSource || 'api-key', revision: entry.revision });
    } catch (error) { this.sourceErrors.set(name, error.message || '切换失败，请刷新后重试。'); }
    finally {
      this.sourceBusy.delete(name);
      // Restore the persisted choice on failure, including the radio's live checked property.
      target.dataset.markup = '';
      this.paintSource(target, name);
      this.onChange();
    }
  }

  async api(url, payload) {
    const response = await fetch(url, payload ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(12000) }
      : { cache: 'no-store', signal: AbortSignal.timeout(12000) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '余额操作失败，请稍后重试。');
    return data;
  }

  lock(busy) { this.busy = busy; for (const control of this.form.elements) control.disabled = busy; }

  async open() {
    if (this.busy || this.dialog.open) return;
    this.form.reset(); this.feedback.textContent = '正在读取设置…'; this.dialog.showModal(); this.lock(true);
    try {
      const { settings } = await this.api('/api/packycode/balance/settings');
      for (const [key, value] of Object.entries(settings)) if (this.form.elements[key]) this.form.elements[key].value = value;
      this.feedback.textContent = '';
    } catch (error) { this.feedback.textContent = error.message; }
    finally { this.lock(false); this.form.elements.api_base_url.focus(); }
  }

  async save() {
    if (this.busy) return;
    this.lock(true); this.feedback.textContent = '正在保存…';
    try {
      const fields = this.form.elements;
      await this.api('/api/packycode/balance/settings', { api_base_url: fields.api_base_url.value,
        request_timeout_seconds: Number(fields.request_timeout_seconds.value), refresh_interval_seconds: Number(fields.refresh_interval_seconds.value) });
      this.dialog.close(); this.onChange();
    } catch (error) { this.feedback.textContent = error.message; }
    finally { this.lock(false); }
  }

  async refresh(button, name) {
    if (button.disabled) return;
    button.disabled = true; button.textContent = '查询中…';
    try { await this.api('/api/packycode/balance/refresh', { name }); this.onChange(); }
    catch (error) {
      const target = button.closest('.packy-balance');
      let message = target.querySelector('.packy-balance-error');
      if (!message) { message = document.createElement('p'); message.className = 'packy-balance-error'; target.append(message); }
      message.textContent = error.message;
    } finally { button.disabled = false; button.textContent = '刷新余额'; }
  }
}
