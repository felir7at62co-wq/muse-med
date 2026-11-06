/** Source headings and change explanations remain versioned across reading, persistence and recovery. */
import { afterEach, expect, it } from 'vitest'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { SessionId } from '@deepseek-ai/dsh-session'
import { Config } from '../src/manuscript-revisions.ts'
import { ManuscriptWork } from '../src/manuscript-work.ts'
import { manuscriptTextHash } from '../src/manuscript-scenes.ts'
import { readAuditCollections } from './manuscript-test-schemas.ts'

const roots: string[] = [], signal = new AbortController().signal
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const coverage = z.object({ complete: z.boolean(), returned_characters: z.number() })
const pageSchema = z.object({
  source_sha256: z.string(), lines: z.array(z.object({ number: z.number(), text: z.string(), source_refs: z.array(z.string()) })),
  continuation: z.object({ offset: z.number(), column: z.number() }).nullable(), reading_coverage: coverage,
  source_contexts: z.object({
    sections: z.array(z.object({
      episode: z.string(), scene_id: z.string().nullable(), heading: z.string().nullable(),
      heading_setting: z.string().nullable(), start_line: z.number(), end_line: z.number(),
    })),
  }).nullable(),
})
const reviewSchema = z.object({
  record: z.object({ comparison_id: z.string(), explanation_evidence: z.array(z.object({ quote: z.string() })) }),
  effective_interpretation: z.string(), contradiction_proven: z.literal(false), missing_basis: z.array(z.string()),
})
const auditSchema = z.object({ reading_coverage: z.array(coverage),
  relationships: z.array(z.object({ relationship_id: z.string() })),
  relationships_needing_recheck: z.array(z.object({ relationship_id: z.string(), scope_issues: z.array(z.object({ code: z.string() })) })),
  comparisons: z.array(reviewSchema), comparisons_needing_recheck: z.array(z.object({
    comparison_id: z.string(), recheck_reasons: z.array(z.string()),
  })) })

async function fixture(text: string, limits: Partial<Config> = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'muse-source-review-'))); roots.push(root)
  await writeFile(join(root, 'source.txt'), text)
  const config = Config(limits), work = new ManuscriptWork(config), session = SessionId('source-context-review')
  const raw = (args: object) => work.request(args, root, session, signal)
  const request = async (args: object): Promise<unknown> => JSON.parse(await raw(args))
  await request({ action: 'bind', task_key: '来源语境', mode: 'edit', source_paths: ['source.txt'], candidate_paths: ['future.md'] })
  const firstRaw = await raw({ action: 'read_source', source_path: 'source.txt' })
  const first = pageSchema.parse(JSON.parse(firstRaw))
  const evidence = (line: number) => ({ source_path: 'source.txt', source_sha256: first.source_sha256,
    start_line: line, end_line: line, quote: text.split('\n')[line - 1] ?? '' })
  return { root, config, work, session, first, firstRaw, evidence, raw, request,
    statePath: join(root, '.muse', 'manuscript-work', manuscriptTextHash(session), 'state.json'),
    audit: async () => auditSchema.parse(await readAuditCollections(request)) }
}

const story = '第1集\n1-1 三楼备勤间 日 内\n甲：我叫甲，月薪两千。\n甲：你把一楼大厅打扫完了吗？\n乙：我叫乙。'
  + '\n第2集\n2-1 总裁办公室 次日 内\n乙：甲调到新岗位，底薪翻三倍。\n甲：现在月薪六千。'

async function roster(f: Awaited<ReturnType<typeof fixture>>) {
  await f.request({ action: 'characters', characters: [
    { character_id: 'a', name: '甲', evidence: [f.evidence(3)] },
    { character_id: 'b', name: '乙', evidence: [f.evidence(5)] },
  ] })
}

it('returns the real current heading when a dialogue asks about another floor', async () => {
  const f = await fixture(story), original = await readFile(join(f.root, 'source.txt'))
  const page = pageSchema.parse(await f.request({ action: 'read_source', source_path: 'source.txt',
    source_sha256: f.first.source_sha256, offset: 4, limit: 1 }))
  expect(page.lines).toEqual([{ number: 4, text: '甲：你把一楼大厅打扫完了吗？', source_refs: ['第1集/1-1'] }])
  expect(page.source_contexts?.sections).toMatchObject([{ episode: '1', scene_id: '1-1',
    heading_setting: '三楼备勤间 日 内', start_line: 2, end_line: 5 }])
  expect(await readFile(join(f.root, 'source.txt'))).toEqual(original)
})

