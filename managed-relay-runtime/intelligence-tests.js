const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { atomicWrite, problem } = require('./config-store');
const { accountId } = require('./relay-identity');
const { generate, PROMPT, MAX_OUTPUT_TOKENS } = require('./intelligence-generation');
const { screenshot, previewDocument, VIEWPORT, CAPTURE_DELAY, CSP } = require('./intelligence-preview');
const { review, BASELINE, PROMPT_SHA256 } = require('./intelligence-review');

const ACTIVE = new Set(['queued', 'generating', 'rendering']);
const routeId = entry => createHash('sha256').update(JSON.stringify([entry.name, entry.naturalAccountId || accountId(entry)])).digest('hex');

class Slots {
  constructor(limit) { this.limit = limit; this.active = 0; this.waiters = []; }
  async run(signal, action) {
    signal.throwIfAborted();
    await new Promise((resolve, reject) => {
      const waiter = { resolve: () => { signal.removeEventListener('abort', abort); this.active++; resolve(); } };
      const abort = () => { this.waiters = this.waiters.filter(item => item !== waiter); reject(signal.reason); };
      if (this.active < this.limit) waiter.resolve();
      else { this.waiters.push(waiter); signal.addEventListener('abort', abort, { once: true }); }
    });
    try { signal.throwIfAborted(); return await action(); }
    finally { this.active--; this.waiters.shift()?.resolve(); }
  }
}

class IntelligenceTests {
  constructor(home, getEntry, outbound, options = {}) {
    this.directory = path.join(home, 'relay-ui-runtime', 'intelligence-tests');
    this.getEntry = getEntry;
    this.outbound = outbound;
    this.generate = options.generate || generate;
    this.screenshot = options.screenshot || screenshot;
    this.review = options.review || review;
    this.timeoutMs = options.timeoutMs ?? 10 * 60000;
    this.reviewTimeoutMs = options.reviewTimeoutMs ?? 10 * 60000;
    this.records = new Map();
    this.jobs = new Map();
    this.queues = new Map();
    this.running = new Set();
    this.generationSlots = new Slots(4);
    this.captureSlots = new Slots(2);
    this.reviewSlots = new Slots(4);
    this.scope = randomUUID();
    this.revision = 0;
    this.closed = false;
  }

  serialize(id, action) {
    const next = (this.queues.get(id) || Promise.resolve()).then(action);
    this.queues.set(id, next.catch(() => {}));
    return next;
  }

