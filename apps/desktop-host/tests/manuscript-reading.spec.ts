/** Actual source pages and persisted task records preserve complete, version-bound reading. */
import { afterEach, expect, it } from 'vitest'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { SessionId } from '@deepseek-ai/dsh-session'
import { ManuscriptWork } from '../src/manuscript-work.ts'
import { Config } from '../src/manuscript-revisions.ts'
import { manuscriptReadingCoverage, recordManuscriptPage } from '../src/manuscript-reading.ts'
import { manuscriptTextHash } from '../src/manuscript-scenes.ts'
import { reportedRelationshipSchema, recheckRelationshipSchema, sourcePageContextSchema } from './manuscript-test-schemas.ts'

const roots: string[] = [], signal = new AbortController().signal
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

const coverageSchema = z.object({ complete: z.boolean(), returned_characters: z.number(), total_characters: z.number(),
  missing: z.array(z.object({ start_line: z.number(), start_column: z.number(), end_line: z.number(), end_column: z.number() })),
  coverage_basis: z.literal('returned_source_text'), semantic_assessment: z.literal('not_performed') })
const pageSchema = z.object({ source_sha256: z.string(), lines: z.array(z.object({ number: z.number(), text: z.string() })),
  continuation: z.object({ offset: z.number(), column: z.number() }).nullable(), reading_coverage: coverageSchema,
  source_contexts: sourcePageContextSchema.nullable() })
const auditSchema = z.object({ missing_files: z.array(z.string()), reading_coverage: z.array(coverageSchema),
  relationships: z.array(reportedRelationshipSchema), relationships_needing_recheck: z.array(recheckRelationshipSchema) })

async function fixture(text: string) {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'muse-reading-')))
  roots.push(cwd)
  await writeFile(join(cwd, 'source.txt'), text)
  const config = Config({ sourceReadMaxLines: 2, sourceReadMaxLineCharacters: 16, sourceReadMaxBytes: 64 })
  const work = new ManuscriptWork(config), session = SessionId('reading')
  const request = async (args: object): Promise<unknown> => JSON.parse(await work.request(args, cwd, session, signal))
  const page = async (args: object = {}) => pageSchema.parse(await request({ action: 'read_source', source_path: 'source.txt', ...args }))
  const audit = async () => auditSchema.parse(await request({ action: 'audit' }))
  await request({ action: 'bind', task_key: '来源阅读', mode: 'edit', source_paths: ['source.txt'], candidate_paths: ['future.md'] })
  return { cwd, config, work, session, request, page, audit, hash: createHash('sha256').update(text).digest('hex') }
}

it('returns the relationship after a long line and covers the exact source before a candidate exists', async () => {
  const text = '甲'.repeat(2300) + '😀乙其实是甲的父亲。\r\n第2集\r\n乙：先别告诉她。'
  const f = await fixture(text)
  const seen: string[] = []
  let cursor: { offset: number; column: number } | null = null
  let coverage: z.infer<typeof coverageSchema> | undefined
  for (let page = 0; page < 200; page++) {
    const result = await f.page({
      ...(cursor ? { ...cursor, source_sha256: f.hash } : { offset: 1, column: 1 }) })
    seen.push(...result.lines.map((line: { text: string }) => line.text))
    coverage = result.reading_coverage
    if (result.continuation === null) break
    expect(coverage.complete).toBe(false)
    cursor = result.continuation
  }
  expect(seen.join('')).toContain('😀乙其实是甲的父亲。')
  expect(coverage).toMatchObject({ complete: true, returned_characters: Array.from(text.replace(/\r\n/g, '\n')).length,
    missing: [], coverage_basis: 'returned_source_text', semantic_assessment: 'not_performed' })
  expect(await readFile(join(f.cwd, 'source.txt'), 'utf8')).toBe(text)
  expect((await f.audit()).missing_files).toEqual([join(f.cwd, 'future.md')])
})

it('reports holes for out-of-order pages and merges overlap without double counting', async () => {
  const f = await fixture('第一行\n第二行\n第三行\n第四行')
  const partial = await f.page({ source_sha256: f.hash, offset: 3 })
  expect(partial.reading_coverage).toMatchObject({ complete: false,
    missing: [{ start_line: 1, start_column: 1, end_line: 3, end_column: 1 }] })
  const first = await f.page()
  const repeated = await f.page()
  expect(first.reading_coverage.complete).toBe(true)
  expect(repeated.reading_coverage.returned_characters).toBe(first.reading_coverage.returned_characters)
})

