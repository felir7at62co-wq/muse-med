/** Whole-record review paging preserves facts without relying on filesystem spill recovery. */
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { z } from 'zod'
import { formatManuscriptPath, formatManuscriptReport, manuscriptReportVersion, serializeManuscriptData } from '../src/manuscript-report.ts'
import { readAuditCollections } from './manuscript-test-schemas.ts'

const manifestSchema = z.object({ report_paged: z.literal(true), report_sha256: z.string(),
  report_sections: z.array(z.object({ section: z.string(), total_items: z.number() })) })
const pageSchema = z.object({ items: z.array(z.object({ id: z.number(), quote: z.string() })), total_items: z.number(),
  is_last_page: z.boolean(), continuation: z.object({ report_offset: z.number() }).nullable() })
const rows = Array.from({ length: 15 }, (_, index) => ({ id: index + 1, quote: `甲OS：${'🌕不要把假设画成当前动作。'.repeat(45)}` }))
const report = { task_key: '回读', advisory: true, records: rows, repeated: { total: 1, findings: [{ text: '保留空对象和空数组', nested: {}, missing: [] }] } }
const version = manuscriptReportVersion(report, process.cwd())

it('keeps a complete small report unchanged and includes the exact budget endpoint', () => {
  const data = { task_key: '小报告', text: 'a'.repeat(1000) }
  const text = JSON.stringify(data)
  expect(text.length).toBeGreaterThanOrEqual(1024)
  expect(formatManuscriptReport(data, version, { maxCharacters: text.length })).toBe(text)
})

it('returns a collection index, complete rows and exact item continuations within the full JSON budget', () => {
  const maximum = 3200
  const first = formatManuscriptReport(report, version, { maxCharacters: maximum })
  const manifest = manifestSchema.parse(JSON.parse(first))
  expect(first.length).toBeLessThanOrEqual(maximum)
  expect(manifest.report_sections.map(row => [row.section, row.total_items])).toEqual([['records', 15], ['repeated.findings', 1]])
  const collected: z.infer<typeof pageSchema>['items'] = []
  let offset = 1
  for (;;) {
    const text = formatManuscriptReport(report, version, { maxCharacters: maximum,
      cursor: { report_sha256: version, report_section: 'records', report_offset: offset } })
    expect(text.length).toBeLessThanOrEqual(maximum)
    const page = pageSchema.parse(JSON.parse(text))
    collected.push(...page.items)
    if (page.continuation === null) { expect(page.is_last_page).toBe(true); break }
    expect(page.continuation.report_offset).toBe(offset + page.items.length)
    offset = page.continuation.report_offset
  }
  expect(collected).toEqual(rows)
})

it('retains empty containers and serializable scalar metadata in its index', () => {
  const value = { task_key: '审查', text: '保留', records: rows, empty: [], details: { blank: {}, missing: [], available: false } }
  const result = z.object({ summary: z.unknown() })
    .parse(JSON.parse(formatManuscriptReport(value, version, { maxCharacters: 3200 })))
  expect(result.summary).toEqual({ task_key: '审查', text: '保留', records: { report_section: 'records', total_items: 15 },
    empty: [], details: { blank: {}, missing: [], available: false } })
})

it('can return a requested group of an otherwise small report and honors an explicit item limit', () => {
  const value = { task_key: '小组', records: rows.slice(0, 2) }
  const result = pageSchema.parse(JSON.parse(formatManuscriptReport(value, version,
    { maxCharacters: 10000, cursor: { report_sha256: version, report_section: 'records', report_limit: 1 } })))
  expect(result.items).toEqual(rows.slice(0, 1))
  expect(result.continuation?.report_offset).toBe(2)
})

