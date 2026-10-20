/** Sparse episode drafting and adoption preserve real identities, history, and continuity disclosures. */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import { brandString } from '@deepseek-ai/dsh-brand'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ProjectCommands } from '../src/project.ts'
import type { ProjectExecution } from '../src/project.ts'
import { PROJECT_FILE } from '../src/schema.ts'
import type { ProjectRequest } from '../src/schema.ts'
import { acceptedCandidates, acceptedKnowledge, acceptedScripts } from '../src/episode.ts'
import * as episodeRendering from '../src/episode.ts'
import type { ActorId, FactId } from '../src/ids.ts'
import type { HumanAuthorization } from '../src/refinement.ts'

const actor = brandString<ActorId>('episode-author')
const limits = { maxSourceBytes: 100_000, maxProjectBytes: 1_000_000, maxReadUnits: 30, maxReadBytes: 100_000, maxFactBatch: 20 }
let root: string, project: string, source: string, ctx: Context, commands: ProjectCommands
const current = async () => PROJECT_FILE.parse(JSON.parse(await readFile(project, 'utf8')))
const run = (request: ProjectRequest, execution: Partial<ProjectExecution> = {}) => commands.execute(request, {
  actor, cwd: root, signal: new AbortController().signal, ...execution,
})

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'screenplay-episodes-'))
  project = join(root, 'project.json'); source = join(root, 'source.txt')
  ctx = new Context()
  await ctx.plugin(LocalFileSystem, { cwd: root })
  await ctx.plugin(LocalAttachmentStore, { dshHome: root })
  commands = new ProjectCommands(ctx.fs, limits, ctx.attachments, 'advisory', 'source-preserving-v1', 'story-faithful-v2')
  await writeFile(source, '甲想：钥匙在我手里。\n甲想：门外有人。\n')
  await run({ method: 'init', project, mode: 'faithful', instructions: '按实际集号创作，保留来源。' })
  await run({ method: 'import_source', project, expected_revision: 0, path: source, source_kind: 'text' })
  const file = await current()
  await run({ method: 'propose_facts', project, expected_revision: file.revision, facts: file.sources[0]!.units.filter(unit => unit.text.trim()).map(unit => ({
    kind: 'thought', actor: '甲', origin: 'source', layer: 'present', summary: unit.text,
    anchors: [{ unit_id: unit.id, quote: unit.text }],
  })) })
})
afterEach(async () => { vi.restoreAllMocks(); await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })

async function draft(episode: number, factIndex = 0, prerequisites: FactId[] = []) {
  const file = await current(), fact = file.facts[factIndex]!
  const result = await run({ method: 'stage', project, expected_revision: file.revision, episode,
    scenes: [{ location: '门前', time: '日', layer: 'present', transition: 'opening', characters: ['甲'],
      beats: [{ kind: 'os', actor: '甲', text: factIndex === 0 ? '钥匙在我手里。' : '门外有人。', fact_ids: [fact.id],
        requires_knowledge: prerequisites, witnesses: [] }] }] })
  return { candidate: (await current()).candidates.at(-1)!, result }
}
async function adopt(candidate: Awaited<ReturnType<typeof draft>>['candidate']) {
  return run({ method: 'commit', project, expected_revision: (await current()).revision,
    candidate_id: candidate.id, candidate_sha256: candidate.sha256 })
}

it('keeps status and export continuity summaries empty when a renderer omits its optional advice', async () => {
  const { candidate } = await draft(1)
  await adopt(candidate)
  const file = await current(), rendered = episodeRendering.renderEpisode(file, candidate.scenes, {}, 1, candidate)
  const { continuity_advisory: _advice, ...withoutAdvice } = rendered
  const accepted = acceptedScripts(file).map(({ continuity_advisory: _continuity, ...script }) => script)
  vi.spyOn(episodeRendering, 'acceptedScripts').mockReturnValue(accepted)
  expect(await run({ method: 'status', project })).toMatchObject({ continuity_advisory: [], continuity_advisory_total: 0 })
  vi.spyOn(episodeRendering, 'renderEpisode').mockReturnValue(withoutAdvice)
  expect(await run({ method: 'export', project, candidate_id: candidate.id, directory: join(root, 'optional-advice') }))
    .toMatchObject({ continuity_advisory: [], adoption: { adopted: true } })
  expect(await readFile(join(root, 'optional-advice', `episode-1-${candidate.id.slice(2)}.md`), 'utf8')).toBe(rendered.script)
})

