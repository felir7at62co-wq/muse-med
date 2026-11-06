/** Real work files expose source cue navigation without recording returned-text coverage or rewriting state. */
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as Atomic from '@deepseek-ai/dsh-atomic-write'
import { Config } from '../src/manuscript-revisions.ts'
import { ManuscriptWork } from '../src/manuscript-work.ts'
import { manuscriptTextHash } from '../src/manuscript-scenes.ts'
import { readAuditCollections } from './manuscript-test-schemas.ts'

const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true, maxRetries: 5 })))
})

const citation = z.object({ start_line: z.number(), end_line: z.number(), episode: z.string(),
  scene_id: z.string().nullable(), source_scene_id: z.string().nullable() })
const auditSchema = z.object({ semantic_assessment: z.literal('not_performed'),
  sources: z.array(z.object({ path: z.string(), sha256: z.string() })),
  source_cues: z.array(z.object({ source_path: z.string(), source_sha256: z.string(),
    line: z.number(), text: z.string(), citation_labels: z.array(citation) })),
  reading_coverage: z.array(z.object({ path: z.string(), sha256: z.string(), complete: z.boolean(),
    returned_characters: z.number(), total_characters: z.number() })) })

async function fixture(source: string) {
  const cwd = await mkdtemp(join(tmpdir(), 'manuscript-source-cues-integration-')); roots.push(cwd)
  const path = join(cwd, 'source.txt'), session = SessionId('source-cues-integration')
  await writeFile(path, source, { flag: 'wx' })
  const work = new ManuscriptWork(Config({ sourceReadMaxLines: 1 }))
  const request = async (args: object): Promise<unknown> => {
    const value: unknown = JSON.parse(await work.request(args, cwd, session, new AbortController().signal))
    return value
  }
  await request({ action: 'bind', task_key: '原稿提示导航', mode: 'edit', source_paths: ['source.txt'], candidate_paths: ['future.md'] })
  const statePath = join(cwd, '.muse', 'manuscript-work', manuscriptTextHash(session), 'state.json')
  const audit = async () => auditSchema.parse(await readAuditCollections(request))
  const sourcePath = await realpath(path), sourceSha = createHash('sha256').update(Buffer.from(source)).digest('hex')
  return { request, audit, path, statePath, sourcePath, sourceSha }
}

it('audits literal full cue lines with source hash and actual scopes without saving or increasing reading coverage', async () => {
  const source = ['△未分集导航😀。', '第六集', '6-1 门厅 日 内', ' \t△原稿提示：门开；仅作导航。  ',
    '▲这条动作不是提示索引。', '甲：对白里提到△。', '第七集', '7-1 庭院 夜 外', '△跨集提示原句完整保留。'].join('\r\n') + '\r\n'
  const f = await fixture(source), stateBefore = await readFile(f.statePath, 'utf8')
  const write = vi.spyOn(Atomic, 'writeFileAtomic')
  const audit = await f.audit()
  expect(audit.sources).toEqual([{ path: f.sourcePath, sha256: f.sourceSha }])
  expect(audit.source_cues).toEqual([
    { source_path: f.sourcePath, source_sha256: f.sourceSha, line: 1, text: '△未分集导航😀。', citation_labels: [
      { start_line: 1, end_line: 1, episode: 'unassigned', scene_id: null, source_scene_id: null },
    ] },
    { source_path: f.sourcePath, source_sha256: f.sourceSha, line: 4, text: ' \t△原稿提示：门开；仅作导航。  ', citation_labels: [
      { start_line: 4, end_line: 4, episode: '第六集', scene_id: '6-1', source_scene_id: 'source-scene-1' },
    ] },
    { source_path: f.sourcePath, source_sha256: f.sourceSha, line: 9, text: '△跨集提示原句完整保留。', citation_labels: [
      { start_line: 9, end_line: 9, episode: '第七集', scene_id: '7-1', source_scene_id: 'source-scene-2' },
    ] },
  ])
  expect(audit.reading_coverage[0]).toMatchObject({ path: f.sourcePath, sha256: f.sourceSha,
    complete: false, returned_characters: 0 })
  expect(write).not.toHaveBeenCalled()
  expect(await readFile(f.statePath, 'utf8')).toBe(stateBefore)

  const page = z.object({ reading_coverage: z.object({ complete: z.boolean(), returned_characters: z.number() }) })
    .parse(await f.request({ action: 'read_source', source_path: 'source.txt', limit: 1 }))
  expect(page.reading_coverage.complete).toBe(false)
  expect(page.reading_coverage.returned_characters).toBeGreaterThan(0)
  const stateAfterReading = await readFile(f.statePath, 'utf8')
  expect(stateAfterReading).not.toBe(stateBefore)
  expect(write.mock.calls.map(([path]) => path)).toContain(f.statePath)
  write.mockClear()
  const second = await f.audit()
  expect(second.source_cues).toEqual(audit.source_cues)
  expect(second.reading_coverage[0]).toMatchObject(page.reading_coverage)
  expect(write).not.toHaveBeenCalled()
  expect(await readFile(f.statePath, 'utf8')).toBe(stateAfterReading)
  expect(await readFile(f.path, 'utf8')).toBe(source)
})

it('follows the real source_cues audit collection pages without turning index retrieval into a reading receipt', async () => {
  const cues = Array.from({ length: 48 }, (_, index) => `△提示${index}😀，${'这只是原稿导航，不证明事件完成。'.repeat(12)}`)
  const source = ['第六集', '6-1 门厅 日 内', ...cues.slice(0, 24), '第七集', '7-1 庭院 夜 外', ...cues.slice(24)].join('\n')
  const f = await fixture(source), stateBefore = await readFile(f.statePath, 'utf8')
  const write = vi.spyOn(Atomic, 'writeFileAtomic')
  const directory = z.object({ report_paged: z.literal(true),
    report_sections: z.array(z.object({ section: z.string(), total_items: z.number() })) })
    .parse(await f.request({ action: 'audit' }))
  expect(directory.report_sections).toContainEqual(expect.objectContaining({ section: 'source_cues', total_items: 48 }))
  const audit = await f.audit()
  expect(audit.source_cues.map(cue => cue.text)).toEqual(cues)
  expect(audit.source_cues.every(cue => cue.source_path === f.sourcePath && cue.source_sha256 === f.sourceSha)).toBe(true)
  expect(audit.source_cues[0]).toMatchObject({ line: 3,
    citation_labels: [{ start_line: 3, end_line: 3, episode: '第六集', scene_id: '6-1', source_scene_id: 'source-scene-1' }] })
  expect(audit.source_cues.at(-1)).toMatchObject({ line: 52,
    citation_labels: [{ start_line: 52, end_line: 52, episode: '第七集', scene_id: '7-1', source_scene_id: 'source-scene-2' }] })
  expect(audit.reading_coverage[0]).toMatchObject({ complete: false, returned_characters: 0 })
  expect(write).not.toHaveBeenCalled()
  expect(await readFile(f.statePath, 'utf8')).toBe(stateBefore)
  expect(await readFile(f.path, 'utf8')).toBe(source)
})
