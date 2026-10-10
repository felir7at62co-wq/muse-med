/** Source, attribution, publication, and recovery through the actual local filesystem provider. */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { FsVersion } from '@deepseek-ai/dsh-fs'
import { Context } from '@deepseek-ai/cordis'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import sharp from 'sharp'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ActorId } from '../src/ids.ts'
import { ProjectCommands } from '../src/project.ts'
import { candidateDigest } from '../src/episode.ts'
import { PROJECT_FILE } from '../src/schema.ts'
import type { FactInput, ProjectRequest, SceneInput } from '../src/schema.ts'

let root: string
let path: string
let source: string
let ctx: Context
let commands: ProjectCommands
const limits = {
  maxSourceBytes: 1024 * 1024, maxProjectBytes: 4 * 1024 * 1024, maxReadUnits: 100, maxReadBytes: 64 * 1024, maxFactBatch: 20,
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'screenplay-project-'))
  path = join(root, 'project.json')
  source = join(root, 'source.txt')
  await writeFile(source, '甲想：我知道钥匙在哪里。\n作者认为：乙有些贪心。\n乙说：门开了。\n甲推开门。\n过去，甲想：我不会告诉乙。\n')
  ctx = new Context()
  await ctx.plugin(LocalFileSystem, { cwd: root })
  await ctx.plugin(LocalAttachmentStore, { dshHome: root })
  commands = new ProjectCommands(ctx.fs, limits, ctx.attachments)
  await run({ method: 'init', project: path, mode: 'faithful', instructions: '保留原始因果和人物知情顺序。' })
  await run({ method: 'import_source', project: path, expected_revision: 0, path: source, source_kind: 'text' })
})
afterEach(async () => {
  vi.restoreAllMocks()
  await ctx.fiber.dispose()
  await rm(root, { recursive: true, force: true })
})

async function run(request: ProjectRequest, actor = 'writer', signal = new AbortController().signal): Promise<object> {
  return commands.execute(request, { actor: brandString<ActorId>(actor), cwd: root, signal })
}
async function current() {
  return PROJECT_FILE.parse(JSON.parse(await readFile(path, 'utf8')))
}
async function fact(kind: FactInput['kind'], ordinal: number, actor?: string, layer: FactInput['layer'] = 'present') {
  const project = await current()
  const unit = project.sources[0]!.units[ordinal - 1]!
  await run({ method: 'propose_fact', project: path, expected_revision: project.revision,
    fact: { kind, origin: 'source', ...(actor === undefined ? {} : { actor }), layer, summary: unit.text,
      anchors: [{ unit_id: unit.id, quote: unit.text }] } })
  const proposed = await current()
  const record = proposed.facts.at(-1)!
  await run({ method: 'review_fact', project: path, expected_revision: proposed.revision, fact_id: record.id,
    decision: 'approve', reason: '原文对应，归属与叙述层核对通过。' }, 'reviewer')
  return record.id
}
function scene(id: string, kind: SceneInput['beats'][number]['kind'] = 'os', actor = '甲', witnesses: string[] = []): SceneInput {
  return { location: '门前', time: '日', layer: 'present', transition: 'opening', characters: ['甲', '乙'],
    beats: [{ kind, actor, text: '我知道钥匙在哪里。', fact_ids: [id], requires_knowledge: [], witnesses }] }
}
async function stage(scenes: SceneInput[]) {
  await run({ method: 'stage', project: path, expected_revision: (await current()).revision, episode: 1, scenes })
  return (await current()).candidates.at(-1)!
}
async function approveAndCommit(id: string, hash: string) {
  await run({ method: 'review', project: path, expected_revision: (await current()).revision,
    candidate_id: id, candidate_sha256: hash, decision: 'approve', reason: '已逐条核对原文、人物归属和场次。' }, 'reviewer')
  await run({ method: 'commit', project: path, expected_revision: (await current()).revision, candidate_id: id, candidate_sha256: hash })
}

async function videoProject(mode: 'faithful' | 'adaptation' = 'faithful') {
  path = join(root, 'qa', 'screenplay-project.json')
  await mkdir(join(root, 'qa'))
  await run({ method: 'init', project: path, mode, workflow: 'video_to_screenplay', instructions: '忠实视频整理，不推断未核实动作。' })
  await run({ method: 'import_source', project: path, expected_revision: 0, path: source, source_kind: 'text' })
  const frames = await inspection()
  await run({ method: 'import_source', project: path, expected_revision: 1, path: frames.manifest, source_kind: 'video_inspection' })
}

async function visualAction(actor: string | null = '甲', includeText = false) {
  const project = await current(), unit = project.sources[1]!.units[0]!
  const text = project.sources[0]!.units[3]!
  await run({ method: 'propose_fact', project: path, expected_revision: project.revision,
    fact: { kind: 'action', origin: 'source', ...(actor === null ? {} : { actor }), layer: 'present',
      summary: actor === null ? '未确认人物推门，旁人后退。' : '甲推开门，乙后退。',
      anchors: [{ unit_id: unit.id, quote: unit.text }, ...(includeText ? [{ unit_id: text.id, quote: text.text }] : [])] } })
  const proposed = await current(), record = proposed.facts.at(-1)!
  await run({ method: 'review_fact', project: path, expected_revision: proposed.revision, fact_id: record.id,
    decision: 'approve', reason: '固定测试事实：关键无对白事件与人物反应。' }, 'reviewer')
  return record.id
}

async function videoStage(scenes: SceneInput[], required: { fact_id: string; kind: SceneInput['beats'][number]['kind'] }[]) {
  const project = await current()
  await run({ method: 'stage', project: path, expected_revision: project.revision, episode: 1, scenes,
    coverage: { windows: project.sources.map(value => ({ source_id: value.id, start: 1, count: value.units.length })),
      required_beats: required } })
  return (await current()).candidates.at(-1)!
}

it('video: refuses writing before visual preparation instead of accepting an audio-only draft', async () => {
  await videoProject()
  const speech = await fact('speech', 3, '乙')
  await expect(stage([scene(speech, 'dialogue', '乙')])).rejects.toThrow('visual_preparation_required')
})

it('video: rejects a missing silent key action and reaction even when all dialogue is present', async () => {
  await videoProject()
  const action = await visualAction(), speech = await fact('speech', 3, '乙')
  await expect(videoStage([scene(speech, 'dialogue', '乙')], [{ fact_id: action, kind: 'action' }, { fact_id: speech, kind: 'dialogue' }]))
    .rejects.toThrow('source_coverage')
})

it('video: refuses action inferred solely from text despite having imported frames', async () => {
  await videoProject()
  const action = await fact('action', 4, '甲')
  await expect(videoStage([scene(action, 'action')], [{ fact_id: action, kind: 'action' }])).rejects.toThrow('visual_fact_evidence')
})

it.each([
  { kind: 'vo' as const, retained: false }, { kind: 'vo' as const, retained: true },
  { kind: 'os' as const, retained: false }, { kind: 'os' as const, retained: true },
  { kind: 'dialogue' as const, retained: false }, { kind: 'dialogue' as const, retained: true },
])('video: rejects converting a source action into $kind, action retained=$retained', async ({ kind, retained }) => {
  await videoProject()
  const action = await visualAction('甲', true), converted = scene(action, kind)
  converted.beats[0]!.text = '甲推开门，乙后退。'
  if (retained) converted.beats.unshift({ ...converted.beats[0]!, kind: 'action' })
  await expect(videoStage([converted], [{ fact_id: action, kind: retained ? 'action' : kind }]))
    .rejects.toThrow(retained ? 'voice_source_evidence' : 'source_coverage')
  expect((await current()).candidates).toHaveLength(0)
})

it('keeps existing novel action narration available outside the managed video workflow', async () => {
  const action = await fact('action', 4, '甲'), narration = scene(action, 'vo')
  narration.beats[0]!.text = '甲推开门。'
  const candidate = await stage([narration])
  await approveAndCommit(candidate.id, candidate.sha256)
  await run({ method: 'export', project: path, candidate_id: candidate.id, directory: join(root, 'final') })
  expect((await current()).accepted).toEqual([candidate.id])
})

it.each(['os', 'vo'] as const)('video: rejects omission of an existing %s source fact', async (kind) => {
  await videoProject()
  const voice = await fact(kind === 'os' ? 'thought' : 'author_analysis', kind === 'os' ? 1 : 2,
    kind === 'os' ? '甲' : undefined, kind === 'os' ? 'present' : 'commentary')
  const speech = await fact('speech', 3, '乙')
  await expect(videoStage([scene(speech, 'dialogue', '乙')], [{ fact_id: voice, kind }, { fact_id: speech, kind: 'dialogue' }]))
    .rejects.toThrow('source_coverage')
})