  async read(id) {
    if (this.records.has(id)) return this.records.get(id);
    let record;
    try { record = JSON.parse(await fs.readFile(path.join(this.directory, id + '.json'), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw problem('无法读取已保存的智力测试结果。', 500); }
    if (record.version !== 1 || record.routeId !== id || !/^[a-f0-9-]{36}$/.test(record.runId) ||
        ![...ACTIVE, 'completed', 'preview_failed', 'failed'].includes(record.state)) throw problem('已保存的智力测试结果格式无效。', 500);
    if (ACTIVE.has(record.state)) {
      record = { ...record, state: 'failed', completedAt: new Date().toISOString(), error: '服务已重启，上次测试中断，请重新执行。' };
      await this.write(record);
    } else if (['queued', 'reviewing'].includes(record.review?.state)) {
      record = { ...record, review: { ...record.review, state: 'failed', verdict: null,
        completedAt: new Date().toISOString(), summary: '服务已重启，上次评审中断，可重试评审。' } };
      await this.write(record);
    } else this.records.set(id, record);
    return record;
  }

  async write(record) {
    const successful = this.successfulResult(record);
    if (successful) record = { ...record, lastSuccessful: successful };
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    await atomicWrite(path.join(this.directory, record.routeId + '.json'), JSON.stringify(record));
    this.records.set(record.routeId, record);
    this.revision++;
  }

  describe(record) {
    if (!record) return null;
    const { routeId: id, runId, name, state, model, effort, startedAt, completedAt, durationMs, error, usage } = record;
    const root = '/intelligence-results/' + id + '/' + runId;
    const result = { routeId: id, runId, name, state, model, effort, startedAt, completedAt, durationMs, error, usage,
      transport: record.transport || null, maxOutputTokens: record.maxOutputTokens,
      reviewEnabled: record.reviewEnabled ?? false, review: record.review || null,
      resultUrl: record.html ? root + '/index.html' : null, screenshotUrl: record.image ? root + '/screenshot.png' : null };
    return { ...result, lastSuccessful: this.successfulResult(record) || record.lastSuccessful || null };
  }

  successfulResult(record) {
    if (record?.state !== 'completed') return null;
    const review = record.review?.state === 'completed'
      ? { state: 'completed', verdict: record.review.verdict, summary: record.review.summary } : null;
    const root = '/intelligence-results/' + record.routeId + '/' + record.runId;
    return { state: 'completed', routeId: record.routeId, name: record.name, runId: record.runId,
      model: record.model, effort: record.effort, resultUrl: record.html ? root + '/index.html' : null,
      screenshotUrl: record.image ? root + '/screenshot.png' : null,
      completedAt: record.review?.state === 'completed' ? record.review.completedAt : record.completedAt, review };
  }

  async snapshot(keys) {
    const rows = await Promise.all(keys.map(entry => this.serialize(routeId(entry), async () => {
      const row = { name: entry.name, routeId: routeId(entry), result: null };
      try { row.result = this.describe(await this.read(row.routeId)); }
      catch { row.error = '已保存的测试结果无法读取，可重新测试替换；若仍失败，请检查目录权限。'; }
      return row;
    })));
    // Read the cache again synchronously so the revision and every row describe the same instant.
    // Otherwise a slow disk read could return an older row stamped with a newer global revision.
    const current = rows.map(row => this.records.has(row.routeId) ? {
      name: row.name, routeId: row.routeId, result: this.describe(this.records.get(row.routeId)),
    } : { ...row, result: null });
    return { scope: this.scope, revision: this.revision, prompt: PROMPT, maxOutputTokens: MAX_OUTPUT_TOKENS, viewport: VIEWPORT, captureDelayMs: CAPTURE_DELAY,
      baseline: { ...BASELINE, imageUrl: '/api/intelligence/baseline.png' }, rows: current };
  }

  async start(payload) {
    if (!payload || Object.keys(payload).some(key => !['name', 'routeId', 'model', 'effort', 'scope', 'reviewEnabled'].includes(key)) ||
        (payload.reviewEnabled !== undefined && typeof payload.reviewEnabled !== 'boolean') ||
        typeof payload.model !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/.test(payload.model) ||
        !['low', 'medium', 'high', 'xhigh'].includes(payload.effort)) throw problem('测试模型或推理强度无效。', 400);
    if (payload.scope !== this.scope) throw problem('服务或配置目录已变化，请刷新后重新测试。', 409);
    const entry = await this.getEntry(payload.name);
    const id = routeId(entry);
    if (payload.routeId !== id) throw problem('中转配置已变化，请刷新后重新测试。', 409);
    return this.serialize(id, async () => {
      if (this.closed) throw problem('测试服务已停止，请刷新后重试。', 409);
      if (routeId(await this.getEntry(payload.name)) !== id) throw problem('中转配置已变化，请刷新后重新测试。', 409);
      // Publish the new record first. A failed disk write must not cancel the last valid run.
      const previous = await this.read(id).catch(() => null);
      const lastSuccessful = this.successfulResult(previous) || previous?.lastSuccessful || null;
      const record = { version: 1, routeId: id, runId: randomUUID(), name: entry.name, state: 'queued',
        model: payload.model, effort: payload.effort, prompt: PROMPT, maxOutputTokens: MAX_OUTPUT_TOKENS,
        reviewEnabled: payload.reviewEnabled ?? true, ...(lastSuccessful ? { lastSuccessful } : {}),
        startedAt: new Date().toISOString(), completedAt: null, durationMs: null };
      await this.write(record);
      this.jobs.get(id)?.controller.abort();
      const job = { id, runId: record.runId, controller: new AbortController() };
      this.track(job, () => this.execute(job, entry, record));
      return this.describe(record);
    });
  }

  track(job, work) {
    this.jobs.set(job.id, job);
    job.promise = Promise.resolve().then(work).finally(() => {
      job.controller.abort();
      this.running.delete(job.promise);
      if (this.jobs.get(job.id) === job) this.jobs.delete(job.id);
    });
    this.running.add(job.promise);
  }

  newReview(record, entry) {
    return { id: randomUUID(), state: 'queued', verdict: null, summary: '', findings: [], limitations: [],
      provider: entry.name, model: record.model, effort: record.effort, startedAt: new Date().toISOString(), completedAt: null,
      baselineSha256: BASELINE.imageSha256, promptSha256: PROMPT_SHA256 };
  }

  async startReview(payload) {
    if (!payload || Object.keys(payload).some(key => !['name', 'routeId', 'runId', 'scope'].includes(key))) throw problem('评审参数无效。', 400);
    if (payload.scope !== this.scope) throw problem('服务或配置目录已变化，请刷新后重试。', 409);
    const entry = await this.getEntry(payload.name), id = routeId(entry);
    if (payload.routeId !== id) throw problem('中转配置已变化，请刷新后重试。', 409);
    return this.serialize(id, async () => {
      if (this.closed) throw problem('测试服务已停止，请刷新后重试。', 409);
      if (routeId(await this.getEntry(payload.name)) !== id) throw problem('中转配置已变化，请刷新后重试。', 409);
      const record = await this.read(id);
      if (!record || record.runId !== payload.runId) throw problem('该结果已被新测试取代，请刷新。', 409);
      if (this.jobs.has(id)) throw problem('该中转的测试或评审正在执行，请稍候。', 409);
      if (record.state !== 'completed' || !record.html || !record.image) throw problem('需要完整 HTML 和截图才能评审。', 409);
      const review = this.newReview(record, entry);
      await this.write({ ...record, lastSuccessful: this.successfulResult(record) || record.lastSuccessful || null, review });
      const job = { id, runId: record.runId, reviewId: review.id, controller: new AbortController() };
      this.track(job, () => this.evaluate(job, entry, record, review));
      return this.describe(this.records.get(id));
    });
  }

  async update(job, fields) {
    return this.serialize(job.id, async () => {
      const current = this.records.get(job.id);
      if (current?.runId !== job.runId || (job.reviewId && current.review?.id !== job.reviewId)) return false;
      await this.write({ ...current, ...fields });
      return true;
    });
  }

  async execute(job, entry, record) {
    const { signal } = job.controller;
    let timedOut = false, generated = false;
    const timer = setTimeout(() => { timedOut = true; job.controller.abort(); }, this.timeoutMs);
    const done = () => ({ completedAt: new Date().toISOString(), durationMs: Date.now() - Date.parse(record.startedAt) });
    try {
      const result = await this.generationSlots.run(signal, async () => {
        await this.update(job, { state: 'generating' });
        signal.throwIfAborted();
        return this.generate(entry, record, this.outbound, signal);
      });
      signal.throwIfAborted();
      generated = true;
      await this.update(job, { state: 'rendering', html: result.html, usage: result.usage || null,
        transport: result.transport || 'responses-api', maxOutputTokens: result.transport === 'codex-cli' ? null : MAX_OUTPUT_TOKENS });
      const image = await this.captureSlots.run(signal, () => this.screenshot(result.html, signal));
      signal.throwIfAborted();
      const review = record.reviewEnabled ? this.newReview(record, entry) : null;
      if (!await this.update(job, { state: 'completed', image, review, ...done() })) return;
      clearTimeout(timer);
      if (review) {
        job.reviewId = review.id;
        await this.evaluate(job, entry, { ...record, html: result.html, image }, review);
      }
    } catch (error) {
      const message = timedOut ? '测试超过 10 分钟，已停止，请重新执行。'
        : this.closed ? '服务已停止，本次测试中断，请重新执行。'
          : signal.aborted ? '本次测试已取消。'
            : generated ? (error.status ? error.message : 'HTML 已生成，但截图失败；可直接打开结果，或安装 / 检查 Chrome 后重试。')
              : error.status ? error.message : '模型请求失败，请检查中转连接后重试。';
      try { await this.update(job, { state: generated && !signal.aborted ? 'preview_failed' : 'failed', error: message, ...done() }); }
      catch {
        // Keep the failure visible even if the filesystem became unavailable during the run.
        const current = this.records.get(job.id);
        if (current?.runId === job.runId) { this.records.set(job.id, { ...current, state: 'failed', error: '结果保存失败，请检查目录权限与剩余空间。', ...done() }); this.revision++; }
      }
    } finally { clearTimeout(timer); job.controller.abort(); }
  }

  async evaluate(job, entry, record, review) {
    const { signal } = job.controller;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; job.controller.abort(); }, this.reviewTimeoutMs);
    const done = () => ({ completedAt: new Date().toISOString(), durationMs: Date.now() - Date.parse(review.startedAt) });
    try {
      const result = await this.reviewSlots.run(signal, async () => {
        if (!await this.update(job, { review: { ...review, state: 'reviewing' } })) throw new Error('Superseded review');
        signal.throwIfAborted();
        return this.review(entry, record, this.outbound, signal);
      });
      signal.throwIfAborted();
      const nextReview = { ...review, state: result.status, verdict: result.verdict, summary: result.summary,
        findings: result.findings, limitations: result.limitations, usage: result.usage || null,
        transport: result.transport || 'responses-api', maxOutputTokens: result.transport === 'codex-cli' ? null : MAX_OUTPUT_TOKENS, ...done() };
      await this.update(job, { review: nextReview });
    } catch (error) {
      const summary = timedOut ? '评审超过 10 分钟，已停止，可重试评审。'
        : this.closed ? '服务已停止，本次评审中断，可重试评审。'
          : signal.aborted ? '本次评审已取消。'
            : error.status ? error.message : '评审请求失败，可重试评审。';
      const failure = { ...review, state: 'failed', verdict: null, summary, ...done() };
      try { await this.update(job, { review: failure }); }
      catch {
        const current = this.records.get(job.id);
        if (current?.runId === job.runId && current.review?.id === job.reviewId) {
          this.records.set(job.id, { ...current, review: { ...failure, summary: '评审结果保存失败，请检查目录权限与剩余空间。' } }); this.revision++;
        }
      }
    } finally { clearTimeout(timer); }
  }

