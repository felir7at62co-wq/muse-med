import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, writeFile, mkdir, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Context } from '@deepseek-ai/cordis';
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local';
import { SourceResearch, resolveConfig } from '../src/service.js';
import { apply } from '../src/index.js';
import { rankingHtml } from '../../muse-qimao-data/tests/fixtures.mjs';

const cleanups = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const collect = { action: 'collect', platform: 'qimao', request: { operation: 'rankings', channels: ['boy'], boards: ['hot'], periods: ['date'] } };
const signal = () => new AbortController().signal;
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

async function fixture(config = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'muse-research-test-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const ctx = new Context();
  const fiber = await ctx.plugin(LocalFileSystem, { cwd: directory });
  cleanups.push(() => fiber.dispose());
  const state = { mode: 'workspace-write', time: Date.parse('2026-11-04T10:00:00.000Z'), calls: [], heat: '10万 热度', hongguo: {}, policyCalls: 0 };
  ctx.provide('agents', { requireInitiator: () => ({ session: { header: { cwd: directory } } }) });
  ctx.provide('sandboxPolicy', { resolve() { state.policyCalls++; return { mode: state.mode, workspaceRoot: directory }; } });
  const host = ctx;
  const fetch = async url => {
    state.calls.push(String(url));
    if (String(url) === 'https://www.qimao.com/paihang/boy/hot/date/') return new Response(rankingHtml({ heat: state.heat }), { headers: { 'content-type': 'text/html' } });
    if (String(url) === 'https://hongguoduanju.com/rank/hot-comic-drama') return new Response(`<script>_ROUTER_DATA = ${JSON.stringify({ loaderData: { 'rank_hot-comic-drama/page': { content: { isSuccess: true, pagination: { pageNum: 1, totalPages: 1 }, rankList: [{ seriesId: '123', title: '红果样例', rank: 1, favoriteText: '120万收藏', likeText: '10万点赞', heatText: '200万热度', ...state.hongguo }] } } } })}</script>`, { headers: { 'content-type': 'text/html' } });
    throw new Error(`Unexpected fixture request: ${url}`);
  };
  const service = new SourceResearch(host, { hongguo: { requestIntervalMs: 0, maxPages: 1, incompletePageRetries: 0 }, qimao: { requestIntervalMs: 0 }, ...config }, { now: () => state.time, hongguo: { fetch, now: () => state.time }, qimao: { fetch, now: () => state.time } });
  cleanups.push(() => service.dispose());
  const call = (type, args, abort = signal()) => service.execute(type, args, abort);
  const scope = async (parent = ctx) => {
    let scoped;
    const owner = await parent.plugin({ inject: ['fs', 'agents', 'sandboxPolicy'], apply(child) {
      const instance = new SourceResearch(child, service.config, { now: () => state.time, hongguo: { fetch, now: () => state.time }, qimao: { fetch, now: () => state.time } });
      child.effect(() => () => instance.dispose());
      scoped = { ctx: child, service: instance, call: (type, args, abort = signal()) => instance.execute(type, args, abort) };
    } });
    cleanups.push(() => owner.dispose());
    return { ...scoped, dispose: () => owner.dispose() };
  };
  return { directory, ctx, host, service, state, call, scope };
}