it('video: a zero-action candidate requires a specific independent recheck', async () => {
  await videoProject()
  const speech = await fact('speech', 3, '乙'), candidate = await videoStage([scene(speech, 'dialogue', '乙')], [{ fact_id: speech, kind: 'dialogue' }])
  await expect(run({ method: 'review', project: path, expected_revision: (await current()).revision,
    candidate_id: candidate.id, candidate_sha256: candidate.sha256, decision: 'approve', reason: '格式合格。' }, 'reviewer'))
    .rejects.toThrow('zero_action_review_required')
})

it('video: independently verified dialogue-only material passes and survives context recovery', async () => {
  await videoProject()
  const speech = await fact('speech', 3, '乙'), candidate = await videoStage([scene(speech, 'dialogue', '乙')], [{ fact_id: speech, kind: 'dialogue' }])
  await run({ method: 'review', project: path, expected_revision: (await current()).revision,
    candidate_id: candidate.id, candidate_sha256: candidate.sha256, decision: 'approve', reason: '人物归属核对。',
    zero_action_reason: '复核两个实际帧及完整发声；本固定片段无需要保留的动作，不增加剧情。' }, 'reviewer')
  commands = new ProjectCommands(ctx.fs, limits, ctx.attachments)
  await run({ method: 'commit', project: path, expected_revision: (await current()).revision, candidate_id: candidate.id, candidate_sha256: candidate.sha256 })
  expect(await run({ method: 'status', project: path })).toMatchObject({ workflow: 'video_to_screenplay', next_episode: 2 })
  expect((await current()).candidates[0]!.coverage).toBeDefined()
  await run({ method: 'export', project: path, candidate_id: candidate.id, directory: join(root, 'final') })
})

it('video: source-backed action, reaction and dialogue pass without fabricating narration', async () => {
  await videoProject()
  const action = await visualAction(), speech = await fact('speech', 3, '乙')
  const combined = scene(action, 'action');combined.beats.push(...scene(speech, 'dialogue', '乙').beats)
  const candidate = await videoStage([combined], [{ fact_id: action, kind: 'action' }, { fact_id: speech, kind: 'dialogue' }])
  await approveAndCommit(candidate.id, candidate.sha256)
  expect((await current()).accepted).toEqual([candidate.id])
})

it('video: cannot hide an approved key action by omitting it from the required inventory', async () => {
  await videoProject()
  await visualAction()
  const speech = await fact('speech', 3, '乙')
  await expect(videoStage([scene(speech, 'dialogue', '乙')], [{ fact_id: speech, kind: 'dialogue' }])).rejects.toThrow('source_coverage')
})

it('video: refuses writing while a source fact still awaits independent classification review', async () => {
  await videoProject()
  const speech = await fact('speech', 3, '乙'), project = await current(), unit = project.sources[1]!.units[0]!
  await run({ method: 'propose_fact', project: path, expected_revision: project.revision,
    fact: { kind: 'action', origin: 'source', actor: '甲', layer: 'present', summary: '甲推门。', anchors: [{ unit_id: unit.id, quote: unit.text }] } })
  await expect(videoStage([scene(speech, 'dialogue', '乙')], [{ fact_id: speech, kind: 'dialogue' }])).rejects.toThrow('unreviewed_source_fact')
})

it('video: refuses reassignment of a visual action to another participant', async () => {
  await videoProject()
  const action = await visualAction()
  await expect(videoStage([scene(action, 'action', '乙')], [{ fact_id: action, kind: 'action' }])).rejects.toThrow('action_attribution')
})

it('video: adaptation mode does not permit invented actions in a managed source conversion', async () => {
  await videoProject('adaptation')
  const speech = await fact('speech', 3, '乙'), project = await current()
  await run({ method: 'propose_fact', project: path, expected_revision: project.revision,
    fact: { kind: 'action', origin: 'adaptation', actor: '甲', layer: 'present', summary: '甲跳舞。', anchors: [], adaptation_reason: '补动作。' } })
  const proposed = await current(), invented = proposed.facts.at(-1)!
  await run({ method: 'review_fact', project: path, expected_revision: proposed.revision, fact_id: invented.id,
    decision: 'approve', reason: '无视觉依据的新增事件。' }, 'reviewer')
  const scenes = scene(invented.id, 'action'); scenes.beats.push(...scene(speech, 'dialogue', '乙').beats)
  await expect(videoStage([scenes], [{ fact_id: speech, kind: 'dialogue' }])).rejects.toThrow('visual_fact_evidence')
})

it.each(['dialogue', 'os', 'vo'] as const)('video: rejects %s inferred from a visual reference alone', async (kind) => {
  await videoProject()
  const project = await current(), unit = project.sources[1]!.units[0]!
  await run({ method: 'propose_fact', project: path, expected_revision: project.revision,
    fact: { kind: kind === 'dialogue' ? 'speech' : kind === 'os' ? 'thought' : 'author_analysis', origin: 'source',
      ...(kind === 'vo' ? {} : { actor: '甲' }), layer: kind === 'vo' ? 'commentary' : 'present',
      summary: '由画面推断的发声或内心。', anchors: [{ unit_id: unit.id, quote: unit.text }] } })
  const proposed = await current(), id = proposed.facts.at(-1)!.id
  await run({ method: 'review_fact', project: path, expected_revision: proposed.revision, fact_id: id,
    decision: 'approve', reason: '本用例检验独立批准也不能补造来源发声。' }, 'reviewer')
  const draft = scene(id, kind)
  if (kind === 'vo') delete draft.beats[0]!.actor
  await expect(videoStage([draft], [{ fact_id: id, kind }])).rejects.toThrow('voice_source_evidence')
})

it('video: rejects invented narration alongside correctly sourced dialogue', async () => {
  await videoProject('adaptation')
  const speech = await fact('speech', 3, '乙'), project = await current()
  await run({ method: 'propose_fact', project: path, expected_revision: project.revision,
    fact: { kind: 'author_analysis', origin: 'adaptation', layer: 'commentary', summary: '一段新增旁白。', anchors: [], adaptation_reason: '补叙事。' } })
  const proposed = await current(), id = proposed.facts.at(-1)!.id
  await run({ method: 'review_fact', project: path, expected_revision: proposed.revision, fact_id: id,
    decision: 'approve', reason: '批准新增旁白不能变成视频原有内容。' }, 'reviewer')
  const draft = scene(speech, 'dialogue', '乙')
  draft.beats.push({ kind: 'vo', text: '一段新增旁白。', fact_ids: [id], requires_knowledge: [], witnesses: [] })
  await expect(videoStage([draft], [{ fact_id: speech, kind: 'dialogue' }])).rejects.toThrow('video_source_fact_required')
})

it('video: rejects assignment of an unidentified visual actor to a named character', async () => {
  await videoProject()
  const action = await visualAction(null)
  await expect(videoStage([scene(action, 'action')], [{ fact_id: action, kind: 'action' }])).rejects.toThrow('action_attribution')
})

it('video: resumes bounded scene files and source windows without losing coverage or original OS/VO', async () => {
  await videoProject()
  const action = await visualAction(), thought = await fact('thought', 1, '甲')
  const voice = await fact('author_analysis', 2, undefined, 'commentary'), speech = await fact('speech', 3, '乙')
  const first = scene(action, 'action')
  first.beats.push(...scene(thought, 'os').beats)
  const second = { ...scene(speech, 'dialogue', '乙'), transition: 'continuous' as const }
  second.beats.push({ kind: 'vo', text: '作者认为：乙有些贪心。', fact_ids: [voice], requires_knowledge: [], witnesses: [] })
  const files = [join(root, 'chunk-1.json'), join(root, 'chunk-2.json')]
  await writeFile(files[0]!, JSON.stringify(first)); await writeFile(files[1]!, JSON.stringify(second))
  commands = new ProjectCommands(ctx.fs, limits, ctx.attachments)
  const project = await current()
  const windows = project.sources.flatMap(source => source.units.map(unit => ({ source_id: source.id, start: unit.ordinal, count: 1 })))
  await run({ method: 'stage_files', project: path, expected_revision: project.revision, episode: 1, files,
    coverage: { windows,
      required_beats: [{ fact_id: action, kind: 'action' }, { fact_id: thought, kind: 'os' }, { fact_id: voice, kind: 'vo' }, { fact_id: speech, kind: 'dialogue' }] } })
  const candidate = (await current()).candidates.at(-1)!
  await approveAndCommit(candidate.id, candidate.sha256)
  const output = join(root, 'final')
  await run({ method: 'export', project: path, candidate_id: candidate.id, directory: output })
  const names = await import('node:fs/promises').then(fs => fs.readdir(output))
  const text = await readFile(join(output, names.find(name => name.endsWith('.md'))!), 'utf8')
  expect(text).toContain('（OS）：'); expect(text).toContain('（VO）：'); expect(text).toContain('▲')
})

it('rejects an author judgement converted into a character OS without advancing the project', async () => {
  const id = await fact('author_analysis', 2, undefined, 'commentary')
  const before = await readFile(path, 'utf8')
  await expect(stage([scene(id)])).rejects.toThrow(/narrative_layer|os_attribution/)
  expect(await readFile(path, 'utf8')).toBe(before)
})