it('drafts several arbitrary episodes and exports a real unadopted version without changing the project', async () => {
  await draft(8); await draft(3); const { candidate } = await draft(10)
  const before = await readFile(project, 'utf8')
  expect(await run({ method: 'status', project })).toMatchObject({ next_episode: 1, accepted: [],
    pending: [{ episode: 8 }, { episode: 3 }, { episode: 10 }],
    candidate_states: [{ adopted: false }, { adopted: false }, { adopted: false }] })
  const result = await run({ method: 'export', project, candidate_id: candidate.id, directory: join(root, 'draft-delivery') })
  expect(result).toMatchObject({ candidate_id: candidate.id, adoption: { episode: 10, adopted: false, committed_at: null, review: null } })
  expect(await readFile(join(root, 'draft-delivery', `episode-10-${candidate.id.slice(2)}.md`), 'utf8')).toMatch(/^第10集\n10-1 /)
  expect(await readFile(project, 'utf8')).toBe(before)
})

it('assembles a later episode from actual scene files before any adoption', async () => {
  const file = await current(), path = join(root, 'episode12-scene.json')
  await writeFile(path, JSON.stringify({ location: '门前', time: '日', layer: 'present', transition: 'opening', characters: ['甲'],
    beats: [{ kind: 'os', actor: '甲', text: '钥匙在我手里。', fact_ids: [file.facts[0]!.id], requires_knowledge: [], witnesses: [] }] }))
  const result = await run({ method: 'stage_files', project, expected_revision: file.revision, episode: 12, files: [path] })
  expect(result).toMatchObject({ candidate: { episode: 12 } })
  expect(result).toHaveProperty('rendered.script', expect.stringMatching(/^第12集\n12-1 /))
  expect((await current()).accepted).toEqual([])
})

it('adopts drafts out of order, reviews after other adoptions, and cold-recovers actual episode identities', async () => {
  const eight = await draft(8), three = await draft(3), ten = await draft(10)
  await adopt(eight.candidate); await adopt(three.candidate); await adopt(ten.candidate)
  await run({ method: 'review', project, expected_revision: (await current()).revision, candidate_id: eight.candidate.id,
    candidate_sha256: eight.candidate.sha256, decision: 'reject', reason: '采用与实际审校意见分别记录。' })
  commands = new ProjectCommands(ctx.fs, limits, ctx.attachments, 'advisory')
  expect(await run({ method: 'status', project })).toMatchObject({ next_episode: 1, accepted: [{ episode: 3 }, { episode: 8 }, { episode: 10 }] })
  const file = await current()
  expect(file.accepted).toEqual([three.candidate.id, eight.candidate.id, ten.candidate.id])
  expect(file.candidates.map(candidate => candidate.base_episode)).toEqual([0, 0, 0])
  expect(acceptedScripts(file).map(candidate => candidate.script.split('\n')[0])).toEqual(['第3集', '第8集', '第10集'])
  expect(file.candidates[0]?.review).toMatchObject({ actor, kind: 'advisory', decision: 'reject' })
})

