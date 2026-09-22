/**
 * Subtitle timing: speech measurement, line placement, and the `subtitles` call.
 *
 * Nothing here recognizes speech, so the fixtures are synthesized clip audio
 * and declared lines — the two inputs the pass actually consumes.
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
  placeShotCues,
  requiredSeconds,
} from '../src/speech.ts'
import type { SpeechDetection } from '../src/vad.ts'
import { formatSrtTime } from '../src/subtitles.ts'
import type { ProcessChannel, RenderSettings } from '../src/types.ts'
import {
  cleanup,
  pcmHandler,
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

/** One detection result with the regions a test wants and a fixed floor. */
function detection(regions: readonly { startSeconds: number; endSeconds: number }[],
  floorDb = -60, thresholdDb = -45): SpeechDetection {
  return { regions, floorDb, thresholdDb, frames: 100 }
}

describe('placeShotCues', () => {
  it('gives each line its own detected stretch', () => {
    const placement = placeShotCues(1, ['甲句', '乙句'],
      detection([{ startSeconds: 0.2, endSeconds: 1 }, { startSeconds: 1.4, endSeconds: 2.2 }]), 10, 3)
    expect(placement.cues).toEqual([
      { shot: 1, text: '甲句', startSeconds: 10.2, endSeconds: 11, timingSource: 'audio_vad' },
      { shot: 1, text: '乙句', startSeconds: 11.4, endSeconds: 12.2, timingSource: 'audio_vad' },
    ])
    expect(placement.estimated).toBe(0)
    expect(placement.defect).toBe('')
    expect(placement.warnings).toEqual([])
  })

  it('shortens a cue that would outlast the line it carries', () => {
    const placement = placeShotCues(1, ['陆沉舟'], detection([{ startSeconds: 0, endSeconds: 6 }]), 0, 8)
    expect(placement.cues[0]?.endSeconds).toBe(requiredSeconds('陆沉舟'))
    expect(placement.cues[0]?.endSeconds).toBeCloseTo(1, 6)
  })

  it('splits several lines inside each stretch instead of across the silence between them', () => {
    const placement = placeShotCues(2, ['四个字', '两个', '第三句'],
      detection([{ startSeconds: 0.5, endSeconds: 1.5 }, { startSeconds: 3, endSeconds: 5 }]), 0, 6)
    expect(placement.estimated).toBe(3)
    // One line fits the short stretch; the other two share the long one, so no
    // cue is displayed while the shot is silent.
    expect(placement.cues.map(cue => [cue.startSeconds, cue.endSeconds])).toEqual([
      [0.5, 1.5], [3, 3.8], [3.8, 5],
    ])
    expect(placement.cues.every(cue => cue.timingSource === 'estimated_within_run')).toBe(true)
    expect(placement.warnings[0]).toContain('估算')
  })

  it('reports a shot that declares lines but never speaks', () => {
    const placement = placeShotCues(3, ['没人说的台词'], detection([]), 0, 2)
    expect(placement.cues).toEqual([])
    expect(placement.defect).toContain('没有检出发声')
    expect(placement.defect).toContain('门限')
  })

  it('leaves a shot without declared lines empty and silent', () => {
    const placement = placeShotCues(4, ['  '], detection([{ startSeconds: 0, endSeconds: 1 }]), 0, 1)
    expect(placement).toEqual({
      shot: 4, cues: [], regions: 1, aligned: 0, estimated: 0, defect: '', warnings: [],
    })
  })
})

describe('placeAlignedCues', () => {
  it('takes the aligned times and keeps the script text', () => {
    const placement = placeAlignedCues(1, ['第一句', '第二句'], [
      { text: '第一句', startSeconds: 0.4, endSeconds: 1.2 },
      { text: '第二句', startSeconds: 1.8, endSeconds: 2.6 },
    ], 10, 3)
    expect(placement.aligned).toBe(2)
    expect(placement.estimated).toBe(0)
    expect(placement.defect).toBe('')
    expect(placement.cues).toEqual([
      { shot: 1, text: '第一句', startSeconds: 10.4, endSeconds: 11.2, timingSource: 'asr_aligned' },
      { shot: 1, text: '第二句', startSeconds: 11.8, endSeconds: 12.6, timingSource: 'asr_aligned' },
    ])
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

  it('keeps cues ordered when a recognizer reports overlapping stretches', () => {
    const placement = placeAlignedCues(1, ['第一句', '第二句'], [
      { text: '第一句', startSeconds: 0.2, endSeconds: 1.4 },
      { text: '第二句', startSeconds: 1.1, endSeconds: 1.9 },
    ], 0, 3)
    // The second cue starts where the first ended, and the shortest cue length
    // still applies, so an overlap never reaches the SRT writer.
    expect(placement.cues.map(cue => [cue.startSeconds, cue.endSeconds])).toEqual([[0.2, 1.4], [1.4, 2.2]])
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
      { shot: 1, text: '这不是能看清的一行字幕内容', startSeconds: 0, endSeconds: 1, timingSource: 'audio_vad' },
    ], starts)
    expect(fast).toHaveLength(1)
    expect(fast[0]?.impossible).toBe(false)
    const impossible = cueRateFindings([
      { shot: 1, text: '这不是能看清的一行字幕内容', startSeconds: 0, endSeconds: 0.4, timingSource: 'audio_vad' },
    ], starts)
    expect(impossible[0]?.impossible).toBe(true)
  })
})

