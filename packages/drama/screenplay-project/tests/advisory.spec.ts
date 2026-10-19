/** Agent-owned review choices retain real identities, source bytes and accepted version integrity. */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import { brandString } from '@deepseek-ai/dsh-brand'
import { afterEach, beforeEach, expect, it } from 'vitest'
import sharp from 'sharp'
import { ProjectCommands } from '../src/project.ts'
import type { ProjectExecution } from '../src/project.ts'
import { PROJECT_FILE } from '../src/schema.ts'
import type { ProjectRequest } from '../src/schema.ts'
import type { ActorId, FactId, UnitId } from '../src/ids.ts'
import { acceptedScripts, sha256 } from '../src/episode.ts'
import { validReview } from '../src/review.ts'
import type { ProjectReadReceipt } from '../src/review.ts'
import type { HumanAuthorization } from '../src/refinement.ts'

const actor = brandString<ActorId>('actual-writing-session')
const other = brandString<ActorId>('actual-review-session')
const limits = { maxSourceBytes: 100_000, maxProjectBytes: 1_000_000, maxReadUnits: 30, maxReadBytes: 100_000, maxFactBatch: 20 }
let root: string, project: string, source: string, ctx: Context, commands: ProjectCommands
const current = async () => PROJECT_FILE.parse(JSON.parse(await readFile(project, 'utf8')))
const run = (request: ProjectRequest, execution: Partial<ProjectExecution> = {}) => commands.execute(request, {
  actor, cwd: root, signal: new AbortController().signal, ...execution,
})

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'screenplay-advisory-'))
  project = join(root, 'project.json'); source = join(root, 'source.txt')
  ctx = new Context()
  await ctx.plugin(LocalFileSystem, { cwd: root })
  await ctx.plugin(LocalAttachmentStore, { dshHome: root })
  commands = new ProjectCommands(ctx.fs, limits, ctx.attachments, 'advisory')
  await writeFile(source, '甲想：钥匙在我手里。\n甲推门。\n')
  await run({ method: 'init', project, mode: 'faithful', instructions: '保留人物、来源与故事。' })
  await run({ method: 'import_source', project, expected_revision: 0, path: source, source_kind: 'text' })
})
afterEach(async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })

async function propose(execution: Partial<ProjectExecution> = {}) {
  const file = await current(), unit = file.sources[0]!.units[0]!
  await run({ method: 'propose_fact', project, expected_revision: file.revision,
    fact: { kind: 'thought', actor: '甲', origin: 'source', layer: 'present', summary: unit.text,
      anchors: [{ unit_id: unit.id, quote: unit.text }] } }, execution)
  return (await current()).facts.at(-1)!
}
async function stage(execution: Partial<ProjectExecution> = {}) {
  const file = await current()
  await run({ method: 'stage', project, expected_revision: file.revision, episode: file.accepted.length + 1,
    scenes: [{ location: '门前', time: '日', layer: 'present', transition: 'opening', characters: ['甲'],
      beats: [{ kind: 'os', actor: '甲', text: '钥匙在我手里。', fact_ids: [file.facts[0]!.id],
        requires_knowledge: [], witnesses: [] }] }] }, execution)
  return (await current()).candidates.at(-1)!
}
async function commit() {
  const file = await current(), candidate = file.candidates.at(-1)!
  return run({ method: 'commit', project, expected_revision: file.revision,
    candidate_id: candidate.id, candidate_sha256: candidate.sha256 })
}

it('commits, reloads and exports unreviewed work without fabricating approvals', async () => {
  const fact = await propose(), candidate = await stage()
  expect(await commit()).toMatchObject({ review_policy: 'advisory',
    review_advisory: { pending_facts: 1, pending_candidates: 1 }, next_episode: 2 })
  commands = new ProjectCommands(ctx.fs, limits, ctx.attachments, 'advisory')
  const file = await current()
  expect(file.review_mode).toBeUndefined()
  expect(file.facts[0]).toEqual(fact)
  expect(file.candidates[0]?.author).toBe(actor)
  expect(file.candidates[0]?.review).toBeUndefined()
  expect(await run({ method: 'status', project })).toMatchObject({ next_episode: 2 })
  expect(acceptedScripts(file)[0]?.script).toContain('甲（OS）：钥匙在我手里。')
  const exported = await run({ method: 'export', project, candidate_id: candidate.id, directory: join(root, 'delivery') })
  expect(exported).toMatchObject({ candidate_id: candidate.id, review_advisory: { pending_candidates: 1 } })
  expect((await current()).candidates[0]?.review).toBeUndefined()
})

