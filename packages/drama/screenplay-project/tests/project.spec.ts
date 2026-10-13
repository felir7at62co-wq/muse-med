/** Source, attribution, publication, and recovery through the actual local filesystem provider. */
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { FsVersion } from '@deepseek-ai/dsh-fs'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import { TRUSTED_VIDEO_INSPECTION_RECEIPT } from '@deepseek-ai/dsh-tool-video-inspect'
import { Context } from '@deepseek-ai/cordis'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import sharp from 'sharp'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ActorId } from '../src/ids.ts'
import type { ProjectExecution } from '../src/project.ts'
import type { ProjectReadReceipt } from '../src/review.ts'
import type { HumanAuthorization } from '../src/refinement.ts'
import { ProjectCommands } from '../src/project.ts'
import { candidateDigest, sha256 } from '../src/episode.ts'
import { inventoryDigest, storyScopeDigest, storyPolicyDigest } from '../src/story.ts'
import { PROJECT_FILE, VIDEO_INSPECTION } from '../src/schema.ts'
import type { FactInput, ProjectRequest, SceneInput } from '../src/schema.ts'
import { stageCoverage } from './fixtures/stage-input.ts'

let root: string
let path: string
let source: string
let ctx: Context
let commands: ProjectCommands
const limits = {
  maxSourceBytes: 1024 * 1024, maxProjectBytes: 4 * 1024 * 1024, maxReadUnits: 100, maxReadBytes: 64 * 1024, maxFactBatch: 20,
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'screenplay-project-')))
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

it('rejects an omitted source-kind suffix, offers the complete identity and reads only its exact correction', async () => {
  const before = await current(), original = before.sources[0]!
  const partial = original.id.slice(0, original.id.lastIndexOf(':'))
  await expect(run({ method: 'read_source', project: path, source_id: partial, start: 1, count: 1 }))
    .rejects.toThrow(`从 status.sources 选择完整 id：${original.id}`)
  expect(await current()).toEqual(before)
  expect(await run({ method: 'read_source', project: path, source_id: original.id, start: 1, count: 1 }))
    .toMatchObject({ source_id: original.id, units: [{ id: original.units[0]!.id, text: original.units[0]!.text }] })
})

it('reports both complete identities when the same bytes were imported as text and transcript', async () => {
  const file = join(root, 'timed.json')
  await writeFile(file, JSON.stringify([{ start: 0, end: 1, text: '你走吧。' }]))
  await run({ method: 'import_source', project: path, expected_revision: 1, path: file, source_kind: 'text' })
  await run({ method: 'import_source', project: path, expected_revision: 2, path: file, source_kind: 'transcript' })
  const before = await current(), text = before.sources[1]!, transcript = before.sources[2]!
  const partial = text.id.slice(0, text.id.lastIndexOf(':'))
  await expect(run({ method: 'read_source', project: path, source_id: partial, start: 1, count: 1 }))
    .rejects.toThrow(`${text.id}、${transcript.id}`)
  expect(await current()).toEqual(before)
  expect(await run({ method: 'read_source', project: path, source_id: transcript.id, start: 1, count: 1 }))
    .toMatchObject({ units: [{ text: '你走吧。' }] })
})

