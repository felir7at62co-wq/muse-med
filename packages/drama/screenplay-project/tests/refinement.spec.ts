/** Bounded source-preserving forks, immutable grants, located reports, and separate delivery. */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
import { PROJECT_FILE, type ProjectRequest } from '../src/schema.ts'
import { acceptedScripts, candidateDigest, sha256 } from '../src/episode.ts'
import { buildRefinement, refinementContentDigest, refinementPolicyDigest, validateRefinement, validateRefinementPolicy,
  validateSupplement, renderModificationNotes } from '../src/refinement.ts'
import { requiredReads, validReview } from '../src/review.ts'
import type { HumanAuthorization } from '../src/refinement.ts'
import type { ActorId } from '../src/ids.ts'
import { stageScenes } from './fixtures/stage-input.ts'

let ctx: Context, root: string, original: string, fork: string, commands: ProjectCommands
const actor = brandString<ActorId>('writer'), reviewer = brandString<ActorId>('reviewer')
const limits = { maxSourceBytes: 1024 * 1024, maxProjectBytes: 4 * 1024 * 1024, maxReadUnits: 100, maxReadBytes: 65536, maxFactBatch: 20 }
const authorization: HumanAuthorization = { source: 'user', session_id: actor, message_id: 'actual-host-message', seq: SessionSeq(4),
  message_sha256: sha256('real human message'), quote: '只精修第一集，可以补最小 OS，不改变事件。', consent_assessment: '用户明确仅允许第一集最小 OS。' }
