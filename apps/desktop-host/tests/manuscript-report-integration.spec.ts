/** Real task files exercise bounded review groups and stale cursors across changes. */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { z } from 'zod'
import { SessionId } from '@deepseek-ai/dsh-session'
import { Config } from '../src/manuscript-revisions.ts'
import { ManuscriptWork } from '../src/manuscript-work.ts'
import { manuscriptTextHash } from '../src/manuscript-scenes.ts'
import { MANUSCRIPT_FACT_GUIDANCE } from '../src/manuscript-source-context.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const manifestSchema = z.object({ report_paged: z.literal(true), report_sha256: z.string(),
  report_sections: z.array(z.object({ section: z.string(), total_items: z.number(), request: z.record(z.string(), z.unknown()) })) })
const pageSchema = z.object({ items: z.array(z.unknown()), continuation: z.record(z.string(), z.unknown()).nullable() })

async function fixture(evidenceLines = 1) {
  const cwd = await mkdtemp(join(tmpdir(), 'manuscript-review-groups-')); roots.push(cwd)
  const quote = `甲：乙是我的朋友，余额三十，后来二十。${'原文证据'.repeat(125)}`
  const quotes = Array.from({ length: evidenceLines }, (_, index) => index === 0 ? quote : `${quote}${index}`)
  await writeFile(join(cwd, 'source.txt'), `第1集\n1-1 客厅 日 内\n${quotes.join('\n')}\n`)
  await writeFile(join(cwd, 'draft.md'), '第1集\n1-1 客厅 日 内\n甲：原采用稿。')
  const work = new ManuscriptWork(Config({ manuscriptReportMaxResultCharacters: 6000 }))
  const session = SessionId('grouped-review'), signal = new AbortController().signal
  const request = (args: object) => work.request(args, cwd, session, signal)
  const bound = z.object({ sources: z.array(z.object({ path: z.string(), sha256: z.string() })) }).parse(JSON.parse(await request({
    action: 'bind', task_key: '完整分组审查', mode: 'edit', source_paths: ['source.txt'], candidate_paths: ['draft.md'],
  })))
  const source = bound.sources[0]!
  const evidence = { source_path: source.path, source_sha256: source.sha256, start_line: 3, end_line: 3, quote }
  await request({ action: 'characters', characters: ['甲', '乙'].map(name => ({ character_id: name, name, evidence: [evidence] })) })
  const relationship = (index: number) => ({ relationship_id: `关系${index}`, subject_id: '甲', object_id: '乙', relation: '朋友',
    status: 'asserted', scope: { episode: '1', scene_id: '1-1', context: '原文明确称呼的朋友关系' }, evidence: [evidence] })
  let last = ''
  for (let index = 1; index <= 6; index++) last = await request({ action: 'relationship', relationship: relationship(index) })
  const statePath = join(cwd, '.muse', 'manuscript-work', manuscriptTextHash(session), 'state.json')
  return { cwd, work, request, quote, quotes, evidence, relationship, last, statePath }
}

it('saves large mutations with an explicit pending-review receipt and returns complete current groups', async () => {
  const f = await fixture()
  expect(JSON.parse(f.last)).toMatchObject({ saved: true, report_pending: true, next_request: { action: 'audit' } })
  const receipt = z.object({ record_review: z.object({ relationship_id: z.string(), evidence: z.array(z.object({ quote: z.string() })) }),
    record_review_notice: z.string() }).parse(JSON.parse(f.last))
  expect(receipt.record_review.relationship_id).toBe('关系6')
  expect(receipt.record_review.evidence[0]?.quote).toBe(f.quote)
  expect(f.last.length).toBeLessThanOrEqual(6000)
  const stateBefore = await readFile(f.statePath, 'utf8')
  const first = await f.request({ action: 'audit' })
  const manifest = manifestSchema.parse(JSON.parse(first))
  const summary = z.object({ summary: z.object({ notice: z.string() }) }).parse(JSON.parse(first))
  expect(summary.summary.notice).toContain(MANUSCRIPT_FACT_GUIDANCE)
  expect(first.length).toBeLessThanOrEqual(6000)
  const counts = new Map(manifest.report_sections.map(section => [section.section, section.total_items]))
  expect(counts.get('characters')).toBe(2)
  expect(counts.get('relationships')).toBe(6)
  for (const section of manifest.report_sections) {
    let cursor: Record<string, unknown> | null = section.request
    const entries: unknown[] = []
    while (cursor !== null) {
      const text = await f.request(cursor)
      expect(text.length).toBeLessThanOrEqual(6000)
      const page = pageSchema.parse(JSON.parse(text))
      entries.push(...page.items)
      cursor = page.continuation
    }
    expect(entries).toHaveLength(section.total_items)
    if (section.section === 'relationships') {
      const notes = z.array(z.object({ evidence: z.array(z.object({ quote: z.string() })),
        source_contexts: z.array(z.object({ line_labels: z.array(z.object({ speaker_label: z.string().nullable() })) })) })).parse(entries)
      expect(notes.every(note => note.evidence[0]?.quote === f.quote)).toBe(true)
      expect(notes.every(note => note.source_contexts[0]?.line_labels[0]?.speaker_label === '甲')).toBe(true)
    }
  }
  expect(await readFile(f.statePath, 'utf8')).toBe(stateBefore)
})