it('restores oversized rows through returned nested requests without dropping quotations or source-line metadata', async () => {
  const lineLabels = Array.from({ length: 72 }, (_, index) => ({ line: index + 1, kind: 'dialogue', speaker_label: '甲',
    voice_marker: 'OS', speaker_annotation: '（心里）', speech_column: 8 }))
  const value = { task_key: '嵌套完整审查', comparisons: [1, 2].map(index => ({
    record: { comparison_id: `对照${index}`, before: { evidence: rows.slice(0, 3) }, after: { evidence: rows.slice(3, 5) } },
    before: [{ source_path: './source.txt', line_labels: lineLabels, time_basis: [], context: { heading: '1-1 后厨 日 内' } }],
    after: [{ source_path: './source.txt', line_labels: lineLabels.slice(0, 25), time_basis: [] }],
    empty: [], optional: null, available: false,
  })), empty: [] }
  const original = JSON.stringify(value), digest = manuscriptReportVersion(value, process.cwd()), maximum = 3200
  const cursorSchema = z.object({ action: z.literal('audit'), report_sha256: z.literal(digest).optional(),
    report_section: z.string().optional(), report_offset: z.number().optional(), report_limit: z.number().optional() })
  const seenSections = new Set<string>(), nestedSections = new Set<string>()
  let pages = 0
  const restored = await readAuditCollections(async (args) => {
    const parsedCursor = cursorSchema.parse(args)
    const cursor = {
      ...(parsedCursor.report_sha256 === undefined ? {} : { report_sha256: parsedCursor.report_sha256 }),
      ...(parsedCursor.report_section === undefined ? {} : { report_section: parsedCursor.report_section }),
      ...(parsedCursor.report_offset === undefined ? {} : { report_offset: parsedCursor.report_offset }),
      ...(parsedCursor.report_limit === undefined ? {} : { report_limit: parsedCursor.report_limit }),
    }
    if (cursor.report_section !== undefined) seenSections.add(cursor.report_section)
    const text = formatManuscriptReport(value, digest, { maxCharacters: maximum, cursor })
    expect(text.length).toBeLessThanOrEqual(maximum)
    const parsed: unknown = JSON.parse(text)
    const page = z.object({ report_sha256: z.literal(digest), items: z.array(z.unknown()).optional() }).parse(parsed)
    for (const row of page.items ?? []) {
      const nested = z.object({ report_item_paged: z.literal(true), report_offset: z.number(),
        report_sections: z.array(z.object({ section: z.string() })) }).safeParse(row)
      if (nested.success) for (const section of nested.data.report_sections) nestedSections.add(section.section)
    }
    pages++
    return parsed
  })
  expect(restored).toEqual(value)
  expect(JSON.stringify(value)).toBe(original)
  expect(pages).toBeGreaterThan(10)
  expect(nestedSections.has('comparisons.0.record.before.evidence')).toBe(true)
  expect(nestedSections.has('comparisons.0.before.0.line_labels')).toBe(true)
  expect(nestedSections.has('comparisons.1.before.0.line_labels')).toBe(true)
  expect([...nestedSections].every(section => seenSections.has(section))).toBe(true)
})

it('keeps item-page boundaries exact and reuses a digest without consuming report data', () => {
  const cursor = { report_sha256: version, report_section: 'records', report_offset: rows.length, report_limit: 50 }
  const text = formatManuscriptReport(report, version, { maxCharacters: 10000, cursor })
  expect(text.length).toBeGreaterThanOrEqual(1024)
  expect(formatManuscriptReport(report, version, { maxCharacters: text.length, cursor })).toBe(text)
  expect(pageSchema.parse(JSON.parse(text))).toMatchObject({ items: rows.slice(-1), total_items: rows.length,
    is_last_page: true, continuation: null })
  expect(() => formatManuscriptReport(report, version, { maxCharacters: text.length - 1, cursor }))
    .toThrow('MANUSCRIPT_REPORT_SIZE')
  expect(manuscriptReportVersion(report, process.cwd())).toBe(version)
})

it('rejects stale or unversioned collection cursors instead of mixing two reports', () => {
  const changed = manuscriptReportVersion({ ...report, changed: true }, process.cwd())
  expect(() => formatManuscriptReport(report, changed, { maxCharacters: 3200,
    cursor: { report_sha256: version, report_section: 'records' } })).toThrow('MANUSCRIPT_REPORT_STALE')
  expect(() => formatManuscriptReport(report, version, { maxCharacters: 3200, cursor: { report_section: 'records' } }))
    .toThrow('MANUSCRIPT_REPORT_VERSION')
})