it('labels every returned line with its own episode across a boundary instead of the adjacent title', async () => {
  const f = await fixture(story)
  const page = pageSchema.parse(await f.request({ action: 'read_source', source_path: 'source.txt',
    source_sha256: f.first.source_sha256, offset: 5, limit: 4 }))
  expect(page.lines).toMatchObject([
    { number: 5, source_refs: ['第1集/1-1'] },
    { number: 6, source_refs: ['第2集'] },
    { number: 7, source_refs: ['第2集/2-1'] },
    { number: 8, source_refs: ['第2集/2-1'] },
  ])
  const result: unknown = JSON.parse(await f.raw({ action: 'read_source', source_path: 'source.txt',
    source_sha256: f.first.source_sha256, offset: 5, limit: 1 }))
  const context = z.object({ source_contexts: z.object({ sections: z.array(z.object({
    next_section: z.object({ episode: z.string(), start_line: z.number() }),
  })) }) }).parse(result)
  expect(context.source_contexts.sections[0]?.next_section).toMatchObject({ episode: '2', start_line: 6 })
  expect(page.lines[0]?.source_refs).toEqual(['第1集/1-1'])
})

it('rejects an incorrect relationship episode and invented temporal basis before persistence', async () => {
  const f = await fixture(story); await roster(f)
  const relationship = { relationship_id: 'r', subject_id: 'b', object_id: 'a', relation: '上级', status: 'uncertain',
    scope: { episode: '1', context: '乙安排甲的新岗位。' }, evidence: [f.evidence(8)] }
  await expect(f.request({ action: 'relationship', relationship })).rejects.toThrow('MANUSCRIPT_RELATION_SCOPE')
  await expect(f.request({ action: 'relationship', relationship: { ...relationship,
    scope: { episode: '2', story_time: '任务结束之后', context: '乙安排甲的新岗位。' } } })).rejects.toThrow('story_time')
  await f.request({ action: 'relationship', relationship: { ...relationship,
    scope: { episode: '2', scene_id: '2-1', story_time: '次日', context: '乙安排甲的新岗位。' } } })
  expect((await f.audit()).relationships).toHaveLength(1)
})

it('quarantines a legacy wrong episode instead of restoring it as current knowledge', async () => {
  const f = await fixture(story); await roster(f)
  await f.request({ action: 'relationship', relationship: { relationship_id: 'r', subject_id: 'b', object_id: 'a',
    relation: '上级', status: 'uncertain', scope: { context: '乙安排甲的新岗位。' }, evidence: [f.evidence(8)] } })
  const state: unknown = JSON.parse(await readFile(f.statePath, 'utf8'))
  const parsed = z.looseObject({ relationships: z.array(z.looseObject({
    scope: z.object({ context: z.string() }),
  })) }).parse(state)
  const old = parsed.relationships[0]
  if (!old) throw Error('Expected persisted relationship')
  old.scope = { ...old.scope, ...{ episode: '99' } }
  await writeFile(f.statePath, JSON.stringify(parsed) + '\n')
  const audit = await f.audit()
  expect(audit.relationships).toEqual([])
  expect(audit.relationships_needing_recheck).toMatchObject([{ relationship_id: 'r', scope_issues: [{ code: 'mismatch' }] }])
  expect(await f.work.checkpoint(f.root, f.session, signal)).not.toContain('"episode":"99"')
})

it('persists change explanations and restores them independently of a new manager instance', async () => {
  const f = await fixture(story); await roster(f)
  const comparison = { comparison_id: 'salary', subject_id: 'a', quantity: '月薪',
    before: { value_text: '两千', unit: '每月', condition: '旧岗位', story_time: '日', evidence: [f.evidence(3)] },
    after: { value_text: '六千', unit: '每月', condition: '新岗位', story_time: '次日', evidence: [f.evidence(9)] },
    explanation_evidence: [f.evidence(8)], explanation_kind: 'explicit_change',
    interpretation: 'explained_change', rationale: '原文明示岗位与底薪变化。' }
  await f.request({ action: 'comparison', comparison })
  expect((await f.audit()).comparisons).toMatchObject([{ effective_interpretation: 'explained_change', contradiction_proven: false }])
  const restarted = new ManuscriptWork(f.config)
  const checkpoint = await restarted.checkpoint(f.root, f.session, signal)
  expect(checkpoint).toContain('"kind":"comparisons"')
  expect(checkpoint).toContain('底薪翻三倍')
  expect(checkpoint).toContain('"episode":"2"')
  expect(checkpoint).toContain('"contradiction_proven":false')
  await writeFile(join(f.root, 'source.txt'), story + '\n乙：后来又调任。')
  const changed = await f.audit()
  expect(changed.comparisons).toEqual([])
  expect(changed.comparisons_needing_recheck).toMatchObject([{ comparison_id: 'salary' }])
  expect(await restarted.checkpoint(f.root, f.session, signal)).not.toContain('底薪翻三倍')
})