it('keeps replaced versions and reports downstream knowledge risks after adopting an earlier revision', async () => {
  const original = await draft(3); await adopt(original.candidate)
  const mainId = (await current()).facts[0]!.id
  const later = await draft(5, 1, [mainId]); await adopt(later.candidate)
  expect(later.result).toMatchObject({ rendered: { continuity_advisory: [] } })
  const oldVersion = structuredClone((await current()).candidates[0]!)
  const revised = await draft(3, 1)
  const result = await adopt(revised.candidate)
  expect(result).toMatchObject({ accepted: [{ id: revised.candidate.id, episode: 3 }, { id: later.candidate.id, episode: 5 }],
    continuity_advisory: [expect.stringContaining('第5集第1场第1拍')] })
  const file = await current()
  expect(file.candidates[0]).toEqual(oldVersion)
  expect(file.candidates[0]?.sha256).toBe(original.candidate.sha256)
  const read = await run({ method: 'read_candidate', project, candidate_id: later.candidate.id })
  expect(read).toMatchObject({ rendered: { continuity_advisory: [expect.stringContaining(mainId)] } })
  const exported = await run({ method: 'export', project, candidate_id: original.candidate.id, directory: join(root, 'history-delivery') })
  expect(exported).toMatchObject({ adoption: { episode: 3, adopted: false, committed_at: oldVersion.committed_at } })
  expect(acceptedKnowledge(file, 3)).toEqual({})
  const earlier = await draft(1, 1, [mainId])
  expect(earlier.result).toMatchObject({ rendered: { continuity_advisory: [expect.stringContaining(mainId)] } })
  expect(acceptedKnowledge(file, 5)['present:甲']).not.toContain(mainId)
  expect(earlier.result).toHaveProperty('rendered.script', expect.not.stringContaining('knowledge_not_acquired'))
})

it('re-adopts a historical version without rewriting its original adoption time and does not duplicate current adoption', async () => {
  const first = await draft(4); await adopt(first.candidate)
  const original = structuredClone((await current()).candidates[0]!)
  const replacement = await draft(4, 1); await adopt(replacement.candidate)
  await adopt(original)
  const file = await current()
  expect(file.accepted).toEqual([original.id])
  expect(file.candidates[0]).toEqual(original)
  const bytes = await readFile(project, 'utf8')
  await adopt(original)
  expect(await readFile(project, 'utf8')).toBe(bytes)
})

it('refuses to overwrite an earlier export when preceding adopted knowledge changes', async () => {
  const earlier = await draft(3); await adopt(earlier.candidate)
  const later = await draft(8, 1); await adopt(later.candidate)
  const directory = join(root, 'fixed-export')
  await run({ method: 'export', project, candidate_id: later.candidate.id, directory })
  const basename = `episode-8-${later.candidate.id.slice(2)}`
  const script = await readFile(join(directory, `${basename}.md`), 'utf8')
  const sidecar = await readFile(join(directory, `${basename}.sources.json`), 'utf8')
  const replacement = await draft(3, 1); await adopt(replacement.candidate)
  await expect(run({ method: 'export', project, candidate_id: later.candidate.id, directory })).rejects.toThrow('export_changed')
  expect(await readFile(join(directory, `${basename}.md`), 'utf8')).toBe(script)
  expect(await readFile(join(directory, `${basename}.sources.json`), 'utf8')).toBe(sidecar)
})

it('marks bounded candidate and continuity status summaries as partial without embedding review reports', async () => {
  const prerequisite = (await current()).facts[0]!.id
  const first = await draft(3, 1, [prerequisite]), second = await draft(6, 1, [prerequisite])
  await adopt(first.candidate); await adopt(second.candidate)
  await run({ method: 'review', project, expected_revision: (await current()).revision,
    candidate_id: second.candidate.id, candidate_sha256: second.candidate.sha256, decision: 'reject', reason: '实际审校意见。' })
  commands = new ProjectCommands(ctx.fs, { ...limits, maxReadUnits: 1 }, ctx.attachments, 'advisory')
  const status = await run({ method: 'status', project })
  expect(status).toMatchObject({ candidate_states_total: 2, candidate_states_truncated: true,
    candidate_states: [{ id: second.candidate.id, review: { decision: 'reject', actor, kind: 'advisory' } }],
    continuity_advisory_total: 2, continuity_advisory_truncated: true,
    continuity_advisory: [expect.stringContaining('第3集')] })
  const text = JSON.stringify(status)
  expect(text).not.toContain('实际审校意见。')
  expect(text).not.toContain('semantic_report')
})

