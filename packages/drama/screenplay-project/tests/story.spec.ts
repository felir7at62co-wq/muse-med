/** Synthetic original scenes exercise story declarations; trusted callbacks are test doubles, not media verification. */
import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import { FsVersion } from '@deepseek-ai/dsh-fs'
import { SessionSeq, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { brandString } from '@deepseek-ai/dsh-brand'
import sharp from 'sharp'
import { createToolResultMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { ProjectCommands } from '../src/project.ts'
import { PROJECT_FILE, STORY_NOTES, SEMANTIC_INPUT, REQUEST_STORY, VIDEO_INSPECTION } from '../src/schema.ts'
import type { ProjectFile, ProjectRequest } from '../src/schema.ts'
import type { ProjectReadReceipt } from '../src/review.ts'
import { acceptedScripts, acceptedKnowledge, renderEpisode, sha256 } from '../src/episode.ts'
import { validateAcceptedStoryEvidence, validateStoryApprovalLog, validateStoryPolicy, storyPolicyDigest, validateInventory, inventoryDigest, storyScopeDigest } from '../src/story.ts'
import type { ActorId, FactId, UnitId } from '../src/ids.ts'
import type { HumanAuthorization } from '../src/refinement.ts'
import { stageScenes, stageCoverage, stageStoryNotes } from './fixtures/stage-input.ts'

const actor = brandString<ActorId>('story-test-session')
const limits = { maxSourceBytes: 100_000, maxProjectBytes: 1_000_000, maxReadUnits: 30, maxReadBytes: 100_000, maxFactBatch: 20 }
let root: string, project: string, ctx: Context, commands: ProjectCommands, step: number, receipts: ProjectReadReceipt[]
let grant: HumanAuthorization
let verifyCount: number
let proof: ProjectFile['sources'][number]['trusted_video_receipt']
const current = async () => PROJECT_FILE.parse(JSON.parse(await readFile(project, 'utf8')))
const run = (request: ProjectRequest, options: { proof?: boolean; approval?: boolean; latest?: number } = {}) => commands.execute(request, {
  actor, signal: new AbortController().signal, step: SessionSeq(step), receipts, observeRead: receipt => receipts.push(receipt),
  authorization: grant, latestUserSeq: SessionSeq(options.latest ?? 1),
  ...(options.proof === false ? {} : { verifyStoryVideo: async () => { verifyCount++; return proof } }),
  ...(options.approval === false ? {} : { verifyStoryApproval: async () => {} }),
})
async function initialize(episodes = [1, 2]) {
  const video = join(root, 'original.mp4'), version = (await ctx.fs.stat(await ctx.fs.resolve(video, { signal: new AbortController().signal }), new AbortController().signal))!.version
  await run({ method: 'init_story_faithful', project, work_title: '门前的选择', videos: [{ path: video, source_version: version, episode: 1 }], episodes,
    scope_instructions: '保留离开的立场、推门行动结果和知情因果，允许情绪/口语/反应表达。', authorization_quote: grant.quote,
    consent_assessment: grant.consent_assessment, allowed_categories: ['performance_detail', 'minimal_os', 'supporting_dialogue'] })
  await run({ method: 'import_source', project, expected_revision: 0, path: join(root, 'source.txt'), source_kind: 'text', story_video_path: video })
  await run({ method: 'import_source', project, expected_revision: 1, path: join(root, 'inspection.json'), source_kind: 'video_inspection' })
}
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'story-faithful-'))); project = join(root, 'project.json')
  ctx = new Context(); await ctx.plugin(LocalFileSystem, { cwd: root }); await ctx.plugin(LocalAttachmentStore, { dshHome: root })
  commands = new ProjectCommands(ctx.fs, limits, ctx.attachments, 'self-check', 'disabled', 'story-faithful-v2')
  step = 10; receipts = []; verifyCount = 0
  grant = { source: 'user', session_id: actor, message_id: 'user-work-request', seq: SessionSeq(1), message_sha256: '1'.repeat(64),
    quote: '将这个视频写成故事忠实剧本，允许表演细节、短OS和承接对白。', consent_assessment: '用户授权本作品常规表达强化，关键事件与关系不变。' }
  await writeFile(join(root, 'original.mp4'), 'synthetic media bytes for callback-only unit tests')
  await writeFile(join(root, 'source.txt'), '甲说：你走吧。\n作者：甲克制地拒绝乙，内心紧绷。')
  const version = (await ctx.fs.stat(await ctx.fs.resolve(join(root, 'original.mp4'), { signal: new AbortController().signal }), new AbortController().signal))!.version
  const image = await ctx.attachments.saveImage({ mediaType: 'image/png', data: await sharp({ create: { width: 8, height: 8, channels: 3, background: 'blue' } }).png().toBuffer() })
  const manifest = { path: join(root, 'original.mp4'), source_version: version, duration_seconds: 4, inspection: 'sampled_frames', verified_readback: true,
    interval: { start_seconds: 0, end_seconds: 4 }, frames: [{ requested_seconds: 1, timestamp_seconds: 1, image }] }
  const bytes = JSON.stringify(manifest); await writeFile(join(root, 'inspection.json'), bytes)
  const ref = { seq: SessionSeq(1), sha256: '2'.repeat(64) }
  proof = { version: 'trusted-video-inspection-v2', video_path: manifest.path, source_version: version, duration_seconds: 4,
    metadata_manifest_path: join(root, 'metadata.json'), manifest_path: join(root, 'inspection.json'), metadata_manifest_sha256: '3'.repeat(64), manifest_sha256: sha256(bytes),
    plan: [{ start_seconds: 0, end_seconds: 4 }], windows: [{ start_seconds: 0, end_seconds: 4, sample_requested_seconds: [1],
      decoded_pts_seconds: [1], frames: manifest.frames }],
    model_input_step: SessionSeq(2), unresolved: [], evidence: { session_id: SessionId('story-test-session'), metadata_result: ref, metadata_root_result: ref,
      sample_result: ref, sample_root_result: ref, metadata_ancestors: [], sample_ancestors: [], model_response: ref, model_input_sha256: '4'.repeat(64) } }
})
afterEach(async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
async function sourcesAndFacts(inheritedSpeech = false, existingProject = inheritedSpeech) {
  if (!existingProject) await initialize()
  const file = await current(), speech = file.sources[0]!.units[0]!, analysis = file.sources[0]!.units[1]!,
    image = file.sources[1]!.units[0]!
  await run({ method: 'propose_facts', project, expected_revision: file.revision, facts: [
    ...(inheritedSpeech ? [] : [{ actor: '甲', kind: 'speech' as const, origin: 'source' as const, layer: 'present' as const, summary: '甲拒绝乙并让乙离开。', anchors: [{ unit_id: speech.id, quote: speech.text }] }]),
    { kind: 'author_analysis', origin: 'source', layer: 'commentary', summary: '甲内心紧绷仍保持拒绝立场。', anchors: [{ unit_id: analysis.id, quote: analysis.text }] },
    { actor: '甲', kind: 'action', origin: 'source', layer: 'present', summary: '甲推门后门打开。', anchors: [{ unit_id: image.id, quote: image.text }] },
  ] })
  step = 20; await readAll(); step = 30
  const proposed = await current()
  await run({ method: 'review_facts', project, expected_revision: proposed.revision, reviews: proposed.facts.filter(fact => fact.review === undefined).map(fact => ({ fact_id: fact.id, decision: 'approve', reason: '来源归属与实际该项证据已在前一模型轮重读。' })) })
  const approved = await current()
  step = 40
  await run({ method: 'propose_fact', project, expected_revision: approved.revision, fact: {
    actor: '甲', kind: 'thought', origin: 'adaptation', layer: 'present', summary: '甲心中：我不能心软。', anchors: [{ unit_id: analysis.id, quote: analysis.text }],
    adaptation_reason: '把来源作者分析的紧绷拒绝表现为本人短OS，立场与后果不变；没有冒称原声。',
    story_supplement: { category: 'minimal_os', policy_sha256: approved.story_policy!.sha256, authorization_sha256: sha256(JSON.stringify(approved.story_policy!.authorization)) },
  } })
  step = 50; await readAll(); step = 60
  const os = (await current()).facts.at(-1)!
  await run({ method: 'review_fact', project, expected_revision: (await current()).revision, fact_id: os.id, decision: 'approve', reason: '本人OS为已获准演绎，作者分析原件保留，非原声。' })
}
async function readAll() {
  const file = await current()
  await run({ method: 'list_facts', project, start: 1, count: 30 })
  for (const source of file.sources) await run({ method: 'read_source', project, source_id: source.id, start: 1, count: source.units.length })
}
async function inventory(unknown = false) {
  const file = await current(), [speech, analysis, action] = file.facts
  step = 70
  await run({ method: 'propose_story_inventory', project, expected_revision: file.revision, episode: file.accepted.length + 1,
    coverage: { windows: file.sources.map(source => ({ source_id: source.id, start: 1, count: source.units.length })), required_beats: [{ fact_id: action!.id, kind: 'action' }] }, not_applicable: [],
    items: [
      { id: 'refusal', dimension: 'event', summary: '甲让乙离开，仍拒绝乙。', critical: true, evidence: 'confirmed', fact_ids: [speech!.id], source_units: [speech!.anchors[0]!.unit_id], depends_on: [], knowledge: [{ fact_id: speech!.id, actor: '甲', recipients: ['乙'] }] },
      { id: 'door', dimension: 'action_result', summary: '甲推门并打开门。', critical: true, evidence: unknown ? 'unverified' : 'confirmed', fact_ids: [action!.id], source_units: [action!.anchors[0]!.unit_id], depends_on: ['refusal'], knowledge: [] },
      { id: 'tension', dimension: 'emotion_conflict', summary: '内心紧绷但克制拒绝。', critical: false, evidence: 'confirmed', fact_ids: [analysis!.id], source_units: [analysis!.anchors[0]!.unit_id], depends_on: [], knowledge: [] },
      { id: 'stance', dimension: 'relationship_stance', summary: '拒绝并让乙离开，没有变成友好邀请。', critical: true, evidence: 'confirmed', fact_ids: [speech!.id], source_units: [speech!.anchors[0]!.unit_id], depends_on: [], knowledge: [] },
      { id: 'cause', dimension: 'causality_reveal', summary: '拒绝先于开门让乙离开，无新揭晓。', critical: true, evidence: 'confirmed', fact_ids: [speech!.id, action!.id], source_units: [speech!.anchors[0]!.unit_id, action!.anchors[0]!.unit_id], depends_on: ['refusal'], knowledge: [] },
    ] })
  return (await current()).story_inventories!.at(-1)!
}
async function reviewedInventory() {
  const item = await inventory(); step = 80
  await run({ method: 'read_story_inventory', project, inventory_id: item.id }); await readAll(); step = 90
  await run({ method: 'review_story_inventory', project, expected_revision: (await current()).revision, inventory_id: item.id, inventory_sha256: item.sha256, decision: 'approve', reason: '五维及来源、动作、关系和实际听者已在前轮复读核对。' })
}
async function draft() {
  const file = await current(), [speech, analysis, action, os] = file.facts, item = file.story_inventories!.at(-1)!
  const scenes: ProjectFile['candidates'][number]['scenes'] = [
    { location: '门前', time: '日', layer: 'present' as const, transition: 'opening' as const, characters: ['甲', '乙'], beats: [
      { kind: 'dialogue' as const, actor: '甲', text: '走吧！我说过，你走吧。', fact_ids: [speech!.id], requires_knowledge: [], witnesses: ['乙'] },
      { kind: 'os' as const, actor: '甲', text: '我不能心软。', fact_ids: [os!.id], requires_knowledge: [], witnesses: [] },
    ] },
    { location: '门前', time: '日', layer: 'present' as const, transition: 'cut' as const, characters: ['甲', '乙'], beats: [
      { kind: 'action' as const, actor: '甲', text: '甲推开门，门应声打开。', fact_ids: [action!.id], requires_knowledge: [], witnesses: ['乙'] },
    ] },
  ]
  const position = (scene: number, beat: number) => ({ scene, beat, text: scenes[scene - 1]!.beats[beat - 1]!.text })
  const notes = STORY_NOTES.parse({ inventory_id: item.id, mapping: [
    { item_id: 'refusal', outputs: [position(1, 1)] }, { item_id: 'door', outputs: [position(2, 1)] },
    { item_id: 'tension', outputs: [position(1, 2)] }, { item_id: 'stance', outputs: [position(1, 1)] },
    { item_id: 'cause', outputs: [position(1, 1), position(2, 1)] },
  ], dispositions: [ { fact_id: speech!.id, disposition: 'retained', reason: '口语化加强拒绝，原发声立场保留。' },
    { fact_id: analysis!.id, disposition: 'merged', reason: '作者分析原件保留，另建授权本人OS表现，不强迫朗读VO。' },
    { fact_id: action!.id, disposition: 'retained', reason: '原推门动作结果保持。' } ], changes: [
    { source: { unit_id: speech!.anchors[0]!.unit_id, fact_id: speech!.id }, after: position(1, 1), reason: '情绪和口语强化。' },
    { source: { unit_id: analysis!.anchors[0]!.unit_id, fact_id: analysis!.id }, after: position(1, 2), reason: '授权OS表达紧绷拒绝。' },
    { source: { unit_id: action!.anchors[0]!.unit_id, fact_id: action!.id }, after: position(2, 1), reason: '拆场强调可拍行动结果。' },
  ], scene_changes: [{ scene: 1, reason: '对话近景与内心反应。' }, { scene: 2, reason: '单独镜头强调开门行动。' }],
  editor_comments: [{ comment: '拒绝情绪更强，仍然让乙离开。', disposition: 'adopted', reason: '口语化保留原立场。', change_indices: [1] }], unresolved: [] })
  return { file, item, scenes, notes }
}
async function stage() {
  const { file, item, scenes, notes } = await draft(); step = 100
  await run({ method: 'stage', project, expected_revision: file.revision, episode: file.accepted.length + 1, scenes: stageScenes(scenes), coverage: stageCoverage(item.coverage), story_notes: stageStoryNotes(notes) })
  return (await current()).candidates.at(-1)!
}
async function rereadCandidate() {
  const file = await current(), candidate = file.candidates.at(-1)!; step = 110
  await run({ method: 'read_candidate', project, candidate_id: candidate.id }); await readAll()
}
async function report() {
  const file = await current(), candidate = file.candidates.at(-1)!, item = file.story_inventories!.at(-1)!
  return SEMANTIC_INPUT.parse({ event_chain: '甲让乙离开后推开门。', emotion_conflict: '紧绷拒绝通过强化对白与授权OS表达。', relationship_stance: '拒绝立场不变。', causality_reveal: '先拒绝再开门，未改知情与揭晓。',
    checks: item.items.map(value => ({ item_id: value.id, status: 'preserved', explanation: value.summary, source_units: value.source_units,
      outputs: candidate.story_adaptation!.notes.mapping.find(mapping => mapping.item_id === value.id)!.outputs })),
    deviations: [], unverified: [] })
}
async function approveCandidate(input?: Awaited<ReturnType<typeof report>>) {
  input ??= await report()
  const file = await current(), candidate = file.candidates.at(-1)!; step = 120
  return run({ method: 'review', project, expected_revision: file.revision, candidate_id: candidate.id, candidate_sha256: candidate.sha256,
    decision: 'approve', reason: '真实B轮完整重读后，C轮核对故事关系、结果、情绪、因果和知情。', semantic_report: input })
}
async function ready() { await sourcesAndFacts(); await reviewedInventory(); await stage(); await rereadCandidate() }
async function accepted() {
  await ready(); await approveCandidate(); const file = await current(), candidate = file.candidates.at(-1)!
  await run({ method: 'commit', project, expected_revision: file.revision, candidate_id: candidate.id, candidate_sha256: candidate.sha256 })
  return candidate
}
it('creates directly from sources, strengthens dialogue and authorized OS, restructures scenes and keeps originals unchanged', async () => {
  const original = await readFile(join(root, 'source.txt'), 'utf8'); const candidate = await accepted(), file = await current()
  expect(await run({ method: 'status', project })).toHaveProperty('story_policy.authorization_sha256', sha256(JSON.stringify(file.story_policy!.authorization)))
  expect(file.candidates).toHaveLength(1); expect(file.facts[1]!.kind).toBe('author_analysis'); expect(file.facts[1]!.origin).toBe('source')
  expect(file.facts[3]!.origin).toBe('adaptation'); expect(candidate.story_adaptation!.input_candidate_json).toBeUndefined()
  expect(candidate.story_adaptation!.notes.changes.every(change => change.before === undefined)).toBe(true)
  expect(await readFile(join(root, 'source.txt'), 'utf8')).toBe(original)
  const output = acceptedScripts(file)[0]!
  expect(output.script).toContain('甲：走吧！我说过，你走吧。'); expect(output.script).toContain('甲（OS）：我不能心软。')
  expect(output.modification_notes).toContain('没有逐字剧本基线'); expect(output.modification_notes).toContain('minimal_os')
  expect(output.script).not.toContain('策略：'); expect(acceptedKnowledge(file)['present:乙']).not.toContain(file.facts[3]!.id)
  await mkdir(join(root, 'delivery')); await run({ method: 'export', project, candidate_id: candidate.id, directory: join(root, 'delivery') })
  expect(await readFile(join(root, 'delivery', `episode-1-${candidate.id.slice(2)}.md`), 'utf8')).toBe(output.script)
  expect(verifyCount).toBeGreaterThan(1)
})
it('matches a sampled video alias to the canonical authorized file without rewriting its receipt', async () => {
  const alias = join(root, 'linked-original.mp4')
  await symlink(join(root, 'original.mp4'), alias)
  const manifest = VIDEO_INSPECTION.parse(JSON.parse(await readFile(join(root, 'inspection.json'), 'utf8')))
  manifest.path = alias
  const bytes = JSON.stringify(manifest)
  await writeFile(join(root, 'inspection.json'), bytes)
  proof = { ...proof!, video_path: alias, manifest_sha256: sha256(bytes) }
  await initialize()
  const file = await current()
  expect(file.sources[1]!.video!.path).toBe(alias)
  expect(file.sources[1]!.story_video_path).toBe(join(root, 'original.mp4'))
  expect(file.sources[1]!.trusted_video_receipt!.video_path).toBe(alias)
  await sourcesAndFacts(false, true)
  await inventory()
  expect(await run({ method: 'status', project })).toMatchObject({ evidence_pending: [] })
})
it('restores saved observation receipts for an unaccepted episode and still propagates invalid evidence', async () => {
  await sourcesAndFacts(); await inventory()
  const saved = (await current()).sources[1]!.trusted_video_receipt
  const verifyStoryVideo = async (_manifest: unknown, receipt: unknown) => {
    expect(receipt).toEqual(saved)
    return saved
  }
  expect(await commands.execute({ method: 'status', project }, { actor, signal: new AbortController().signal, verifyStoryVideo }))
    .toMatchObject({ evidence_pending: [] })
  await expect(commands.execute({ method: 'status', project }, { actor, signal: new AbortController().signal,
    verifyStoryVideo: async () => { throw Error('Original Session log is missing') } })).rejects.toThrow('Original Session log is missing')
})
it('defaults disabled and requires the latest actual Host user grant and original video version', async () => {
  commands = new ProjectCommands(ctx.fs, limits, ctx.attachments, 'self-check')
  await expect(initialize()).rejects.toThrow('story_mode_disabled')
  commands = new ProjectCommands(ctx.fs, limits, ctx.attachments, 'self-check', 'disabled', 'story-faithful-v2')
  grant.seq = SessionSeq(0); await expect(initialize()).rejects.toThrow('story_human_authorization')
})
it('does not treat a self-written verified manifest as actual inspection', async () => {
  await initialize(); const file = await current(); expect(file.sources[1]!.trusted_video_receipt!.version).toBe('trusted-video-inspection-v2')
  const destination = join(root, 'unverified.json'); project = destination
  const video = join(root, 'original.mp4'), version = (await ctx.fs.stat(await ctx.fs.resolve(video, { signal: new AbortController().signal }), new AbortController().signal))!.version
  await run({ method: 'init_story_faithful', project, work_title: '另一次', videos: [{ path: video, source_version: version }], episodes: [1], scope_instructions: '同原视频。', authorization_quote: grant.quote, consent_assessment: grant.consent_assessment, allowed_categories: [] })
  await expect(run({ method: 'import_source', project, expected_revision: 0, path: join(root, 'inspection.json'), source_kind: 'video_inspection' }, { proof: false })).rejects.toThrow('story_video_evidence_pending')
  expect((await current()).sources).toHaveLength(0)
})
it('rejects same-round inventory approval and key unknowns while preserving resumable inventory state', async () => {
  await sourcesAndFacts(); const item = await inventory(); await run({ method: 'read_story_inventory', project, inventory_id: item.id }); await readAll()
  await expect(run({ method: 'review_story_inventory', project, expected_revision: (await current()).revision, inventory_id: item.id, inventory_sha256: item.sha256, decision: 'approve', reason: '同轮不能批准。' })).rejects.toThrow('self_check_step')
  step = 80; await expect(run({ method: 'review_story_inventory', project, expected_revision: (await current()).revision, inventory_id: item.id, inventory_sha256: item.sha256, decision: 'approve', reason: '之前同轮reads不算。' })).rejects.toThrow('self_check_read_required')
  const unknown = await inventory(true)
  await expect(run({ method: 'review_story_inventory', project, expected_revision: (await current()).revision, inventory_id: unknown.id, inventory_sha256: unknown.sha256, decision: 'approve', reason: '不能自填关键verified。' })).rejects.toThrow('story_evidence_pending')
  expect((await current()).story_inventories!.at(-1)!.review).toBeUndefined()
})
it.each(['deviation', 'unverified'] as const)('refuses declared relationship/condition/causality %s in the real C report', async (status) => {
  await ready(); const input = await report(); input.checks[3]!.status = status
  if (status === 'deviation') input.deviations.push('拒绝改成好友邀请，属于新关系方案。'); else input.unverified.push('条件是否保持尚未核实。')
  await expect(approveCandidate(input)).rejects.toThrow('story_semantic_deviation')
  expect((await current()).candidates[0]!.review).toBeUndefined()
})
it.each(['missing', 'unrelated', 'actor', 'os_listener', 'cause_order', 'before', 'comments'] as const)('refuses mechanically invalid story mapping or preservation: %s', async (variant) => {
  await sourcesAndFacts(); await reviewedInventory(); const { file, item, scenes, notes } = await draft()
  if (variant === 'missing') notes.mapping.pop()
  if (variant === 'unrelated') notes.mapping.find(value => value.item_id === 'door')!.outputs = [{ scene: 1, beat: 1, text: scenes[0]!.beats[0]!.text }]
  if (variant === 'actor') scenes[1]!.beats[0]!.actor = '乙'
  if (variant === 'os_listener') { scenes[0]!.beats[1]!.witnesses = ['乙'] }
  if (variant === 'cause_order') { scenes[0]!.beats.unshift(scenes[1]!.beats[0]!); scenes[1]!.beats.pop() }
  if (variant === 'before') notes.changes[0]!.before = notes.changes[0]!.after
  if (variant === 'comments') notes.editor_comments[0]!.change_indices = [30]
  await expect(run({ method: 'stage', project, expected_revision: file.revision, episode: 1, scenes: stageScenes(scenes), coverage: stageCoverage(item.coverage), story_notes: stageStoryNotes(notes) })).rejects.toThrow(/story_|private_knowledge|empty_scene/)
})
it('requires B receipts again after cold restart and refuses direct commit/export without the actual C-log callback', async () => {
  await ready(); receipts = []; commands = new ProjectCommands(ctx.fs, limits, ctx.attachments, 'self-check', 'disabled', 'story-faithful-v2')
  await expect(approveCandidate()).rejects.toThrow('self_check_read_required')
  await rereadCandidate(); await approveCandidate(); const file = await current(), candidate = file.candidates[0]!
  await expect(run({ method: 'commit', project, expected_revision: file.revision, candidate_id: candidate.id, candidate_sha256: candidate.sha256 }, { approval: false })).rejects.toThrow('story_approval_log_pending')
})
it.each(['candidate', 'policy', 'scope', 'semantic', 'proof'] as const)('refuses changed final %s bindings through pure accepted replay and load', async (variant) => {
  await accepted(); const file = await current(), candidate = file.candidates[0]!
  if (variant === 'candidate') candidate.scenes[0]!.beats[0]!.text = '我们做好朋友吧。'
  if (variant === 'policy') file.story_policy!.scope.instructions = '变成好友。'
  if (variant === 'scope') candidate.story_adaptation!.scope_sha256 = '0'.repeat(64)
  if (variant === 'semantic') candidate.review!.semantic_report!.checks[0]!.explanation = '改成好友。'
  if (variant === 'proof') delete candidate.review!.story_acceptance
  expect(() => acceptedScripts(file)).toThrow(); expect(() => acceptedKnowledge(file)).toThrow()
  await writeFile(project, JSON.stringify(file)); await expect(run({ method: 'status', project })).rejects.toThrow()
})
it('validates both final approval and source events before formal accepted evidence export', async () => {
  await accepted(); const file = await current(); await expect(validateAcceptedStoryEvidence(file, async () => proof)).rejects.toThrow('story_approval_log_pending')
  let approvals = 0, sources = 0
  await validateAcceptedStoryEvidence(file, async (_input, saved) => { expect(saved).toEqual(proof); sources++; return proof },
    async () => { approvals++ })
  expect(approvals).toBe(1); expect(sources).toBe(1)
})
it('retains an accepted prefix after later sources append and invalidates overlapping unaccepted inventories', async () => {
  await accepted(); const before = await current(), original = acceptedScripts(before)[0]!
  await writeFile(join(root, 'later.txt'), '乙说：我走了。')
  await run({ method: 'import_source', project, expected_revision: before.revision, path: join(root, 'later.txt'), source_kind: 'text', story_video_path: join(root, 'original.mp4') })
  expect(acceptedScripts(await current())[0]).toEqual(original)
  await run({ method: 'status', project })
})
it('keeps the ordinary import branch unique while disabled deployments retain their existing request schema', () => {
  expect(REQUEST_STORY.oneOf.filter(entry => entry.properties.method.const === 'import_source')).toHaveLength(1)
})
it('preserves genuine old independent accepted prefixes in an explicit new story fork', async () => {
  const original = project
  const independent = new ProjectCommands(ctx.fs, limits, ctx.attachments)
  const reviewer = brandString<ActorId>('independent-reviewer')
  const exec = (asActor = actor) => ({ actor: asActor, signal: new AbortController().signal })
  await independent.execute({ method: 'init', project, mode: 'faithful', instructions: '原独立作品。' }, exec())
  await independent.execute({ method: 'import_source', project, expected_revision: 0, path: join(root, 'source.txt'), source_kind: 'text' }, exec())
  const source = (await current()).sources[0]!, unit = source.units[0]!
  await independent.execute({ method: 'propose_fact', project, expected_revision: 1, fact: { kind: 'speech', actor: '甲', origin: 'source', layer: 'present', summary: '原句拒绝。', anchors: [{ unit_id: unit.id, quote: unit.text }] } }, exec())
  const fact = (await current()).facts[0]!
  await independent.execute({ method: 'review_fact', project, expected_revision: 2, fact_id: fact.id, decision: 'approve', reason: '独立读取原文。' }, exec(reviewer))
  await independent.execute({ method: 'stage', project, expected_revision: 3, episode: 1, scenes: [{ location: '门前', time: '日', layer: 'present', transition: 'opening', characters: ['甲', '乙'], beats: [{ kind: 'dialogue', actor: '甲', text: '你走吧。', fact_ids: [fact.id], requires_knowledge: [], witnesses: ['乙'] }] }] }, exec())
  const candidate = (await current()).candidates[0]!
  await independent.execute({ method: 'review', project, expected_revision: 4, candidate_id: candidate.id, candidate_sha256: candidate.sha256, decision: 'approve', reason: '独立验收原稿。' }, exec(reviewer))
  await independent.execute({ method: 'commit', project, expected_revision: 5, candidate_id: candidate.id, candidate_sha256: candidate.sha256 }, exec())
  const old = await current(), oldBytes = await readFile(project, 'utf8'), oldScript = acceptedScripts(old)[0]!
  const version = (await ctx.fs.stat(await ctx.fs.resolve(join(root, 'original.mp4'), { signal: new AbortController().signal }), new AbortController().signal))!.version
  const destination = join(root, 'story-fork.json')
  await run({ method: 'fork_story_faithful', project, expected_revision: old.revision, destination, before_episode: 2, work_title: '门前的选择', videos: [{ path: join(root, 'original.mp4'), source_version: version }], episodes: [2], scope_instructions: '仅新第二集故事忠实创作。', authorization_quote: grant.quote, consent_assessment: grant.consent_assessment, allowed_categories: ['performance_detail', 'minimal_os', 'supporting_dialogue'], baseline_candidate_ids: [], source_links: [{ source_id: source.id, video_path: join(root, 'original.mp4') }] })
  project = destination
  const fork = await current(); expect(fork.candidates[0]!.review).toEqual(old.candidates[0]!.review)
  expect(fork.candidates[0]!.review!.kind).toBeUndefined(); expect(acceptedScripts(fork)[0]).toEqual(oldScript)
  commands = new ProjectCommands(ctx.fs, limits, ctx.attachments)
  await run({ method: 'status', project })
  let newProofChecks = 0
  await validateAcceptedStoryEvidence(fork, async () => { newProofChecks++; throw Error('legacy prefix does not require V2 stamp') }, async () => { throw Error('legacy prefix does not require V2 C record') })
  expect(newProofChecks).toBe(0); expect(await readFile(original, 'utf8')).toBe(oldBytes)
  // The new episode receives fresh V2 evidence while the retained prefix remains independent.
  commands = new ProjectCommands(ctx.fs, limits, ctx.attachments, 'self-check', 'disabled', 'story-faithful-v2')
  await run({ method: 'import_source', project, expected_revision: 0, path: join(root, 'inspection.json'), source_kind: 'video_inspection' })
  await sourcesAndFacts(true); await reviewedInventory(); const second = await stage(); await rereadCandidate(); await approveCandidate()
  const next = await current()
  await run({ method: 'commit', project, expected_revision: next.revision, candidate_id: second.id, candidate_sha256: second.sha256 })
  const complete = await current(); expect(complete.candidates[0]!.review).toEqual(old.candidates[0]!.review)
  expect(acceptedScripts(complete)).toHaveLength(2); expect(acceptedScripts(complete)[0]).toEqual(oldScript)
  let approved = 0, inspected = 0
  await validateAcceptedStoryEvidence(complete, async () => { inspected++; return proof },
    async (item) => { expect(item.id).toBe(second.id); approved++ })
  expect(approved).toBe(1); expect(inspected).toBe(1)
  commands = new ProjectCommands(ctx.fs, limits, ctx.attachments)
  await run({ method: 'status', project }); await mkdir(join(root, 'fork-delivery'))
  await run({ method: 'export', project, candidate_id: second.id, directory: join(root, 'fork-delivery') })
  expect(await readFile(original, 'utf8')).toBe(oldBytes)
})
it('uses a bounded exact input snapshot across five same-episode revisions', async () => {
  await sourcesAndFacts(); await reviewedInventory(); await stage()
  let previous = (await current()).candidates.at(-1)!, firstBytes = 0
  for (let index = 0; index < 5; index++) {
    const { file, item, scenes, notes } = await draft()
    scenes[0]!.beats[0]!.text = `走吧！我说过，你走吧。${index + 1}`
    notes.input_candidate_id = previous.id
    for (const mapping of notes.mapping)
      for (const output of mapping.outputs) output.text = scenes[output.scene - 1]!.beats[output.beat - 1]!.text
    for (const change of notes.changes) if (change.after !== undefined) {
      const old = previous.scenes[change.after.scene - 1]!.beats[change.after.beat - 1]!
      change.before = { scene: change.after.scene, beat: change.after.beat, text: old.text }
      change.after.text = scenes[change.after.scene - 1]!.beats[change.after.beat - 1]!.text
    }
    step = 110 + index * 10
    await run({ method: 'stage', project, expected_revision: file.revision, episode: 1, scenes: stageScenes(scenes), coverage: stageCoverage(item.coverage), story_notes: stageStoryNotes(notes) })
    previous = (await current()).candidates.at(-1)!
    const snapshot = previous.story_adaptation!.input_candidate_json!
    if (index === 0) firstBytes = Buffer.byteLength(snapshot)
    expect(Buffer.byteLength(snapshot)).toBeLessThan(firstBytes + 100)
    expect(snapshot).not.toContain('input_candidate_json')
  }
})
it.each(['before', 'after'] as const)('rejects revision notes that misquote the actual %s version without replacing the pending candidate', async (variant) => {
  await sourcesAndFacts(); await reviewedInventory(); const previous = await stage()
  const { file, item, scenes, notes } = await draft(), original = await readFile(project, 'utf8')
  notes.input_candidate_id = previous.id
  for (const change of notes.changes) if (change.after !== undefined) {
    change.before = { ...change.after, text: previous.scenes[change.after.scene - 1]!.beats[change.after.beat - 1]!.text }
  }
  notes.changes[0]![variant]!.text = '此句没有出现在实际版本中。'
  step = 110
  await expect(run({ method: 'stage', project, expected_revision: file.revision, episode: 1,
    scenes: stageScenes(scenes), coverage: stageCoverage(item.coverage), story_notes: stageStoryNotes(notes) })).rejects.toThrow('story_notes_location')
  expect(await readFile(project, 'utf8')).toBe(original)
  expect((await current()).candidates.at(-1)!.id).toBe(previous.id)
})
it('rejects future-only source facts and unauthorized adaptation knowledge even when notes cite valid current units', async () => {
  await sourcesAndFacts(); await reviewedInventory(); const { file, item, scenes, notes } = await draft()
  const future = structuredClone(file.facts[0]!); future.id = brandString<FactId>('f:future'); future.anchors = [{ unit_id: brandString<UnitId>('future-unit'), quote: '未来身份揭晓。' }]
  file.facts.push(future)
  const candidate = { ...file, candidates: [] }
  // The public executor refuses the forged source before it can become an accepted knowledge prerequisite.
  await writeFile(project, JSON.stringify(candidate))
  scenes[1]!.beats[0]!.requires_knowledge = [future.id]
  await expect(run({ method: 'stage', project, expected_revision: file.revision, episode: 1, scenes: stageScenes(scenes), coverage: stageCoverage(item.coverage), story_notes: stageStoryNotes(notes) })).rejects.toThrow(/source_quote_mismatch|invalid_project|story_fact_scope/)
})
it.each(['failed_outer', 'missing_outer'] as const)('does not repair a %s C execution with a later successful reused call ID', async (variant) => {
  await accepted(); const file = await current(), candidate = file.candidates[0]!, input = await report()
  const rootCallId = ToolCallId('reused-root'), subCallId = ToolCallId('reused-root:ptc:1')
  const events: SessionEvent[] = Array.from({ length: 120 }, (_, index) => ({ type: 'turn/end', seq: SessionSeq(index), time: 0, data: { turn: 0, reason: { kind: 'completed' } } }))
  events[120] = { type: 'step/start', seq: SessionSeq(120), time: 0, data: { turn: 1, step: 1 } }
  events[121] = { type: 'tool/ptc-dispatch', seq: SessionSeq(121), time: 0, data: { name: 'screenplay_project', rootCallId, parentCallId: rootCallId, subCallId,
    arguments: { request: { method: 'review', candidate_id: candidate.id, candidate_sha256: candidate.sha256, decision: 'approve', semantic_report: input } }, isError: false,
    content: [{ type: 'text', text: JSON.stringify({ candidate }) }] } }
  events[122] = { type: 'tool/call', seq: SessionSeq(122), time: 0, data: { turn: 1, step: 1, callId: rootCallId, name: 'run_code', arguments: '{}' } }
  if (variant === 'failed_outer') events[122] = { type: 'tool/result', surfaceOp: 'append', seq: SessionSeq(122), time: 0, data: { turn: 1, step: 1,
    message: createToolResultMessage({ callId: rootCallId, isError: true, content: [{ type: 'text', text: 'failed synthetic C outer' }] }) } }
  events[123] = { type: 'step/end', seq: SessionSeq(123), time: 0, data: { turn: 1, step: 1 } }
  events[124] = { type: 'step/start', seq: SessionSeq(124), time: 0, data: { turn: 1, step: 2 } }
  events[125] = { type: 'tool/result', surfaceOp: 'append', seq: SessionSeq(125), time: 0, data: { turn: 1, step: 2,
    message: createToolResultMessage({ callId: rootCallId, isError: false, content: [{ type: 'text', text: 'unrelated later success' }] }) } }
  // This read-only query double supplies the event window being validated; media proof is tested separately.
  ctx.provide('sessionQuery', { observeSession: async () => ({ events, [Symbol.dispose]() {} }) } as never)
  await expect(validateStoryApprovalLog(ctx, file, candidate, new AbortController().signal)).rejects.toThrow('story_approval_log_pending')
})
it('does not require a noncritical heuristic candidate point in V2 while retaining the actual duration plan', async () => {
  const path = join(root, 'inspection.json'), manifest = VIDEO_INSPECTION.parse(JSON.parse(await readFile(path, 'utf8')))
  manifest.sampling_plan = { strategy: 'scene_dialogue', selected: [{ time: 1, reasons: ['真实采样'] }], deferred: [{ time: 2, reasons: ['非关键算法候选'] }] }
  const bytes = JSON.stringify(manifest); await writeFile(path, bytes); proof!.manifest_sha256 = sha256(bytes)
  await accepted(); expect(acceptedScripts(await current())).toHaveLength(1)
})
it('keeps missing full-duration plan windows pending instead of accepting a self-declared verified inventory', async () => {
  proof!.plan = [{ start_seconds: 0, end_seconds: 2 }, { start_seconds: 2, end_seconds: 4 }]
  await sourcesAndFacts(); const item = await inventory(); step = 80
  await run({ method: 'read_story_inventory', project, inventory_id: item.id }); await readAll(); step = 90
  await expect(run({ method: 'review_story_inventory', project, expected_revision: (await current()).revision, inventory_id: item.id, inventory_sha256: item.sha256, decision: 'approve', reason: '仅一张帧不可代替全片分窗实际证据。' })).rejects.toThrow('story_evidence_pending')
  expect(await run({ method: 'status', project })).toMatchObject({ evidence_pending: [expect.stringContaining('2–4s')] })
})
it('appends new frame versions, invalidates the current inventory and retains its old candidate for restoration', async () => {
  await ready(); const old = await current(), oldCandidate = old.candidates[0]!
  const path = join(root, 'extra-inspection.json'), manifest = VIDEO_INSPECTION.parse(JSON.parse(await readFile(join(root, 'inspection.json'), 'utf8')))
  const frame = manifest.frames[0]
  if (frame === undefined) throw Error('synthetic fixture needs a frame')
  frame.requested_seconds = 2; frame.timestamp_seconds = 2
  const bytes = JSON.stringify(manifest); await writeFile(path, bytes)
  proof = { ...proof!, manifest_path: path, manifest_sha256: sha256(bytes), windows: [{ start_seconds: 0, end_seconds: 4,
    sample_requested_seconds: [2], decoded_pts_seconds: [2], frames: manifest.frames }] }
  await run({ method: 'import_source', project, expected_revision: old.revision, path, source_kind: 'video_inspection' })
  const updated = await current(); expect(updated.sources).toHaveLength(3); expect(updated.candidates[0]!.sha256).toBe(oldCandidate.sha256)
  expect(updated.story_inventories![0]!.superseded_at_revision).toBe(updated.revision)
  expect(await run({ method: 'status', project })).toMatchObject({ evidence_pending: [expect.stringContaining('已失效')] })
  await expect(approveCandidate()).rejects.toThrow(/story_evidence_pending|self_check_read_required/)
})
it.each(['action_after_speech', 'speech_after_action'] as const)('keeps genuine current-scene knowledge prerequisites across expression channels: %s', async (variant) => {
  await sourcesAndFacts(); await reviewedInventory(); const { file, item, scenes, notes } = await draft()
  const speech = file.facts[0]!, action = file.facts[2]!
  if (variant === 'action_after_speech') scenes[1]!.beats[0]!.requires_knowledge = [speech.id]
  else {
    const beat = { kind: 'dialogue' as const, actor: '甲', text: '门开了。你走吧。', fact_ids: [speech.id], requires_knowledge: [action.id], witnesses: ['乙'] }
    scenes[1]!.beats.push(beat)
    notes.changes.push({ source: { unit_id: speech.anchors[0]!.unit_id, fact_id: speech.id }, after: { scene: 2, beat: 2, text: beat.text }, reason: '人物观察实际开门行动后重复同一拒绝立场，前提是图像动作不是语音。' })
  }
  await run({ method: 'stage', project, expected_revision: file.revision, episode: 1, scenes: stageScenes(scenes), coverage: stageCoverage(item.coverage), story_notes: stageStoryNotes(notes) })
  expect((await current()).candidates).toHaveLength(1)
})
it('does not let a model-defined short coverage interval skip the remaining probed original duration', async () => {
  proof!.plan = [{ start_seconds: 0, end_seconds: 2 }, { start_seconds: 2, end_seconds: 4 }]
  await sourcesAndFacts(); const file = await current(), item = await inventory()
  const raw = await current(), pending = raw.story_inventories!.at(-1)!
  // Repropose with a truthful tiny sample interval. It grants no permission to discard the other original-video window.
  await run({ method: 'propose_story_inventory', project, expected_revision: raw.revision, episode: 1, items: pending.items, not_applicable: [],
    coverage: { ...pending.coverage, windows: stageCoverage(pending.coverage).windows.map(window => window.source_id === file.sources[1]!.id
      ? { ...window, interval: { start_seconds: 0, end_seconds: 2 } } : window) } })
  const cropped = (await current()).story_inventories!.at(-1)!; step = 80
  await run({ method: 'read_story_inventory', project, inventory_id: cropped.id }); await readAll(); step = 90
  await expect(run({ method: 'review_story_inventory', project, expected_revision: (await current()).revision, inventory_id: cropped.id, inventory_sha256: cropped.sha256, decision: 'approve', reason: '模型裁剪不能授权遗漏整片其余区间。' })).rejects.toThrow('story_evidence_pending')
  expect(item.episode).toBe(1)
})
it.each([false, true])('requires all three 180-second probed windows, complete=%s', async (complete) => {
  const path = join(root, 'inspection.json'), manifest = VIDEO_INSPECTION.parse(JSON.parse(await readFile(path, 'utf8')))
  if (manifest.interval === undefined) throw Error('synthetic fixture needs an interval')
  manifest.duration_seconds = 180; manifest.interval.end_seconds = 180
  const frame = manifest.frames[0]
  if (frame === undefined) throw Error('synthetic fixture needs a frame')
  if (complete) manifest.frames.push(...[61, 121].map(time => ({ ...frame, requested_seconds: time, timestamp_seconds: time })))
  const bytes = JSON.stringify(manifest); await writeFile(path, bytes)
  proof = { ...proof!, duration_seconds: 180, manifest_sha256: sha256(bytes), plan: [0, 60,
    120].map(start => ({ start_seconds: start, end_seconds: start + 60 })),
  windows: [{ start_seconds: 0, end_seconds: 180,
    sample_requested_seconds: manifest.frames.map(frame => frame.requested_seconds),
    decoded_pts_seconds: manifest.frames.map(frame => frame.timestamp_seconds), frames: manifest.frames }] }
  if (complete) { await accepted(); expect(acceptedScripts(await current())).toHaveLength(1) }
  else {
    await sourcesAndFacts(); const item = await inventory(); step = 80
    await run({ method: 'read_story_inventory', project, inventory_id: item.id }); await readAll(); step = 90
    await expect(run({ method: 'review_story_inventory', project, expected_revision: (await current()).revision, inventory_id: item.id, inventory_sha256: item.sha256, decision: 'approve', reason: '一窗不能替代原片三窗。' })).rejects.toThrow('story_evidence_pending')
  }
})
it('preserves original ordinary adaptation facts in a story fork without granting them new supplemental authority', async () => {
  const independent = new ProjectCommands(ctx.fs, limits, ctx.attachments), reviewer = brandString<ActorId>('old-adaptation-reviewer')
  const exec = (asActor = actor) => ({ actor: asActor, signal: new AbortController().signal })
  await independent.execute({ method: 'init', project, mode: 'adaptation', instructions: '旧项目获准的常规改编。' }, exec())
  await independent.execute({ method: 'import_source', project, expected_revision: 0, path: join(root, 'source.txt'), source_kind: 'text' }, exec())
  const source = (await current()).sources[0]!, unit = source.units[0]!
  await independent.execute({ method: 'propose_fact', project, expected_revision: 1, fact: { kind: 'speech', origin: 'adaptation', actor: '甲', layer: 'present', summary: '甲说再见。', adaptation_reason: '旧项目明确允许的承接表达。', anchors: [{ unit_id: unit.id, quote: unit.text }] } }, exec())
  const fact = (await current()).facts[0]!
  await independent.execute({ method: 'review_fact', project, expected_revision: 2, fact_id: fact.id, decision: 'approve', reason: '旧独立审校的改编方向。' }, exec(reviewer))
  await independent.execute({ method: 'stage', project, expected_revision: 3, episode: 1, scenes: [{ location: '门前', time: '日', layer: 'present', transition: 'opening', characters: ['甲', '乙'], beats: [{ kind: 'dialogue', actor: '甲', text: '再见。', fact_ids: [fact.id], requires_knowledge: [], witnesses: ['乙'] }] }] }, exec())
  const old = await current(), input = old.candidates[0]!, destination = join(root, 'adaptation-story-fork.json')
  const version = (await ctx.fs.stat(await ctx.fs.resolve(join(root, 'original.mp4'), { signal: new AbortController().signal }), new AbortController().signal))!.version
  await run({ method: 'fork_story_faithful', project, expected_revision: old.revision, destination, before_episode: 1, work_title: '从原作品复核的新稿', videos: [{ path: join(root, 'original.mp4'), source_version: version }], episodes: [1], scope_instructions: '新作品忠实原故事，旧草稿仅作为实际修改输入。', authorization_quote: grant.quote, consent_assessment: grant.consent_assessment, allowed_categories: [], baseline_candidate_ids: [input.id], source_links: [{ source_id: source.id, video_path: join(root, 'original.mp4') }] })
  project = destination
  await run({ method: 'status', project }); const fork = await current()
  expect(fork.facts[0]).toEqual(old.facts[0]); expect(fork.facts[0]!.story_supplement).toBeUndefined()
  expect(JSON.parse(fork.story_policy!.input_candidates![0]!)).toMatchObject({ id: input.id, sha256: input.sha256 })
})
it('requires explicit multi-video episode mapping and does not invalidate episode one when episode two is appended', async () => {
  const nextVideo = join(root, 'episode-two.mp4'); await writeFile(nextVideo, 'another original synthetic media file')
  const version = (await ctx.fs.stat(await ctx.fs.resolve(join(root, 'original.mp4'), { signal: new AbortController().signal }), new AbortController().signal))!.version
  const nextVersion = (await ctx.fs.stat(await ctx.fs.resolve(nextVideo, { signal: new AbortController().signal }),
    new AbortController().signal))!.version
  const init = { method: 'init_story_faithful' as const, project, work_title: '两集原作品', videos: [{ path: join(root, 'original.mp4'), source_version: version }, { path: nextVideo, source_version: nextVersion }], episodes: [1, 2], scope_instructions: '按原视频逐集保留故事。', authorization_quote: grant.quote, consent_assessment: grant.consent_assessment, allowed_categories: ['performance_detail', 'minimal_os', 'supporting_dialogue'] as const }
  await expect(run({ ...init, allowed_categories: [...init.allowed_categories] })).rejects.toThrow('story_video_episode')
  await run({ ...init, allowed_categories: [...init.allowed_categories], videos: init.videos.map((video, index) => ({ ...video,
    episode: index + 1 })) })
  await run({ method: 'import_source', project, expected_revision: 0, path: join(root, 'source.txt'), source_kind: 'text', story_video_path: join(root, 'original.mp4') })
  await run({ method: 'import_source', project, expected_revision: 1, path: join(root, 'inspection.json'), source_kind: 'video_inspection' })
  await sourcesAndFacts(false,
    true); await reviewedInventory(); const candidate = await stage(); await rereadCandidate(); await approveCandidate()
  await run({ method: 'commit', project, expected_revision: (await current()).revision, candidate_id: candidate.id, candidate_sha256: candidate.sha256 })
  const first = acceptedScripts(await current())[0]!
  await writeFile(join(root, 'episode-two-source.txt'), '乙说：明天再来。')
  await run({ method: 'import_source', project, expected_revision: (await current()).revision, path: join(root, 'episode-two-source.txt'), source_kind: 'text', story_video_path: nextVideo })
  expect(acceptedScripts(await current())[0]).toEqual(first)
  const firstInventory = (await current()).story_inventories![0]!
  await expect(run({ method: 'propose_story_inventory', project, expected_revision: (await current()).revision, episode: 2,
    coverage: stageCoverage(firstInventory.coverage), items: firstInventory.items, not_applicable: [] })).rejects.toThrow('story_source_window')
})
it('rejects duplicate persisted inventory identities and changed original source bytes', async () => {
  await sourcesAndFacts(); await reviewedInventory(); const file = await current()
  file.story_inventories!.push(structuredClone(file.story_inventories![0]!))
  await writeFile(project, JSON.stringify(file)); await expect(run({ method: 'status', project })).rejects.toThrow('invalid_project')
  file.story_inventories!.pop(); await writeFile(project, JSON.stringify(file))
  await writeFile(join(root, 'source.txt'), '甲说：我们是好友。')
  await expect(run({ method: 'status', project })).rejects.toThrow('source_changed')
})
it('retains historical self-check context digests when explicitly forking an ordinary project into V2', async () => {
  const originalCommands = new ProjectCommands(ctx.fs, limits, ctx.attachments, 'self-check')
  const invoke = (request: ProjectRequest) => originalCommands.execute(request, { actor, signal: new AbortController().signal,
    step: SessionSeq(step), receipts, observeRead: receipt => receipts.push(receipt) })
  await invoke({ method: 'init', project, mode: 'faithful', instructions: '旧同会话事实自检。' })
  await invoke({ method: 'import_source', project, expected_revision: 0, path: join(root, 'source.txt'), source_kind: 'text' })
  const source = (await current()).sources[0]!, unit = source.units[0]!
  await invoke({ method: 'propose_fact', project, expected_revision: 1, fact: { kind: 'speech', actor: '甲', origin: 'source', layer: 'present', summary: '甲让乙离开。', anchors: [{ unit_id: unit.id, quote: unit.text }] } })
  const proposed = (await current()).facts[0]!; step = 20
  await invoke({ method: 'read_fact', project, fact_id: proposed.id }); await invoke({ method: 'read_source', project, source_id: source.id, start: 1, count: 1 }); step = 30
  await invoke({ method: 'review_fact', project, expected_revision: 2, fact_id: proposed.id, decision: 'approve', reason: '旧完整分轮事实自检。' })
  const old = await current(), review = structuredClone(old.facts[0]!.review), version = (await ctx.fs.stat(await ctx.fs.resolve(join(root, 'original.mp4'), { signal: new AbortController().signal }), new AbortController().signal))!.version
  const destination = join(root, 'old-self-check-story-fork.json')
  await run({ method: 'fork_story_faithful', project, expected_revision: old.revision, destination, before_episode: 1, work_title: '旧来源新故事稿', videos: [{ path: join(root, 'original.mp4'), source_version: version }], episodes: [1], scope_instructions: '保留来源和旧审校，不改变历史身份。', authorization_quote: grant.quote, consent_assessment: grant.consent_assessment, allowed_categories: [], baseline_candidate_ids: [], source_links: [{ source_id: source.id, video_path: join(root, 'original.mp4') }] })
  project = destination; await run({ method: 'status', project })
  expect((await current()).facts[0]!.review).toEqual(review)
  expect((await current()).story_policy!.legacy_context_sha256).toBe(review!.evidence!.context_sha256)
})
it('binds V2 rendering to its actual candidate scenes and episode while preserving explicit synchronous typed action', async () => {
  await sourcesAndFacts(); await reviewedInventory(); const { file, item, scenes, notes } = await draft()
  const dialogue = scenes[0]!.beats[0]!, os = scenes[0]!.beats[1]!, action = scenes[1]!.beats[0]!
  action.sync_with = 1; action.synchrony_reason = '同人物在拒绝发声时推门，保留独立已审动作事实与源位置。'
  scenes[0]!.beats = [dialogue, action, os]; scenes.pop(); notes.scene_changes.pop()
  const position = (beat: number) => ({ scene: 1, beat, text: scenes[0]!.beats[beat - 1]!.text })
  for (const mapping of notes.mapping) mapping.outputs = mapping.item_id === 'door' ? [position(2)] : mapping.item_id === 'tension' ? [position(3)]
    : mapping.item_id === 'cause' ? [position(1), position(2)] : [position(1)]
  notes.changes[1]!.after = position(3); notes.changes[2]!.after = position(2)
  await run({ method: 'stage', project, expected_revision: file.revision, episode: 1, scenes: stageScenes(scenes), coverage: stageCoverage(item.coverage), story_notes: stageStoryNotes(notes) })
  const staged = await current(), candidate = staged.candidates[0]!
  const rendered = renderEpisode(staged, candidate.scenes, {}, 1, candidate)
  expect(rendered.script).toContain('甲（甲推开门，门应声打开。）：走吧！我说过，你走吧。')
  expect(candidate.scenes[0]!.beats[1]!.kind).toBe('action'); expect(candidate.scenes[0]!.beats[1]!.fact_ids).toEqual([file.facts[2]!.id])
  expect(() => renderEpisode(staged, candidate.scenes, {}, 2, candidate)).toThrow('synchronous_action_context')
  const changed = structuredClone(candidate.scenes); changed[0]!.beats[0]!.text = '别的版本。'
  expect(() => renderEpisode(staged, changed, {}, 1, candidate)).toThrow('synchronous_action_context')
})

it.each(['missing_policy', 'changed_grant', 'duplicate_episode', 'unrelated_video', 'changed_video_version'] as const)(
  'refuses durable story source or grant changes: %s', async (variant) => {
    await sourcesAndFacts(); await inventory()
    const file = await current(), policy = file.story_policy!
    switch (variant) {
      case 'missing_policy': delete file.story_policy; break
      case 'changed_grant': policy.authorization.quote += ' altered'; break
      case 'duplicate_episode': policy.scope.episodes.push(policy.scope.episodes[0]!); policy.sha256 = storyPolicyDigest(policy); break
      case 'unrelated_video': file.sources[1]!.story_video_path = join(root, 'other.mp4'); break
      case 'changed_video_version': file.sources[1]!.video!.source_version = FsVersion('changed-version'); break
    }
    const code = { missing_policy: 'story_policy_required', changed_grant: 'story_policy_digest',
      duplicate_episode: 'story_policy_scope', unrelated_video: 'story_source_scope', changed_video_version: 'story_source_scope' }[variant]
    expect(() => { validateStoryPolicy(file) }).toThrow(code)
  },
)
it.each(['unknown_source', 'oversized_window', 'duplicate_item', 'missing_dimension', 'causal_cycle', 'self_dependency',
  'unknown_fact', 'adaptation_as_source', 'unreviewed_fact', 'uncovered_evidence'] as const)(
  'refuses incomplete or replaced durable story inventory: %s', async (variant) => {
    await sourcesAndFacts(); await inventory()
    const file = await current(), item = file.story_inventories![0]!, first = item.items[0]!
    switch (variant) {
      case 'unknown_source': item.coverage.windows[0]!.source_id = brandString<typeof file.sources[number]['id']>('s:missing'); break
      case 'oversized_window': item.coverage.windows[0]!.count += 100; break
      case 'duplicate_item': item.items.push(first); break
      case 'missing_dimension': item.items.splice(2, 1); break
      case 'causal_cycle': first.depends_on = ['door']; break
      case 'self_dependency': first.depends_on = [first.id]; break
      case 'unknown_fact': first.fact_ids = [brandString<FactId>('f:missing')]; break
      case 'adaptation_as_source': first.fact_ids = [file.facts[3]!.id]; break
      case 'unreviewed_fact': delete file.facts[0]!.review; break
      case 'uncovered_evidence': first.source_units.push(file.sources[1]!.units[0]!.id); break
    }
    item.scope_sha256 = storyScopeDigest(file, item); item.sha256 = inventoryDigest(item)
    const code = { unknown_source: 'story_source_window', oversized_window: 'story_source_window', duplicate_item: 'story_item_duplicate',
      missing_dimension: 'story_dimensions_required', causal_cycle: 'story_causal_cycle', self_dependency: 'story_item_scope',
      unknown_fact: 'story_fact_review', adaptation_as_source: 'story_fact_review', unreviewed_fact: 'story_fact_review',
      uncovered_evidence: 'story_item_evidence' }[variant]
    expect(() => { validateInventory(file, item) }).toThrow(code)
  },
)