it('does not turn an unexplained number difference into a proven contradiction', async () => {
  const f = await fixture(story); await roster(f)
  await f.request({ action: 'comparison', comparison: { comparison_id: 'incomplete', subject_id: 'a', quantity: '月薪',
    before: { value_text: '两千', evidence: [f.evidence(3)] }, after: { value_text: '六千', evidence: [f.evidence(9)] },
    interpretation: 'potential_conflict', rationale: '还没核对口径和中间过程。' } })
  expect((await f.audit()).comparisons).toMatchObject([{ effective_interpretation: 'unresolved', contradiction_proven: false,
    missing_basis: ['before.unit', 'before.condition', 'before.story_time', 'after.unit', 'after.condition', 'after.story_time'] }])
  await expect(f.request({ action: 'comparison', comparison: { comparison_id: 'bad', subject_id: 'a', quantity: '月薪',
    before: { value_text: '两千', evidence: [f.evidence(3)] }, after: { value_text: '六千', evidence: [f.evidence(9)] },
    interpretation: 'explained_change', rationale: '没有解释引文。' } })).rejects.toThrow('MANUSCRIPT_COMPARISON_EXPLANATION')
})

it('fits complete page JSON including contexts and resumes the exact remaining Unicode text', async () => {
  const text = '甲'.repeat(5000) + '😀结尾', f = await fixture(text,
    { sourceReadMaxBytes: 24000, sourceReadMaxLineCharacters: 12000, sourceReadMaxResultCharacters: 5000 })
  const fragments = f.first.lines.map(line => line.text)
  expect(f.firstRaw.length).toBeLessThanOrEqual(5000)
  let cursor = f.first.continuation
  for (let count = 0; cursor && count < 32; count++) {
    const raw = await f.raw({ action: 'read_source', source_path: 'source.txt', source_sha256: f.first.source_sha256, ...cursor })
    expect(raw.length).toBeLessThanOrEqual(5000)
    const page = pageSchema.parse(JSON.parse(raw)); fragments.push(...page.lines.map(line => line.text)); cursor = page.continuation
  }
  expect(cursor).toBeNull()
  expect(fragments.join('')).toBe(text)
  expect((await f.audit()).reading_coverage).toMatchObject([{ complete: true }])
})

it('moves a removed subject comparison to recheck in the same roster replacement response', async () => {
  const f = await fixture(story); await roster(f)
  await f.request({ action: 'comparison', comparison: { comparison_id: 'salary', subject_id: 'a', quantity: '月薪',
    before: { value_text: '两千', evidence: [f.evidence(3)] }, after: { value_text: '六千', evidence: [f.evidence(9)] },
    interpretation: 'unresolved', rationale: '尚需核对变化。' } })
  const replaced = auditSchema.parse(await f.request({ action: 'characters', characters: [
    { character_id: 'b', name: '乙', evidence: [f.evidence(5)] },
  ] }))
  expect(replaced.comparisons).toEqual([])
  expect(replaced.comparisons_needing_recheck).toMatchObject([{ comparison_id: 'salary' }])
  expect(await f.work.checkpoint(f.root, f.session, signal)).not.toContain('"comparison_id":"salary"')
})

it('accepts the exact full-result budget without truncating JSON or source text', async () => {
  const f = await fixture('甲'.repeat(100))
  const exact = f.firstRaw.length
  const work = new ManuscriptWork(Config({ sourceReadMaxResultCharacters: exact }))
  const result = await work.request({ action: 'read_source', source_path: 'source.txt' }, f.root, f.session, signal)
  expect(result.length).toBe(exact)
  expect(pageSchema.parse(JSON.parse(result)).lines).toEqual(f.first.lines)
})

