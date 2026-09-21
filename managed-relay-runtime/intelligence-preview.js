const { setTimeout: delay } = require('node:timers/promises');
const { launchSession } = require('./chrome-session');

const VIEWPORT = { width: 1280, height: 800 };
const CAPTURE_DELAY = 2000;
const CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; frame-src about:; object-src 'none'; base-uri 'none'; form-action 'none'";
const escape = text => String(text).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

function previewDocument(html) {
  // The generated code only enters an opaque-origin iframe. It cannot reach this origin's APIs,
  // navigate the parent, open windows, submit forms, or load external resources.
  return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta http-equiv="Content-Security-Policy" content="' + escape(CSP) + '"><title>鹈鹕骑自行车 · 智力测试结果</title>' +
    '<style>html,body{margin:0;width:100%;height:100%;background:white}iframe{display:block;width:100%;height:100%;border:0}</style></head>' +
    '<body><iframe title="生成的 SVG 动画" sandbox="allow-scripts" referrerpolicy="no-referrer" srcdoc="' + escape(html) + '"></iframe></body></html>';
}

async function screenshot(html, signal) {
  const browser = await launchSession(signal, { headless: true, size: VIEWPORT });
  const { command, sessionId } = browser;
  try {
    // Block navigations as well as subresources while rendering untrusted output.
    browser.onEvent(event => {
      if (event.method === 'Fetch.requestPaused') command('Fetch.failRequest', { requestId: event.params.requestId, errorReason: 'BlockedByClient' }, event.sessionId).catch(() => {});
    });
    await command('Fetch.enable', { patterns: [{ urlPattern: '*' }] }, sessionId);
    await command('Emulation.setDeviceMetricsOverride', { ...VIEWPORT, deviceScaleFactor: 1, mobile: false }, sessionId);
    const { frameTree } = await command('Page.getFrameTree', {}, sessionId);
    await command('Page.setDocumentContent', { frameId: frameTree.frame.id, html: previewDocument(html) }, sessionId);
    await delay(CAPTURE_DELAY, undefined, { signal });
    const { data } = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, sessionId);
    if (typeof data !== 'string' || data.length > 12 * 1024 * 1024 || !data.startsWith('iVBORw0KGgo')) throw new Error('Invalid screenshot');
    return data;
  } finally { await browser.close(); }
}

module.exports = { screenshot, previewDocument, CSP, VIEWPORT, CAPTURE_DELAY };
