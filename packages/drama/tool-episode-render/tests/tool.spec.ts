/** The plugin entry: its registration, its argument resolution, and one call per method. */

import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { apply, Config, inject, name, resolveCall, resolveSettings, runDramaRender } from '../src/index.ts'
import type { DramaRenderReport, ProcessChannel, RenderSettings } from '../src/types.ts'
import {
  cleanup,
  framemd5Line,
  probeHandler,
  runContext,
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

/** Mount the plugin against a stub tool registry and return what it registered. */
function mount(config: Config = {}): ToolDefinition[] {
  const registered: ToolDefinition[] = []
  const ctx = {
    tools: {
      register: (definition: ToolDefinition) => {
        registered.push(definition)
        return () => {}
      },
    },
  } as unknown as Context
  apply(ctx, config)
  return registered
}

/** The one `drama_render` definition this package registers. */
function dramaRender(): ToolDefinition {
  const tool = mount().find(candidate => candidate.name === 'drama_render')
  if (tool === undefined) throw new Error('drama_render was not registered')
  return tool
}

/** Run one call with injected settings and validate it against the tool's own output schema. */
async function run(
  args: Parameters<typeof runDramaRender>[0],
  settings: RenderSettings,
): Promise<DramaRenderReport> {
  const tool = dramaRender()
  const value = await runDramaRender(args, settings)
  expect(validateJsonSchemaValue(tool.output.schema, value, '')).toEqual([])
  return value
}

/** The settings a test run resolves, with an injected channel. */
function settingsWith(channel: ProcessChannel): RenderSettings {
  return { ...resolveSettings({ ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe' }), channel }
}

/** A project prepared far enough for `render` and `verify` to run. */
async function preparedProject(): Promise<{
  project: string
  timeline: string
  subtitle: string
  bgm: string
  endingAudio: string
  endingEffect: string
  output: string
  shots: string
}> {
  const project = await tempProject()
  temporary.push(project)
  const shots = join(project, 'ep02-shots.json')
  await writePlaceholder(shots, JSON.stringify({ shots: [{ shot: 1, video: 'media/p1-clean.mp4' }] }))
  await writePlaceholder(join(project, 'media', 'p1-clean.mp4'), 'provider video')
  await writePlaceholder(join(project, 'origin', 'ep02.srt'),
    srtDocument([{ start: '00:00:01,680', end: '00:00:03,580', text: '台词' }]))
  await writePlaceholder(join(project, 'video', '02', 'shot_001.mp4'), 'shot one')
  await writePlaceholder(join(project, 'audio', '02.wav'), 'master')
  const timeline = join(project, 'editing', '02-timeline.json')
  await writePlaceholder(timeline, timelineJson([{ shot: 1, startUs: 0, durationUs: 114_733_332 }], 114.733332))
  const bgm = join(project, 'audio', 'bgm.mp3')
  const endingAudio = join(project, 'audio', 'ending_audio.mp3')
  const endingEffect = join(project, 'assets', 'ending_effect.mp4')
  await writePlaceholder(bgm, 'bgm')
  await writePlaceholder(endingAudio, 'ending sound')
  await writePlaceholder(endingEffect, 'ending effect')
  return {
    project,
    timeline,
    subtitle: join(project, 'origin', 'ep02.srt'),
    bgm,
    endingAudio,
    endingEffect,
    output: join(project, 'export', 'ep02.mp4'),
    shots,
  }
}

/**
 * Build the channel one whole call talks to.
 * @param project - The project root.
 * @returns The stub channel.
 */
function callChannel(project: string): ReturnType<typeof stubChannel> {
  const handlers: StubHandler[] = [
    probeHandler({
      [join(project, 'media', 'p1-clean.mp4')]: { durationSeconds: 114.733332, video: {}, audio: {} },
      [join(project, 'export', 'ep02.mp4')]: {
        durationSeconds: 116.733332, sizeBytes: 400_000_000, bitRateBps: 27_000_000, video: {}, audio: {},
      },
    }),
    call => (call.args.includes('lavfi') ? {} : undefined),
    call => (call.args.includes('-sseof') ? { after: async () => { await writePlaceholder(call.args.at(-1) ?? '', 'png') } } : undefined),
    call => (call.args.includes('framemd5') ? { stdout: `${framemd5Line(0, 'tail')}\n` } : undefined),
    call => ({ after: async () => { await writePlaceholder(call.args.at(-1) ?? '', 'media') } }),
  ]
  return stubChannel(handlers)
}

describe('registration', () => {
  it('declares its identity and the registry it needs', () => {
    expect(name).toBe('tool-episode-render')
    expect(inject).toEqual(['tools'])
  })

  it('registers exactly the drama_render tool with the delivery style and both known traps', () => {
    const tool = dramaRender()
    expect(tool.name).toBe('drama_render')
    for (const phrase of ['1440x2560@60', '24M', '30M', '48M', '4.6 Mbps', 'SimHei 68', '字间距 -2', '7px 黑描边',
      '内容由AI生成', '-sseof -0.1', 'framemd5', 'h264_nvenc', 'libx264', 'alimiter=0.95', '定格 2 秒']) {
      expect(tool.description).toContain(phrase)
    }
  })

  it('exposes the method enum and every path argument', () => {
    const parameters = dramaRender().parameters as {
      properties: Record<string, { enum?: string[] }>
      required: string[]
    }
    expect(Object.keys(parameters.properties).sort()).toEqual([
      'alignment', 'bgm', 'bgm_plan', 'ending_audio', 'ending_effect', 'episode', 'force', 'last_shot', 'lines',
      'method', 'output', 'project', 'shots', 'subtitle_srt', 'timeline',
    ])
    expect(parameters.properties.method?.enum).toEqual(['prepare', 'render', 'verify', 'subtitles'])
    expect(parameters.required.sort()).toEqual(['episode', 'method', 'project'])
  })

  it('maps a BGM plan through call resolution and returns only declared report fields', async () => {
    const prepared = await preparedProject()
    const plan = join(prepared.project, 'bgm-plan.json')
    await writePlaceholder(plan, JSON.stringify({ episodes: [{ episode: '02', body_duration_seconds: 114.733332,
      segments: [{ index: 1, track: 'song', source: prepared.bgm, start_seconds: 0, end_seconds: 114.733332, reason: 'scene' }],
    }] }))
    const report = await run({ method: 'render', ...prepared, episode: 2, subtitleSrt: prepared.subtitle,
      lastShot: 1, bgmPlan: plan }, settingsWith(callChannel(prepared.project).channel))
    expect(report.bgm_plan.path).toBe(plan)
    expect(report.bgm_plan.segments[0]).not.toHaveProperty('index')
  })

  it('renders the canonical value as pretty JSON', () => {
    const blocks = dramaRender().output.render({}, { ok: true }) as { type: string; text: string }[]
    expect(blocks).toHaveLength(1)
    expect(blocks[0]?.type).toBe('text')
    expect(blocks[0]?.text).toContain('"ok": true')
  })

  it.each(['prepare', 'render', 'verify'] as const)(
    'accepts public snake_case arguments for %s before reading inputs', async (method) => {
      const project = await tempProject()
      temporary.push(project)
      const missing = join(project, 'missing.json')
      const args = {
        method, project, episode: 1, shots: missing, timeline: missing,
        subtitle_srt: join(project, 'subtitles.srt'), last_shot: 1,
        bgm: join(project, 'bgm.wav'), ending_audio: join(project, 'ending.wav'),
        ending_effect: join(project, 'effect.mp4'), output: join(project, 'output.mp4'),
      }
      const tool = dramaRender()
      expect(validateJsonSchemaValue(tool.parameters, args, '')).toEqual([])
      await expect(tool.execute(args, runContext())).rejects.toMatchObject({ code: 'ENOENT', path: missing })
    },
  )

  it('fails a call through the registered executor when an argument is missing', async () => {
    await expect(dramaRender().execute({ method: 'verify', project: 'C:/proj', episode: 1 }, runContext()))
      .rejects.toThrow('drama_render verify 需要 timeline')
  })
})

describe('Config', () => {
  it('defaults every deployment-varying choice to the approved delivery', () => {
    const resolved = Config({}) as Required<Config>
    expect(resolved.ffmpegPath).toBe('ffmpeg')
    expect(resolved.ffprobePath).toBe('ffprobe')
    expect(resolved.masterVolume).toBe(1.45)
    expect(resolved.bgmVolume).toBe(0.24)
    expect(resolved.preferNvenc).toBe(true)
    expect(resolved.fontsDir).toBe('C:/Windows/Fonts')
  })

  it('rejects a gain outside the audible range', () => {
    expect(() => Config({ masterVolume: 12 })).toThrow()
  })
})

describe('resolveSettings', () => {
  it('uses the config values it was given', () => {
    expect(resolveSettings({
      ffmpegPath: 'D:/ffmpeg/bin/ffmpeg.exe',
      ffprobePath: 'D:/ffmpeg/bin/ffprobe.exe',
      masterVolume: 1.2,
      bgmVolume: 0.3,
      preferNvenc: false,
      fontsDir: 'D:/Fonts',
    })).toEqual({
      ffmpeg: 'D:/ffmpeg/bin/ffmpeg.exe',
      ffprobe: 'D:/ffmpeg/bin/ffprobe.exe',
      masterVolume: 1.2,
      bgmVolume: 0.3,
      preferNvenc: false,
      fontsDir: 'D:/Fonts',
    })
  })

  it('falls back to the approved defaults for every omitted field', () => {
    expect(resolveSettings()).toEqual({
      ffmpeg: 'ffmpeg',
      ffprobe: 'ffprobe',
      masterVolume: 1.45,
      bgmVolume: 0.24,
      preferNvenc: true,
      fontsDir: 'C:/Windows/Fonts',
    })
  })
})

describe('resolveCall', () => {
  it('resolves a prepare call and pads the episode number', () => {
    expect(resolveCall({
      method: 'prepare', project: 'C:/proj', episode: 2, shots: 'shots.json', subtitleSrt: 'ep02.srt',
    })).toEqual({
      method: 'prepare',
      project: resolve('C:/proj'),
      episode: '02',
      shotsPath: resolve('shots.json'),
      subtitleSrt: resolve('ep02.srt'),
    })
  })

  it('defaults a render call\u2019s output to the project\u2019s export path', () => {
    const call = resolveCall({
      method: 'render', project: 'C:/proj', episode: 2, timeline: 't.json', subtitleSrt: 's.srt',
      lastShot: 9, bgm: 'b.mp3', endingAudio: 'e.mp3', endingEffect: 'fx.mp4',
    })
    expect(call).toEqual({
      method: 'render',
      project: resolve('C:/proj'),
      episode: '02',
      timelinePath: resolve('t.json'),
      subtitleSrt: resolve('s.srt'),
      lastShot: 9,
      bgm: resolve('b.mp3'),
      endingAudio: resolve('e.mp3'),
      endingEffect: resolve('fx.mp4'),
      output: join(resolve('C:/proj'), 'exports', '02.mp4'),
      force: false,
    })
  })

  it('keeps an explicit render output and force flag', () => {
    const call = resolveCall({
      method: 'render', project: 'C:/proj', episode: 2, timeline: 't.json', subtitleSrt: 's.srt',
      lastShot: 9, bgm: 'b.mp3', endingAudio: 'e.mp3', endingEffect: 'fx.mp4',
      output: 'C:/out/final.mp4', force: true,
    })
    expect(call.method === 'render' ? call.output : '').toBe(resolve('C:/out/final.mp4'))
    expect(call.method === 'render' ? call.force : false).toBe(true)
  })

  it('resolves a verify call from the delivered file and its two inputs', () => {
    const call = resolveCall({
      method: 'verify', project: 'C:/proj', episode: 12, output: 'C:/out/final.mp4',
      timeline: 't.json', subtitleSrt: 's.srt',
    })
    expect(call.method).toBe('verify')
    expect(call.episode).toBe('12')
    expect(call.method === 'verify' ? call.output : '').toBe(resolve('C:/out/final.mp4'))
  })

  it('rejects a non-positive episode number before opening any file', () => {
    expect(() => resolveCall({ method: 'prepare', project: 'C:/proj', episode: 0, shots: 'a', subtitleSrt: 'b' }))
      .toThrow('episode 必须是正整数集号')
    expect(() => resolveCall({ method: 'prepare', project: 'C:/proj', episode: 1.5, shots: 'a', subtitleSrt: 'b' }))
      .toThrow('episode 必须是正整数集号')
  })

  it('rejects every argument a method cannot run without', () => {
    expect(() => resolveCall({ method: 'prepare', project: 'C:/proj', episode: 1 }))
      .toThrow('drama_render prepare 需要 shots')
    expect(() => resolveCall({ method: 'prepare', project: 'C:/proj', episode: 1, shots: 'a' }))
      .toThrow('drama_render prepare 需要 subtitleSrt')
    expect(() => resolveCall({ method: 'render', project: 'C:/proj', episode: 1 }))
      .toThrow('drama_render render 需要 lastShot')
    expect(() => resolveCall({ method: 'render', project: 'C:/proj', episode: 1, lastShot: 0 }))
      .toThrow('lastShot 必须是正整数镜头号')
    expect(() => resolveCall({ method: 'render', project: 'C:/proj', episode: 1, lastShot: 2 }))
      .toThrow('drama_render render 需要 timeline')
    expect(() => resolveCall({ method: 'render', project: 'C:/proj', episode: 1, lastShot: 2, timeline: 't' }))
      .toThrow('drama_render render 需要 subtitleSrt')
    expect(() => resolveCall({
      method: 'render', project: 'C:/proj', episode: 1, lastShot: 2, timeline: 't', subtitleSrt: 's',
    })).toThrow('drama_render render 需要 bgm')
    expect(() => resolveCall({
      method: 'render', project: 'C:/proj', episode: 1, lastShot: 2, timeline: 't', subtitleSrt: 's', bgm: 'b',
    })).toThrow('drama_render render 需要 endingAudio')
    expect(() => resolveCall({
      method: 'render', project: 'C:/proj', episode: 1, lastShot: 2, timeline: 't', subtitleSrt: 's',
      bgm: 'b', endingAudio: 'e',
    })).toThrow('drama_render render 需要 endingEffect')
    expect(() => resolveCall({ method: 'verify', project: 'C:/proj', episode: 1 }))
      .toThrow('drama_render verify 需要 timeline')
    expect(() => resolveCall({ method: 'verify', project: 'C:/proj', episode: 1, timeline: 't' }))
      .toThrow('drama_render verify 需要 subtitleSrt')
    expect(() => resolveCall({
      method: 'verify', project: 'C:/proj', episode: 1, timeline: 't', subtitleSrt: 's',
    })).toThrow('drama_render verify 需要 output')
  })
})

describe('runDramaRender', () => {
  it('prepares the episode layout and returns the timeline it laid out', async () => {
    const files = await preparedProject()
    const report = await run({
      method: 'prepare',
      project: files.project,
      episode: 2,
      shots: files.shots,
      subtitleSrt: files.subtitle,
    }, settingsWith(callChannel(files.project).channel))
    expect(report.method).toBe('prepare')
    expect(report.ok).toBe(true)
    expect(report.episode).toBe('02')
    expect(report.clips).toHaveLength(1)
    expect(report.clips[0]?.duration_us).toBe(114_733_332)
    expect(report.clips[0]?.source).toBe(join(files.project, 'media', 'p1-clean.mp4'))
    expect(report.body_end_seconds).toBe(114.733332)
    expect(report.expected_duration_seconds).toBe(114.733332)
    expect(report.encoder).toBe('')
    expect(report.gpu_requested).toBe(false)
    expect(report.media.duration_seconds).toBe(0)
    expect(report.tail_frame.matches_sequential_tail).toBe(false)
    expect(report.log_path).toBe('')
    expect(report.written).toContain(join(files.project, 'audio', '02.wav'))
  })

  it('renders the episode and reports the measured delivery', async () => {
    const files = await preparedProject()
    const report = await run({
      method: 'render',
      project: files.project,
      episode: 2,
      timeline: files.timeline,
      subtitleSrt: files.subtitle,
      lastShot: 1,
      bgm: files.bgm,
      endingAudio: files.endingAudio,
      endingEffect: files.endingEffect,
      output: files.output,
    }, settingsWith(callChannel(files.project).channel))
    expect(report.ok).toBe(true)
    expect(report.encoder).toBe('h264_nvenc')
    expect(report.expected_duration_seconds).toBe(116.733332)
    expect(report.log_path.length).toBeGreaterThan(0)
    expect(await readFile(report.log_path, 'utf8')).toContain('encoder=h264_nvenc')
  })

  it('verifies a delivered file and reports every check', async () => {
    const files = await preparedProject()
    await run({
      method: 'prepare',
      project: files.project,
      episode: 2,
      shots: files.shots,
      subtitleSrt: files.subtitle,
    }, settingsWith(callChannel(files.project).channel))
    await writePlaceholder(files.output, 'delivered')
    const report = await run({
      method: 'verify',
      project: files.project,
      episode: 2,
      output: files.output,
      timeline: files.timeline,
      subtitleSrt: join(files.project, 'editing', '02.srt'),
    }, settingsWith(callChannel(files.project).channel))
    expect(report.method).toBe('verify')
    expect(report.ok).toBe(true)
    expect(report.failures).toEqual([])
    expect(report.checks.map(check => check.id)).toEqual([
      'duration', 'video_stream', 'frame_rate', 'audio_stream', 'bitrate_floor',
      'black_frames', 'fade_to_black', 'silence', 'long_pauses', 'subtitle_bounds', 'subtitle_present',
      'output_provenance',
    ])
    expect(report.written).toEqual([])
  })
})