const run = (request: ProjectRequest, asActor = actor, evidence = authorization) => commands.execute(request, {
  actor: asActor, signal: new AbortController().signal, authorization: evidence,
})
const current = async (path = fork) => PROJECT_FILE.parse(JSON.parse(await readFile(path, 'utf8')))
const notes = (before: string, after: string) => ({
  changes: [{ before: { scene: 1, beat: 1, text: before }, after: { scene: 1, beat: 1, text: after }, reason: '整理语气，不改变钥匙归属。' }],
  editor_comments: [{ comment: '把语气写顺。', disposition: 'adopted' as const, reason: '已调整停顿。', change_indices: [1] }],
  unresolved: ['表演节奏仍须拍摄时核对。'], unhandled: [], validation: {
    semantic: { status: 'limited' as const, scenes: [1], reason: '仅对比第一场的钥匙归属，后续版本审查尚未进行。' },
    visual: { status: 'not_run' as const, source_units: [], reason: '只有文字来源，未做视觉检查。' },
  },
})
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'screenplay-refinement-')); original = join(root, 'original.json'); fork = join(root, 'refined.json')
  ctx = new Context(); await ctx.plugin(LocalFileSystem, { cwd: root }); await ctx.plugin(LocalAttachmentStore, { dshHome: root })
  commands = new ProjectCommands(ctx.fs, limits, ctx.attachments, 'independent', 'source-preserving-v1')
  await run({ method: 'init', project: original, mode: 'faithful', instructions: '保持原事件与人物归属。' })
  await writeFile(join(root, 'source.txt'), '甲想：钥匙在我手里。')
  await run({ method: 'import_source', project: original, expected_revision: 0, path: join(root, 'source.txt'), source_kind: 'text' })
  let file = await current(original); const unit = file.sources[0]!.units[0]!
  await run({ method: 'propose_fact', project: original, expected_revision: file.revision,
    fact: { kind: 'thought', origin: 'source', actor: '甲', layer: 'present', summary: unit.text, anchors: [{ unit_id: unit.id, quote: unit.text }] } })
  file = await current(original)
  await run({ method: 'review_fact', project: original, expected_revision: file.revision, fact_id: file.facts[0]!.id, decision: 'approve', reason: '原文为甲本人心理。' }, reviewer)
  file = await current(original)
  await run({ method: 'stage', project: original, expected_revision: file.revision, episode: 1,
    scenes: [{ location: '门前', time: '日', setting: '外', layer: 'present', transition: 'opening', characters: ['甲'],
      beats: [{ kind: 'os', actor: '甲', text: '钥匙在我手里。', fact_ids: [file.facts[0]!.id], requires_knowledge: [], witnesses: [] }] }] })
})
afterEach(async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
async function createFork(categories: ('performance_detail' | 'minimal_os' | 'supporting_dialogue')[] = ['minimal_os']) {
  const file = await current(original)
  await run({ method: 'fork_refinement', project: original, expected_revision: file.revision, destination: fork,
    baseline_candidate_ids: [file.candidates[0]!.id], scope_instructions: '仅第一集，保持事件、关系、动机、关键句与揭示顺序。',
    authorization_quote: authorization.quote, consent_assessment: authorization.consent_assessment, allowed_categories: categories })
}
async function proposeSupplement() {
  const file = await current(), policy = file.refinement!, unit = file.sources[0]!.units[0]!
  return run({ method: 'propose_fact', project: fork, expected_revision: file.revision,
    fact: { kind: 'thought', origin: 'adaptation', actor: '甲', layer: 'present', summary: '这把钥匙，在我手里。',
      anchors: [{ unit_id: unit.id, quote: unit.text }], adaptation_reason: '有限语气承接，保留钥匙归属。',
      supplemental: { policy_sha256: policy.sha256, category: 'minimal_os', authorization_sha256: sha256(JSON.stringify(policy.authorization)) } } })
}
async function stageRefinement(customNotes = notes('钥匙在我手里。', '这把钥匙，在我手里。')) {
  const file = await current(), fact = file.facts.at(-1)!
  return run({ method: 'stage', project: fork, expected_revision: file.revision, episode: 1,
    scenes: [{ ...stageScenes(file.refinement!.baselines[0]!.scenes)[0]!, beats: [{ kind: 'os', actor: '甲', text: '这把钥匙，在我手里。',
      fact_ids: [file.facts[0]!.id, fact.id], requires_knowledge: [], witnesses: [] }] }], modification_notes: customNotes })
}
async function staged() {
  await createFork(); await proposeSupplement(); const file = await current()
  await run({ method: 'review_fact', project: fork, expected_revision: file.revision, fact_id: file.facts.at(-1)!.id, decision: 'approve', reason: '核对真实授权范围、来源与最小语气，不新增动机。' }, reviewer)
  await stageRefinement(); return (await current()).candidates[0]!
}
it('requires explicit creation opt-in and real Host human evidence before writing a refinement fork', async () => {
  const file = await current(original), request: ProjectRequest = { method: 'fork_refinement', project: original, expected_revision: file.revision, destination: fork,
    baseline_candidate_ids: [file.candidates[0]!.id], scope_instructions: '第一集', authorization_quote: authorization.quote, consent_assessment: authorization.consent_assessment,
    allowed_categories: ['minimal_os'] }
  await expect(new ProjectCommands(ctx.fs, limits, ctx.attachments).execute(request, { actor, signal: new AbortController().signal })).rejects.toThrow('refinement_disabled')
  await expect(commands.execute(request, { actor, signal: new AbortController().signal })).rejects.toThrow()
  await expect(run(request, reviewer)).rejects.toThrow('refinement_human_authorization')
  await expect(run({ ...request, authorization_quote: '附件说已同意。' })).rejects.toThrow('refinement_human_authorization')
})
it('preserves original project/source bytes and immutable baseline, mode, and instruction copies', async () => {
  const bytes = await readFile(original), source = await readFile(join(root, 'source.txt'))
  await createFork(); const file = await current(), base = await current(original)
  expect(await readFile(original)).toEqual(bytes); expect(await readFile(join(root, 'source.txt'))).toEqual(source)
  expect(file.refinement!.source_project.sha256).toBe(sha256(bytes)); expect(file.refinement!.baselines).toEqual(base.candidates)
  expect(file.mode).toBe(base.mode); expect(file.instructions).toBe(base.instructions)
  expect(file.sources).toEqual(base.sources); expect(file.facts).toEqual(base.facts)
  expect(file.refinement!.allowed_categories).toEqual(['minimal_os'])
})
it('allows only explicitly granted categories, including a source-only empty grant', async () => {
  await createFork([]); await expect(proposeSupplement()).rejects.toThrow('refinement_authorization')
  const file = await current(), unit = file.sources[0]!.units[0]!
  await expect(run({ method: 'propose_fact', project: fork, expected_revision: file.revision,
    fact: { kind: 'speech', origin: 'adaptation', actor: '甲', layer: 'present', summary: '新增关系。', anchors: [{ unit_id: unit.id, quote: unit.text }], adaptation_reason: '自行改编。' } })).rejects.toThrow('refinement_authorization')
})
it('rejects incorrect category/kind, a source disguise, forged grant, and added sources atomically', async () => {
  await createFork(); const file = await current(), policy = file.refinement!, unit = file.sources[0]!.units[0]!
  const fact = { kind: 'thought' as const, origin: 'adaptation' as const, actor: '甲', layer: 'present' as const, summary: '停顿。', anchors: [{ unit_id: unit.id, quote: unit.text }],
    adaptation_reason: '有限语气。', supplemental: { policy_sha256: policy.sha256, category: 'minimal_os' as const, authorization_sha256: sha256(JSON.stringify(policy.authorization)) } }
  for (const input of [{ ...fact, kind: 'speech' as const }, { ...fact, origin: 'source' as const }, { ...fact, supplemental: { ...fact.supplemental, authorization_sha256: '0'.repeat(64) } }]) {
    await expect(run({ method: 'propose_fact', project: fork, expected_revision: file.revision, fact: input })).rejects.toThrow('refinement_')
  }
  await expect(run({ method: 'import_source', project: fork, expected_revision: file.revision, path: join(root, 'source.txt'), source_kind: 'text' })).rejects.toThrow('refinement_original_source')
  expect((await current()).revision).toBe(0)
})
it('binds the actual final before/after locations and rejects missing or false modification notes', async () => {
  await createFork(); await proposeSupplement(); let file = await current()
  await run({ method: 'review_fact', project: fork, expected_revision: file.revision, fact_id: file.facts.at(-1)!.id, decision: 'approve', reason: '范围与归属通过。' }, reviewer)
  const bad = notes('别的原文。', '这把钥匙，在我手里。')
  await expect(stageRefinement(bad)).rejects.toThrow('refinement_notes_location')
  await expect(stageRefinement(notes('钥匙在我手里。', '不存在的正文。'))).rejects.toThrow('refinement_notes_location')
  file = await current()
  await expect(run({ method: 'stage', project: fork, expected_revision: file.revision, episode: 1, scenes: stageScenes(file.refinement!.baselines[0]!.scenes) })).rejects.toThrow('refinement_report_required')
  await stageRefinement(); const candidate = (await current()).candidates[0]!
  expect(candidate.refinement!.notes.output.candidate_id).toBe(candidate.id)
  expect(candidate.refinement!.notes.output.content_sha256).toBe(candidate.refinement!.output_content_sha256)
  expect(candidate.refinement!.notes.supplements).toMatchObject([{ origin: 'adaptation', category: 'minimal_os' }])
})
it('rejects stale report, content, original fact, and policy on read, review, and accepted delivery', async () => {
  const candidate = await staged(), originalFile = await current()
  for (const mutate of [
    (file: typeof originalFile) => { file.candidates[0]!.refinement!.notes.changes[0]!.reason = '另一个理由。' },
    (file: typeof originalFile) => { file.candidates[0]!.scenes[0]!.beats[0]!.text = '被替换的正文。' },
    (file: typeof originalFile) => { file.facts[0]!.summary = '被替换的原事实。' },
    (file: typeof originalFile) => { file.refinement!.allowed_categories.push('supporting_dialogue') },
  ]) {
    const edited = structuredClone(originalFile); mutate(edited); await writeFile(fork, JSON.stringify(edited))
    await expect(run({ method: 'read_candidate', project: fork, candidate_id: candidate.id })).rejects.toThrow('refinement_')
    await expect(run({ method: 'review', project: fork, expected_revision: edited.revision, candidate_id: candidate.id, candidate_sha256: candidate.sha256, decision: 'approve', reason: '不能批准修改后内容。' }, reviewer)).rejects.toThrow('refinement_')
  }
  const forged = structuredClone(originalFile)
  forged.candidates[0]!.refinement!.notes.output.candidate_id = forged.refinement!.baselines[0]!.id
  forged.candidates[0]!.sha256 = candidateDigest(forged.candidates[0]!); await writeFile(fork, JSON.stringify(forged))
  await expect(run({ method: 'read_candidate', project: fork, candidate_id: candidate.id })).rejects.toThrow('refinement_report_digest')
  const policyChanged = structuredClone(originalFile); policyChanged.refinement!.scope.instructions = '已换范围。'; policyChanged.refinement!.sha256 = refinementPolicyDigest(policyChanged.refinement!)
  await writeFile(fork, JSON.stringify(policyChanged)); await expect(run({ method: 'read_candidate', project: fork, candidate_id: candidate.id })).rejects.toThrow('refinement_')
})
it('delivers pure accepted screenplay with a separate fixed report and sidecar report digest', async () => {
  const candidate = await staged(); let file = await current()
  await run({ method: 'review', project: fork, expected_revision: file.revision, candidate_id: candidate.id, candidate_sha256: candidate.sha256,
    decision: 'approve', reason: '有限范围内核对来源、真实用户类别授权与最终正文。' }, reviewer)
  file = await current(); await run({ method: 'commit', project: fork, expected_revision: file.revision, candidate_id: candidate.id, candidate_sha256: candidate.sha256 })
  const result = await run({ method: 'export', project: fork, candidate_id: candidate.id, directory: join(root, 'delivery') })
  expect(result).toHaveProperty('files'); file = await current()
  const scripts = acceptedScripts(file); expect(scripts[0]!.script).not.toContain('修改说明'); expect(scripts[0]!.modification_notes).toContain('《修改说明》')
  const basename = `episode-1-${candidate.id.slice(2)}`, report = await readFile(join(root, 'delivery', `${basename}.modification-notes.md`), 'utf8')
  expect(report).toBe(scripts[0]!.modification_notes); expect(report).toContain(candidate.sha256); expect(report).toContain('not_run'); expect(report).toContain('independent / approve')
  const sidecar = z.object({ modification_notes: z.object({ file: z.string(), sha256: z.string() }) })
    .parse(JSON.parse(await readFile(join(root, 'delivery', `${basename}.sources.json`), 'utf8')))
  expect(sidecar.modification_notes).toEqual({ file: `${basename}.modification-notes.md`, sha256: sha256(report) })
})

it('rejects silently changed scene metadata and after-only descriptions of replaced baseline beats', async () => {
  await createFork([]); const file = await current(), baseline = file.refinement!.baselines[0]!
  const candidate = { ...baseline, id: brandString<typeof baseline.id>('c:12345678-1234-4234-8234-123456789012'), review: undefined, committed_at: undefined,
    scenes: structuredClone(baseline.scenes) }
  candidate.scenes[0]!.beats[0]!.text = '钥匙，就在我手里。'
  const changed = notes('钥匙在我手里。', '钥匙，就在我手里。')
  for (const mutate of [
    () => { candidate.scenes[0]!.time = '夜' },
    () => { candidate.scenes[0]!.characters.push('乙') },
  ]) {
    candidate.scenes = structuredClone(baseline.scenes); candidate.scenes[0]!.beats[0]!.text = '钥匙，就在我手里。'; mutate()
    expect(() => buildRefinement(file, candidate, changed)).toThrow('refinement_scene_metadata')
  }
  candidate.scenes = structuredClone(baseline.scenes); candidate.scenes[0]!.beats[0]!.text = '钥匙，就在我手里。'
  const afterOnly = { ...changed, changes: [{ after: changed.changes[0]!.after, reason: '只报告新增。' }] }
  expect(() => buildRefinement(file, candidate, afterOnly)).toThrow('refinement_notes_unhandled')
  const falseVisual = { ...changed, validation: { ...changed.validation, visual: { status: 'limited' as const,
    source_units: [file.sources[0]!.units[0]!.id], reason: '把文字当画面。' } } }
  expect(() => buildRefinement(file, candidate, falseVisual)).toThrow('refinement_validation_range')
})
it('preserves source channels, listeners, unique fact ordering and allows duplicate identical expression collapse', async () => {
  const file = await current(original), baseline = file.candidates[0]!
  baseline.scenes[0]!.beats.push(structuredClone(baseline.scenes[0]!.beats[0]!)); baseline.sha256 = candidateDigest(baseline)
  await writeFile(original, JSON.stringify(file)); await createFork([])
  const forkFile = await current(), input = forkFile.refinement!.baselines[0]!
  const candidate = { ...input, id: brandString<typeof input.id>('c:12345678-1234-4234-8234-123456789012'), review: undefined, committed_at: undefined,
    scenes: structuredClone(input.scenes) }
  candidate.scenes[0]!.beats.pop()
  const report = { ...notes('钥匙在我手里。', '钥匙在我手里。'), changes: [{ before: { scene: 1, beat: 2, text: '钥匙在我手里。' }, reason: '合并完全重复的本人心理表达，原事实与顺序仍保留。' }] }
  candidate.refinement = buildRefinement(forkFile, candidate, report)
  candidate.sha256 = candidateDigest(candidate)
  expect(candidate.refinement).toHaveProperty('baseline_candidate_id', input.id)
  expect(renderModificationNotes(forkFile, candidate)).toContain('无（新增或删除）')
  expect(renderModificationNotes(forkFile, candidate)).toContain('无新增演绎事实')
  candidate.scenes[0]!.beats[0]!.kind = 'dialogue'
  expect(() => buildRefinement(forkFile, candidate, report)).toThrow('refinement_source_channel')
  candidate.scenes[0]!.beats = []
  expect(() => buildRefinement(forkFile, candidate, report)).toThrow('refinement_source_order')
})
it('rejects retagging actual source dialogue as audience-only VO or OS, and source fact reordering', async () => {
  await writeFile(join(root, 'speech.txt'), '甲说：门还开着。')
  let file = await current(original)
  await run({ method: 'import_source', project: original, expected_revision: file.revision, path: join(root, 'speech.txt'), source_kind: 'text' })
  file = await current(original); const unit = file.sources[1]!.units[0]!
  await run({ method: 'propose_fact', project: original, expected_revision: file.revision,
    fact: { kind: 'speech', origin: 'source', actor: '甲', layer: 'present', summary: unit.text, anchors: [{ unit_id: unit.id, quote: unit.text }] } })
  file = await current(original); const speech = file.facts.at(-1)!
  await run({ method: 'review_fact', project: original, expected_revision: file.revision, fact_id: speech.id, decision: 'approve', reason: '甲本人实际发声。' }, reviewer)
  file = await current(original); const baseline = file.candidates[0]!
  baseline.scenes[0]!.beats.push({ kind: 'dialogue', actor: '甲', text: '门还开着。', fact_ids: [speech.id], requires_knowledge: [], witnesses: [] })
  baseline.sha256 = candidateDigest(baseline); await writeFile(original, JSON.stringify(file)); await createFork([])
  const refined = await current(), input = refined.refinement!.baselines[0]!
  const candidate = { ...input, id: brandString<typeof input.id>('c:12345678-1234-4234-8234-123456789012'), review: undefined, committed_at: undefined,
    scenes: structuredClone(input.scenes) }
  const change = { ...notes('门还开着。', '门还开着。'), changes: [{ before: { scene: 1, beat: 2, text: '门还开着。' },
    after: { scene: 1, beat: 2, text: '门还开着。' }, reason: '伪装渠道变化。' }] }
  for (const kind of ['vo', 'os'] as const) {
    candidate.scenes[0]!.beats[1]!.kind = kind
    expect(() => buildRefinement(refined, candidate, change)).toThrow('refinement_source_channel')
  }
  candidate.scenes[0]!.beats = [...input.scenes[0]!.beats].reverse()
  expect(() => buildRefinement(refined, candidate, change)).toThrow('refinement_source_order')
})

it('rejects future episode source anchors in an earlier candidate even when both episodes share a grant', async () => {
  let file = await current(original)
  const first = file.candidates[0]!
  await run({ method: 'review', project: original, expected_revision: file.revision, candidate_id: first.id, candidate_sha256: first.sha256,
    decision: 'approve', reason: '真实第一集来源归属。' }, reviewer)
  file = await current(original); await run({ method: 'commit', project: original, expected_revision: file.revision, candidate_id: first.id, candidate_sha256: first.sha256 })
  await writeFile(join(root, 'future.txt'), '甲想：第二把钥匙在乙手里。')
  file = await current(original)
  await run({ method: 'import_source', project: original, expected_revision: file.revision, path: join(root, 'future.txt'), source_kind: 'text' })
  file = await current(original); const unit = file.sources[1]!.units[0]!
  await run({ method: 'propose_fact', project: original, expected_revision: file.revision, fact: { kind: 'thought', origin: 'source', actor: '甲', layer: 'present',
    summary: unit.text, anchors: [{ unit_id: unit.id, quote: unit.text }] } })
  file = await current(original); const futureFact = file.facts.at(-1)!
  await run({ method: 'review_fact', project: original, expected_revision: file.revision, fact_id: futureFact.id, decision: 'approve', reason: '第二集本人心理。' }, reviewer)
  file = await current(original)
  await run({ method: 'stage', project: original, expected_revision: file.revision, episode: 2, scenes: [{ ...stageScenes(first.scenes)[0]!,
    beats: [{ ...stageScenes(first.scenes)[0]!.beats[0]!, text: '第二把钥匙在乙手里。', fact_ids: [futureFact.id] }] }] })
  file = await current(original)
  const bothAuthorization = { ...authorization, quote: '只精修第一、二集，可以补最小 OS，不能提前揭示。',
    consent_assessment: '用户明确允许两个输入版本范围内最小 OS，禁止提前揭示。' }
  await run({ method: 'fork_refinement', project: original, expected_revision: file.revision, destination: fork,
    baseline_candidate_ids: file.candidates.map(candidate => candidate.id),
    scope_instructions: '精修第一、二集，不能提前揭示。', authorization_quote: bothAuthorization.quote,
    consent_assessment: bothAuthorization.consent_assessment, allowed_categories: ['minimal_os'] }, actor, bothAuthorization)
  file = await current(); const policy = file.refinement!
  await run({ method: 'propose_fact', project: fork, expected_revision: file.revision, fact: { kind: 'thought', origin: 'adaptation', actor: '甲', layer: 'present',
    summary: '提前提及第二把钥匙。', anchors: [{ unit_id: unit.id, quote: unit.text }], adaptation_reason: '测试未来来源跨集隔离。',
    supplemental: { policy_sha256: policy.sha256, category: 'minimal_os', authorization_sha256: sha256(JSON.stringify(policy.authorization)) } } })
  file = await current(); const supplement = file.facts.at(-1)!, baseline = policy.baselines[0]!
  const candidate = { ...baseline, id: brandString<typeof baseline.id>('c:12345678-1234-4234-8234-123456789012'), review: undefined, committed_at: undefined,
    scenes: structuredClone(baseline.scenes) }
  candidate.scenes[0]!.beats[0]!.fact_ids.push(supplement.id); candidate.scenes[0]!.beats[0]!.text = '第二把钥匙在乙手里。'
  expect(() => buildRefinement(file, candidate, notes('钥匙在我手里。', '第二把钥匙在乙手里。'))).toThrow('refinement_context_scope')
})

it('keeps original author analysis separate from an explicitly authorized adaptation thought and OS', async () => {
  original = join(root, 'analysis-original.json')
  await run({ method: 'init', project: original, mode: 'faithful', instructions: '保留作者分析，心理补充只能明确标为获准演绎。' })
  await writeFile(join(root, 'analysis.txt'), '作者分析：甲此刻有些迟疑。')
  await run({ method: 'import_source', project: original, expected_revision: 0, path: join(root, 'analysis.txt'), source_kind: 'text' })
  let file = await current(original); const unit = file.sources[0]!.units[0]!
  await run({ method: 'propose_fact', project: original, expected_revision: file.revision, fact: { kind: 'author_analysis', origin: 'source', layer: 'commentary',
    summary: unit.text, anchors: [{ unit_id: unit.id, quote: unit.text }] } })
  file = await current(original)
  await run({ method: 'review_fact', project: original, expected_revision: file.revision, fact_id: file.facts[0]!.id, decision: 'approve', reason: '原件为无角色归属的作者分析。' }, reviewer)
  file = await current(original)
  await run({ method: 'stage', project: original, expected_revision: file.revision, episode: 1, scenes: [{ location: '门前', time: '日', setting: '外',
    layer: 'present', transition: 'opening', characters: ['甲'], beats: [{ kind: 'vo', text: '甲此刻有些迟疑。', fact_ids: [file.facts[0]!.id], requires_knowledge: [], witnesses: [] }] }] })
  await createFork(); file = await current(); const policy = file.refinement!
  await run({ method: 'propose_fact', project: fork, expected_revision: file.revision, fact: { kind: 'thought', origin: 'adaptation', actor: '甲', layer: 'present',
    summary: '再想一想。', anchors: [{ unit_id: unit.id, quote: unit.text }], adaptation_reason: '用户限定最小 OS，心理承接明确标为演绎，不声称原作者分析是本人原声。',
    supplemental: { policy_sha256: policy.sha256, category: 'minimal_os', authorization_sha256: sha256(JSON.stringify(policy.authorization)) } } })
  file = await current(); const thought = file.facts.at(-1)!
  await run({ method: 'review_fact', project: fork, expected_revision: file.revision, fact_id: thought.id, decision: 'approve', reason: '明确演绎心理，原分析归属保留。' }, reviewer)
  file = await current(); const baseline = file.refinement!.baselines[0]!
  const result = await run({ method: 'stage', project: fork, expected_revision: file.revision, episode: 1, scenes: [{ ...stageScenes(baseline.scenes)[0]!, beats: [
    ...stageScenes(baseline.scenes)[0]!.beats, { kind: 'os', actor: '甲', text: '再想一想。', fact_ids: [thought.id], requires_knowledge: [], witnesses: [] },
  ] }], modification_notes: { ...notes('甲此刻有些迟疑。', '再想一想。'),
    changes: [{ after: { scene: 1, beat: 2, text: '再想一想。' }, reason: '保留原无角色分析，另列获准最小 OS。' }] } })
  expect(result).toHaveProperty('rendered')
  file = await current(); expect(file.facts[0]).toMatchObject({ kind: 'author_analysis', origin: 'source', layer: 'commentary' })
  expect(file.facts[0]!.actor).toBeUndefined(); expect(file.facts.at(-1)).toMatchObject({ kind: 'thought', origin: 'adaptation', actor: '甲' })
  expect(file.candidates[0]!.scenes[0]!.beats.map(beat => beat.kind)).toEqual(['vo', 'os'])
})

it.each(['legacy-omitted', 'earlier-subset'])('preserves %s baseline source IDs without changing the input digest', async (kind) => {
  let file = await current(original)
  const baseline = file.candidates[0]!
  if (kind === 'legacy-omitted') { delete baseline.source_ids; baseline.sha256 = candidateDigest(baseline); await writeFile(original, JSON.stringify(file)) }
  else {
    await writeFile(join(root, 'later.txt'), '第二集的独立来源，尚未写入第一集。')
    await run({ method: 'import_source', project: original, expected_revision: file.revision, path: join(root, 'later.txt'), source_kind: 'text' })
  }
  const inputDigest = baseline.sha256
  await createFork(); await proposeSupplement(); file = await current()
  await run({ method: 'review_fact', project: fork, expected_revision: file.revision, fact_id: file.facts.at(-1)!.id, decision: 'approve', reason: '获准本集语气补充。' }, reviewer)
  await stageRefinement(); file = await current()
  expect(file.refinement!.baselines[0]!.sha256).toBe(inputDigest)
  expect(file.candidates[0]!.source_ids).toEqual(baseline.source_ids)
  if (kind === 'legacy-omitted') expect(file.candidates[0]).not.toHaveProperty('source_ids')
  else expect(file.candidates[0]!.source_ids).toHaveLength(1)
})

it('rejects newly forged ungranted adaptation facts through common accepted-script delivery validation', async () => {
  const candidate = await staged(); let file = await current()
  await run({ method: 'review', project: fork, expected_revision: file.revision, candidate_id: candidate.id, candidate_sha256: candidate.sha256,
    decision: 'approve', reason: '实际有限授权版本审校。' }, reviewer)
  file = await current(); await run({ method: 'commit', project: fork, expected_revision: file.revision, candidate_id: candidate.id, candidate_sha256: candidate.sha256 })
  file = await current(); const fact = structuredClone(file.facts.at(-1)!), accepted = file.candidates[0]!
  fact.id = brandString<typeof fact.id>('f:ungranted'); delete fact.supplemental; fact.adaptation_reason = '仅声称改编，不具备授权。'
  file.facts.push(fact); accepted.scenes[0]!.beats[0]!.fact_ids.push(fact.id)
  accepted.refinement!.output_content_sha256 = refinementContentDigest(accepted)
  accepted.refinement!.notes.output.content_sha256 = accepted.refinement!.output_content_sha256
  accepted.refinement!.notes.machine.fact_ids.push(fact.id); accepted.sha256 = candidateDigest(accepted)
  expect(() => acceptedScripts(file)).toThrow('refinement_authorization')
})

it.each(['duplicate_category', 'duplicate_baseline', 'episode_scope', 'baseline_content', 'missing_fact',
  'changed_fact', 'missing_source', 'changed_source', 'added_source'] as const)(
  'rejects a persisted refinement policy with %s even after its outer digest is refreshed', async (variant) => {
    await createFork(); const file = await current(), policy = file.refinement!
    if (variant === 'duplicate_category') policy.allowed_categories.push(policy.allowed_categories[0]!)
    if (variant === 'duplicate_baseline') policy.baselines.push(structuredClone(policy.baselines[0]!))
    if (variant === 'episode_scope') policy.scope.episodes = [2]
    if (variant === 'baseline_content') policy.baselines[0]!.scenes[0]!.beats[0]!.text = '被替换的基线。'
    if (variant === 'missing_fact') file.facts = []
    if (variant === 'changed_fact') file.facts[0]!.summary = '被替换的事实。'
    if (variant === 'missing_source') file.sources = []
    if (variant === 'changed_source') file.sources[0]!.units[0]!.text = '被替换的索引。'
    if (variant === 'added_source') file.sources.push({ ...file.sources[0]!, id: brandString<typeof file.sources[0]['id']>('s:other:text') })
    policy.sha256 = refinementPolicyDigest(policy)
    const persisted = PROJECT_FILE.parse(JSON.parse(JSON.stringify(file)))
    expect(() => { validateRefinementPolicy(persisted) }).toThrow('refinement_')
  },
)

it.each(['missing_policy', 'wrong_policy', 'wrong_origin', 'wrong_grant', 'wrong_category', 'commentary',
  'missing_actor', 'empty_anchors', 'unrelated_anchor'] as const)(
  'rejects a saved supplement with %s', async (variant) => {
    await createFork(); await proposeSupplement(); const file = await current(), fact = file.facts.at(-1)!
    if (variant === 'missing_policy') delete file.refinement
    if (variant === 'wrong_policy') fact.supplemental!.policy_sha256 = '0'.repeat(64)
    if (variant === 'wrong_origin') fact.origin = 'source'
    if (variant === 'wrong_grant') fact.supplemental!.authorization_sha256 = '0'.repeat(64)
    if (variant === 'wrong_category') file.refinement!.allowed_categories = []
    if (variant === 'commentary') fact.layer = 'commentary'
    if (variant === 'missing_actor') delete fact.actor
    if (variant === 'empty_anchors') fact.anchors = []
    if (variant === 'unrelated_anchor') fact.anchors[0]!.unit_id = brandString<typeof fact.anchors[0]['unit_id']>('u:unrelated')
    const persisted = PROJECT_FILE.parse(JSON.parse(JSON.stringify(file)))
    expect(() => { validateSupplement(persisted, persisted.facts.at(-1)!) }).toThrow('refinement_')
  },
)

it.each(['missing_policy', 'candidate_digest', 'policy_digest', 'baseline_id', 'baseline_digest', 'content_digest',
  'source_scope', 'empty_change', 'missing_after', 'missing_before', 'comment_index', 'comment_unmapped',
  'semantic_scene', 'semantic_empty', 'visual_unknown', 'visual_empty', 'report_input', 'wrong_channel'] as const)(
  'rejects saved refinement delivery with %s without accepting refreshed outer hashes', async (variant) => {
    await staged(); const file = await current(), candidate = file.candidates[0]!, refinement = candidate.refinement!
    const report = refinement.notes
    if (variant === 'missing_policy') delete file.refinement
    if (variant === 'policy_digest') refinement.policy_sha256 = '0'.repeat(64)
    if (variant === 'baseline_id') refinement.baseline_candidate_id = brandString<typeof candidate.id>('c:12345678-1234-4234-8234-123456789012')
    if (variant === 'baseline_digest') refinement.baseline_sha256 = '0'.repeat(64)
    if (variant === 'content_digest') refinement.output_content_sha256 = '0'.repeat(64)
    if (variant === 'source_scope') candidate.source_ids = []
    if (variant === 'empty_change') report.changes = [{ reason: '没有位置的声明。' }]
    if (variant === 'missing_after') delete report.changes[0]!.after
    if (variant === 'missing_before') delete report.changes[0]!.before
    if (variant === 'comment_index') report.editor_comments[0]!.change_indices = [2]
    if (variant === 'comment_unmapped') report.editor_comments[0]!.change_indices = []
    if (variant === 'semantic_scene') report.validation.semantic.scenes = [2]
    if (variant === 'semantic_empty') report.validation.semantic.scenes = []
    if (variant === 'visual_unknown') report.validation.visual = { status: 'limited', source_units: [file.sources[0]!.units[0]!.id], reason: '文字不可冒充实际图像检查。' }
    if (variant === 'visual_empty') report.validation.visual.status = 'limited'
    if (variant === 'report_input') report.input.project_sha256 = '0'.repeat(64)
    if (variant === 'wrong_channel') candidate.scenes[0]!.beats[0]!.kind = 'dialogue'
    if (variant === 'source_scope' || variant === 'wrong_channel') {
      refinement.output_content_sha256 = refinementContentDigest(candidate)
      report.output.content_sha256 = refinement.output_content_sha256
    }
    candidate.sha256 = variant === 'candidate_digest' ? '0'.repeat(64) : candidateDigest(candidate)
    const persisted = PROJECT_FILE.parse(JSON.parse(JSON.stringify(file)))
    expect(() => { validateRefinement(persisted, persisted.candidates[0]!) }).toThrow('refinement_')
  },
)

it('renders an unreviewed refinement report without claiming missing checks or editor feedback', async () => {
  await staged(); const file = await current(), candidate = file.candidates[0]!, report = candidate.refinement!.notes
  report.editor_comments = []; report.unresolved = []; report.unhandled = []
  report.validation.semantic = { status: 'not_run', scenes: [], reason: '未进行语义检查。' }
  candidate.sha256 = candidateDigest(candidate)
  const rendered = renderModificationNotes(file, candidate)
  expect(rendered).toContain('无提供的编辑意见')
  expect(rendered).toContain('尚未进行')
  expect(rendered).toContain('不等同于全局通过')
  expect(renderModificationNotes(file, file.refinement!.baselines[0]!)).toBe('')
})

it('labels an advisory refinement decision as agent review without claiming independent evidence', async () => {
  const candidate = await staged(), file = await current()
  file.review_policy = 'advisory'
  candidate.review = { kind: 'advisory', actor, decision: 'approve', time: file.updated_at, reason: '核对原文后记录自主意见。' }
  const rendered = renderModificationNotes(file, candidate)
  expect(rendered).toContain('版本审查：advisory / approve')
  expect(rendered).toContain('Agent自主审校记录')
  expect(rendered).not.toContain('独立会话记录')
})

it('rejects missing grants, out-of-scope episodes, and report-free nonretained candidates', async () => {
  const originalFile = await current(original), baseline = originalFile.candidates[0]!
  expect(() => buildRefinement(originalFile, baseline, notes('钥匙在我手里。', '这把钥匙，在我手里。')))
    .toThrow('refinement_policy_required')
  await createFork(); const file = await current(), policy = file.refinement!
  const { sha256: _digest, ...content } = policy
  expect(refinementPolicyDigest(content)).toBe(policy.sha256)
  expect(() => { validateRefinement(file, baseline) }).toThrow('refinement_report_required')
  const future = { ...baseline, episode: 2 }
  expect(() => buildRefinement(file, future, notes('钥匙在我手里。', '这把钥匙，在我手里。'))).toThrow('refinement_scope')
})

it('does not report an unchanged source beat as an edit', async () => {
  await createFork([]); const file = await current(), baseline = file.refinement!.baselines[0]!
  expect(() => buildRefinement(file, baseline, notes('钥匙在我手里。', '钥匙在我手里。'))).toThrow('refinement_notes_empty')
})

it('rejects supplementary expression assigned to a different actor after source expressions are preserved', async () => {
  await staged(); const file = await current(), candidate = file.candidates[0]!
  file.facts.at(-1)!.actor = '乙'
  expect(() => { validateRefinement(file, candidate) }).toThrow('refinement_category')
})

it('renders source-only expression edits and separately validates retained candidates', async () => {
  await createFork([]); const file = await current(), baseline = file.refinement!.baselines[0]!
  const candidate = { ...baseline, scenes: structuredClone(baseline.scenes) }
  candidate.scenes[0]!.beats[0]!.text = '钥匙，就在我手里。'
  candidate.refinement = buildRefinement(file, candidate, {
    ...notes('钥匙在我手里。', '钥匙，就在我手里。'), editor_comments: [{ comment: '其他修改尚未处理。', disposition: 'not_adopted',
      reason: '超出这次范围。', change_indices: [] }],
  })
  candidate.sha256 = candidateDigest(candidate)
  expect(renderModificationNotes(file, candidate)).toContain('保留来源的表达调整')
  expect(renderModificationNotes(file, candidate)).toContain('修改条目 无')
  const policy = file.refinement!
  policy.retained_candidates = [{ id: baseline.id, sha256: baseline.sha256 }]
  policy.sha256 = refinementPolicyDigest(policy)
  expect(() => { validateRefinement(file, baseline) }).not.toThrow()
  policy.retained_candidates[0]!.sha256 = '0'.repeat(64); policy.sha256 = refinementPolicyDigest(policy)
  expect(() => { validateRefinement(file, baseline) }).toThrow('refinement_report_required')
  policy.retained_candidates[0]!.id = brandString<typeof baseline.id>('c:12345678-1234-4234-8234-123456789012')
  policy.sha256 = refinementPolicyDigest(policy)
  expect(() => { validateRefinement(file, baseline) }).toThrow('refinement_report_required')
})

it('does not invent a missing baseline read while deriving evidence from an incomplete artifact', async () => {
  await staged(); const file = await current(), candidate = file.candidates[0]!, baseline = file.refinement!.baselines[0]!
  candidate.refinement!.baseline_candidate_id = brandString<typeof baseline.id>('c:12345678-1234-4234-8234-123456789012')
  expect(requiredReads(file, candidate, 'candidate').some(read => read.id === baseline.id)).toBe(false)
  delete file.refinement
  expect(requiredReads(file, candidate, 'candidate').some(read => read.id === baseline.id)).toBe(false)
})

it('does not invent source units for unresolved imported coverage when deriving refinement evidence', async () => {
  await createFork(); const file = await current(), policy = file.refinement!, baseline = policy.baselines[0]!
  const source = file.sources[0]!, unit = source.units[0]!
  baseline.coverage = { windows: [{ source_id: brandString<typeof source.id>('s:12345678-1234-4234-8234-123456789012'), start: 1, count: 1 }],
    required_beats: [{ fact_id: file.facts[0]!.id, kind: 'os' }] }
  baseline.sha256 = candidateDigest(baseline); policy.sha256 = refinementPolicyDigest(policy)
  expect(() => { validateSupplement(file, { kind: 'thought', origin: 'adaptation', layer: 'present', actor: '甲',
    anchors: [{ unit_id: unit.id, quote: unit.text }], supplemental: { policy_sha256: policy.sha256, category: 'minimal_os',
      authorization_sha256: sha256(JSON.stringify(policy.authorization)) } }) }).not.toThrow()
  const candidate = { ...baseline, scenes: structuredClone(baseline.scenes) }
  candidate.scenes[0]!.beats[0]!.text = '钥匙，就在我手里。'
  candidate.refinement = buildRefinement(file, candidate, notes('钥匙在我手里。', '钥匙，就在我手里。'))
  candidate.sha256 = candidateDigest(candidate)
  expect(requiredReads(file, candidate, 'candidate').filter(read => read.kind === 'source')).toHaveLength(1)
  expect(validReview(file, candidate, 'candidate')).toBe(false)
})