it('does not expose unrelated source identities when a missing id shares no complete byte digest', async () => {
  const before = await current()
  await expect(run({ method: 'read_source', project: path, source_id: 's:missing', start: 1, count: 1 }))
    .rejects.toThrow(/^missing_source: 请使用 status 返回的来源编号。$/u)
  expect(await current()).toEqual(before)
})
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
  for (const [facts, failure] of [[[], 'fact_batch: 本次批量事实 0 条，允许 1–20 条。'],
    [Array.from({ length: 21 }, () => valid), 'fact_batch: 本次批量事实 21 条，允许 1–20 条。'],
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
    [[], 'reviewer', 'fact_batch: 本次批量审校 0 条，允许 1–20 条。'],
    [Array.from({ length: 21 }, () => valid), 'reviewer', 'fact_batch: 本次批量审校 21 条，允许 1–20 条。'],
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
  await expect(run({ ...request, files: [malformed] })).rejects.toThrow(`scene_file_json: 场次文件 ${malformed} 须为有效 UTF-8 JSON`)
  await writeFile(malformed, Buffer.from([0xff]))
  await expect(run({ ...request, files: [malformed] })).rejects.toThrow(`scene_file_json: 场次文件 ${malformed} 须为有效 UTF-8 JSON`)
  await writeFile(malformed, JSON.stringify({ ...scene(id), beats: [{ kind: 'os', actor: '甲', text: '我还记得。', fact_ids: [id] }] }))
  await expect(run({ ...request, files: [file, malformed] })).rejects.toThrow(`scene_file_invalid: 场次文件 ${malformed}`)
  await expect(run({ ...request, files: [file, malformed] })).rejects.toThrow('beats.0.requires_knowledge')
  await expect(run({ ...request, files: [file, malformed] })).rejects.toThrow('beats.0.witnesses')
  expect(await readFile(path, 'utf8')).toBe(original)
  const missing = join(root, 'missing-scene.json')
  await expect(run({ ...request, files: [missing] })).rejects.toThrow(`scene_file_missing: 场次 JSON 文件不可用：${missing}`)
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

function humanGrant(): HumanAuthorization {
  return { source: 'user', session_id: brandString<ActorId>('writer'), message_id: 'work-request', seq: SessionSeq(1),
    message_sha256: '1'.repeat(64), quote: '只处理当前原视频的第一集，保持故事事实。', consent_assessment: '用户授权当前作品第一集的表达整理。' }
}
async function storyForkRequest(): Promise<Extract<ProjectRequest, { method: 'fork_story_faithful' }>> {
  const fixture = await inspection(), file = await current(), grant = humanGrant()
  return { method: 'fork_story_faithful', project: path, destination: join(root, 'story-branch.json'), expected_revision: file.revision,
    before_episode: 1, work_title: '原件边界回归', videos: [{ path: fixture.video, source_version: fixture.value.source_version }], episodes: [1],
    scope_instructions: '只处理本集，不改变原始事件。', authorization_quote: grant.quote, consent_assessment: grant.consent_assessment,
    allowed_categories: [], baseline_candidate_ids: [], source_links: [{ source_id: file.sources[0]!.id, video_path: fixture.video }] }
}
function storyExecution(step = 10, receipts: ProjectReadReceipt[] = []): ProjectExecution {
  return { actor: brandString<ActorId>('writer'), cwd: root, signal: new AbortController().signal, step: SessionSeq(step),
    authorization: humanGrant(), latestUserSeq: SessionSeq(1), receipts, observeRead: receipt => receipts.push(receipt) }
}
async function storyBranch(categories: 'minimal_os'[] = []) {
  const id = await fact('thought', 1, '甲'), request = await storyForkRequest()
  commands = new ProjectCommands(ctx.fs, limits, ctx.attachments, 'self-check', 'source-preserving-v1', 'story-faithful-v2')
  request.allowed_categories = categories
  await commands.execute(request, storyExecution()); path = request.destination
  return { id, request }
}
async function storyInventory(withFrames = false, categories: 'minimal_os'[] = []) {
  const { id } = await storyBranch(categories)
  if (withFrames) {
    const manifestPath = join(root, 'inspection.json'), proof = await storyInspectionProof(manifestPath)
    await commands.execute({ method: 'import_source', project: path, expected_revision: (await current()).revision,
      path: manifestPath, source_kind: 'video_inspection' }, { ...storyExecution(), verifyStoryVideo: async () => proof })
  }
  const file = await current(), unit = file.sources[0]!.units[0]!
  await commands.execute({ method: 'propose_story_inventory', project: path, expected_revision: file.revision, episode: 1,
    coverage: { windows: file.sources.map(source => ({ source_id: source.id, start: 1,
      count: source.kind === 'text' ? 1 : source.units.length })), required_beats: [{ fact_id: id, kind: 'os' }] },
    items: [{ id: 'thought', dimension: 'emotion_conflict', summary: '甲知道钥匙所在。', critical: false,
      evidence: 'confirmed', fact_ids: [id], source_units: [unit.id], depends_on: [], knowledge: [] }],
    not_applicable: (['event', 'action_result', 'relationship_stance', 'causality_reveal'] as const).map(dimension => ({
      dimension, reason: '该局部原文只有心理，没有本维度事件。' })) }, storyExecution())
  return (await current()).story_inventories![0]!
}

it.each(['video-version', 'episode-unspecified', 'episode-outside', 'stale-original',
  'before-gap', 'missing-input', 'source-unlinked'] as const)(
  'preserves the original project when a story fork rejects %s', async (failure) => {
    const request = await storyForkRequest(), before = await readFile(path, 'utf8')
    if (failure === 'video-version') request.videos[0]!.source_version = FsVersion('obsolete-original-version')
    if (failure === 'episode-unspecified') request.episodes = [1, 2]
    if (failure === 'episode-outside') request.videos[0]!.episode = 2
    if (failure === 'stale-original') request.expected_revision++
    if (failure === 'before-gap') request.before_episode = 2
    if (failure === 'missing-input') request.baseline_candidate_ids = ['not-a-real-candidate']
    if (failure === 'source-unlinked') request.source_links = []
    commands = new ProjectCommands(ctx.fs, limits, ctx.attachments, 'self-check', 'disabled', 'story-faithful-v2')
    const error = { 'video-version': 'story_video_version', 'episode-unspecified': 'story_video_episode',
      'episode-outside': 'story_video_episode', 'stale-original': 'stale_revision', 'before-gap': 'revision_episode',
      'missing-input': 'story_input_candidate', 'source-unlinked': 'story_source_scope' }[failure]
    await expect(commands.execute(request, storyExecution())).rejects.toThrow(error)
    expect(await readFile(path, 'utf8')).toBe(before)
  },
)
it('rejects a real candidate outside the story fork authorization scope', async () => {
  const id = await fact('thought', 1, '甲'), candidate = await stage([scene(id)]), request = await storyForkRequest()
  request.episodes = [2]; request.videos[0]!.episode = 2; request.baseline_candidate_ids = [candidate.id]
  commands = new ProjectCommands(ctx.fs, limits, ctx.attachments, 'self-check', 'disabled', 'story-faithful-v2')
  await expect(commands.execute(request, storyExecution())).rejects.toThrow('story_input_candidate')
})
it('does not downgrade an existing story grant by forking it into another story or refinement grant', async () => {
  await storyBranch(); const file = await current(), request = await storyForkRequest()
  request.before_episode = 1
  await expect(commands.execute(request, storyExecution())).rejects.toThrow('story_fork_original')
  await expect(commands.execute({ method: 'fork_refinement', project: path,
    expected_revision: file.revision,
    destination: join(root, 'refinement.json'), baseline_candidate_ids: [], scope_instructions: '第一集',
    authorization_quote: humanGrant().quote, consent_assessment: humanGrant().consent_assessment,
    allowed_categories: [] }, storyExecution()))
    .rejects.toThrow('story_policy_exclusive')
})
it('refuses story writes from a disabled deployment while keeping historical status readable', async () => {
  await storyBranch(); const file = await current(), source = file.sources[0]!
  commands = new ProjectCommands(ctx.fs, limits, ctx.attachments)
  expect(await run({ method: 'status', project: path })).toMatchObject({ story_policy: { version: 'story-faithful-v2' } })
  await expect(run({ method: 'propose_fact', project: path, expected_revision: file.revision, fact: {
    kind: 'thought', origin: 'source', actor: '甲', layer: 'present', summary: source.units[0]!.text,
    anchors: [{ unit_id: source.units[0]!.id, quote: source.units[0]!.text }] } })).rejects.toThrow('story_mode_disabled')
})
it('rejects forged persisted inventory review evidence before showing status', async () => {
  const inventory = await storyInventory(), receipts: ProjectReadReceipt[] = []
  await commands.execute({ method: 'read_story_inventory', project: path, inventory_id: inventory.id }, storyExecution(20, receipts))
  const file = await current(), source = file.sources[0]!
  await commands.execute({ method: 'read_source', project: path, source_id: source.id, start: 1, count: 1 }, storyExecution(20, receipts))
  await commands.execute({ method: 'review_story_inventory', project: path, expected_revision: file.revision, inventory_id: inventory.id,
    inventory_sha256: inventory.sha256, decision: 'reject', reason: '没有视频证据，不能接受来源复原。' }, storyExecution(30, receipts))
  const saved = await current(); saved.story_inventories![0]!.review!.evidence!.subject_sha256 = '0'.repeat(64)
  await writeFile(path, JSON.stringify(saved))
  await expect(commands.execute({ method: 'status', project: path }, storyExecution())).rejects.toThrow('story_inventory_review')
})
it('reports missing video evidence and allows rejecting an inventory without claiming visual verification', async () => {
  const inventory = await storyInventory(), file = await current()
  const status = await commands.execute({ method: 'status', project: path }, storyExecution())
  expect(status).toMatchObject({ evidence_pending: ['本集没有实际视频图像证据'] })
  await expect(commands.execute({ method: 'read_story_inventory', project: path, inventory_id: 'missing' }, storyExecution()))
    .rejects.toThrow('story_inventory_required')
  await expect(commands.execute({ method: 'review_story_inventory', project: path, expected_revision: file.revision,
    inventory_id: inventory.id, inventory_sha256: inventory.sha256, decision: 'reject', reason: ' ' }, storyExecution()))
    .rejects.toThrow('review_reason')
})

async function refinementForkRequest(): Promise<Extract<ProjectRequest, { method: 'fork_refinement' }>> {
  const id = await fact('thought', 1, '甲'), candidate = await stage([scene(id)]), file = await current(), grant = humanGrant()
  commands = new ProjectCommands(ctx.fs, limits, ctx.attachments, 'independent', 'source-preserving-v1')
  return { method: 'fork_refinement', project: path, expected_revision: file.revision, destination: join(root, 'refinement-branch.json'),
    baseline_candidate_ids: [candidate.id], scope_instructions: '仅基线第一集，不改事件。', authorization_quote: grant.quote,
    consent_assessment: grant.consent_assessment, allowed_categories: [] }
}
it.each(['blank-scope', 'blank-consent', 'empty-baseline', 'missing-baseline', 'missing-user'] as const)(
  'rejects refinement %s before publishing a branch', async (failure) => {
    const request = await refinementForkRequest(), exec = storyExecution(), before = await readFile(path, 'utf8')
    if (failure === 'blank-scope') request.scope_instructions = ' '
    if (failure === 'blank-consent') request.consent_assessment = ' '
    if (failure === 'empty-baseline') request.baseline_candidate_ids = []
    if (failure === 'missing-baseline') request.baseline_candidate_ids = ['not-a-real-candidate']
    if (failure === 'missing-user') delete exec.authorization
    await expect(commands.execute(request, exec)).rejects.toThrow(failure === 'missing-baseline' ? 'refinement_baseline'
      : failure === 'missing-user' ? 'refinement_human_authorization' : 'refinement_scope')
    expect(await readFile(path, 'utf8')).toBe(before)
  },
)
it('keeps the accepted prefix in a later refinement fork and rejects nested or disabled refinement writes', async () => {
  const request = await refinementForkRequest(), first = (await current()).candidates[0]!
  await approveAndCommit(first.id, first.sha256)
  const file = await current()
  await run({ method: 'stage', project: path, expected_revision: file.revision, episode: 2, scenes: [scene(file.facts[0]!.id)] })
  const second = (await current()).candidates.at(-1)!
  await commands.execute({ ...request, expected_revision: (await current()).revision,
    baseline_candidate_ids: [second.id] }, storyExecution())
  path = request.destination; const refined = await current()
  expect(refined.accepted).toEqual([first.id])
  expect(refined.refinement!.retained_candidates).toEqual([{ id: first.id, sha256: first.sha256 }])
  await expect(commands.execute({ ...request, project: path, expected_revision: refined.revision,
    destination: join(root, 'nested-refinement.json') }, storyExecution()))
    .rejects.toThrow('refinement_original_project')
  commands = new ProjectCommands(ctx.fs, limits, ctx.attachments)
  await expect(run({ method: 'propose_fact', project: path, expected_revision: refined.revision, fact: {
    kind: 'action', origin: 'adaptation', actor: '甲', layer: 'present', summary: '擅自补动作。', anchors: [], adaptation_reason: '自称授权。' } }))
    .rejects.toThrow('refinement_disabled')
  const forkStory = await storyForkRequest()
  commands = new ProjectCommands(ctx.fs, limits, ctx.attachments, 'self-check', 'disabled', 'story-faithful-v2')
  await expect(commands.execute(forkStory, storyExecution())).rejects.toThrow('story_fork_original')
})
it('requires a contiguous actual refinement baseline rather than a gap or a future draft', async () => {
  const request = await refinementForkRequest(), saved = await current(), first = saved.candidates[0]!
  const third = { ...structuredClone(first), id: brandString<typeof first.id>('c:00000000-0000-4000-8000-000000000003'), episode: 3 }
  third.sha256 = candidateDigest(third); saved.candidates.push(third)
  await writeFile(path, JSON.stringify(saved))
  await expect(commands.execute({ ...request, baseline_candidate_ids: [first.id, third.id] }, storyExecution()))
    .rejects.toThrow('refinement_scope')
  await expect(commands.execute({ ...request, baseline_candidate_ids: [third.id] }, storyExecution())).rejects.toThrow('refinement_scope')
})
it('rejects unenabled or non-model self-check writes while retaining independent source approvals', async () => {
  const saved = await current(); saved.review_mode = 'self-check'; await writeFile(path, JSON.stringify(saved))
  const proposed: ProjectRequest = { method: 'propose_fact', project: path, expected_revision: saved.revision,
    fact: { kind: 'action', origin: 'source', layer: 'present', summary: saved.sources[0]!.units[3]!.text,
      anchors: [{ unit_id: saved.sources[0]!.units[3]!.id, quote: saved.sources[0]!.units[3]!.text }] } }
  await expect(run(proposed)).rejects.toThrow('self_check_mode')
  commands = new ProjectCommands(ctx.fs, limits, ctx.attachments, 'self-check')
  await expect(run(proposed)).rejects.toThrow('self_check_step')
  await commands.execute(proposed, storyExecution())
  const created = await current(); commands = new ProjectCommands(ctx.fs, limits, ctx.attachments)
  await expect(commands.execute({ method: 'review_fact', project: path, expected_revision: created.revision, fact_id: created.facts[0]!.id,
    decision: 'reject', reason: '部署未启用自检。' }, storyExecution())).rejects.toThrow('self_check_mode')
})
it('does not accept story notes or semantic reports on an ordinary independently reviewed project', async () => {
  const id = await fact('thought', 1, '甲'), candidate = await stage([scene(id)]), file = await current()
  await expect(run({ method: 'stage', project: path, expected_revision: file.revision, episode: 1, scenes: [scene(id)], story_notes: {
    inventory_id: 'missing', mapping: [], dispositions: [], changes: [], scene_changes: [], editor_comments: [], unresolved: [] } }))
    .rejects.toThrow('story_policy_required')
  await expect(run({ method: 'review', project: path, expected_revision: file.revision, candidate_id: candidate.id,
    candidate_sha256: candidate.sha256, decision: 'reject', reason: '旧策略须保留。', semantic_report: {
      event_chain: '原文只有心理。', emotion_conflict: '甲知道钥匙位置。', relationship_stance: '无关系变化。',
      causality_reveal: '无新的揭示。', checks: [], deviations: [], unverified: [] } }, 'reviewer'))
    .rejects.toThrow('story_policy_required')
})

async function preparedStoryCandidate(extraNotesFact = false) {
  const inventory = await storyInventory(true, extraNotesFact ? ['minimal_os'] : [])
  const file = await current(), receipts: ProjectReadReceipt[] = []
  const proof = file.sources.find(source => source.video !== undefined)!.trusted_video_receipt!
  const exec = (step: number): ProjectExecution => ({ ...storyExecution(step, receipts), verifyStoryVideo: async () => proof })
  await commands.execute({ method: 'read_story_inventory', project: path, inventory_id: inventory.id }, exec(20))
  for (const source of file.sources) await commands.execute({ method: 'read_source', project: path, source_id: source.id,
    start: 1, count: source.kind === 'text' ? 1 : source.units.length }, exec(20))
  await commands.execute({ method: 'review_story_inventory', project: path, expected_revision: file.revision, inventory_id: inventory.id,
    inventory_sha256: inventory.sha256, decision: 'approve', reason: '单元测试回调证明，只有固定心理原文；不声称真实视频质量。' }, exec(30))
  if (extraNotesFact) {
    const reviewed = await current(), policy = reviewed.story_policy!, unit = reviewed.sources[0]!.units[0]!
    await commands.execute({ method: 'propose_fact', project: path, expected_revision: reviewed.revision, fact: {
      kind: 'thought', origin: 'adaptation', actor: '甲', layer: 'present', summary: '甲心里确认自己知情。',
      anchors: [{ unit_id: unit.id, quote: unit.text }], adaptation_reason: '获准的同一心理轻微表达，未加入实际成稿。',
      story_supplement: { category: 'minimal_os', policy_sha256: policy.sha256,
        authorization_sha256: sha256(JSON.stringify(policy.authorization)) } } }, exec(34))
    const proposed = await current(), additional = proposed.facts.at(-1)!
    await commands.execute({ method: 'read_fact', project: path, fact_id: additional.id }, exec(35))
    await commands.execute({ method: 'read_source', project: path, source_id: proposed.sources[0]!.id, start: 1, count: 1 }, exec(35))
    await commands.execute({ method: 'review_fact', project: path, expected_revision: proposed.revision, fact_id: additional.id,
      decision: 'approve', reason: '确认是获准心理表达的候选解释。' }, exec(36))
  }
  const currentFile = await current(), scenes = [scene(currentFile.facts[0]!.id)], notes = {
    inventory_id: inventory.id, mapping: [{ item_id: 'thought', outputs: [{ scene: 1, beat: 1, text: scenes[0]!.beats[0]!.text }] }],
    dispositions: [{ fact_id: currentFile.facts[0]!.id, disposition: 'retained' as const, reason: '保留原心理归属。' }],
    changes: [{ source: { fact_id: extraNotesFact ? currentFile.facts.at(-1)!.id : currentFile.facts[0]!.id,
      unit_id: currentFile.facts[0]!.anchors[0]!.unit_id },
    after: { scene: 1, beat: 1, text: scenes[0]!.beats[0]!.text }, reason: '将原文心理归属标记改为剧本OS格式。' }],
    scene_changes: [{ scene: 1, reason: '保持门前原场次。' }], editor_comments: [], unresolved: [],
  }
  return { inventory, file: currentFile, scenes, notes, proof, exec }
}
it.each(['missing', 'pending', 'error'] as const)('reports inspection recovery %s accurately in story status', async (failure) => {
  await storyInventory(true)
  const file = await current(), proof = file.sources[1]!.trusted_video_receipt!
  const exec: ProjectExecution = { ...storyExecution(), ...(failure === 'missing' ? {} : {
    verifyStoryVideo: async () => {
      throw Error(failure === 'pending' ? 'video_evidence_pending: recheck' : 'unexpected resolver failure')
    },
  }) }
  if (failure === 'error') await expect(commands.execute({ method: 'status', project: path }, exec))
    .rejects.toThrow('unexpected resolver failure')
  else expect(await commands.execute({ method: 'status', project: path }, exec))
    .toMatchObject({ evidence_pending: [expect.stringContaining('当前实际检查未恢复')] })
  expect(await commands.execute({ method: 'status', project: path }, { ...storyExecution(), verifyStoryVideo: async () => proof }))
    .toMatchObject({ evidence_pending: [] })
})
it('requires current inspection recovery for inventory approval and final story staging', async () => {
  const prepared = await preparedStoryCandidate(), request = { method: 'stage' as const, project: path,
    expected_revision: prepared.file.revision, episode: 1, scenes: prepared.scenes, coverage: stageCoverage(prepared.inventory.coverage),
    story_notes: prepared.notes }
  await expect(commands.execute(request, storyExecution(40))).rejects.toThrow('story_video_evidence_pending')
  const { story_notes: _notes, ...missingNotes } = request
  await expect(commands.execute(missingNotes, prepared.exec(40))).rejects.toThrow('story_report_required')
  await commands.execute(request, prepared.exec(40)); const candidate = (await current()).candidates[0]!
  await expect(commands.execute({ method: 'review', project: path, expected_revision: (await current()).revision,
    candidate_id: candidate.id, candidate_sha256: candidate.sha256, decision: 'reject', reason: '尚未语义核对。' }, prepared.exec(50)))
    .rejects.toThrow('story_semantic_required')
})

async function acceptedStory() {
  const prepared = await preparedStoryCandidate()
  await commands.execute({ method: 'stage', project: path, expected_revision: prepared.file.revision, episode: 1,
    scenes: prepared.scenes, coverage: stageCoverage(prepared.inventory.coverage), story_notes: prepared.notes }, prepared.exec(40))
  let file = await current(); const candidate = file.candidates[0]!
  await commands.execute({ method: 'read_candidate', project: path, candidate_id: candidate.id }, prepared.exec(50))
  for (const source of file.sources) await commands.execute({ method: 'read_source', project: path, source_id: source.id,
    start: 1, count: source.kind === 'text' ? 1 : source.units.length }, prepared.exec(50))
  await commands.execute({ method: 'review', project: path, expected_revision: file.revision, candidate_id: candidate.id,
    candidate_sha256: candidate.sha256, decision: 'approve', reason: '固定原文心理归属不变。',
    zero_action_reason: '单元测试固定样本没有动作事实。',
    semantic_report: { event_chain: '只保留知道钥匙位置的心理。', emotion_conflict: '本人知情，没有新增情绪事件。',
      relationship_stance: '无关系事件。', causality_reveal: '无新因果。',
      checks: [{ item_id: 'thought', status: 'preserved',
        explanation: '原角色本人知情保持。', source_units: [file.facts[0]!.anchors[0]!.unit_id],
        outputs: [{ scene: 1, beat: 1, text: prepared.scenes[0]!.beats[0]!.text }] }],
      deviations: [], unverified: [] } }, prepared.exec(60))
  file = await current()
  const exec = (): ProjectExecution => ({ ...prepared.exec(70), verifyStoryApproval: async () => {} })
  await commands.execute({ method: 'commit', project: path, expected_revision: file.revision, candidate_id: candidate.id,
    candidate_sha256: candidate.sha256 }, exec())
  return { ...prepared, candidate, acceptedExecution: exec }
}
it.each(['inspection', 'approval'] as const)('does not reopen accepted story files without restored %s evidence', async (missing) => {
  const prepared = await acceptedStory()
  commands = new ProjectCommands(ctx.fs, limits, ctx.attachments, 'self-check', 'disabled', 'story-faithful-v2')
  const exec = prepared.acceptedExecution()
  if (missing === 'inspection') delete exec.verifyStoryVideo
  else delete exec.verifyStoryApproval
  await expect(commands.execute({ method: 'status', project: path }, exec)).rejects.toThrow('story_accepted_evidence_pending')
  expect(await commands.execute({ method: 'status', project: path }, prepared.acceptedExecution()))
    .toMatchObject({ accepted: [{ episode: 1 }] })
})
it('exports accepted story metadata with its report, then preserves it when another source is imported', async () => {
  const prepared = await acceptedStory(), directory = join(root, 'story-delivery')
  const delivered = await commands.execute({ method: 'export', project: path, candidate_id: prepared.candidate.id, directory },
    prepared.acceptedExecution())
  expect(delivered).toHaveProperty('files')
  const basename = `episode-1-${prepared.candidate.id.slice(2)}`
  const sidecar: unknown = JSON.parse(await readFile(join(directory, `${basename}.sources.json`), 'utf8'))
  expect(sidecar).toHaveProperty('story_adaptation'); expect(sidecar).toHaveProperty('semantic_report')
  expect(sidecar).toHaveProperty('modification_notes')
  const before = await readFile(join(directory, `${basename}.md`), 'utf8')
  const newSource = join(root, 'new-source.txt'); await writeFile(newSource, '下一次复看新取得的原文。')
  const file = await current()
  await commands.execute({ method: 'import_source', project: path, expected_revision: file.revision, path: newSource, source_kind: 'text',
    story_video_path: file.story_policy!.videos[0]!.path }, prepared.acceptedExecution())
  await commands.execute({ method: 'export', project: path, candidate_id: prepared.candidate.id, directory }, prepared.acceptedExecution())
  expect(await readFile(join(directory, `${basename}.md`), 'utf8')).toBe(before)
})

it('preserves unknown critical inventory evidence in status and rejects out-of-order preparation', async () => {
  const inventory = await storyInventory(), file = await current()
  inventory.items[0]!.critical = true; inventory.items[0]!.evidence = 'unverified'; inventory.sha256 = inventoryDigest(inventory)
  file.story_inventories![0] = inventory; await writeFile(path, JSON.stringify(file))
  expect(await commands.execute({ method: 'status', project: path }, storyExecution()))
    .toMatchObject({ evidence_pending: [expect.stringContaining('没有实际视频'), expect.stringContaining('关键证据尚未核实')] })
  await expect(commands.execute({ method: 'propose_story_inventory', project: path, expected_revision: file.revision, episode: 2,
    coverage: stageCoverage(inventory.coverage),
    items: inventory.items, not_applicable: inventory.not_applicable }, storyExecution()))
    .rejects.toThrow('story_inventory_scope')
})
it('rejects an ungranted new story adaptation while preserving inherited original facts', async () => {
  await storyBranch(); const file = await current()
  await expect(commands.execute({ method: 'propose_fact', project: path, expected_revision: file.revision, fact: {
    kind: 'action', origin: 'adaptation', layer: 'present', summary: '擅自新增动作。', anchors: [],
    adaptation_reason: '自行许可。' } }, storyExecution()))
    .rejects.toThrow('story_supplement_authorization')
})
it('does not import unlinked ASR into a scoped story project', async () => {
  await storyBranch(); const file = await current(), additional = join(root, 'unlinked.txt')
  await writeFile(additional, '用户尚未说明属于哪个原视频。')
  await expect(commands.execute({ method: 'import_source', project: path, expected_revision: file.revision, path: additional,
    source_kind: 'text' }, storyExecution())).rejects.toThrow('story_source_scope')
  expect((await current()).sources).toEqual(file.sources)
})
it.each(['inside', 'outside'] as const)('invalidates an unused story inventory only for a new source fact %s its window', async (position) => {
  const inventory = await storyInventory(), file = await current(), unit = file.sources[0]!.units[position === 'inside' ? 0 : 1]!
  await commands.execute({ method: 'propose_fact', project: path, expected_revision: file.revision, fact: {
    kind: 'action', origin: 'source', layer: 'present', summary: '复看后的来源分类，尚未审核。',
    anchors: [{ unit_id: unit.id, quote: unit.text }] } }, storyExecution(20))
  expect((await current()).story_inventories![0]!.superseded_at_revision)
    .toBe(position === 'inside' ? file.revision + 1 : undefined)
  expect((await current()).story_inventories![0]!.id).toBe(inventory.id)
})
it.each(['later', 'earlier', 'unbounded'] as const)('tracks supplemental source overlap for a %s video window', async (range) => {
  await storyInventory(); const file = await current(), inventory = file.story_inventories![0]!
  inventory.coverage.windows[0]!.interval = { start_seconds: 10, end_seconds: 20 }
  inventory.scope_sha256 = storyScopeDigest(file, inventory); inventory.sha256 = inventoryDigest(inventory)
  await writeFile(path, JSON.stringify(file))
  const extra = join(root, 'extra-window.json')
  const original = VIDEO_INSPECTION.parse(JSON.parse(await readFile(join(root, 'inspection.json'), 'utf8')))
  const interval = range === 'later' ? { start_seconds: 20, end_seconds: 30 } : { start_seconds: 0, end_seconds: 10 }
  const frame = { ...original.frames[0]!, requested_seconds: interval.start_seconds + 1, timestamp_seconds: interval.start_seconds + 1 }
  if (range === 'unbounded') {
    await writeFile(extra, '没有时间范围的新增原文。')
    await commands.execute({ method: 'import_source', project: path, expected_revision: file.revision, path: extra,
      source_kind: 'text', story_video_path: original.path }, storyExecution(20))
  } else {
    await writeFile(extra, JSON.stringify({ ...original, interval, frames: [frame] }))
    await expect(commands.execute({ method: 'import_source', project: path, expected_revision: file.revision, path: extra,
      source_kind: 'video_inspection' }, storyExecution(20))).rejects.toThrow('story_video_evidence_pending')
    const existingProof = await storyInspectionProof(extra)
    await commands.execute({ method: 'import_source', project: path, expected_revision: file.revision, path: extra,
      source_kind: 'video_inspection' }, { ...storyExecution(20), verifyStoryVideo: async () => existingProof })
  }
  expect((await current()).story_inventories![0]!.superseded_at_revision)
    .toBe(range === 'unbounded' ? file.revision + 1 : undefined)
})
async function storyInspectionProof(manifestPath: string) {
  const text = await readFile(manifestPath, 'utf8'), manifest = VIDEO_INSPECTION.parse(JSON.parse(text))
  const receipt = { seq: SessionSeq(1), sha256: '2'.repeat(64) }, interval = manifest.interval ?? { start_seconds: 0, end_seconds: 30 }
  return TRUSTED_VIDEO_INSPECTION_RECEIPT.parse({ version: 'trusted-video-inspection-v2', video_path: manifest.path,
    source_version: manifest.source_version, duration_seconds: manifest.duration_seconds,
    metadata_manifest_path: join(root, 'metadata.json'),
    manifest_path: manifestPath, metadata_manifest_sha256: '3'.repeat(64), manifest_sha256: sha256(text), plan: [interval],
    windows: [{ ...interval, sample_requested_seconds: manifest.frames.map(frame => frame.requested_seconds),
      decoded_pts_seconds: manifest.frames.map(frame => frame.timestamp_seconds), frames: manifest.frames }],
    model_input_step: SessionSeq(2), unresolved: [], evidence: { session_id: SessionId('writer'), metadata_result: receipt,
      metadata_root_result: receipt, sample_result: receipt, sample_root_result: receipt, metadata_ancestors: [], sample_ancestors: [],
      model_response: receipt, model_input_sha256: '4'.repeat(64) } })
}

it('retains the legacy video workflow when forking its original source into a new story grant', async () => {
  const file = await current(); file.workflow = 'video_to_screenplay'; await writeFile(path, JSON.stringify(file))
  const request = await storyForkRequest()
  commands = new ProjectCommands(ctx.fs, limits, ctx.attachments, 'self-check', 'disabled', 'story-faithful-v2')
  await commands.execute(request, storyExecution()); path = request.destination
  expect((await current()).story_policy!.legacy_workflow).toBe('video_to_screenplay')
})
it('reads a story grant with no inventory history without manufacturing a completed inventory', async () => {
  await storyBranch(); const file = await current(); delete file.story_inventories; await writeFile(path, JSON.stringify(file))
  expect(await commands.execute({ method: 'status', project: path }, storyExecution()))
    .toMatchObject({ story_inventories: [], evidence_pending: [] })
})
it('requires successful model-visible read receipts for self-check rather than accepting a missing receipt list', async () => {
  const saved = await current(); saved.review_mode = 'self-check'; await writeFile(path, JSON.stringify(saved))
  commands = new ProjectCommands(ctx.fs, limits, ctx.attachments, 'self-check')
  const unit = saved.sources[0]!.units[3]!
  await commands.execute({ method: 'propose_fact', project: path, expected_revision: saved.revision, fact: {
    kind: 'action', origin: 'source', layer: 'present', summary: unit.text,
    anchors: [{ unit_id: unit.id, quote: unit.text }] } }, storyExecution())
  const proposed = await current(), exec = storyExecution(30); delete exec.receipts
  await expect(commands.execute({ method: 'review_fact', project: path, expected_revision: proposed.revision,
    fact_id: proposed.facts[0]!.id, decision: 'approve', reason: '没有读回证据不能批准。' }, exec)).rejects.toThrow('self_check_read_required')
})
it('rejects withdrawing a self-checked fact after moving to a deployment without self-check writing', async () => {
  const saved = await current(); saved.review_mode = 'self-check'; await writeFile(path, JSON.stringify(saved))
  commands = new ProjectCommands(ctx.fs, limits, ctx.attachments, 'self-check')
  const receipts: ProjectReadReceipt[] = [], unit = saved.sources[0]!.units[3]!
  await commands.execute({ method: 'propose_fact', project: path, expected_revision: saved.revision, fact: {
    kind: 'action', origin: 'source', layer: 'present', summary: unit.text,
    anchors: [{ unit_id: unit.id, quote: unit.text }] } }, storyExecution())
  const proposed = await current(), fact = proposed.facts[0]!
  await commands.execute({ method: 'read_fact', project: path, fact_id: fact.id }, storyExecution(20, receipts))
  await commands.execute({ method: 'read_source', project: path, source_id: proposed.sources[0]!.id, start: 4, count: 1 },
    storyExecution(20, receipts))
  await commands.execute({ method: 'review_fact', project: path, expected_revision: proposed.revision, fact_id: fact.id,
    decision: 'approve', reason: '原文与动作对应。' }, storyExecution(30, receipts))
  const approved = await current(), missingReads = storyExecution(40); delete missingReads.receipts
  await expect(commands.execute({ method: 'withdraw_fact', project: path, expected_revision: approved.revision, fact_id: fact.id,
    reason: '缺少此次重读证据。' }, missingReads)).rejects.toThrow('self_check_read_required')
  commands = new ProjectCommands(ctx.fs, limits, ctx.attachments)
  await expect(commands.execute({ method: 'withdraw_fact', project: path, expected_revision: approved.revision, fact_id: fact.id,
    reason: '没有当前写入权限。' }, storyExecution(40))).rejects.toThrow('self_check_mode')
})

function retainedNotes(text: string) {
  return { changes: [{ before: { scene: 1, beat: 1, text }, after: { scene: 1, beat: 1, text: '钥匙在哪里，我知道。' }, reason: '调整语序，保持原人物知情。' }],
    editor_comments: [], unresolved: [], unhandled: [], validation: {
      semantic: { status: 'limited' as const, scenes: [1], reason: '只核对该集人物心理归属。' },
      visual: { status: 'not_run' as const, source_units: [], reason: '文本来源没有视觉证据。' },
    } }
}
it.each(['current', 'legacy'] as const)('reads the actual baseline and rejects out-of-scope drafts for a %s refinement', async (version) => {
  const request = await refinementForkRequest()
  if (version === 'legacy') {
    const saved = await current(), baseline = saved.candidates[0]!
    delete baseline.source_ids; baseline.sha256 = candidateDigest(baseline); await writeFile(path, JSON.stringify(saved))
  }
  await commands.execute(request, storyExecution()); path = request.destination
  const file = await current(), baseline = file.refinement!.baselines[0]!, scenes = [scene(file.facts[0]!.id)]
  const notes = retainedNotes(scenes[0]!.beats[0]!.text)
  scenes[0]!.beats[0]!.text = '钥匙在哪里，我知道。'
  await run({ method: 'stage', project: path, expected_revision: file.revision, episode: 1, scenes, modification_notes: notes })
  const candidate = (await current()).candidates[0]!
  expect(await run({ method: 'read_candidate', project: path, candidate_id: candidate.id }))
    .toMatchObject({ baseline: { id: baseline.id, sha256: baseline.sha256 } })
  await approveAndCommit(candidate.id, candidate.sha256)
  await expect(run({ method: 'stage', project: path, expected_revision: (await current()).revision, episode: 2,
    scenes, modification_notes: notes })).rejects.toThrow('refinement_scope')
})
it('does not accept modification notes before the original project has a refinement authorization', async () => {
  const id = await fact('thought', 1, '甲'), scenes = [scene(id)]
  await expect(run({ method: 'stage', project: path, expected_revision: (await current()).revision, episode: 1, scenes,
    modification_notes: retainedNotes(scenes[0]!.beats[0]!.text) })).rejects.toThrow('refinement_policy_required')
})
it('does not stage an authorized story without the declared source coverage', async () => {
  const prepared = await preparedStoryCandidate()
  await expect(commands.execute({ method: 'stage', project: path, expected_revision: prepared.file.revision,
    episode: 1, scenes: prepared.scenes, story_notes: prepared.notes }, prepared.exec(40))).rejects.toThrow('story_candidate_digest')
})
it('retains export approval-log verification even after an accepted project enters the validation cache', async () => {
  const prepared = await acceptedStory()
  await commands.execute({ method: 'status', project: path }, prepared.acceptedExecution())
  const exec = prepared.acceptedExecution(); delete exec.verifyStoryApproval
  await expect(commands.execute({ method: 'export', project: path, candidate_id: prepared.candidate.id,
    directory: join(root, 'cached-export') }, exec)).rejects.toThrow('story_approval_log_pending')
})
it('rejects a null scene file at the root and keeps the candidate list unchanged', async () => {
  const file = join(root, 'null-scene.json'); await writeFile(file, 'null')
  const before = await readFile(path, 'utf8')
  await expect(run({ method: 'stage_files', project: path, expected_revision: (await current()).revision,
    episode: 1, files: [file] })).rejects.toThrow('root:')
  expect(await readFile(path, 'utf8')).toBe(before)
})

it('keeps a legacy accepted prefix separate from pending story preparation and new source facts', async () => {
  const inventory = await storyInventory(), originalPath = join(root, 'project.json')
  path = originalPath; commands = new ProjectCommands(ctx.fs, limits, ctx.attachments)
  const first = await stage([scene((await current()).facts[0]!.id)]); await approveAndCommit(first.id, first.sha256)
  const request = await storyForkRequest(), grant = humanGrant()
  grant.quote = '保留第一集，只处理当前原视频的第二集。'; grant.consent_assessment = '本次授权仅第二集，不覆盖已批准第一集。'
  request.destination = join(root, 'second-story.json'); request.before_episode = 2; request.episodes = [2]
  request.videos[0]!.episode = 2; request.authorization_quote = grant.quote; request.consent_assessment = grant.consent_assessment
  commands = new ProjectCommands(ctx.fs, limits, ctx.attachments, 'self-check', 'disabled', 'story-faithful-v2')
  await commands.execute(request, { ...storyExecution(), authorization: grant }); path = request.destination
  let file = await current()
  await commands.execute({ method: 'propose_story_inventory', project: path, expected_revision: file.revision, episode: 2,
    coverage: stageCoverage(inventory.coverage), items: inventory.items, not_applicable: inventory.not_applicable }, storyExecution())
  expect(await commands.execute({ method: 'status', project: path }, storyExecution()))
    .toMatchObject({ accepted: [{ id: first.id, episode: 1 }], evidence_pending: ['本集没有实际视频图像证据'] })
  file = await current(); const unit = file.sources[0]!.units[1]!
  await commands.execute({ method: 'propose_fact', project: path, expected_revision: file.revision, fact: {
    kind: 'action', origin: 'source', layer: 'present', summary: '第二集新增待审来源分类。',
    anchors: [{ unit_id: unit.id, quote: unit.text }] } }, storyExecution(20))
  expect((await current()).accepted).toEqual([first.id])
  expect((await current()).story_inventories![0]!.superseded_at_revision).toBeUndefined()
})

it('retains a legacy frame source video identity and ignores supplemental evidence from another granted original', async () => {
  await storyInventory(true); const file = await current(), inventory = file.story_inventories![0]!, original = file.sources[1]!
  delete original.story_video_path
  inventory.coverage.windows.reverse(); inventory.scope_sha256 = storyScopeDigest(file, inventory)
  inventory.sha256 = inventoryDigest(inventory)
  const otherVideo = join(root, 'other-original.mp4'); await writeFile(otherVideo, 'Separate original media bytes')
  const signal = new AbortController().signal, target = await ctx.fs.resolve(otherVideo, { signal })
  const version = (await ctx.fs.stat(target, signal))!.version
  file.story_policy!.videos.push({ path: otherVideo, source_version: version, episode: 1 })
  file.story_policy!.sha256 = storyPolicyDigest(file.story_policy!)
  inventory.policy_sha256 = file.story_policy!.sha256; inventory.scope_sha256 = storyScopeDigest(file, inventory)
  inventory.sha256 = inventoryDigest(inventory)
  await writeFile(path, JSON.stringify(file))
  const sourceFile = join(root, 'other-source.txt'); await writeFile(sourceFile, '另一个原视频的来源，未纳入当前清单。')
  await commands.execute({ method: 'import_source', project: path, expected_revision: file.revision, path: sourceFile,
    source_kind: 'text', story_video_path: otherVideo }, storyExecution(20))
  expect((await current()).story_inventories![0]!.superseded_at_revision).toBeUndefined()
  expect((await current()).sources[1]!.video!.path).toBe(original.video!.path)
})

it('preserves an approved supplemental fact referenced only by a saved story change note', async () => {
  const prepared = await preparedStoryCandidate(true)
  await commands.execute({ method: 'stage', project: path, expected_revision: prepared.file.revision, episode: 1,
    scenes: prepared.scenes, coverage: stageCoverage(prepared.inventory.coverage), story_notes: prepared.notes }, prepared.exec(40))
  const saved = await current(), supplemental = saved.facts.at(-1)!, candidate = saved.candidates[0]!
  expect(candidate.scenes.flatMap(scene => scene.beats.flatMap(beat => beat.fact_ids))).not.toContain(supplemental.id)
  expect(candidate.story_adaptation!.notes.dispositions.map(disposition => disposition.fact_id)).not.toContain(supplemental.id)
  await expect(commands.execute({ method: 'withdraw_fact', project: path, expected_revision: saved.revision, fact_id: supplemental.id,
    reason: '说明中引用也必须保留历史。' }, prepared.exec(50))).rejects.toThrow('fact_in_history')
  expect((await current()).facts.at(-1)!.withdrawal).toBeUndefined()
})

it('requires model-visible inventory reads even when rejecting a pending inventory', async () => {
  const inventory = await storyInventory(), file = await current(), exec = storyExecution(30); delete exec.receipts
  await expect(commands.execute({ method: 'review_story_inventory', project: path, expected_revision: file.revision,
    inventory_id: inventory.id, inventory_sha256: inventory.sha256, decision: 'reject', reason: '没有读回记录。' }, exec))
    .rejects.toThrow('self_check_read_required')
})
it('withdraws an unused supplemental interpretation without invalidating the source inventory', async () => {
  const prepared = await preparedStoryCandidate(true), file = await current(), supplemental = file.facts.at(-1)!
  await commands.execute({ method: 'read_fact', project: path, fact_id: supplemental.id }, prepared.exec(40))
  await commands.execute({ method: 'read_source', project: path, source_id: file.sources[0]!.id, start: 1, count: 1 }, prepared.exec(40))
  await commands.execute({ method: 'withdraw_fact', project: path, expected_revision: file.revision, fact_id: supplemental.id,
    reason: '未使用的表达解释撤销，不改变原来源事实。' }, prepared.exec(50))
  const withdrawn = await current()
  expect(withdrawn.facts.at(-1)!.withdrawal).toMatchObject({ kind: 'self-check' })
  expect(withdrawn.story_inventories![0]!.superseded_at_revision).toBeUndefined()
})