it('rejects stale and unversioned continuation and never counts older source bytes as current', async () => {
  const f = await fixture('甲'.repeat(80))
  const first = await f.page()
  await expect(f.request({ action: 'read_source', source_path: 'source.txt', ...first.continuation })).rejects.toThrow('MANUSCRIPT_READ_VERSION')
  await writeFile(join(f.cwd, 'source.txt'), '乙'.repeat(80))
  await expect(f.request({ action: 'read_source', source_path: 'source.txt', source_sha256: f.hash,
    ...first.continuation })).rejects.toThrow('MANUSCRIPT_READ_STALE')
  expect((await f.audit()).reading_coverage[0]).toMatchObject({ complete: false, returned_characters: 0 })
})

it('does not claim an unread empty source is complete, then records an actual empty read', async () => {
  const f = await fixture('')
  expect((await f.audit()).reading_coverage[0]?.complete).toBe(false)
  expect((await f.page()).reading_coverage.complete).toBe(true)
})

it.each([
  { source: '甲😀\r', lines: ['甲😀'], characters: 2 },
  { source: '甲\r\r', lines: ['甲\r'], characters: 2 },
  { source: '\r', lines: [''], characters: 0 },
  { source: '\n\r', lines: ['', ''], characters: 1 },
  { source: '甲\r\r\n', lines: ['甲\r'], characters: 3 },
  { source: '甲\r\n乙\r', lines: ['甲', '乙'], characters: 3 },
])('counts only reading text returned for terminal CR input $source', async ({ source, lines, characters }) => {
  const f = await fixture(source)
  expect((await f.audit()).reading_coverage[0]?.complete).toBe(false)
  const page = await f.page()
  expect(page.lines.map((line: { text: string }) => line.text)).toEqual(lines)
  expect(page.reading_coverage).toMatchObject({ complete: true, returned_characters: characters, total_characters: characters })
  expect(page.source_sha256).toBe(createHash('sha256').update(source).digest('hex'))
  expect(await readFile(join(f.cwd, 'source.txt'), 'utf8')).toBe(source)
})

it('continues a Unicode partial line without counting its undisplayed terminal CR', async () => {
  const f = await fixture('甲'.repeat(17) + '😀\r')
  const first = await f.page()
  expect(first.reading_coverage).toMatchObject({ complete: false, returned_characters: 16, total_characters: 18 })
  const last = await f.page({ source_sha256: f.hash, ...first.continuation })
  expect(last.lines).toEqual([{ number: 1, text: '甲😀' }])
  expect(last.reading_coverage).toMatchObject({ complete: true, returned_characters: 18, total_characters: 18, missing: [] })
})

async function replaceStoredSpans(f: Awaited<ReturnType<typeof fixture>>, spans: { start: number; end: number }[], sha256 = f.hash) {
  const path = join(f.cwd, '.muse', 'manuscript-work', manuscriptTextHash(f.session), 'state.json')
  const state = z.record(z.string(), z.unknown()).parse(JSON.parse(await readFile(path, 'utf8')))
  state.readings = [{ path: join(f.cwd, 'source.txt'), sha256, spans }]
  const damaged = JSON.stringify(state)
  await writeFile(path, damaged)
  return { path, damaged }
}

it.each([
  [{ start: -1, end: 2 }],
  [{ start: 2, end: 1 }],
  [{ start: 0.5, end: 1 }],
  [{ start: 0, end: 1 }, { start: 1, end: 2 }],
  [{ start: 2, end: 3 }, { start: 0, end: 1 }],
])('rejects malformed persisted intervals instead of claiming returned coverage: %j', async (...spans) => {
  const f = await fixture('甲乙丙')
  const stored = await replaceStoredSpans(f, spans)
  await expect(f.request({ action: 'audit' })).rejects.toThrow()
  expect(await readFile(stored.path, 'utf8')).toBe(stored.damaged)
})

it.each([{ start: 0, end: 4 }, { start: 4, end: 4 }])('rejects a persisted receipt beyond the current text: %j', async (span) => {
  const f = await fixture('甲乙丙'), stored = await replaceStoredSpans(f, [span])
  await expect(f.request({ action: 'audit' })).rejects.toThrow('MANUSCRIPT_READ_RECORD')
  await expect(f.request({ action: 'read_source', source_path: 'source.txt' })).rejects.toThrow('MANUSCRIPT_READ_RECORD')
  expect(await readFile(stored.path, 'utf8')).toBe(stored.damaged)
})

