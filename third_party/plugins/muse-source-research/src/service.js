/** Collection, legacy evidence, immutable snapshot reads and evidence-led report generation. */
import { HongguoClient, resolveConfig as hongguoConfig } from 'muse-hongguo-search/client';
import { QimaoClient, resolveConfig as qimaoConfig } from 'muse-qimao-data/client';
import { Context } from '@deepseek-ai/cordis';
import { ResearchStore, sha256, encode, failure } from './store.js';
import { canonicalize, compareSnapshots, renderReport } from './canonical.js';
import { WorkMappings, mappingReceipts, renderMappings } from './mappings.js';

const SNAPSHOT_ADAPTER_VERSION = '1.0.1';
const supportedSnapshotAdapter = version => version === '1.0.0' || version === SNAPSHOT_ADAPTER_VERSION;
const BOARDS = ['hot-drama', 'hot-real-drama', 'hot-ai-drama', 'hot-comic-drama'];
const defaults = { maxJsonBytes: 16777216, maxItems: 20000, maxSnapshots: 1000, maxReportInputs: 40, maxComparisonPairs: 100, maxReportInputBytes: 67108864, maxListEntries: 5000, maxReportBytes: 4194304, toolTimeoutMs: 300000,
  maxMappings: 1000, maxMappingRevisions: 100, maxMappingReasonChars: 2000, maxMappingExcerptChars: 500, maxMappingHistoryBytes: 16777216, maxMappingListBytes: 67108864 };
const limits = { maxJsonBytes: 67108864, maxItems: 50000, maxSnapshots: 10000, maxReportInputs: 100, maxComparisonPairs: 1000, maxReportInputBytes: 268435456, maxListEntries: 20000, maxReportBytes: 16777216, toolTimeoutMs: 3600000,
  maxMappings: 10000, maxMappingRevisions: 999999, maxMappingReasonChars: 20000, maxMappingExcerptChars: 20000, maxMappingHistoryBytes: 268435456, maxMappingListBytes: 268435456 };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function keys(value, allowed) { if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) throw failure('Research request has unknown fields or is not an object'); }
function id(value, prefix) { if (typeof value !== 'string' || !new RegExp(`^${prefix}-[a-f0-9]{32}$`).test(value)) throw failure(`Invalid ${prefix === 's' ? 'snapshotId' : 'reportId'}`); return value; }
function list(value, choices, fallback) {
  const selected = value ?? fallback;
  if (!Array.isArray(selected) || !selected.length || selected.some(item => !choices.includes(item))) throw failure('Invalid research collection window selection');
  return [...new Set(selected)].sort();
}
function abortable(promise, signal) {
  signal?.throwIfAborted();
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(value => { signal.removeEventListener('abort', abort); resolve(value); }, error => { signal.removeEventListener('abort', abort); reject(error); });
  });
}

/** @param ctx Scoped Cordis context. @returns Host-owned publication queues, separated by filesystem service scope. */
function publicationOwner(ctx) {
  let owner = ctx.root.get('sourceResearchPublication');
  if (!owner) {
    owner = { providers: new Map() };
    ctx.root.provide('sourceResearchPublication', owner);
  }
  return owner;
}

/** @param input Deployment resource and client settings. @returns Complete validated settings; invalid nested client settings fail at load. */
export function resolveConfig(input = {}) {
  keys(input, [...Object.keys(defaults), 'hongguo', 'qimao']);
  const config = { ...defaults };
  for (const key of Object.keys(defaults)) if (input[key] !== undefined) {
    if (!Number.isSafeInteger(input[key]) || input[key] < 1 || input[key] > limits[key]) throw failure(`Invalid source research config: ${key}`);
    config[key] = input[key];
  }
  return Object.freeze({ ...config, hongguo: hongguoConfig(input.hongguo), qimao: qimaoConfig(input.qimao) });
}

