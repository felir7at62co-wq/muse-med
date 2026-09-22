/** `verify`: the delivery verdict, the two detection passes, and the subtitle bounds. */

import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { fileSha256 } from '../src/cache.ts'
import { provenancePathFor } from '../src/provenance.ts'
import { createMediaToolkit } from '../src/ffmpeg.ts'
import { NO_MEDIA } from '../src/report.ts'
import type { MediaFacts, SubtitleCue } from '../src/types.ts'
import {
  deliveryChecks,
  detectBlackSegments,
  detectSilenceSegments,
  parseBlackSegments,
  parseSilenceSegments,
  subtitleChecks,
  verifyEpisode,
} from '../src/verify.ts'
import { cleanup, probeHandler, srtDocument, stubChannel, tempProject, timelineJson, writePlaceholder, type StubHandler } from './harness.ts'

const temporary: string[] = []

afterEach(async () => {
  await Promise.all(temporary.splice(0).map(async (dir) => { await cleanup(dir) }))
})

/** Build a toolkit over a stub channel. */
function toolkit(handlers: readonly StubHandler[]) {
  return createMediaToolkit({ ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', channel: stubChannel(handlers).channel })
}

/** The delivered file's measured facts, all inside the delivery specification. */
function goodMedia(overrides: Partial<MediaFacts> = {}): MediaFacts {
  return {
    durationSeconds: 116.733332,
    sizeBytes: 400_000_000,
    bitrateBps: 27_000_000,
    videoCodec: 'h264',
    width: 1440,
    height: 2560,
    fps: 60,
    hasAudio: true,
    audioCodec: 'aac',
    audioSampleRate: 48_000,
    ...overrides,
  }
}

/** One cue at the given boundaries. */
function cue(index: number, startSeconds: number, endSeconds: number): SubtitleCue {
  return { index, startSeconds, endSeconds, text: '台词' }
}

/** The blackdetect log for one closed stretch. */
function blackLog(start: number, end: number, duration: number): string {
  return `[blackdetect @ 0x1] black_start:${String(start)} black_end:${String(end)} black_duration:${String(duration)}\n`
}

describe('deliveryChecks', () => {
  it('passes a delivery that meets the specification', () => {
    const checks = deliveryChecks(goodMedia(), 116.733332)
    expect(checks.map(check => check.id)).toEqual(['duration', 'video_stream', 'frame_rate', 'audio_stream', 'bitrate_floor'])
    expect(checks.every(check => check.ok)).toBe(true)
    expect(checks.every(check => check.fix === '')).toBe(true)
    expect(checks[0]?.detail).toBe('实测 116.733332s，应为 116.733332s，差 0.000000s')
  })

  it('fails a duration that drifts past the tolerance', () => {
    const [duration] = deliveryChecks(goodMedia(), 116)
    expect(duration?.ok).toBe(false)
    expect(duration?.fix).toContain('重跑 render')
  })

  it('fails a picture outside the delivery geometry', () => {
    const [, geometry] = deliveryChecks(goodMedia({ width: 1080, height: 1920 }), 116.733332)
    expect(geometry?.ok).toBe(false)
    expect(geometry?.detail).toBe('实测 1080x1920 h264')
  })

  it('fails a non-H.264 delivery', () => {
    const [, geometry] = deliveryChecks(goodMedia({ videoCodec: 'hevc' }), 116.733332)
    expect(geometry?.ok).toBe(false)
  })

  it('fails a frame rate outside the delivery rate', () => {
    const [, , fps] = deliveryChecks(goodMedia({ fps: 30 }), 116.733332)
    expect(fps?.ok).toBe(false)
    expect(fps?.fix).toContain('fps=60')
  })

  it('fails a delivery with no audio stream', () => {
    const [, , , audio] = deliveryChecks(goodMedia({ hasAudio: false }), 116.733332)
    expect(audio?.ok).toBe(false)
    expect(audio?.detail).toBe('实测 音轨=缺失')
  })

  it('fails an audio track that is not 48 kHz AAC', () => {
    const [, , , audio] = deliveryChecks(goodMedia({ audioSampleRate: 32_000 }), 116.733332)
    expect(audio?.ok).toBe(false)
    expect(audio?.detail).toBe('实测 音轨=aac 32000Hz')
  })

  it('fails a delivery below the bitrate floor', () => {
    const [, , , , bitrate] = deliveryChecks(goodMedia({ bitrateBps: 4_000_000 }), 116.733332)
    expect(bitrate?.ok).toBe(false)
    expect(bitrate?.detail).toBe('实测 4.000 Mbps，下限 4.6 Mbps')
  })
})

describe('parseBlackSegments', () => {
  it('reads a closed stretch', () => {
    expect(parseBlackSegments(blackLog(0, 2.5, 2.5), 100)).toEqual([{ startSeconds: 0, durationSeconds: 2.5 }])
  })

  it('closes a stretch that is still black when the file ends', () => {
    expect(parseBlackSegments('[blackdetect @ 0x1] black_start:98.5\n', 100))
      .toEqual([{ startSeconds: 98.5, durationSeconds: 1.5 }])
  })

  it('reports nothing for a log without black frames', () => {
    expect(parseBlackSegments('frame= 840 fps=60\n', 100)).toEqual([])
  })
})

describe('parseSilenceSegments', () => {
  it('pairs a start line with its duration line', () => {
    const log = '[silencedetect @ 0x1] silence_start: 0\n'
      + '[silencedetect @ 0x1] silence_end: 4.5 | silence_duration: 4.5\n'
    expect(parseSilenceSegments(log, 100)).toEqual([{ startSeconds: 0, durationSeconds: 4.5 }])
  })

  it('closes a stretch the file never ends', () => {
    expect(parseSilenceSegments('[silencedetect @ 0x1] silence_start: 97\n', 100))
      .toEqual([{ startSeconds: 97, durationSeconds: 3 }])
  })

  it('ignores a duration line that follows no start', () => {
    expect(parseSilenceSegments('[silencedetect @ 0x1] silence_end: 4 | silence_duration: 4\n', 100)).toEqual([])
  })

  it('reports nothing for a log without silence', () => {
    expect(parseSilenceSegments('size=N/A time=00:01:56.73\n', 100)).toEqual([])
  })
})

describe('detectBlackSegments', () => {
  it('runs the detection pass and reads its log', async () => {
    const channel = stubChannel([() => ({ stderr: blackLog(10, 12, 2) })])
    const segments = await detectBlackSegments(
      createMediaToolkit({ ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', channel: channel.channel }), 'out.mp4', 116)
    expect(segments).toEqual([{ startSeconds: 10, durationSeconds: 2 }])
    expect(channel.calls[0]?.args).toEqual([
      '-v', 'info', '-i', 'out.mp4', '-vf', 'blackdetect=d=0.1:pix_th=0.1', '-an', '-f', 'null', '-',
    ])
  })

  it('fails loud when the detection pass itself fails', async () => {
    await expect(detectBlackSegments(toolkit([() => ({ code: 1, stderr: 'Invalid data' })]), 'out.mp4', 116))
      .rejects.toThrow('黑帧检测失败')
  })
})

describe('detectSilenceSegments', () => {
  it('runs the detection pass and reads its log', async () => {
    const channel = stubChannel([() => ({ stderr: '[silencedetect @ 0x1] silence_end: 4 | silence_duration: 4\n' })])
    const segments = await detectSilenceSegments(
      createMediaToolkit({ ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', channel: channel.channel }), 'out.mp4', 116)
    expect(segments).toEqual([])
    expect(channel.calls[0]?.args).toEqual([
      '-v', 'info', '-i', 'out.mp4', '-af', 'silencedetect=noise=-50dB:d=1', '-vn', '-f', 'null', '-',
    ])
  })

  it('fails loud when the detection pass itself fails', async () => {
    await expect(detectSilenceSegments(toolkit([() => ({ code: 1, stderr: 'Invalid data' })]), 'out.mp4', 116))
      .rejects.toThrow('静音检测失败')
  })
})

describe('subtitleChecks', () => {
  it('accepts cues inside the picture and reports an empty subtitle as a warning', () => {
    const [bounds, present] = subtitleChecks([cue(1, 1, 2)], 114.733332, 116.733332)
    expect(bounds?.ok).toBe(true)
    expect(bounds?.detail).toBe('1 条字幕都在 0–114.733s 之内')
    expect(present?.severity).toBe('warning')
    expect(present?.ok).toBe(true)

    const [emptyBounds, emptyPresent] = subtitleChecks([], 114.733332, 116.733332)
    expect(emptyBounds?.ok).toBe(true)
    expect(emptyBounds?.detail).toBe('0 条字幕都在 0–114.733s 之内')
    expect(emptyPresent?.ok).toBe(false)
    expect(emptyPresent?.fix).toContain('没有任何 cue')
  })

  it('fails a cue that runs into the ending', () => {
    const [bounds] = subtitleChecks([cue(2, 114, 115.5)], 114.733332, 116.733332)
    expect(bounds?.ok).toBe(false)
    expect(bounds?.detail).toBe('第 2 条 114.000–115.500s')
    expect(bounds?.fix).toContain('body_end')
  })

  it('fails a cue that ends after the delivered file', () => {
    const [bounds] = subtitleChecks([cue(1, 1, 2)], 1, 1.5)
    expect(bounds?.ok).toBe(false)
  })

  it('fails a cue with a negative start', () => {
    const [bounds] = subtitleChecks([cue(1, -1, 2)], 114.733332, 116.733332)
    expect(bounds?.ok).toBe(false)
  })

  it('fails a cue whose end precedes its start', () => {
    const [bounds] = subtitleChecks([cue(1, 5, 4)], 114.733332, 116.733332)
    expect(bounds?.ok).toBe(false)
  })
})

describe('NO_MEDIA', () => {
  it('is the empty measurement every non-measuring method reports', () => {
    expect(NO_MEDIA).toEqual({
      durationSeconds: 0, sizeBytes: 0, bitrateBps: 0, videoCodec: '', width: 0, height: 0, fps: 0,
      hasAudio: false, audioCodec: '', audioSampleRate: 0,
    })
  })
})

describe('verifyEpisode', () => {
  /** Build a delivered file plus the timeline and subtitle that describe it. */
  async function delivered(): Promise<{ project: string; output: string; timeline: string; subtitle: string }> {
    const project = await tempProject()
    temporary.push(project)
    const output = join(project, 'export', 'ep02.mp4')
    const timeline = join(project, 'editing', '02-timeline.json')
    const subtitle = join(project, 'editing', '02.srt')
    await writePlaceholder(output, 'delivered')
    await writePlaceholder(timeline, timelineJson([
      { shot: 1, startUs: 0, durationUs: 5_050_000 },
      { shot: 2, startUs: 5_050_000, durationUs: 109_683_332 },
    ], 114.733332))
    await writePlaceholder(subtitle, srtDocument([{ start: '00:00:01,680', end: '00:00:03,580', text: '台词' }]))
    // A delivery normally carries the record its render wrote; without it every check
    // below is answering about a file nobody can prove was the one reviewed.
    await writePlaceholder(provenancePathFor(output), JSON.stringify({
      version: 1, episode: '02', rendered_at: new Date().toISOString(),
      output: { path: output, sha256: await fileSha256(output), size_bytes: 9,
        duration_seconds: 116.733332 },
      inputs: ['sha256:shot-1'], encoder: 'libx264', checks: [],
    }))
    return { project, output, timeline, subtitle }
  }

  it('warns when the delivery carries no record of what was rendered and checked', async () => {
    const files = await delivered()
    await rm(provenancePathFor(files.output))
    const report = await verifyEpisode({
      toolkit: toolkit([probeHandler({ [files.output]: { durationSeconds: 116.733332, video: {}, audio: {} } }), () => ({})]),
      settings: { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', masterVolume: 1.45, bgmVolume: 0.24, preferNvenc: true, fontsDir: '' },
      project: files.project, episode: '02', output: files.output, timelinePath: files.timeline, subtitleSrt: files.subtitle,
    })
    const check = report.checks.find(item => item.id === 'output_provenance')
    expect(check?.ok).toBe(false)
    expect(check?.detail).toContain('没有来源清单')
    expect(report.warnings.join(' ')).toContain('无法证明当前文件就是当初检查过的那个')
  })

  it('fails a delivery whose bytes changed after its record was written', async () => {
    const files = await delivered()
    // The same path now holds different bytes. Every technical check below still
    // passes, so only the digest comparison can say that the review is stale.
    await writePlaceholder(files.output, 'replaced after the record')
    const report = await verifyEpisode({
      toolkit: toolkit([probeHandler({ [files.output]: { durationSeconds: 116.733332, video: {}, audio: {} } }), () => ({})]),
      settings: { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', masterVolume: 1.45, bgmVolume: 0.24, preferNvenc: true, fontsDir: '' },
      project: files.project, episode: '02', output: files.output, timelinePath: files.timeline, subtitleSrt: files.subtitle,
    })
    const check = report.checks.find(item => item.id === 'output_provenance')
    expect(check?.ok).toBe(false)
    expect(report.failures.join(' ')).toContain('output_provenance')
    expect(report.failures.join(' ')).toContain('已经被换过')
  })

  it('reports banned copied selections without claiming historical output identity or deleting output', async () => {
    const files = await delivered()
    const { runDramaVideo } = await import('../src/video.ts')
    const source = join(files.project, 'video', '02', 'shot_001.mp4')
    await writePlaceholder(source, 'banned copy')
    await runDramaVideo({ method: 'ban', project: files.project, video: source, labels: ['人物对调'], reason: '用户明确禁用' })
    const report = await verifyEpisode({
      toolkit: toolkit([probeHandler({ [files.output]: { durationSeconds: 116.733332, video: {}, audio: {} } }), () => ({})]),
      settings: { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', masterVolume: 1.45, bgmVolume: 0.24, preferNvenc: true, fontsDir: '' },
      project: files.project, episode: '02', output: files.output, timelinePath: files.timeline, subtitleSrt: files.subtitle,
    })
    expect(report.ok).toBe(false)
    const banCheck = report.checks.find(check => check.id === 'video_bans')
    expect(banCheck?.ok).toBe(false)
    expect(banCheck?.detail).toContain('当前选片含禁用素材')
    expect(report.failures.join(' ')).toContain('人物对调')
    expect(report.not_checked).toContain('output_source_mapping')
    expect(report.written).toEqual([])
    expect(await readFile(files.output, 'utf8')).toBe('delivered')
  })

  it('reports every check and passes a delivery that meets the specification', async () => {
    const files = await delivered()
    const report = await verifyEpisode({
      toolkit: toolkit([
        probeHandler({
          [files.output]: {
            durationSeconds: 116.733332, sizeBytes: 400_000_000, bitRateBps: 27_000_000, video: {}, audio: {},
          },
        }),
        () => ({ stderr: '' }),
      ]),
      settings: { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', masterVolume: 1.45, bgmVolume: 0.24, preferNvenc: true, fontsDir: 'C:/Windows/Fonts' },
      project: files.project,
      episode: '02',
      output: files.output,
      timelinePath: files.timeline,
      subtitleSrt: files.subtitle,
    })
    expect(report.ok).toBe(true)
    expect(report.checks.map(check => check.id)).toEqual([
      'duration', 'video_stream', 'frame_rate', 'audio_stream', 'bitrate_floor',
      'black_frames', 'fade_to_black', 'silence', 'long_pauses', 'subtitle_bounds', 'subtitle_present',
      'output_provenance',
    ])
    expect(report.failures).toEqual([])
    expect(report.warnings).toEqual([])
    expect(report.clips.map(clip => clip.source)).toEqual(['', ''])
    expect(report.clips[0]).toMatchObject({ shot: 1, start_us: 0, duration_us: 5_050_000 })
    expect(report.body_end_seconds).toBe(114.733332)
    expect(report.expected_duration_seconds).toBe(116.733332)
    expect(report.media).toEqual({
      duration_seconds: 116.733332,
      size_bytes: 400_000_000,
      bitrate_bps: 27_000_000,
      video_codec: 'h264',
      width: 1440,
      height: 2560,
      fps: 60,
      has_audio: true,
      audio_codec: 'aac',
      audio_sample_rate: 48000,
    })
    expect(report.summary).toEqual({ shots: 2, encoded: 0, reused: 0, checks: 12, failed_checks: 0, warnings: 0 })
    expect(report.written).toEqual([])
    expect(report.log_path).toBe('')
  })

  it('reports a black hole, a silent stretch, and a cue past the picture with their repairs', async () => {
    const files = await delivered()
    await writePlaceholder(files.subtitle, srtDocument([{ start: '00:01:54,000', end: '00:01:56,000', text: '越界' }]))
    const report = await verifyEpisode({
      toolkit: toolkit([
        probeHandler({ [files.output]: { durationSeconds: 100, sizeBytes: 1, bitRateBps: 1_000_000, video: { width: 1080, height: 1920, fps: 30 }, audio: { codec: 'mp3', sampleRate: 44100 } } }),
        call => (call.args.some(argument => argument.startsWith('blackdetect'))
          ? { stderr: blackLog(10, 12, 2) }
          : { stderr: '[silencedetect @ 0x1] silence_start: 0\n[silencedetect @ 0x1] silence_end: 5 | silence_duration: 5\n' }),
      ]),
      settings: { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', masterVolume: 1.45, bgmVolume: 0.24, preferNvenc: true, fontsDir: 'C:/Windows/Fonts' },
      project: files.project,
      episode: '02',
      output: files.output,
      timelinePath: files.timeline,
      subtitleSrt: files.subtitle,
    })
    expect(report.ok).toBe(false)
    expect(report.failures.map(failure => failure.split(':')[0])).toEqual([
      'duration', 'video_stream', 'frame_rate', 'audio_stream', 'bitrate_floor', 'black_frames', 'silence', 'subtitle_bounds',
    ])
    expect(report.checks.find(check => check.id === 'black_frames')?.detail).toBe('10.000s 起持续 2.000s')
    expect(report.checks.find(check => check.id === 'silence')?.detail).toBe('0.000s 起持续 5.000s')
    expect(report.checks.find(check => check.id === 'subtitle_bounds')?.detail).toBe('第 1 条 114.000–116.000s')
    expect(report.checks.find(check => check.id === 'fade_to_black')?.ok).toBe(false)
    expect(report.checks.find(check => check.id === 'long_pauses')?.ok).toBe(false)
  })

  it('reports a file with no video and no audio stream at all', async () => {
    const files = await delivered()
    const report = await verifyEpisode({
      toolkit: toolkit([
        probeHandler({ [files.output]: { durationSeconds: 0, sizeBytes: 0, bitRateBps: 0, video: undefined, audio: false } }),
        () => ({ stderr: '' }),
      ]),
      settings: { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', masterVolume: 1.45, bgmVolume: 0.24, preferNvenc: true, fontsDir: 'C:/Windows/Fonts' },
      project: files.project,
      episode: '02',
      output: files.output,
      timelinePath: files.timeline,
      subtitleSrt: files.subtitle,
    })
    expect(report.media).toEqual({
      duration_seconds: 0,
      size_bytes: 0,
      bitrate_bps: 0,
      video_codec: '',
      width: 0,
      height: 0,
      fps: 0,
      has_audio: false,
      audio_codec: '',
      audio_sample_rate: 0,
    })
    expect(report.ok).toBe(false)
    expect(report.failures.map(failure => failure.split(':')[0])).toContain('video_stream')
  })
})