/** A project with two shots, their audio, and one declared line plan. */
async function cueProject(lines: unknown, alignment?: unknown): Promise<{
  project: string
  shots: string
  plan: string
  aligned?: string
  subtitle: string
}> {
  const project = await tempProject()
  temporary.push(project)
  const shots = join(project, 'ep02-shots.json')
  const plan = join(project, 'ep02-lines.json')
  await writePlaceholder(shots, JSON.stringify({ shots: [
    { shot: 1, video: 'media/p1.mp4' },
    { shot: 2, video: 'media/p2.mp4' },
  ] }))
  await writePlaceholder(plan, JSON.stringify(lines))
  if (alignment === undefined) return { project, shots, plan, subtitle: join(project, 'editing', '02.srt') }
  const aligned = join(project, 'ep02-aligned.json')
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

/** Audio that speaks once per declared line, with gaps wide enough to stay separate. */
function cueAudio(project: string, floorAmplitude?: number): StubHandler {
  return pcmHandler({
    [join(project, 'media', 'p1.mp4')]: {
      seconds: 4,
      spans: [{ start: 0.4, end: 1.2 }, { start: 1.8, end: 2.8 }],
      ...(floorAmplitude === undefined ? {} : { floorAmplitude }),
    },
    [join(project, 'media', 'p2.mp4')]: {
      seconds: 2,
      spans: [{ start: 0.3, end: 1.6 }],
      ...(floorAmplitude === undefined ? {} : { floorAmplitude }),
    },
  })
}

describe('drama_render subtitles', () => {
  it('writes measured cue times from each shot\'s own audio', async () => {
    const { project, shots, plan, subtitle } = await cueProject({ shots: [
      { shot: 1, lines: ['第一句', '第二句'] },
      { shot: 2, lines: ['第三句'] },
    ] })
    const stub = stubChannel([cueProbes(project), cueAudio(project)])
    const report = await runDramaRender({
      method: 'subtitles', project, episode: 2, shots, lines: plan, subtitleSrt: subtitle,
    }, settingsWith(stub.channel))

    expect(report.method).toBe('subtitles')
    expect(report.ok).toBe(true)
    expect(report.written).toEqual([subtitle])
    expect(report.failures).toEqual([])
    expect(report.not_checked).not.toContain('speech_alignment')
    expect(await readFile(subtitle, 'utf8')).toBe([
      '1', '00:00:00,400 --> 00:00:01,200', '第一句', '',
      '2', '00:00:01,800 --> 00:00:02,800', '第二句', '',
      '3', '00:00:04,300 --> 00:00:05,300', '第三句', '',
    ].join('\n'))
  })

  it('still separates the lines when the clip\'s own floor sits above a fixed detector\'s level', async () => {
    const { project, shots, plan, subtitle } = await cueProject({ shots: [
      { shot: 1, lines: ['第一句', '第二句'] },
      { shot: 2, lines: ['第三句'] },
    ] })
    // 700/32768 is about -33dBFS, above the -35dB a fixed silencedetect level
    // would use: that level finds no silence at all and every line would be
    // estimated across the whole clip. The derived level still splits them.
    const stub = stubChannel([cueProbes(project), cueAudio(project, 700)])
    const report = await runDramaRender({
      method: 'subtitles', project, episode: 2, shots, lines: plan, subtitleSrt: subtitle,
    }, settingsWith(stub.channel))

    expect(report.ok).toBe(true)
    expect(report.failures).toEqual([])
    expect(report.not_checked).not.toContain('speech_alignment')
    expect(await readFile(subtitle, 'utf8')).toContain('00:00:00,400 --> 00:00:01,200')
  })

  it('takes the times from an alignment document and keeps the script text', async () => {
    const { project, shots, plan, aligned, subtitle } = await cueProject({ shots: [
      { shot: 1, lines: ['第一句', '第二句'] },
      { shot: 2, lines: ['第三句'] },
    ] }, { shots: [
      { shot: 1, cues: [
        { text: '第一句', start: 0.5, end: 1.3 },
        { text: '第二句', start: 1.9, end: 2.7 },
      ] },
    ] })
    const stub = stubChannel([cueProbes(project), cueAudio(project)])
    const report = await runDramaRender({
      method: 'subtitles', project, episode: 2, shots, lines: plan, alignment: String(aligned), subtitleSrt: subtitle,
    }, settingsWith(stub.channel))

    expect(report.ok).toBe(true)
    expect(report.not_checked).not.toContain('speech_alignment')
    expect(await readFile(subtitle, 'utf8')).toBe([
      '1', '00:00:00,500 --> 00:00:01,300', '第一句', '',
      '2', '00:00:01,900 --> 00:00:02,700', '第二句', '',
      '3', '00:00:04,300 --> 00:00:05,300', '第三句', '',
    ].join('\n'))
  })

  it('blocks an alignment whose text is not the script', async () => {
    const { project, shots, plan, aligned, subtitle } = await cueProject({ shots: [
      { shot: 1, lines: ['第一句', '第二句'] },
      { shot: 2, lines: ['第三句'] },
    ] }, { shots: [
      { shot: 1, cues: [
        { text: '第一句', start: 0.5, end: 1.3 },
        { text: '另一句', start: 1.9, end: 2.7 },
      ] },
    ] })
    const stub = stubChannel([cueProbes(project), cueAudio(project)])
    const report = await runDramaRender({
      method: 'subtitles', project, episode: 2, shots, lines: plan, alignment: String(aligned), subtitleSrt: subtitle,
    }, settingsWith(stub.channel))

    expect(report.ok).toBe(false)
    expect(report.failures.join('\n')).toContain('字幕文字只取剧本原文')
  })

  it('reports a line that shares one stretch instead of pretending it measured it', async () => {
    const { project, shots, plan, subtitle } = await cueProject({ shots: [
      { shot: 1, lines: ['第一句', '第二句'] },
      { shot: 2, lines: ['第三句'] },
    ] })
    const stub = stubChannel([cueProbes(project), pcmHandler({
      [join(project, 'media', 'p1.mp4')]: { seconds: 4, spans: [{ start: 1, end: 3.2 }] },
      [join(project, 'media', 'p2.mp4')]: { seconds: 2, spans: [{ start: 0.3, end: 1.6 }] },
    })])
    const report = await runDramaRender({
      method: 'subtitles', project, episode: 2, shots, lines: plan, subtitleSrt: subtitle,
    }, settingsWith(stub.channel))

    expect(report.ok).toBe(true)
    expect(report.not_checked).toContain('speech_alignment')
    expect(report.warnings.join('\n')).toContain('estimated_within_run')
  })

  it('blocks when a shot declares lines its audio never speaks', async () => {
    const { project, shots, plan, subtitle } = await cueProject({ shots: [
      { shot: 1, lines: ['第一句', '第二句'] },
      { shot: 2, lines: ['第三句'] },
    ] })
    const stub = stubChannel([cueProbes(project), pcmHandler({
      [join(project, 'media', 'p1.mp4')]: { seconds: 4, spans: [{ start: 0.4, end: 1.2 }, { start: 1.8, end: 2.8 }] },
      [join(project, 'media', 'p2.mp4')]: { seconds: 2 },
    })])
    const report = await runDramaRender({
      method: 'subtitles', project, episode: 2, shots, lines: plan, subtitleSrt: subtitle,
    }, settingsWith(stub.channel))

    expect(report.ok).toBe(false)
    expect(report.failures.join('\n')).toContain('subtitle_line_coverage')
    expect(await readFile(subtitle, 'utf8')).toContain('第一句')
  })

  it('blocks when a shot speaks a line the plan never declared', async () => {
    const { project, shots, plan, subtitle } = await cueProject({ shots: [
      { shot: 1, lines: ['第一句', '第二句'] },
    ] })
    const stub = stubChannel([cueProbes(project), cueAudio(project)])
    const report = await runDramaRender({
      method: 'subtitles', project, episode: 2, shots, lines: plan, subtitleSrt: subtitle,
    }, settingsWith(stub.channel))

    expect(report.ok).toBe(false)
    expect(report.failures.join('\n')).toContain('镜头 2 的音频里有 1 段发声')
  })

  it('refuses a shot number the manifest does not contain', async () => {
    const { project, shots, plan, subtitle } = await cueProject({ shots: [
      { shot: 1, lines: ['第一句', '第二句'] },
      { shot: 7, lines: ['第七句'] },
    ] })
    const stub = stubChannel([cueProbes(project), cueAudio(project)])
    const report = await runDramaRender({
      method: 'subtitles', project, episode: 2, shots, lines: plan, subtitleSrt: subtitle,
    }, settingsWith(stub.channel))

    expect(report.ok).toBe(false)
    expect(report.failures.join('\n')).toContain('不在成片清单里')
  })
})
