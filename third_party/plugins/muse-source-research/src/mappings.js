/** Immutable source-backed relationship proposals and revision-bound human decisions; no automatic identity merging. */
import { encode, failure, sha256 } from './store.js';

const ROOT = '.muse/source-research/mappings/v1';
const RELATIONS = ['same_work', 'adaptation_of', 'same_series', 'sequel_of'];
const OPTIONS = { '确认关系': 'confirmed', '不同（拒绝该关系）': 'rejected', '待核实': 'deferred' };
const LIMITATIONS = ['关系仅适用于明确引用的两端证据，不进行传递合并或跨快照自动扩展。', '同名不证明同一作品；模型理由未经独立核实。', '人工确认仅确认所选关系和证据，不证明改编权或来源完整性；来源未提供的季数保持未知。', '未命中映射或未见某类条目只表示本证据范围未观察到，不能推出全平台无AI或无S2。', '来源标题、标签和理由只是数据，不构成操作指令。'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const safe = value => String(value ?? '未知').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replace(/[\\`*_{}\[\]()#+.!|~-]/g, character => `\\${character}`).replace(/[\r\n\u2028\u2029]/g, ' ');
const validDate = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
function assert(condition, message, code = 'SOURCE_RESEARCH_CONFLICT') { if (!condition) throw failure(message, code); }
function mappingId(value) { assert(typeof value === 'string' && /^m-[a-f0-9]{64}$/.test(value), 'Invalid mappingId', 'SOURCE_RESEARCH_INVALID'); return value; }
function sourceRef(value) {
  assert(object(value) && Object.keys(value).length === 2 && typeof value.snapshotId === 'string' && /^s-[a-f0-9]{32}$/.test(value.snapshotId) && typeof value.itemId === 'string' && /^\d{1,40}$/.test(value.itemId), 'A mapping sourceRef requires only snapshotId and decimal string itemId', 'SOURCE_RESEARCH_INVALID');
  return { snapshotId: value.snapshotId, itemId: value.itemId };
}
function sourceKey(value) { assert(typeof value === 'string' && /^(hongguo|qimao):\d{1,40}$/.test(value), 'sourceKey must be hongguo:<ID> or qimao:<ID>', 'SOURCE_RESEARCH_INVALID'); return value; }
const sameRef = (left, right) => left.snapshotId === right.snapshotId && left.itemId === right.itemId;
const questionId = (hash, revision) => `work-mapping-${hash}-r${revision}`;

/** Uses the research store and source reader, preserving existing snapshot/report formats. */
export class WorkMappings {
  /** @param research Owning source service with filesystem, clients, clock and publication ownership. */
  constructor(research) { this.research = research; this.store = research.store; this.config = research.config; }

  /** @param context Project execution context. @param reference Snapshot and actual source ID. @returns Source-backed immutable endpoint, never model-supplied platform or title. */
  async endpoint(context, reference) {
    const ref = sourceRef(reference);
    const { snapshot, receipt } = await this.research.readSnapshot(context, ref.snapshotId);
    const item = snapshot.canonicalItems.find(candidate => candidate.id === ref.itemId);
    assert(item, 'Mapping itemId was not found among the snapshot canonical IDs', 'SOURCE_RESEARCH_NOT_FOUND');
    const raw = snapshot.sourceResult.items[item.sourceItemIndexes[0]];
    let url = null;
    if (typeof raw.url === 'string') {
      try {
        const parsed = new URL(raw.url);
        const hosts = snapshot.platform === 'qimao' ? ['www.qimao.com', 'qimao.com'] : ['hongguoduanju.com', 'www.hongguoduanju.com'];
        const matches = snapshot.platform === 'qimao'
          ? parsed.pathname === `/shuku/${ref.itemId}/` && parsed.search === ''
          : parsed.pathname === '/detail' && parsed.search === `?series_id=${ref.itemId}`;
        if (parsed.protocol === 'https:' && hosts.includes(parsed.hostname) && !parsed.username && !parsed.password && parsed.port === '' && parsed.hash === '' && matches) url = raw.url;
      } catch (error) { /* An invalid legacy URL remains in the original evidence and is not offered as a verified source link. */ }
    }
    return { sourceRef: ref, platform: snapshot.platform, key: item.key, title: item.title, evidenceKind: snapshot.evidenceKind, snapshotSha256: receipt.sha256,
      url, author: typeof raw.author === 'string' ? raw.author : null,
      description: typeof raw.description === 'string' ? raw.description : typeof raw.desc === 'string' ? raw.desc : null };
  }

  /** @param context Project execution context. @param path Mapping artifact path. @returns Bounded parsed document and exact file receipt. */
  async document(context, path) {
    const stored = await this.store.read(context, await this.store.target(context, path));
    let value;
    try { value = JSON.parse(stored.text); }
    catch (error) { throw failure(`Mapping JSON cannot be parsed: ${error.message}`); }
    return { value, receipt: { path: stored.path, sha256: stored.sha256 }, bytes: Buffer.byteLength(stored.text) };
  }

  /** @param context Project execution context. @returns All bounded mapping directory entries; invalid entries fail instead of being silently omitted. */
  async directories(context) {
    const entries = await this.store.entries(context, ROOT);
    assert(entries.length <= this.config.maxMappings, 'Mapping directory exceeds maxMappings', 'SOURCE_RESEARCH_LIMIT');
    for (const entry of entries) assert(entry.type === 'directory' && /^m-[a-f0-9]{64}$/.test(entry.name), 'Mapping storage contains an unexpected entry');
    return entries;
  }

  /** @param context Writable project context. @param request Model-proposed relation and two source references. @returns An immutable unreviewed proposal; matching titles never confirm it. */
  async propose(context, request) {
    await this.store.writable(context);
    assert(RELATIONS.includes(request.relation), 'Unsupported work relation', 'SOURCE_RESEARCH_INVALID');
    assert(typeof request.reason === 'string' && request.reason.trim() && request.reason.length <= this.config.maxMappingReasonChars, 'Mapping reason must be non-empty text within maxMappingReasonChars', 'SOURCE_RESEARCH_INVALID');
    const left = await this.endpoint(context, request.left), right = await this.endpoint(context, request.right);
    assert(!sameRef(left.sourceRef, right.sourceRef), 'A relationship proposal must reference two different source records', 'SOURCE_RESEARCH_INVALID');
    const body = { schemaVersion: 1, kind: 'work_mapping_proposal', adapterVersion: '1.0.0', createdAt: new Date(this.research.now()).toISOString(),
      left, right, relation: request.relation, reason: request.reason.trim(), reasonVerified: false };
    const proposalHash = sha256(encode(body)), id = `m-${proposalHash}`;
    const proposal = { ...body, mappingId: id, proposalHash };
    assert(Buffer.byteLength(encode(proposal)) <= this.config.maxMappingHistoryBytes, 'Mapping proposal exceeds maxMappingHistoryBytes', 'SOURCE_RESEARCH_LIMIT');
    return this.research.publishQueued(context, 'mapping-proposals', async () => {
      const entries = await this.directories(context);
      assert(entries.length < this.config.maxMappings || entries.some(entry => entry.name === id), 'Mapping capacity reached maxMappings', 'SOURCE_RESEARCH_LIMIT');
      assert(encode(await this.endpoint(context, left.sourceRef)) === encode(left) && encode(await this.endpoint(context, right.sourceRef)) === encode(right), 'Mapping evidence changed before proposal publication');
      const stored = await this.store.publish(context, `${ROOT}/${id}/proposal.json`, encode(proposal));
      if (stored.reused) return this.read(context, id);
      return this.state(proposal, { path: stored.path, sha256: stored.sha256 }, null, null);
    }, async () => {});
  }

  /** @param context Project execution context. @param id Immutable proposal ID. @param withBudget Internal caller requests total validated history bytes for append admission. @returns Verified state, or state plus internal byte accounting when requested. */
  async read(context, id, withBudget = false) {
    mappingId(id);
    const loaded = await this.document(context, `${ROOT}/${id}/proposal.json`), proposal = loaded.value;
    assert(object(proposal) && proposal.schemaVersion === 1, 'Unsupported mapping proposal schemaVersion', 'SOURCE_RESEARCH_VERSION');
    const { mappingId: declaredId, proposalHash, ...body } = proposal;
    assert(proposal.kind === 'work_mapping_proposal' && proposal.adapterVersion === '1.0.0' && declaredId === id && proposalHash === sha256(encode(body)) && id === `m-${proposalHash}`, 'Mapping proposal content differs from its immutable identity');
    assert(RELATIONS.includes(proposal.relation) && proposal.reasonVerified === false && typeof proposal.reason === 'string' && proposal.reason.trim() && proposal.reason.length <= this.config.maxMappingReasonChars && validDate(proposal.createdAt), 'Invalid stored mapping proposal fields');
    const actualLeft = await this.endpoint(context, proposal.left?.sourceRef), actualRight = await this.endpoint(context, proposal.right?.sourceRef);
    assert(encode(actualLeft) === encode(proposal.left) && encode(actualRight) === encode(proposal.right), 'Mapping source evidence differs from its saved snapshot receipt');
    assert(!sameRef(actualLeft.sourceRef, actualRight.sourceRef), 'Stored mapping repeats the same source record');
    const entries = await this.store.entries(context, `${ROOT}/${id}/revisions`);
    assert(entries.length <= this.config.maxMappingRevisions, 'Mapping revision count exceeds maxMappingRevisions', 'SOURCE_RESEARCH_LIMIT');
    let latestRevision = null, latestReceipt = null, bytes = loaded.bytes;
    assert(bytes <= this.config.maxMappingHistoryBytes, 'Mapping proposal exceeds maxMappingHistoryBytes', 'SOURCE_RESEARCH_LIMIT');
    for (const [index, entry] of entries.entries()) {
      const revision = index + 1;
      assert(entry.type === 'file' && entry.name === `${String(revision).padStart(6, '0')}.json`, 'Mapping revision files must form an uninterrupted ordered sequence');
      const loadedRevision = await this.document(context, `${ROOT}/${id}/revisions/${entry.name}`), record = loadedRevision.value;
      bytes += loadedRevision.bytes;
      assert(bytes <= this.config.maxMappingHistoryBytes, 'Mapping history exceeds maxMappingHistoryBytes', 'SOURCE_RESEARCH_LIMIT');
      assert(object(record) && record.schemaVersion === 1, 'Unsupported mapping revision schemaVersion', 'SOURCE_RESEARCH_VERSION');
      const { revisionHash, ...revisionBody } = record;
      assert(record.kind === 'work_mapping_revision' && record.adapterVersion === '1.0.0' && revisionHash === sha256(encode(revisionBody)) && record.mappingId === id && record.proposalHash === proposalHash && record.proposalSha256 === loaded.receipt.sha256 && record.revision === revision && record.priorRevision === revision - 1 && record.priorRevisionSha256 === (latestReceipt?.sha256 ?? null), 'Mapping revision identity, checksum or predecessor does not match');
      assert(record.questionId === questionId(loaded.receipt.sha256, revision - 1) && validDate(record.reviewedAt) && typeof record.reviewerSessionId === 'string' && record.reviewerSessionId.length > 0, 'Mapping revision review attribution is invalid');
      assert(this.answer(record.answer, record.questionId) === record.status, 'Mapping revision answer differs from its stored status');
      latestRevision = record; latestReceipt = loadedRevision.receipt;
    }
    const state = this.state(proposal, loaded.receipt, latestRevision, latestReceipt);
    return withBudget ? { state, historyBytes: bytes } : state;
  }

  /** @param proposal Immutable verified proposal. @param proposalReceipt Exact proposal-file receipt. @param latestRevision Last committed decision or null. @param revisionReceipt Exact revision-file receipt or null. @returns Public state without post-commit cancellable I/O. */
  state(proposal, proposalReceipt, latestRevision, revisionReceipt) {
    return { mappingId: proposal.mappingId, proposalHash: proposal.proposalHash, proposalSha256: proposalReceipt.sha256,
      status: latestRevision?.status ?? 'needs_human_review', revision: latestRevision?.revision ?? 0, revisionSha256: revisionReceipt?.sha256 ?? null,
      proposal, latestRevision, receipts: { proposal: proposalReceipt, revision: revisionReceipt }, limitations: [...LIMITATIONS] };
  }

  /** @param answer Untrusted answer batch item. @param expectedId Exact revision-bound question ID. @returns The one known selected status; rejects custom, empty, multiple or foreign answers. */
  answer(answer, expectedId) {
    assert(object(answer) && Object.keys(answer).every(key => ['id', 'selected'].includes(key)) && answer.id === expectedId && Array.isArray(answer.selected) && answer.selected.length === 1 && Object.hasOwn(OPTIONS, answer.selected[0]), 'Human mapping answer must select exactly one offered label for this proposal revision, with no custom answer', 'SOURCE_RESEARCH_INVALID_ANSWER');
    return OPTIONS[answer.selected[0]];
  }

  /** @param state Verified current mapping. @param request Expected immutable proposal hash and current revision. @returns Nothing; stale or incorrectly routed review cannot consume an answer. */
  expected(state, request) {
    assert(typeof request.expectedProposalSha256 === 'string' && /^[a-f0-9]{64}$/.test(request.expectedProposalSha256) && Number.isSafeInteger(request.expectedRevision) && request.expectedRevision >= 0, 'Review requires expectedProposalSha256 and a non-negative expectedRevision', 'SOURCE_RESEARCH_INVALID');
    assert(state.proposalSha256 === request.expectedProposalSha256 && state.revision === request.expectedRevision, 'Mapping proposal or revision changed; inspect the latest state and review again', 'SOURCE_RESEARCH_MAPPING_STALE');
    assert(request.action === 'supersede' ? state.revision > 0 : state.revision === 0, 'Use review for the initial decision and supersede for a later decision', 'SOURCE_RESEARCH_MAPPING_STALE');
    assert(state.revision < this.config.maxMappingRevisions, 'Mapping has reached maxMappingRevisions', 'SOURCE_RESEARCH_LIMIT');
  }

  /** @param context Writable project context. @param request Revision-bound review/supersede request. @param agent Exact live calling agent, passed to the real question service. @returns Newly appended human decision; denied, unavailable, canceled, invalid or stale answers never append. */
  async review(context, request, agent) {
    await this.store.writable(context);
    const state = await this.read(context, request.mappingId);
    this.expected(state, request);
    const id = questionId(state.proposalSha256, state.revision), p = state.proposal;
    const excerpt = value => value === null ? '未知（来源未提供）' : safe(value.length > this.config.maxMappingExcerptChars ? value.slice(0, this.config.maxMappingExcerptChars) + '…（仅展示片段，完整字段见快照）' : value);
    const question = { id, header: '作品关系审核', question: '请审核这份具体作品关系提案', multiSelect: false,
      detail: [`提案 ID：${state.mappingId}；文件 SHA-256：${state.proposalSha256}；当前修订：${state.revision}。`,
        `左侧：${excerpt(p.left.title)}（${p.left.platform} / ${p.left.key} / ${p.left.evidenceKind}）`,
        `左侧来源 URL：${excerpt(p.left.url)}；作者：${excerpt(p.left.author)}；简介：${excerpt(p.left.description)}`,
        `左侧快照：${p.left.sourceRef.snapshotId}；SHA-256：${p.left.snapshotSha256}。`,
        `右侧：${excerpt(p.right.title)}（${p.right.platform} / ${p.right.key} / ${p.right.evidenceKind}）`,
        `右侧来源 URL：${excerpt(p.right.url)}；作者：${excerpt(p.right.author)}；简介：${excerpt(p.right.description)}`,
        `右侧快照：${p.right.sourceRef.snapshotId}；SHA-256：${p.right.snapshotSha256}。`,
        `关系：${p.relation}（${direction(p.relation)}）。`, `模型理由（未独立核实）：${safe(p.reason)}`, ...LIMITATIONS].join('\n\n'),
      options: Object.keys(OPTIONS).map(label => ({ label })) };
    const answerer = typeof this.research.ctx.get === 'function' ? this.research.ctx.get('userQuestions') : this.research.ctx.userQuestions;
    assert(answerer, 'Work relationship review requires the userQuestions service', 'SOURCE_RESEARCH_NO_USER_QUESTIONS');
    const result = await answerer.ask({ questions: [question], agent, signal: context.signal });
    assert(object(result) && Array.isArray(result.answers) && result.answers.length === 1, 'Human mapping review requires exactly one answer', 'SOURCE_RESEARCH_INVALID_ANSWER');
    const status = this.answer(result.answers[0], id);
    return this.research.publishQueued(context, `mapping-${state.mappingId}`, async () => {
      let publicationContext = { ...context, policy: this.research.policyService()?.resolve({ session: agent.session }) };
      await this.store.writable(publicationContext);
      const loaded = await this.read(publicationContext, state.mappingId, true), current = loaded.state;
      this.expected(current, request);
      assert(current.revisionSha256 === state.revisionSha256, 'Mapping revision changed while waiting for human review', 'SOURCE_RESEARCH_MAPPING_STALE');
      const body = { schemaVersion: 1, kind: 'work_mapping_revision', adapterVersion: '1.0.0', mappingId: state.mappingId,
        proposalHash: state.proposalHash, proposalSha256: state.proposalSha256, revision: state.revision + 1,
        priorRevision: state.revision, priorRevisionSha256: state.revisionSha256, status,
        reviewedAt: new Date(this.research.now()).toISOString(), reviewerSessionId: agent.session.id,
        questionId: id, answer: { id, selected: [...result.answers[0].selected] } };
      const record = { ...body, revisionHash: sha256(encode(body)) };
      assert(loaded.historyBytes + Buffer.byteLength(encode(record)) <= this.config.maxMappingHistoryBytes, 'Mapping history would exceed maxMappingHistoryBytes; no decision was appended', 'SOURCE_RESEARCH_LIMIT');
      const path = `${ROOT}/${state.mappingId}/revisions/${String(record.revision).padStart(6, '0')}.json`;
      publicationContext = { ...context, policy: this.research.policyService()?.resolve({ session: agent.session }) };
      await this.store.writable(publicationContext);
      let stored;
      try { stored = await this.store.publish(publicationContext, path, encode(record)); }
      catch (error) {
        if (error.code === 'SOURCE_RESEARCH_CONFLICT') {
          const competing = await this.read(publicationContext, state.mappingId);
          assert(competing.proposalSha256 !== state.proposalSha256 || competing.revision <= state.revision, 'A competing human decision already published this revision', 'SOURCE_RESEARCH_MAPPING_STALE');
        }
        throw error;
      }
      assert(!stored.reused, 'A competing human decision already published this revision', 'SOURCE_RESEARCH_MAPPING_STALE');
      return this.state(current.proposal, current.receipts.proposal, record, { path: stored.path, sha256: stored.sha256 });
    }, async () => {});
  }

  /** @param context Project execution context. @param reference Optional exact snapshot/item reference. @param key Optional validated platform/source ID for historical evidence lookup. @returns Direct proposals within bounded storage; historical matches never extend their confirmations to a new snapshot. */
  async list(context, reference, key) {
    const requested = reference === undefined ? null : (await this.endpoint(context, reference)).sourceRef;
    const mappings = [];
    let bytes = 0;
    for (const entry of await this.directories(context)) {
      const state = await this.read(context, entry.name);
      bytes += Buffer.byteLength(encode(state));
      assert(bytes <= this.config.maxMappingListBytes, 'Mapping list exceeds maxMappingListBytes; results were not truncated', 'SOURCE_RESEARCH_LIMIT');
      if (key !== undefined ? state.proposal.left.key === key || state.proposal.right.key === key : !requested || sameRef(state.proposal.left.sourceRef, requested) || sameRef(state.proposal.right.sourceRef, requested)) mappings.push(state);
    }
    return { mappings, count: mappings.length, complete: true, limitations: [...LIMITATIONS] };
  }

  /** @param context Project execution context. @param request Lookup by exactly one mapping ID, exact source reference or historical source key. @returns Direct relationship states and explicit limitations. */
  async lookup(context, request) {
    assert([request.mappingId, request.sourceRef, request.sourceKey].filter(value => value !== undefined).length === 1, 'lookup requires exactly one mappingId, sourceRef or sourceKey', 'SOURCE_RESEARCH_INVALID');
    if (request.sourceKey !== undefined) {
      const key = sourceKey(request.sourceKey);
      return { ...await this.list(context, undefined, key), sourceKey: key, historyOnly: true,
        note: '仅返回同平台ID的历史直接提案及原快照证据；不把旧确认自动应用于新快照，不合并指标。' };
    }
    if (request.mappingId === undefined) return this.list(context, request.sourceRef);
    const state = await this.read(context, request.mappingId);
    return { mappings: [state], count: 1, complete: true, limitations: [...LIMITATIONS] };
  }
}

function direction(relation) { return { same_work: '同一作品', adaptation_of: '左侧改编自右侧', same_series: '同一系列，不等于同一作品', sequel_of: '左侧是右侧续作' }[relation]; }

/** @param states Verified relationship states captured during report construction. @returns Portable immutable review evidence without filesystem paths or versions. */
export function mappingReceipts(states) {
  return states.map(({ mappingId, proposalHash, proposalSha256, revision, revisionSha256, status, proposal, latestRevision }) => ({ mappingId, proposalHash, proposalSha256, revision, revisionSha256, status, proposal, latestRevision }));
}

/** @param receipts Report-captured relationship decisions. @returns An appended evidence section; legacy reports without mappingIds never call this renderer. */
export function renderMappings(receipts) {
  const labels = { confirmed: '已核实（人工确认该提案）', rejected: '已拒绝', deferred: '待核实', needs_human_review: '待人工审核（未核实）' };
  const lines = ['', '## 作品关系审核', '', '此处“已核实”仅指有人确认所选关系和证据，不证明版权或来源覆盖完整性。未审提案保持未核实；来源未提供的季数仍未知。关系不传递合并；未命中只表示本证据范围未观察到，不能推出全平台无AI或无S2。', ''];
  for (const receipt of receipts) {
    const p = receipt.proposal, r = receipt.latestRevision;
    lines.push(`### ${receipt.mappingId}`, '', `- 状态：${labels[receipt.status]}；关系方向：${direction(p.relation)}。`,
      `- 左侧：${safe(p.left.title)}；${safe(p.left.key)}；${safe(p.left.evidenceKind)}；快照 ${p.left.sourceRef.snapshotId}；SHA-256 ${p.left.snapshotSha256}。`,
      `- 左侧来源 URL：${safe(p.left.url)}；作者：${safe(p.left.author)}。`,
      `- 右侧：${safe(p.right.title)}；${safe(p.right.key)}；${safe(p.right.evidenceKind)}；快照 ${p.right.sourceRef.snapshotId}；SHA-256 ${p.right.snapshotSha256}。`,
      `- 右侧来源 URL：${safe(p.right.url)}；作者：${safe(p.right.author)}。`,
      `- 提案 SHA-256：${receipt.proposalSha256}；修订：${receipt.revision}；修订 SHA-256：${receipt.revisionSha256 ?? '无（尚未审核）'}。`,
      `- 审核时间：${r ? safe(r.reviewedAt) : '无（尚未审核）'}；审核 Session：${r ? safe(r.reviewerSessionId) : '无'}。`,
      `- 模型理由（未独立核实）：${safe(p.reason)}`, '');
  }
  return lines.join('\n');
}
