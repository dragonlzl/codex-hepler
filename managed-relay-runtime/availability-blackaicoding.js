const { parse } = require('parse5');

function elements(node, matches) {
  const found = [];
  const visit = current => {
    if (current.tagName && matches(current)) found.push(current);
    for (const child of current.childNodes || []) visit(child);
  };
  visit(node);
  return found;
}

const attribute = (node, name) => node.attrs?.find(item => item.name === name)?.value || '';
const hasClass = (node, name) => attribute(node, 'class').split(/\s+/).includes(name);
const text = node => node.nodeName === '#text' ? node.value : (node.childNodes || []).map(text).join('');

function percentage(value) {
  if (value === '-') return null;
  if (!/^\d+(?:\.\d+)?%$/.test(value)) throw new Error('Invalid status percentage');
  const number = Number(value.slice(0, -1));
  if (number > 100) throw new Error('Invalid status percentage');
  return number;
}

function readBlackaicodingStatus(html, models, now = Date.now()) {
  if (typeof html !== 'string') throw new Error('Invalid status page');
  const document = parse(html);
  const meta = elements(document, node => hasClass(node, 'meta'))[0];
  const updated = meta && text(meta).match(/更新时间[：:]\s*(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/)?.[1];
  if (!updated) throw new Error('Missing status snapshot time');
  // The source omits its timezone. Keep its wall-clock labels instead of inventing UTC timestamps.
  const wallTime = Date.parse(updated.replace(' ', 'T') + 'Z');
  if (!Number.isFinite(wallTime) || new Date(wallTime).toISOString().slice(0, 19).replace('T', ' ') !== updated) {
    throw new Error('Invalid status snapshot time');
  }
  const stale = elements(document, node => hasClass(node, 'warn')).length > 0 || now - wallTime > 14 * 3600000 + 180000;
  const table = elements(document, node => node.tagName === 'table').find(node => elements(node, child => hasClass(child, 'model-name')).length);
  if (!table) throw new Error('Missing status components');
  const headers = elements(table, node => node.tagName === 'th').map(node => text(node).trim());
  const rateColumn = headers.findIndex(value => /^1\s*小时可用率$/.test(value));
  if (rateColumn < 0) throw new Error('Missing hourly status metric');
  const result = {};
  for (const row of elements(table, node => node.tagName === 'tr')) {
    const name = elements(row, node => hasClass(node, 'model-name'))[0];
    const model = name && text(name).trim();
    if (!models.includes(model)) continue;
    if (result[model]) throw new Error('Duplicate status model');
    const timeline = elements(row, node => hasClass(node, 'timeline'))[0];
    const ticks = timeline && elements(timeline, node => hasClass(node, 'tick'));
    const cells = elements(row, node => node.tagName === 'td');
    if (!ticks?.length || !cells[rateColumn]) throw new Error('Incomplete status row');
    const history = ticks.slice(-60).map((tick, index, visible) => {
      const states = { good: 'available', watch: 'degraded', bad: 'unavailable', unknown: 'no-data' };
      const kinds = Object.keys(states).filter(kind => hasClass(tick, kind));
      if (kinds.length !== 1) throw new Error('Invalid status interval');
      const state = states[kinds[0]];
      const title = attribute(tick, 'title');
      if (!title) throw new Error('Missing status interval details');
      const start = Math.floor(wallTime / 30000) * 30000 - (visible.length - 1 - index) * 30000;
      const startLabel = new Date(start).toISOString().slice(11, 19);
      const endLabel = new Date(start + 30000).toISOString().slice(11, 19);
      return {
        at: null, state, ok: state === 'available' ? true : state === 'unavailable' ? false : null,
        timeLabel: startLabel, endTimeLabel: endLabel,
        label: new Date(start).toISOString().slice(0, 10) + ' ' + startLabel + ' - ' + endLabel + '\n' + title.slice(0, 500),
        latencyMs: null, error: null,
      };
    });
    result[model] = {
      history, last: history.at(-1), stale,
      uptimePct: percentage(text(cells[rateColumn]).trim()),
      uptimeLabel: '1 小时可用率', historyLabel: '时段', sourceUpdatedAtLabel: updated,
    };
  }
  return result;
}

module.exports = { readBlackaicodingStatus };
