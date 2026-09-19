/** `render`: the encode pipeline, its cache, its log, and the delivery verdict it returns. */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createMediaToolkit } from '../src/ffmpeg.ts'
import { episodePaths } from '../src/paths.ts'
import { renderEpisode } from '../src/render.ts'
import type { RenderSettings } from '../src/types.ts'
import {
  cleanup,
  framemd5Line,
  probeHandler,
  sizeOf,
  srtDocument,
  stubChannel,
  tempProject,
  timelineJson,
  writePlaceholder,
  type StubHandler,
} from './harness.ts'

const temporary: string[] = []

afterEach(async () => {
  await Promise.all(temporary.splice(0).map(async (dir) => { await cleanup(dir) }))
})

/** The deployment-varying settings every render test runs with. */
const settings: RenderSettings = {
  ffmpeg: 'ffmpeg',
  ffprobe: 'ffprobe',
  masterVolume: 1.45,
  bgmVolume: 0.24,
  preferNvenc: true,
  fontsDir: 'C:/Windows/Fonts',
}

/** A prepared project: two shots, a master, a timeline, and a subtitle. */
interface Prepared {
  readonly project: string
  readonly paths: ReturnType<typeof episodePaths>
  readonly timeline: string
  readonly subtitle: string
  readonly bgm: string
  readonly endingAudio: string
  readonly endingEffect: string
  readonly output: string
}

/** Lay out everything a render reads, exactly as `prepare` would have. */
async function preparedProject(): Promise<Prepared> {
  const project = await tempProject()
  temporary.push(project)
  const paths = episodePaths(project, '02')
  await writePlaceholder(join(paths.videoDir, 'shot_001.mp4'), 'shot one')
  await writePlaceholder(join(paths.videoDir, 'shot_002.mp4'), 'shot two')
  await writePlaceholder(paths.masterAudio, 'master')
  const timeline = join(project, 'editing', '02-timeline.json')
  await writePlaceholder(timeline, timelineJson([
    { shot: 1, startUs: 0, durationUs: 5_050_000 },
    { shot: 2, startUs: 5_050_000, durationUs: 109_683_332 },
  ], 114.733332))
  const subtitle = join(project, 'editing', '02.srt')
  await writePlaceholder(subtitle, srtDocument([{ start: '00:00:01,680', end: '00:00:03,580', text: '台词' }]))
  const bgm = join(project, 'audio', 'bgm.mp3')
  const endingAudio = join(project, 'audio', 'ending_audio.mp3')
  const endingEffect = join(project, 'assets', 'ending_effect.mp4')
  await writePlaceholder(bgm, 'bgm')
  await writePlaceholder(endingAudio, 'ending sound')
  await writePlaceholder(endingEffect, 'ending effect')
  return { project, paths, timeline, subtitle, bgm, endingAudio, endingEffect, output: join(project, 'export', 'ep02.mp4') }
}

/**
 * Build the channel a full render talks to.
 * @param prepared - The project the render reads and writes.
 * @param options - Whether the GPU probe succeeds, and the delivered file's measured facts.
 * @returns The stub channel and its recorded calls.
 */
function renderChannel(prepared: Prepared, options: {
  gpu?: boolean
  durationSeconds?: number
  bitRateBps?: number
  seekWrites?: boolean
  imageHashes?: readonly string[]
  videoHashes?: readonly string[]
  deliveredHasStreams?: boolean
} = {}): ReturnType<typeof stubChannel> {
  const queued = [...(options.imageHashes ?? ['tail'])]
  const handlers: StubHandler[] = [
    probeHandler({
      [prepared.output]: {
        durationSeconds: options.durationSeconds ?? 116.733332,
        sizeBytes: 400_000_000,
        bitRateBps: options.bitRateBps ?? 27_000_000,
        video: options.deliveredHasStreams === false ? undefined : {},
        audio: options.deliveredHasStreams === false ? false : {},
      },
    }),
    call => (call.args.includes('lavfi') ? { code: options.gpu === false ? 1 : 0, stderr: 'Cannot load nvcuda.dll' } : undefined),
    (call) => {
      if (!call.args.includes('-sseof')) return undefined
      if (options.seekWrites === false) return {}
      return { after: async () => { await writePlaceholder(call.args[call.args.length - 1] ?? '', 'png') } }
    },
    (call) => {
      if (!call.args.includes('framemd5')) return undefined
      const input = call.args[call.args.indexOf('-i') + 1] ?? ''
      if (input.endsWith('.png')) {
        const hash = queued.shift() ?? 'tail'
        return { stdout: `${framemd5Line(0, hash)}\n` }
      }
      return { stdout: `${(options.videoHashes ?? ['a', 'tail']).map((hash, index) => framemd5Line(index, hash)).join('\n')}\n` }
    },
    call => ({ after: async () => { await writePlaceholder(call.args[call.args.length - 1] ?? '', 'media') } }),
  ]
  return stubChannel(handlers)
}