function resolveCollection(platform, request, config) {
  if (!['hongguo', 'qimao'].includes(platform)) throw failure('platform must be hongguo or qimao');
  keys(request, platform === 'hongguo' ? ['operation', 'boards', 'refresh'] : ['operation', 'source', 'channels', 'boards', 'periods', 'pages', 'refresh']);
  if (request.operation !== 'rankings') throw failure('Only operation:rankings is supported for research collection');
  if (request.refresh !== undefined && typeof request.refresh !== 'boolean') throw failure('refresh must be boolean');
  if (platform === 'hongguo') {
    const boards = list(request.boards, BOARDS, BOARDS);
    return { options: { boards, refresh: request.refresh === true }, scope: { operation: 'rankings', source: 'public_rankings', boards, maxPagesPerBoard: config.hongguo.maxPages } };
  }
  const source = request.source ?? 'rank';
  if (source === 'library') {
    if (request.channels !== undefined || request.boards !== undefined || request.periods !== undefined) throw failure('Library does not accept ranking selections');
    const pages = request.pages ?? config.qimao.maxPages;
    if (!Number.isInteger(pages) || pages < 1 || pages > config.qimao.maxPages) throw failure('Library pages exceed the configured limit');
    return { options: { source, pages, refresh: request.refresh === true }, scope: { operation: 'rankings', source, pages, filter: { updatedWithinDays: 3, wordCountBelow: 300000, status: '连载中', sort: 'click' } } };
  }
  if (source !== 'rank' || request.pages !== undefined) throw failure('Ranking pagination is unverified; pages is supported only for library');
  const channels = list(request.channels, ['boy', 'girl'], ['boy', 'girl']);
  const boards = list(request.boards, ['hot', 'new', 'over', 'collect', 'update'], ['hot', 'new', 'over', 'collect', 'update']);
  const periods = list(request.periods, ['date', 'month'], ['date', 'month']);
  const windows = channels.flatMap(channel => boards.flatMap(board => (board === 'hot' ? periods : ['date']).map(period => ({ channel, board, period, page: 1 }))));
  return { options: { source, channels, boards, periods, refresh: request.refresh === true }, scope: { operation: 'rankings', source, windows } };
}

/** Owns clients and complete in-flight calls; unloading aborts and waits for quiescence. */
export class SourceResearch {
  /** @param ctx Filesystem, agent identity and optional sandbox policy services. @param input Deployment settings. @param dependencies Internal transport/clock test dependencies, never tool JSON. */
  constructor(ctx, input = {}, dependencies = {}) {
    this.ctx = ctx;
    this.config = resolveConfig(input);
    if (ctx.fs.sandboxMode !== undefined && this.policyService() === undefined) throw failure('Sandboxed source research filesystem requires sandboxPolicy');
    this.store = new ResearchStore(ctx.fs, this.config);
    this.now = dependencies.now ?? Date.now;
    this.clients = {
      hongguo: new HongguoClient(this.config.hongguo, dependencies.hongguo),
      qimao: new QimaoClient(this.config.qimao, dependencies.qimao),
    };
    this.lifetime = new AbortController();
    this.pending = new Set();
    this.publicationOwner = publicationOwner(ctx);
    this.providerScope = ctx[Context.isolate].fs;
    this.publishing = new Set();
    this.mappings = new WorkMappings(this);
  }

  /** @returns The optional Host sandbox policy service; sandboxed filesystems require it. */
  policyService() { return typeof this.ctx.get === 'function' ? this.ctx.get('sandboxPolicy') : this.ctx.sandboxPolicy; }

  /** @param type snapshot, report or mapping. @param request Tool JSON. @param signal Tool cancellation. @returns Result after all reads/publication settle; denied writes fail before HTTP or human review. */
  execute(type, request, signal) {
    const combined = signal ? AbortSignal.any([signal, this.lifetime.signal]) : this.lifetime.signal;
    const pending = this.run(type, request, combined);
    this.pending.add(pending);
    void pending.then(() => this.pending.delete(pending), () => this.pending.delete(pending));
    return pending;
  }

  /** @returns Completion after owned clients and all tool calls have settled. */
  async dispose() {
    this.lifetime.abort();
    await Promise.allSettled(Object.values(this.clients).map(client => client.dispose()));
    await Promise.allSettled([...this.pending]);
    await Promise.allSettled([...this.publishing]);
  }