it('fails an oversized minimum context without publishing a false reading receipt', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'muse-context-budget-'))); roots.push(root)
  await writeFile(join(root, 'source.txt'), '第1集\n1-1 ' + '长标题'.repeat(1000) + '\n甲：你好。')
  const work = new ManuscriptWork(Config({ sourceReadMaxResultCharacters: 1024 })), session = SessionId('budget')
  await work.request({ action: 'bind', task_key: '预算', mode: 'edit', source_paths: ['source.txt'], candidate_paths: ['future.md'] },
    root, session, signal)
  await expect(work.request({ action: 'read_source', source_path: 'source.txt' }, root, session, signal))
    .rejects.toThrow('MANUSCRIPT_READ_RESULT')
  const result: unknown = JSON.parse(await work.request({ action: 'audit' }, root, session, signal))
  expect(auditSchema.parse(result).reading_coverage).toMatchObject([{ complete: false, returned_characters: 0 }])
})

it('quarantines an old comparison whose story-time label has no literal source basis', async () => {
  const f = await fixture(story); await roster(f)
  await f.request({ action: 'comparison', comparison: { comparison_id: 'old-time', subject_id: 'a', quantity: '月薪',
    before: { value_text: '两千', story_time: '日', evidence: [f.evidence(3)] },
    after: { value_text: '六千', story_time: '次日', evidence: [f.evidence(9)] },
    interpretation: 'unresolved', rationale: '需要核对中间过程。' } })
  const state: unknown = JSON.parse(await readFile(f.statePath, 'utf8'))
  const parsed = z.looseObject({ comparisons: z.array(z.looseObject({
    before: z.looseObject({ story_time: z.string().optional() }),
  })) }).parse(state)
  const row = parsed.comparisons[0]
  if (!row) throw Error('Expected a persisted comparison')
  row.before.story_time = '从未明示的清晨'
  await writeFile(f.statePath, JSON.stringify(parsed) + '\n')
  const audit = await f.audit()
  expect(audit.comparisons).toEqual([])
  expect(audit.comparisons_needing_recheck).toMatchObject([{ comparison_id: 'old-time' }])
  expect(await f.work.checkpoint(f.root, f.session, signal)).not.toContain('从未明示的清晨')
})

it.each([undefined, 'general_rule'] as const)('keeps an old strong explanation with kind %s out of active recovery until corrected', async (kind) => {
  const f = await fixture(story); await roster(f)
  const comparison = { comparison_id: 'legacy-explanation', subject_id: 'a', quantity: '月薪',
    before: { value_text: '两千', evidence: [f.evidence(3)] },
    after: { value_text: '六千', evidence: [f.evidence(9)] },
    explanation_evidence: [f.evidence(8)], explanation_kind: 'explicit_change',
    interpretation: 'explained_change', rationale: '原文中的岗位及薪资对照。' }
  await f.request({ action: 'comparison', comparison })
  const state: unknown = JSON.parse(await readFile(f.statePath, 'utf8'))
  const parsed = z.looseObject({ comparisons: z.array(z.looseObject({
    explanation_kind: z.enum(['explicit_change', 'general_rule', 'suggested']).optional(),
  })) }).parse(state)
  const row = parsed.comparisons[0]
  if (!row) throw Error('Expected a persisted comparison')
  row.explanation_kind = kind
  await writeFile(f.statePath, JSON.stringify(parsed) + '\n')
  const restarted = new ManuscriptWork(f.config)
  const audit = auditSchema.parse(JSON.parse(await restarted.request({ action: 'audit' }, f.root, f.session, signal)))
  expect(audit.comparisons).toEqual([])
  expect(audit.comparisons_needing_recheck).toMatchObject([{ comparison_id: 'legacy-explanation' }])
  expect(audit.comparisons_needing_recheck[0]?.recheck_reasons.join('\n')).toContain('explanation_kind')
  expect(await restarted.checkpoint(f.root, f.session, signal)).not.toContain('legacy-explanation')
  await f.request({ action: 'comparison', comparison: { ...comparison,
    explanation_kind: 'general_rule', interpretation: 'possible_change' } })
  const corrected = await f.audit()
  expect(corrected.comparisons_needing_recheck).toEqual([])
  expect(corrected.comparisons).toMatchObject([{ effective_interpretation: 'possible_change' }])
  expect(await restarted.checkpoint(f.root, f.session, signal)).toContain('legacy-explanation')
})
