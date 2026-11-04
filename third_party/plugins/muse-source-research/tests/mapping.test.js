/** Work relationships retain source evidence and require answers from the real live-root question service. */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Context } from '@deepseek-ai/cordis';
import LocalFileSystem from '@deepseek-ai/dsh-fs-local';
import UserQuestionService from '@deepseek-ai/dsh-user-questions';
import SandboxPolicy, { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy';
import { SessionId } from '@deepseek-ai/dsh-session';
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit';
import { SourceResearch } from '../src/service.js';

const cleanup = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const labels = ['确认关系', '不同（拒绝该关系）', '待核实'];
const statuses = ['confirmed', 'rejected', 'deferred'];
const ref = (snapshot, itemId) => ({ snapshotId: snapshot.snapshotId, itemId });
const revisionArgs = (state, action = 'review') => ({ action, mappingId: state.mappingId, expectedProposalSha256: state.proposalSha256, expectedRevision: state.revision });

async function fixture(config = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'muse-work-mapping-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const ctx = new Context();
  cleanup.push(() => ctx.fiber.dispose());
  await mountAgentLoopTestDependencies(ctx);
  await ctx.plugin(LocalFileSystem, { cwd: directory });
  await ctx.plugin(SandboxPolicy, { mode: 'workspace-write', workspaceRoot: directory });
  await ctx.plugin(UserQuestionService);
  await mountAgentLoopTestHarness(ctx);
  let agentOrdinal = 0;
  const makeAgent = async (meta = {}, parentAgent) => {
    const handle = await ctx.agents.create({ sessionId: SessionId('mapping-agent-' + ++agentOrdinal), meta: { cwd: directory, ...meta }, ...(parentAgent === undefined ? {} : { parentAgent }) });
    cleanup.push(() => handle.dispose());
    return handle.agent;
  };
  const root = await makeAgent();
  const state = { now: Date.parse('2026-11-04T12:00:00.000Z') };
  const service = new SourceResearch(ctx, config, { now: () => state.now++ });
  cleanup.push(() => service.dispose());
  const callFamily = (type, args, agent = root, signal = new AbortController().signal) => ctx.agents.withInitiator(agent, () => service.execute(type, args, signal));
  const call = (args, agent = root, signal = new AbortController().signal) => callFamily('mapping', args, agent, signal);
  const report = args => callFamily('report', args);
  const snapshot = async (platform, items) => {
    const path = join(directory, platform + '-legacy.json');
    await writeFile(path, JSON.stringify({ platform, collectedAt: '2026-11-04T11:00:00.000Z', source: 'mapping fixture legacy evidence', coverage: { complete: false }, items: items.map(item => ({ platform, metric_type: 'legacy_count', metric_value: null, ...item })) }));
    return ctx.agents.withInitiator(root, () => service.execute('snapshot', { action: 'import_legacy', path }, new AbortController().signal));
  };
  const qimao = await snapshot('qimao', [
    { id: '101', title: '同名作品', url: 'https://www.qimao.com/shuku/101/', author: '来源作者', description: '来源简介' },
    { id: '102', title: '同名作品', url: 'https://www.qimao.com/shuku/999/' },
    { id: '103', title: '同名作品', url: 'https://www.qimao.com:8443/shuku/103/' },
  ]);
  const hongguo = await snapshot('hongguo', [
    { id: '201', title: '同名作品', url: 'https://hongguoduanju.com/detail?series_id=201' },
    { id: '202', title: '同名作品', url: 'https://hongguoduanju.com/detail?series_id=999' },
    { id: '203', title: '同名作品', url: 'https://hongguoduanju.com:8443/detail?series_id=203' },
  ]);
  const proposal = (options = {}, agent = root) => call({ action: 'propose', left: ref(qimao, '101'), right: ref(hongguo, '201'), relation: 'adaptation_of', reason: '标题相同，尚无其他身份依据，请人工核对。', ...options }, agent);
  const answerer = answer => {
    const seen = [];
    const dispose = ctx.on('user-questions/request', async request => {
      seen.push(request);
      return typeof answer === 'function' ? answer(request) : { answers: [{ id: request.questions[0].id, selected: [answer] }] };
    });
    cleanup.push(dispose);
    return { seen, dispose };
  };
  const revisions = async mappingId => {
    try { return (await readdir(join(directory, '.muse/source-research/mappings/v1', mappingId, 'revisions'))).sort(); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  };
  const revisionBytes = (mappingId, ordinal) => readFile(join(directory, '.muse/source-research/mappings/v1', mappingId, 'revisions', String(ordinal).padStart(6, '0') + '.json'));
  return { ctx, service, root, directory, qimao, hongguo, call, report, proposal, answerer, makeAgent, revisions, revisionBytes };
}

describe('work mapping through real agents, questions and project files', () => {
  it('keeps equal titles as separate proposals with explicit source IDs and unverified reasons', async () => {
    const f = await fixture();
    const provider = f.answerer(labels[0]);
    const proposals = [];
    for (const relation of ['same_work', 'adaptation_of', 'same_series', 'sequel_of']) proposals.push(await f.proposal({ relation }));
    expect(new Set(proposals.map(value => value.mappingId)).size).toBe(4);
    for (const proposal of proposals) {
      expect(proposal).toMatchObject({ status: 'needs_human_review', revision: 0, latestRevision: null, proposal: { reasonVerified: false } });
      expect(proposal.mappingId).toMatch(/^m-[a-f0-9]{64}$/);
      expect(proposal.proposal.left).toMatchObject({ platform: 'qimao', key: 'qimao:101', title: '同名作品', evidenceKind: 'legacy_file', snapshotSha256: f.qimao.sha256 });
      expect(proposal.proposal.right).toMatchObject({ platform: 'hongguo', key: 'hongguo:201', title: '同名作品', evidenceKind: 'legacy_file', snapshotSha256: f.hongguo.sha256 });
      expect(hash(await readFile(proposal.receipts.proposal.path))).toBe(proposal.proposalSha256);
      expect(await f.revisions(proposal.mappingId)).toEqual([]);
    }
    expect(provider.seen).toEqual([]);
    const another = await f.proposal({ left: ref(f.qimao, '102') });
    expect(another.mappingId).not.toBe(proposals[1].mappingId);
    expect(another.status).toBe('needs_human_review');
    expect((await f.call({ action: 'list' })).count).toBe(5);
  });

  it.each(labels.map((label, index) => [label, statuses[index]]))('persists the real user choice %s as %s', async (label, status) => {
    const f = await fixture();
    const proposal = await f.proposal();
    const provider = f.answerer(label);
    const reviewed = await f.call(revisionArgs(proposal));
    expect(reviewed).toMatchObject({ status, revision: 1, latestRevision: { kind: 'work_mapping_revision', mappingId: proposal.mappingId, proposalHash: proposal.proposalHash, proposalSha256: proposal.proposalSha256, revision: 1, priorRevision: 0, priorRevisionSha256: null, status, reviewerSessionId: f.root.session.id } });
    expect(provider.seen).toHaveLength(1);
    const question = provider.seen[0].questions[0];
    expect(reviewed.latestRevision.answer).toEqual({ id: question.id, selected: [label] });
    const bytes = await f.revisionBytes(proposal.mappingId, 1);
    expect(hash(bytes)).toBe(reviewed.revisionSha256);
    expect(hash(bytes)).toBe(reviewed.receipts.revision.sha256);
    expect(JSON.parse(bytes.toString('utf8'))).toEqual(reviewed.latestRevision);
    expect((await f.call({ action: 'read', mappingId: proposal.mappingId })).latestRevision).toEqual(reviewed.latestRevision);
    expect(await f.revisions(proposal.mappingId)).toEqual(['000001.json']);
  });

  it('binds the exact live owner, full proposal hash and both original evidence references to the question', async () => {
    const f = await fixture();
    const proposal = await f.proposal();
    const provider = f.answerer(labels[0]);
    await f.call(revisionArgs(proposal));
    const request = provider.seen[0], question = request.questions[0];
    expect(request.agent).toBe(f.root);
    expect(request.signal.aborted).toBe(false);
    expect(question.id).toBe('work-mapping-' + proposal.proposalSha256 + '-r0');
    expect(question.multiSelect).not.toBe(true);
    expect(question.options.map(option => option.label)).toEqual(labels);
    const displayed = question.question + '\n' + question.detail;
    for (const token of [proposal.mappingId, f.qimao.snapshotId, f.qimao.sha256, f.hongguo.snapshotId, f.hongguo.sha256, '101', '201', 'adaptation_of', 'legacy_file']) expect(displayed).toContain(token);
    expect(proposal.proposal.reasonVerified).toBe(false);
  });

  it('offers legacy source links only when canonical URLs identify the referenced item on the normal HTTPS port', async () => {
    const f = await fixture(), proposal = await f.proposal();
    expect(proposal.proposal.left.url).toBe('https://www.qimao.com/shuku/101/');
    expect(proposal.proposal.right.url).toBe('https://hongguoduanju.com/detail?series_id=201');
    const provider = f.answerer(labels[2]);
    await f.call(revisionArgs(proposal));
    expect(provider.seen[0].questions[0].detail).toContain('/shuku/101/');
    for (const [snapshot, itemId] of [[f.qimao, '102'], [f.qimao, '103'], [f.hongguo, '202'], [f.hongguo, '203']]) {
      const invalid = await f.proposal({ left: ref(snapshot, itemId) });
      expect(invalid.proposal.left.url).toBeNull();
      await f.call(revisionArgs(invalid));
      const detail = provider.seen.at(-1).questions[0].detail;
      expect(detail).not.toContain('/shuku/999/');
      expect(detail).not.toContain('series_id=999');
      expect(detail).not.toContain('8443');
    }
  });

  it('rejects model-supplied confirmation fields and stale hashes without asking or reserving a decision', async () => {
    const f = await fixture(), proposal = await f.proposal();
    const provider = f.answerer(labels[0]);
    await expect(f.proposal({ confirmed: true })).rejects.toThrow(/unknown|unsupported/i);
    await expect(f.call({ ...revisionArgs(proposal), decision: 'confirmed' })).rejects.toThrow(/unknown|unsupported/i);
    await expect(f.call({ ...revisionArgs(proposal, 'supersede'), confirmed: true })).rejects.toThrow(/unknown|unsupported/i);
    await expect(f.call({ ...revisionArgs(proposal), expectedProposalSha256: '0'.repeat(64) })).rejects.toMatchObject({ code: 'SOURCE_RESEARCH_MAPPING_STALE' });
    expect(provider.seen).toEqual([]);
    expect(await f.revisions(proposal.mappingId)).toEqual([]);
    expect((await f.call({ action: 'read', mappingId: proposal.mappingId })).status).toBe('needs_human_review');
  });

  it('rejects read-only review before asking and keeps read access available', async () => {
    const f = await fixture(), proposal = await f.proposal();
    const provider = f.answerer(labels[0]);
    setSandboxMode(f.root.session, 'read-only');
    await expect(f.call(revisionArgs(proposal))).rejects.toMatchObject({ code: 'SOURCE_RESEARCH_READ_ONLY' });
    await expect(f.proposal({ relation: 'same_work' })).rejects.toMatchObject({ code: 'SOURCE_RESEARCH_READ_ONLY' });
    expect(provider.seen).toEqual([]);
    expect(await f.revisions(proposal.mappingId)).toEqual([]);
    expect((await f.call({ action: 'read', mappingId: proposal.mappingId })).revision).toBe(0);
  });

  it('honors permission revoked while a real human question is pending', async () => {
    const f = await fixture(), proposal = await f.proposal();
    const entered = Promise.withResolvers(), answer = Promise.withResolvers();
    cleanup.push(() => answer.resolve({ answers: [] }));
    const provider = f.answerer(request => { entered.resolve(request); return answer.promise; });
    const review = f.call(revisionArgs(proposal));
    const denied = expect(review).rejects.toMatchObject({ code: 'SOURCE_RESEARCH_READ_ONLY' });
    const request = await Promise.race([entered.promise, review.then(() => { throw new Error('Review completed before asking'); })]);
    setSandboxMode(f.root.session, 'read-only');
    answer.resolve({ answers: [{ id: request.questions[0].id, selected: [labels[0]] }] });
    await denied;
    expect(provider.seen).toHaveLength(1);
    expect(await f.revisions(proposal.mappingId)).toEqual([]);
    expect((await f.call({ action: 'read', mappingId: proposal.mappingId })).status).toBe('needs_human_review');
  });

  it('lets an owned child propose but rejects its review before reaching any answerer', async () => {
    const f = await fixture();
    const child = await f.makeAgent({}, f.root);
    const proposal = await f.proposal({}, child);
    const provider = f.answerer(labels[0]);
    await expect(f.call(revisionArgs(proposal), child)).rejects.toMatchObject({ name: 'UserQuestionError', code: 'DELEGATED_CALLER' });
    expect(provider.seen).toEqual([]);
    expect(await f.revisions(proposal.mappingId)).toEqual([]);
    expect((await f.call(revisionArgs(proposal))).status).toBe('confirmed');
    expect(provider.seen[0].agent).toBe(f.root);
  });

  it('allows a live root with durable subagent lineage to review normally', async () => {
    const f = await fixture(), proposal = await f.proposal();
    const resumedRoot = await f.makeAgent({ parentSession: f.root.session.id, delegationDepth: 2, origin: 'subagent' });
    expect(f.ctx.agents.roots()).toContain(resumedRoot);
    const provider = f.answerer(labels[1]);
    const decision = await f.call(revisionArgs(proposal), resumedRoot);
    expect(decision.latestRevision).toMatchObject({ status: 'rejected', reviewerSessionId: resumedRoot.session.id });
    expect(provider.seen[0].agent).toBe(resumedRoot);
  });

  it.each(['empty', 'empty_selection', 'custom', 'selected_and_custom', 'multiple', 'wrong_id', 'unknown'])('does not persist an invalid %s answer', async kind => {
    const f = await fixture(), proposal = await f.proposal();
    const provider = f.answerer(request => {
      const answer = { id: request.questions[0].id, selected: [] };
      if (kind === 'custom') answer.custom = '我确认';
      if (kind === 'selected_and_custom') { answer.selected = [labels[0]]; answer.custom = '但可能是别的作品'; }
      if (kind === 'multiple') answer.selected = labels.slice(0, 2);
      if (kind === 'wrong_id') { answer.id = 'a different proposal'; answer.selected = [labels[0]]; }
      if (kind === 'unknown') answer.selected = ['confirmed'];
      return { answers: kind === 'empty' ? [] : [answer] };
    });
    await expect(f.call(revisionArgs(proposal))).rejects.toMatchObject({ code: 'SOURCE_RESEARCH_INVALID_ANSWER' });
    expect(provider.seen).toHaveLength(1);
    expect(await f.revisions(proposal.mappingId)).toEqual([]);
    expect((await f.call({ action: 'read', mappingId: proposal.mappingId })).revision).toBe(0);
  });

  it('does not convert an unavailable answerer into a user decision', async () => {
    const f = await fixture(), proposal = await f.proposal();
    await expect(f.call(revisionArgs(proposal))).rejects.toMatchObject({ name: 'UserQuestionError', code: 'NO_PROVIDER' });
    expect(await f.revisions(proposal.mappingId)).toEqual([]);
    f.answerer(labels[2]);
    expect((await f.call(revisionArgs(proposal))).status).toBe('deferred');
  });

  it('cancels a real pending question without leaving a revision behind', async () => {
    const f = await fixture(), proposal = await f.proposal();
    const entered = Promise.withResolvers();
    const controller = new AbortController();
    cleanup.push(() => controller.abort());
    f.answerer(request => new Promise((_resolve, reject) => {
      const abort = () => reject(request.signal.reason);
      request.signal.addEventListener('abort', abort, { once: true });
      entered.resolve();
    }));
    const review = f.call(revisionArgs(proposal), f.root, controller.signal);
    const rejected = expect(review).rejects.toMatchObject({ name: 'UserQuestionError', code: 'ASK_ABORTED' });
    await Promise.race([entered.promise, review.then(() => { throw new Error('Review completed before asking the user'); })]);
    controller.abort(new Error('test cancelled review'));
    await rejected;
    expect(await f.revisions(proposal.mappingId)).toEqual([]);
    expect((await f.call({ action: 'read', mappingId: proposal.mappingId })).status).toBe('needs_human_review');
  });

  it('returns the immutable decision receipt when cancellation arrives after atomic publication', async () => {
    const f = await fixture(), proposal = await f.proposal();
    f.answerer(labels[0]);
    const controller = new AbortController();
    const write = f.ctx.fs.writeText.bind(f.ctx.fs);
    cleanup.push(() => { controller.abort(); f.ctx.fs.writeText = write; });
    let published = false;
    f.ctx.fs.writeText = async (...args) => {
      const outcome = await write(...args);
      if (args[0].displayPath.replaceAll('\\', '/').endsWith('/revisions/000001.json')) {
        published = true;
        controller.abort(new Error('canceled after the guarded write committed'));
      }
      return outcome;
    };
    const reviewed = await f.call(revisionArgs(proposal), f.root, controller.signal);
    expect(published).toBe(true);
    expect(controller.signal.aborted).toBe(true);
    expect(reviewed).toMatchObject({ status: 'confirmed', revision: 1 });
    const bytes = await f.revisionBytes(proposal.mappingId, 1);
    expect(reviewed.revisionSha256).toBe(hash(bytes));
    expect(reviewed.receipts.revision.sha256).toBe(hash(bytes));
    expect(JSON.parse(bytes.toString('utf8'))).toEqual(reviewed.latestRevision);
    expect((await f.call({ action: 'read', mappingId: proposal.mappingId })).revisionSha256).toBe(reviewed.revisionSha256);
  });

  it('rejects an answer made stale by another live root and appends superseding decisions without overwrites', async () => {
    const f = await fixture(), proposal = await f.proposal();
    const other = await f.makeAgent();
    const gates = [Promise.withResolvers(), Promise.withResolvers()];
    const entered = [Promise.withResolvers(), Promise.withResolvers()];
    cleanup.push(() => { for (const gate of gates) gate.resolve({ answers: [] }); });
    const provider = f.answerer(request => {
      const index = request.agent === f.root ? 0 : 1;
      entered[index].resolve(request);
      return gates[index].promise;
    });
    const oldBytes = await readFile(proposal.receipts.proposal.path);
    const first = f.call(revisionArgs(proposal));
    const staleFirst = expect(first).rejects.toMatchObject({ code: 'SOURCE_RESEARCH_MAPPING_STALE' });
    const firstQuestion = await Promise.race([entered[0].promise, first.then(() => { throw new Error('First review completed before asking'); })]);
    const second = f.call(revisionArgs(proposal), other);
    const secondQuestion = await Promise.race([entered[1].promise, second.then(() => { throw new Error('Second review completed before asking'); })]);
    gates[1].resolve({ answers: [{ id: secondQuestion.questions[0].id, selected: [labels[0]] }] });
    const won = await second;
    gates[0].resolve({ answers: [{ id: firstQuestion.questions[0].id, selected: [labels[0]] }] });
    await staleFirst;
    expect(won.latestRevision.reviewerSessionId).toBe(other.session.id);
    expect(await f.revisions(proposal.mappingId)).toEqual(['000001.json']);
    const firstRevision = await f.revisionBytes(proposal.mappingId, 1);
    provider.dispose();
    const nextProvider = f.answerer(labels[1]);
    const superseded = await f.call(revisionArgs(won, 'supersede'));
    expect(superseded).toMatchObject({ status: 'rejected', revision: 2, latestRevision: { priorRevision: 1, priorRevisionSha256: hash(firstRevision) } });
    expect(nextProvider.seen[0].questions[0].id).toBe('work-mapping-' + proposal.proposalSha256 + '-r1');
    expect(await f.revisionBytes(proposal.mappingId, 1)).toEqual(firstRevision);
    expect(await readFile(proposal.receipts.proposal.path)).toEqual(oldBytes);
    await expect(f.call(revisionArgs(won, 'supersede'))).rejects.toMatchObject({ code: 'SOURCE_RESEARCH_MAPPING_STALE' });
    expect(nextProvider.seen).toHaveLength(1);
    expect(await f.revisions(proposal.mappingId)).toEqual(['000001.json', '000002.json']);
  });

  it('looks up only explicitly referenced relationships without transitive matches or market-absence claims', async () => {
    const f = await fixture();
    f.answerer(labels[0]);
    const direct = await f.proposal({ relation: 'same_work' });
    await f.call(revisionArgs(direct));
    const next = await f.proposal({ left: ref(f.hongguo, '201'), right: ref(f.qimao, '102'), relation: 'sequel_of' });
    await f.call(revisionArgs(next));
    const unrelated = await f.proposal({ left: ref(f.qimao, '103'), relation: 'same_series' });
    const found = await f.call({ action: 'lookup', sourceRef: ref(f.qimao, '101') });
    expect(found).toMatchObject({ count: 1, complete: true });
    expect(found.mappings.map(value => value.mappingId)).toEqual([direct.mappingId]);
    expect(found.mappings[0].status).toBe('confirmed');
    expect(found.mappings.map(value => value.mappingId)).not.toContain(next.mappingId);
    expect(found.mappings.map(value => value.mappingId)).not.toContain(unrelated.mappingId);
    expect(found.limitations.join(' ')).toMatch(/AI|S2/);
    for (const field of ['aiVersionExists', 's2Exists', 'noAi', 'noS2']) expect(found).not.toHaveProperty(field);
    expect((await f.call({ action: 'lookup', mappingId: next.mappingId })).mappings[0].proposal.relation).toBe('sequel_of');
    await expect(f.call({ action: 'lookup', sourceRef: ref(f.qimao, '101'), mappingId: direct.mappingId })).rejects.toThrow();
  });

  it('rejects a competing writer from another provider instance at atomic revision publication', async () => {
    const f = await fixture(), proposal = await f.proposal();
    const other = await f.makeAgent();
    const secondService = new SourceResearch(f.ctx, {}, { now: () => Date.parse('2026-11-04T13:00:00.000Z') });
    cleanup.push(() => secondService.dispose());
    f.answerer(labels[0]);
    const admitted = Promise.withResolvers();
    const write = f.ctx.fs.writeText.bind(f.ctx.fs);
    let writes = 0;
    cleanup.push(() => { admitted.resolve(); f.ctx.fs.writeText = write; });
    // Hold both real guarded writes after their independent revision reads.
    f.ctx.fs.writeText = async (...args) => {
      if (args[0].displayPath.replaceAll('\\', '/').endsWith('/revisions/000001.json')) {
        if (++writes === 2) admitted.resolve();
        await admitted.promise;
      }
      return write(...args);
    };
    const first = f.call(revisionArgs(proposal));
    const second = f.ctx.agents.withInitiator(other, () => secondService.execute('mapping', revisionArgs(proposal), new AbortController().signal));
    const outcomes = await Promise.allSettled([first, second]);
    expect(writes).toBe(2);
    expect(outcomes.filter(value => value.status === 'fulfilled')).toHaveLength(1);
    const rejected = outcomes.find(value => value.status === 'rejected');
    expect(rejected.reason).toMatchObject({ code: 'SOURCE_RESEARCH_MAPPING_STALE' });
    expect(await f.revisions(proposal.mappingId)).toEqual(['000001.json']);
    const saved = JSON.parse(await f.revisionBytes(proposal.mappingId, 1));
    expect([f.root.session.id, other.session.id]).toContain(saved.reviewerSessionId);
    expect((await f.call({ action: 'read', mappingId: proposal.mappingId })).latestRevision).toEqual(saved);
  });

  it('captures mapping decisions in immutable reports without changing earlier evidence', async () => {
    const f = await fixture(), proposal = await f.proposal();
    const args = { action: 'build', snapshotIds: [f.qimao.snapshotId, f.hongguo.snapshotId], mappingIds: [proposal.mappingId] };
    const unreviewed = await f.report(args);
    expect(unreviewed.mappingReceipts[0]).toMatchObject({ status: 'needs_human_review', revision: 0 });
    const pendingMarkdown = await readFile(unreviewed.markdownPath, 'utf8');
    expect(pendingMarkdown).toContain('待人工审核');
    expect(pendingMarkdown).not.toContain('状态：已核实');
    const provider = f.answerer(labels[0]);
    const confirmed = await f.call(revisionArgs(proposal));
    const receipt = await f.report(args);
    expect(receipt.mappingReceipts[0]).toMatchObject({ mappingId: proposal.mappingId, status: 'confirmed', revision: 1, proposalSha256: proposal.proposalSha256, revisionSha256: confirmed.revisionSha256 });
    const reportBytes = await readFile(receipt.path), markdownBytes = await readFile(receipt.markdownPath);
    expect(reportBytes.toString('utf8')).not.toContain(f.directory);
    expect(markdownBytes.toString('utf8')).toContain('状态：已核实');
    expect(markdownBytes.toString('utf8')).toContain(confirmed.revisionSha256);
    provider.dispose();
    f.answerer(labels[1]);
    await f.call(revisionArgs(confirmed, 'supersede'));
    const read = await f.report({ action: 'read', reportId: receipt.reportId });
    expect(read.report.mappingReceipts[0]).toMatchObject({ status: 'confirmed', revision: 1 });
    expect(await readFile(receipt.path)).toEqual(reportBytes);
    expect(await readFile(receipt.markdownPath)).toEqual(markdownBytes);
    expect(await readFile(unreviewed.markdownPath, 'utf8')).toBe(pendingMarkdown);
  });

  it('refuses tampered proposals and revision checksums before asking again', async () => {
    const f = await fixture(), proposal = await f.proposal();
    const provider = f.answerer(labels[0]);
    const confirmed = await f.call(revisionArgs(proposal));
    const originalRevision = await f.revisionBytes(proposal.mappingId, 1);
    const changed = JSON.parse(originalRevision);
    changed.status = 'rejected';
    await writeFile(confirmed.receipts.revision.path, JSON.stringify(changed));
    await expect(f.call({ action: 'read', mappingId: proposal.mappingId })).rejects.toMatchObject({ code: 'SOURCE_RESEARCH_CONFLICT' });
    await expect(f.call(revisionArgs(confirmed, 'supersede'))).rejects.toMatchObject({ code: 'SOURCE_RESEARCH_CONFLICT' });
    expect(provider.seen).toHaveLength(1);
    await writeFile(confirmed.receipts.revision.path, originalRevision);
    const originalProposal = await readFile(proposal.receipts.proposal.path);
    const forged = JSON.parse(originalProposal);
    forged.relation = 'same_work';
    await writeFile(proposal.receipts.proposal.path, JSON.stringify(forged));
    await expect(f.call(revisionArgs(confirmed, 'supersede'))).rejects.toMatchObject({ code: 'SOURCE_RESEARCH_CONFLICT' });
    expect(provider.seen).toHaveLength(1);
    await writeFile(proposal.receipts.proposal.path, originalProposal);
    expect((await f.call({ action: 'read', mappingId: proposal.mappingId })).status).toBe('confirmed');
    expect(await f.revisions(proposal.mappingId)).toEqual(['000001.json']);
  });

  it('enforces proposal and revision limits before creating files or asking for unavailable capacity', async () => {
    const f = await fixture({ maxMappings: 1, maxMappingRevisions: 1, maxMappingReasonChars: 8 });
    const provider = f.answerer(labels[0]);
    await expect(f.proposal({ reason: 'x'.repeat(9) })).rejects.toMatchObject({ code: 'SOURCE_RESEARCH_INVALID' });
    await expect(f.proposal({ left: ref(f.qimao, '999'), reason: '待核实' })).rejects.toMatchObject({ code: 'SOURCE_RESEARCH_NOT_FOUND' });
    expect((await f.call({ action: 'list' })).count).toBe(0);
    const proposal = await f.proposal({ reason: '待核实' });
    await expect(f.proposal({ relation: 'same_work', reason: '另一提案' })).rejects.toMatchObject({ code: 'SOURCE_RESEARCH_LIMIT' });
    const confirmed = await f.call(revisionArgs(proposal));
    await expect(f.call(revisionArgs(confirmed, 'supersede'))).rejects.toMatchObject({ code: 'SOURCE_RESEARCH_LIMIT' });
    expect(provider.seen).toHaveLength(1);
    expect(await f.revisions(proposal.mappingId)).toEqual(['000001.json']);
  });

  it('checks the complete proposal and next revision against mapping history byte limits', async () => {
    const f = await fixture(), proposal = await f.proposal();
    const provider = f.answerer(labels[0]);
    const limited = new SourceResearch(f.ctx, { maxMappingHistoryBytes: (await readFile(proposal.receipts.proposal.path)).byteLength }, { now: () => Date.parse('2026-11-04T13:00:00.000Z') });
    cleanup.push(() => limited.dispose());
    await expect(f.ctx.agents.withInitiator(f.root, () => limited.execute('mapping', revisionArgs(proposal), new AbortController().signal))).rejects.toMatchObject({ code: 'SOURCE_RESEARCH_LIMIT' });
    expect(provider.seen).toHaveLength(1);
    expect(await f.revisions(proposal.mappingId)).toEqual([]);
    const tiny = await fixture({ maxMappingHistoryBytes: 1 });
    await expect(tiny.proposal()).rejects.toMatchObject({ code: 'SOURCE_RESEARCH_LIMIT' });
    expect((await tiny.call({ action: 'list' })).count).toBe(0);
  });
});