  /** @param type Tool family. @param request Validated per-action JSON fields. @param signal Combined call/lifetime cancellation. @returns The action result after resolving initiating Session identity and policy. */
  async run(type, request, signal) {
    signal.throwIfAborted();
    const fields = type === 'snapshot' ? {
      collect: ['platform', 'request'], import_legacy: ['path'], list: [], read: ['snapshotId'], compare: ['beforeId', 'afterId'],
    } : type === 'mapping' ? {
      propose: ['left', 'right', 'relation', 'reason'], read: ['mappingId'], list: [], lookup: ['mappingId', 'sourceRef', 'sourceKey'],
      review: ['mappingId', 'expectedProposalSha256', 'expectedRevision'], supersede: ['mappingId', 'expectedProposalSha256', 'expectedRevision'],
    } : type === 'report' ? { build: ['snapshotIds', 'baselineIds', 'mappingIds'], read: ['reportId'] } : {};
    if (!object(request) || !Object.hasOwn(fields, request.action)) throw failure('Unsupported source research action');
    keys(request, ['action', 'project', ...fields[request.action]]);
    const agent = this.ctx.agents.requireInitiator();
    const policy = this.policyService()?.resolve({ session: agent.session });
    const context = await this.store.context(agent.session.header.cwd, request.project, policy, signal);
    if (type === 'mapping') {
      switch (request.action) {
        case 'propose': return this.mappings.propose(context, request);
        case 'read': return this.mappings.read(context, request.mappingId);
        case 'list': return this.mappings.list(context);
        case 'lookup': return this.mappings.lookup(context, request);
        case 'review': case 'supersede': return this.mappings.review(context, request, agent);
        default: throw failure('Unsupported mapping action');
      }
    }
    if (type === 'snapshot') {
      switch (request.action) {
        case 'collect': return this.collect(context, request);
        case 'import_legacy': return this.importLegacy(context, request.path);
        case 'list': return this.list(context);
        case 'read': return this.readSnapshot(context, request.snapshotId);
        case 'compare': {
          const before = await this.readSnapshot(context, request.beforeId), after = await this.readSnapshot(context, request.afterId);
          return { ...compareSnapshots(before.snapshot, after.snapshot), inputReceipts: [before.receipt, after.receipt] };
        }
        default: throw failure('Unsupported snapshot action');
      }
    }
    if (request.action === 'build') return this.buildReport(context, request);
    return this.readReport(context, request.reportId);
  }

  /** @param context Project execution context. @param request Platform and official-client options. @returns A saved snapshot receipt; rejected preflight performs no HTTP. */
  async collect(context, request) {
    await this.store.writable(context);
    await this.store.capacity(context);
    const plan = resolveCollection(request.platform, request.request, this.config);
    const sourceResult = await this.clients[request.platform].rankings(plan.options, context.signal);
    return this.saveSnapshot(context, { platform: request.platform, evidenceKind: 'official_public', request: { operation: 'rankings', ...plan.options }, scope: plan.scope, sourceResult });
  }

  /** @param context Project execution context. @param path Existing contained legacy JSON. @returns A saved legacy evidence receipt without changing the input file. */
  async importLegacy(context, path) {
    await this.store.writable(context);
    await this.store.capacity(context);
    if (typeof path !== 'string' || !path.trim()) throw failure('import_legacy requires path to an existing JSON file inside project');
    const source = await this.store.read(context, await this.store.target(context, path));
    let sourceResult;
    try { sourceResult = JSON.parse(source.text); }
    catch (error) { throw failure(`Legacy JSON cannot be parsed: ${error.message}`); }
    if (!object(sourceResult) || !['hongguo', 'qimao'].includes(sourceResult.platform)) throw failure('Legacy JSON platform must be hongguo or qimao');
    return this.saveSnapshot(context, { platform: sourceResult.platform, evidenceKind: 'legacy_file', request: null,
      scope: { operation: 'legacy_import', source: sourceResult.source ?? null, declaredCoverage: sourceResult.coverage ?? null },
      evidence: { path: source.path, sha256: source.sha256 }, sourceResult });
  }

  /** @param context Project execution context. @param input Complete source result, scope and evidence classification. @returns An immutable snapshot receipt after capacity-guarded publication. */
  async saveSnapshot(context, input) {
    const normalized = canonicalize(input.platform, input.sourceResult, input.evidenceKind, this.config.maxItems);
    const payload = { schemaVersion: 1, kind: 'source_snapshot', adapterVersion: SNAPSHOT_ADAPTER_VERSION,
      createdAt: new Date(this.now()).toISOString(), ...input, coverage: structuredClone(input.sourceResult.coverage ?? null), ...normalized };
    const snapshotId = `s-${sha256(encode(payload)).slice(0, 32)}`;
    const snapshot = { ...payload, snapshotId }, text = encode(snapshot);
    return this.publishQueued(context, 'snapshots', async () => {
      context.signal?.throwIfAborted();
      const stored = await this.store.publish(context, `.muse/source-research/snapshots/v1/${snapshotId}.json`, text);
      return this.snapshotReceipt(snapshot, stored);
    });
  }

