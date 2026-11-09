/** Boundary plans report missing coverage and require exact target evidence on both episode sides. */
import { expect, it } from 'vitest'
import { buildEpisodePlan, validateEpisodeChecks, type EpisodeCheckEvidence } from '../src/manuscript-episode-checks.ts'
import type { ManuscriptMaterialsDocument } from '../src/manuscript-materials.ts'

function document(range?: { start: number; end: number }): ManuscriptMaterialsDocument {
  const text = ['剧名：门外', '', '第1集', '1-1 茶馆 日 内', '甲：已经抛出七次正面。',
    '第2集', '2-1 茶馆 日 内', '▲甲又抛出三次正面。', '乙：十连正面。', '第3集', '3-1 茶馆 日 内', '甲：轮到你了。']
  const selected = range ?? { start: 1, end: text.length }
  return { role: 'candidate', path: '/workspace/final.md', file_sha256: 'a'.repeat(64), text_sha256: 'b'.repeat(64),
    line_count: text.length, lines: text.flatMap((text, index) => index + 1 >= selected.start && index + 1 <= selected.end
      ? [{ number: index + 1, text }] : []),
    selection: range === undefined ? { kind: 'full' } : { kind: 'lines', ...range },
    coverage: { basis: 'returned_text_lines', read_ranges: [selected], full_document: range === undefined,
      unread_ranges: [...selected.start > 1 ? [{ start: 1, end: selected.start - 1 }] : [],
        ...selected.end < text.length ? [{ start: selected.end + 1, end: text.length }] : []] },
    episode_index: { state: 'indexed', issues: [], episodes: [
      { episode: 1, start: 3, end: 5 }, { episode: 2, start: 6, end: 9 }, { episode: 3, start: 10, end: 12 },
    ] }, unchanged_since_read: true }
}

function cite(doc: ManuscriptMaterialsDocument, line: number): EpisodeCheckEvidence {
  const found = doc.lines.find(value => value.number === line)
  if (found === undefined) throw Error('Test citation needs a real returned line')
  return { role: doc.role, path: doc.path, file_sha256: doc.file_sha256, text_sha256: doc.text_sha256, line, quote: found.text }
}

function checks(doc: ManuscriptMaterialsDocument) {
  return [{ from_episode: 1, to_episode: 2, status: 'consistent' as const,
    explanation: '七次之后再抛三次，下一集记录为十次。', evidence: [cite(doc, 5), cite(doc, 8)] },
  { from_episode: 2, to_episode: 3, status: 'consistent' as const,
    explanation: '上一集结束计数，下一集交接投掷顺序。', evidence: [cite(doc, 9), cite(doc, 12)] }]
}
const consistent = { status: 'consistent' as const, findings: [], unknowns: [] }

it('schedules complete adjacent episode sections while keeping preamble outside the plan', () => {
  expect(buildEpisodePlan(document(), 2)).toEqual({ path: '/workspace/final.md', file_sha256: 'a'.repeat(64),
    checks: [{ from_episode: 1, to_episode: 2 }, { from_episode: 2, to_episode: 3 }],
    not_checked: [], preamble_lines: 2, issues: [] })
})

it('distinguishes unread and partially read episode boundaries without treating excerpts as complete', () => {
  expect(buildEpisodePlan(document({ start: 3, end: 9 }), 2)).toMatchObject({ checks: [{ from_episode: 1, to_episode: 2 }],
    not_checked: [{ from_episode: 2, to_episode: 3, reason: 'unread_episode' }] })
  expect(buildEpisodePlan(document({ start: 3, end: 8 }), 2)).toMatchObject({ checks: [], not_checked: [
    { from_episode: 1, to_episode: 2, reason: 'partial_episode' }, { from_episode: 2, to_episode: 3, reason: 'unread_episode' },
  ] })
})

it('reports a numbering gap instead of inventing an absent episode or calling nonconsecutive sections adjacent', () => {
  const doc = document()
  doc.episode_index.episodes[2] = { episode: 4, start: 10, end: 12 }
  expect(buildEpisodePlan(doc, 2)).toMatchObject({ checks: [{ from_episode: 1, to_episode: 2 }],
    not_checked: [{ from_episode: 2, to_episode: 4, reason: 'numbering_gap' }] })
})

it.each(['unavailable', 'ambiguous'] as const)('refuses planning for %s episode headings', (state) => {
  const doc = document()
  doc.episode_index = { state, episodes: [], issues: ['标题不能确定唯一集序。'] }
  const plan = buildEpisodePlan(doc, 2)
  expect(plan.checks).toEqual([])
  expect(plan.issues).toContain('标题不能确定唯一集序。')
})

it('rejects a reference target and refuses a scheduled-check overflow without truncating', () => {
  expect(buildEpisodePlan({ ...document(), role: 'reference' }, 2).issues).toHaveLength(1)
  expect(() => buildEpisodePlan(document(), 1)).toThrow('CROSS_EPISODE_PLAN_LIMIT')
})