it('withdraws mistaken approval without erasing its review and blocks reuse in a new draft', async () => {
  const id = await fact('thought', 1, '甲')
  const before = await current()
  await run({ method: 'withdraw_fact', project: path, expected_revision: before.revision, fact_id: id,
    reason: '独立复核发现原判断不成立；更正事实另行提交。' }, 'verifier')
  const after = await current()
  expect(after.revision).toBe(before.revision + 1)
  expect(after.facts[0]!.review).toEqual(before.facts[0]!.review)
  expect(after.facts[0]!.withdrawal).toMatchObject({ actor: 'verifier', reason: '独立复核发现原判断不成立；更正事实另行提交。' })
  await expect(stage([scene(id)])).rejects.toThrow('withdrawn_fact')
  await expect(run({ method: 'withdraw_fact', project: path, expected_revision: after.revision, fact_id: id,
    reason: '重复撤销。' }, 'verifier')).rejects.toThrow('fact_withdrawn')
  expect(await current()).toEqual(after)
})

it('rejects absent, unapproved, self-authored or unexplained withdrawals before publication', async () => {
  const id = await fact('thought', 1, '甲')
  const before = await readFile(path, 'utf8')
  const request = { method: 'withdraw_fact', project: path, expected_revision: (await current()).revision,
    fact_id: id, reason: '独立复核错误。' } as const
  await expect(run({ ...request, fact_id: 'missing' }, 'verifier')).rejects.toThrow('fact_approval')
  await expect(run(request)).rejects.toThrow('self_review')
  await expect(run({ ...request, reason: '  ' }, 'verifier')).rejects.toThrow('review_reason')
  expect(await readFile(path, 'utf8')).toBe(before)
  const rejected = await current()
  rejected.facts[0]!.review!.decision = 'reject'
  await writeFile(path, JSON.stringify(rejected))
  await expect(run(request, 'verifier')).rejects.toThrow('fact_approval')
})

it('requires a revision fork when a mistaken fact already supports a candidate and preserves the original export', async () => {
  const id = await fact('thought', 1, '甲')
  const candidate = await stage([scene(id)])
  await approveAndCommit(candidate.id, candidate.sha256)
  const directory = join(root, 'original-final')
  await run({ method: 'export', project: path, candidate_id: candidate.id, directory })
  const exported = join(directory, `episode-1-${candidate.id.slice(2)}.md`)
  const original = await readFile(path, 'utf8'), text = await readFile(exported, 'utf8')
  await expect(run({ method: 'withdraw_fact', project: path, expected_revision: (await current()).revision,
    fact_id: id, reason: '原事实错误。' }, 'verifier')).rejects.toThrow('fact_in_history')
  const destination = join(root, 'correction.json')
  await run({ method: 'fork_project', project: path, expected_revision: (await current()).revision,
    destination, before_episode: 1 })
  await run({ method: 'withdraw_fact', project: destination, expected_revision: 0, fact_id: id,
    reason: '在修订项目中撤销，不改原版本。' }, 'verifier')
  expect(await readFile(path, 'utf8')).toBe(original)
  expect(await readFile(exported, 'utf8')).toBe(text)
  expect(PROJECT_FILE.parse(JSON.parse(await readFile(destination, 'utf8'))).facts[0]!.withdrawal).toBeDefined()
})

it('protects knowledge prerequisites as well as direct references when withdrawing facts', async () => {
  const prior = await fact('thought', 1, '甲'), later = await fact('thought', 1, '甲')
  const first = await stage([scene(prior)])
  await approveAndCommit(first.id, first.sha256)
  const next = scene(later)
  next.beats[0]!.requires_knowledge = [prior]
  await run({ method: 'stage', project: path, expected_revision: (await current()).revision, episode: 2, scenes: [next] })
  const stored = await current()
  stored.candidates.reverse()
  await writeFile(path, JSON.stringify(stored))
  await expect(run({ method: 'withdraw_fact', project: path, expected_revision: stored.revision,
    fact_id: prior, reason: '检查知情引用。' }, 'verifier')).rejects.toThrow('fact_in_history')
})

it('rejects malformed persisted withdrawals and permits withdrawing facts unrelated to a saved candidate', async () => {
  const kept = await fact('thought', 1, '甲'), unused = await fact('thought', 1, '甲')
  await stage([scene(kept)])
  const original = await current()
  for (const [id, actor, decision] of [[unused, 'writer', 'approve'], [unused, 'verifier', 'reject'], [kept, 'verifier', 'approve']] as const) {
    const invalid = structuredClone(original), record = invalid.facts.find(item => item.id === id)!
    record.review!.decision = decision
    record.withdrawal = { actor: brandString<ActorId>(actor), time: new Date().toISOString(), reason: '更正。' }
    await writeFile(path, JSON.stringify(invalid))
    await expect(run({ method: 'status', project: path })).rejects.toThrow('invalid_withdrawal')
  }
  await writeFile(path, JSON.stringify(original))
  await run({ method: 'withdraw_fact', project: path, expected_revision: original.revision, fact_id: unused,
    reason: '无候选依赖的旧事实撤销。' }, 'verifier')
  const saved = await current()
  expect(saved.candidates).toEqual(original.candidates)
  expect(saved.facts.find(item => item.id === unused)!.withdrawal).toBeDefined()
  expect(candidateDigest(saved.candidates[0]!))
    .toBe(saved.candidates[0]!.sha256)
})

it('rejects another character’s private thought and never informs an on-scene listener', async () => {
  const id = await fact('thought', 1, '甲')
  await expect(stage([scene(id, 'os', '乙')])).rejects.toThrow('os_attribution')
  await expect(stage([scene(id, 'os', '甲', ['乙'])])).rejects.toThrow('private_knowledge')
  const candidate = await stage([scene(id)])
  await approveAndCommit(candidate.id, candidate.sha256)
  const status = await run({ method: 'status', project: path })
  expect(status).toMatchObject({ next_episode: 2, knowledge: { 'present:甲': [id] } })
  expect(status).not.toHaveProperty('knowledge.present:乙')
})

it('rejects a shifted source index and a mismatched quotation', async () => {
  const project = await current()
  await expect(run({ method: 'propose_fact', project: path, expected_revision: project.revision,
    fact: { kind: 'thought', origin: 'source', actor: '甲', layer: 'present', summary: '甲知道钥匙。',
      anchors: [{ unit_id: project.sources[0]!.units[1]!.id, quote: '甲想：我知道钥匙在哪里。' }] } })).rejects.toThrow('source_quote_mismatch')
  expect((await current()).facts).toEqual([])
})

it('blocks self review, stale candidate digests, and delivery before independent acceptance', async () => {
  const id = await fact('thought', 1, '甲')
  const candidate = await stage([scene(id)])
  const revision = (await current()).revision
  await expect(run({ method: 'review', project: path, expected_revision: revision, candidate_id: candidate.id,
    candidate_sha256: candidate.sha256, decision: 'approve', reason: '通过。' })).rejects.toThrow('self_review')
  await expect(run({ method: 'review', project: path, expected_revision: revision, candidate_id: candidate.id,
    candidate_sha256: '0'.repeat(64), decision: 'approve', reason: '通过。' }, 'reviewer')).rejects.toThrow('candidate_review_state')
  await expect(run({ method: 'commit', project: path, expected_revision: revision, candidate_id: candidate.id,
    candidate_sha256: candidate.sha256 })).rejects.toThrow('review_required')
  await expect(run({ method: 'export', project: path, candidate_id: candidate.id, directory: join(root, 'final') })).rejects.toThrow('export_unaccepted')
  expect((await current()).accepted).toEqual([])
})

it('requires explicit flashback entry and return to the present', async () => {
  const now = await fact('thought', 1, '甲')
  const past = await fact('thought', 5, '甲', 'flashback')
  const scenes = [scene(now), { ...scene(past), layer: 'flashback' as const, transition: 'cut' as const }]
  await expect(stage(scenes)).rejects.toThrow('flashback_entry')
  scenes[1]!.transition = 'enter_flashback'
  const ending = { ...scene(now), transition: 'cut' as const }
  await expect(stage([...scenes, ending])).rejects.toThrow('flashback_return')
  await stage([...scenes, { ...ending, transition: 'return_present' }])
})

it('rejects imaginary observations used as real-world knowledge', async () => {
  const id = await fact('speech', 3, '乙', 'imagined')
  const dreamed = { ...scene(id, 'dialogue', '乙', ['甲']), layer: 'imagined' as const }
  const realFact = await fact('thought', 1, '甲')
  const real = { ...scene(realFact), transition: 'cut' as const }
  real.beats[0]!.requires_knowledge = [id]
  await expect(stage([dreamed, real])).rejects.toThrow('knowledge_not_acquired')
})