  /** @param context Project execution context. @param kind Artifact queue category. @param publish Publication operation after capacity admission. @param admission Optional category-specific capacity validation. @returns Its result; queued cancellation settles immediately without releasing the FIFO barrier early. */
  publishQueued(context, kind, publish, admission) {
    // A canceled waiter settles immediately but its FIFO barrier releases only after its predecessor.
    context = { ...context, signal: context.signal ? AbortSignal.any([context.signal, this.lifetime.signal]) : this.lifetime.signal };
    const providers = this.publicationOwner.providers;
    let projects = providers.get(this.providerScope);
    if (!projects) providers.set(this.providerScope, projects = new Map());
    let queues = projects.get(context.root.targetKey);
    if (!queues) projects.set(context.root.targetKey, queues = new Map());
    const previous = queues.get(kind) ?? Promise.resolve();
    let release;
    const slot = new Promise(resolve => { release = resolve; });
    const tail = previous.then(() => slot);
    queues.set(kind, tail);
    void tail.then(() => {
      if (queues.get(kind) !== tail) return;
      queues.delete(kind);
      if (!queues.size) projects.delete(context.root.targetKey);
      if (!projects.size) providers.delete(this.providerScope);
    });
    const pending = (async () => {
      let acquired = false;
      try {
        await abortable(previous, context.signal);
        acquired = true;
        context.signal.throwIfAborted();
        if (admission) await admission();
        else await this.store.capacity(context, kind);
        return await publish();
      } finally {
        if (acquired) release();
        else void previous.then(release, release);
      }
    })();
    this.publishing.add(pending);
    void pending.then(() => this.publishing.delete(pending), () => this.publishing.delete(pending));
    return pending;
  }

  /** @param snapshot Verified source document. @param stored Exact artifact path/hash receipt. @returns Public evidence metadata without provider-specific filesystem versions. */
  snapshotReceipt(snapshot, stored) {
    const { version, ...receipt } = stored;
    return { snapshotId: snapshot.snapshotId, schemaVersion: 1, platform: snapshot.platform, evidenceKind: snapshot.evidenceKind,
      canonicalCount: snapshot.canonicalItems.length, unidentifiedCount: snapshot.unidentifiedItems.length,
      observedAt: snapshot.observedAt, coverage: snapshot.coverage, ...receipt };
  }

  /** @param context Project execution context. @param snapshotId Content-addressed v1 ID. @returns Verified source document and exact-byte receipt; unsupported versions or changed content fail. */
  async readSnapshot(context, snapshotId) {
    id(snapshotId, 's');
    const stored = await this.store.read(context, await this.store.target(context, `.muse/source-research/snapshots/v1/${snapshotId}.json`));
    let snapshot;
    try { snapshot = JSON.parse(stored.text); }
    catch (error) { throw failure(`Stored snapshot JSON cannot be parsed: ${error.message}`); }
    this.validateSnapshot(snapshot, snapshotId);
    return { receipt: this.snapshotReceipt(snapshot, { path: stored.path, sha256: stored.sha256, version: stored.version, reused: true }), snapshot };
  }

  /** @param snapshot Untrusted parsed JSON. @param snapshotId Requested v1 content ID. @returns Nothing; rejects unsupported versions, mismatched IDs or inconsistent canonical data. */
  validateSnapshot(snapshot, snapshotId) {
    if (!object(snapshot) || snapshot.schemaVersion !== 1) throw failure('Unsupported source snapshot schemaVersion; committed versions are never rewritten', 'SOURCE_RESEARCH_VERSION');
    if (snapshot.kind !== 'source_snapshot' || snapshot.snapshotId !== snapshotId || !supportedSnapshotAdapter(snapshot.adapterVersion) || !['hongguo', 'qimao'].includes(snapshot.platform) || !['official_public', 'legacy_file'].includes(snapshot.evidenceKind)) throw failure('Stored snapshot identity or adapter is unsupported');
    const { snapshotId: omitted, ...payload } = snapshot;
    if (`s-${sha256(encode(payload)).slice(0, 32)}` !== snapshotId) throw failure('Stored snapshot content does not match its immutable ID', 'SOURCE_RESEARCH_CONFLICT');
    const expected = canonicalize(snapshot.platform, snapshot.sourceResult, snapshot.evidenceKind, this.config.maxItems, snapshot.adapterVersion);
    if (encode(expected.canonicalItems) !== encode(snapshot.canonicalItems) || encode(expected.unidentifiedItems) !== encode(snapshot.unidentifiedItems) || encode(expected.observedAt) !== encode(snapshot.observedAt)) throw failure('Stored snapshot canonical data differs from its source evidence');
  }

