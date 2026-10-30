/** The plugin entry: its registration, its argument resolution, and one call per method. */

import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { apply, Config, inject, name, resolveCall, resolveSettings, runDramaRender } from '../src/index.ts'
import type { DramaRenderReport, ProcessChannel, RenderSettings } from '../src/types.ts'
import {
  cleanup,
  decodeHandler,
  framemd5Line,
  probeHandler,
  runContext,
  shippedEndingAsset,
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
  const ctx = Object.assign(new Context(), {
    tools: {
      register: (definition: ToolDefinition) => {
        registered.push(definition)
        return () => {}
      },
    },
  })
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
  await writePlaceholder(bgm, 'bgm')
  // `render` accepts the ending sound and effect only as the shipped bytes: the
  // fixture copies those bytes in, so no stub can write over the repository's own
  // assets while the checks still read what actually ships.
  const endingAudio = join(project, 'audio', 'ending_audio.mp3')
  const endingEffect = join(project, 'assets', 'ending_effect.mp4')
  await mkdir(join(project, 'assets'), { recursive: true })
  await copyFile(shippedEndingAsset('ending_audio.mp3'), endingAudio)
  await copyFile(shippedEndingAsset('ending_effect.mp4'), endingEffect)
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
      [join(project, 'assets', 'ending_effect.mp4')]: { durationSeconds: 1.02 },
    }),
    call => (call.args.includes('lavfi') ? {} : undefined),
    call => (call.args.includes('-sseof') ? { after: async () => { await writePlaceholder(call.args.at(-1) ?? '', 'png') } } : undefined),
    call => (call.args.includes('framemd5') ? { stdout: `${framemd5Line(0, 'tail')}\n` } : undefined),
    decodeHandler(2),
    call => (call.command === 'ffmpeg'
      ? { after: async () => { await writePlaceholder(call.args.at(-1) ?? '', 'media') } }
      : undefined),
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
    expect(tool.description).toContain('默认 SimHei 40，字体服从部署配置')
    for (const phrase of ['1440x2560@60', '24M', '30M', '48M', '4.6 Mbps', 'SimHei 40', '字间距 -2',
      '单行、无标点、每条不超过 14 个有效字', '长句要逐条取得同源字词时间',
      '黑描边按成片宽度推导（1440px 宽目标 7px）', 'fps=F,setpts=N/(F*TB)', 'F 取时间线 delivery.fps（旧时间线默认 60）',
      '内容由AI生成', 'drawtext', '-sseof -0.1', 'framemd5', 'h264_nvenc', 'libx264', 'alimiter=0.95', '定格 2 秒']) {
      expect(tool.description).toContain(phrase)
    }
    // The delivery style states the outline as a delivered width, never as the raw
    // ASS field: the field is derived, and a stale literal here is what let the
    // value drift away from the 7px the picture must show.
    expect(tool.description).not.toMatch(/\d+px 黑描边/u)
  })

  it('states the shipped ending bytes in the ending parameter descriptions', () => {
    const properties = (dramaRender().parameters as { properties: Record<string, { description?: string }> }).properties
    const effect = properties.ending_effect?.description ?? ''
    const audio = properties.ending_audio?.description ?? ''
    expect(effect).toContain('tweet-drama-background-render/assets/ending_effect.mp4')
    expect(effect).toContain('49308bce84b964c5ec6768655e84920731dcaabe14509a0d84b4c92aea590010')
    expect(effect).toContain('原速')
    expect(audio).toContain('tweet-drama-background-render/assets/ending_audio.mp3')
    expect(audio).toContain('d1649e9c9231283a93ee3d28816c741ac3d389528654fca5ac69d75139943c0f')
    expect(audio).toContain('前 2 秒')
  })

  it('exposes the method enum and every path argument', () => {
    const parameters = dramaRender().parameters as {
      properties: Record<string, { enum?: string[]; description?: string }>
      required: string[]
    }
    expect(Object.keys(parameters.properties).sort()).toEqual([
      'alignment', 'audio', 'bgm', 'bgm_generation', 'bgm_plan', 'duration_seconds', 'ending_audio', 'ending_effect', 'episode', 'force',
      'intended_use', 'last_shot', 'lines', 'method', 'mix_profile', 'output', 'project', 'shots',
      'speech_decisions', 'speech_transcripts', 'start_seconds', 'subtitle_plan', 'subtitle_srt', 'timeline',
    ])
    expect(parameters.properties.method?.enum).toEqual(['prepare', 'render', 'verify', 'subtitles', 'audio_preview', 'subtitle_overlay',
      'speech_coverage', 'subtitle_layout'])
    for (const field of ['shots', 'lines', 'alignment', 'timeline', 'subtitle_srt', 'bgm', 'bgm_plan',
      'ending_audio', 'ending_effect', 'output']) {
      expect(parameters.properties[field]?.description).toContain('相对路径以 project 为基准')
    }
    expect(parameters.properties.bgm?.description).toContain('drama_bgm 返回的绝对 output')
    expect(parameters.properties.bgm_plan?.description).toContain('drama_bgm 返回的绝对 plan')
    expect(parameters.required.sort()).toEqual(['episode', 'method', 'project'])
  })

  it('maps a BGM plan through call resolution and returns only declared report fields', async () => {
    const prepared = await preparedProject()
    const plan = join(prepared.project, 'bgm-plan.json')
    await writePlaceholder(plan, JSON.stringify({ episodes: [{ episode: '02', intended_use: 'commercial', body_duration_seconds: 114.733332,
      segments: [{ index: 1, track: 'song', source: prepared.bgm, start_seconds: 0, end_seconds: 114.733332, reason: 'scene',
        track_id: 'catalog-song', license_info: { license: 'Non-commercial grant', commercial_use: false,
          source: 'https://music.example/license', attribution: 'Music provider', scope: 'Non-commercial distribution' } }],
    }] }))
    const report = await run({ method: 'render', ...prepared, episode: 2, subtitleSrt: prepared.subtitle,
      lastShot: 1, bgmPlan: plan }, settingsWith(callChannel(prepared.project).channel))
    expect(report.bgm_plan.path).toBe(plan)
    expect(report.bgm_plan.segments[0]).not.toHaveProperty('index')
    expect(report.bgm_plan).toMatchObject({ intended_use: 'commercial',
      license_records: [{ track_id: 'catalog-song', license_info: { status: 'declared', commercial_use: false },
        warnings: ['曲目声明不允许商业使用，与本次商业用途不匹配。'] }] })
    expect(report.warnings).toContain('BGM song：曲目声明不允许商业使用，与本次商业用途不匹配。')
    expect(report.ok).toBe(true)
  })

  it('renders the canonical value as pretty JSON', () => {
    const blocks = dramaRender().output.render({}, { ok: true }) as { type: string; text: string }[]
    expect(blocks).toHaveLength(1)
    expect(blocks[0]?.type).toBe('text')
    expect(blocks[0]?.text).toContain('"ok": true')
  })

  it.each(['prepare', 'render', 'verify', 'subtitles'] as const)(
    'accepts public snake_case arguments for %s before reading inputs', async (method) => {
      const project = await tempProject()
      temporary.push(project)
      const missing = join(project, 'missing.json')
      const args = {
        method, project, episode: 1, shots: missing, timeline: missing, lines: missing, alignment: missing,
        bgm_plan: join(project, 'plan.json'),
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

describe('subtitle overlay application', () => {
  async function plan(project: string, source: string): Promise<string> {
    const target = join(project, 'subtitle-plan.json')
    await writePlaceholder(target, JSON.stringify({ schema_version: 1, decisions: [{ shot: 1,
      source_sha256: createHash('sha256').update(await readFile(source)).digest('hex'),
      start_seconds: 1.68, end_seconds: 3.58, text: '台词', action: 'retain_embedded',
      reason: '源片预览已见同句', evidence_paths: ['qa/frame.png'] }] }))
    return target
  }

  it('exports a schema-valid resolved overlay through the actual registered executor without a media command', async () => {
    const prepared = await preparedProject(), tool = dramaRender()
    const subtitlePlan = await plan(prepared.project, join(prepared.project, 'video/02/shot_001.mp4'))
    const result = await tool.execute({ method: 'subtitle_overlay', project: prepared.project, episode: 2,
      timeline: prepared.timeline, subtitle_srt: prepared.subtitle, subtitle_plan: subtitlePlan,
      output: 'editing/export-overlay.srt' }, runContext()) as DramaRenderReport
    expect(validateJsonSchemaValue(tool.output.schema, result, '')).toEqual([])
    expect(result.subtitle_overlay).toMatchObject({ retained_cue_indexes: [1], overlay_cue_count: 0,
      resolved_srt: join(prepared.project, 'editing/export-overlay.srt') })
    expect(result.not_checked).toContain('embedded_subtitles')
    expect(result.subtitle_overlay?.retained_text_editable).toBe(false)
    expect(result.subtitle_overlay?.original_cue_count).toBe(1)
    expect(await readFile(prepared.subtitle, 'utf8')).toContain('台词')
    expect(await readFile(result.subtitle_overlay?.resolved_srt ?? '', 'utf8')).not.toContain('台词')
    expect(result.ok).toBe(true)
  })

  it('allocates an independent subtitle candidate when no output path is supplied', async () => {
    const prepared = await preparedProject(), channel = callChannel(prepared.project)
    const subtitlePlan = await plan(prepared.project, join(prepared.project, 'video/02/shot_001.mp4'))
    const report = await run({ method: 'subtitle_overlay', project: prepared.project, episode: 2,
      timeline: prepared.timeline, subtitleSrt: prepared.subtitle, subtitlePlan }, settingsWith(channel.channel))
    expect(report.subtitle_overlay?.resolved_srt).toContain(join(prepared.project, 'editing/subtitle-overlays/ep02-'))
    expect(report.subtitle_overlay?.retained_cue_indexes).toEqual([1])
    expect(report.written).toHaveLength(2)
    expect(channel.calls).toEqual([])
    expect(await readFile(prepared.subtitle, 'utf8')).toContain('台词')
  })

  it('prepares byte-identical videos before resolving the optional plan while keeping the authored installed SRT', async () => {
    const prepared = await preparedProject(), channel = callChannel(prepared.project)
    const subtitlePlan = await plan(prepared.project, join(prepared.project, 'media/p1-clean.mp4'))
    const result = await run({ method: 'prepare', project: prepared.project, episode: 2, shots: prepared.shots,
      subtitleSrt: prepared.subtitle, subtitlePlan }, settingsWith(channel.channel))
    expect(result.subtitle_overlay?.retained_cue_indexes).toEqual([1])
    expect(result.render_preview?.subtitle.path).toBe(result.subtitle_overlay?.resolved_srt)
    expect(await readFile(join(prepared.project, 'editing/02.srt'), 'utf8')).toContain('台词')
    expect(await readFile(result.subtitle_overlay?.resolved_srt ?? '', 'utf8')).not.toContain('台词')
  })

  it('burns only resolved cues and returns their bound report during final render', async () => {
    const prepared = await preparedProject(), channel = callChannel(prepared.project)
    const subtitlePlan = await plan(prepared.project, join(prepared.project, 'video/02/shot_001.mp4'))
    const result = await run({ method: 'render', ...prepared, episode: 2, subtitleSrt: prepared.subtitle,
      lastShot: 1, subtitlePlan }, settingsWith(channel.channel))
    expect(result.subtitle_overlay?.retained_cue_indexes).toEqual([1])
    expect(result.render_preview?.subtitle.path).toBe(result.subtitle_overlay?.resolved_srt)
    expect(await readFile(join(prepared.project, 'exports/.render_cache/02/display.ass'), 'utf8')).not.toContain('台词')
    expect(await readFile(prepared.subtitle, 'utf8')).toContain('台词')
    expect(result.written).toContain(result.subtitle_overlay?.decision_report)
  })

  it('does not silently accept the plan on an unsupported operation', () => {
    expect(() => resolveCall({ method: 'verify', project: 'project', episode: 2, subtitlePlan: 'plan.json' })).toThrow('仅用于')
  })
  it('passes explicit timeline effect timing into encoding and a schema-valid measured report', async () => {
    const prepared = await preparedProject(), channel = callChannel(prepared.project)
    await writePlaceholder(prepared.timeline, JSON.stringify({ ...JSON.parse(await readFile(prepared.timeline, 'utf8')),
      ending_effect_fit: 'stretch_to_window' }))
    const result = await run({ method: 'render', ...prepared, episode: 2, subtitleSrt: prepared.subtitle,
      lastShot: 1 }, settingsWith(channel.channel))
    expect(result.ending_effect).toEqual({ fit: 'stretch_to_window', source_duration_seconds: 1.02,
      target_duration_seconds: 2, speed: 0.51 })
    expect(channel.calls.some(call => call.args.some(arg => arg.includes('setpts=(PTS-STARTPTS)/0.51')))).toBe(true)
  })

  it.each([
    [undefined, 'stretch_to_window', 0.51],
    ['source_once', 'source_once', 1],
  ] as const)('uses configured ending fit only when the timeline omits it: %s', async (explicit, expected, speed) => {
    const prepared = await preparedProject(), channel = callChannel(prepared.project)
    if (explicit !== undefined) {
      await writePlaceholder(prepared.timeline, JSON.stringify({ ...JSON.parse(await readFile(prepared.timeline, 'utf8')),
        ending_effect_fit: explicit }))
    }
    const result = await run({ method: 'render', ...prepared, episode: 2, subtitleSrt: prepared.subtitle, lastShot: 1 },
      { ...settingsWith(channel.channel), defaultEndingEffectFit: 'stretch_to_window' })
    expect(result.ending_effect?.fit).toBe(expected)
    expect(result.ending_effect?.speed).toBe(speed)
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
    expect(resolved.subtitleFontFamily).toBe('SimHei')
    expect(resolved.watermarkFontFamily).toBe('Microsoft YaHei')
  })

  it.each(['subtitleFontFamily', 'watermarkFontFamily'])('rejects invalid ASS font names in %s', (field) => {
    for (const value of ['', '   ', 'Noto,Injected', 'Noto\nStyle: Injected', 'Noto\rStyle: Injected', 'Noto\n', 'Noto\r\n']) {
      expect(() => Config({ [field]: value })).toThrow()
    }
  })

  it('accepts deployment font families without changing the font directory', () => {
    expect(resolveSettings(Config({ subtitleFontFamily: 'Noto Sans CJK SC', watermarkFontFamily: '思源黑体' })))
      .toMatchObject({ subtitleFontFamily: 'Noto Sans CJK SC', watermarkFontFamily: '思源黑体', fontsDir: 'C:/Windows/Fonts' })
  })

  it('validates and carries the deployment subtitle target without changing non-product defaults', () => {
    const visual = { schema_version: 1 as const, reference_width: 480, reference_height: 854,
      font_size_px: 48, outline_px: 2, center_y_ratio: 0.736747073, max_width_ratio: 0.9 }
    expect(resolveSettings(Config({ defaultSubtitleVisual: visual, normalizeSubtitleText: true, enforceSubtitleVisual: true })))
      .toMatchObject({ defaultSubtitleVisual: visual, normalizeSubtitleText: true, enforceSubtitleVisual: true })
    expect(resolveSettings(Config({})).defaultSubtitleVisual).toBeUndefined()
    expect(resolveSettings(Config({})).enforceSubtitleVisual).toBeUndefined()
    expect(() => resolveSettings(Config({ enforceSubtitleVisual: true }))).toThrow('产品字幕视觉配置缺失')
    expect(() => Config({ defaultSubtitleVisual: { ...visual, font_size_px: -1 } })).toThrow()
    expect(() => Config({ defaultSubtitleVisual: { ...visual, center_y_ratio: 2 } })).toThrow()
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
      maxBgmVolume: 1,
      preferNvenc: false,
      fontsDir: 'D:/Fonts',
      subtitleFontFamily: 'Noto Sans CJK SC',
      watermarkFontFamily: '思源黑体',
    })).toEqual({
      ffmpeg: 'D:/ffmpeg/bin/ffmpeg.exe',
      ffprobe: 'D:/ffmpeg/bin/ffprobe.exe',
      masterVolume: 1.2,
      bgmVolume: 0.3,
      maxBgmVolume: 1,
      preferNvenc: false,
      fontsDir: 'D:/Fonts',
      subtitleFontFamily: 'Noto Sans CJK SC',
      watermarkFontFamily: '思源黑体',
    })
  })

  it('falls back to the approved defaults for every omitted field', () => {
    expect(resolveSettings()).toEqual({
      ffmpeg: 'ffmpeg',
      ffprobe: 'ffprobe',
      masterVolume: 1.45,
      bgmVolume: 0.24,
      maxBgmVolume: 8,
      preferNvenc: true,
      fontsDir: 'C:/Windows/Fonts',
      subtitleFontFamily: 'SimHei',
      watermarkFontFamily: 'Microsoft YaHei',
    })
  })
})

