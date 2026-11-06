import { subtitleReviewWarnings } from '../src/subtitles.ts'
/**
 * Subtitle timing: placement from a recognition alignment, and the `subtitles` call.
 *
 * Nothing here recognizes speech, so the fixtures are alignment documents and
 * declared lines — the two inputs the pass actually consumes.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveSettings, runDramaRender } from '../src/index.ts'
import { fileSha256 } from '../src/cache.ts'
import { episodePaths } from '../src/paths.ts'
import { verifyPreparedSubtitleClock } from '../src/prepare.ts'
import { readTimeline } from '../src/timeline.ts'
import {
  cueRateFindings,
  effectiveCharacterCount,
  parseAlignment,
  parseLinePlan,
  placeAlignedCues,
} from '../src/speech.ts'
import { formatSrtTime } from '../src/subtitles.ts'
import type { ProcessChannel, RenderSettings } from '../src/types.ts'
import {
  cleanup,
  placeholderHandler,
  probeHandler,
  stubChannel,
  tempProject,
  writePlaceholder,
  type StubHandler,
} from './harness.ts'

const temporary: string[] = []

afterEach(async () => {
  await Promise.all(temporary.splice(0).map(async (dir) => { await cleanup(dir) }))
})

/** The settings a test run resolves, with an injected channel. */
function settingsWith(channel: ProcessChannel): RenderSettings {
  return { ...resolveSettings({ ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe' }), channel }
}

describe('placeAlignedCues', () => {
  it('takes the aligned times and keeps the script text', () => {
    const placement = placeAlignedCues(1, ['第一句', '第二句'], [
      { text: '第一句', startSeconds: 0.4, endSeconds: 1.2 },
      { text: '第二句', startSeconds: 1.8, endSeconds: 2.6 },
    ], 10, 3)
    expect(placement.aligned).toBe(2)
    expect(placement.defect).toBe('')
    expect(placement.cues).toEqual([
      { shot: 1, text: '第一句', startSeconds: 10.4, endSeconds: 11.2, timingSource: 'asr_aligned' },
      { shot: 1, text: '第二句', startSeconds: 11.8, endSeconds: 12.6, timingSource: 'asr_aligned' },
    ])
  })

  it('keeps short speech spans without delaying the next line', () => {
    const placement = placeAlignedCues(1, ['甲', '乙'], [
      { text: '甲', startSeconds: 0.1, endSeconds: 0.3 },
      { text: '乙', startSeconds: 0.5, endSeconds: 0.7 },
    ], 10, 1.2)
    expect(placement.defect).toBe('')
    expect(placement.cues.map(cue => [cue.startSeconds, cue.endSeconds])).toEqual([[10.1, 10.3], [10.5, 10.7]])
  })

  it('rejects a negative clip-relative start instead of moving it to zero', () => {
    const placement = placeAlignedCues(1, ['甲'], [{ text: '甲', startSeconds: -0.1, endSeconds: 0.2 }], 10, 1)
    expect(placement.cues).toEqual([])
    expect(placement.defect).not.toBe('')
  })

  it('rejects a span too short to survive SRT millisecond rounding', () => {
    const placement = placeAlignedCues(1, ['甲'], [{ text: '甲', startSeconds: 0.1, endSeconds: 0.1001 }], 0, 1)
    expect(placement.cues).toEqual([])
    expect(placement.defect).not.toBe('')
  })

  it('ignores whitespace the recognizer added where the script has none', () => {
    const placement = placeAlignedCues(1, ['第一句'], [{ text: '第 一 句', startSeconds: 0, endSeconds: 1 }], 0, 2)
    expect(placement.defect).toBe('')
    expect(placement.cues[0]?.text).toBe('第一句')
  })

  it('reports a recognizer word the script does not contain', () => {
    const placement = placeAlignedCues(1, ['第一句'], [{ text: '你说什么', startSeconds: 0, endSeconds: 1 }], 0, 2)
    expect(placement.cues).toEqual([])
    expect(placement.defect).toContain('字幕文字只取剧本原文')
  })

  it('reports an alignment written for a different number of lines', () => {
    const placement = placeAlignedCues(1, ['第一句', '第二句'], [
      { text: '第一句', startSeconds: 0, endSeconds: 1 },
    ], 0, 2)
    expect(placement.defect).toContain('不是为当前台词做的')
  })

  it('reports an alignment whose own span is not a positive duration', () => {
    const placement = placeAlignedCues(1, ['第一句'], [{ text: '第一句', startSeconds: 1, endSeconds: 1 }], 0, 2)
    expect(placement.defect).toContain('对齐时间无效')
  })

  it('rejects overlapping recognized stretches instead of moving speech boundaries', () => {
    const placement = placeAlignedCues(1, ['第一句', '第二句'], [
      { text: '第一句', startSeconds: 0.2, endSeconds: 1.4 },
      { text: '第二句', startSeconds: 1.1, endSeconds: 1.9 },
    ], 0, 3)
    expect(placement.cues).toEqual([])
    expect(placement.defect).toContain('重叠')
  })

  it('rejects a stretch that runs past the end of its shot', () => {
    const placement = placeAlignedCues(1, ['第一句'], [{ text: '第一句', startSeconds: 3, endSeconds: 9 }], 0, 4)
    expect(placement.cues).toEqual([])
    expect(placement.defect).toContain('超出镜头范围')
  })
})

describe('line plans, alignment documents, and times', () => {
  it('rejects malformed JSON rows with the document path and row position', () => {
    for (const document of [null, [], { shots: [null] }, { shots: [3] },
      { shots: [{ shot: 0, lines: [] }] }, { shots: [{ shot: 1.5, lines: [] }] },
      { shots: [{ shot: 1, lines: 'line' }] }]) {
      expect(() => parseLinePlan(document, 'private-lines.json')).toThrow('private-lines.json')
    }
    for (const document of [null, { shots: [null] }, { shots: [3] },
      { shots: [{ shot: 0, cues: [] }] }, { shots: [{ shot: 1, cues: null }] },
      { shots: [{ shot: 1, cues: [null] }] },
      { shots: [{ shot: 1, cues: [{ text: 2, start: 0, end: 1 }] }] },
      { shots: [{ shot: 1, cues: [{ text: 'line', start: 'Infinity', end: 1 }] }] },
      { shots: [{ shot: 1, cues: [] }, { shot: 1, cues: [] }] }]) {
      expect(() => parseAlignment(document, 'private-alignment.json')).toThrow('private-alignment.json')
    }
  })

  it('orders both document types by shot and preserves explicitly absent strategies', () => {
    expect(parseLinePlan({ shots: [{ shot: 3, lines: ['three'] }, { shot: 1, lines: ['one'] }] }, 'lines'))
      .toEqual([{ shot: 1, lines: ['one'] }, { shot: 3, lines: ['three'] }])
    expect(parseAlignment({ shots: [{ shot: 3, cues: [] }, { shot: 1, strategy: 'asr_aligned', cues: [] }] }, 'alignment'))
      .toEqual([{ shot: 1, strategy: 'asr_aligned', cues: [] }, { shot: 3, cues: [] }])
  })

  it('ignores blank planned lines and cues without a measurable reading interval', () => {
    expect(effectiveCharacterCount('，。！？')).toBe(0)
    expect(placeAlignedCues(1, [' ', ''], [], 0, 1)).toMatchObject({ cues: [], aligned: 0, defect: '' })
    const make = (shot: number, end: number) => ({ shot, text: '甲'.repeat(30), startSeconds: 0,
      endSeconds: end, timingSource: 'asr_aligned' as const })
    const findings = cueRateFindings([make(1, 2), make(2, 1), make(3, 0), make(4, -1), make(5, 1)],
      new Map([[1, 0], [2, 0], [3, 0], [4, 0]]))
    expect(findings.map(row => [row.shot, row.charactersPerSecond, row.impossible])).toEqual([[2, 30, true], [1, 15, false]])
  })

  it('counts only characters that are actually spoken', () => {
    expect(effectiveCharacterCount('他说 A1，。')).toBe(4)
  })


  it('formats SRT timestamps with a comma and milliseconds', () => {
    expect(formatSrtTime(0.4)).toBe('00:00:00,400')
    expect(formatSrtTime(6)).toBe('00:00:06,000')
    expect(formatSrtTime(3725.5)).toBe('01:02:05,500')
  })

  it('rejects a malformed plan', () => {
    expect(() => parseLinePlan({ shots: [] }, 'lines.json')).not.toThrow()
    expect(() => parseLinePlan({}, 'lines.json')).toThrow('台词计划必须是')
    expect(() => parseLinePlan({ shots: [{ shot: 1, lines: [2] }] }, 'lines.json')).toThrow('必须是字符串数组')
    expect(() => parseLinePlan({ shots: [{ shot: 1, lines: [] }, { shot: 1, lines: [] }] }, 'lines.json'))
      .toThrow('镜头号重复')
  })

  it('reads an alignment document and rejects a malformed one', () => {
    const rows = parseAlignment({ shots: [{ shot: 3, cues: [{ text: '甲', start: 0, end: 1 }] }] }, 'a.json')
    expect(rows).toEqual([{ shot: 3, cues: [{ text: '甲', startSeconds: 0, endSeconds: 1 }] }])
    expect(() => parseAlignment({}, 'a.json')).toThrow('对齐文档必须是')
    expect(() => parseAlignment({ shots: [{ shot: 1, cues: [{ text: '甲', start: 0 }] }] }, 'a.json'))
      .toThrow('必须含 text、start、end')
  })

  it('reports the cues whose reading speed is too high', () => {
    const starts = new Map([[1, 0]])
    const fast = cueRateFindings([
      { shot: 1, text: '这不是能看清的一行字幕内容', startSeconds: 0, endSeconds: 1, timingSource: 'asr_aligned' },
    ], starts)
    expect(fast).toHaveLength(1)
    expect(fast[0]?.impossible).toBe(false)
    const impossible = cueRateFindings([
      { shot: 1, text: '这不是能看清的一行字幕内容', startSeconds: 0, endSeconds: 0.4, timingSource: 'asr_aligned' },
    ], starts)
    expect(impossible[0]?.impossible).toBe(true)
  })
})

/** The alignment both shots share: one stretch per declared line. */
const ALIGNMENT = { shots: [
  { shot: 1, strategy: 'asr_aligned', cues: [
    { text: '第一句', start: 0.4, end: 1.2 },
    { text: '第二句', start: 1.8, end: 2.6 },
  ] },
  { shot: 2, strategy: 'asr_aligned', cues: [{ text: '第三句', start: 0.3, end: 1.6 }] },
] }

/** The lines both shots declare, matching {@link ALIGNMENT}. */
const LINES = { shots: [
  { shot: 1, lines: ['第一句', '第二句'] },
  { shot: 2, lines: ['第三句'] },
] }

/** A project with two shots, one line plan, and one alignment document. */
async function cueProject(lines: unknown, alignment: unknown = ALIGNMENT): Promise<{
  project: string
  shots: string
  plan: string
  aligned: string
  subtitle: string
}> {
  const project = await tempProject()
  temporary.push(project)
  const shots = join(project, 'ep02-shots.json')
  const plan = join(project, 'ep02-lines.json')
  const aligned = join(project, 'ep02-aligned.json')
  await writePlaceholder(shots, JSON.stringify({ shots: [
    { shot: 1, video: 'media/p1.mp4' },
    { shot: 2, video: 'media/p2.mp4' },
  ] }))
  await writePlaceholder(plan, JSON.stringify(lines))
  await writePlaceholder(aligned, JSON.stringify(alignment))
  await writePlaceholder(join(project, 'media', 'p1.mp4'), 'selected shot one')
  await writePlaceholder(join(project, 'media', 'p2.mp4'), 'selected shot two')
  return { project, shots, plan, aligned, subtitle: join(project, 'editing', '02.srt') }
}

/** The probe table both shots share: four seconds then two. */
function cueProbes(project: string): StubHandler {
  return probeHandler({
    [join(project, 'media', 'p1.mp4')]: { durationSeconds: 4, video: {} },
    [join(project, 'media', 'p2.mp4')]: { durationSeconds: 2, video: {} },
  })
}

describe('drama_render subtitles', () => {
  it('does not publish new cues as source-bound when alignment explicitly identifies another selected sound', async () => {
    const { project, shots, plan, aligned, subtitle } = await cueProject(LINES)
    const selectedAudio = join(project, 'media', 'p1-original.wav')
    await writePlaceholder(selectedAudio, 'different selected audio')
    await writeFile(shots, JSON.stringify({ shots: [
      { shot: 1, video: 'media/p1.mp4', audio: selectedAudio }, { shot: 2, video: 'media/p2.mp4' },
    ] }))
    const firstSource = await fileSha256(join(project, 'media', 'p1.mp4'))
    const secondSource = await fileSha256(join(project, 'media', 'p2.mp4'))
    const alignment = (source: string) => JSON.stringify({ shots: ALIGNMENT.shots.map(row => ({
      ...row, source_sha256: row.shot === 1 ? source : secondSource,
    })) })
    await writeFile(aligned, alignment(firstSource))
    await writePlaceholder(subtitle, '保留旧字幕')
    const build = () => runDramaRender({ method: 'subtitles', project, episode: 2, shots,
      lines: plan, alignment: aligned, subtitleSrt: subtitle },
    settingsWith(stubChannel([cueProbes(project)]).channel))
    const reviewed = await build()
    expect(reviewed.written).not.toContain(subtitle)
    expect(reviewed.checks).toContainEqual(expect.objectContaining({
      id: 'subtitle_line_coverage', detail: expect.stringContaining('对齐来源与当前所选声音不一致') as string,
    }))
    expect(await readFile(subtitle, 'utf8')).toBe('保留旧字幕')
    const draft = await readFile(`${subtitle}.draft.srt`, 'utf8')
    expect(draft).toContain('第三句')
    expect(draft).not.toContain('第一句')
    await writeFile(aligned, alignment(await fileSha256(selectedAudio)))
    expect((await build()).written).toContain(subtitle)
    expect(await readFile(subtitle, 'utf8')).toContain('第一句')
  })

  it('keeps silent shots empty, warns about unused alignment and readable fast speech', async () => {
    const fast = '甲'.repeat(13)
    const { project, shots, plan, aligned, subtitle } = await cueProject({ shots: [
      { shot: 1, lines: [fast] }, { shot: 2, lines: [] },
    ] }, { shots: [
      { shot: 1, strategy: 'asr_aligned', cues: [{ text: fast, start: 0, end: 1 }] },
      { shot: 2, strategy: 'no_lines', cues: [] },
      { shot: 9, strategy: 'asr_aligned', cues: [{ text: 'unused', start: 0, end: 1 }] },
    ] })
    const report = await runDramaRender({ method: 'subtitles', project, episode: 2, shots,
      lines: plan, alignment: aligned, subtitleSrt: subtitle }, settingsWith(stubChannel([cueProbes(project)]).channel))
    expect(report.ok).toBe(true)
    expect(report.failures).toEqual([])
    expect(report.warnings.join(' ')).toContain('镜头 9 不在成片清单里')
    expect(report.warnings.join(' ')).toContain('13.0 字/秒')
    expect(await readFile(subtitle, 'utf8')).toContain(fast)
  })

  it('writes the aligned times onto the episode clock', async () => {
    const { project, shots, plan, aligned, subtitle } = await cueProject(LINES)
    const stub = stubChannel([cueProbes(project)])
    const report = await runDramaRender({
      method: 'subtitles', project, episode: 2, shots, lines: plan, alignment: aligned, subtitleSrt: subtitle,
    }, settingsWith(stub.channel))

    expect(report.method).toBe('subtitles')
    expect(report.ok).toBe(true)
    expect(report.written).toEqual([subtitle, `${subtitle}.clock.json`, `${subtitle}.review.txt`])
    expect(report.failures).toEqual([])
    expect(await readFile(subtitle, 'utf8')).toBe([
      '1', '00:00:00,400 --> 00:00:01,200', '第一句', '',
      '2', '00:00:01,800 --> 00:00:02,600', '第二句', '',
      '3', '00:00:04,300 --> 00:00:05,600', '第三句', '',
    ].join('\n'))
  })

  it('refuses a substituted prepared master even when the generated subtitle and per-shot sources still match', async () => {
    const { project, shots, plan, aligned } = await cueProject(LINES)
    const subtitleSrt = join(project, 'selected.srt')
    const paths = episodePaths(project, '02')
    const stub = stubChannel([cueProbes(project), placeholderHandler('audio')])
    const settings = settingsWith(stub.channel)
    const input = { project, episode: 2, shots, subtitleSrt }
    await runDramaRender({ ...input, method: 'subtitles', lines: plan, alignment: aligned }, settings)
    await runDramaRender({ ...input, method: 'prepare' }, settings)
    const timeline = await readTimeline(paths.timeline)
    const original = await readFile(paths.masterAudio)
    await expect(verifyPreparedSubtitleClock(paths.subtitle, paths, timeline)).resolves.toBeUndefined()
    await writeFile(paths.masterAudio, 'other')
    expect((await readFile(paths.masterAudio)).length).toBe(original.length)
    for (const subtitle of [subtitleSrt, paths.subtitle]) {
      await expect(verifyPreparedSubtitleClock(subtitle, paths, timeline)).rejects.toThrow('整集原声')
    }
    await writeFile(paths.masterAudio, original)
    await expect(verifyPreparedSubtitleClock(paths.subtitle, paths, timeline)).resolves.toBeUndefined()
  })

  it('binds the master and cut even when strict speech coverage uses a manually authored SRT', async () => {
    const { project, shots } = await cueProject(LINES)
    const subtitleSrt = join(project, 'manual.srt')
    const paths = episodePaths(project, '02')
    await writePlaceholder(subtitleSrt, '1\n00:00:00,400 --> 00:00:01,200\n第一句\n')
    await writePlaceholder(join(project, 'project_config.json'), JSON.stringify({
      project_bible: { delivery: { subtitle: { require_speech_coverage: true } } },
    }))
    const stub = stubChannel([cueProbes(project), placeholderHandler('audio')])
    await runDramaRender({ method: 'prepare', project, episode: 2, shots, subtitleSrt }, settingsWith(stub.channel))
    const timeline = await readTimeline(paths.timeline)
    expect(timeline.delivery?.subtitle?.require_speech_coverage).toBe(true)
    await expect(verifyPreparedSubtitleClock(subtitleSrt, paths, timeline)).resolves.toBeUndefined()
    const shifted = { ...timeline, clips: [{ shot: 1, startUs: 0, durationUs: 3_000_000 },
      { shot: 2, startUs: 3_000_000, durationUs: 3_000_000 }] }
    await expect(verifyPreparedSubtitleClock(subtitleSrt, paths, shifted)).rejects.toThrow('准备切点')
    await writeFile(paths.masterAudio, 'other')
    await expect(verifyPreparedSubtitleClock(subtitleSrt, paths, timeline)).rejects.toThrow('整集原声')
  })

  it('keeps the prepared cut until a stale subtitle is rebuilt after inserting a shot', async () => {
    const { project, shots, plan, aligned, subtitle: preparedSubtitle } = await cueProject(LINES)
    const subtitleSrt = join(project, 'selected.srt')
    const prefix = join(project, 'media', 'prefix.mp4')
    await writePlaceholder(prefix, 'selected silent prefix')
    const stub = stubChannel([probeHandler({
      [prefix]: { durationSeconds: 3, video: {} },
      [join(project, 'media', 'p1.mp4')]: { durationSeconds: 4, video: {} },
      [join(project, 'media', 'p2.mp4')]: { durationSeconds: 2, video: {} },
    }), placeholderHandler()])
    const settings = settingsWith(stub.channel)
    const input = { project, episode: 2, shots, subtitleSrt }
    const build = () => runDramaRender({ ...input, method: 'subtitles', lines: plan, alignment: aligned }, settings)
    const prepare = () => runDramaRender({ ...input, method: 'prepare' }, settings)

    await build()
    const original = await prepare()
    expect(original.written).toContain(`${preparedSubtitle}.clock.json`)
    const originalClock = await readFile(`${preparedSubtitle}.clock.json`, 'utf8')
    const originalSrt = await readFile(preparedSubtitle, 'utf8')
    expect(originalClock).toBe(await readFile(`${subtitleSrt}.clock.json`, 'utf8'))
    const previousCut = await readFile(join(project, 'editing', '02-timeline.json'), 'utf8')

    await writeFile(shots, JSON.stringify({ shots: [
      { shot: 1, video: prefix }, { shot: 2, video: 'media/p1.mp4' }, { shot: 3, video: 'media/p2.mp4' },
    ] }))
    await expect(prepare()).rejects.toThrow('生成字幕与当前集、分包素材或切点不一致')
    expect(await readFile(join(project, 'editing', '02-timeline.json'), 'utf8')).toBe(previousCut)
    expect(await readFile(`${preparedSubtitle}.clock.json`, 'utf8')).toBe(originalClock)

    await writeFile(plan, JSON.stringify({ shots: [
      { shot: 1, lines: [] }, ...LINES.shots.map(row => ({ ...row, shot: row.shot + 1 })),
    ] }))
    await writeFile(aligned, JSON.stringify({ shots: [
      { shot: 1, strategy: 'no_lines', cues: [] }, ...ALIGNMENT.shots.map(row => ({ ...row, shot: row.shot + 1 })),
    ] }))
    const repair = (source = preparedSubtitle) => runDramaRender({ ...input, method: 'prepare',
      subtitleSrt: source, lines: plan, alignment: aligned }, settings)
    await expect(repair()).rejects.toThrow('当前声音文件一致的对齐证据')
    expect(await readFile(preparedSubtitle, 'utf8')).toBe(originalSrt)
    expect(await readFile(join(project, 'editing', '02-timeline.json'), 'utf8')).toBe(previousCut)

    const sources = [prefix, join(project, 'media', 'p1.mp4'), join(project, 'media', 'p2.mp4')]
    const hashes = await Promise.all(sources.map(fileSha256))
    await writeFile(aligned, JSON.stringify({ shots: [
      { shot: 1, strategy: 'no_lines', cues: [], source_sha256: hashes[0] },
      ...ALIGNMENT.shots.map((row, i) => ({ ...row, shot: row.shot + 1, source_sha256: hashes[i + 1] })),
    ] }))
    const currentAlignment = await readFile(aligned, 'utf8')
    await writeFile(aligned, JSON.stringify({ shots: [
      { shot: 1, strategy: 'no_lines', cues: [], source_sha256: hashes[0] },
      ...ALIGNMENT.shots.map((row, i) => ({ ...row, shot: row.shot + 1, source_sha256: hashes[i + 1],
        cues: row.cues.map(cue => ({ ...cue, text: '无法对应当前台词' })) })),
    ] }))
    await expect(repair()).rejects.toThrow('字幕自动修复未通过对齐复验')
    expect(await readFile(preparedSubtitle, 'utf8')).toBe(originalSrt)
    expect(await readFile(join(project, 'editing', '02-timeline.json'), 'utf8')).toBe(previousCut)
    await writeFile(aligned, currentAlignment)
    const editedSrt = join(project, 'manually-edited.srt')
    await writeFile(editedSrt, originalSrt.replace('第三句', '人工改字'))
    await writeFile(editedSrt + '.clock.json', originalClock)
    await expect(repair(editedSrt)).rejects.toThrow('生成字幕与当前集、分包素材或切点不一致')
    expect(await readFile(preparedSubtitle, 'utf8')).toBe(originalSrt)

    const boundPlan = await readFile(plan, 'utf8')
    const boundAlignment = await readFile(aligned, 'utf8')
    await writeFile(plan, boundPlan.replace('第三句', '新台词'))
    await writeFile(aligned, boundAlignment.replace('第三句', '新台词'))
    await expect(repair()).rejects.toThrow('会改变字幕文字或顺序')
    expect(await readFile(preparedSubtitle, 'utf8')).toBe(originalSrt)
    await writeFile(plan, boundPlan)
    await writeFile(aligned, boundAlignment)

    const repaired = await repair()
    expect(repaired.ok).toBe(true)
    expect(repaired.warnings).toEqual(expect.arrayContaining([expect.stringContaining('重建生成字幕并复验')]))
    const savedOriginal = repaired.written.find(path => path.endsWith('original.srt'))
    if (!savedOriginal) throw new Error('Missing original subtitle backup')
    expect(await readFile(savedOriginal, 'utf8')).toBe(originalSrt)
    expect(await readFile(savedOriginal + '.clock.json', 'utf8')).toBe(originalClock)
    expect(await readFile(preparedSubtitle, 'utf8')).toContain('00:00:07,300 --> 00:00:08,600\n第三句')
    expect((await repair()).warnings.some(warning => warning.includes('重建生成字幕并复验'))).toBe(false)
    expect(await readFile(`${preparedSubtitle}.clock.json`, 'utf8')).not.toBe(originalClock)
  })

  it.each([false, true])('does not publish an empty candidate when all alignment is unverified (existing: %s)', async (existing) => {
    const { project, shots, plan, aligned, subtitle } = await cueProject(LINES, {
      shots: ALIGNMENT.shots.map(({ shot, cues }) => ({ shot, cues })),
    })
    const candidate = `${subtitle}.draft.srt`
    const oldSubtitle = '1\n00:00:00,000 --> 00:00:01,000\n保留原字幕\n'
    const oldCandidate = '1\n00:00:00,100 --> 00:00:01,100\n保留候选\n'
    if (existing) {
      await mkdir(dirname(subtitle), { recursive: true })
      await writeFile(subtitle, oldSubtitle)
      await writeFile(candidate, oldCandidate)
      await writeFile(`${candidate}.review.txt`, '原候选说明\n')
      await writeFile(`${subtitle}.blocked`, '原待核标记\n')
    }
    const report = await runDramaRender({ method: 'subtitles', project, episode: 2,
      shots, lines: plan, alignment: aligned, subtitleSrt: subtitle },
    settingsWith(stubChannel([cueProbes(project)]).channel))

    expect(report.ok).toBe(true)
    expect(report.written).toEqual([`${subtitle}.review.txt`])
    expect(report.warnings.join('\n')).toContain('未生成字幕候选')
    expect(report.warnings.join('\n')).not.toContain('候选已写入')
    expect(await readFile(`${subtitle}.review.txt`, 'utf8')).toContain('未生成字幕候选')
    if (existing) {
      expect(await readFile(subtitle, 'utf8')).toBe(oldSubtitle)
      expect(await readFile(candidate, 'utf8')).toBe(oldCandidate)
      expect(await readFile(`${candidate}.review.txt`, 'utf8')).toBe('原候选说明\n')
      expect(await readFile(`${subtitle}.blocked`, 'utf8')).toBe('原待核标记\n')
    } else {
      for (const path of [subtitle, `${subtitle}.clock.json`, candidate, `${candidate}.clock.json`, `${candidate}.review.txt`]) {
        await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' })
      }
    }
  })

  it('retains an explicit all-no-lines result instead of reporting missing alignment', async () => {
    const { project, shots, plan, aligned, subtitle } = await cueProject({ shots: [
      { shot: 1, lines: [] }, { shot: 2, lines: [] },
    ] }, { shots: [
      { shot: 1, strategy: 'no_lines', cues: [] }, { shot: 2, strategy: 'no_lines', cues: [] },
    ] })
    const report = await runDramaRender({ method: 'subtitles', project, episode: 2,
      shots, lines: plan, alignment: aligned, subtitleSrt: subtitle },
    settingsWith(stubChannel([cueProbes(project)]).channel))
    expect(report.ok).toBe(true)
    expect(report.written).toEqual([subtitle, `${subtitle}.clock.json`, `${subtitle}.review.txt`])
    expect(await readFile(subtitle, 'utf8')).toBe('\n')
    expect(report.warnings.join('\n')).not.toContain('未生成字幕候选')
    await expect(readFile(`${subtitle}.draft.srt`)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('preserves user subtitles, writes a reviewable candidate and clears observations after successful alignment', async () => {
    const { project, shots, plan, aligned, subtitle } = await cueProject(LINES, { shots: [ALIGNMENT.shots[0]] })
    const oldSrt = '1\n00:00:00,000 --> 00:00:01,000\n旧字幕\n'
    await mkdir(dirname(subtitle), { recursive: true })
    await writeFile(subtitle, oldSrt, 'utf8')
    const settings = settingsWith(stubChannel([cueProbes(project)]).channel)
    const failed = await runDramaRender({ method: 'subtitles', project, episode: 2,
      shots, lines: plan, alignment: aligned, subtitleSrt: subtitle }, settings)
    expect(failed.ok).toBe(true)
    expect(failed.written).toEqual([`${subtitle}.draft.srt`, `${subtitle}.draft.srt.clock.json`,
      `${subtitle}.review.txt`, `${subtitle}.draft.srt.review.txt`])
    expect(await readFile(subtitle, 'utf8')).toBe(oldSrt)
    expect((await subtitleReviewWarnings(subtitle)).join(' ')).toContain('字幕对齐待核')
    expect(await readFile(`${subtitle}.draft.srt`, 'utf8')).toContain('第一句')

    await writeFile(aligned, JSON.stringify(ALIGNMENT), 'utf8')
    const passed = await runDramaRender({ method: 'subtitles', project, episode: 2,
      shots, lines: plan, alignment: aligned, subtitleSrt: subtitle }, settings)
    expect(passed.ok).toBe(true)
    expect(await readFile(subtitle, 'utf8')).toContain('第一句')
    await expect(readFile(`${subtitle}.blocked`, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('reports missing alignment as advisory without fabricating a cue', async () => {
    const { project, shots, plan, aligned, subtitle } = await cueProject(LINES, { shots: [
      { shot: 1, strategy: 'asr_aligned', cues: [
        { text: '第一句', start: 0.4, end: 1.2 },
        { text: '第二句', start: 1.8, end: 2.6 },
      ] },
    ] })
    const stub = stubChannel([cueProbes(project)])
    const report = await runDramaRender({
      method: 'subtitles', project, episode: 2, shots, lines: plan, alignment: aligned, subtitleSrt: subtitle,
    }, settingsWith(stub.channel))

    expect(report.ok).toBe(true)
    expect(report.warnings.join('\n')).toContain('对齐文档里没有这一镜的时间')
    expect(report.warnings.join('\n')).toContain('重跑一次语音识别')
    expect(report.written).toEqual([`${subtitle}.draft.srt`, `${subtitle}.draft.srt.clock.json`,
      `${subtitle}.review.txt`, `${subtitle}.draft.srt.review.txt`])
    expect(await readFile(`${subtitle}.draft.srt`, 'utf8')).toContain('第一句')
    await expect(readFile(subtitle, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('blocks when the recognizer heard a line the script does not contain', async () => {
    const { project, shots, plan, aligned, subtitle } = await cueProject(LINES, { shots: [
      { shot: 1, strategy: 'asr_aligned', cues: [
        { text: '第一句', start: 0.4, end: 1.2 },
        { text: '另一句', start: 1.8, end: 2.6 },
      ] },
      { shot: 2, strategy: 'asr_aligned', cues: [{ text: '第三句', start: 0.3, end: 1.6 }] },
    ] })
    const stub = stubChannel([cueProbes(project)])
    const report = await runDramaRender({
      method: 'subtitles', project, episode: 2, shots, lines: plan, alignment: aligned, subtitleSrt: subtitle,
    }, settingsWith(stub.channel))

    expect(report.ok).toBe(true)
    expect(report.warnings.join('\n')).toContain('字幕文字只取剧本原文')
  })

  it('blocks when a shot speaks a line the plan never declared', async () => {
    const { project, shots, plan, aligned, subtitle } = await cueProject({ shots: [
      { shot: 1, lines: ['第一句', '第二句'] },
    ] })
    const stub = stubChannel([cueProbes(project)])
    const report = await runDramaRender({
      method: 'subtitles', project, episode: 2, shots, lines: plan, alignment: aligned, subtitleSrt: subtitle,
    }, settingsWith(stub.channel))

    expect(report.ok).toBe(true)
    expect(report.warnings.join('\n')).toContain('镜头 2 的对齐文档里有 1 段识别结果')
  })

  it('blocks recognized speech in a shot declared silent even with no subtitle cues', async () => {
    const { project, shots, plan, aligned, subtitle } = await cueProject({ shots: [
      { shot: 1, lines: ['第一句', '第二句'] },
      { shot: 2, lines: [] },
    ] }, { shots: [
      ALIGNMENT.shots[0],
      { shot: 2, strategy: 'unmapped_speech', cues: [] },
    ] })
    const report = await runDramaRender({
      method: 'subtitles', project, episode: 2, shots, lines: plan, alignment: aligned, subtitleSrt: subtitle,
    }, settingsWith(stubChannel([cueProbes(project)]).channel))

    expect(report.ok).toBe(true)
    expect(report.warnings.join('\n')).toContain('镜头 2 没有声明台词')
  })

  it('blocks a declared silent shot without a checked no_lines alignment', async () => {
    for (const shot2 of [undefined, { shot: 2, strategy: 'asr_aligned', cues: [] }]) {
      const { project, shots, plan, aligned, subtitle } = await cueProject({ shots: [
        { shot: 1, lines: ['第一句', '第二句'] },
        { shot: 2, lines: [] },
      ] }, { shots: [ALIGNMENT.shots[0], ...(shot2 === undefined ? [] : [shot2])] })
      const report = await runDramaRender({ method: 'subtitles', project, episode: 2, shots,
        lines: plan, alignment: aligned, subtitleSrt: subtitle }, settingsWith(stubChannel([cueProbes(project)]).channel))
      expect(report.ok).toBe(true)
      expect(report.warnings.join('\n')).toContain('镜头 2 没有声明台词')
      expect(report.warnings.join('\n')).toContain('无发声')
    }
  })

  it('blocks a cue whose reading speed is impossible', async () => {
    const impossible = '这句字幕确实需要更久才能看清'
    const { project, shots, plan, aligned, subtitle } = await cueProject({ shots: [
      { shot: 1, lines: [impossible] },
      { shot: 2, lines: ['第三句'] },
    ] }, { shots: [
      { shot: 1, strategy: 'asr_aligned', cues: [{ text: impossible, start: 0, end: 0.4 }] },
      { shot: 2, strategy: 'asr_aligned', cues: [{ text: '第三句', start: 0.3, end: 1.6 }] },
    ] })
    const stub = stubChannel([cueProbes(project)])
    const report = await runDramaRender({
      method: 'subtitles', project, episode: 2, shots, lines: plan, alignment: aligned, subtitleSrt: subtitle,
    }, settingsWith(stub.channel))

    expect(report.ok).toBe(true)
    expect(report.warnings.join('\n')).toContain('subtitle_timing')
  })

  it.each([
    { end: 0.1, defect: '对齐时间无效' },
    { end: 0.1001, defect: '不足一毫秒' },
  ])('blocks an unwritable speech interval ending at $end before emitting a cue', async ({ end, defect }) => {
    const { project, shots, plan, aligned, subtitle } = await cueProject({ shots: [
      { shot: 1, lines: ['甲'] },
    ] }, { shots: [
      { shot: 1, strategy: 'asr_aligned', cues: [{ text: '甲', start: 0.1, end }] },
    ] })
    const report = await runDramaRender({
      method: 'subtitles', project, episode: 2, shots, lines: plan, alignment: aligned, subtitleSrt: subtitle,
    }, settingsWith(stubChannel([cueProbes(project)]).channel))

    expect(report.ok).toBe(true)
    expect(report.warnings.join('\n')).toContain(defect)
    expect(report.written).toEqual([`${subtitle}.review.txt`])
    await expect(readFile(subtitle, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('blocks a cue the alignment places past the end of its own shot', async () => {
    const { project, shots, plan, aligned, subtitle } = await cueProject(LINES, { shots: [
      { shot: 1, strategy: 'asr_aligned', cues: [
        { text: '第一句', start: 0.4, end: 1.2 },
        { text: '第二句', start: 1.8, end: 2.6 },
      ] },
      // Shot 2 is two seconds long; these times describe a longer take.
      { shot: 2, strategy: 'asr_aligned', cues: [{ text: '第三句', start: 5, end: 5.5 }] },
    ] })
    const stub = stubChannel([cueProbes(project)])
    const report = await runDramaRender({
      method: 'subtitles', project, episode: 2, shots, lines: plan, alignment: aligned, subtitleSrt: subtitle,
    }, settingsWith(stub.channel))

    expect(report.ok).toBe(true)
    expect(report.warnings.join('\n')).toContain('超出镜头范围')
  })

  it.each([
    { start: 0.3, end: 0.3, defect: '对齐时间无效' },
    { start: 0.3, end: 0.3001, defect: '不足一毫秒' },
  ])('does not write a partial SRT for a rejected zero display interval ($end)', async ({ start, end, defect }) => {
    const { project, shots, plan, aligned, subtitle } = await cueProject(LINES, { shots: [
      ALIGNMENT.shots[0],
      { shot: 2, strategy: 'asr_aligned', cues: [{ text: '第三句', start, end }] },
    ] })
    const stub = stubChannel([cueProbes(project)])
    const report = await runDramaRender({
      method: 'subtitles', project, episode: 2, shots, lines: plan, alignment: aligned, subtitleSrt: subtitle,
    }, settingsWith(stub.channel))

    expect(report.ok).toBe(true)
    expect(report.warnings.join('\n')).toContain(defect)
    expect(report.written).toEqual([`${subtitle}.draft.srt`, `${subtitle}.draft.srt.clock.json`,
      `${subtitle}.review.txt`, `${subtitle}.draft.srt.review.txt`])
    await expect(readFile(subtitle, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses a shot number the manifest does not contain', async () => {
    const { project, shots, plan, aligned, subtitle } = await cueProject({ shots: [
      { shot: 1, lines: ['第一句', '第二句'] },
      { shot: 7, lines: ['第七句'] },
    ] })
    const stub = stubChannel([cueProbes(project)])
    const report = await runDramaRender({
      method: 'subtitles', project, episode: 2, shots, lines: plan, alignment: aligned, subtitleSrt: subtitle,
    }, settingsWith(stub.channel))

    expect(report.ok).toBe(true)
    expect(report.warnings.join('\n')).toContain('不在成片清单里')
  })

  it('refuses a shot the aligner labelled as anything but fully aligned', async () => {
    const { project, shots, plan, aligned, subtitle } = await cueProject(LINES, { shots: [
      { shot: 1, strategy: 'asr_aligned', cues: [
        { text: '第一句', start: 0.4, end: 1.2 },
        { text: '第二句', start: 1.8, end: 2.6 },
      ] },
      { shot: 2, strategy: 'estimated_total', cues: [{ text: '第三句', start: 0.3, end: 1.6 }] },
    ] })
    const stub = stubChannel([cueProbes(project)])
    const report = await runDramaRender({
      method: 'subtitles', project, episode: 2, shots, lines: plan, alignment: aligned, subtitleSrt: subtitle,
    }, settingsWith(stub.channel))

    expect(report.ok).toBe(true)
    expect(report.warnings.join('\n')).toContain('estimated_total')
    expect(report.warnings.join('\n')).toContain('asr_aligned')
  })

  it('refuses an alignment document that never states how it was produced', async () => {
    // Times from an unlabelled document are unverified rather than verified: the
    // aligner always writes the strategy, so absence means the file came from
    // somewhere else.
    const { project, shots, plan, aligned, subtitle } = await cueProject(LINES, { shots: [
      { shot: 1, cues: [
        { text: '第一句', start: 0.4, end: 1.2 },
        { text: '第二句', start: 1.8, end: 2.6 },
      ] },
      { shot: 2, cues: [{ text: '第三句', start: 0.3, end: 1.6 }] },
    ] })
    const stub = stubChannel([cueProbes(project)])
    const report = await runDramaRender({
      method: 'subtitles', project, episode: 2, shots, lines: plan, alignment: aligned, subtitleSrt: subtitle,
    }, settingsWith(stub.channel))

    expect(report.ok).toBe(true)
    expect(report.warnings.join('\n')).toContain('对齐来源未验证')
    expect(report.warnings.join('\n')).toContain('文档没有标 strategy')
  })

  it('rejects a strategy that is not a string instead of treating it as absent', async () => {
    const { project, shots, plan, aligned, subtitle } = await cueProject(LINES, { shots: [
      { shot: 1, strategy: 1, cues: [
        { text: '第一句', start: 0.4, end: 1.2 },
        { text: '第二句', start: 1.8, end: 2.6 },
      ] },
      { shot: 2, strategy: 'asr_aligned', cues: [{ text: '第三句', start: 0.3, end: 1.6 }] },
    ] })
    const stub = stubChannel([cueProbes(project)])
    await expect(runDramaRender({
      method: 'subtitles', project, episode: 2, shots, lines: plan, alignment: aligned, subtitleSrt: subtitle,
    }, settingsWith(stub.channel))).rejects.toThrow('strategy 必须是字符串')
  })

  it('still disclaims how accurate the recognizer itself was', async () => {
    const { project, shots, plan, aligned, subtitle } = await cueProject(LINES)
    const stub = stubChannel([cueProbes(project)])
    const report = await runDramaRender({
      method: 'subtitles', project, episode: 2, shots, lines: plan, alignment: aligned, subtitleSrt: subtitle,
    }, settingsWith(stub.channel))
    expect(report.not_checked).toContain('speech_alignment')
  })
})