it('blocks a silent scene change and using private knowledge before it is acquired', async () => {
  const id = await fact('thought', 1, '甲')
  const first = scene(id)
  const changed = { ...scene(id), location: '厨房', transition: 'continuous' as const }
  await expect(stage([first, changed])).rejects.toThrow('scene_continuity')
  first.beats[0]!.requires_knowledge = [id]
  await expect(stage([first])).rejects.toThrow('knowledge_not_acquired')
})

it('does not publish cancelled mutations and preserves stale concurrent write protection', async () => {
  const project = await current()
  const controller = new AbortController()
  controller.abort(Error('cancelled'))
  await expect(run({ method: 'import_source', project: path, expected_revision: project.revision, path: source, source_kind: 'text' }, 'writer', controller.signal)).rejects.toThrow('cancelled')
  await expect(run({ method: 'import_source', project: path, expected_revision: 0, path: source, source_kind: 'text' })).rejects.toThrow('stale_revision')
  expect((await current()).revision).toBe(project.revision)
})

it('resumes an accepted episode without rewriting history and exports reproducible line references', async () => {
  const id = await fact('thought', 1, '甲')
  const candidate = await stage([scene(id)])
  await approveAndCommit(candidate.id, candidate.sha256)
  const before = await readFile(path, 'utf8')
  commands = new ProjectCommands(ctx.fs, limits, ctx.attachments)
  expect(await run({ method: 'status', project: path })).toMatchObject({ next_episode: 2 })
  await expect(run({ method: 'commit', project: path, expected_revision: (await current()).revision,
    candidate_id: candidate.id, candidate_sha256: candidate.sha256 })).rejects.toThrow('episode_order')
  const directory = join(root, 'final')
  const result = await run({ method: 'export', project: path, candidate_id: candidate.id, directory })
  expect(await run({ method: 'export', project: path, candidate_id: candidate.id, directory })).toEqual(result)
  const basename = `episode-1-${candidate.id.slice(2)}`
  const map: unknown = JSON.parse(await readFile(join(directory, `${basename}.sources.json`), 'utf8'))
  const script = await readFile(join(directory, `${basename}.md`), 'utf8')
  const line = script.split('\n').indexOf('甲（OS）：我知道钥匙在哪里。') + 1
  expect(line).toBeGreaterThan(0)
  expect(map).toMatchObject({ lines: [{ line, source_units: [(await current()).sources[0]!.units[0]!.id] }] })
  expect(await readFile(path, 'utf8')).toBe(before)
})

it('detects a changed original source and malformed persisted candidates', async () => {
  const id = await fact('thought', 1, '甲')
  await stage([scene(id)])
  const saved = await readFile(source, 'utf8')
  await writeFile(source, '被替换的原文')
  await expect(run({ method: 'status', project: path })).rejects.toThrow('source_changed')
  await writeFile(source, saved)
  const project = await current()
  project.candidates[0]!.scenes[0]!.beats[0]!.text = '私自改过的正文'
  await writeFile(path, JSON.stringify(project))
  await expect(run({ method: 'status', project: path })).rejects.toThrow('invalid_candidate_digest')
})

it('preserves original one-based transcript order, timing, and known speaker ids', async () => {
  const transcript = join(root, 'transcript.json')
  await writeFile(transcript, JSON.stringify({ segments: [
    { start: 1.1, end: 2, text: '门开了。', speaker_id: 'speaker_2' },
    { start: 3, end: 4, text: '我不会告诉你。' },
  ] }))
  await run({ method: 'import_source', project: path, expected_revision: (await current()).revision, path: transcript, source_kind: 'transcript' })
  const imported = (await current()).sources[1]!
  expect(await run({ method: 'read_source', project: path, source_id: imported.id, start: 1, count: 1 }))
    .toMatchObject({ next: 2, units: [{ ordinal: 1, start: 1.1, end: 2, speaker_id: 'speaker_2' }] })
  expect(imported.units[1]).not.toHaveProperty('speaker_id')
})

it('imports the segment-array JSON actually published by audio_transcribe', async () => {
  const transcript = join(root, 'actual-audio-transcribe.json')
  await writeFile(transcript, JSON.stringify([{ start: 0, end: 1, text: '门开了。', words: [{ start: 0, end: 0.5, text: '门' }] }]))
  await run({ method: 'import_source', project: path, expected_revision: (await current()).revision, path: transcript, source_kind: 'transcript' })
  expect((await current()).sources[1]!.units).toHaveLength(1)
})

it('rejects missing project files, directories, and a file changed during its read', async () => {
  await expect(run({ method: 'status', project: join(root, 'missing.json') })).rejects.toThrow('missing_project')
  await mkdir(join(root, 'directory'))
  await expect(run({ method: 'status', project: join(root, 'directory') })).rejects.toThrow('missing_project')
  const target = await ctx.fs.resolve(path, { signal: new AbortController().signal })
  const original = (await ctx.fs.stat(target, new AbortController().signal))!
  vi.spyOn(ctx.fs, 'stat').mockResolvedValueOnce(original).mockResolvedValueOnce({ ...original, version: FsVersion('changed') })
  await expect(run({ method: 'status', project: path })).rejects.toThrow('stale_read')
})

it('rejects empty directions, duplicate initialization, and project allocation overflow', async () => {
  const other = join(root, 'other.json')
  await expect(run({ method: 'init', project: other, mode: 'faithful', instructions: ' ' })).rejects.toThrow('missing_direction')
  await expect(run({ method: 'init', project: path, mode: 'faithful', instructions: '方向' })).rejects.toThrow()
  commands = new ProjectCommands(ctx.fs, { ...limits, maxProjectBytes: 100 }, ctx.attachments)
  await expect(run({ method: 'init', project: other, mode: 'faithful', instructions: '方向' })).rejects.toThrow('project_size')
})

it('refuses duplicate originals and enforces one-based unit and byte read budgets without truncation', async () => {
  const project = await current()
  const id = project.sources[0]!.id
  await expect(run({ method: 'import_source', project: path, expected_revision: project.revision, path: source, source_kind: 'text' })).rejects.toThrow('duplicate_source')
  await expect(run({ method: 'read_source', project: path, source_id: 'missing', start: 1, count: 1 })).rejects.toThrow('missing_source')
  for (const [start, count] of [[0, 1], [1, 0], [1, 101], [7, 1]]) {
    await expect(run({ method: 'read_source', project: path, source_id: id, start: start!, count: count! })).rejects.toThrow('source_window')
  }
  expect(await run({ method: 'read_source', project: path, source_id: id, start: 1, count: 100 })).toMatchObject({ next: null })
  commands = new ProjectCommands(ctx.fs, { ...limits, maxReadBytes: 1 }, ctx.attachments)
  await expect(run({ method: 'read_source', project: path, source_id: id, start: 1, count: 1 })).rejects.toThrow('source_window_bytes')
})

it.each([
  ['empty_fact', { summary: ' ' }],
  ['fact_actor', { kind: 'speech' as const }],
  ['author_attribution', { kind: 'author_analysis' as const, actor: '甲', layer: 'commentary' as const }],
  ['author_attribution', { kind: 'author_analysis' as const }],
  ['missing_source', {}],
  ['adaptation_direction', { origin: 'adaptation' as const, adaptation_reason: '改编理由' }],
])('rejects %s before a source fact is persisted', async (message, fields) => {
  const project = await current()
  await expect(run({ method: 'propose_fact', project: path, expected_revision: project.revision,
    fact: { kind: 'action', origin: 'source', layer: 'present', summary: '动作', anchors: [], ...fields } })).rejects.toThrow(message)
  expect((await current()).facts).toEqual([])
})

it('requires an adaptation reason and persists approved changed events separately from original facts', async () => {
  const other = join(root, 'adaptation.json')
  await run({ method: 'init', project: other, mode: 'adaptation', instructions: '人物改为同事，保留因果。' })
  const input: FactInput = { kind: 'action', origin: 'adaptation', layer: 'present', summary: '甲打开办公室的门。', anchors: [] }
  await expect(run({ method: 'propose_fact', project: other, expected_revision: 0, fact: input })).rejects.toThrow('adaptation_direction')
  await run({ method: 'propose_fact', project: other, expected_revision: 0, fact: { ...input, adaptation_reason: '按用户已确定的职场方向转换地点。' } })
  expect(PROJECT_FILE.parse(JSON.parse(await readFile(other, 'utf8'))).facts[0]!.origin).toBe('adaptation')
})

it('binds references to a known unit and a nonblank exact quote', async () => {
  const project = await current()
  for (const anchor of [{ unit_id: 'missing', quote: '甲' }, { unit_id: project.sources[0]!.units[0]!.id, quote: ' ' }]) {
    await expect(run({ method: 'propose_fact', project: path, expected_revision: project.revision,
      fact: { kind: 'action', origin: 'source', layer: 'present', summary: '动作', anchors: [anchor] } })).rejects.toThrow('source_quote_mismatch')
  }
})