  async artifact(id, runId, kind, keys) {
    if (!keys.some(entry => routeId(entry) === id)) throw problem('中转已变化，结果不可用。', 404);
    return this.serialize(id, async () => {
      const record = await this.read(id);
      if (!record || record.runId !== runId) throw problem('该结果已被新一次测试取代。', 404);
      if (kind === 'index.html' && record.html) return { body: previewDocument(record.html), type: 'text/html; charset=utf-8', csp: CSP };
      if (kind === 'screenshot.png' && record.image) return { body: Buffer.from(record.image, 'base64'), type: 'image/png' };
      throw problem('测试结果尚未就绪。', 404);
    });
  }

  forget(entry) {
    const id = routeId(entry);
    return this.serialize(id, async () => {
      this.jobs.get(id)?.controller.abort();
      this.records.delete(id); // Late completion sees no current run and cannot recreate this file.
      await fs.rm(path.join(this.directory, id + '.json'), { force: true });
      this.revision++;
    });
  }

  async close() {
    this.closed = true;
    // Drain starts already saving their record, then abort and await every job before changing homes.
    await Promise.allSettled([...this.queues.values()]);
    for (const job of this.jobs.values()) job.controller.abort();
    await Promise.allSettled([...this.running]);
    await Promise.allSettled([...this.queues.values()]);
  }
}

module.exports = { IntelligenceTests, routeId, Slots };
