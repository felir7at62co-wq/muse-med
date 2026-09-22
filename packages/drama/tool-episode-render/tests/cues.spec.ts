/**
 * Subtitle timing: silence inversion, line placement, and the `subtitles` call.
 *
 * Nothing here recognizes speech, so the fixtures are silence logs and declared
 * lines — the two inputs the pass actually consumes.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveSettings, runDramaRender } from '../src/index.ts'
import { effectiveCharacterCount, invertSilence, parseLinePlan, placeShotCues } from '../src/speech.ts'
import { formatSrtTime } from '../src/subtitles.ts'
import type { ProcessChannel, RenderSettings } from '../src/types.ts'
import {
  cleanup,
  probeHandler,
  slash,
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

/** One silent stretch the stub reports. */
interface Gap {
  /** Gap start, seconds. */
  readonly start: number
  /** Gap length, seconds. */
  readonly duration: number
}

/**
 * Build the handler that answers the cue pass's `silencedetect`.
 * @param gaps - Silent stretches keyed by the analysed file's path.
 * @returns The handler; an unregistered path answers like a missing file.
 */
function silenceHandler(gaps: Readonly<Record<string, readonly Gap[]>>): StubHandler {
  const table = new Map(Object.entries(gaps).map(([path, value]) => [slash(path), value]))
  return (call) => {
    const filterAt = call.args.indexOf('-af')
    const filter = filterAt === -1 ? '' : call.args[filterAt + 1] ?? ''
    if (!filter.startsWith('silencedetect')) return undefined
    const input = call.args[call.args.indexOf('-i') + 1] ?? ''
    const found = table.get(slash(input))
    if (found === undefined) return { code: 1, stderr: `No such file or directory: ${input}` }
    const stderr = found.map(gap => `[silencedetect @ 0x1] silence_start: ${String(gap.start)}\n`
      + `[silencedetect @ 0x1] silence_end: ${String(gap.start + gap.duration)}`
      + ` | silence_duration: ${String(gap.duration)}\n`).join('')
    return { stderr }
  }
}

describe('invertSilence', () => {
  it('turns the gaps between silent stretches into speech', () => {
    expect(invertSilence([
      { startSeconds: 0, durationSeconds: 1 },
      { startSeconds: 3, durationSeconds: 3.4 },
    ], 6.4)).toEqual([{ startSeconds: 1, endSeconds: 3 }])
  })

  it('drops stretches too short to be speech', () => {
    expect(invertSilence([
      { startSeconds: 0, durationSeconds: 0.5 },
      { startSeconds: 0.55, durationSeconds: 3 },
    ], 3.55)).toEqual([{ startSeconds: 0.5, endSeconds: 0.55 }].slice(0, 0))
  })

  it('keeps a clip with no reported silence whole', () => {
    expect(invertSilence([], 2)).toEqual([{ startSeconds: 0, endSeconds: 2 }])
  })

  it('reads a clip that is silent from end to end as having no speech', () => {
    expect(invertSilence([{ startSeconds: 0, durationSeconds: 2 }], 2)).toEqual([])
  })
})

describe('placeShotCues', () => {
  it('gives each line its own detected stretch', () => {
    const placement = placeShotCues(1, ['甲句', '乙句'],
      [{ startSeconds: 0.2, endSeconds: 1 }, { startSeconds: 1.4, endSeconds: 2.2 }], 10, 3)
    expect(placement.cues).toEqual([
      { shot: 1, text: '甲句', startSeconds: 10.2, endSeconds: 11, timingSource: 'audio_silence' },
      { shot: 1, text: '乙句', startSeconds: 11.4, endSeconds: 12.2, timingSource: 'audio_silence' },
    ])
    expect(placement.estimated).toBe(0)
    expect(placement.defect).toBe('')
    expect(placement.warnings).toEqual([])
  })

  it('marks every line estimated when one stretch must carry them all', () => {
    const placement = placeShotCues(2, ['四个字', '两个'], [{ startSeconds: 0.5, endSeconds: 2.5 }], 0, 3)
    expect(placement.estimated).toBe(2)
    expect(placement.cues.map(cue => cue.timingSource)).toEqual(['estimated_within_run', 'estimated_within_run'])
    expect(placement.cues[0]?.startSeconds).toBe(0.5)
    expect(placement.cues[1]?.endSeconds).toBe(2.5)
    expect(placement.warnings[0]).toContain('估算')
  })

  it('reports a shot that declares lines but never speaks', () => {
    const placement = placeShotCues(3, ['没人说的台词'], [], 0, 2)
    expect(placement.cues).toEqual([])
    expect(placement.defect).toContain('没有检出发声')
  })

  it('leaves a shot without declared lines empty and silent', () => {
    const placement = placeShotCues(4, ['  '], [{ startSeconds: 0, endSeconds: 1 }], 0, 1)
    expect(placement).toEqual({ shot: 4, cues: [], regions: 1, estimated: 0, defect: '', warnings: [] })
  })
})