it.each(['revision', 'digest', 'unknown_knowledge', 'source', 'duplicate_episode'] as const)
('preserves real %s checks while permitting arbitrary episode workflow', async (failure) => {
  const first = await draft(4)
  const before = await readFile(project, 'utf8'), file = await current()
  if (failure === 'revision' || failure === 'digest') {
    await expect(run({ method: 'commit', project, expected_revision: file.revision - (failure === 'revision' ? 1 : 0),
      candidate_id: first.candidate.id, candidate_sha256: failure === 'digest' ? '0'.repeat(64) : first.candidate.sha256 }))
      .rejects.toThrow(failure === 'revision' ? 'stale_revision' : 'candidate_digest')
  } else if (failure === 'unknown_knowledge') {
    await expect(draft(9, 1, [brandString<FactId>('f:missing')])).rejects.toThrow('knowledge_fact_missing')
  } else if (failure === 'source') {
    await writeFile(source, 'changed original')
    await expect(adopt(first.candidate)).rejects.toThrow('source_changed')
  } else {
    const second = await draft(4, 1); await adopt(first.candidate)
    const invalid = await current()
    invalid.candidates[1]!.committed_at = invalid.candidates[0]!.committed_at!
    invalid.accepted.push(second.candidate.id)
    expect(() => acceptedCandidates(invalid)).toThrow('invalid_history')
    await writeFile(project, JSON.stringify(invalid))
    commands = new ProjectCommands(ctx.fs, limits, ctx.attachments, 'advisory')
    await expect(run({ method: 'status', project })).rejects.toThrow('invalid_history')
    return
  }
  expect(await readFile(project, 'utf8')).toBe(before)
})

it('retains old sequential accepted records when opening them for later sparse drafting', async () => {
  const first = await draft(1); await adopt(first.candidate)
  const before = await current(), original = structuredClone(before.candidates[0]!)
  delete before.review_policy
  before.candidates[0]!.review = { actor: brandString<ActorId>('actual-other-reviewer'), time: before.created_at,
    decision: 'approve', reason: '历史实际独立审校。' }
  await writeFile(project, JSON.stringify(before))
  const historical = structuredClone((await current()).candidates[0]!)
  const ninth = await draft(9); await adopt(ninth.candidate)
  const after = await current()
  expect(after.candidates[0]).toEqual(historical)
  expect(after.candidates[0]?.sha256).toBe(original.sha256)
  expect(acceptedCandidates(after).map(candidate => candidate.episode)).toEqual([1, 9])
  expect(await run({ method: 'status', project })).toMatchObject({ next_episode: 2 })
})

it('keeps strict deployments sequential and accepted-only for delivery', async () => {
  const file = await current(); delete file.review_policy; await writeFile(project, JSON.stringify(file))
  commands = new ProjectCommands(ctx.fs, limits, ctx.attachments)
  await expect(draft(3)).rejects.toThrow('episode_order')
  const fact = file.facts[0]!
  await run({ method: 'review_fact', project, expected_revision: file.revision, fact_id: fact.id, decision: 'approve',
    reason: '另一真实会话核对来源。' }, { actor: brandString<ActorId>('strict-reviewer') })
  const first = await draft(1)
  await expect(draft(2)).rejects.toThrow('episode_order')
  await expect(run({ method: 'export', project, candidate_id: first.candidate.id, directory: join(root, 'strict-delivery') }))
    .rejects.toThrow('export_unaccepted')
})