it('does not permit a fact proposer to approve itself, blank reviews, or revising a recorded rejection', async () => {
  const project = await current()
  const unit = project.sources[0]!.units[0]!
  await run({ method: 'propose_fact', project: path, expected_revision: project.revision,
    fact: { kind: 'thought', origin: 'source', actor: '甲', layer: 'present', summary: unit.text, anchors: [{ unit_id: unit.id, quote: unit.text }] } })
  const proposed = await current()
  const id = proposed.facts[0]!.id
  const review = { method: 'review_fact', project: path, expected_revision: proposed.revision, fact_id: id, decision: 'reject', reason: '归属有误。' } as const
  await expect(run(review)).rejects.toThrow('self_review')
  await expect(run({ ...review, fact_id: 'missing' }, 'reviewer')).rejects.toThrow('fact_review_state')
  await expect(run({ ...review, reason: ' ' }, 'reviewer')).rejects.toThrow('review_reason')
  await run(review, 'reviewer')
  await expect(run({ ...review, expected_revision: (await current()).revision }, 'reviewer')).rejects.toThrow('fact_review_state')
  expect(await run({ method: 'read_fact', project: path, fact_id: id })).toMatchObject({ fact: { review: { decision: 'reject' } } })
  await expect(run({ method: 'read_fact', project: path, fact_id: 'missing' })).rejects.toThrow('missing_fact')
  await expect(stage([scene(id)])).rejects.toThrow('unapproved_fact')
})

it('retains complete rejected candidates while refusing their acceptance', async () => {
  const id = await fact('thought', 1, '甲')
  const candidate = await stage([scene(id)])
  await expect(run({ method: 'read_candidate', project: path, candidate_id: 'missing' })).rejects.toThrow('missing_candidate')
  expect(await run({ method: 'read_candidate', project: path, candidate_id: candidate.id })).toMatchObject({
    candidate: { id: candidate.id }, facts: [{ id }],
  })
  expect(await run({ method: 'read_candidate', project: path, candidate_id: candidate.id }))
    .toHaveProperty('rendered.script', expect.stringContaining('甲（OS）'))
  const review = { method: 'review', project: path, expected_revision: (await current()).revision,
    candidate_id: candidate.id, candidate_sha256: candidate.sha256, decision: 'reject', reason: '因果尚需核对。' } as const
  await expect(run({ ...review, reason: ' ' }, 'reviewer')).rejects.toThrow('review_reason')
  await run(review, 'reviewer')
  await expect(run({ ...review, expected_revision: (await current()).revision }, 'reviewer')).rejects.toThrow('candidate_review_state')
  await expect(run({ method: 'commit', project: path, expected_revision: (await current()).revision,
    candidate_id: candidate.id, candidate_sha256: candidate.sha256 })).rejects.toThrow('review_required')
  expect((await current()).candidates[0]!.review!.reason).toBe('因果尚需核对。')
})

it('requires the current candidate digest and invalidates competing drafts once a preceding episode advances', async () => {
  const id = await fact('thought', 1, '甲')
  const first = await stage([scene(id)])
  const second = await stage([scene(id)])
  await expect(run({ method: 'commit', project: path, expected_revision: (await current()).revision,
    candidate_id: first.id, candidate_sha256: '0'.repeat(64) })).rejects.toThrow('candidate_digest')
  await approveAndCommit(first.id, first.sha256)
  await expect(run({ method: 'review', project: path, expected_revision: (await current()).revision,
    candidate_id: second.id, candidate_sha256: second.sha256, decision: 'approve', reason: '核对。' }, 'reviewer')).rejects.toThrow('candidate_base_changed')
  await expect(stage([scene(id)])).rejects.toThrow('episode_order')
  await run({ method: 'stage', project: path, expected_revision: (await current()).revision, episode: 2, scenes: [scene(id)] })
  const next = (await current()).candidates.at(-1)!
  await approveAndCommit(next.id, next.sha256)
  expect(await run({ method: 'status', project: path })).toMatchObject({ next_episode: 3, accepted: [{ episode: 1 }, { episode: 2 }] })
})

it('detects forged source indexes, duplicate identities and a self-approved persisted fact', async () => {
  const id = await fact('thought', 1, '甲')
  const original = await current()
  const altered = structuredClone(original)
  altered.sources[0]!.units[0]!.text = '伪造来源片段'
  await writeFile(path, JSON.stringify(altered))
  await expect(run({ method: 'status', project: path })).rejects.toThrow('source_quote_mismatch')
  altered.facts = []
  await writeFile(path, JSON.stringify(altered))
  await expect(run({ method: 'status', project: path })).rejects.toThrow('source_index_changed')
  const duplicate = structuredClone(original)
  duplicate.facts.push(duplicate.facts[0]!)
  await writeFile(path, JSON.stringify(duplicate))
  await expect(run({ method: 'status', project: path })).rejects.toThrow('invalid_project')
  original.facts.find(fact => fact.id === id)!.review!.actor = brandString<ActorId>('writer')
  await writeFile(path, JSON.stringify(original))
  await expect(run({ method: 'status', project: path })).rejects.toThrow('invalid_project')
})

it('rejects backward transcript intervals without changing source history', async () => {
  const transcript = join(root, 'backward.json')
  await writeFile(transcript, JSON.stringify([{ start: 2, end: 1, text: '错误时间' }]))
  await expect(run({ method: 'import_source', project: path, expected_revision: (await current()).revision,
    path: transcript, source_kind: 'transcript' })).rejects.toThrow('transcript_time')
  expect((await current()).sources).toHaveLength(1)
})

it('leaves an accepted version unchanged when the user edits exported text or export meets a filesystem error', async () => {
  const id = await fact('thought', 1, '甲')
  const candidate = await stage([scene(id)])
  await approveAndCommit(candidate.id, candidate.sha256)
  const directory = join(root, 'final')
  await run({ method: 'export', project: path, candidate_id: candidate.id, directory })
  const output = join(directory, `episode-1-${candidate.id.slice(2)}.md`)
  await writeFile(output, '用户修订')
  await expect(run({ method: 'export', project: path, candidate_id: candidate.id, directory })).rejects.toThrow('export_changed')
  expect(await readFile(output, 'utf8')).toBe('用户修订')
  vi.spyOn(ctx.fs, 'writeText').mockRejectedValueOnce(Error('storage unavailable'))
  await expect(run({ method: 'export', project: path, candidate_id: candidate.id, directory: join(root, 'other') })).rejects.toThrow('storage unavailable')
  expect((await current()).accepted).toEqual([candidate.id])
})

it('recovers all fact identities in bounded original order after a writer exits without returning its IDs', async () => {
  expect(await run({ method: 'list_facts', project: path, start: 1, count: 1 })).toMatchObject({ facts: [], next: null })
  const first = await fact('thought', 1, '甲')
  const second = await fact('speech', 3, '乙')
  commands = new ProjectCommands(ctx.fs, limits, ctx.attachments)
  expect(await run({ method: 'list_facts', project: path, start: 1, count: 1 })).toMatchObject({ facts: [{ id: first }], next: 2 })
  expect(await run({ method: 'list_facts', project: path, start: 2, count: 1 })).toMatchObject({ facts: [{ id: second }], next: null })
  for (const [start, count] of [[0, 1], [1, 0], [1, 101], [3, 1]]) {
    await expect(run({ method: 'list_facts', project: path, start: start!, count: count! })).rejects.toThrow('fact_window')
  }
  commands = new ProjectCommands(ctx.fs, { ...limits, maxReadBytes: 1 }, ctx.attachments)
  await expect(run({ method: 'list_facts', project: path, start: 1, count: 1 })).rejects.toThrow('fact_window_bytes')
})

it('pages complete facts by encoded byte size without losing review records or mutating the project', async () => {
  const first = await fact('thought', 1, '甲')
  const second = await fact('speech', 3, '乙')
  const before = await current()
  const budget = Math.max(...before.facts.map(value => Buffer.byteLength(JSON.stringify([value]), 'utf8')))
  commands = new ProjectCommands(ctx.fs, { ...limits, maxReadBytes: budget }, ctx.attachments)
  expect(await run({ method: 'list_facts', project: path, start: 1, count: 100 }))
    .toEqual({ revision: before.revision, facts: [before.facts[0]], next: 2 })
  expect(await run({ method: 'list_facts', project: path, start: 2, count: 100 }))
    .toEqual({ revision: before.revision, facts: [before.facts[1]], next: null })
  expect(before.facts.map(value => value.id)).toEqual([first, second])
  expect(await current()).toEqual(before)
  commands = new ProjectCommands(ctx.fs, { ...limits, maxReadBytes: 2 }, ctx.attachments)
  await expect(run({ method: 'list_facts', project: path, start: 1, count: 100 })).rejects.toThrow('单条事实超过读取预算')
})