  /** @param context Project execution context. @returns All verified v1 snapshot receipts within configured limits; never truncates. */
  async list(context) {
    const entries = await this.store.entries(context, '.muse/source-research/snapshots/v1');
    const candidates = entries.filter(entry => entry.name.endsWith('.json'));
    if (candidates.length > this.config.maxSnapshots) throw failure('Research snapshots exceed maxSnapshots; listing was not truncated', 'SOURCE_RESEARCH_LIMIT');
    const snapshots = [];
    for (const entry of candidates) {
      if (entry.type !== 'file') throw failure('Snapshot directory contains a non-file JSON entry');
      snapshots.push((await this.readSnapshot(context, entry.name.slice(0, -5))).receipt);
    }
    return { snapshots, count: snapshots.length, complete: true, scope: 'selected_project_snapshots_v1' };
  }

  /** @param ids Model-supplied snapshot IDs. @param name Parameter name for diagnostics. @returns Validated unique bounded v1 IDs. */
  reportInputs(ids, name) {
    if (!Array.isArray(ids) || !ids.length || ids.length > this.config.maxReportInputs || new Set(ids).size !== ids.length) throw failure(`${name} must be unique snapshot IDs within maxReportInputs`, 'SOURCE_RESEARCH_LIMIT');
    return ids.map(value => id(value, 's'));
  }

