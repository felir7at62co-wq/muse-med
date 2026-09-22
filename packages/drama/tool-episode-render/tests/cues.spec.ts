/**
 * Subtitle timing: placement from a recognition alignment, and the `subtitles` call.
 *
 * Nothing here recognizes speech, so the fixtures are alignment documents and
 * declared lines — the two inputs the pass actually consumes.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveSettings, runDramaRender } from '../src/index.ts'
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

  it('keeps cues ordered when a recognizer reports overlapping stretches', () => {
    const placement = placeAlignedCues(1, ['第一句', '第二句'], [
      { text: '第一句', startSeconds: 0.2, endSeconds: 1.4 },
      { text: '第二句', startSeconds: 1.1, endSeconds: 1.9 },
    ], 0, 3)
    // The second cue starts where the first ended, and the shortest cue length
    // still applies, so an overlap never reaches the SRT writer.
    expect(placement.cues.map(cue => [cue.startSeconds, cue.endSeconds])).toEqual([[0.2, 1.4], [1.4, 2.2]])
  })

  it('clamps a stretch that runs past the end of its shot', () => {
    const placement = placeAlignedCues(1, ['第一句'], [{ text: '第一句', startSeconds: 3, endSeconds: 9 }], 0, 4)
    expect(placement.cues[0]?.endSeconds).toBe(4)
  })
})

describe('line plans, alignment documents, and times', () => {
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
  { shot: 1, cues: [
    { text: '第一句', start: 0.4, end: 1.2 },
    { text: '第二句', start: 1.8, end: 2.6 },
  ] },
  { shot: 2, cues: [{ text: '第三句', start: 0.3, end: 1.6 }] },
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
  it('writes the aligned times onto the episode clock', async () => {
    const { project, shots, plan, aligned, subtitle } = await cueProject(LINES)
    const stub = stubChannel([cueProbes(project)])
    const report = await runDramaRender({
      method: 'subtitles', project, episode: 2, shots, lines: plan, alignment: aligned, subtitleSrt: subtitle,
    }, settingsWith(stub.channel))

    expect(report.method).toBe('subtitles')
    expect(report.ok).toBe(true)
    expect(report.written).toEqual([subtitle])
    expect(report.failures).toEqual([])
    expect(await readFile(subtitle, 'utf8')).toBe([
      '1', '00:00:00,400 --> 00:00:01,200', '第一句', '',
      '2', '00:00:01,800 --> 00:00:02,600', '第二句', '',
      '3', '00:00:04,300 --> 00:00:05,600', '第三句', '',
    ].join('\n'))
  })

  it('blocks when a shot with lines has no alignment for it', async () => {
    const { project, shots, plan, aligned, subtitle } = await cueProject(LINES, { shots: [
      { shot: 1, cues: [
        { text: '第一句', start: 0.4, end: 1.2 },
        { text: '第二句', start: 1.8, end: 2.6 },
      ] },
    ] })
    const stub = stubChannel([cueProbes(project)])
    const report = await runDramaRender({
      method: 'subtitles', project, episode: 2, shots, lines: plan, alignment: aligned, subtitleSrt: subtitle,
    }, settingsWith(stub.channel))

    expect(report.ok).toBe(false)
    expect(report.failures.join('\n')).toContain('对齐文档里没有这一镜的时间')
    expect(report.failures.join('\n')).toContain('重跑一次语音识别')
  })

  it('blocks when the recognizer heard a line the script does not contain', async () => {
    const { project, shots, plan, aligned, subtitle } = await cueProject(LINES, { shots: [
      { shot: 1, cues: [
        { text: '第一句', start: 0.4, end: 1.2 },
        { text: '另一句', start: 1.8, end: 2.6 },
      ] },
      { shot: 2, cues: [{ text: '第三句', start: 0.3, end: 1.6 }] },
    ] })
    const stub = stubChannel([cueProbes(project)])
    const report = await runDramaRender({
      method: 'subtitles', project, episode: 2, shots, lines: plan, alignment: aligned, subtitleSrt: subtitle,
    }, settingsWith(stub.channel))

    expect(report.ok).toBe(false)
    expect(report.failures.join('\n')).toContain('字幕文字只取剧本原文')
  })

  it('blocks when a shot speaks a line the plan never declared', async () => {
    const { project, shots, plan, aligned, subtitle } = await cueProject({ shots: [
      { shot: 1, lines: ['第一句', '第二句'] },
    ] })
    const stub = stubChannel([cueProbes(project)])
    const report = await runDramaRender({
      method: 'subtitles', project, episode: 2, shots, lines: plan, alignment: aligned, subtitleSrt: subtitle,
    }, settingsWith(stub.channel))

    expect(report.ok).toBe(false)
    expect(report.failures.join('\n')).toContain('镜头 2 的对齐文档里有 1 段识别结果')
  })

  it('blocks a cue whose reading speed is impossible', async () => {
    const impossible = '这不是能看清的一行字幕内容真是长得离谱'
    const { project, shots, plan, aligned, subtitle } = await cueProject({ shots: [
      { shot: 1, lines: [impossible] },
      { shot: 2, lines: ['第三句'] },
    ] }, { shots: [
      { shot: 1, cues: [{ text: impossible, start: 0, end: 0.4 }] },
      { shot: 2, cues: [{ text: '第三句', start: 0.3, end: 1.6 }] },
    ] })
    const stub = stubChannel([cueProbes(project)])
    const report = await runDramaRender({
      method: 'subtitles', project, episode: 2, shots, lines: plan, alignment: aligned, subtitleSrt: subtitle,
    }, settingsWith(stub.channel))

    expect(report.ok).toBe(false)
    expect(report.failures.join('\n')).toContain('subtitle_timing')
  })

  it('blocks a cue the alignment places past the end of its own shot', async () => {
    const { project, shots, plan, aligned, subtitle } = await cueProject(LINES, { shots: [
      { shot: 1, cues: [
        { text: '第一句', start: 0.4, end: 1.2 },
        { text: '第二句', start: 1.8, end: 2.6 },
      ] },
      // Shot 2 is two seconds long; these times describe a longer take.
      { shot: 2, cues: [{ text: '第三句', start: 5, end: 5.5 }] },
    ] })
    const stub = stubChannel([cueProbes(project)])
    const report = await runDramaRender({
      method: 'subtitles', project, episode: 2, shots, lines: plan, alignment: aligned, subtitleSrt: subtitle,
    }, settingsWith(stub.channel))

    expect(report.ok).toBe(false)
    expect(report.failures.join('\n')).toContain('时长不是正数')
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

    expect(report.ok).toBe(false)
    expect(report.failures.join('\n')).toContain('不在成片清单里')
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

    expect(report.ok).toBe(false)
    expect(report.failures.join('\n')).toContain('estimated_total')
    expect(report.failures.join('\n')).toContain('asr_aligned')
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