it.each(['approve', 'reject'] as const)('records same-session %s advice without ordering requirements', async (decision) => {
  const fact = await propose()
  await run({ method: 'review_fact', project, expected_revision: (await current()).revision, fact_id: fact.id,
    decision, reason: '本会话自主核对原文。' })
  const candidate = await stage()
  await run({ method: 'review', project, expected_revision: (await current()).revision,
    candidate_id: candidate.id, candidate_sha256: candidate.sha256, decision, reason: '本会话自主判断版本。' })
  await commit()
  const file = await current()
  for (const review of [file.facts[0]?.review, file.candidates[0]?.review]) {
    expect(review).toMatchObject({ kind: 'advisory', actor, decision })
    expect(review?.evidence).toBeUndefined()
  }
  expect(await run({ method: 'status', project })).toMatchObject({ review_advisory: {
    pending_facts: 0, rejected_facts: decision === 'reject' ? 1 : 0,
    pending_candidates: 0, rejected_candidates: decision === 'reject' ? 1 : 0,
  } })
  expect(acceptedScripts(file)).toHaveLength(1)
})

it('keeps a real different reviewer identity without relabeling the advice independent', async () => {
  const fact = await propose()
  await run({ method: 'review_fact', project, expected_revision: (await current()).revision,
    fact_id: fact.id, decision: 'approve', reason: '另一实际会话核对。' }, { actor: other })
  expect((await current()).facts[0]?.review).toMatchObject({ actor: other, kind: 'advisory' })
})

it.each(['independent', 'self-check'] as const)('preserves historical %s evidence when enabling advisory', async (mode) => {
  const initial = await current(); delete initial.review_policy
  if (mode === 'self-check') initial.review_mode = 'self-check'
  await writeFile(project, JSON.stringify(initial))
  commands = new ProjectCommands(ctx.fs, limits, ctx.attachments, mode)
  const receipts: ProjectReadReceipt[] = []
  const fact = await propose({ step: SessionSeq(10) })
  const observe = (receipt: ProjectReadReceipt) => { receipts.push(receipt) }
  await run({ method: 'read_fact', project, fact_id: fact.id }, { step: SessionSeq(20), observeRead: observe })
  await run({ method: 'read_source', project, source_id: initial.sources[0]!.id, start: 1, count: 1 },
    { step: SessionSeq(20), observeRead: observe })
  await run({ method: 'review_fact', project, expected_revision: (await current()).revision,
    fact_id: fact.id, decision: 'approve', reason: '原始真实审校。' },
  { actor: mode === 'independent' ? other : actor, step: SessionSeq(30), receipts })
  const originalCandidate = await stage({ step: SessionSeq(40) })
  await run({ method: 'read_candidate', project, candidate_id: originalCandidate.id },
    { step: SessionSeq(50), observeRead: observe })
  await run({ method: 'read_source', project, source_id: initial.sources[0]!.id, start: 1, count: 1 },
    { step: SessionSeq(50), observeRead: observe })
  await run({ method: 'review', project, expected_revision: (await current()).revision,
    candidate_id: originalCandidate.id, candidate_sha256: originalCandidate.sha256,
    decision: 'approve', reason: '原始真实版本审校。' },
  { actor: mode === 'independent' ? other : actor, step: SessionSeq(60), receipts })
  await commit()
  const before = await current(), originalReview = structuredClone(before.facts[0]!.review)
  commands = new ProjectCommands(ctx.fs, limits, ctx.attachments, 'advisory')
  await stage(); await commit()
  const after = await current()
  expect(after.review_policy).toBe('advisory')
  expect(after.review_mode).toBe(before.review_mode)
  expect(after.facts[0]?.review).toEqual(originalReview)
  expect(after.candidates[0]).toEqual(before.candidates[0])
  expect(validReview(after, after.facts[0]!, 'fact')).toBe(true)
  commands = new ProjectCommands(ctx.fs, limits, ctx.attachments, 'advisory')
  expect(await run({ method: 'status', project })).toMatchObject({ next_episode: 3 })
  expect(acceptedScripts(after)).toHaveLength(2)
})