describe('source research through the real local filesystem', () => {
  it('persists real Hongguo parser reasons while preserving absence and original raw evidence', async () => {
    const f = await fixture();
    f.state.hongguo = { favoriteText: '暂无收藏', likeText: '未知点赞', heatText: null };
    const receipt = await f.call('snapshot', { action: 'collect', platform: 'hongguo', request: { operation: 'rankings', boards: ['hot-comic-drama'] } });
    const { snapshot } = await f.call('snapshot', { action: 'read', snapshotId: receipt.snapshotId });
    expect(snapshot.sourceResult.items[0].observations[0].missingMetrics).toContainEqual({ field: 'collection', reason: 'unparseable' });
    expect(snapshot.canonicalItems[0].metrics.collection).toMatchObject({ raw: '暂无收藏', value: null, missingReason: 'unparseable' });
    expect(snapshot.canonicalItems[0].metrics.likes).toMatchObject({ raw: '未知点赞', value: null, missingReason: 'unparseable' });
    expect(snapshot.canonicalItems[0].metrics.heat).toMatchObject({ raw: null, value: null, missingReason: 'not_displayed' });
    expect(digest(await readFile(receipt.path))).toBe(receipt.sha256);
  });

  it.each(['snapshots', 'reports', 'mapping-proposals'])('shares %s admission between real Cordis Session scopes', async kind => {
    const f = await fixture({ maxSnapshots: 1, maxMappings: 1 });
    const a = await f.scope(), b = await f.scope();
    expect(a.ctx.fs).not.toBe(b.ctx.fs);
    const context = await a.service.store.context(f.directory, undefined, { mode: 'workspace-write', workspaceRoot: f.directory }, signal());
    const entered = deferred(), release = deferred();
    cleanups.push(() => release.resolve());
    const folder = kind === 'mapping-proposals' ? 'mappings' : kind;
    const admission = service => async () => {
      const entries = await service.store.entries(context, `.muse/source-research/${folder}/v1`);
      if (entries.length >= 1) throw Object.assign(new Error('artifact capacity reached'), { code: 'SOURCE_RESEARCH_LIMIT' });
    };
    const first = a.service.publishQueued(context, kind, async () => {
      entered.resolve(); await release.promise;
      return a.service.store.publish(context, `.muse/source-research/${folder}/v1/first.json`, '{"first":true}\n');
    }, admission(a.service));
    await entered.promise;
    const second = b.service.publishQueued(context, kind, () => b.service.store.publish(context, `.muse/source-research/${folder}/v1/second.json`, '{"second":true}\n'), admission(b.service));
    const result = Promise.allSettled([first, second]);
    // A different category supplies a completion barrier without joining the held queue.
    await b.service.publishQueued(context, 'independent', async () => {}, async () => {});
    release.resolve();
    const outcomes = await result;
    expect(outcomes.map(value => value.status)).toEqual(['fulfilled', 'rejected']);
    expect(outcomes[1].reason).toMatchObject({ code: 'SOURCE_RESEARCH_LIMIT' });
    expect(await readdir(join(f.directory, `.muse/source-research/${folder}/v1`))).toEqual(['first.json']);
  });

  it('reads and reports immutable 1.0.0 projections without reinterpreting their source reasons', async () => {
    const f = await fixture();
    const bytes = await readFile(new URL('./fixtures/hongguo-snapshot-adapter-1.0.0.json', import.meta.url), 'utf8');
    const { snapshotId, ...body } = JSON.parse(bytes);
    const encode = value => JSON.stringify(value, null, 2) + '\n';
    expect(snapshotId).toBe('s-87b403b90c05a4f293ebd2570b11a5bd');
    expect(digest(bytes)).toBe('9612dcaa845ad8ceb6bc7c44460b8c7c433f236ea753de79970208264acf98f6');
    const context = await f.service.store.context(f.directory, undefined, undefined, signal());
    const saved = await f.service.store.publish(context, `.muse/source-research/snapshots/v1/${snapshotId}.json`, bytes);
    const read = await f.call('snapshot', { action: 'read', snapshotId });
    expect(read.snapshot.adapterVersion).toBe('1.0.0');
    expect(read.snapshot.canonicalItems[0].metrics.collection.missingReason).toBe('not_displayed');
    expect((await f.call('snapshot', { action: 'list' })).snapshots).toEqual([expect.objectContaining({ snapshotId, sha256: digest(bytes) })]);
    const report = await f.call('report', { action: 'build', snapshotIds: [snapshotId] });
    const reportBytes = await readFile(report.path), markdownBytes = await readFile(report.markdownPath);
    expect((await f.call('report', { action: 'read', reportId: report.reportId })).report.adapterVersion).toBe('1.0.0');
    expect(await readFile(saved.path, 'utf8')).toBe(bytes);
    expect(await readFile(report.path)).toEqual(reportBytes);
    expect(await readFile(report.markdownPath)).toEqual(markdownBytes);
    const reinterpreted = structuredClone(body);
    reinterpreted.canonicalItems[0].metrics.collection.missingReason = 'unparseable';
    const invalidId = `s-${digest(encode(reinterpreted)).slice(0, 32)}`;
    await f.service.store.publish(context, `.muse/source-research/snapshots/v1/${invalidId}.json`, encode({ ...reinterpreted, snapshotId: invalidId }));
    await expect(f.call('snapshot', { action: 'read', snapshotId: invalidId })).rejects.toThrow('canonical data differs');
  });

  it('admits only one public collection across scopes and leaves the project list readable', async () => {
    const f = await fixture({ maxSnapshots: 1 }), a = await f.scope(), b = await f.scope();
    const entered = deferred(), release = deferred(), queued = deferred();
    cleanups.push(() => release.resolve());
    const publish = a.service.store.publish.bind(a.service.store);
    a.service.store.publish = async (...args) => { entered.resolve(); await release.promise; return publish(...args); };
    const first = a.call('snapshot', collect);
    await entered.promise;
    const enqueue = b.service.publishQueued.bind(b.service);
    b.service.publishQueued = (...args) => { const pending = enqueue(...args); queued.resolve(); return pending; };
    const second = b.call('snapshot', collect);
    const results = Promise.allSettled([first, second]);
    await queued.promise;
    release.resolve();
    const outcomes = await results;
    expect(outcomes.map(value => value.status)).toEqual(['fulfilled', 'rejected']);
    expect(outcomes[1].reason).toMatchObject({ code: 'SOURCE_RESEARCH_LIMIT' });
    const list = await f.call('snapshot', { action: 'list' });
    expect(list).toMatchObject({ count: 1, complete: true });
    expect(list.snapshots[0].snapshotId).toBe(outcomes[0].value.snapshotId);
    expect((await readdir(join(f.directory, '.muse/source-research/snapshots/v1')))).toHaveLength(1);
  });

  it('disposes a queued Session scope without awaiting another scope or releasing the FIFO barrier', async () => {
    const f = await fixture(), a = await f.scope(), b = await f.scope();
    const context = await a.service.store.context(f.directory, undefined, undefined, signal());
    const entered = deferred(), release = deferred(), events = [];
    cleanups.push(() => release.resolve());
    const first = a.service.publishQueued(context, 'reports', async () => { events.push('A'); entered.resolve(); await release.promise; });
    await entered.promise;
    const second = b.service.publishQueued(context, 'reports', async () => { events.push('B'); });
    const rejected = expect(second).rejects.toBeDefined();
    const third = a.service.publishQueued(context, 'reports', async () => { events.push('C'); });
    await b.dispose();
    await rejected;
    expect(events).toEqual(['A']);
    release.resolve();
    await Promise.all([first, third]);
    expect(events).toEqual(['A', 'C']);
    expect(a.service.publicationOwner.providers.size).toBe(0);
    // An idle owner must be reusable by an already-live scope and a newly mounted scope.
    const c = await f.scope();
    const held = deferred(), started = deferred();
    cleanups.push(() => held.resolve());
    const again = a.service.publishQueued(context, 'reports', async () => { started.resolve(); await held.promise; });
    await started.promise;
    const last = c.service.publishQueued(context, 'reports', async () => { events.push('D'); });
    held.resolve();
    await Promise.all([again, last]);
    expect(events).toEqual(['A', 'C', 'D']);
  });

  it('keeps filesystem provider isolation independent within the same Host', async () => {
    const f = await fixture(), a = await f.scope();
    const isolated = f.ctx.isolate('fs');
    const filesystem = await isolated.plugin(LocalFileSystem, { cwd: f.directory });
    cleanups.push(() => filesystem.dispose());
    const b = await f.scope(isolated);
    expect(a.ctx[Context.isolate].fs).not.toBe(b.ctx[Context.isolate].fs);
    const context = await a.service.store.context(f.directory, undefined, undefined, signal());
    const entered = deferred(), release = deferred();
    cleanups.push(() => release.resolve());
    const first = a.service.publishQueued(context, 'reports', async () => { entered.resolve(); await release.promise; });
    await entered.promise;
    const second = await b.service.publishQueued(context, 'reports', () => b.service.store.publish(context, '.muse/source-research/reports/v1/isolated.json', '{}\n'));
    expect(await readFile(second.path, 'utf8')).toBe('{}\n');
    release.resolve();
    await first;
  });

  it('keeps injected filesystem access until root disposal drains a committed publication', async () => {
    const f = await fixture(), a = await f.scope(), b = await f.scope();
    const committed = deferred(), release = deferred();
    cleanups.push(() => release.resolve());
    const publish = a.service.store.publish.bind(a.service.store);
    a.service.store.publish = async (...args) => {
      const receipt = await publish(...args);
      committed.resolve(receipt);
      await release.promise;
      return receipt;
    };
    const call = a.call('snapshot', collect);
    const receipt = await committed.promise;
    const bytes = await readFile(receipt.path);
    let disposed = false;
    const disposal = f.ctx.fiber.dispose().then(() => { disposed = true; });
    await b.dispose();
    expect(disposed).toBe(false);
    const target = await a.ctx.fs.resolve(receipt.path);
    expect(Buffer.from(await a.ctx.fs.readBytes(target, signal(), bytes.byteLength))).toEqual(bytes);
    release.resolve();
    expect(await call).toMatchObject({ path: receipt.path, sha256: digest(bytes) });
    await disposal;
    expect(disposed).toBe(true);
    expect(await readFile(receipt.path)).toEqual(bytes);
  });

  it('collects both real clients, stores full results and exact hashes, and preserves cached measurement times', async () => {
    const f = await fixture();
    const first = await f.call('snapshot', collect);
    const bytes = await readFile(first.path);
    expect(first.sha256).toBe(digest(bytes));
    expect(first).not.toHaveProperty('version');
    const firstDoc = JSON.parse(bytes);
    expect(firstDoc).toMatchObject({ schemaVersion: 1, kind: 'source_snapshot', evidenceKind: 'official_public', platform: 'qimao' });
    expect(firstDoc.sourceResult.items[0].metrics.heat.raw).toBe('10万 热度');
    expect(firstDoc.canonicalItems[0].metrics.heat).toMatchObject({ label: '热度', value: 100000, observedAt: '2026-11-04T10:00:00.000Z' });
    f.state.time += 1000;
    const cached = await f.call('snapshot', collect);
    const cachedChange = await f.call('snapshot', { action: 'compare', beforeId: first.snapshotId, afterId: cached.snapshotId });
    expect(cachedChange.comparisons[0].metrics[0]).toMatchObject({ delta: 0, measurementAdvanced: false });
    f.state.time += 1000; f.state.heat = '9万 热度';
    const refreshed = await f.call('snapshot', { ...collect, request: { ...collect.request, refresh: true } });
    const negative = await f.call('snapshot', { action: 'compare', beforeId: first.snapshotId, afterId: refreshed.snapshotId });
    expect(negative.comparisons[0].metrics.find(metric => metric.field === 'heat')).toMatchObject({ delta: -10000, measurementAdvanced: true });
    const hongguo = await f.call('snapshot', { action: 'collect', platform: 'hongguo', request: { operation: 'rankings', boards: ['hot-comic-drama'] } });
    expect(hongguo.canonicalCount).toBe(1);
    expect(f.state.calls).toHaveLength(3);
    expect((await f.call('snapshot', { action: 'list' })).count).toBe(4);
    expect((await f.call('snapshot', { action: 'read', snapshotId: first.snapshotId })).snapshot.sourceResult).toEqual(firstDoc.sourceResult);
  });

  it('rejects readonly collection before HTTP and resolves policy on every call', async () => {
    const f = await fixture();
    f.state.mode = 'read-only';
    await expect(f.call('snapshot', collect)).rejects.toMatchObject({ code: 'SOURCE_RESEARCH_READ_ONLY' });
    await expect(f.call('snapshot', { action: 'import_legacy', path: 'missing.json' })).rejects.toMatchObject({ code: 'SOURCE_RESEARCH_READ_ONLY' });
    await expect(f.call('report', { action: 'build', snapshotIds: [] })).rejects.toMatchObject({ code: 'SOURCE_RESEARCH_READ_ONLY' });
    expect(f.state.calls).toEqual([]);
    expect(f.state.policyCalls).toBe(3);
    expect((await f.call('snapshot', { action: 'list' })).snapshots).toEqual([]);
  });

  it('rejects canonical path and symlink escapes before HTTP or external legacy reads', async () => {
    const f = await fixture();
    await expect(f.call('snapshot', { ...collect, project: '..' })).rejects.toMatchObject({ code: 'SOURCE_RESEARCH_OUTSIDE_PROJECT' });
    await expect(f.call('snapshot', { action: 'import_legacy', path: '../outside.json' })).rejects.toMatchObject({ code: 'SOURCE_RESEARCH_OUTSIDE_PROJECT' });
    const outside = await mkdtemp(join(tmpdir(), 'muse-research-outside-'));
    cleanups.push(() => rm(outside, { recursive: true, force: true }));
    await mkdir(join(f.directory, '.muse'), { recursive: true });
    await symlink(outside, join(f.directory, '.muse/source-research'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(f.call('snapshot', collect)).rejects.toMatchObject({ code: 'SOURCE_RESEARCH_OUTSIDE_PROJECT' });
    expect(f.state.calls).toEqual([]);
  });

  it('imports actual legacy field sets, keeps originals/hash, and excludes missing or cross-platform IDs', async () => {
    const f = await fixture();
    const legacy = { platform: 'qimao', collectedAt: '2026-11-04T19:40:32+08:00', source: 'old scanner', coverage: { pages: '8/8 榜（每榜 3 页）', unique: 138, complete: false, failures: [], boardCounts: { hot: 20 } }, items: [
      { platform: 'qimao', id: '42', title: '同名', metric_raw: '538.6万人气值', metric_value: 5386000, metric_type: 'popularity', popularity: 5386000, reads: 123, golden_pick: null, cat2: '年代', ranks: [] },
      { platform: 'qimao', id: '43', title: '同名', metric_type: 'popularity', metric_value: null },
      { title: '未知ID' }, { platform: 'hongguo', id: '42', title: '另一平台' },
    ] };
    const path = join(f.directory, 'legacy.json'), content = JSON.stringify(legacy, null, 2);
    await writeFile(path, content);
    const receipt = await f.call('snapshot', { action: 'import_legacy', path: 'legacy.json' });
    const { snapshot } = await f.call('snapshot', { action: 'read', snapshotId: receipt.snapshotId });
    expect(receipt).toMatchObject({ evidenceKind: 'legacy_file', canonicalCount: 2, unidentifiedCount: 2 });
    expect(snapshot.sourceResult).toEqual(legacy);
    expect(snapshot.evidence).toEqual({ path: f.ctx.fs.processPath(await f.ctx.fs.resolve(path)), sha256: digest(content) });
    expect(snapshot.canonicalItems[0].metrics.reads.semantic).toBe('legacy.reads');
    expect(await readFile(path, 'utf8')).toBe(content);
    expect(f.state.calls).toEqual([]);
    const hongguo = { platform: 'hongguo', collectedAt: '2026-11-04T19:38:39+08:00', source: 'old scanner', coverage: { pages: '18/20', unique: 260, complete: false, failures: [{ page: 19, error: 'old scanner failure' }] }, items: [{ platform: 'hongguo', id: '42', title: '旧红果', metric_raw: '538.6万收藏', metric_value: 5386000, metric_type: 'collection', rank: 1, tags: ['年代'] }] };
    await writeFile(join(f.directory, 'hongguo.json'), JSON.stringify(hongguo));
    const hg = await f.call('snapshot', { action: 'import_legacy', path: 'hongguo.json' });
    expect(hg).toMatchObject({ platform: 'hongguo', canonicalCount: 1 });
    const hgDoc = (await f.call('snapshot', { action: 'read', snapshotId: hg.snapshotId })).snapshot;
    expect(hgDoc.coverage).toEqual(hongguo.coverage);
    expect(hgDoc.observedAt).toEqual({ first: hongguo.collectedAt, last: hongguo.collectedAt });
  });

  it('writes evidence-led reports with portable input hashes, reads readonly, and verifies Markdown integrity', async () => {
    const f = await fixture();
    const before = await f.call('snapshot', collect);
    f.state.time += 1000; f.state.heat = '8万 热度';
    const after = await f.call('snapshot', { ...collect, request: { ...collect.request, refresh: true } });
    const receipt = await f.call('report', { action: 'build', snapshotIds: [after.snapshotId], baselineIds: [before.snapshotId] });
    expect(receipt.status).toBe('complete');
    const raw = await readFile(receipt.path, 'utf8');
    expect(raw).not.toContain(f.directory);
    expect(raw).not.toContain('version');
    const report = JSON.parse(raw);
    expect(report.inputReceipts.map(value => value.sha256)).toEqual([after.sha256, before.sha256]);
    const markdown = await readFile(receipt.markdownPath, 'utf8');
    expect(digest(markdown)).toBe(report.markdownSha256);
    expect(markdown).toContain('-20000');
    expect(markdown).toContain(before.snapshotId);
    expect(markdown).toContain(before.sha256);
    expect(markdown).toContain('未知指标');
    f.state.mode = 'read-only';
    expect((await f.call('report', { action: 'read', reportId: receipt.reportId })).markdown).toBe(markdown);
    await writeFile(receipt.markdownPath, 'modified');
    await expect(f.call('report', { action: 'read', reportId: receipt.reportId })).rejects.toMatchObject({ code: 'SOURCE_RESEARCH_CONFLICT' });
  });

  it('returns a concrete saved JSON receipt if the Markdown publication fails', async () => {
    const f = await fixture();
    const snapshot = await f.call('snapshot', collect);
    const original = f.service.store.publish.bind(f.service.store);
    f.service.store.publish = (context, path, ...args) => path.endsWith('.md') ? Promise.reject(Object.assign(new Error('output denied'), { code: 'FS_SANDBOX_DENIED' })) : original(context, path, ...args);
    const report = await f.call('report', { action: 'build', snapshotIds: [snapshot.snapshotId] });
    expect(report).toMatchObject({ status: 'partial', markdownError: { code: 'FS_SANDBOX_DENIED' } });
    expect(digest(await readFile(report.path))).toBe(report.sha256);
    expect((await f.call('report', { action: 'read', reportId: report.reportId })).status).toBe('partial');
  });

  it('never overwrites an existing artifact and rejects changed input bytes or future versions', async () => {
    const f = await fixture();
    const snapshot = await f.call('snapshot', collect), original = await readFile(snapshot.path, 'utf8');
    const context = await f.service.store.context(f.directory, undefined, { mode: 'workspace-write', workspaceRoot: f.directory }, signal());
    expect(await f.service.store.publish(context, snapshot.path, original)).toMatchObject({ reused: true });
    await expect(f.service.store.publish(context, snapshot.path, 'other')).rejects.toMatchObject({ code: 'SOURCE_RESEARCH_CONFLICT' });
    expect(await readFile(snapshot.path, 'utf8')).toBe(original);
    const altered = JSON.parse(original); altered.sourceResult.items[0].title = 'tampered';
    await writeFile(snapshot.path, JSON.stringify(altered));
    await expect(f.call('snapshot', { action: 'read', snapshotId: snapshot.snapshotId })).rejects.toMatchObject({ code: 'SOURCE_RESEARCH_CONFLICT' });
    altered.schemaVersion = 2;
    await writeFile(snapshot.path, JSON.stringify(altered));
    await expect(f.call('snapshot', { action: 'read', snapshotId: snapshot.snapshotId })).rejects.toMatchObject({ code: 'SOURCE_RESEARCH_VERSION' });
  });

  it('rejects bounded JSON, directory, report-input and snapshot capacity failures without truncation', async () => {
    const f = await fixture({ maxJsonBytes: 100 });
    await writeFile(join(f.directory, 'large.json'), ' '.repeat(101));
    await expect(f.call('snapshot', { action: 'import_legacy', path: 'large.json' })).rejects.toMatchObject({ code: 'SOURCE_RESEARCH_LIMIT' });
    const capped = await fixture({ maxSnapshots: 1 });
    const first = await capped.call('snapshot', collect);
    capped.state.time += 1;
    await expect(capped.call('snapshot', collect)).rejects.toMatchObject({ code: 'SOURCE_RESEARCH_LIMIT' });
    expect(capped.state.calls).toHaveLength(1);
    await expect(capped.call('report', { action: 'build', snapshotIds: [first.snapshotId], baselineIds: [first.snapshotId, first.snapshotId] })).rejects.toMatchObject({ code: 'SOURCE_RESEARCH_LIMIT' });
    const entries = await fixture({ maxListEntries: 1 });
    await mkdir(join(entries.directory, '.muse/source-research/snapshots/v1'), { recursive: true });
    await writeFile(join(entries.directory, '.muse/source-research/snapshots/v1/a'), 'x');
    await writeFile(join(entries.directory, '.muse/source-research/snapshots/v1/b'), 'x');
    await expect(entries.call('snapshot', { action: 'list' })).rejects.toMatchObject({ code: 'SOURCE_RESEARCH_LIMIT' });
  });

  it('settles a canceled queued publication immediately without releasing its successor early', async () => {
    const f = await fixture();
    let enter, release;
    const entered = new Promise(resolve => { enter = resolve; }), held = new Promise(resolve => { release = resolve; });
    cleanups.push(() => release());
    const context = await f.service.store.context(f.directory, undefined, undefined, signal());
    const events = [];
    const first = f.service.publishQueued(context, 'reports', async () => { events.push('A'); enter(); await held; });
    await entered;
    const abort = new AbortController();
    const second = f.service.publishQueued({ ...context, signal: abort.signal }, 'reports', async () => { events.push('B'); });
    const third = f.service.publishQueued(context, 'reports', async () => { events.push('C'); });
    abort.abort(new Error('canceled waiter'));
    await expect(second).rejects.toThrow('canceled waiter');
    expect(events).toEqual(['A']);
    release();
    await Promise.all([first, third]);
    expect(events).toEqual(['A', 'C']);
  });

  it('rechecks report capacity after concurrent publication admission', async () => {
    const f = await fixture({ maxSnapshots: 1 });
    const snapshot = await f.call('snapshot', collect);
    const a = await f.scope(), b = await f.scope();
    let entered, release;
    const entry = new Promise(resolve => { entered = resolve; }), held = new Promise(resolve => { release = resolve; });
    cleanups.push(() => release());
    const publish = a.service.store.publish.bind(a.service.store);
    let reportPublications = 0;
    a.service.store.publish = async (context, path, ...args) => {
      if (path.includes('/reports/')) { reportPublications++; entered(); await held; }
      return publish(context, path, ...args);
    };
    const first = a.call('report', { action: 'build', snapshotIds: [snapshot.snapshotId] });
    await entry;
    const second = b.call('report', { action: 'build', snapshotIds: [snapshot.snapshotId] });
    const rejected = expect(second).rejects.toMatchObject({ code: 'SOURCE_RESEARCH_LIMIT' });
    release();
    expect((await first).status).toBe('complete');
    await rejected;
    expect(reportPublications).toBe(1);
  });

  it('preserves an admitted atomic publication receipt when cancellation arrives after commit', async () => {
    const f = await fixture();
    let enter, release;
    const entered = new Promise(resolve => { enter = resolve; }), held = new Promise(resolve => { release = resolve; });
    cleanups.push(() => release());
    const abort = new AbortController();
    const context = await f.service.store.context(f.directory, undefined, undefined, abort.signal);
    const receipt = { path: 'committed.json', sha256: 'exact hash' };
    const publication = f.service.publishQueued(context, 'reports', async () => { enter(); await held; return receipt; });
    await entered;
    abort.abort(new Error('cancel after commit'));
    release();
    expect(await publication).toEqual(receipt);
  });

  it('rejects input mutation during a real bounded read and report aggregate byte exhaustion', async () => {
    const f = await fixture({ maxReportInputBytes: 1 });
    const snapshot = await f.call('snapshot', collect);
    await expect(f.call('report', { action: 'build', snapshotIds: [snapshot.snapshotId] })).rejects.toThrow('maxReportInputBytes');
    const path = join(f.directory, 'changing.json');
    await writeFile(path, '{"a":1}');
    const context = await f.service.store.context(f.directory, undefined, undefined, signal());
    const target = await f.service.store.target(context, 'changing.json');
    const read = f.ctx.fs.readBytes.bind(f.ctx.fs);
    f.ctx.fs.readBytes = async (...args) => { const bytes = await read(...args); await writeFile(path, '{"a":12345}'); return bytes; };
    await expect(f.service.store.read(context, target)).rejects.toMatchObject({ code: 'SOURCE_RESEARCH_STALE_READ' });
  });

  it('registers three scoped object-schema tools, rejects extra model evidence, and disposes registrations', async () => {
    const f = await fixture(), definitions = [], cleanup = [];
    const host = f.host.extend({ tools: { register(definition) { definitions.push(definition); return () => definitions.splice(definitions.indexOf(definition), 1); } }, effect(factory) { cleanup.push(factory()); } });
    apply(host, { qimao: { requestIntervalMs: 0 }, hongguo: { requestIntervalMs: 0 } });
    expect(definitions.map(value => value.name)).toEqual(['source_snapshot', 'source_report', 'work_mapping']);
    for (const definition of definitions) expect(definition.parameters).toMatchObject({ type: 'object', required: ['action'], additionalProperties: false });
    await expect(definitions[0].execute({ ...collect, sourceResult: {} }, { signal: signal() })).rejects.toThrow('unknown fields');
    for (const dispose of cleanup.reverse()) await dispose();
    expect(definitions).toEqual([]);
    expect(() => resolveConfig({ maxItems: 0 })).toThrow();
    expect(() => resolveConfig({ qimao: { cacheTtlMs: -1 } })).toThrow();
    expect(() => new SourceResearch({ fs: { sandboxMode: 'workspace-write' } })).toThrow('requires sandboxPolicy');
  });
});
