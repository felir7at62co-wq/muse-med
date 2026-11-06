/** Workspace-local paths do not spend manuscript context budgets on host-specific directory names. */
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { Config } from '../src/manuscript-revisions.ts'
import { ManuscriptWork } from '../src/manuscript-work.ts'
import { manuscriptTextHash } from '../src/manuscript-scenes.ts'
import { formatManuscriptReport, manuscriptReportVersion, serializeManuscriptData } from '../src/manuscript-report.ts'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true, maxRetries: 5 })))
})

it('changes only declared local path fields and preserves external paths, prose, and input objects', () => {
  const cwd = resolve('project'), path = join(cwd, '资料', '原稿🌕.txt'), external = resolve('project-other', 'source.txt')
  const input = { path, source_path: path, file_path: path, paths: [path, external, 12],
    source_paths: [path], candidate_paths: [path], missing_files: [path], relative: './keep.txt',
    nested: { path: external, source_path: './already.txt', path_count: 1 },
    quote: path, text: path, note: { value: path } }
  const before = JSON.stringify(input)
  const relative = './资料/原稿🌕.txt'
  expect(JSON.parse(serializeManuscriptData(input, cwd))).toEqual({ ...input,
    path: relative, source_path: relative, file_path: relative,
    paths: [relative, external, 12], source_paths: [relative], candidate_paths: [relative], missing_files: [relative] })
  expect(JSON.stringify(input)).toBe(before)
  expect(serializeManuscriptData(input)).toBe(before)
})

it('keeps complete rows and continuations identical under different absolute workspace names', () => {
  const render = (cwd: string) => {
    const report = { task_key: '分页', records: Array.from({ length: 8 }, (_, index) => ({
      source_path: join(cwd, 'source.txt'), index, quote: '甲OS：不把设想写成已发生。'.repeat(35) })) }
    const version = manuscriptReportVersion(report, cwd)
    return [formatManuscriptReport(report, version, { maxCharacters: 3200, cwd }),
      formatManuscriptReport(report, version, { maxCharacters: 3200, cwd,
        cursor: { report_sha256: version, report_section: 'records', report_offset: 1 } })]
  }
  const short = render(resolve('a')), long = render(resolve('long-workspace-'.repeat(8)))
  expect(short).toEqual(long)
  expect(short.every(text => text.length <= 3200)).toBe(true)
  expect(short[1]).toContain('甲OS：不把设想写成已发生。')
  expect(short[1]).toContain('"source_path":"./source.txt"')
})

it('returns usable relative paths while retaining absolute durable identities and exact budgeted content', async () => {
  const source = '第一集\n1-1 门厅 日 内\n甲OS：' + '原句🌕，不补当前动作。'.repeat(700) + '\n'
  const outputs: { source: string; audit: string; checkpoint: string | undefined; refresh: string | undefined }[] = []
  for (const prefix of ['muse-path-a-', 'muse-path-较长的工作目录-'.repeat(3)]) {
    const cwd = await mkdtemp(join(tmpdir(), prefix)); roots.push(cwd)
    await writeFile(join(cwd, '来源🌕.txt'), source)
    const session = SessionId('portable-path-budget'), signal = new AbortController().signal
    const work = new ManuscriptWork(Config({ sourceReadMaxResultCharacters: 30000 }))
    await work.request({ action: 'bind', task_key: '保留原文', mode: 'edit', source_paths: ['来源🌕.txt'], candidate_paths: ['采用.md'] }, cwd, session, signal)
    const page = await work.request({ action: 'read_source', source_path: './来源🌕.txt', limit: 3 }, cwd, session, signal)
    expect(page).toContain('"source_path":"./来源🌕.txt"')
    const audit = await work.request({ action: 'audit' }, cwd, session, signal)
    const state = await readFile(join(cwd, '.muse', 'manuscript-work', manuscriptTextHash(session), 'state.json'), 'utf8')
    expect(state).toContain(JSON.stringify(await realpath(join(cwd, '来源🌕.txt'))))
    expect(await readFile(join(cwd, '来源🌕.txt'), 'utf8')).toBe(source)
    outputs.push({ source: page, audit, checkpoint: await work.checkpoint(cwd, session, signal),
      refresh: await work.refresh(cwd, session, signal, true) })
  }
  expect(outputs[0]).toEqual(outputs[1])
})