it('does not relax the independent default for an ordinary old project', async () => {
  const file = await current(); delete file.review_policy; await writeFile(project, JSON.stringify(file))
  commands = new ProjectCommands(ctx.fs, limits, ctx.attachments)
  const fact = await propose()
  await expect(run({ method: 'review_fact', project, expected_revision: (await current()).revision,
    fact_id: fact.id, decision: 'approve', reason: '本人意见。' })).rejects.toThrow('self_review')
  await expect(stage()).rejects.toThrow('unapproved_fact')
})

it.each(['pending', 'reject'] as const)('opens strict story history without inventing dispositions for an existing %s fact', async (decision) => {
  const video = join(root, 'original.mp4'); await writeFile(video, 'synthetic video bytes for evidence callbacks')
  const signal = new AbortController().signal
  const version = (await ctx.fs.stat(await ctx.fs.resolve(video, { signal }), signal))!.version
  const image = await ctx.attachments.saveImage({ mediaType: 'image/png', data: await sharp({ create: {
    width: 8, height: 8, channels: 3, background: 'blue' } }).png().toBuffer() })
  const manifest = { path: video, source_version: version, duration_seconds: 4, inspection: 'sampled_frames',
    verified_readback: true, interval: { start_seconds: 0, end_seconds: 4 },
    frames: [{ requested_seconds: 1, timestamp_seconds: 1, image }] }
  const manifestBytes = JSON.stringify(manifest), manifestPath = join(root, 'inspection.json')
  await writeFile(manifestPath, manifestBytes)
  const ref = { seq: SessionSeq(1), sha256: '2'.repeat(64) }
  const proof = { version: 'trusted-video-inspection-v2' as const, video_path: video, source_version: version,
    duration_seconds: 4, metadata_manifest_path: join(root, 'metadata.json'), manifest_path: manifestPath,
    metadata_manifest_sha256: '3'.repeat(64), manifest_sha256: sha256(manifestBytes),
    plan: [{ start_seconds: 0, end_seconds: 4 }], windows: [{ start_seconds: 0, end_seconds: 4,
      sample_requested_seconds: [1], decoded_pts_seconds: [1], frames: manifest.frames }], model_input_step: SessionSeq(2),
    unresolved: [], evidence: { session_id: SessionId(actor), metadata_result: ref, metadata_root_result: ref,
      sample_result: ref, sample_root_result: ref, metadata_ancestors: [], sample_ancestors: [],
      model_response: ref, model_input_sha256: '4'.repeat(64) } }
  const grant: HumanAuthorization = { source: 'user', session_id: actor, message_id: 'actual-story-request', seq: SessionSeq(1),
    message_sha256: '1'.repeat(64), quote: '将本视频写成故事忠实剧本。', consent_assessment: '授权本作品的来源忠实创作。' }
  const receipts: ProjectReadReceipt[] = []
  let step = 10
  const execute = (request: ProjectRequest) => run(request, { step: SessionSeq(step), receipts,
    observeRead: receipt => receipts.push(receipt), authorization: grant, latestUserSeq: SessionSeq(1),
    verifyStoryVideo: async () => proof, verifyStoryApproval: async () => {} })
  const readSources = async () => {
    const file = await current()
    await execute({ method: 'list_facts', project, start: 1, count: 30 })
    for (const source of file.sources) await execute({ method: 'read_source', project,
      source_id: source.id, start: 1, count: source.units.length })
  }
  project = join(root, 'strict-story.json')
  commands = new ProjectCommands(ctx.fs, limits, ctx.attachments, 'self-check', 'disabled', 'story-faithful-v2')
  await execute({ method: 'init_story_faithful', project, work_title: '门前',
    videos: [{ path: video, source_version: version, episode: 1 }], episodes: [1], scope_instructions: '保留来源故事。',
    authorization_quote: grant.quote, consent_assessment: grant.consent_assessment, allowed_categories: ['minimal_os'] })
  await execute({ method: 'import_source', project, expected_revision: 0, path: source, source_kind: 'text', story_video_path: video })
  await execute({ method: 'import_source', project, expected_revision: 1, path: manifestPath, source_kind: 'video_inspection' })
  const main = await propose({ step: SessionSeq(step) })
  const extra = await propose({ step: SessionSeq(step) })
  step = 20; await readSources(); step = 30
  await execute({ method: 'review_facts', project, expected_revision: (await current()).revision,
    reviews: [{ fact_id: main.id, decision: 'approve', reason: '实际复读后批准原心理。' },
      ...(decision === 'reject' ? [{ fact_id: extra.id, decision: 'reject' as const, reason: '重复解释，不用于成稿。' }] : [])] })
  const file = await current(), unit = file.sources[0]!.units[0]!
  const coverage = { windows: file.sources.map(value => ({ source_id: value.id, start: 1, count: value.units.length })),
    required_beats: [{ fact_id: main.id, kind: 'os' as const }] }
  step = 40
  await execute({ method: 'propose_story_inventory', project, expected_revision: file.revision, episode: 1, coverage,
    items: [{ id: 'thought', dimension: 'emotion_conflict', summary: '甲保留钥匙的心理。', critical: false,
      evidence: 'confirmed', fact_ids: [main.id], source_units: [unit.id], depends_on: [], knowledge: [] }],
    not_applicable: (['event', 'action_result', 'relationship_stance', 'causality_reveal'] as const)
      .map(dimension => ({ dimension, reason: '来源没有此项故事变化。' })) })
  const inventory = (await current()).story_inventories![0]!
  step = 50
  await execute({ method: 'read_story_inventory', project, inventory_id: inventory.id }); await readSources()
  step = 60
  await execute({ method: 'review_story_inventory', project, expected_revision: (await current()).revision,
    inventory_id: inventory.id, inventory_sha256: inventory.sha256, decision: 'approve', reason: '实际复读清单与本集来源。' })
  const location = { scene: 1, beat: 1, text: '钥匙在我手里。' }
  step = 70
  await execute({ method: 'stage', project, expected_revision: (await current()).revision, episode: 1, coverage,
    scenes: [{ location: '门前', time: '日', layer: 'present', transition: 'opening', characters: ['甲'],
      beats: [{ kind: 'os', actor: '甲', text: location.text, fact_ids: [main.id], requires_knowledge: [], witnesses: [] }] }],
    story_notes: { inventory_id: inventory.id, mapping: [{ item_id: 'thought', outputs: [location] }],
      dispositions: [{ fact_id: main.id, disposition: 'retained', reason: '原心理保留。' }],
      changes: [{ source: { unit_id: unit.id, fact_id: main.id }, after: location, reason: '按来源呈现心理。' }],
      scene_changes: [{ scene: 1, reason: '按来源场次安排。' }], editor_comments: [], unresolved: [] } })
  const candidate = (await current()).candidates[0]!
  step = 80
  await execute({ method: 'read_candidate', project, candidate_id: candidate.id }); await readSources()
  step = 90
  await execute({ method: 'review', project, expected_revision: (await current()).revision, candidate_id: candidate.id,
    candidate_sha256: candidate.sha256, decision: 'approve', reason: '实际复读成稿后保留来源意义。',
    zero_action_reason: '合成来源没有本集关键行动，只有心理。', semantic_report: {
      event_chain: '甲独自保留钥匙。', emotion_conflict: '甲保留原心理。', relationship_stance: '关系未改变。',
      causality_reveal: '未改变知情或揭晓。', checks: [{ item_id: 'thought', status: 'preserved',
        explanation: '心理保持。', source_units: [unit.id], outputs: [location] }], deviations: [], unverified: [] } })
  step = 100
  await execute({ method: 'commit', project, expected_revision: (await current()).revision,
    candidate_id: candidate.id, candidate_sha256: candidate.sha256 })
  const originalBytes = await readFile(project, 'utf8'), original = await current(), originalScript = acceptedScripts(original)[0]!
  expect(original.review_policy).toBeUndefined()
  expect(original.candidates[0]?.review?.kind).toBe('self-check')
  expect(original.candidates[0]?.story_adaptation?.notes.dispositions.map(value => value.fact_id)).toEqual([main.id])
  expect(original.facts[1]?.review?.decision).toBe(decision === 'reject' ? 'reject' : undefined)
  commands = new ProjectCommands(ctx.fs, limits, ctx.attachments, 'advisory', 'disabled', 'story-faithful-v2')
  expect(await execute({ method: 'status', project })).toMatchObject({ review_policy: 'advisory', next_episode: 2 })
  await execute({ method: 'export', project, candidate_id: candidate.id, directory: join(root, 'old-story-delivery') })
  expect(await readFile(project, 'utf8')).toBe(originalBytes)
  expect(acceptedScripts(await current())[0]).toEqual(originalScript)
  expect(await readFile(join(root, 'old-story-delivery', `episode-1-${candidate.id.slice(2)}.md`), 'utf8')).toBe(originalScript.script)
})