  /** @param context Writable project context. @param request Snapshot IDs and optional baselines. @returns Saved evidence/Markdown receipts, or partial status if JSON succeeded before Markdown failure. */
  async buildReport(context, request) {
    await this.store.writable(context);
    const snapshotIds = this.reportInputs(request.snapshotIds, 'snapshotIds');
    const baselineIds = request.baselineIds === undefined ? [] : this.reportInputs(request.baselineIds, 'baselineIds');
    const mappingIds = request.mappingIds;
    if (mappingIds !== undefined && (!Array.isArray(mappingIds) || mappingIds.length < 1 || new Set(mappingIds).size !== mappingIds.length || mappingIds.length > this.config.maxReportInputs)) throw failure('mappingIds must be unique mapping IDs within maxReportInputs', 'SOURCE_RESEARCH_LIMIT');
    if (snapshotIds.length + baselineIds.length + (mappingIds?.length ?? 0) > this.config.maxReportInputs) throw failure('Combined report inputs exceed maxReportInputs', 'SOURCE_RESEARCH_LIMIT');
    const loaded = [];
    let bytes = 0;
    for (const snapshotId of [...new Set([...snapshotIds, ...baselineIds])]) {
      const snapshot = await this.readSnapshot(context, snapshotId);
      bytes += Buffer.byteLength(encode(snapshot.snapshot));
      if (bytes > this.config.maxReportInputBytes) throw failure('Report inputs exceed maxReportInputBytes', 'SOURCE_RESEARCH_LIMIT');
      loaded.push(snapshot);
    }
    const selected = loaded.filter(value => snapshotIds.includes(value.snapshot.snapshotId));
    const baselines = loaded.filter(value => baselineIds.includes(value.snapshot.snapshotId));
    const pairs = selected.flatMap(after => baselines.filter(before => before.snapshot.platform === after.snapshot.platform).map(before => [before, after]));
    if (pairs.length > this.config.maxComparisonPairs) throw failure('Report comparisons exceed maxComparisonPairs', 'SOURCE_RESEARCH_LIMIT');
    const comparisons = pairs.map(([before, after]) => compareSnapshots(before.snapshot, after.snapshot));
    const inputReceipts = loaded.map(({ receipt }) => ({ snapshotId: receipt.snapshotId, sha256: receipt.sha256, platform: receipt.platform, evidenceKind: receipt.evidenceKind })), createdAt = new Date(this.now()).toISOString();
    const states = [];
    if (mappingIds !== undefined) for (const mappingId of mappingIds) {
      const state = await this.mappings.read(context, mappingId);
      bytes += Buffer.byteLength(encode(state));
      if (bytes > this.config.maxReportInputBytes) throw failure('Report inputs exceed maxReportInputBytes', 'SOURCE_RESEARCH_LIMIT');
      states.push(state);
    }
    const capturedMappings = mappingIds === undefined ? null : mappingReceipts(states);
    const markdown = renderReport(selected.map(value => value.snapshot), inputReceipts, comparisons, createdAt) + (capturedMappings === null ? '' : renderMappings(capturedMappings));
    if (Buffer.byteLength(markdown) > this.config.maxReportBytes) throw failure('Report Markdown exceeds maxReportBytes', 'SOURCE_RESEARCH_LIMIT');
    const payload = { schemaVersion: 1, kind: 'source_report', adapterVersion: '1.0.0', createdAt, snapshotIds, baselineIds,
      inputReceipts, comparisons, markdownSha256: sha256(markdown), ...(capturedMappings === null ? {} : { mappingIds, mappingReceipts: capturedMappings }) };
    const reportId = `r-${sha256(encode(payload)).slice(0, 32)}`;
    const markdownPath = `deliverables/选材日报/${createdAt.slice(0, 10)}-${reportId}.md`;
    const report = { ...payload, reportId, markdownPath };
    const stored = await this.publishQueued(context, 'reports', () => this.store.publish(context, `.muse/source-research/reports/v1/${reportId}.json`, encode(report)));
    const receipt = { reportId, path: stored.path, sha256: stored.sha256, reused: stored.reused, markdownPath, markdownSha256: payload.markdownSha256, inputReceipts,
      ...(capturedMappings === null ? {} : { mappingReceipts: capturedMappings }) };
    try {
      const rendered = await this.store.publish(context, markdownPath, markdown, this.config.maxReportBytes);
      return { ...receipt, markdownPath: rendered.path, status: 'complete' };
    } catch (error) {
      return { ...receipt, status: 'partial', markdownError: { code: error.code ?? 'SOURCE_RESEARCH_WRITE_FAILED', message: error.message }, recovery: 'The immutable report JSON was saved; read the report or build again with these snapshot IDs after resolving the Markdown write failure.' };
    }
  }

  /** @param context Project execution context. @param reportId Content-addressed v1 report ID. @returns Verified report and Markdown, or partial status when only the saved JSON exists. */
  async readReport(context, reportId) {
    id(reportId, 'r');
    const stored = await this.store.read(context, await this.store.target(context, `.muse/source-research/reports/v1/${reportId}.json`));
    let report;
    try { report = JSON.parse(stored.text); }
    catch (error) { throw failure(`Stored report JSON cannot be parsed: ${error.message}`); }
    if (!object(report) || report.schemaVersion !== 1) throw failure('Unsupported report schemaVersion; committed versions are never rewritten', 'SOURCE_RESEARCH_VERSION');
    const { reportId: omitted, markdownPath, ...payload } = report;
    if (report.kind !== 'source_report' || report.adapterVersion !== '1.0.0' || report.reportId !== reportId || `r-${sha256(encode(payload)).slice(0, 32)}` !== reportId || markdownPath !== `deliverables/选材日报/${report.createdAt?.slice(0, 10)}-${reportId}.md`) throw failure('Stored report content does not match its immutable ID', 'SOURCE_RESEARCH_CONFLICT');
    try {
      const markdown = await this.store.read(context, await this.store.target(context, markdownPath), this.config.maxReportBytes);
      if (markdown.sha256 !== report.markdownSha256) throw failure('Report Markdown differs from its immutable receipt', 'SOURCE_RESEARCH_CONFLICT');
      return { reportId, path: stored.path, sha256: stored.sha256, report, markdown: markdown.text, status: 'complete' };
    } catch (error) {
      if (error.code !== 'SOURCE_RESEARCH_NOT_FOUND' && error.code !== 'FS_NOT_FOUND') throw error;
      return { reportId, path: stored.path, sha256: stored.sha256, report, markdown: null, status: 'partial', markdownError: { code: error.code, message: error.message } };
    }
  }
}
