const state = { keys: [], visible: new Set(), query: '' };
const list = document.querySelector('#key-list');
const emptyState = document.querySelector('#empty-state');
const count = document.querySelector('#total-count');
const connectionStatus = document.querySelector('#connection-status');
const statusPill = document.querySelector('.status-pill');
const form = document.querySelector('#add-form');
const formMessage = document.querySelector('#form-message');
const submitButton = document.querySelector('#submit-button');

function mask(value) {
  if (!value) return '';
  if (value.length <= 8) return `${value.slice(0, 2)}••••${value.slice(-2)}`;
  return `${value.slice(0, 5)}••••••••${value.slice(-4)}`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
}

function render() {
  const query = state.query.toLowerCase();
  const visibleKeys = state.keys.filter((item) => [item.name, item.baseurl].some((value) => value.toLowerCase().includes(query)));
  count.textContent = state.keys.length;
  list.innerHTML = visibleKeys.map((item, index) => {
    const originalIndex = state.keys.indexOf(item);
    const revealed = state.visible.has(originalIndex);
    return `<article class="key-item">
      <div class="item-name"><span class="item-label">名称</span>${escapeHtml(item.name)}</div>
      <div class="item-value"><span class="item-label">API KEY</span>${escapeHtml(revealed ? item.value : mask(item.value))}</div>
      <div class="item-url"><span class="item-label">BASE URL</span>${escapeHtml(item.baseurl)}</div>
      <div class="item-actions">
        <button class="icon-button" type="button" data-action="reveal" data-index="${originalIndex}" title="${revealed ? '隐藏 API Key' : '显示 API Key'}" aria-label="${revealed ? '隐藏 API Key' : '显示 API Key'}">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.5 12s3.5-5 9.5-5 9.5 5 9.5 5-3.5 5-9.5 5-9.5-5-9.5-5Z"></path><circle cx="12" cy="12" r="2.5"></circle></svg>
        </button>
        <button class="icon-button" type="button" data-action="copy" data-index="${originalIndex}" title="复制 API Key" aria-label="复制 API Key">
          <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="11" height="11" rx="1.5"></rect><path d="M16 8V6.5A1.5 1.5 0 0 0 14.5 5h-8A1.5 1.5 0 0 0 5 6.5v8A1.5 1.5 0 0 0 6.5 16H8"></path></svg>
        </button>
      </div>
    </article>`;
  }).join('');
  emptyState.hidden = visibleKeys.length > 0;
}

async function loadKeys() {
  try {
    const response = await fetch('/api/keys');
    if (!response.ok) throw new Error('加载失败');
    const data = await response.json();
    state.keys = data.keys || [];
    statusPill.classList.add('connected');
    connectionStatus.textContent = '已连接';
    render();
  } catch (error) {
    connectionStatus.textContent = '连接失败';
    formMessage.textContent = '无法读取配置文件，请检查本地服务。';
    formMessage.className = 'form-message error';
  }
}

document.querySelector('#search-input').addEventListener('input', (event) => {
  state.query = event.target.value.trim();
  render();
});

list.addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  const index = Number(button.dataset.index);
  const item = state.keys[index];
  if (!item) return;
  if (button.dataset.action === 'reveal') {
    state.visible.has(index) ? state.visible.delete(index) : state.visible.add(index);
    render();
  } else if (button.dataset.action === 'copy') {
    try {
      await navigator.clipboard.writeText(item.value);
      button.title = '已复制';
      setTimeout(() => { button.title = '复制 API Key'; }, 1400);
    } catch {
      formMessage.textContent = '浏览器未允许复制，请手动查看 API Key。';
      formMessage.className = 'form-message error';
    }
  }
});

document.querySelector('#toggle-new-key').addEventListener('click', () => {
  const input = document.querySelector('#value-input');
  input.type = input.type === 'password' ? 'text' : 'password';
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  formMessage.textContent = '';
  formMessage.className = 'form-message';
  const payload = Object.fromEntries(new FormData(form).entries());
  submitButton.disabled = true;
  try {
    const response = await fetch('/api/keys', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '保存失败');
    state.keys.push(data.key);
    state.visible.clear();
    form.reset();
    formMessage.textContent = '配置已保存';
    render();
  } catch (error) {
    formMessage.textContent = error.message;
    formMessage.className = 'form-message error';
  } finally {
    submitButton.disabled = false;
  }
});

loadKeys();