async function inspection(count = 2, large = false) {
  const video = join(root, 'fixture.mp4')
  await writeFile(video, 'Owned video fixture bytes')
  const target = await ctx.fs.resolve(video, { signal: new AbortController().signal })
  const version = (await ctx.fs.stat(target, new AbortController().signal))!.version
  const data = await sharp({ create: { width: large ? 4000 : 8, height: large ? 3000 : 8, channels: 3, background: 'blue' } }).png().toBuffer()
  const image = await ctx.attachments.saveImage({ data, mediaType: 'image/png', name: 'fixture-frame.png' })
  const manifest = join(root, 'inspection.json')
  const value = { path: video, source_version: version, duration_seconds: 30, inspection: 'sampled_frames', verified_readback: true,
    frames: Array.from({ length: count }, (_, index) => ({ requested_seconds: index + 1, timestamp_seconds: index + 1, image })) }
  await writeFile(manifest, JSON.stringify(value))
  return { video, manifest, value, image }
}

it('imports real stored frames, retains original timecodes, and reads the same verified image bytes', async () => {
  const fixture = await inspection(2, true)
  expect(fixture.image.originalDimensions).toEqual({ width: 4000, height: 3000 })
  await run({ method: 'import_source', project: path, expected_revision: 1, path: fixture.manifest, source_kind: 'video_inspection' })
  const source = (await current()).sources[1]!
  expect(await run({ method: 'read_source', project: path, source_id: source.id, start: 1, count: 1 }))
    .toMatchObject({ next: 2, units: [{ start: 1, end: 1, image: fixture.image }] })
  const read = vi.spyOn(ctx.attachments, 'readImage').mockRejectedValueOnce(Error('missing frame bytes'))
  await expect(run({ method: 'read_source', project: path, source_id: source.id, start: 1, count: 1 })).rejects.toThrow('missing frame bytes')
  expect(read).toHaveBeenCalledWith(fixture.image, expect.any(AbortSignal))
})

it('rejects an altered or missing video original bound by a frame manifest', async () => {
  const fixture = await inspection()
  await run({ method: 'import_source', project: path, expected_revision: 1, path: fixture.manifest, source_kind: 'video_inspection' })
  await writeFile(fixture.video, 'changed video bytes')
  await expect(run({ method: 'status', project: path })).rejects.toThrow('video_changed')
  await rm(fixture.video)
  await expect(run({ method: 'status', project: path })).rejects.toThrow('video_changed')
})

it('refuses unavailable frame bytes and out-of-range actual or requested frame timecodes before import', async () => {
  const fixture = await inspection()
  vi.spyOn(ctx.attachments, 'readImage').mockRejectedValueOnce(Error('missing frame bytes'))
  await expect(run({ method: 'import_source', project: path, expected_revision: 1, path: fixture.manifest, source_kind: 'video_inspection' })).rejects.toThrow('missing frame bytes')
  for (const key of ['timestamp_seconds', 'requested_seconds'] as const) {
    const changed = structuredClone(fixture.value);changed.frames[0]![key] = 30
    await writeFile(fixture.manifest, JSON.stringify(changed))
    await expect(run({ method: 'import_source', project: path, expected_revision: 1, path: fixture.manifest, source_kind: 'video_inspection' })).rejects.toThrow('frame_time')
  }
  expect((await current()).sources).toHaveLength(1)
})

it('rejects frame reads that exceed attachment count or aggregate bytes instead of omitting images', async () => {
  const fixture = await inspection(21)
  await run({ method: 'import_source', project: path, expected_revision: 1, path: fixture.manifest, source_kind: 'video_inspection' })
  const source = (await current()).sources[1]!
  await expect(run({ method: 'read_source', project: path, source_id: source.id, start: 1, count: 21 })).rejects.toThrow('frame_window')
  Object.defineProperty(ctx.attachments, 'imageLimits', { value: { ...ctx.attachments.imageLimits, maxMessageImageBytes: 1 } })
  await expect(run({ method: 'read_source', project: path, source_id: source.id, start: 1, count: 1 })).rejects.toThrow('frame_window')
})

it('publishes bounded fact batches once and preserves each attributed source and review decision', async () => {
  const original = await current()
  const first = original.sources[0]!.units[0]!, third = original.sources[0]!.units[2]!
  const facts: FactInput[] = [
    { kind: 'thought', origin: 'source', actor: '甲', layer: 'present', summary: first.text, anchors: [{ unit_id: first.id, quote: first.text }] },
    { kind: 'speech', origin: 'source', actor: '乙', layer: 'present', summary: third.text, anchors: [{ unit_id: third.id, quote: third.text }] },
  ]
  const write = vi.spyOn(ctx.fs, 'writeText')
  await run({ method: 'propose_facts', project: path, expected_revision: original.revision, facts })
  const proposed = await current()
  expect(proposed.revision).toBe(original.revision + 1)
  expect(write).toHaveBeenCalledTimes(1)
  expect(new Set(proposed.facts.map(fact => fact.id)).size).toBe(2)
  expect(proposed.facts.map(fact => fact.actor)).toEqual(['甲', '乙'])
  const reviews = proposed.facts.map((fact, index) => ({ fact_id: fact.id, decision: index === 0 ? 'approve' as const : 'reject' as const, reason: `核对原文 ${index + 1}：人物与心理/发声归属已分别检查。` }))
  await run({ method: 'review_facts', project: path, expected_revision: proposed.revision, reviews }, 'reviewer')
  const reviewed = await current()
  expect(write).toHaveBeenCalledTimes(2)
  expect(reviewed.revision).toBe(proposed.revision + 1)
  expect(reviewed.facts.map(fact => fact.review?.decision)).toEqual(['approve', 'reject'])
  expect(reviewed.facts.map(fact => fact.review?.reason)).toEqual(reviews.map(review => review.reason))
})

it('does not write any part of a fact batch when a later source quote is invalid or the batch is empty or over budget', async () => {
  const original = await current(), unit = original.sources[0]!.units[0]!
  const valid: FactInput = { kind: 'thought', origin: 'source', actor: '甲', layer: 'present', summary: unit.text, anchors: [{ unit_id: unit.id, quote: unit.text }] }
  const before = await readFile(path, 'utf8')
  const write = vi.spyOn(ctx.fs, 'writeText')
  for (const [facts, failure] of [[[], 'fact_batch'], [Array.from({ length: 21 }, () => valid), 'fact_batch'],
    [[valid, { ...valid, anchors: [{ unit_id: unit.id, quote: '原件不存在这段文字' }] }], 'source_quote_mismatch']] as const) {
    await expect(run({ method: 'propose_facts', project: path, expected_revision: original.revision, facts: facts.map(fact => ({ ...fact, anchors: fact.anchors.map(anchor => ({ ...anchor })) })) })).rejects.toThrow(failure)
    expect(await readFile(path, 'utf8')).toBe(before)
  }
  expect(write).not.toHaveBeenCalled()
})

it('rejects an entire review batch if any member is duplicated, missing, already reviewed, self reviewed or has no reason', async () => {
  const original = await current(), unit = original.sources[0]!.units[0]!
  const input: FactInput = { kind: 'thought', origin: 'source', actor: '甲', layer: 'present', summary: unit.text, anchors: [{ unit_id: unit.id, quote: unit.text }] }
  await run({ method: 'propose_facts', project: path, expected_revision: original.revision, facts: [input, input] })
  const proposed = await current()
  const valid = { fact_id: proposed.facts[0]!.id, decision: 'approve' as const, reason: '原文、人物和心理归属核对通过。' }
  const other = { ...valid, fact_id: proposed.facts[1]!.id }
  const before = await readFile(path, 'utf8')
  const write = vi.spyOn(ctx.fs, 'writeText')
  for (const [reviews, actor, failure] of [
    [[], 'reviewer', 'fact_batch'],
    [Array.from({ length: 21 }, () => valid), 'reviewer', 'fact_batch'],
    [[valid, valid], 'reviewer', 'duplicate_review'],
    [[valid, { ...other, fact_id: 'missing' }], 'reviewer', 'fact_review_state'],
    [[valid, { ...other, reason: ' ' }], 'reviewer', 'review_reason'],
    [[valid, other], 'writer', 'self_review'],
  ] as const) {
    await expect(run({ method: 'review_facts', project: path, expected_revision: proposed.revision, reviews: [...reviews] }, actor)).rejects.toThrow(failure)
    expect(await readFile(path, 'utf8')).toBe(before)
  }
  expect(write).not.toHaveBeenCalled()
  await run({ method: 'review_facts', project: path, expected_revision: proposed.revision, reviews: [valid, other] }, 'reviewer')
  const reviewed = await current(), acceptedBytes = await readFile(path, 'utf8')
  await expect(run({ method: 'review_facts', project: path, expected_revision: reviewed.revision, reviews: [valid] }, 'reviewer')).rejects.toThrow('fact_review_state')
  expect(await readFile(path, 'utf8')).toBe(acceptedBytes)
})

