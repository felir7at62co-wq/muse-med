import { createHash } from 'node:crypto'
import { lstat, readFile, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseSubtitlePlan, resolveSubtitleOverlay } from '../src/subtitle-plan.ts'
import { cleanup, tempProject, writePlaceholder } from './harness.ts'

const temporary: string[] = []
afterEach(async () => { await Promise.all(temporary.splice(0).map(cleanup)) })
const digest = (text: string) => createHash('sha256').update(text).digest('hex')
const decision = { shot: 2, source_sha256: digest('provider-picture'), start_seconds: 1, end_seconds: 2,
  text: '再添半碗', action: 'retain_embedded', reason: '预览看见该句', evidence_paths: ['qa/frame.json'] }
async function fixture(decisions: unknown[] = [decision]) {
  const project = await tempProject()
  temporary.push(project)
  const subtitleSrt = join(project, 'original.srt'), planPath = join(project, 'plan.json')
  const original = '1\n00:00:01,000 --> 00:00:02,000\n外加字幕\n\n2\n00:00:06,000 --> 00:00:07,000\n再添半碗\n'
  await writePlaceholder(subtitleSrt, original)
  await writePlaceholder(planPath, JSON.stringify({ schema_version: 1, decisions }))
  await writePlaceholder(join(project, 'video/24/shot_002.mp4'), 'provider-picture')
  await writePlaceholder(join(project, 'video/24/shot_001.mp4'), 'first-picture')
  return { project, episode: '24', subtitleSrt, planPath, original,
    timeline: { clips: [{ shot: 1, startUs: 0, durationUs: 5_000_000 },
      { shot: 2, startUs: 5_000_000, durationUs: 5_000_000 }], bodyEndSeconds: 10 } }
}
describe('source-bound subtitle overlay', () => {
  it('retains matching picture text while separately binding the new overlay and unmodified original', async () => {
    const input = await fixture(), result = await resolveSubtitleOverlay(input)
    expect(result.cues.map(x => x.text)).toEqual(['外加字幕'])
    expect(result.report).toMatchObject({ episode: '24', retained_cue_indexes: [2], original_cue_count: 2, overlay_cue_count: 1,
      original_srt_sha256: digest(input.original), evidence_kind: 'caller_declared', retained_text_editable: false,
      retained_text_style_adjustable: false,
      retained_embedded: [{ cue_index: 2, shot: 2, start_seconds: 6, end_seconds: 7, editable: false }] })
    const overlay = await readFile(result.report.resolved_srt, 'utf8')
    expect(digest(overlay)).toBe(result.report.resolved_srt_sha256)
    expect(overlay).not.toContain('再添半碗')
    expect(await readFile(input.subtitleSrt, 'utf8')).toBe(input.original)
    const report: unknown = JSON.parse(await readFile(result.report.decision_report, 'utf8'))
    expect(report).toMatchObject({ schema_version: 1, ...result.report,
      decisions: [{ start_seconds: 1, end_seconds: 2, global_start_seconds: 6, global_end_seconds: 7 }],
      sources: [{ shot: 1 }, { shot: 2 }],
      timeline_clips: [{ shot: 1, start_us: 0, duration_us: 5_000_000 }, { shot: 2, start_us: 5_000_000, duration_us: 5_000_000 }] })
    expect(result.warnings.join('\n')).toContain('不可作为字幕编辑')
    expect(result.warnings.join('\n')).toContain('不是 Host 签发')
  })
  it.each([{ ...decision, start_seconds: 1.1 }, { ...decision, end_seconds: 1.9 }, { ...decision, text: '噪声字符' }])(
    'keeps the entire cue when text or coverage is uncertain: %j', async (entry) => {
      const result = await resolveSubtitleOverlay(await fixture([entry]))
      expect(result.cues).toHaveLength(2)
      expect(result.report.retained_cue_indexes).toEqual([])
      expect(result.warnings.join('\n')).toContain('不自动切句')
    })
  it('normalizes punctuation only for comparison', async () => {
    const result = await resolveSubtitleOverlay(await fixture([{ ...decision, text: ' 再添半碗！' }]))
    expect(result.report.retained_embedded[0]?.text).toBe('再添半碗')
  })
  it('binds normalized display text to the overlay hash while retaining the original SRT', async () => {
    const input = await fixture()
    const original = input.original.replace('外加字幕', '外加，\n字幕！')
    await writePlaceholder(input.subtitleSrt, original)
    const result = await resolveSubtitleOverlay({ ...input, normalizeDisplay: true })
    const output = await readFile(result.report.resolved_srt, 'utf8')
    expect(result.cues.map(cue => cue.text)).toEqual(['外加 字幕'])
    expect(output).toContain('外加 字幕')
    expect(digest(output)).toBe(result.report.resolved_srt_sha256)
    expect(result.report.original_srt_sha256).toBe(digest(original))
    expect(await readFile(input.subtitleSrt, 'utf8')).toBe(original)
  })
  it('warns and emits an empty overlay when all selected cues are punctuation, without modifying the source', async () => {
    const input = await fixture([])
    const original = '1\n00:00:01,000 --> 00:00:02,000\n！\n'
    await writePlaceholder(input.subtitleSrt, original)
    const result = await resolveSubtitleOverlay({ ...input, normalizeDisplay: true })
    expect(result.cues).toEqual([])
    expect(result.warnings.join(' ')).toContain('1.000–2.000 秒')
    expect(result.report.overlay_cue_count).toBe(0)
    expect(await readFile(result.report.resolved_srt, 'utf8')).not.toContain('！')
    expect(await readFile(input.subtitleSrt, 'utf8')).toBe(original)
  })
  it('orders retained cue indexes and records a duplicated declared interval only once', async () => {
    const first = { ...decision, shot: 1, source_sha256: digest('first-picture'), text: '外加字幕' }
    const result = await resolveSubtitleOverlay(await fixture([decision, first, decision]))
    expect(result.report.retained_cue_indexes).toEqual([1, 2])
    expect(result.report.retained_embedded).toHaveLength(2)
    expect(result.cues).toEqual([])
  })
  it('resolves repeated shot numbers against their first timeline occurrence', async () => {
    const input = await fixture()
    input.timeline.clips.push({ shot: 2, startUs: 10_000_000, durationUs: 1_000_000 })
    const result = await resolveSubtitleOverlay(input)
    expect(result.report.retained_cue_indexes).toEqual([2])
    expect(result.report.retained_embedded).toMatchObject([{ shot: 2, start_seconds: 6, end_seconds: 7 }])
    expect(result.report.sources.map(source => source.shot)).toEqual([1, 2])
  })
  it('keeps all cues when the reviewed interval contains none', async () => {
    const result = await resolveSubtitleOverlay(await fixture([{ ...decision, start_seconds: 3, end_seconds: 4 }]))
    expect(result.cues).toHaveLength(2)
    expect(result.warnings.join('\n')).toContain('未完整覆盖')
  })
  it.each([[{ ...decision, source_sha256: 'a'.repeat(64) }, 'SHA-256 已变化'],
    [{ ...decision, shot: 3 }, '不在时间线'], [{ ...decision, end_seconds: 6 }, '越过片段末尾']])(
    'rejects stale or invalid source mapping', async (entry, message) => {
      await expect(resolveSubtitleOverlay(await fixture([entry]))).rejects.toThrow(message)
    })
  it('exports an empty plan to an explicit new path without overwriting either SRT', async () => {
    const input = await fixture([]), outputSrt = join(input.project, 'editing/export.srt')
    const result = await resolveSubtitleOverlay({ ...input, outputSrt })
    expect(result.cues).toHaveLength(2)
    expect(result.report.decision_report).toBe(outputSrt + '.decision-report.json')
    await expect(resolveSubtitleOverlay({ ...input, outputSrt })).rejects.toMatchObject({ code: 'EEXIST' })
    expect(await readFile(input.subtitleSrt, 'utf8')).toBe(input.original)
  })
  it('rejects export outside the project', async () => {
    const input = await fixture()
    await expect(resolveSubtitleOverlay({ ...input, outputSrt: join(input.project, '../outside.srt') })).rejects.toThrow('项目目录内')
  })
  it('allows a project root alias without following output links inside the project', async () => {
    const input = await fixture(), parent = await tempProject()
    temporary.push(parent)
    const project = join(parent, 'project')
    await symlink(input.project, project, process.platform === 'win32' ? 'junction' : 'dir')
    const result = await resolveSubtitleOverlay({ ...input, project, outputSrt: 'editing/alias.srt' })
    expect(result.cues.map(cue => cue.text)).toEqual(['外加字幕'])
    expect(await readFile(result.report.resolved_srt, 'utf8')).toContain('外加字幕')
  })
  it('keeps an existing report unchanged without leaving a newly written SRT', async () => {
    const input = await fixture(), outputSrt = join(input.project, 'editing/export.srt')
    const report = outputSrt + '.decision-report.json'
    await writePlaceholder(report, 'existing report evidence')
    await expect(resolveSubtitleOverlay({ ...input, outputSrt })).rejects.toMatchObject({ code: 'EEXIST' })
    expect(await readFile(report, 'utf8')).toBe('existing report evidence')
    await expect(lstat(outputSrt)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('rejects output through a link without writing to the linked directory', async () => {
    const input = await fixture(), target = await tempProject()
    temporary.push(target)
    await symlink(target, join(input.project, 'linked'), 'junction')
    await expect(resolveSubtitleOverlay({ ...input, outputSrt: join(input.project, 'linked/output.srt') })).rejects.toThrow('junction')
    await expect(lstat(join(target, 'output.srt'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
describe('subtitle plan JSON', () => {
  it('defaults only omitted evidence references', () => {
    const { evidence_paths: _evidence, ...entry } = decision
    expect(parseSubtitlePlan({ schema_version: 1, decisions: [entry] })[0]?.evidence_paths).toEqual([])
  })
  it.each([null, [], {}, { schema_version: 2, decisions: [] }, { schema_version: 1, decisions: null }])('rejects unsupported JSON %j', (value) => {
    expect(() => parseSubtitlePlan(value)).toThrow()
  })
  it.each([null, { ...decision, shot: 0 }, { ...decision, source_sha256: 'bad' }, { ...decision, action: 'erase' },
    { ...decision, start_seconds: -1 }, { ...decision, end_seconds: 0 }, { ...decision, text: '' },
    { ...decision, reason: ' ' }, { ...decision, evidence_paths: [3] }])('rejects invalid decision %j', (entry) => {
    expect(() => parseSubtitlePlan({ schema_version: 1, decisions: [entry] })).toThrow()
  })
})