it.each(['source', 'digest', 'revision', 'reference'] as const)('still refuses actual %s inconsistency', async (failure) => {
  await propose(); await stage()
  if (failure === 'source') await writeFile(source, 'different original bytes')
  if (failure === 'digest') {
    const file = await current(); file.candidates[0]!.scenes[0]!.beats[0]!.text = 'changed without a new digest'
    await writeFile(project, JSON.stringify(file))
  }
  if (failure === 'revision') {
    const file = await current(), candidate = file.candidates[0]!
    await expect(run({ method: 'commit', project, expected_revision: file.revision - 1,
      candidate_id: candidate.id, candidate_sha256: candidate.sha256 })).rejects.toThrow('stale_revision')
    return
  }
  if (failure === 'reference') {
    const file = await current(); file.facts[0]!.anchors[0]!.unit_id = brandString<UnitId>('missing-unit')
    await writeFile(project, JSON.stringify(file))
  }
  await expect(commit()).rejects.toThrow(failure === 'source' ? 'source_changed'
    : failure === 'digest' ? 'invalid_candidate_digest' : 'source_quote_mismatch')
  expect((await current()).accepted).toEqual([])
})

it.each([false, true])('lets authorized story creation choose optional notes=%s without approval gates', async (notes) => {
  const video = join(root, 'original.mp4'); await writeFile(video, 'actual unit-test file')
  const signal = new AbortController().signal
  const version = (await ctx.fs.stat(await ctx.fs.resolve(video, { signal }), signal))!.version
  const grant: HumanAuthorization = { source: 'user', session_id: actor, message_id: 'actual-user-request', seq: SessionSeq(1),
    message_sha256: '1'.repeat(64), quote: '将本视频写成故事忠实剧本。', consent_assessment: '用户授权当前作品常规表达。' }
  commands = new ProjectCommands(ctx.fs, limits, ctx.attachments, 'advisory', 'disabled', 'story-faithful-v2')
  project = join(root, 'story.json')
  const request: ProjectRequest = { method: 'init_story_faithful', project, work_title: '门前',
    videos: [{ path: video, source_version: version, episode: 1 }], episodes: [1],
    scope_instructions: '保留来源故事。', authorization_quote: grant.quote, consent_assessment: grant.consent_assessment,
    allowed_categories: ['minimal_os'] }
  await expect(run(request)).rejects.toThrow()
  await expect(run(request, { authorization: { ...grant, quote: 'another request' }, latestUserSeq: SessionSeq(1) }))
    .rejects.toThrow('story_human_authorization')
  await run(request, { authorization: grant, latestUserSeq: SessionSeq(1) })
  await run({ method: 'import_source', project, expected_revision: 0, path: source, source_kind: 'text', story_video_path: video })
  const fact = await propose()
  let candidate
  if (!notes) candidate = await stage()
  else {
    const file = await current(), unit = file.sources[0]!.units[0]!
    const coverage = { windows: [{ source_id: file.sources[0]!.id, start: 1, count: 1 }],
      required_beats: [{ fact_id: fact.id, kind: 'os' as const }] }
    await run({ method: 'propose_story_inventory', project, expected_revision: file.revision, episode: 1, coverage,
      items: [{ id: 'thought', dimension: 'emotion_conflict', summary: '保留甲的心理。', critical: false,
        evidence: 'unverified', fact_ids: [fact.id], source_units: [unit.id], depends_on: [], knowledge: [] }],
      not_applicable: (['event', 'action_result', 'relationship_stance', 'causality_reveal'] as const)
        .map(dimension => ({ dimension, reason: '这个来源片段未涉及此项。' })) })
    const inventory = (await current()).story_inventories![0]!
    await run({ method: 'review_story_inventory', project, expected_revision: (await current()).revision,
      inventory_id: inventory.id, inventory_sha256: inventory.sha256, decision: 'reject', reason: '保留待核意见，自主继续成稿。' })
    const location = { scene: 1, beat: 1, text: '钥匙在我手里。' }
    const request: Extract<ProjectRequest, { method: 'stage' }> = { method: 'stage', project,
      expected_revision: (await current()).revision, episode: 1, coverage,
      scenes: [{ location: '门前', time: '日', layer: 'present', transition: 'opening', characters: ['甲'],
        beats: [{ kind: 'os', actor: '甲', text: location.text, fact_ids: [fact.id], requires_knowledge: [], witnesses: [] }] }],
      story_notes: { inventory_id: inventory.id, mapping: [{ item_id: 'thought', outputs: [location] }],
        dispositions: [{ fact_id: fact.id, disposition: 'retained', reason: '按实际来源保留。' }],
        changes: [{ source: { unit_id: unit.id, fact_id: fact.id }, after: location, reason: '使用来源心理。' }],
        scene_changes: [{ scene: 1, reason: '本集按来源位置安排。' }], editor_comments: [], unresolved: [] } }
    const before = await readFile(project, 'utf8'), disposition = request.story_notes!.dispositions[0]!
    for (const dispositions of [[disposition, disposition], [{ ...disposition, fact_id: brandString<FactId>('f:missing') }]]) {
      await expect(run({ ...request, story_notes: { ...request.story_notes!, dispositions } }))
        .rejects.toThrow('story_source_disposition')
      expect(await readFile(project, 'utf8')).toBe(before)
    }
    await run(request)
    candidate = (await current()).candidates[0]!
    await run({ method: 'review', project, expected_revision: (await current()).revision,
      candidate_id: candidate.id, candidate_sha256: candidate.sha256, decision: 'approve', reason: '自主意见，无固定C轮或零动作说明。' })
  }
  await commit()
  expect((await current()).story_policy?.authorization).toEqual(grant)
  expect((await current()).review_mode).toBeUndefined()
  if (!notes) {
    expect((await current()).story_inventories).toEqual([])
    expect((await current()).candidates[0]?.story_adaptation).toBeUndefined()
  } else {
    expect((await current()).story_inventories?.[0]?.review).toMatchObject({ kind: 'advisory', actor, decision: 'reject' })
    expect((await current()).candidates[0]?.review).toMatchObject({ kind: 'advisory', actor, decision: 'approve' })
    expect((await current()).candidates[0]?.review?.semantic_report).toBeUndefined()
  }
  expect(acceptedScripts(await current())).toHaveLength(1)
  await run({ method: 'export', project, candidate_id: candidate.id, directory: join(root, 'story-delivery') })
  await writeFile(video, 'changed original video bytes after adoption')
  await expect(run({ method: 'status', project })).rejects.toThrow('story_video_version')
})