/** Build the toolkit a render uses over a stub channel. */
function toolkit(channel: ReturnType<typeof stubChannel>) {
  return createMediaToolkit({ ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', channel: channel.channel })
}

/** Run one full render. */
async function render(prepared: Prepared, channel: ReturnType<typeof stubChannel>, force = false) {
  return await renderEpisode({
    toolkit: toolkit(channel),
    settings,
    project: prepared.project,
    episode: '02',
    timelinePath: prepared.timeline,
    subtitleSrt: prepared.subtitle,
    lastShot: 2,
    bgm: prepared.bgm,
    endingAudio: prepared.endingAudio,
    endingEffect: prepared.endingEffect,
    output: prepared.output,
    force,
  })
}

describe('renderEpisode', () => {
  it('encodes every body clip, rebuilds the ending, burns the subtitle, and reports the delivery', async () => {
    const prepared = await preparedProject()
    const channel = renderChannel(prepared)
    const report = await render(prepared, channel)

    expect(report.ok).toBe(true)
    expect(report.encoder).toBe('h264_nvenc')
    expect(report.gpu_requested).toBe(true)
    expect(report.gpu_used).toBe(true)
    expect(report.encoder_fallback_reason).toBe('')
    expect(report.encoded_shots).toEqual([1, 2])
    expect(report.reused_shots).toEqual([])
    expect(report.tail_frame).toEqual({
      path: join(prepared.paths.cacheDir, 'last_video_tail_frame.png'),
      frame_md5: 'tail',
      sequential_tail_md5: 'tail',
      from_sequential_decode: false,
      matches_sequential_tail: true,
    })
    expect(report.media.duration_seconds).toBe(116.733332)
    expect(report.media.bitrate_bps).toBe(27_000_000)
    expect(report.body_end_seconds).toBe(114.733332)
    expect(report.expected_duration_seconds).toBe(116.733332)
    expect(report.clips).toEqual([
      { shot: 1, source: join(prepared.paths.videoDir, 'shot_001.mp4'), start_us: 0, duration_us: 5_050_000 },
      { shot: 2, source: join(prepared.paths.videoDir, 'shot_002.mp4'), start_us: 5_050_000, duration_us: 109_683_332 },
    ])
    expect(report.written).toEqual([prepared.output, prepared.paths.renderLog])
    expect(report.log_path).toBe(prepared.paths.renderLog)
    expect(report.failures).toEqual([])
    expect(await sizeOf(prepared.output)).toBe(5)

    const log = await readFile(prepared.paths.renderLog, 'utf8')
    expect(log).toContain('encoder=h264_nvenc gpu_requested=true gpu_used=true')
    expect(log).toContain('encoder_fallback_reason=(none)')
    expect(log).toContain('encoded_shots=1,2 reused_shots=(none)')
    expect(log).toContain('check duration ok')
    expect(log).toContain(`output=${prepared.output}`)

    const concat = await readFile(join(prepared.paths.cacheDir, 'concat.txt'), 'utf8')
    expect(concat).toBe([
      `file '${join(prepared.paths.cacheDir, 'shot_001.mp4').split('\\').join('/')}'`,
      `file '${join(prepared.paths.cacheDir, 'shot_002.mp4').split('\\').join('/')}'`,
      `file '${join(prepared.paths.cacheDir, 'ending.mp4').split('\\').join('/')}'`,
      '',
    ].join('\n'))

    const burn = channel.calls.find(call => call.args.includes('-vf')
      && (call.args[call.args.indexOf('-vf') + 1] ?? '').startsWith('scale=2880'))
    const burnFilter = burn?.args[burn.args.indexOf('-vf') + 1] ?? ''
    const escapedAss = join(prepared.paths.cacheDir, 'display.ass').split('\\').join('/').replace(/:/g, '\\:')
    expect(burnFilter).toContain(`ass='${escapedAss}'`)
    expect(burnFilter).toContain("fontsdir='C\\:/Windows/Fonts'")
    expect(await readFile(join(prepared.paths.cacheDir, 'display.ass'), 'utf8')).toContain('内容由AI生成')

    const mux = channel.calls.find(call => call.args.includes('+faststart'))
    expect(mux?.args.slice(0, 4)).toEqual(['-y', '-v', 'error', '-i'])
    expect(mux?.args[mux.args.indexOf('-filter_complex') + 1] ?? '')
      .toContain('alimiter=limit=0.95:level=false[a]')
    expect(mux?.args).toContain('+faststart')
    expect(mux?.args.at(-1)).toBe(prepared.output)
  })

  it('records the GPU probe failure and reports the CPU encoder it fell back to', async () => {
    const prepared = await preparedProject()
    const report = await render(prepared, renderChannel(prepared, { gpu: false }))
    expect(report.encoder).toBe('libx264')
    expect(report.gpu_used).toBe(false)
    expect(report.encoder_fallback_reason).toBe('h264_nvenc 探测失败（退出码 1）：Cannot load nvcuda.dll')
    expect(await readFile(prepared.paths.renderLog, 'utf8')).toContain('Cannot load nvcuda.dll')
  })

  it('reuses the cached clips on a second run and re-encodes them when forced', async () => {
    const prepared = await preparedProject()
    const first = await render(prepared, renderChannel(prepared))
    expect(first.encoded_shots).toEqual([1, 2])

    const second = await render(prepared, renderChannel(prepared))
    expect(second.reused_shots).toEqual([1, 2])
    expect(second.encoded_shots).toEqual([])
    expect(second.summary).toEqual({ shots: 2, encoded: 0, reused: 2, checks: 5, failed_checks: 0, warnings: 0 })

    const forced = await render(prepared, renderChannel(prepared), true)
    expect(forced.encoded_shots).toEqual([1, 2])
    expect(forced.reused_shots).toEqual([])
  })

  it('reports a delivery below the bitrate floor instead of refusing to hand it back', async () => {
    const prepared = await preparedProject()
    const report = await render(prepared, renderChannel(prepared, { bitRateBps: 4_000_000 }))
    expect(report.ok).toBe(false)
    expect(report.failures).toHaveLength(1)
    expect(report.failures[0]).toContain('bitrate_floor')
    expect(report.failures[0]).toContain('修法：')
    expect(report.output).toBe(prepared.output)
    expect(report.summary.failed_checks).toBe(1)
  })

  it('reports zeroes when the delivered file turns out to have no stream at all', async () => {
    const prepared = await preparedProject()
    const report = await render(prepared, renderChannel(prepared, { deliveredHasStreams: false }))
    expect(report.media).toEqual({
      duration_seconds: 116.733332,
      size_bytes: 400_000_000,
      bitrate_bps: 27_000_000,
      video_codec: '',
      width: 0,
      height: 0,
      fps: 0,
      has_audio: false,
      audio_codec: '',
      audio_sample_rate: 0,
    })
    expect(report.ok).toBe(false)
    expect(report.failures.map(failure => failure.split(':')[0]))
      .toEqual(['video_stream', 'frame_rate', 'audio_stream'])
  })

  it('warns when the seeked frame had to be replaced by a sequential decode', async () => {
    const prepared = await preparedProject()
    const report = await render(prepared, renderChannel(prepared, { imageHashes: ['wrong', 'tail'] }))
    expect(report.ok).toBe(true)
    expect(report.tail_frame.from_sequential_decode).toBe(true)
    expect(report.warnings[0]).toContain('已改用顺序解码的最后一帧')
    expect(report.summary.warnings).toBe(1)
  })

  it('fails loud when the episode master is missing', async () => {
    const prepared = await preparedProject()
    await writePlaceholder(prepared.paths.masterAudio, '')
    await expect(render(prepared, renderChannel(prepared))).rejects.toThrow('整集原声 master是空文件')
  })

  it('fails loud when a shot was never prepared', async () => {
    const prepared = await preparedProject()
    const channel = renderChannel(prepared)
    await expect(renderEpisode({
      toolkit: toolkit(channel),
      settings,
      project: prepared.project,
      episode: '02',
      timelinePath: prepared.timeline,
      subtitleSrt: prepared.subtitle,
      lastShot: 3,
      bgm: prepared.bgm,
      endingAudio: prepared.endingAudio,
      endingEffect: prepared.endingEffect,
      output: prepared.output,
      force: false,
    })).rejects.toThrow('时间线里 shot <= 3 的镜头有 2 个')
  })

  it('fails loud when the BGM is missing', async () => {
    const prepared = await preparedProject()
    await expect(renderEpisode({
      toolkit: toolkit(renderChannel(prepared)),
      settings,
      project: prepared.project,
      episode: '02',
      timelinePath: prepared.timeline,
      subtitleSrt: prepared.subtitle,
      lastShot: 2,
      bgm: join(prepared.project, 'audio', 'absent.mp3'),
      endingAudio: prepared.endingAudio,
      endingEffect: prepared.endingEffect,
      output: prepared.output,
      force: false,
    })).rejects.toThrow('BGM不存在或不可读')
  })

  it('fails loud when the ending sound is missing', async () => {
    const prepared = await preparedProject()
    await expect(renderEpisode({
      toolkit: toolkit(renderChannel(prepared)),
      settings,
      project: prepared.project,
      episode: '02',
      timelinePath: prepared.timeline,
      subtitleSrt: prepared.subtitle,
      lastShot: 2,
      bgm: prepared.bgm,
      endingAudio: join(prepared.project, 'audio', 'absent.mp3'),
      endingEffect: prepared.endingEffect,
      output: prepared.output,
      force: false,
    })).rejects.toThrow('片尾音不存在或不可读')
  })

  it('fails loud when the ending effect is missing', async () => {
    const prepared = await preparedProject()
    await expect(renderEpisode({
      toolkit: toolkit(renderChannel(prepared)),
      settings,
      project: prepared.project,
      episode: '02',
      timelinePath: prepared.timeline,
      subtitleSrt: prepared.subtitle,
      lastShot: 2,
      bgm: prepared.bgm,
      endingAudio: prepared.endingAudio,
      endingEffect: join(prepared.project, 'assets', 'absent.mp4'),
      output: prepared.output,
      force: false,
    })).rejects.toThrow('片尾特效不存在或不可读')
  })

  it('fails loud when the timeline file does not exist', async () => {
    const prepared = await preparedProject()
    await expect(renderEpisode({
      toolkit: toolkit(renderChannel(prepared)),
      settings,
      project: prepared.project,
      episode: '02',
      timelinePath: join(prepared.project, 'editing', 'absent.json'),
      subtitleSrt: prepared.subtitle,
      lastShot: 2,
      bgm: prepared.bgm,
      endingAudio: prepared.endingAudio,
      endingEffect: prepared.endingEffect,
      output: prepared.output,
      force: false,
    })).rejects.toThrow()
  })

  it('stops when the tail frame cannot be proved', async () => {
    const prepared = await preparedProject()
    await expect(render(prepared, renderChannel(prepared, { seekWrites: false })))
      .rejects.toThrow('尾帧抽取没有写出任何文件')
  })
})
