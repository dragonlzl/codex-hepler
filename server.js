const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { URL } = require('node:url');

const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT || 3789);
// 与完整版保持一致：优先 CODEX_HOME，否则用当前用户的 ~/.codex。
const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const CONFIG_PATH = path.join(CODEX_HOME, 'key_config.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function json(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

async function readConfig() {
  const raw = await fs.readFile(CONFIG_PATH, 'utf8');
  const config = JSON.parse(raw);
  if (!config || !Array.isArray(config.keys)) {
    throw new Error('配置文件格式无效：缺少 keys 数组');
  }
  return config;
}

async function writeConfig(config) {
  const tempPath = `${CONFIG_PATH}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  const content = `${JSON.stringify(config, null, 2)}\n`;
  await fs.writeFile(tempPath, content, { encoding: 'utf8', mode: 0o600 });
  await fs.rename(tempPath, CONFIG_PATH);
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        req.destroy();
        reject(new Error('请求内容过大'));
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function validateEntry(payload) {
  if (!payload || typeof payload !== 'object') return '请求格式无效';
  const fields = ['name', 'value', 'baseurl'];
  for (const field of fields) {
    if (typeof payload[field] !== 'string' || !payload[field].trim()) {
      return `请填写${field}`;
    }
    if (payload[field].length > 2000) return `${field} 长度过长`;
  }

  try {
    const url = new URL(payload.baseurl.trim());
    if (!['http:', 'https:'].includes(url.protocol)) return 'baseurl 必须使用 HTTP 或 HTTPS';
  } catch {
    return 'baseurl 不是有效地址';
  }
  return null;
}

async function handleApi(req, res, requestUrl) {
  if (req.method === 'GET' && requestUrl.pathname === '/api/keys') {
    const config = await readConfig();
    return json(res, 200, { keys: config.keys });
  }

  if (req.method === 'POST' && requestUrl.pathname === '/api/keys') {
    let payload;
    try {
      payload = JSON.parse(await readRequestBody(req));
    } catch {
      return json(res, 400, { error: '请求 JSON 无效' });
    }

    const error = validateEntry(payload);
    if (error) return json(res, 400, { error });

    const config = await readConfig();
    const entry = {
      name: payload.name.trim(),
      value: payload.value.trim(),
      baseurl: payload.baseurl.trim().replace(/\/$/, ''),
    };
    if (config.keys.some((item) => item.name === entry.name)) {
      return json(res, 409, { error: '已存在同名中转站' });
    }
    config.keys.push(entry);
    await writeConfig(config);
    return json(res, 201, { key: entry, count: config.keys.length });
  }

  return json(res, 404, { error: '接口不存在' });
}

async function serveStatic(res, requestUrl) {
  const requested = requestUrl.pathname === '/' ? '/index.html' : requestUrl.pathname;
  const filePath = path.resolve(PUBLIC_DIR, `.${requested}`);
  if (!filePath.startsWith(`${PUBLIC_DIR}${path.sep}`)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) throw new Error('not a file');
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[path.extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(await fs.readFile(filePath));
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }
}

const server = http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url, `http://${req.headers.host || HOST}`);
  try {
    if (requestUrl.pathname.startsWith('/api/')) {
      await handleApi(req, res, requestUrl);
    } else if (req.method === 'GET' || req.method === 'HEAD') {
      await serveStatic(res, requestUrl);
    } else {
      json(res, 405, { error: '方法不允许' });
    }
  } catch (error) {
    console.error(error);
    json(res, 500, { error: error.message || '服务器错误' });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Relay config UI running at http://${HOST}:${PORT}`);
  console.log(`Reading ${CONFIG_PATH}`);
});