it('assembles separately written scene files into one independently reviewed candidate', async () => {
  const id = await fact('thought', 1, '甲')
  const scenes = [scene(id), { ...scene(id), transition: 'continuous' as const }]
  const files = scenes.map((_, index) => join(root, `scene-${index}.json`))
  for (const [index, file] of files.entries()) await writeFile(file, JSON.stringify(scenes[index]))
  await run({ method: 'stage_files', project: path, expected_revision: (await current()).revision, episode: 1, files })
  const candidate = (await current()).candidates[0]!
  expect(candidate.scenes).toEqual(scenes)
  expect(candidate.author).toBe('writer')
  await approveAndCommit(candidate.id, candidate.sha256)
  expect(await run({ method: 'status', project: path })).toMatchObject({ next_episode: 2 })
  await writeFile(files[0]!, '{}')
  expect((await current()).candidates[0]!.scenes).toEqual(scenes)
})

it('rejects empty, duplicate, unavailable or malformed scene files without publishing a partial candidate', async () => {
  const id = await fact('thought', 1, '甲')
  const file = join(root, 'scene.json'), malformed = join(root, 'invalid-scene.json')
  await writeFile(file, JSON.stringify(scene(id)))
  await writeFile(malformed, '{"location":"门前","time":false}')
  const original = await readFile(path, 'utf8')
  const request = { method: 'stage_files', project: path, expected_revision: (await current()).revision, episode: 1 } as const
  for (const files of [[], Array.from({ length: limits.maxReadUnits + 1 }, () => file), [file, file],
    [join(root, 'missing.json')], [root], [file, malformed]]) {
    await expect(run({ ...request, files })).rejects.toThrow()
    expect(await readFile(path, 'utf8')).toBe(original)
  }
  await writeFile(malformed, 'not json')
  await expect(run({ ...request, files: [malformed] })).rejects.toThrow()
  commands = new ProjectCommands(ctx.fs, { ...limits, maxReadBytes: 1 }, ctx.attachments)
  await expect(run({ ...request, files: [file] })).rejects.toThrow()
  expect(await readFile(path, 'utf8')).toBe(original)
})

it('refuses scene files changed or removed during assembly', async () => {
  const id = await fact('thought', 1, '甲'), file = join(root, 'scene.json')
  const original = await readFile(path, 'utf8')
  const readBytes = ctx.fs.readBytes.bind(ctx.fs)
  for (const remove of [false, true]) {
    await writeFile(file, JSON.stringify(scene(id)))
    const spy = vi.spyOn(ctx.fs, 'readBytes').mockImplementation(async (...args) => {
      const bytes = await readBytes(...args)
      if (args[0].displayPath === file) {
        if (remove) await rm(file)
        else await writeFile(file, JSON.stringify({ ...scene(id), time: '夜' }))
      }
      return bytes
    })
    await expect(run({ method: 'stage_files', project: path, expected_revision: (await current()).revision,
      episode: 1, files: [file] })).rejects.toThrow('scene_file_changed')
    spy.mockRestore()
    expect(await readFile(path, 'utf8')).toBe(original)
  }
})

it('forks an accepted episode for revision while retaining exact parent identity and immutable old delivery', async () => {
  const id = await fact('thought', 1, '甲')
  const original = await stage([scene(id)])
  await approveAndCommit(original.id, original.sha256)
  const before = await readFile(path, 'utf8')
  const destination = join(root, 'revision.json')
  const parent = await current()
  const forked = await run({ method: 'fork_project', project: path, expected_revision: parent.revision, destination, before_episode: 1 })
  expect(forked).toMatchObject({ revision: 0, next_episode: 1, accepted: [], parent: {
    id: parent.id, path, revision: parent.revision, before_episode: 1,
  } })
  const branch = PROJECT_FILE.parse(JSON.parse(await readFile(destination, 'utf8')))
  expect(branch.id).not.toBe(parent.id)
  expect(branch.sources).toEqual(parent.sources)
  expect(branch.facts).toEqual(parent.facts)
  expect(branch.candidates).toEqual([])
  await run({ method: 'stage', project: destination, expected_revision: 0, episode: 1, scenes: [scene(id)] }, 'revision-writer')
  const proposed = PROJECT_FILE.parse(JSON.parse(await readFile(destination, 'utf8')))
  const revision = proposed.candidates[0]!
  await run({ method: 'review', project: destination, expected_revision: 1, candidate_id: revision.id,
    candidate_sha256: revision.sha256, decision: 'approve', reason: '重新独立核对原文与修订稿。' }, 'revision-reviewer')
  await run({ method: 'commit', project: destination, expected_revision: 2, candidate_id: revision.id, candidate_sha256: revision.sha256 })
  expect(await run({ method: 'status', project: destination })).toMatchObject({ next_episode: 2 })
  expect(await readFile(path, 'utf8')).toBe(before)
})

it('retains only accepted ancestors when revising a later episode and refuses gaps, stale requests and overwrites', async () => {
  const id = await fact('thought', 1, '甲')
  const first = await stage([scene(id)])
  await approveAndCommit(first.id, first.sha256)
  const parent = await current()
  const destination = join(root, 'later-revision.json')
  for (const before_episode of [0, 3]) await expect(run({ method: 'fork_project', project: path,
    expected_revision: parent.revision, destination, before_episode })).rejects.toThrow('revision_episode')
  await expect(run({ method: 'fork_project', project: path, expected_revision: parent.revision - 1,
    destination, before_episode: 2 })).rejects.toThrow('stale_revision')
  const result = await run({ method: 'fork_project', project: path, expected_revision: parent.revision, destination, before_episode: 2 })
  expect(result).toMatchObject({ next_episode: 2, accepted: [{ id: first.id }] })
  const branch = PROJECT_FILE.parse(JSON.parse(await readFile(destination, 'utf8')))
  expect(branch.candidates).toEqual([parent.candidates[0]])
  const bytes = await readFile(destination, 'utf8')
  await expect(run({ method: 'fork_project', project: path, expected_revision: parent.revision, destination, before_episode: 1 })).rejects.toThrow()
  expect(await readFile(destination, 'utf8')).toBe(bytes)
  await expect(run({ method: 'fork_project', project: path, expected_revision: parent.revision, destination: path, before_episode: 1 })).rejects.toThrow()
  expect(await current()).toEqual(parent)
})

it('keeps accepted exports identical after importing an unrelated next episode source', async () => {
  const id = await fact('thought', 1, '甲')
  const candidate = await stage([scene(id)])
  await approveAndCommit(candidate.id, candidate.sha256)
  const directory = join(root, 'stable-export')
  await run({ method: 'export', project: path, candidate_id: candidate.id, directory })
  const sidecar = join(directory, `episode-1-${candidate.id.slice(2)}.sources.json`)
  const before = await readFile(sidecar, 'utf8')
  const later = join(root, 'episode-two.txt')
  await writeFile(later, '第二集的新来源。')
  await run({ method: 'import_source', project: path, expected_revision: (await current()).revision, path: later, source_kind: 'text' })
  commands = new ProjectCommands(ctx.fs, limits, ctx.attachments)
  await run({ method: 'export', project: path, candidate_id: candidate.id, directory })
  expect(await readFile(sidecar, 'utf8')).toBe(before)
})

it('retains sampled inspection intervals and deferred observations in imported source reads', async () => {
  const fixture = await inspection()
  const interval = { start_seconds: 0, end_seconds: 12 }
  const sampling_plan = { strategy: 'scene_dialogue', selected: [{ time: 1, reasons: ['scene'] }], deferred: [{ time: 8, reasons: ['dialogue'] }] }
  await writeFile(fixture.manifest, JSON.stringify({ ...fixture.value, interval, sampling_plan }))
  await run({ method: 'import_source', project: path, expected_revision: 1, path: fixture.manifest, source_kind: 'video_inspection' })
  const video = (await current()).sources[1]!
  expect(await run({ method: 'read_source', project: path, source_id: video.id, start: 1, count: 1 }))
    .toMatchObject({ video: { inspection: 'sampled_frames', interval, sampling_plan } })
})

it('reuses unchanged validated project bytes without trusting unchanged file metadata or returned objects', async () => {
  commands = new ProjectCommands(ctx.fs, limits, ctx.attachments)
  const parse = vi.spyOn(PROJECT_FILE, 'parse')
  await run({ method: 'status', project: path })
  parse.mockClear()
  await run({ method: 'status', project: path })
  expect(parse).not.toHaveBeenCalled()
  const project = await current()
  project.sources[0]!.units[0]!.text = 'tampered'
  await writeFile(path, JSON.stringify(project))
  await expect(run({ method: 'status', project: path })).rejects.toThrow('source_index_changed')
})

