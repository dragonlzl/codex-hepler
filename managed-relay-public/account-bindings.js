class AccountBindings {
  constructor({ list, getState, mutate }) {
    Object.assign(this, { list, getState, mutate });
    this.dialog = document.querySelector('#account-binding-dialog');
    this.form = document.querySelector('#account-binding-form');
    this.feedback = document.querySelector('#account-binding-feedback');
    this.submit = document.querySelector('#account-binding-save');
    this.unbindAll = document.querySelector('#account-unbind-all');
    this.busy = false;
    list.addEventListener('click', event => {
      const button = event.target.closest('.account-bind-button');
      if (button && !button.disabled) this.open(button.closest('.provider-account').dataset.name);
    });
    this.form.addEventListener('submit', event => { event.preventDefault(); this.bind(); });
    this.form.addEventListener('change', () => this.controls());
    document.querySelector('#account-binding-cancel').addEventListener('click', () => { if (!this.busy) this.dialog.close(); });
    this.unbindAll.addEventListener('click', () => this.unbind(this.target.name, true));
    document.querySelector('#account-bound-members').addEventListener('click', event => {
      const button = event.target.closest('[data-unbind-name]');
      if (button) this.unbind(button.dataset.unbindName);
    });
    this.dialog.addEventListener('cancel', event => { if (this.busy) event.preventDefault(); });
    this.dialog.addEventListener('close', () => { this.form.reset(); });
  }

  open(name) {
    if (this.busy || this.dialog.open) return;
    const state = this.getState();
    this.target = state.keys.find(entry => entry.name === name);
    if (!this.target || !state.accountBindingAvailable) return;
    this.revision = state.accountBindingsRevision;
    this.form.reset(); this.feedback.textContent = '';
    const groups = new Map();
    for (const entry of state.keys.filter(entry => entry.merchantId === this.target.merchantId)) {
      if (!groups.has(entry.accountId)) groups.set(entry.accountId, []);
      groups.get(entry.accountId).push(entry);
    }
    const members = groups.get(this.target.accountId);
    this.candidates = [...groups.values()].filter(items => items[0].accountId !== this.target.accountId);
    document.querySelector('#account-binding-title').textContent = this.target.accountBindingId ? '管理账号绑定' : '设为同一账号';
    document.querySelector('#account-binding-source').textContent = '共享信息来源：' + this.target.accountSourceName;
    document.querySelector('#account-binding-description').textContent = '选中的账号将与「' + members.map(entry => entry.name).join('、') + '」共用登录、余额和订阅。登录任意一个即可更新全部绑定成员。';
    document.querySelector('#account-binding-help').textContent = this.target.merchantId === 'packycode'
      ? 'Packycode 使用信息来源配置的 Key 查询余额，不累加各 Key 的额度。解绑后恢复各自的 Key 查询。'
      : '沿用信息来源账号已保存的授权；若尚未登录，绑定后登录一次即可。解绑会恢复该账号原有的独立授权，其余成员继续共用。';
    const natural = new Map();
    for (const entry of members) {
      if (!natural.has(entry.naturalAccountId)) natural.set(entry.naturalAccountId, []);
      natural.get(entry.naturalAccountId).push(entry);
    }
    const memberList = document.querySelector('#account-bound-members');
    memberList.innerHTML = [...natural.values()].map(items => '<div class="binding-member"><div><strong>' + escapeHtml(items.map(entry => entry.name).join(' / ')) + '</strong><code>' + escapeHtml(items[0].baseurl) + '</code><small>' + escapeHtml(items[0].maskedValue) + '</small></div>' + (this.target.accountBindingId ? '<button type="button" data-unbind-name="' + escapeHtml(items[0].name) + '">解绑</button>' : '') + '</div>').join('');
    document.querySelector('#account-binding-options').innerHTML = this.candidates.map((items, i) => '<label class="binding-choice"><input type="checkbox" name="accounts" value="' + i + '" /><span><strong>' + escapeHtml(items.map(entry => entry.name).join(' / ')) + '</strong><small>' + escapeHtml([...new Set(items.map(entry => entry.baseurl))].join(' · ')) + '</small>' + (items[0].accountBindingId ? '<small>已绑定账号，将整体合并</small>' : '') + '</span></label>').join('') || '<p class="binding-empty">当前中转商没有其他可绑定的账号。</p>';
    this.unbindAll.hidden = !this.target.accountBindingId;
    this.controls(); this.dialog.showModal();
  }

  controls() {
    for (const control of this.form.elements) control.disabled = this.busy;
    this.submit.disabled = this.busy || !this.form.querySelector('input[name="accounts"]:checked');
    this.form.setAttribute('aria-busy', String(this.busy));
  }

  bind() {
    const names = [...this.form.querySelectorAll('input[name="accounts"]:checked')].map(input => this.candidates[Number(input.value)][0].name);
    if (!names.length) return;
    return this.perform('/api/accounts/bind', { targetName: this.target.name, names, revision: this.revision });
  }

  unbind(name, all = false) {
    return this.perform('/api/accounts/unbind', { name, all, accountId: this.target.accountId, revision: this.revision });
  }

  async perform(endpoint, payload) {
    if (this.busy) return;
    this.busy = true; this.controls(); this.feedback.textContent = '正在保存账号设置…';
    try { await this.mutate(endpoint, payload); this.dialog.close(); }
    catch (error) { this.feedback.textContent = errorMessage(error); }
    finally { this.busy = false; this.controls(); }
  }
}