describe('line plans and times', () => {
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
})

/** A project with two shots, their audio, and one declared line plan. */
async function cueProject(lines: unknown): Promise<{
  project: string
  shots: string
  plan: string
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
  return { project, shots, plan, subtitle: join(project, 'editing', '02.srt') }
}

/** The probe table both shots share: four seconds then two. */
function cueProbes(project: string): StubHandler {
  return probeHandler({
    [join(project, 'media', 'p1.mp4')]: { durationSeconds: 4, video: {} },
    [join(project, 'media', 'p2.mp4')]: { durationSeconds: 2, video: {} },
  })
}

/** Silence that leaves one stretch per declared line. */
function cueGaps(project: string): Record<string, readonly Gap[]> {
  return {
    [join(project, 'media', 'p1.mp4')]: [
      { start: 0, duration: 0.4 },
      { start: 1.4, duration: 0.2 },
      { start: 2.6, duration: 1.4 },
    ],
    [join(project, 'media', 'p2.mp4')]: [{ start: 0, duration: 0.3 }],
  }
}

describe('drama_render subtitles', () => {
  it('writes measured cue times from each shot\'s own audio', async () => {
    const { project, shots, plan, subtitle } = await cueProject({ shots: [
      { shot: 1, lines: ['第一句', '第二句'] },
      { shot: 2, lines: ['第三句'] },
    ] })
    const stub = stubChannel([cueProbes(project), silenceHandler(cueGaps(project))])
    const report = await runDramaRender({
      method: 'subtitles', project, episode: 2, shots, lines: plan, subtitleSrt: subtitle,
    }, settingsWith(stub.channel))

    expect(report.method).toBe('subtitles')
    expect(report.ok).toBe(true)
    expect(report.written).toEqual([subtitle])
    expect(report.failures).toEqual([])
    expect(report.not_checked).not.toContain('speech_alignment')
    expect(await readFile(subtitle, 'utf8')).toBe([
      '1', '00:00:00,400 --> 00:00:01,400', '第一句', '',
      '2', '00:00:01,600 --> 00:00:02,600', '第二句', '',
      '3', '00:00:04,300 --> 00:00:06,000', '第三句', '',
    ].join('\n'))
  })

  it('reports a line that shares one stretch instead of pretending it measured it', async () => {
    const { project, shots, plan, subtitle } = await cueProject({ shots: [
      { shot: 1, lines: ['第一句', '第二句'] },
      { shot: 2, lines: ['第三句'] },
    ] })
    const stub = stubChannel([cueProbes(project), silenceHandler({
      [join(project, 'media', 'p1.mp4')]: [{ start: 0, duration: 1 }, { start: 3.2, duration: 0.8 }],
      [join(project, 'media', 'p2.mp4')]: [{ start: 0, duration: 0.3 }],
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
    const stub = stubChannel([cueProbes(project), silenceHandler({
      ...cueGaps(project),
      [join(project, 'media', 'p2.mp4')]: [{ start: 0, duration: 2 }],
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
    const stub = stubChannel([cueProbes(project), silenceHandler(cueGaps(project))])
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
    const stub = stubChannel([cueProbes(project), silenceHandler(cueGaps(project))])
    const report = await runDramaRender({
      method: 'subtitles', project, episode: 2, shots, lines: plan, subtitleSrt: subtitle,
    }, settingsWith(stub.channel))

    expect(report.ok).toBe(false)
    expect(report.failures.join('\n')).toContain('不在成片清单里')
  })
})