it('rejects missing groups and invalid item positions', () => {
  for (const cursor of [{ report_section: 'absent' }, { report_section: 'records', report_offset: 16 },
    { report_section: 'records', report_offset: 0 }, { report_section: 'records', report_limit: 0 }]) {
    expect(() => formatManuscriptReport(report, version, { maxCharacters: 3200, cursor: { ...cursor, report_sha256: version } }))
      .toThrow('MANUSCRIPT_REPORT_')
  }
  expect(() => formatManuscriptReport(report, version, { maxCharacters: 3200, cursor: { report_offset: 2 } }))
    .toThrow('MANUSCRIPT_REPORT_SECTION')
})

it('rejects inherited properties, scalar paths, empty collections and invalid nested sections', () => {
  const value = { task_key: '拒绝非法路径', records: rows, empty: [], nothing: null }
  for (const section of ['__proto__', 'constructor.prototype', 'toString', 'records.__proto__', 'records.constructor',
    'records.0.__proto__', 'records.00', 'records.-1', 'records.0.quote', 'records.0.id.child', 'records.0',
    'records..quote', 'nothing.child', 'empty', '']) {
    expect(() => formatManuscriptReport(value, version, { maxCharacters: 3200,
      cursor: { report_sha256: version, report_section: section } })).toThrow('MANUSCRIPT_REPORT_SECTION')
  }
})

it('rejects nonintegral limits and offsets and never truncates oversized scalar fields inside rows', () => {
  for (const count of [Number.NaN, Number.POSITIVE_INFINITY, 1.5, -1]) {
    expect(() => formatManuscriptReport(report, version, { maxCharacters: count })).toThrow('MANUSCRIPT_REPORT_LIMIT')
    expect(() => formatManuscriptReport(report, version, { maxCharacters: 3200,
      cursor: { report_sha256: version, report_section: 'records', report_offset: count } })).toThrow('MANUSCRIPT_REPORT_OFFSET')
    expect(() => formatManuscriptReport(report, version, { maxCharacters: 3200,
      cursor: { report_sha256: version, report_section: 'records', report_limit: count } })).toThrow('MANUSCRIPT_REPORT_LIMIT')
  }
  const value = { task_key: '超大单条', records: [{ quote: '🌕原句不截断'.repeat(1000), nested: ['短内容'] }] }
  expect(() => formatManuscriptReport(value, version, { maxCharacters: 3200,
    cursor: { report_sha256: version, report_section: 'records' } })).toThrow('MANUSCRIPT_REPORT_SIZE')
  expect(() => formatManuscriptReport(report, version, { maxCharacters: 3200, cursor: { report_limit: 1 } }))
    .toThrow('MANUSCRIPT_REPORT_SECTION')
})

it('fails without dropping a row or oversized index when no minimum response fits', () => {
  expect(() => formatManuscriptReport(report, version, { maxCharacters: 1024,
    cursor: { report_sha256: version, report_section: 'records' } })).toThrow('MANUSCRIPT_REPORT_SIZE')
  expect(() => formatManuscriptReport({ task_key: '长'.repeat(1600), records: rows }, version, { maxCharacters: 1024 }))
    .toThrow('MANUSCRIPT_REPORT_SIZE')
  expect(() => formatManuscriptReport(report, version, { maxCharacters: 1023 })).toThrow('MANUSCRIPT_REPORT_LIMIT')
})