it('explicitly defers an oversized new record to complete audit groups without clipping its quotation', async () => {
  const f = await fixture(12)
  const result = await f.request({ action: 'relationship', relationship: { ...f.relationship(7),
    evidence: f.quotes.map((quote, index) => ({ ...f.evidence, start_line: index + 3, end_line: index + 3, quote })) } })
  expect(result.length).toBeLessThanOrEqual(6000)
  expect(JSON.parse(result)).toMatchObject({ saved: true, report_pending: true, record_review_omitted: true })
  const state = z.object({ relationships: z.array(z.object({ relationship_id: z.string(),
    evidence: z.array(z.object({ quote: z.string() })) })) }).parse(JSON.parse(await readFile(f.statePath, 'utf8')))
  expect(state.relationships.find(row => row.relationship_id === '关系7')?.evidence.map(row => row.quote)).toEqual(f.quotes)
  const manifest = manifestSchema.parse(JSON.parse(await f.request({ action: 'audit' })))
  const section = manifest.report_sections.find(row => row.section === 'relationships')!
  const page: unknown = JSON.parse(await f.request({ ...section.request, report_offset: 7, report_limit: 1 }))
  expect(page).toMatchObject({ items: [{ report_item_paged: true, report_offset: 7 }] })
})

it('returns a complete new comparison for immediate review when the accumulated report is too large', async () => {
  const f = await fixture()
  const result = await f.request({ action: 'comparison', comparison: { comparison_id: '余额', subject_id: '甲', quantity: '余额',
    before: { value_text: '三十', evidence: [f.evidence] }, after: { value_text: '二十', evidence: [f.evidence] },
    interpretation: 'unresolved', rationale: '需要核对计量条件及实际变化过程。' } })
  const receipt = z.object({ record_review: z.object({ record: z.object({ comparison_id: z.string() }),
    contradiction_proven: z.literal(false), labels_verified: z.literal(false) }) }).parse(JSON.parse(result))
  expect(result.length).toBeLessThanOrEqual(6000)
  expect(receipt.record_review.record.comparison_id).toBe('余额')
})

it('invalidates a report cursor on saved-note, reading-progress and actual-source changes', async () => {
  const f = await fixture()
  const first = manifestSchema.parse(JSON.parse(await f.request({ action: 'audit' })))
  const cursor = first.report_sections.find(section => section.section === 'relationships')!.request
  await f.request({ action: 'relationship', relationship: f.relationship(7) })
  await expect(f.request(cursor)).rejects.toThrow('MANUSCRIPT_REPORT_STALE')
  const next = manifestSchema.parse(JSON.parse(await f.request({ action: 'audit' })))
  const nextCursor = next.report_sections[0]!.request
  await f.request({ action: 'read_source', source_path: 'source.txt', limit: 1 })
  await expect(f.request(nextCursor)).rejects.toThrow('MANUSCRIPT_REPORT_STALE')
  const latest = manifestSchema.parse(JSON.parse(await f.request({ action: 'audit' })))
  await writeFile(join(f.cwd, 'source.txt'), '第1集\n1-1 客厅 日 内\n甲：来源变了。\n')
  await expect(f.request(latest.report_sections[0]!.request)).rejects.toThrow('MANUSCRIPT_REPORT_STALE')
})

it('keeps pending adopted changes stable while the same report is read across several requests', async () => {
  const f = await fixture()
  await writeFile(join(f.cwd, 'draft.md'), '第1集\n1-1 客厅 日 内\n甲：用户返稿。')
  const first = manifestSchema.parse(JSON.parse(await f.request({ action: 'audit' })))
  const changeRequest = first.report_sections.find(section => section.section === 'changes')!.request
  const changes = await f.request(changeRequest)
  expect(changes).toContain('用户返稿')
  const again = manifestSchema.parse(JSON.parse(await f.request({ action: 'audit' })))
  expect(again.report_sha256).toBe(first.report_sha256)
  expect(await f.request(changeRequest)).toBe(changes)
})

it('retains old wrong-speaker notes for recheck and excludes them from active relationship groups', async () => {
  const f = await fixture()
  const state = z.looseObject({ relationships: z.array(z.looseObject({ contextual_name: z.object({
    term: z.string(), speaker_id: z.string(), target_id: z.string(),
  }).optional() })) }).parse(JSON.parse(await readFile(f.statePath, 'utf8')))
  const note = state.relationships[0]
  if (!note) throw Error('Expected a saved relationship')
  note.contextual_name = { term: '朋友', speaker_id: '乙', target_id: '甲' }
  await writeFile(f.statePath, JSON.stringify(state))
  const report = manifestSchema.parse(JSON.parse(await f.request({ action: 'audit' })))
  const recheck = report.report_sections.find(section => section.section === 'relationships_needing_recheck')!
  const result = pageSchema.parse(JSON.parse(await f.request(recheck.request)))
  const old = z.object({ relationship_id: z.string(), contextual_name: z.object({ speaker_id: z.string() }),
    scope_issues: z.array(z.object({ code: z.string() })) }).parse(result.items[0])
  expect(old).toMatchObject({ relationship_id: '关系1', contextual_name: { speaker_id: '乙' } })
  expect(old.scope_issues.map(issue => issue.code)).toContain('speaker_mismatch')
  expect(report.report_sections.find(section => section.section === 'relationships')?.total_items).toBe(5)
  expect(z.object({ relationships: z.array(z.unknown()) }).parse(JSON.parse(await readFile(f.statePath, 'utf8'))).relationships).toHaveLength(6)
})