describe('resolveCall', () => {
  it('resolves optional audition inputs and defaults only its original audio', () => {
    const project = resolve('audio-project')
    const input = { method: 'audio_preview' as const, project, episode: 1,
      timeline: 'timeline.json', mixProfile: 'mix.json', startSeconds: 0, durationSeconds: 1 }
    expect(resolveCall(input)).toMatchObject({ method: 'audio_preview', audio: join(project, 'audio/01.wav') })
    expect(resolveCall({ ...input, audio: 'original.wav', bgm: 'music.wav', bgmPlan: 'plan.json',
      bgmGeneration: 'receipt.json', intendedUse: 'commercial' })).toMatchObject({
      audio: join(project, 'original.wav'), bgm: join(project, 'music.wav'),
      bgmPlan: join(project, 'plan.json'), bgmGeneration: join(project, 'receipt.json'), intendedUse: 'commercial',
    })
    expect(resolveCall({ method: 'render', project, episode: 1, timeline: 'timeline.json', subtitleSrt: 'a.srt',
      lastShot: 1, mixProfile: 'mix.json' })).not.toHaveProperty('bgm')
    expect(resolveCall({ method: 'subtitle_overlay', project, episode: 1, timeline: 'timeline.json',
      subtitleSrt: 'a.srt', subtitlePlan: 'plan.json' })).not.toHaveProperty('outputSrt')
  })
  it('uses the installed episode subtitle path when an aligned cue build omits an output', () => {
    const project = resolve('project')
    expect(resolveCall({ method: 'subtitles', project, episode: 2, shots: 'shots.json',
      lines: 'lines.json', alignment: 'alignment.json' }))
      .toMatchObject({ method: 'subtitles', subtitleSrt: join(project, 'editing', '02.srt') })
  })
  it('resolves a prepare call and pads the episode number', () => {
    expect(resolveCall({
      method: 'prepare', project: 'C:/proj', episode: 2, shots: 'shots.json', subtitleSrt: 'ep02.srt',
    })).toEqual({
      method: 'prepare',
      project: resolve('C:/proj'),
      episode: '02',
      shotsPath: join(resolve('C:/proj'), 'shots.json'),
      subtitleSrt: join(resolve('C:/proj'), 'ep02.srt'),
    })
  })

  it('defaults a render call\u2019s output to the project\u2019s export path', () => {
    const project = resolve('C:/proj')
    const call = resolveCall({
      method: 'render', project: 'C:/proj', episode: 2, timeline: 't.json', subtitleSrt: 's.srt',
      lastShot: 9, bgm: 'b.mp3', bgmPlan: 'editing/bgm-plan.json', endingAudio: 'e.mp3', endingEffect: 'fx.mp4',
    })
    expect(call).toEqual({
      method: 'render',
      project,
      episode: '02',
      timelinePath: join(project, 't.json'),
      subtitleSrt: join(project, 's.srt'),
      lastShot: 9,
      bgm: join(project, 'b.mp3'),
      bgmPlan: join(project, 'editing', 'bgm-plan.json'),
      endingAudio: join(project, 'e.mp3'),
      endingEffect: join(project, 'fx.mp4'),
      output: join(project, 'exports', '02.mp4'),
      force: false,
    })
  })

  it('preserves absolute BGM handoff paths while the process cwd differs from the project', () => {
    const project = resolve('剧变项目')
    const timeline = join(project, 'editing', '02-timeline.json')
    const bgm = join(project, 'audio', 'bgm', '02.wav')
    const bgmPlan = join(project, 'editing', 'bgm-plan.json')
    const call = resolveCall({
      method: 'render', project, episode: 2, timeline, subtitleSrt: 's.srt', lastShot: 9,
      bgm, bgmPlan, endingAudio: 'e.mp3', endingEffect: 'fx.mp4',
    })
    expect(call).toMatchObject({ timelinePath: timeline, bgm, bgmPlan })
  })

  it('keeps an explicit render output and force flag', () => {
    const output = resolve('out', 'final.mp4')
    const call = resolveCall({
      method: 'render', project: 'C:/proj', episode: 2, timeline: 't.json', subtitleSrt: 's.srt',
      lastShot: 9, bgm: 'b.mp3', endingAudio: 'e.mp3', endingEffect: 'fx.mp4',
      output, force: true,
    })
    expect(call.method === 'render' ? call.output : '').toBe(output)
    expect(call.method === 'render' ? call.force : false).toBe(true)
  })

  it('resolves a verify call from the delivered file and its two inputs', () => {
    const project = resolve('C:/proj')
    const output = resolve('out', 'final.mp4')
    const call = resolveCall({
      method: 'verify', project: 'C:/proj', episode: 12, output,
      timeline: 't.json', subtitleSrt: 's.srt',
    })
    expect(call.method).toBe('verify')
    expect(call.episode).toBe('12')
    expect(call.method === 'verify' ? call.timelinePath : '').toBe(join(project, 't.json'))
    expect(call.method === 'verify' ? call.subtitleSrt : '').toBe(join(project, 's.srt'))
    expect(call.method === 'verify' ? call.output : '').toBe(output)
  })

  it.each(['prepare', 'subtitles', 'render', 'verify'] as const)(
    'resolves every %s path against a Chinese project outside the process cwd', (method) => {
      const project = resolve('中文 项目')
      expect(project).not.toBe(process.cwd())
      const call = resolveCall({
        method, project, episode: 2, shots: '输入 文件/镜头.json', lines: '输入 文件/台词.json',
        alignment: '输入 文件/对齐.json', timeline: 'editing/时间线.json', subtitleSrt: 'editing/字幕.srt',
        lastShot: 1, bgm: 'audio/配乐.wav', bgmPlan: 'editing/配乐计划.json',
        endingAudio: '片尾 素材/音效.mp3', endingEffect: '片尾 素材/特效.mp4', output: 'exports/成片.mp4',
      })
      const expected = {
        prepare: { shotsPath: join(project, '输入 文件', '镜头.json'), subtitleSrt: join(project, 'editing', '字幕.srt') },
        subtitles: { shotsPath: join(project, '输入 文件', '镜头.json'), linesPath: join(project, '输入 文件', '台词.json'),
          alignmentPath: join(project, '输入 文件', '对齐.json'), subtitleSrt: join(project, 'editing', '字幕.srt') },
        render: { timelinePath: join(project, 'editing', '时间线.json'), subtitleSrt: join(project, 'editing', '字幕.srt'),
          bgm: join(project, 'audio', '配乐.wav'), bgmPlan: join(project, 'editing', '配乐计划.json'),
          endingAudio: join(project, '片尾 素材', '音效.mp3'), endingEffect: join(project, '片尾 素材', '特效.mp4'),
          output: join(project, 'exports', '成片.mp4') },
        verify: { timelinePath: join(project, 'editing', '时间线.json'), subtitleSrt: join(project, 'editing', '字幕.srt'),
          output: join(project, 'exports', '成片.mp4') },
      }
      expect(call).toMatchObject({ method, project, episode: '02', ...expected[method] })
    },
  )

  it.each(['prepare', 'subtitles', 'render', 'verify'] as const)(
    'preserves absolute %s handoff paths outside the project', (method) => {
      const project = resolve('中文 项目')
      const absolute = resolve('共享 素材', '已确认 文件')
      const call = resolveCall({
        method, project, episode: 2, shots: absolute, lines: absolute, alignment: absolute,
        timeline: absolute, subtitleSrt: absolute, lastShot: 1, bgm: absolute, bgmPlan: absolute,
        endingAudio: absolute, endingEffect: absolute, output: absolute,
      })
      const expected = {
        prepare: { shotsPath: absolute, subtitleSrt: absolute },
        subtitles: { shotsPath: absolute, linesPath: absolute, alignmentPath: absolute, subtitleSrt: absolute },
        render: { timelinePath: absolute, subtitleSrt: absolute, bgm: absolute, bgmPlan: absolute,
          endingAudio: absolute, endingEffect: absolute, output: absolute },
        verify: { timelinePath: absolute, subtitleSrt: absolute, output: absolute },
      }
      expect(call).toMatchObject({ method, project, ...expected[method] })
    },
  )

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
    expect(resolveCall({
      method: 'render', project: 'C:/proj', episode: 1, lastShot: 2, timeline: 't', subtitleSrt: 's', bgm: 'b',
    })).toMatchObject({ method: 'render' })
    expect(resolveCall({
      method: 'render', project: 'C:/proj', episode: 1, lastShot: 2, timeline: 't', subtitleSrt: 's',
      bgm: 'b', endingAudio: 'e',
    })).toMatchObject({ method: 'render' })
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
  it('resolves animation policy before requiring ending arguments through the tool entry', async () => {
    const files = await preparedProject()
    await writePlaceholder(join(files.project, 'project_config.json'), JSON.stringify({ project_bible: { visual_medium: 'animation_3d' } }))
    const report = await run({ method: 'render', project: files.project, episode: 2,
      timeline: files.timeline, subtitleSrt: files.subtitle, lastShot: 1, bgm: files.bgm, output: files.output },
    settingsWith(callChannel(files.project).channel))
    expect(report.expected_duration_seconds).toBe(114.733332)
    expect(report.tail_frame.path).toBe('')
  })

  it.each(['endingAudio', 'endingEffect'] as const)('requires %s only after resolving photorealistic policy', async (missing) => {
    const files = await preparedProject()
    await writePlaceholder(join(files.project, 'project_config.json'), JSON.stringify({ project_bible: { visual_medium: 'photorealistic' } }))
    const endings = missing === 'endingAudio' ? {} : { endingAudio: files.endingAudio }
    await expect(run({ method: 'render', project: files.project, episode: 2,
      timeline: files.timeline, subtitleSrt: files.subtitle, lastShot: 1, bgm: files.bgm, ...endings },
    settingsWith(callChannel(files.project).channel))).rejects.toThrow(`需要 ${missing}`)
  })

  it.each([
    [{}, 'SimHei', 'Microsoft YaHei'],
    [{ subtitleFontFamily: 'Noto Sans CJK SC' }, 'Noto Sans CJK SC', 'Microsoft YaHei'],
    [{ watermarkFontFamily: '思源黑体' }, 'SimHei', '思源黑体'],
    [{ subtitleFontFamily: 'Noto Sans CJK SC', watermarkFontFamily: 'Noto Sans CJK SC' }, 'Noto Sans CJK SC', 'Noto Sans CJK SC'],
  ] as const)('burns configured fonts over the concatenated body and ending: %j', async (config, subtitle, watermark) => {
    const files = await preparedProject()
    const channel = callChannel(files.project)
    await run({ method: 'render', ...files, episode: 2, subtitleSrt: files.subtitle, lastShot: 1 },
      { ...resolveSettings(Config(config)), channel: channel.channel })
    const cache = join(files.project, 'exports', '.render_cache', '02')
    const ass = await readFile(join(cache, 'display.ass'), 'utf8')
    expect(ass).toContain(`Style: Default,${subtitle},40,`)
    expect(ass).toContain(`Style: Watermark,${watermark},44,`)
    expect(ass).toContain('Dialogue: 1,0:00:00.00,9:59:59.00,Watermark')
    const concat = channel.calls.find(call => call.args.includes('concat'))
    expect(await readFile(join(cache, 'concat.txt'), 'utf8')).toContain('/ending.mp4')
    const burn = channel.calls.find(call => call.args.at(-1) === join(cache, 'subtitled.mp4'))
    expect(burn?.args).toContain(concat?.args.at(-1))
    expect(burn?.args.join(' ')).toContain("fontsdir='C\\:/Windows/Fonts'")
  })

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
    expect(report.expected_duration_seconds).toBe(116.733332)
    expect(report.encoder).toBe('')
    expect(report.gpu_requested).toBe(false)
    expect(report.media.duration_seconds).toBe(0)
    expect(report.tail_frame.matches_sequential_tail).toBe(false)
    expect(report.log_path).toBe('')
    expect(report.written).toContain(join(files.project, 'audio', '02.wav'))
  })

  it('returns a separate normalized subtitle candidate for both delivery consumers without changing the source', async () => {
    const files = await preparedProject()
    const source = '1\n00:00:01,000 --> 00:00:02,000\n你好，\n世界！\n'
    await writeFile(files.subtitle, source, 'utf8')
    const report = await run({ method: 'prepare', project: files.project, episode: 2,
      shots: files.shots, subtitleSrt: files.subtitle },
    { ...settingsWith(callChannel(files.project).channel), normalizeSubtitleText: true })
    const candidate = report.render_preview?.subtitle.path
    expect(candidate).toBeTruthy()
    expect(candidate).not.toBe(files.subtitle)
    expect(report.written).toContain(candidate)
    expect(await readFile(candidate as string, 'utf8')).toContain('你好 世界')
    expect(await readFile(files.subtitle, 'utf8')).toBe(source)
  })

  it('records omitted punctuation-only cue intervals beside the shared candidate without rewriting the source', async () => {
    const files = await preparedProject()
    const source = '1\n00:00:01,000 --> 00:00:02,000\n！\n\n2\n00:00:02,000 --> 00:00:03,000\n你好。\n'
    await writeFile(files.subtitle, source, 'utf8')
    const report = await run({ method: 'prepare', project: files.project, episode: 2,
      shots: files.shots, subtitleSrt: files.subtitle },
    { ...settingsWith(callChannel(files.project).channel), normalizeSubtitleText: true })
    const candidate = report.render_preview?.subtitle.path as string
    expect(await readFile(candidate, 'utf8')).not.toContain('！')
    expect(await readFile(candidate, 'utf8')).toContain('你好')
    expect(await readFile(`${candidate}.review.txt`, 'utf8')).toContain('1.000–2.000 秒')
    expect(report.warnings.join(' ')).toContain('勿据此认定该时段无对白')
    expect(report.written).toContain(`${candidate}.review.txt`)
    expect(await readFile(files.subtitle, 'utf8')).toBe(source)
  })

  it('prepares a shared single-line candidate from source-bound word times and measured widths', async () => {
    const files = await preparedProject()
    const original = '1\n00:00:01,000 --> 00:00:04,000\n今天我们一起去做饭！\n'
    await writeFile(files.subtitle, original, 'utf8')
    const audio = join(files.project, 'media', 'p1-clean.mp4')
    const hash = createHash('sha256').update(await readFile(audio)).digest('hex')
    await mkdir(join(files.project, 'transcript', 'jobs'), { recursive: true })
    await mkdir(join(files.project, 'transcript', 'raw'), { recursive: true })
    const receipt = join(files.project, 'transcript', 'jobs', 'p1-v1.json')
    await writeFile(receipt, JSON.stringify({ status: 'complete', source: audio, sourceSha256: hash, stem: 'p1', version: 1 }))
    const words = ['今天', '我们', '一起', '去', '做饭'].map((text, i) => ({ text, start: 1 + i * 0.5, end: 1.4 + i * 0.5 }))
    await writeFile(join(files.project, 'transcript', 'raw', 'p1-v1.json'), JSON.stringify([{ start: 1, end: 4,
      text: words.map(word => word.text).join(''), words }]))
    const mapping = join(files.project, 'receipts.json')
    await writeFile(mapping, JSON.stringify({ shots: [{ shot: 1, receipt }] }))
    const underlying = callChannel(files.project).channel
    const channel: ProcessChannel = { run: async (command, args) => {
      const inputIndex = args.findIndex(arg => arg.startsWith('[0:v]'))
      if (inputIndex < 0) return await underlying.run(command, args)
      const filter = args[inputIndex] ?? ''
      const assPath = /ass='([^']+)'/u.exec(filter)?.[1]?.replace(/\\:/gu, ':')
      if (assPath === undefined) throw new Error(`Missing ASS path: ${filter}`)
      const document = await readFile(assPath, 'utf8')
      const text = (document.split('\n').find(line => line.startsWith('Dialogue:'))?.split(',').at(-1) ?? '')
        .replace(/^.*\}/u, '')
      const width = Array.from(text).length > 4 ? 2000 : 100
      for (const path of args.filter(arg => arg.endsWith('.png'))) await writeFile(path, 'fake image')
      return { code: 0, stdout: '', stderr: `[Parsed_bbox] x1:400 x2:${String(399 + width)} y1:100 y2:119 w:${String(width)} h:20` }
    } }
    const report = await run({ method: 'prepare', project: files.project, episode: 2, shots: files.shots,
      subtitleSrt: files.subtitle, speechTranscripts: mapping }, { ...settingsWith(channel), normalizeSubtitleText: true,
      defaultSubtitleVisual: { schema_version: 1, reference_width: 480, reference_height: 854,
        font_size_px: 48, outline_px: 2, center_y_ratio: 0.736747073, max_width_ratio: 0.9 } })
    const candidate = report.render_preview?.subtitle.path
    expect(candidate).toBeTruthy()
    const text = await readFile(candidate as string, 'utf8')
    expect(text).toContain('今天我们')
    expect(text).toContain('一起去')
    expect(text).toContain('做饭')
    expect(text, report.warnings.join('\n')).toContain('00:00:02,000')
    expect(text).not.toContain('！')
    expect(await readFile(files.subtitle, 'utf8')).toBe(original)
  })

  it('captures the configured ending fit in new timelines for both render and editable drafts', async () => {
    const files = await preparedProject()
    await run({ method: 'prepare', project: files.project, episode: 2,
      shots: files.shots, subtitleSrt: files.subtitle },
    { ...settingsWith(callChannel(files.project).channel), defaultEndingEffectFit: 'stretch_to_window' })
    const timeline: unknown = JSON.parse(await readFile(join(files.project, 'editing/02-timeline.json'), 'utf8'))
    expect(timeline).toMatchObject({ ending_effect_fit: 'stretch_to_window' })
  })

  it('preserves an existing explicit ending choice when preparing again', async () => {
    const files = await preparedProject()
    await writePlaceholder(files.timeline, JSON.stringify({ ...JSON.parse(await readFile(files.timeline, 'utf8')),
      ending_effect_fit: 'source_once' }))
    await run({ method: 'prepare', project: files.project, episode: 2,
      shots: files.shots, subtitleSrt: files.subtitle },
    { ...settingsWith(callChannel(files.project).channel), defaultEndingEffectFit: 'stretch_to_window' })
    const timeline: unknown = JSON.parse(await readFile(files.timeline, 'utf8'))
    expect(timeline).toMatchObject({ ending_effect_fit: 'source_once' })
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

  it('reports the normalized SRT actually burned by the render without modifying the supplied source', async () => {
    const files = await preparedProject(), channel = callChannel(files.project)
    const source = '1\n00:00:01,000 --> 00:00:02,000\n你好，\n世界！\n'
    await writeFile(files.subtitle, source, 'utf8')
    const report = await run({ method: 'render', ...files, episode: 2, subtitleSrt: files.subtitle, lastShot: 1 },
      { ...settingsWith(channel.channel), normalizeSubtitleText: true })
    const candidate = report.render_preview?.subtitle.path
    expect(candidate).toBeTruthy()
    expect(report.written).toContain(candidate)
    expect(await readFile(candidate as string, 'utf8')).toContain('你好 世界')
    expect(await readFile(join(files.project, 'exports/.render_cache/02/display.ass'), 'utf8')).toContain('你好 世界')
    expect(await readFile(files.subtitle, 'utf8')).toBe(source)
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
    expect(report.bgm_plan).toMatchObject({ intended_use: 'unknown', license_records: [], segments: [] })
    expect(report.not_checked).toContain('bgm_license_info')
    expect(report.ok).toBe(true)
    expect(report.failures).toEqual([])
    expect(report.checks.map(check => check.id)).toEqual([
      'duration', 'video_stream', 'frame_rate', 'audio_stream', 'bitrate_floor', 'decode_probe',
      'black_frames', 'fade_to_black', 'silence', 'long_pauses', 'subtitle_bounds', 'subtitle_present',
      'output_source_record',
    ])
    expect(report.written).toEqual([])
  })
})