it('blocks deferred visual observations until supplemental samples are included in candidate coverage', async () => {
  const fixture = await inspection()
  await writeFile(fixture.manifest, JSON.stringify({ ...fixture.value, interval: { start_seconds: 0, end_seconds: 30 },
    sampling_plan: { strategy: 'scene_dialogue', selected: [{ time: 1, reasons: ['scene'] }], deferred: [{ time: 8, reasons: ['scene'] }] } }))
  await run({ method: 'import_source', project: path, expected_revision: 1, path: fixture.manifest, source_kind: 'video_inspection' })
  const project = await current()
  project.workflow = 'video_to_screenplay'
  await writeFile(path, JSON.stringify(project))
  const action = await visualAction()
  await expect(videoStage([scene(action, 'action')], [{ fact_id: action, kind: 'action' }])).rejects.toThrow('video_observation_deferred')
  const supplemental = join(root, 'supplemental.json')
  await writeFile(supplemental, JSON.stringify({ ...fixture.value, interval: { start_seconds: 7, end_seconds: 9 },
    frames: [{ requested_seconds: 8, timestamp_seconds: 7.98, image: fixture.image }] }))
  await run({ method: 'import_source', project: path, expected_revision: (await current()).revision, path: supplemental, source_kind: 'video_inspection' })
  const candidate = await videoStage([scene(action, 'action')], [{ fact_id: action, kind: 'action' }])
  await approveAndCommit(candidate.id, candidate.sha256)
})

it('rehashes sources on cached reads and isolates returned records from the validation cache', async () => {
  const id = await fact('thought', 1, '甲')
  const response = await run({ method: 'read_fact', project: path, fact_id: id }) as { fact: { summary: string } }
  response.fact.summary = 'caller mutation'
  expect(await run({ method: 'read_fact', project: path, fact_id: id })).not.toMatchObject({ fact: { summary: 'caller mutation' } })
  await writeFile(source, 'changed source')
  await expect(run({ method: 'status', project: path })).rejects.toThrow('source_changed')
})

it('loads legacy candidates with their original content digests', async () => {
  const id = await fact('thought', 1, '甲')
  await stage([scene(id)])
  const project = await current()
  const candidate = project.candidates[0]!
  delete candidate.source_ids
  candidate.sha256 = candidateDigest(candidate)
  await writeFile(path, JSON.stringify(project))
  await approveAndCommit(candidate.id, candidate.sha256)
  expect(await run({ method: 'status', project: path })).toMatchObject({ next_episode: 2 })
})

it('preserves a pre-upgrade legacy sidecar including unused sources after later imports', async () => {
  const unused = join(root, 'unused.txt')
  await writeFile(unused, 'unused original')
  await run({ method: 'import_source', project: path, expected_revision: (await current()).revision, path: unused, source_kind: 'text' })
  const id = await fact('thought', 1, '甲')
  await stage([scene(id)])
  const project = await current(), candidate = project.candidates[0]!
  delete candidate.source_ids
  candidate.sha256 = candidateDigest(candidate)
  await writeFile(path, JSON.stringify(project))
  await approveAndCommit(candidate.id, candidate.sha256)
  const directory = join(root, 'legacy-export')
  await run({ method: 'export', project: path, candidate_id: candidate.id, directory })
  const sidecar = join(directory, `episode-1-${candidate.id.slice(2)}.sources.json`)
  const before = await readFile(sidecar, 'utf8')
  expect((JSON.parse(before) as { sources: unknown[] }).sources).toHaveLength(2)
  const later = join(root, 'later.txt')
  await writeFile(later, 'later source')
  await run({ method: 'import_source', project: path, expected_revision: (await current()).revision, path: later, source_kind: 'text' })
  commands = new ProjectCommands(ctx.fs, limits, ctx.attachments)
  await run({ method: 'export', project: path, candidate_id: candidate.id, directory })
  expect(await readFile(sidecar, 'utf8')).toBe(before)
  await writeFile(sidecar, before.replace('unused.txt', 'edited.txt'))
  await expect(run({ method: 'export', project: path, candidate_id: candidate.id, directory })).rejects.toThrow('export_changed')
})

it('scopes deferred observations to the declared episode interval within a longer-video manifest', async () => {
  const fixture = await inspection()
  await writeFile(fixture.manifest, JSON.stringify({ ...fixture.value, interval: { start_seconds: 0, end_seconds: 30 },
    sampling_plan: { strategy: 'scene_dialogue', selected: [{ time: 1, reasons: ['scene'] }], deferred: [{ time: 20, reasons: ['scene'] }] } }))
  await run({ method: 'import_source', project: path, expected_revision: 1, path: fixture.manifest, source_kind: 'video_inspection' })
  const project = await current()
  project.workflow = 'video_to_screenplay'
  await writeFile(path, JSON.stringify(project))
  const action = await visualAction()
  const saved = await current(), video = saved.sources[1]!
  const request: ProjectRequest = { method: 'stage', project: path, expected_revision: saved.revision, episode: 1,
    scenes: [scene(action, 'action')], coverage: {
      windows: [{ source_id: video.id, start: 1, count: 2, interval: { start_seconds: 0, end_seconds: 10 } }],
      required_beats: [{ fact_id: action, kind: 'action' }],
    } }
  await run(request)
  const candidate = (await current()).candidates[0]!
  await approveAndCommit(candidate.id, candidate.sha256)
  expect(await run({ method: 'status', project: path })).toMatchObject({ next_episode: 2 })
})

it.each(['duplicate', 'missing'] as const)('rejects a persisted candidate with %s source bindings before reusing its digest', async (failure) => {
  const id = await fact('thought', 1, '甲')
  await stage([scene(id)])
  const saved = await current(), candidate = saved.candidates[0]!
  candidate.source_ids = failure === 'duplicate'
    ? [saved.sources[0]!.id, saved.sources[0]!.id]
    : [brandString<typeof saved.sources[0]['id']>('missing-source')]
  candidate.sha256 = candidateDigest(candidate)
  await writeFile(path, JSON.stringify(saved))
  await expect(run({ method: 'status', project: path })).rejects.toThrow('invalid_candidate_sources')
})

it('rejects persisted video metadata that disagrees with its unchanged original manifest', async () => {
  const fixture = await inspection()
  await run({ method: 'import_source', project: path, expected_revision: 1, path: fixture.manifest, source_kind: 'video_inspection' })
  const saved = await current()
  saved.sources[1]!.video!.samples[0]!.timestamp_seconds = 0.5
  await writeFile(path, JSON.stringify(saved))
  await expect(run({ method: 'status', project: path })).rejects.toThrow('source_index_changed')
})

it.each(['backward', 'duration', 'frame', 'point-duration', 'point-before', 'point-after'] as const)(
  'rejects an inspection manifest with a %s interval violation without importing it', async (failure) => {
    const fixture = await inspection()
    const interval = { start_seconds: 0, end_seconds: 10 }
    if (failure === 'backward') interval.start_seconds = 10
    if (failure === 'duration') interval.end_seconds = 31
    if (failure === 'frame' || failure === 'point-before') interval.start_seconds = 2
    const sampling_plan = { strategy: 'scene_dialogue', selected: [], deferred: [
      { time: failure === 'point-duration' ? 30 : failure === 'point-after' ? 10 : 0, reasons: ['scene'] },
    ] }
    const frames = failure === 'point-before'
      ? [{ ...fixture.value.frames[0]!, requested_seconds: 3, timestamp_seconds: 3 }]
      : fixture.value.frames
    await writeFile(fixture.manifest, JSON.stringify({ ...fixture.value, interval, frames, sampling_plan }))
    const before = await readFile(path, 'utf8')
    await expect(run({ method: 'import_source', project: path, expected_revision: 1, path: fixture.manifest, source_kind: 'video_inspection' }))
      .rejects.toThrow('video_interval')
    expect(await readFile(path, 'utf8')).toBe(before)
  },
)

it.each(['invalid-json', 'null', 'missing-sources', 'non-array-sources', 'removed-used-source'] as const)(
  'preserves and rejects a legacy export sidecar altered to %s', async (failure) => {
    const id = await fact('thought', 1, '甲')
    await stage([scene(id)])
    const saved = await current(), candidate = saved.candidates[0]!
    delete candidate.source_ids
    candidate.sha256 = candidateDigest(candidate)
    await writeFile(path, JSON.stringify(saved))
    await approveAndCommit(candidate.id, candidate.sha256)
    const directory = join(root, 'legacy-export')
    await run({ method: 'export', project: path, candidate_id: candidate.id, directory })
    const sidecar = join(directory, `episode-1-${candidate.id.slice(2)}.sources.json`)
    const previous = JSON.parse(await readFile(sidecar, 'utf8')) as Record<string, unknown>
    const content = failure === 'invalid-json' ? '{' : JSON.stringify(failure === 'null' ? null
      : failure === 'missing-sources' ? {} : { ...previous, sources: failure === 'non-array-sources' ? {} : [] })
    await writeFile(sidecar, content)
    await expect(run({ method: 'export', project: path, candidate_id: candidate.id, directory })).rejects.toThrow('export_changed')
    expect(await readFile(sidecar, 'utf8')).toBe(content)
  },
)