it('forks sparse history by actual episode and permits noncontiguous actual refinement baselines', async () => {
  const third = await draft(3), eighth = await draft(8)
  await adopt(eighth.candidate); await adopt(third.candidate)
  const originalBytes = await readFile(project, 'utf8'), destination = join(root, 'fork.json')
  await run({ method: 'fork_project', project, expected_revision: (await current()).revision, destination, before_episode: 7 })
  const fork = PROJECT_FILE.parse(JSON.parse(await readFile(destination, 'utf8')))
  expect(fork.accepted).toEqual([third.candidate.id])
  expect(fork.candidates[0]?.episode).toBe(3)
  const grant: HumanAuthorization = { source: 'user', session_id: actor, message_id: 'actual-refinement-request', seq: SessionSeq(1),
    message_sha256: '1'.repeat(64), quote: '只精修第三集和第八集。', consent_assessment: '用户明确选定两集的实际版本。' }
  const refinement = join(root, 'refinement.json')
  await run({ method: 'fork_refinement', project, expected_revision: (await current()).revision, destination: refinement,
    baseline_candidate_ids: [eighth.candidate.id, third.candidate.id], scope_instructions: '精修两集的表演表达。',
    allowed_categories: ['performance_detail'], authorization_quote: grant.quote, consent_assessment: grant.consent_assessment },
  { authorization: grant })
  expect(PROJECT_FILE.parse(JSON.parse(await readFile(refinement, 'utf8'))).refinement?.scope.episodes).toEqual([3, 8])
  expect(await readFile(project, 'utf8')).toBe(originalBytes)
})

it('prepares a later story episode without earlier adoption while keeping actual work scope', async () => {
  const video = join(root, 'episode3.mp4'); await writeFile(video, 'actual local file for scope checking')
  const signal = new AbortController().signal
  const version = (await ctx.fs.stat(await ctx.fs.resolve(video, { signal }), signal))!.version
  const grant: HumanAuthorization = { source: 'user', session_id: actor, message_id: 'actual-story-request', seq: SessionSeq(1),
    message_sha256: '1'.repeat(64), quote: '从这个视频创作第三集。', consent_assessment: '当前作品只授权第三集。' }
  project = join(root, 'story.json')
  await run({ method: 'init_story_faithful', project, work_title: '门前', videos: [{ path: video, source_version: version, episode: 3 }],
    episodes: [3], scope_instructions: '创作第三集。', allowed_categories: ['minimal_os'], authorization_quote: grant.quote,
    consent_assessment: grant.consent_assessment }, { authorization: grant, latestUserSeq: SessionSeq(1) })
  await run({ method: 'import_source', project, expected_revision: 0, path: source, source_kind: 'text', story_video_path: video })
  const file = await current(), unit = file.sources[0]!.units[0]!
  await run({ method: 'propose_fact', project, expected_revision: file.revision, fact: { kind: 'thought', actor: '甲', origin: 'source',
    layer: 'present', summary: unit.text, anchors: [{ unit_id: unit.id, quote: unit.text }] } })
  const fact = (await current()).facts[0]!
  await run({ method: 'propose_story_inventory', project, expected_revision: (await current()).revision, episode: 3,
    coverage: { windows: [{ source_id: file.sources[0]!.id, start: 1, count: 1 }], required_beats: [{ fact_id: fact.id, kind: 'os' }] },
    items: [{ id: 'thought', dimension: 'emotion_conflict', summary: '甲保留心理。', critical: false, evidence: 'unverified',
      fact_ids: [fact.id], source_units: [unit.id], depends_on: [], knowledge: [] }],
    not_applicable: (['event', 'action_result', 'relationship_stance', 'causality_reveal'] as const)
      .map(dimension => ({ dimension, reason: '来源没有此类变化。' })) })
  const third = await draft(3); await adopt(third.candidate)
  expect(await run({ method: 'status', project })).toMatchObject({ next_episode: 1, accepted: [{ episode: 3 }] })
  await expect(draft(4)).rejects.toThrow('story_candidate_scope')
})
