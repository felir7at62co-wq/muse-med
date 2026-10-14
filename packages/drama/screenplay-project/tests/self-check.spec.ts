/** Opt-in sequential self-check, exact reread bindings, replay, and historical independent reviews. */
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import { brandString } from '@deepseek-ai/dsh-brand'
import { z } from 'zod'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { ProjectCommands } from '../src/project.ts'
import { PROJECT_FILE, STORY_POLICY, type ProjectRequest } from '../src/schema.ts'
import { acceptedScripts, sha256 } from '../src/episode.ts'
import { validReview, requiredReads, selfCheckEvidence } from '../src/review.ts'
import type { ActorId } from '../src/ids.ts'
import type { ProjectReadReceipt } from '../src/review.ts'

let ctx: Context, root: string, project: string, commands: ProjectCommands
let step: number, receipts: ProjectReadReceipt[]
const actor = brandString<ActorId>('real-creation-session')
const limits = { maxSourceBytes: 1024 * 1024, maxProjectBytes: 4 * 1024 * 1024,
  maxReadUnits: 100, maxReadBytes: 64 * 1024, maxFactBatch: 20 }
const current = async () => PROJECT_FILE.parse(JSON.parse(await readFile(project, 'utf8')))
const run = (request: ProjectRequest, asActor = actor, liveStep: number | undefined = step) => commands.execute(request, {
  actor: asActor, signal: new AbortController().signal, ...(liveStep === undefined ? {} : { step: SessionSeq(liveStep) }),
  receipts, observeRead: (receipt) => { receipts.push(receipt) },
})
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'screenplay-self-check-'))
  project = join(root, 'project.json')
  ctx = new Context()
  await ctx.plugin(LocalFileSystem, { cwd: root })
  await ctx.plugin(LocalAttachmentStore, { dshHome: root })
  commands = new ProjectCommands(ctx.fs, limits, ctx.attachments, 'self-check')
  step = 10; receipts = []
  await run({ method: 'init', project, mode: 'faithful', instructions: '保留归属与来源。' })
  await writeFile(join(root, 'source.txt'), '甲想：钥匙在我手里。\n甲推门。\n')
  await run({ method: 'import_source', project, expected_revision: 0, path: join(root, 'source.txt'), source_kind: 'text' })
})
afterEach(async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
async function propose() {
  const file = await current(), unit = file.sources[0]!.units[0]!
  await run({ method: 'propose_fact', project, expected_revision: file.revision,
    fact: { kind: 'thought', origin: 'source', actor: '甲', layer: 'present', summary: unit.text,
      anchors: [{ unit_id: unit.id, quote: unit.text }] } })
  return (await current()).facts[0]!
}
async function rereadFact() {
  const file = await current()
  await run({ method: 'read_fact', project, fact_id: file.facts[0]!.id })
  await run({ method: 'read_source', project, source_id: file.sources[0]!.id, start: 1, count: 1 })
}
async function approveFact() {
  const file = await current()
  return run({ method: 'review_fact', project, expected_revision: file.revision, fact_id: file.facts[0]!.id,
    decision: 'approve', reason: '已重新核对甲的内心独白与原文。' })
}
async function stage() {
  const file = await current()
  await run({ method: 'stage', project, expected_revision: file.revision, episode: file.accepted.length + 1,
    scenes: [{ location: '门前', time: '日', layer: 'present', transition: 'opening', characters: ['甲'],
      beats: [{ kind: 'os', actor: '甲', text: '钥匙在我手里。', fact_ids: [file.facts[0]!.id], requires_knowledge: [], witnesses: [] }] }] })
  return (await current()).candidates.at(-1)!
}
async function reviewedFact() { await propose(); step = 20; await rereadFact(); step = 30; await approveFact() }
async function reviewCandidate() {
  const file = await current(), candidate = file.candidates.at(-1)!
  return run({ method: 'review', project, expected_revision: file.revision, candidate_id: candidate.id,
    candidate_sha256: candidate.sha256, decision: 'approve', reason: '本会话在读回完整原文、人物心理、场次和正文后自检。' })
}
async function rereadCandidate() {
  const file = await current(), candidate = file.candidates.at(-1)!
  await run({ method: 'read_candidate', project, candidate_id: candidate.id })
  await run({ method: 'read_source', project, source_id: file.sources[0]!.id, start: 1, count: 1 })
}
async function accepted() {
  await reviewedFact(); step = 40; const candidate = await stage()
  step = 50; await rereadCandidate(); step = 60; await reviewCandidate()
  const file = await current()
  await run({ method: 'commit', project, expected_revision: file.revision, candidate_id: candidate.id, candidate_sha256: candidate.sha256 })
  return candidate
}

it('does not inherit fact review context from absent or nonmatching archived story facts', async () => {
  await reviewedFact(); const file = await current(), fact = file.facts[0]!
  file.story_policy = STORY_POLICY.parse({ version: 'story-faithful-v2', sha256: '0'.repeat(64), work_title: 'Synthetic archived grant',
    videos: [{ path: join(root, 'archived.mp4'), source_version: 'archived-source-version', episode: 1 }],
    scope: { episodes: [1], instructions: 'Preserve the original key ownership.' }, allowed_categories: [],
    authorization: { source: 'user', session_id: actor, message_id: 'archived-user-message', seq: 1,
      message_sha256: sha256('Original human request'), quote: 'Preserve the original story.', consent_assessment: 'Exact original scope.' },
    legacy_context_sha256: '1'.repeat(64) })
  expect(validReview(file, fact, 'fact')).toBe(false)
  file.story_policy.original_facts = [{ id: fact.id, sha256: '2'.repeat(64) }]
  expect(validReview(file, fact, 'fact')).toBe(false)
})

it('keeps legacy context fields exact and excludes candidates absent from an archived retention list', async () => {
  await propose(); step = 20; await rereadFact(); const file = await current(), fact = file.facts[0]!
  delete file.review_mode; file.workflow = 'video_to_screenplay'
  const bound = (subject: Parameters<typeof requiredReads>[1], kind: 'fact' | 'candidate') => [{
    project_id: file.id, project_sha256: 'loaded-current-project', revision: file.revision, actor, step: SessionSeq(20),
    reads: requiredReads(file, subject, kind),
  }]
  const evidence = selfCheckEvidence(file, 'loaded-current-project', fact, 'fact', actor, SessionSeq(30), bound(fact, 'fact'))
  expect(evidence.context_sha256).toBe(sha256(JSON.stringify({
    mode: file.mode, instructions: file.instructions, workflow: file.workflow,
  })))
  step = 30; await approveFact(); step = 40; const candidate = await stage(), stagedFile = await current()
  stagedFile.story_policy = STORY_POLICY.parse({ version: 'story-faithful-v2', sha256: '0'.repeat(64), work_title: 'Synthetic new grant',
    videos: [{ path: join(root, 'archived.mp4'), source_version: 'archived-source-version', episode: 1 }],
    scope: { episodes: [1], instructions: 'Preserve the original key ownership.' }, allowed_categories: [],
    authorization: { source: 'user', session_id: actor, message_id: 'new-human-message', seq: 1,
      message_sha256: sha256('New human request'), quote: 'Preserve the original story.', consent_assessment: 'Exact original scope.' } })
  const candidateReads: ProjectReadReceipt[] = [{ project_id: stagedFile.id, project_sha256: 'new-project', revision: stagedFile.revision,
    actor, step: SessionSeq(50), reads: requiredReads(stagedFile, candidate, 'candidate') }]
  expect(selfCheckEvidence(stagedFile, 'new-project', candidate, 'candidate', actor, SessionSeq(60), candidateReads).context_sha256)
    .not.toBe(evidence.context_sha256)
  stagedFile.story_policy.retained_candidates = [{ id: candidate.id, sha256: '1'.repeat(64) }]
  expect(selfCheckEvidence(stagedFile, 'new-project', candidate, 'candidate', actor, SessionSeq(60), candidateReads).context_sha256)
    .not.toBe('1'.repeat(64))
  expect(validReview(stagedFile, candidate, 'candidate')).toBe(false)
})

it('rejects same-step proposal/read/approval and a later decision without current source rereads', async () => {
  await propose(); await rereadFact()
  await expect(approveFact()).rejects.toThrow('self_check_step')
  step = 20
  await expect(approveFact()).rejects.toThrow('self_check_read_required')
  await rereadFact()
  await expect(approveFact()).rejects.toThrow('self_check_read_required')
  step = 30; await approveFact()
  const review = (await current()).facts[0]!.review!
  expect(review).toMatchObject({ kind: 'self-check', actor, evidence: { creation_step: 10, review_step: 30 } })
  expect(review.evidence!.reads.every(read => read.step === 20)).toBe(true)
})

it('fails closed without live host step and rejects a different-session self-check actor', async () => {
  await propose(); step = 20; await rereadFact(); step = 30
  await expect(commands.execute({ method: 'review_fact', project, expected_revision: (await current()).revision,
    fact_id: (await current()).facts[0]!.id, decision: 'approve', reason: '无真实轮。' }, { actor, signal: new AbortController().signal, receipts })).rejects.toThrow('self_check_step')
  await expect(run({ method: 'review_fact', project, expected_revision: (await current()).revision,
    fact_id: (await current()).facts[0]!.id, decision: 'approve', reason: '另一会话。' }, brandString<ActorId>('other'))).rejects.toThrow('self_check_actor')
})

it('requires exact current file bytes and revision after an intervening mutation or edited fact', async () => {
  await propose(); step = 20; await rereadFact()
  const before = await current()
  await writeFile(join(root, 'second.txt'), '乙说：你好。')
  await run({ method: 'import_source', project, expected_revision: before.revision, path: join(root, 'second.txt'), source_kind: 'text' })
  step = 30; await expect(approveFact()).rejects.toThrow('self_check_read_required')
  await expect(run({ method: 'review_fact', project, expected_revision: before.revision, fact_id: before.facts[0]!.id,
    decision: 'approve', reason: '过期。' })).rejects.toThrow('stale_revision')
  step = 40; await rereadFact()
  const edited = await current(); edited.facts[0]!.summary = '甲知道钥匙位置。'
  await writeFile(project, JSON.stringify(edited)); step = 50
  await expect(approveFact()).rejects.toThrow('self_check_read_required')
})

it('keeps partial source reads from counting as unreturned source units', async () => {
  const file = await current(), second = file.sources[0]!.units[1]!
  await run({ method: 'propose_fact', project, expected_revision: file.revision,
    fact: { kind: 'action', origin: 'source', actor: '甲', layer: 'present', summary: second.text, anchors: [{ unit_id: second.id, quote: second.text }] } })
  step = 20; await rereadFact(); step = 30
  await expect(approveFact()).rejects.toThrow('self_check_read_required')
})

it('requires candidate and source reads after staging and rejects stale candidate digests', async () => {
  await reviewedFact(); step = 40; const candidate = await stage(); step = 50
  await expect(reviewCandidate()).rejects.toThrow('self_check_read_required')
  await rereadCandidate(); await expect(reviewCandidate()).rejects.toThrow('self_check_read_required')
  step = 60
  await expect(run({ method: 'review', project, expected_revision: (await current()).revision, candidate_id: candidate.id,
    candidate_sha256: '0'.repeat(64), decision: 'approve', reason: '摘要过期。' })).rejects.toThrow('candidate_review_state')
  await reviewCandidate()
  expect((await current()).candidates[0]!.review!.kind).toBe('self-check')
})

it('replays, forks and exports accepted self-check history with original evidence intact', async () => {
  const candidate = await accepted(), file = await current(), original = structuredClone(file.candidates[0]!.review)
  expect(acceptedScripts(file)[0]!.sha256).toBe(candidate.sha256)
  commands = new ProjectCommands(ctx.fs, limits, ctx.attachments)
  await run({ method: 'status', project })
  await mkdir(join(root, 'delivery'))
  const exported = await run({ method: 'export', project, candidate_id: candidate.id, directory: join(root, 'delivery') })
  expect(exported).toMatchObject({ review_kind: 'self-check' })
  const sidecar = z.object({ review: PROJECT_FILE.shape.candidates.element.shape.review }).parse(JSON.parse(await readFile(join(root, 'delivery', `episode-1-${candidate.id.slice(2)}.sources.json`), 'utf8')))
  expect(sidecar.review).toEqual(original)
  const branch = join(root, 'branch.json')
  await run({ method: 'fork_project', project, expected_revision: file.revision, destination: branch, before_episode: 2 })
  const fork = PROJECT_FILE.parse(JSON.parse(await readFile(branch, 'utf8')))
  expect(fork.revision).toBe(0); expect(fork.candidates[0]!.review).toEqual(original)
  expect(acceptedScripts(fork)[0]!.sha256).toBe(candidate.sha256)
  await run({ method: 'status', project: branch })
})

it.each(['kind', 'step', 'digest', 'actor', 'mode', 'missing'] as const)('rejects corrupted persisted self-check %s on load and accepted export', async (field) => {
  await accepted(); const file = await current(), review = file.candidates[0]!.review!
  if (field === 'kind') delete review.kind
  if (field === 'step') review.evidence!.reads[0]!.step = review.evidence!.review_step
  if (field === 'digest') review.evidence!.subject_sha256 = '0'.repeat(64)
  if (field === 'actor') review.actor = brandString<ActorId>('fake-reviewer')
  if (field === 'mode') delete file.review_mode
  if (field === 'missing') delete review.evidence
  await writeFile(project, JSON.stringify(file))
  await expect(run({ method: 'status', project })).rejects.toThrow(/invalid_(project|fact_review)/)
  expect(() => acceptedScripts(file)).toThrow(/invalid_(history|fact_review)/)
})

it('does not opt old independent projects into self-check through current configuration or model JSON', async () => {
  const file = await current(); delete file.review_mode; await writeFile(project, JSON.stringify(file))
  await propose(); step = 20; await rereadFact(); step = 30
  await expect(approveFact()).rejects.toThrow('self_review')
  const independent = new ProjectCommands(ctx.fs, limits, ctx.attachments)
  const other = join(root, 'independent.json')
  await independent.execute({ method: 'init', project: other, mode: 'faithful', instructions: '独立验收。' }, { actor, signal: new AbortController().signal })
  expect(PROJECT_FILE.parse(JSON.parse(await readFile(other, 'utf8'))).review_mode).toBeUndefined()
})

it('keeps accepted reviews readable with omitted legacy kind and rejects old own-author approval', async () => {
  const file = await current(); delete file.review_mode; await writeFile(project, JSON.stringify(file))
  const fact = await propose(), reviewer = brandString<ActorId>('independent-reviewer')
  await run({ method: 'review_fact', project, expected_revision: (await current()).revision, fact_id: fact.id, decision: 'approve', reason: '独立核对。' }, reviewer)
  const candidate = await stage()
  await run({ method: 'review', project, expected_revision: (await current()).revision, candidate_id: candidate.id,
    candidate_sha256: candidate.sha256, decision: 'approve', reason: '独立验收。' }, reviewer)
  await run({ method: 'commit', project, expected_revision: (await current()).revision, candidate_id: candidate.id, candidate_sha256: candidate.sha256 })
  const accepted = await current(); expect(accepted.candidates[0]!.review!.kind).toBeUndefined()
  expect(acceptedScripts(accepted)).toHaveLength(1)
  accepted.candidates[0]!.review!.actor = actor; await writeFile(project, JSON.stringify(accepted))
  await expect(run({ method: 'status', project })).rejects.toThrow('invalid_project')
})


it('reviews an unreviewed inherited fact in a fork using current branch revision and unchanged creation step', async () => {
  const fact = await propose(), original = project, branch = join(root, 'unreviewed-branch.json')
  await run({ method: 'fork_project', project, expected_revision: (await current()).revision, destination: branch, before_episode: 1 })
  project = branch; step = 20; await rereadFact(); step = 30; await approveFact()
  const file = await current()
  expect(file.facts[0]!.created_step).toBe(fact.created_step)
  expect(file.facts[0]!.review!.evidence).toMatchObject({ project_id: file.id, project_revision: 0 })
  await run({ method: 'status', project })
  expect(PROJECT_FILE.parse(JSON.parse(await readFile(original, 'utf8'))).facts[0]!.review).toBeUndefined()
})

it('withdraws its own self-check approval only after a new reread and later model decision, preserving the original', async () => {
  await reviewedFact(); const before = await current(), original = structuredClone(before.facts[0]!.review)
  const withdraw = () => run({ method: 'withdraw_fact', project, expected_revision: before.revision,
    fact_id: before.facts[0]!.id, reason: '原心理摘要含义过强，保留原批准记录并撤销。' })
  await expect(withdraw()).rejects.toThrow('self_check_step')
  step = 40; await expect(withdraw()).rejects.toThrow('self_check_read_required')
  await rereadFact(); await expect(withdraw()).rejects.toThrow('self_check_read_required')
  step = 50; await withdraw()
  const after = await current(), fact = after.facts[0]!
  expect(fact.review).toEqual(original)
  expect(fact.withdrawal).toMatchObject({ kind: 'self-check', actor, evidence: { creation_step: 30, review_step: 50 } })
  await run({ method: 'status', project })
  await expect(stage()).rejects.toThrow('withdrawn_fact')
  step = 60
  const unit = after.sources[0]!.units[0]!
  await run({ method: 'propose_fact', project, expected_revision: after.revision, fact: { kind: 'thought', origin: 'source', actor: '甲',
    layer: 'present', summary: '甲想到钥匙在自己手里。', anchors: [{ unit_id: unit.id, quote: unit.text }] } })
  step = 70; await run({ method: 'read_fact', project, fact_id: (await current()).facts[1]!.id })
  await run({ method: 'read_source', project, source_id: after.sources[0]!.id, start: 1, count: 1 })
  step = 80; const corrected = await current()
  await run({ method: 'review_fact', project, expected_revision: corrected.revision, fact_id: corrected.facts[1]!.id,
    decision: 'approve', reason: '读回原文后重新自检更正归属与语义。' })
  expect((await current()).facts).toHaveLength(2)
})

it('forks before a referenced erroneous fact and withdraws without changing the original accepted history', async () => {
  const candidate = await accepted(), original = project, file = await current()
  step = 70; await rereadFact(); step = 80
  await expect(run({ method: 'withdraw_fact', project, expected_revision: file.revision, fact_id: file.facts[0]!.id, reason: '需要修订。' })).rejects.toThrow('fact_in_history')
  const branch = join(root, 'repair.json')
  await run({ method: 'fork_project', project, expected_revision: file.revision, destination: branch, before_episode: 1 })
  project = branch; step = 90; await rereadFact(); step = 100
  await run({ method: 'withdraw_fact', project, expected_revision: 0, fact_id: file.facts[0]!.id, reason: '修订分支重新核对后撤销。' })
  await run({ method: 'status', project })
  expect((await current()).facts[0]!.withdrawal!.kind).toBe('self-check')
  const originalFile = PROJECT_FILE.parse(JSON.parse(await readFile(original, 'utf8')))
  expect(originalFile.facts[0]!.withdrawal).toBeUndefined()
  expect(acceptedScripts(originalFile)[0]!.sha256).toBe(candidate.sha256)
})

it('cannot downgrade old independent approval or withdrawal even inside a self-check-configured host', async () => {
  const initial = await current(); delete initial.review_mode; await writeFile(project, JSON.stringify(initial))
  const fact = await propose()
  await run({ method: 'review_fact', project, expected_revision: (await current()).revision, fact_id: fact.id,
    decision: 'approve', reason: '历史独立批准。' }, brandString<ActorId>('reviewer'))
  const file = await current(); file.review_mode = 'self-check'; await writeFile(project, JSON.stringify(file))
  step = 20; await rereadFact(); step = 30
  await expect(run({ method: 'withdraw_fact', project, expected_revision: file.revision, fact_id: fact.id, reason: '不能降低旧审批。' })).rejects.toThrow('self_review')
})

it.each(['kind', 'actor', 'step', 'digest'] as const)('rejects malformed persisted self-check withdrawal %s on load and pure replay', async (field) => {
  await reviewedFact(); step = 40; await rereadFact(); step = 50
  await run({ method: 'withdraw_fact', project, expected_revision: (await current()).revision, fact_id: (await current()).facts[0]!.id,
    reason: '保留原审校后撤销错误事实。' })
  const file = await current(), withdrawal = file.facts[0]!.withdrawal!
  if (field === 'kind') delete withdrawal.kind
  if (field === 'actor') withdrawal.actor = brandString<ActorId>('other')
  if (field === 'step') withdrawal.evidence!.creation_step = file.facts[0]!.created_step!
  if (field === 'digest') withdrawal.evidence!.subject_sha256 = '0'.repeat(64)
  await writeFile(project, JSON.stringify(file))
  await expect(run({ method: 'status', project })).rejects.toThrow('invalid_withdrawal')
  expect(() => acceptedScripts(file)).toThrow('invalid_withdrawal')
})

it('requires every declared coverage source unit rather than only the rendered fact anchor', async () => {
  await reviewedFact(); step = 40
  const file = await current()
  await run({ method: 'stage', project, expected_revision: file.revision, episode: 1,
    scenes: [{ location: '门前', time: '日', layer: 'present', transition: 'opening', characters: ['甲'],
      beats: [{ kind: 'os', actor: '甲', text: '钥匙在我手里。', fact_ids: [file.facts[0]!.id], requires_knowledge: [], witnesses: [] }] }],
    coverage: { windows: [{ source_id: file.sources[0]!.id, start: 1, count: 2 }], required_beats: [{ fact_id: file.facts[0]!.id, kind: 'os' }] } })
  step = 50; await rereadCandidate(); step = 60
  await expect(reviewCandidate()).rejects.toThrow('self_check_read_required')
  step = 70; await run({ method: 'read_source', project, source_id: file.sources[0]!.id, start: 2, count: 1 })
  step = 80; await reviewCandidate()
})

it('rereads knowledge-prerequisite facts and anchors even when the candidate does not repeat them as content', async () => {
  await accepted(); step = 70
  const file = await current(), unit = file.sources[0]!.units[1]!
  await run({ method: 'propose_fact', project, expected_revision: file.revision,
    fact: { kind: 'action', origin: 'source', actor: '甲', layer: 'present', summary: unit.text, anchors: [{ unit_id: unit.id, quote: unit.text }] } })
  const proposed = await current(), action = proposed.facts[1]!
  step = 80; await run({ method: 'read_fact', project, fact_id: action.id })
  await run({ method: 'read_source', project, source_id: file.sources[0]!.id, start: 2, count: 1 })
  step = 90; await run({ method: 'review_fact', project, expected_revision: proposed.revision, fact_id: action.id,
    decision: 'approve', reason: '当前人物推门动作与原文一致。' })
  step = 100; const approved = await current()
  await run({ method: 'stage', project, expected_revision: approved.revision, episode: 2,
    scenes: [{ location: '门前', time: '日', layer: 'present', transition: 'opening', characters: ['甲'],
      beats: [{ kind: 'action', actor: '甲', text: '甲推门。', fact_ids: [action.id], requires_knowledge: [file.facts[0]!.id], witnesses: [] }] }] })
  step = 110; const staged = await current(), candidate = staged.candidates[1]!
  const read = await run({ method: 'read_candidate', project, candidate_id: candidate.id })
  expect(read).toMatchObject({ facts: [expect.objectContaining({ id: file.facts[0]!.id }), expect.objectContaining({ id: action.id })] })
  await run({ method: 'read_source', project, source_id: file.sources[0]!.id, start: 2, count: 1 })
  step = 120; await expect(reviewCandidate()).rejects.toThrow('self_check_read_required')
})

it('rejects absent ephemeral receipts after restart until new rereads reach a subsequent step', async () => {
  await propose(); step = 20; await rereadFact()
  commands = new ProjectCommands(ctx.fs, limits, ctx.attachments, 'self-check'); receipts = []; step = 30
  await expect(approveFact()).rejects.toThrow('self_check_read_required')
  step = 40; await rereadFact(); step = 50; await approveFact()
})