it('keeps an old-version receipt outside the current source length from certifying or blocking a new source', async () => {
  const f = await fixture('甲乙丙')
  await replaceStoredSpans(f, [{ start: 0, end: 400 }], 'f'.repeat(64))
  expect((await f.audit()).reading_coverage[0]).toMatchObject({ complete: false, returned_characters: 0 })
  expect((await f.page()).reading_coverage)
    .toMatchObject({ complete: true, returned_characters: 3, total_characters: 3 })
})

it('resumes persisted coverage without treating a restarted reader as a fresh task', async () => {
  const f = await fixture('甲'.repeat(80))
  const page = await f.page()
  const resumed = new ManuscriptWork(f.config)
  const result = pageSchema.parse(JSON.parse(await resumed.request({ action: 'read_source', source_path: 'source.txt',
    source_sha256: f.hash, ...page.continuation }, f.cwd, f.session, signal)))
  expect(result.reading_coverage.returned_characters).toBeGreaterThan(page.reading_coverage.returned_characters)
  const checkpoint = await resumed.checkpoint(f.cwd, f.session, signal)
  expect(checkpoint).toContain('missing_intervals')
  expect(checkpoint).toContain(f.hash)
})

it('keeps directed relationship evidence across resume and excludes it after source replacement', async () => {
  const text = '甲和乙站在门口。\n甲：乙可能是我的父亲。'
  const f = await fixture(text)
  const evidence = { source_path: 'source.txt', source_sha256: f.hash, start_line: 1, end_line: 1, quote: text.split('\n')[0] }
  await f.request({ action: 'characters', characters: [
    { character_id: 'a', name: '甲', aliases: [], evidence: [evidence] },
    { character_id: 'b', name: '乙', aliases: [], evidence: [evidence] },
  ] })
  await f.request({ action: 'relationship', relationship: { relationship_id: 'father', subject_id: 'b', object_id: 'a',
    relation: '父亲', status: 'uncertain', scope: { context: '甲的猜测，尚未确认' },
    evidence: [{ ...evidence, start_line: 2, end_line: 2, quote: text.split('\n')[1] }] } })
  const resumed = new ManuscriptWork(f.config)
  const checkpoint = await resumed.checkpoint(f.cwd, f.session, signal)
  expect(checkpoint).toContain('"subject_id":"b","object_id":"a"')
  expect(checkpoint).toContain('uncertain')
  await writeFile(join(f.cwd, 'source.txt'), text + '\n新版本。')
  const audit = auditSchema.parse(JSON.parse(await resumed.request({ action: 'audit' }, f.cwd, f.session, signal)))
  expect(audit.relationships).toEqual([])
  expect(audit.relationships_needing_recheck).toHaveLength(1)
  expect(await resumed.checkpoint(f.cwd, f.session, signal)).not.toContain('"relation":"父亲"')
})

it('rejects invalid source paths, limits, positions and caller-provided coverage claims', async () => {
  const f = await fixture('甲乙丙')
  await writeFile(join(f.cwd, 'other.txt'), '外部文件')
  await expect(f.request({ action: 'read_source' })).rejects.toThrow('MANUSCRIPT_READ_SOURCE')
  await expect(f.request({ action: 'read_source', source_path: 'other.txt' })).rejects.toThrow('MANUSCRIPT_READ_SOURCE')
  await expect(f.request({ action: 'read_source', source_path: 'source.txt', limit: 3 })).rejects.toThrow('MANUSCRIPT_READ_LIMIT')
  await expect(f.request({ action: 'read_source', source_path: 'source.txt', source_sha256: f.hash, column: 9 })).rejects.toThrow('MANUSCRIPT_READ_POSITION')
  await expect(f.request({ action: 'read_source', source_path: 'source.txt', complete: true })).rejects.toThrow()
})

it('merges overlapping intervals and retains explicit end-of-line positions for holes', () => {
  const source = { path: 'source', sha256: 'v1', text: '甲😀\n乙丙' }
  const record = recordManuscriptPage([], source, { start: 0, end: 2 })
  const merged = recordManuscriptPage([record], source, { start: 1, end: 4 })
  const coverage = manuscriptReadingCoverage([source], [merged])[0]
  expect(merged.spans).toEqual([{ start: 0, end: 4 }])
  expect(coverage).toMatchObject({ returned_characters: 4, complete: false,
    missing: [{ start_line: 2, start_column: 2, end_line: 2, end_column: 3 }] })
})