it('makes only declared workspace path fields portable and keeps note text and outside paths significant', () => {
  const leftRoot = join(process.cwd(), 'left'), rightRoot = join(process.cwd(), 'right')
  const value = (root: string) => ({ sources: [{ path: join(root, 'source.txt'), sha256: 'source' }],
    paths: [join(root, 'draft.md')], evidence: [{ source_path: join(root, 'source.txt'), quote: '甲：原句' }], context: '推断仍是推断' })
  expect(manuscriptReportVersion(value(leftRoot), leftRoot)).toBe(manuscriptReportVersion(value(rightRoot), rightRoot))
  expect(manuscriptReportVersion({ ...value(leftRoot), context: leftRoot }, leftRoot))
    .not.toBe(manuscriptReportVersion({ ...value(rightRoot), context: rightRoot }, rightRoot))
  expect(manuscriptReportVersion({ path: join(process.cwd(), 'outside.txt') }, leftRoot))
    .not.toBe(manuscriptReportVersion({ path: join(process.cwd(), 'other.txt') }, leftRoot))
  expect(manuscriptReportVersion({ path: 'source.txt', paths: [null] }, leftRoot)).toBeDefined()
})

it('shares path spelling with diagnostics while preserving quotes and similarly prefixed external paths', () => {
  for (const name of ['x', '较长的剧本工作区'.repeat(8)]) {
    const cwd = join(process.cwd(), name), path = join(cwd, '资料', 'source.txt')
    expect(formatManuscriptPath(path, cwd)).toBe('./资料/source.txt')
    expect(formatManuscriptPath(cwd, cwd)).toBe('./')
    expect(formatManuscriptPath(path)).toBe(path)
    expect(formatManuscriptPath('./资料/source.txt', cwd)).toBe('./资料/source.txt')
    const outside = join(cwd + '-other', 'source.txt')
    expect(formatManuscriptPath(outside, cwd)).toBe(outside)
    expect(formatManuscriptPath(join(cwd, '..', 'outside.txt'), cwd)).toBe(join(cwd, '..', 'outside.txt'))
    const quote = `甲OS：保留原文中的${path}。`
    expect(JSON.parse(serializeManuscriptData({ source_path: path, quote }, cwd)))
      .toEqual({ source_path: './资料/source.txt', quote })
  }
})

it.each(['paths', 'source_paths', 'candidate_paths', 'missing_files'])('keeps %s pages portable at root and nested sections', (key) => {
  const outside = join(process.cwd(), 'outside-source.txt')
  const pages = ['short', '较长的剧本工作区'.repeat(8)].map((name) => {
    const cwd = join(process.cwd(), name)
    const paths = [join(cwd, '资料', 'source.txt'), outside, './already.txt', null]
    const data = { task_key: '路径分页', [key]: paths, nested: [{ [key]: paths }] }
    const digest = manuscriptReportVersion(data, cwd)
    return [key, `nested.0.${key}`].map((section) => {
      const cursor = { report_sha256: digest, report_section: section }
      const text = formatManuscriptReport(data, digest, { cwd, maxCharacters: 1600, cursor })
      const page = z.object({ items: z.array(z.string().nullable()) }).parse(JSON.parse(text))
      expect(page.items).toEqual(['./资料/source.txt', outside, './already.txt', null])
      const withoutWorkspace = formatManuscriptReport(data, digest, { maxCharacters: 8000, cursor })
      expect(z.object({ items: z.array(z.string().nullable()) }).parse(JSON.parse(withoutWorkspace)).items).toEqual(paths)
      return text
    })
  })
  expect(pages[0]).toEqual(pages[1])
})

it('preserves absolute path text in ordinary item and quotation pages', () => {
  const cwd = join(process.cwd(), 'quotation-workspace')
  const literal = join(cwd, '原文中的文件.txt')
  const data = { task_key: '原文分页', items: [literal], quote: [literal], records: [{ items: [literal], quote: literal }] }
  const digest = manuscriptReportVersion(data, cwd)
  for (const section of ['items', 'quote', 'records.0.items']) {
    const text = formatManuscriptReport(data, digest, { cwd, maxCharacters: 1600,
      cursor: { report_sha256: digest, report_section: section } })
    expect(z.object({ items: z.array(z.string()) }).parse(JSON.parse(text)).items).toEqual([literal])
  }
  const text = formatManuscriptReport(data, digest, { cwd, maxCharacters: 1600,
    cursor: { report_sha256: digest, report_section: 'records' } })
  expect(z.object({ items: z.array(z.object({ items: z.array(z.string()), quote: z.string() })) }).parse(JSON.parse(text)).items)
    .toEqual(data.records)
})
