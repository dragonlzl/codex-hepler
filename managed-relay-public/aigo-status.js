class AigoStatusControls {
  constructor(list, onChange, { getState, mutateStatusMode, site = 'aigo' }) {
    Object.assign(this, { onChange, getState, mutateStatusMode, site });
    this.busy = new Set();
    this.errors = new Map();
    list.addEventListener('change', event => {
      if (event.target.matches('.' + this.site + '-mode-option')) this.setMode(event.target);
    });
  }

  paint(target, name) {
    const state = this.getState(), entry = state.keys.find(item => item.name === name);
    if (!entry) return;
    const disabled = this.busy.has(name) || !state[this.site + 'StatusModeAvailable'];
    const html = '<fieldset class="aigo-mode"' + (disabled ? ' disabled' : '') + '><legend>号池展示</legend>' +
      [['all', '全部号池'], ['api-key', '跟随 API Key']].map(([value, label]) => '<label><input class="' + this.site + '-mode-option" type="radio" name="' + this.site + '-mode-' + escapeHtml(encodeURIComponent(name)) + '" value="' + value + '"' + ((entry.statusMode || 'all') === value ? ' checked' : '') + ' />' + label + '</label>').join('') + '</fieldset>' +
      (this.errors.has(name) ? '<p class="aigo-mode-error" role="status">' + escapeHtml(this.errors.get(name)) + '</p>' : '') +
      (!state[this.site + 'StatusModeAvailable'] ? '<p class="aigo-mode-error">请重启管理服务以启用号池切换。</p>' : '');
    if (target.dataset.markup !== html) { target.innerHTML = html; target.dataset.markup = html; }
  }

  async setMode(input) {
    const account = input.closest('.provider-account'), name = account.dataset.name;
    if (this.busy.has(name)) return;
    const entry = this.getState().keys.find(item => item.name === name);
    if (!entry) return;
    const target = account.querySelector('.' + this.site + '-status-mode');
    this.busy.add(name); this.errors.delete(name);
    input.closest('fieldset').disabled = true;
    try {
      await this.mutateStatusMode({ name, mode: input.value, previousMode: entry.statusMode || 'all', revision: entry.revision });
    } catch (error) { this.errors.set(name, error.message || '切换失败，请刷新后重试。'); }
    finally {
      this.busy.delete(name);
      target.dataset.markup = '';
      this.paint(target, name);
      this.onChange();
    }
  }
}