it('allows a small checked batch in a large indexed manuscript and reports every unread boundary', () => {
  const doc = document()
  doc.episode_index = { state: 'indexed', issues: [], episodes: Array.from({ length: 115 }, (_, index) =>
    ({ episode: index + 1, start: index + 1, end: index + 1 })) }
  doc.line_count = 115
  doc.lines = [1, 2, 3].map(number => ({ number, text: `第${number}集` }))
  doc.selection = { kind: 'episodes', requested: [2], included: [1, 2, 3], adjacent: [1, 3] }
  doc.coverage = { basis: 'returned_text_lines', read_ranges: [{ start: 1, end: 3 }],
    unread_ranges: [{ start: 4, end: 115 }], full_document: false }
  const plan = buildEpisodePlan(doc, 2)
  expect(plan.checks).toEqual([{ from_episode: 1, to_episode: 2 }, { from_episode: 2, to_episode: 3 }])
  expect(plan.not_checked).toHaveLength(112)
  expect(plan.not_checked.at(-1)).toEqual({ from_episode: 114, to_episode: 115, reason: 'unread_episode' })
})

it('accepts complete checks supported by both actual target episodes', () => {
  const doc = document()
  expect(validateEpisodeChecks(checks(doc), buildEpisodePlan(doc, 2), doc, consistent)).toBeUndefined()
})

it('rejects missing, duplicate, reversed and unscheduled pair coverage', () => {
  const doc = document(), plan = buildEpisodePlan(doc, 2), values = checks(doc)
  expect(validateEpisodeChecks(undefined, plan, doc, consistent)).toContain('missing or invalid')
  expect(validateEpisodeChecks(values.slice(0, 1), plan, doc, consistent)).toContain('complete Host schedule')
  expect(validateEpisodeChecks([values[0], values[0]], plan, doc, consistent)).toContain('duplicated or was not scheduled')
  expect(validateEpisodeChecks([{ ...values[0], from_episode: 2, to_episode: 1 }, values[1]], plan, doc, consistent))
    .toContain('duplicated or was not scheduled')
})

it.each(['role', 'path', 'file_sha256', 'text_sha256', 'line', 'quote'] as const)('rejects fabricated %s in pair evidence', (field) => {
  const doc = document(), values = checks(doc), evidence = cite(doc, 5)
  const value = field === 'line' ? 12 : field === 'role' ? 'current' : field.endsWith('sha256') ? 'c'.repeat(64) : 'fabricated'
  const fabricated = { ...evidence, [field]: value }
  const first = { ...values[0], evidence: [fabricated, cite(doc, 8)] }
  expect(validateEpisodeChecks([first, values[1]], buildEpisodePlan(doc, 2), doc, consistent)).toBeDefined()
})

it('rejects two citations from only one side or a citation from a third episode', () => {
  const doc = document(), values = checks(doc), plan = buildEpisodePlan(doc, 2)
  expect(validateEpisodeChecks([{ ...values[0], evidence: [cite(doc, 4), cite(doc, 5)] }, values[1]], plan, doc, consistent))
    .toContain('each episode')
  expect(validateEpisodeChecks([{ ...values[0], evidence: [cite(doc, 5), cite(doc, 12)] }, values[1]], plan, doc, consistent))
    .toContain('not from the assessed boundary')
})

it('keeps an uncertain boundary unknown without inventing evidence or discarding root uncertainty', () => {
  const doc = document(), plan = buildEpisodePlan(doc, 2), values = checks(doc)
  const uncertain = [{ ...values[0], status: 'unknown', explanation: '现有正文没有说明道具归属。', evidence: [] }, values[1]]
  expect(validateEpisodeChecks(uncertain, plan, doc, { status: 'unknown', findings: [], unknowns: ['道具归属仍未确定。'] })).toBeUndefined()
  expect(validateEpisodeChecks(uncertain, plan, doc, { status: 'unknown', findings: [], unknowns: [] })).toContain('root uncertainty')
  expect(validateEpisodeChecks(uncertain, plan, doc, { ...consistent, unknowns: ['未确定。'] })).toContain('cannot be consistent')
})

it('requires each boundary issue to correspond to a grounded root finding touching both target episodes', () => {
  const doc = document(), plan = buildEpisodePlan(doc, 2), values = checks(doc)
  const issues = [{ ...values[0], status: 'issues' }, values[1]]
  const finding = { evidence: [cite(doc, 5), cite(doc, 8)] }
  expect(validateEpisodeChecks(issues, plan, doc, { status: 'issues', findings: [finding], unknowns: [] })).toBeUndefined()
  expect(validateEpisodeChecks(issues, plan, doc, { status: 'issues', findings: [], unknowns: [] })).toContain('grounded root finding')
  expect(validateEpisodeChecks(issues, plan, doc, { status: 'issues', findings: [{ evidence: [cite(doc, 4), cite(doc, 5)] }], unknowns: [] }))
    .toContain('grounded root finding')
  expect(validateEpisodeChecks(values, plan, doc, { status: 'issues', findings: [finding], unknowns: [] }))
    .toContain('cannot be reported as consistent or unknown')
})

it('rejects a stale plan and refuses a passing judgment with no complete checked boundaries', () => {
  const doc = document()
  expect(validateEpisodeChecks(checks(doc), { ...buildEpisodePlan(doc, 2), file_sha256: 'c'.repeat(64) }, doc, consistent))
    .toContain('does not match')
  const partial = document({ start: 3, end: 8 })
  expect(validateEpisodeChecks([], buildEpisodePlan(partial, 2), partial, consistent)).toContain('No complete unambiguous')
})
