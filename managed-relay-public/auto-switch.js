class AutoSwitchControls {
  constructor({ getState, request, mutate }) {
    Object.assign(this, { getState, request, mutate });
    this.toggle = document.querySelector('#auto-enabled');
    this.openButton = document.querySelector('#auto-settings-open');
    this.dialog = document.querySelector('#auto-settings-dialog');
    this.form = document.querySelector('#auto-settings-form');
    this.editor = document.querySelector('#auto-pool-editor');
    this.feedback = document.querySelector('#auto-feedback');
    this.formFeedback = document.querySelector('#auto-settings-feedback');
    this.busy = false;
    this.toggle.addEventListener('change', () => this.setEnabled());
    this.openButton.addEventListener('click', () => this.open());
    document.querySelector('#auto-settings-cancel').addEventListener('click', () => this.dialog.close());
    this.dialog.addEventListener('cancel', event => { if (this.busy) event.preventDefault(); });
    this.form.addEventListener('submit', event => { event.preventDefault(); this.save(); });
    this.editor.addEventListener('change', () => this.updateFields());
  }

  sync() {
    const state = this.getState(), settings = state.autoSwitchSettings, runtime = state.autoSwitch;
    this.toggle.checked = this.pendingEnabled ?? settings?.enabled === true;
    this.toggle.disabled = this.busy || !settings || (!settings.enabled && (!state.proxyInstalled || !settings.pool.length));
    this.openButton.disabled = this.busy || !settings;
    document.querySelector('#auto-status').textContent = !settings ? '正在读取设置…' : !settings.enabled ?
      (!state.proxyInstalled ? '已关闭 · 接入本地代理后可开启' : !settings.pool.length ? '已关闭 · 请先设置优先级池' : `已关闭 · 池中 ${settings.pool.length} 个入口`) :
      (runtime?.message || '等待后台检测');
    const last = runtime?.lastSwitch;
    document.querySelector('#auto-last-switch').textContent = last ?
      `最近切换：${last.from || '未选择'} → ${last.to} · ${last.reason} · ${new Date(last.at).toLocaleTimeString()}` : '';
    const list = document.querySelector('#auto-candidate-list');
    list.replaceChildren(...(runtime?.candidates || []).map(item => {
      const li = document.createElement('li');
      li.className = item.eligible ? 'eligible' : 'excluded';
      li.textContent = `${item.name} · 优先级 ${item.priority} · ${item.source === 'subscription' ? '订阅' : '余额'} · ${item.reason}`;
      return li;
    }));
    if (!list.children.length) { const li = document.createElement('li'); li.textContent = '开启后显示后台检测结果。'; list.append(li); }
    if (this.dialog.open && this.context && this.context !== state.home) {
      this.dialog.close(); this.feedback.textContent = '配置目录已变化，请重新打开自动切换设置。';
    }
  }

  async setEnabled() {
    const enabled = this.toggle.checked;
    this.pendingEnabled = enabled;
    this.busy = true; this.sync(); this.feedback.textContent = enabled ? '正在开启…' : '正在关闭…';
    try {
      const result = await this.mutate('/api/auto-switch/toggle', { enabled, revision: this.getState().autoSwitchRevision });
      this.feedback.textContent = result.message;
    } catch (error) { this.feedback.textContent = error.message; }
    finally { this.busy = false; this.pendingEnabled = undefined; this.sync(); }
  }

  async open() {
    this.busy = true; this.sync(); this.formFeedback.textContent = '正在读取可关联的订阅…';
    this.revision = null;
    this.editor.replaceChildren();
    this.context = this.getState().home;
    this.dialog.showModal();
    this.form.querySelectorAll('input, select, button').forEach(control => { control.disabled = true; });
    try {
      const data = await this.request('/api/auto-switch/options');
      if (this.context !== this.getState().home || !this.dialog.open) return;
      this.revision = data.revision;
      this.form.elements.model.value = data.settings.model;
      this.form.elements.subscriptionMinimum.value = data.settings.subscriptionMinimum;
      this.form.elements.balanceMinimum.value = data.settings.balanceMinimum;
      this.renderPool(data);
      this.formFeedback.textContent = '';
    } catch (error) { this.formFeedback.textContent = error.message; this.revision = null; }
    finally {
      this.busy = false;
      this.form.querySelectorAll('input, select, button').forEach(control => { control.disabled = false; });
      this.updateFields(); this.sync();
    }
  }

  renderPool(data) {
    const groups = new Map();
    for (const key of data.keys) {
      if (!groups.has(key.merchantId)) groups.set(key.merchantId, []);
      groups.get(key.merchantId).push(key);
    }
    let index = 0;
    for (const [merchant, keys] of groups) {
      const section = document.createElement('fieldset'); section.className = 'auto-merchant';
      const legend = document.createElement('legend'); legend.textContent = RelayGroups.providerLabel(merchant.includes('://') ? merchant : 'merchant:' + merchant); section.append(legend);
      const priorityLabel = document.createElement('label'); priorityLabel.className = 'auto-priority'; priorityLabel.textContent = '中转商优先级';
      const priority = document.createElement('input'); Object.assign(priority, { type: 'number', min: '1', max: '9999', step: '1', required: true });
      priority.dataset.priority = '';
      index++;
      priority.value = data.settings.pool.find(item => keys.some(key => key.name === item.name))?.priority || index;
      priorityLabel.append(priority); section.append(priorityLabel);
      for (const key of keys) {
        const saved = data.settings.pool.find(item => item.name === key.name);
        const row = document.createElement('div'); row.className = 'auto-pool-row'; row.dataset.name = key.name;
        const label = document.createElement('label'); label.className = 'auto-include';
        const include = document.createElement('input'); include.type = 'checkbox'; include.dataset.include = ''; include.checked = Boolean(saved);
        const title = document.createElement('span'); title.textContent = key.name; label.append(include, title);
        const sourceLabel = document.createElement('label'); sourceLabel.textContent = '扣费入口';
        const source = document.createElement('select'); source.dataset.source = '';
        source.add(new Option('请选择', '')); source.add(new Option('余额入口', 'balance')); source.add(new Option('订阅入口', 'subscription'));
        source.value = saved?.source || ''; sourceLabel.append(source);
        const planLabel = document.createElement('label'); planLabel.textContent = '关联订阅';
        const plan = document.createElement('select'); plan.dataset.plan = '';
        plan.add(new Option('请选择实际使用的套餐', ''));
        const plans = data.plans.find(item => item.name === key.name);
        for (const item of plans?.items || []) plan.add(new Option(`${item.name} · #${item.id}${item.state !== 'active' ? '（未生效）' : ''}`, String(item.id)));
        if (saved?.subscriptionId && !Array.from(plan.options).some(option => option.value === String(saved.subscriptionId))) {
          plan.add(new Option(`套餐 #${saved.subscriptionId}（暂不可读取）`, String(saved.subscriptionId)));
        }
        plan.value = saved?.subscriptionId || ''; planLabel.append(plan);
        row.append(label, sourceLabel, planLabel); section.append(row);
      }
      this.editor.append(section);
    }
    if (!groups.size) this.editor.textContent = '请先新增中转配置。';
  }

  updateFields() {
    for (const group of this.editor.querySelectorAll('.auto-merchant')) {
      group.querySelector('[data-priority]').disabled = this.busy || !group.querySelector('[data-include]:checked');
      for (const row of group.querySelectorAll('.auto-pool-row')) {
        const included = row.querySelector('[data-include]').checked;
        const source = row.querySelector('[data-source]'), plan = row.querySelector('[data-plan]');
        source.disabled = this.busy || !included; source.required = included;
        plan.disabled = this.busy || !included || source.value !== 'subscription'; plan.required = included && source.value === 'subscription';
      }
    }
    document.querySelector('#auto-settings-save').disabled = this.busy || !this.revision;
  }

  async save() {
    if (this.busy || !this.revision || !this.form.reportValidity()) return;
    const pool = [];
    for (const group of this.editor.querySelectorAll('.auto-merchant')) for (const row of group.querySelectorAll('.auto-pool-row')) {
      if (!row.querySelector('[data-include]').checked) continue;
      const source = row.querySelector('[data-source]').value;
      pool.push({ name: row.dataset.name, priority: Number(group.querySelector('[data-priority]').value), source,
        ...(source === 'subscription' ? { subscriptionId: Number(row.querySelector('[data-plan]').value) } : {}) });
    }
    const settings = { enabled: this.getState().autoSwitchSettings.enabled && pool.length > 0,
      model: this.form.elements.model.value, subscriptionMinimum: Number(this.form.elements.subscriptionMinimum.value),
      balanceMinimum: Number(this.form.elements.balanceMinimum.value), pool };
    this.busy = true; this.updateFields(); this.sync(); this.formFeedback.textContent = '正在保存…';
    document.querySelector('#auto-settings-cancel').disabled = true;
    try {
      await this.mutate('/api/auto-switch/settings', { settings, revision: this.revision });
      this.dialog.close(); this.feedback.textContent = settings.enabled ? '设置已保存，后台重新检测。' : '设置已保存，可使用开关开启自动切换。';
    } catch (error) { this.formFeedback.textContent = error.message; }
    finally { this.busy = false; document.querySelector('#auto-settings-cancel').disabled = false; this.updateFields(); this.sync(); }
  }
}
