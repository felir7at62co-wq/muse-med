/** `render`: the encode pipeline, its cache, its log, and the delivery verdict it returns. */

import { copyFile, mkdir, readFile, readdir, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runDramaRender } from '../src/index.ts'
import { readSourceRecord, sourceRecordPathFor, writeSourceRecord } from '../src/source-record.ts'
import { fileSha256 } from '../src/cache.ts'
import { createMediaToolkit } from '../src/ffmpeg.ts'
import { episodePaths, shotFileName } from '../src/paths.ts'
import { renderEpisode, type RenderInput } from '../src/render.ts'
import { writeSubtitleClock } from '../src/subtitle-clock.ts'
import type { RenderSettings } from '../src/types.ts'
import {
  cleanup,
  decodeHandler,
  framemd5Line,
  probeHandler,
  shippedEndingAsset,
  sizeOf,
  srtDocument,
  stubChannel,
  tempProject,
  timelineJson,
  writePlaceholder,
  type ProbeSpec,
  type StubHandler,
} from './harness.ts'

const temporary: string[] = []
const publication = vi.hoisted(() => ({ target: '' }))
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual, link: async (...args: Parameters<typeof actual.link>) => {
    if (String(args[1]) === publication.target) {
      await actual.writeFile(args[1], 'concurrent publication', { flag: 'wx' })
      throw Object.assign(new Error('publication already exists'), { code: 'EEXIST' })
    }
    await actual.link(...args)
  } }
})

afterEach(async () => {
  publication.target = ''
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
  subtitleFontFamily: 'SimHei',
  watermarkFontFamily: 'Microsoft YaHei',
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
  await writePlaceholder(join(project, 'project_config.json'), JSON.stringify({ project_bible: { visual_medium: 'photorealistic' } }))
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
  await writePlaceholder(bgm, 'bgm')
  // `render` accepts the ending sound and effect only as the shipped bytes, so the
  // fixture copies the shipped assets in: the checks read real bytes, and a stub
  // that writes over an output path can never touch the repository's own assets.
  const endingAudio = join(project, 'audio', 'ending_audio.mp3')
  const endingEffect = join(project, 'assets', 'ending_effect.mp4')
  await mkdir(join(project, 'assets'), { recursive: true })
  await copyFile(shippedEndingAsset('ending_audio.mp3'), endingAudio)
  await copyFile(shippedEndingAsset('ending_effect.mp4'), endingEffect)
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
  resume?: boolean
  sourceProbe?: ProbeSpec
  layout?: boolean
} = {}): ReturnType<typeof stubChannel> {
  const queued = [...(options.imageHashes ?? ['tail'])]
  const deliveredProbe = {
    durationSeconds: options.durationSeconds ?? 116.733332,
    sizeBytes: 400_000_000,
    bitRateBps: options.bitRateBps ?? 27_000_000,
    video: options.deliveredHasStreams === false ? undefined : {},
    audio: options.deliveredHasStreams === false ? false as const : {},
  }
  const handlers: StubHandler[] = [
    ...(options.layout === true ? [(call => call.args.some(argument => argument.includes('bbox=min_val=1')) ? {
      stderr: 'fontselect: (SimHei, 400, 0) -> SimHei, 0, SimHei\n[Parsed_bbox] x1:1000 x2:1199 y1:1200 y2:1239 w:200 h:40',
      after: async () => { for (const path of call.args.filter(argument => argument.endsWith('.png'))) await writePlaceholder(path, 'glyph probe image') },
    } : undefined) satisfies StubHandler] : []),
    ...(options.resume === true ? [
      ((call) => {
        const path = call.args.at(-1) ?? ''
        if (basename(path) !== 'output.mp4' && !basename(path).includes('.resume-')) return undefined
        return probeHandler({ [path]: deliveredProbe })(call)
      }) satisfies StubHandler,
      (call => call.args.includes('blackdetect=d=0.1:pix_th=0.1')
        || call.args.includes('silencedetect=noise=-50dB:d=1') ? {} : undefined) satisfies StubHandler,
      decodeHandler(),
    ] : []),
    probeHandler({
      [join(prepared.paths.videoDir, 'shot_001.mp4')]: options.sourceProbe ?? { video: {} },
      [join(prepared.paths.videoDir, 'shot_002.mp4')]: { video: {} },
      [prepared.output]: deliveredProbe,
      [prepared.endingEffect]: { durationSeconds: 1.02 },
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
    call => (call.command === 'ffmpeg'
      ? { after: async () => {
        if (call.args.includes('[musicstem]')) {
          const output = call.args.find(arg => basename(arg) === 'output.mp4')
          if (output === undefined) throw new Error('music-stem mux requires its staged video output')
          await writePlaceholder(output, 'muxed media')
        }
        await writePlaceholder(call.args[call.args.length - 1] ?? '', 'media')
      } }
      : undefined),
  ]
  return stubChannel(handlers)
}

/** Build the toolkit a render uses over a stub channel. */
function toolkit(channel: ReturnType<typeof stubChannel>) {
  return createMediaToolkit({ ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', channel: channel.channel })
}

/** Run one full render, with any input the case substitutes. */
async function render(
  prepared: Omit<Prepared, 'bgm'> & { readonly bgm?: string },
  channel: ReturnType<typeof stubChannel>,
  force = false,
  bgmPlan?: string,
  overrides: Partial<RenderInput> = {},
) {
  return await renderEpisode({
    toolkit: toolkit(channel),
    settings,
    project: prepared.project,
    episode: '02',
    timelinePath: prepared.timeline,
    subtitleSrt: prepared.subtitle,
    lastShot: 2,
    ...(prepared.bgm === undefined ? {} : { bgm: prepared.bgm }),
    ...(bgmPlan === undefined ? {} : { bgmPlan }),
    endingAudio: prepared.endingAudio,
    endingEffect: prepared.endingEffect,
    output: prepared.output,
    force,
    ...overrides,
  })
}

describe('renderEpisode', () => {
  it('records measured product subtitle checks and preserves a prior candidate missing that proof', async () => {
    const p = await preparedProject()
    const timeline = JSON.parse(await readFile(p.timeline, 'utf8'))
    timeline.delivery = { width: 1440, height: 2560, fps: 60 }
    timeline.delivery.subtitle_visual = { schema_version: 1, reference_width: 1080, reference_height: 1920,
      font_size_px: 40, outline_px: 2, center_y_ratio: 0.75, max_width_ratio: 0.9, font_family: 'SimHei' }
    await writePlaceholder(p.timeline, JSON.stringify(timeline))
    const channel = renderChannel(p, { resume: true, layout: true })
    const first = await render(p, channel, false, undefined, { resume: true })
    const path = sourceRecordPathFor(first.output)
    const record = (await readSourceRecord(path))!
    const verification = record.delivery_inputs!.subtitle_visual_verification!
    expect(verification).toMatchObject({ version: 1, subtitle_sha256: record.delivery_inputs!.subtitle_sha256,
      requested_font: 'SimHei', delivery: { width: 1440, height: 2560, fps: 60 }, visual: timeline.delivery.subtitle_visual, checks: [
        { id: 'subtitle_display_text', ok: true }, { id: 'subtitle_display_width', ok: true }, { id: 'subtitle_display_font', ok: true },
      ] })
    expect(record.input_files).toContainEqual({ path: verification.report_path, sha256: await fileSha256(verification.report_path) })
    const { subtitle_visual_verification: _verification, ...legacy } = record.delivery_inputs!
    await writeSourceRecord(path, { ...record, delivery_inputs: legacy })
    const next = await render(p, channel, false, undefined, { resume: true })
    expect(next.output).not.toBe(first.output)
    expect((await readSourceRecord(path))?.delivery_inputs?.subtitle_visual_verification).toBeUndefined()
  })
  it('requires current source QA before media processing on a strict formal render', async () => {
    const p = await preparedProject()
    await writePlaceholder(join(p.project, 'project_config.json'), JSON.stringify({
      project_bible: { visual_medium: 'photorealistic', delivery: { require_source_review: true } },
    }))
    await writePlaceholder(p.paths.sources, JSON.stringify({ shots: [
      { shot: 1, package: 1, video: join(p.paths.videoDir, 'shot_001.mp4') },
      { shot: 2, package: 2, video: join(p.paths.videoDir, 'shot_002.mp4') },
    ] }))
    const channel = stubChannel([])
    await expect(render(p, channel)).rejects.toThrow(/缺少本集选源审核/u)
    expect(channel.calls).toHaveLength(0)
  })
  it('blocks a legacy AAC-duration cut that would duplicate a decoded source frame', async () => {
    const prepared = await preparedProject()
    const channel = renderChannel(prepared, { sourceProbe: {
      durationSeconds: 5.049999, video: { fps: 60, startSeconds: 0, durationSeconds: 5.033333, frameCount: 302 },
    } })
    await expect(render(prepared, channel)).rejects.toThrow('镜头 1 的时间线需要 303 帧，实际画面只有 302 帧')
    expect(channel.calls).toHaveLength(1)
    expect(channel.calls[0]?.command).toBe('ffprobe')
  })

  it('rejects generated subtitles from another episode or cut before running any media command', async () => {
    const prepared = await preparedProject()
    const clips = [5_050_000, 109_683_332].map((durationUs, index) => {
      const shot = index + 1
      const video = join(prepared.paths.videoDir, shotFileName(shot))
      return { source: { shot, video, audio: video }, video, audio: video, durationUs }
    })
    await writePlaceholder(prepared.paths.sources, JSON.stringify({ shots: clips.map(clip => clip.source) }))
    const otherSubtitle = join(prepared.project, 'editing', '03.srt')
    const srt = await readFile(prepared.subtitle, 'utf8')
    await writePlaceholder(otherSubtitle, srt)
    await writeSubtitleClock(otherSubtitle, srt, '03', clips)

    const channel = renderChannel(prepared, { resume: true })
    const args = { method: 'render' as const, project: prepared.project, episode: 2, timeline: prepared.timeline,
      subtitleSrt: otherSubtitle, lastShot: 2, bgm: prepared.bgm, endingAudio: prepared.endingAudio,
      endingEffect: prepared.endingEffect, output: prepared.output, resume: true }
    const options = { ...settings, channel: channel.channel }
    await expect(runDramaRender(args, options)).rejects.toThrow(/生成字幕与当前集/)
    expect(channel.calls).toEqual([])

    await writeSubtitleClock(otherSubtitle, srt, '02', clips)
    const originalTimeline = await readFile(prepared.timeline, 'utf8')
    await writePlaceholder(prepared.timeline, timelineJson([
      { shot: 1, startUs: 0, durationUs: 4_050_000 },
      { shot: 2, startUs: 4_050_000, durationUs: 110_683_332 },
    ], 114.733332))
    await expect(runDramaRender(args, options)).rejects.toThrow(/生成字幕与当前集/)
    expect(channel.calls).toEqual([])

    await writePlaceholder(prepared.timeline, originalTimeline)
    await expect(runDramaRender(args, options)).resolves.toMatchObject({ method: 'render', ok: true })
  })

  it('independently verifies and reuses the exact single-episode candidate through the normal render method', async () => {
    const prepared = await preparedProject()
    const channel = renderChannel(prepared, { resume: true })
    const args = { method: 'render' as const, project: prepared.project, episode: 2, timeline: prepared.timeline,
      subtitleSrt: prepared.subtitle, lastShot: 2, bgm: prepared.bgm, endingAudio: prepared.endingAudio,
      endingEffect: prepared.endingEffect, output: prepared.output, resume: true }
    const options = { ...settings, channel: channel.channel }
    const first = await runDramaRender(args, options)
    expect(first.ok).toBe(true)
    const source = await readSourceRecord(sourceRecordPathFor(first.output))
    expect(source?.request_sha256).toMatch(/^[0-9a-f]{64}$/u)
    expect(source?.delivery_inputs).toEqual({
      timeline_sha256: await fileSha256(prepared.timeline),
      subtitle_sha256: await fileSha256(prepared.subtitle),
      master_audio_sha256: await fileSha256(prepared.paths.masterAudio),
      videos: await Promise.all([1, 2].map(async shot => ({
        shot, sha256: await fileSha256(join(prepared.paths.videoDir, shotFileName(shot))),
      }))),
    })
    expect(source?.input_files).toContainEqual({ path: prepared.timeline, sha256: source?.delivery_inputs?.timeline_sha256 })
    expect((await readdir(dirname(first.log_path))).sort()).toEqual(['last_video_tail_frame.png', 'render.log'])
    const checkpoint = channel.calls.length
    const next = await runDramaRender(args, options)
    expect(next).toMatchObject({ method: 'render', ok: true, output: first.output, written: [] })
    expect(next.checks.find(check => check.id === 'output_source_record')?.ok).toBe(true)
    expect(next.checks.find(check => check.id === 'decode_probe')?.ok).toBe(true)
    expect(channel.calls.slice(checkpoint).some(call => call.args.includes('-c:v'))).toBe(false)
  })

  it('binds strict coverage to the prepared source manifest and external SRT in the render receipt', async () => {
    const prepared = await preparedProject()
    const channel = renderChannel(prepared, { resume: true })
    await writePlaceholder(join(prepared.project, 'project_config.json'),
      JSON.stringify({ project_bible: { delivery: { subtitle: { require_speech_coverage: true } } } }))
    await writePlaceholder(prepared.paths.sources, '{"shots":[]}')
    const rendered = await runDramaRender({ method: 'render', project: prepared.project, episode: 2,
      timeline: prepared.timeline, subtitleSrt: prepared.subtitle, lastShot: 2, bgm: prepared.bgm,
      endingAudio: prepared.endingAudio, endingEffect: prepared.endingEffect, output: prepared.output, resume: true,
    }, { ...settings, channel: channel.channel })
    const record = await readSourceRecord(sourceRecordPathFor(rendered.output))
    expect(record?.delivery_inputs?.subtitle_display).toBe('external')
    expect(record?.input_files).toContainEqual({ path: prepared.paths.sources, sha256: await fileSha256(prepared.paths.sources) })
  })

  it.each(['music', 'none'] as const)('binds actual %s music mode and consumed evidence in the normal render receipt', async (mode) => {
    const prepared = await preparedProject(), channel = renderChannel(prepared, { resume: true })
    const bgmPlan = join(prepared.project, 'bgm-plan.json'), bgmGeneration = join(prepared.project, 'bgm.generation.json')
    const mixProfile = join(prepared.project, 'mix.json')
    await Promise.all([
      writePlaceholder(join(prepared.project, 'project_config.json'),
        JSON.stringify({ project_bible: { delivery: { audio: { require_music_decision: true } } } })),
      writePlaceholder(bgmPlan, JSON.stringify({ episodes: [{ episode: '02', body_duration_seconds: 114.733332,
        music_decision: mode, decision_reason: 'scene reasons', segments: mode === 'none' ? [] : [{
          track: 'theme', source: prepared.bgm, start_seconds: 0, end_seconds: 114.733332,
        }] }] })),
      writePlaceholder(mixProfile, JSON.stringify({ schema_version: 1, mode: mode === 'none' ? 'no_bgm' : 'legacy',
        analysis_window_ms: 100, music_gain: 0.3 })),
      ...(mode === 'none' ? [] : [writePlaceholder(bgmGeneration, '{"method":"compose"}')]),
    ])
    const rendered = await runDramaRender({ method: 'render', project: prepared.project, episode: 2,
      timeline: prepared.timeline, subtitleSrt: prepared.subtitle, lastShot: 2, bgm: prepared.bgm, bgmPlan, bgmGeneration, mixProfile,
      endingAudio: prepared.endingAudio, endingEffect: prepared.endingEffect, output: prepared.output, resume: true,
    }, { ...settings, channel: channel.channel })
    const record = await readSourceRecord(sourceRecordPathFor(rendered.output))
    expect(record?.delivery_inputs?.music).toEqual({ mode, gain: mode === 'none' ? 0 : 0.3, plan_path: bgmPlan,
      ...(mode === 'none' ? {} : { bed_path: prepared.bgm, generation_path: bgmGeneration }),
    })
    expect(record?.input_files).toContainEqual({ path: bgmPlan, sha256: await fileSha256(bgmPlan) })
    expect(record?.input_files?.some(file => file.path === bgmGeneration)).toBe(mode === 'music')
    expect(channel.calls.some(call => call.args.includes(prepared.bgm))).toBe(mode === 'music')
  })

  it('allocates a different candidate when the source subtitles change and reuses the new one on replay', async () => {
    const prepared = await preparedProject()
    const channel = renderChannel(prepared, { resume: true })
    const first = await render(prepared, channel, false, undefined, { resume: true })
    const initial = await readFile(sourceRecordPathFor(first.output), 'utf8')
    await writePlaceholder(prepared.subtitle, srtDocument([{ start: '00:00:02,680', end: '00:00:03,580', text: '修订' }]))
    const second = await render(prepared, channel, false, undefined, { resume: true })
    expect(second.ok).toBe(true)
    expect(second.output).not.toBe(first.output)
    expect(await readFile(sourceRecordPathFor(first.output), 'utf8')).toBe(initial)
    const next = await render(prepared, channel, false, undefined, { resume: true })
    expect(next).toMatchObject({ ok: true, output: second.output, written: [] })
  })

  it('preserves an older resume receipt without archive evidence and returns a stageable candidate', async () => {
    const prepared = await preparedProject()
    const channel = renderChannel(prepared, { resume: true })
    const first = await render(prepared, channel, false, undefined, { resume: true })
    const oldPath = sourceRecordPathFor(first.output)
    const record = await readSourceRecord(oldPath)
    if (record === undefined) throw new Error('Fixture did not produce a render receipt')
    const { delivery_inputs: _inputs, input_files: _files, ...legacy } = record
    const unchanged = JSON.stringify(legacy)
    await writePlaceholder(oldPath, unchanged)

    const next = await render(prepared, channel, false, undefined, { resume: true })
    expect(next.output).not.toBe(first.output)
    expect(await readFile(oldPath, 'utf8')).toBe(unchanged)
    expect(await readSourceRecord(sourceRecordPathFor(next.output))).toMatchObject({
      delivery_inputs: record.delivery_inputs, input_files: record.input_files,
    })
    const resumed = await render(prepared, channel, false, undefined, { resume: true })
    expect(resumed).toMatchObject({ output: next.output, written: [] })
  })

  it('preserves a torn output and a candidate whose receipt is bound to another episode', async () => {
    const prepared = await preparedProject()
    const channel = renderChannel(prepared, { resume: true })
    await writePlaceholder(prepared.output, 'surviving output from a torn prior publication')
    const first = await render(prepared, channel, false, undefined, { resume: true })
    expect(first.output).not.toBe(prepared.output)
    expect(await readFile(prepared.output, 'utf8')).toBe('surviving output from a torn prior publication')
    const firstRecordPath = sourceRecordPathFor(first.output)
    const mismatched = { ...await readSourceRecord(firstRecordPath), episode: '03' }
    await writePlaceholder(firstRecordPath, JSON.stringify(mismatched))
    const next = await render(prepared, channel, false, undefined, { resume: true })
    expect(next.output).not.toBe(first.output)
    expect(await readFile(firstRecordPath, 'utf8')).toBe(JSON.stringify(mismatched))
    expect(await readFile(first.output, 'utf8')).toBe('media')
  })

  it('refuses an external output before media commands or writing an overlay', async () => {
    const prepared = await preparedProject()
    const external = await tempProject()
    temporary.push(external)
    const output = join(external, 'final.mp4')
    await writePlaceholder(output, 'external media')
    const channel = renderChannel(prepared, { resume: true })
    await expect(render(prepared, channel, false, undefined, {
      output, resume: true, subtitlePlan: join(prepared.project, 'missing-overlay.json'),
    })).rejects.toThrow('输出必须位于项目目录内')
    expect(channel.calls).toEqual([])
    expect(await readFile(output, 'utf8')).toBe('external media')
  })

  it.each([1, undefined])('renders no_bgm with profile gain %s and project fallback without opening music or replacing output', async (originalGain) => {
    const prepared = await preparedProject()
    await writePlaceholder(join(prepared.project, 'project_config.json'), JSON.stringify({
      project_bible: { delivery: { audio: { master_gain: 0.7, bgm_gain: 0.1 } } },
    }))
    await rm(prepared.bgm)
    const profile = join(prepared.project, 'audio', 'no-music.json')
    await writePlaceholder(profile, JSON.stringify({ schema_version: 1, mode: 'no_bgm',
      ...(originalGain === undefined ? {} : { original_gain: originalGain }), analysis_window_ms: 100 }))
    const channel = renderChannel(prepared)
    const subtitlePlan = join(prepared.project, 'subtitle-plan.json')
    await writePlaceholder(subtitlePlan, JSON.stringify({ schema_version: 1, decisions: [] }))
    const report = await runDramaRender({ method: 'render', project: prepared.project, episode: 2,
      timeline: prepared.timeline, subtitleSrt: prepared.subtitle, subtitlePlan, lastShot: 2,
      mixProfile: profile, bgmPlan: join(prepared.project, 'missing-plan.json'),
      endingAudio: prepared.endingAudio, endingEffect: prepared.endingEffect, output: prepared.output },
    { ...settings, channel: channel.channel })
    expect(report.audio_mix).toMatchObject({ mode: 'no_bgm', original_audio: prepared.paths.masterAudio,
      music_audio: '', music_stem: '', detector: 'none' })
    expect(report.bgm_plan.path).toBe('')
    expect(report.subtitle_overlay?.plan_path).toBe(subtitlePlan)
    expect(report.written).toContain(report.subtitle_overlay?.resolved_srt)
    expect(report.render_preview?.audio).toMatchObject({ master_gain: originalGain ?? 0.7, bgm_gain: 0,
      bgm_path: '', bgm_plan_path: '' })
    expect(report.warnings.join('\n')).not.toContain('尚未提供 BGM')
    expect(report.warnings.join('\n')).not.toContain('未提供 bgm_plan')
    expect(channel.calls.some(call => call.args.includes(prepared.bgm))).toBe(false)
    const final = channel.calls.find(call => call.args.includes('-filter_complex') && call.args.includes('aac'))
    expect(final?.args[final.args.indexOf('-filter_complex') + 1]).not.toContain('sidechaincompress')
    const before = await readFile(prepared.output)
    await expect(render(prepared, renderChannel(prepared), false, undefined, { mixProfile: profile }))
      .rejects.toThrow('不会覆盖')
    expect(await readFile(prepared.output)).toEqual(before)
  })

  it('rejects missing music unless the explicit audio profile selects no_bgm', async () => {
    const prepared = await preparedProject()
    const { bgm: _bgm, ...withoutMusic } = prepared
    await expect(render(withoutMusic, renderChannel(prepared))).rejects.toThrow('需要 bgm')
  })

  it('publishes separate music stems and original-sound gains through the renderer method', async () => {
    const prepared = await preparedProject(), channel = renderChannel(prepared)
    const mixProfile = join(prepared.project, 'mix.json')
    await writePlaceholder(mixProfile, JSON.stringify({ schema_version: 1, mode: 'legacy',
      analysis_window_ms: 100, original_gain: 0.8, music_gain: 0.2 }))
    const report = await runDramaRender({ method: 'render', project: prepared.project, episode: 2,
      timeline: prepared.timeline, subtitleSrt: prepared.subtitle, lastShot: 2, mixProfile,
      bgm: prepared.bgm, endingAudio: prepared.endingAudio, endingEffect: prepared.endingEffect, output: prepared.output },
    { ...settings, channel: channel.channel })
    expect(report.audio_mix).toMatchObject({ mode: 'legacy', music_audio: prepared.bgm,
      music_stem: join(prepared.project, 'export/ep02.music-stem.wav') })
    expect(await readFile(report.audio_mix!.music_stem, 'utf8')).toBe('media')
    expect(await readFile(prepared.output, 'utf8')).toBe('muxed media')
    expect(report.written).toContain(report.audio_mix!.music_stem)
  })

  it.each(['output', 'stem'])('preserves a concurrent %s publication and rolls back only its own new links', async (conflict) => {
    const prepared = await preparedProject(), mixProfile = join(prepared.project, 'mix.json')
    await writePlaceholder(mixProfile, JSON.stringify({ schema_version: 1, mode: 'legacy', analysis_window_ms: 100 }))
    publication.target = conflict === 'output' ? prepared.output : join(prepared.project, 'export/ep02.music-stem.wav')
    await expect(render(prepared, renderChannel(prepared), false, undefined, { mixProfile })).rejects.toMatchObject({ code: 'EEXIST' })
    expect(await readFile(publication.target, 'utf8')).toBe('concurrent publication')
    if (conflict === 'stem') await expect(readFile(prepared.output)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(prepared.paths.masterAudio, 'utf8')).toBe('master')
  })

  it('refuses an animation timeline marking an included ending before media commands', async () => {
    const prepared = await preparedProject()
    await writePlaceholder(join(prepared.project, 'project_config.json'), JSON.stringify({ project_bible: { visual_medium: 'animation_3d' } }))
    await writePlaceholder(prepared.timeline, timelineJson([
      { shot: 1, startUs: 0, durationUs: 5_050_000 },
      { shot: 2, startUs: 5_050_000, durationUs: 109_683_332 },
    ], 112.733332))
    const channel = renderChannel(prepared)
    await expect(render(prepared, channel)).rejects.toThrow('仅保留正片镜头')
    expect(channel.calls).toEqual([])
  })

  it('renders 3D without ending assets, a stale ending, tail extraction, or watermark', async () => {
    const prepared = await preparedProject()
    await writePlaceholder(join(prepared.project, 'project_config.json'), JSON.stringify({ project_bible: { visual_medium: 'animation_3d' } }))
    await rm(prepared.endingAudio)
    await rm(prepared.endingEffect)
    await writePlaceholder(join(prepared.paths.cacheDir, 'ending.mp4'), 'stale ending')
    const channel = renderChannel(prepared, { durationSeconds: 114.733332 })
    const input = {
      toolkit: toolkit(channel), settings, project: prepared.project, episode: '02',
      timelinePath: prepared.timeline, subtitleSrt: prepared.subtitle, lastShot: 2, bgm: prepared.bgm,
      output: prepared.output, force: false,
    }
    const report = await renderEpisode(input)
    expect(report.ok).toBe(true)
    expect(report.expected_duration_seconds).toBe(114.733332)
    expect(report.tail_frame.path).toBe('')
    expect(report.warnings).toEqual([
      expect.stringContaining('未提供 bgm_plan'), expect.stringContaining('SRT 不携带字体样式'),
    ])
    const commands = channel.calls.flatMap(call => call.args).join(' ')
    expect(commands).not.toContain('ending_audio')
    expect(commands).not.toContain('ending_effect')
    expect(commands).not.toContain('-sseof')
    expect(commands).not.toContain('framemd5')
    expect(commands).toContain('amix=inputs=2')
    expect(commands).not.toContain('[3:a]')
    expect(await readFile(join(prepared.paths.cacheDir, 'concat.txt'), 'utf8')).not.toContain('ending.mp4')
    expect(await readFile(join(prepared.paths.cacheDir, 'display.ass'), 'utf8')).not.toContain('Watermark')
  })

  it('retains the prior delivery and refuses a cache identity when a selected source changes during encoding', async () => {
    const prepared = await preparedProject()
    await writePlaceholder(prepared.output, 'previous delivery')
    const source = join(prepared.paths.videoDir, 'shot_001.mp4')
    const cached = join(prepared.paths.cacheDir, 'shot_001.mp4')
    const base = renderChannel(prepared)
    const channel: ReturnType<typeof stubChannel> = { calls: base.calls, channel: {
      async run(command, args) {
        const outcome = await base.channel.run(command, args)
        if (args.at(-1) === cached) await writePlaceholder(source, 'replacement generation')
        return outcome
      },
    } }
    await expect(render(prepared, channel)).rejects.toThrow('编码期间源视频发生变化')
    expect(await readFile(prepared.output, 'utf8')).toBe('previous delivery')
    await expect(readFile(`${cached}.identity`)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(`${prepared.output}.source-record.json`)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(channel.calls.some(call => call.args.includes('-movflags'))).toBe(false)
  })
  it.each(['source', 'ending', 'subtitled'])('keeps the old delivery when a %s ban arrives during final mux', async (kind) => {
    const prepared = await preparedProject()
    await writePlaceholder(prepared.output, 'previous delivery')
    const { runDramaVideo } = await import('../src/video.ts')
    const base = renderChannel(prepared)
    const channel: ReturnType<typeof stubChannel> = { calls: base.calls, channel: {
      async run(command, args) {
        const result = await base.channel.run(command, args)
        if (args.at(-1) === join(prepared.paths.cacheDir, 'ending.mp4')) {
          await writePlaceholder(join(prepared.paths.cacheDir, 'ending.mp4'), 'distinct ending')
        }
        if (args.at(-1) === join(prepared.paths.cacheDir, 'subtitled.mp4')) {
          await writePlaceholder(join(prepared.paths.cacheDir, 'subtitled.mp4'), 'distinct subtitled')
        }
        if (args.includes('-movflags')) {
          await runDramaVideo({ method: 'ban', project: prepared.project,
            video: kind === 'source' ? join(prepared.paths.videoDir, 'shot_001.mp4')
              : join(prepared.paths.cacheDir, `${kind}.mp4`), labels: ['人物对调'] })
        }
        return result
      },
    } }
    await expect(render(prepared, channel)).rejects.toThrow('人物对调')
    expect(await readFile(prepared.output, 'utf8')).toBe('previous delivery')
  })

  it('rechecks user bans before final mux when a ban arrives during encoding', async () => {
    const prepared = await preparedProject()
    const { runDramaVideo } = await import('../src/video.ts')
    const base = renderChannel(prepared)
    const channel: ReturnType<typeof stubChannel> = { calls: base.calls, channel: {
      async run(command, args) {
        const result = await base.channel.run(command, args)
        if (args.at(-1)?.endsWith('subtitled.mp4')) {
          await runDramaVideo({ method: 'ban', project: prepared.project,
            video: join(prepared.paths.videoDir, 'shot_001.mp4'), labels: ['字幕错误'] })
        }
        return result
      },
    } }
    await expect(render(prepared, channel)).rejects.toThrow('字幕错误')
    expect(channel.calls.some(call => call.args.at(-1) === prepared.output)).toBe(false)
  })

  it('refuses a directly banned encoded cache before reusing it', async () => {
    const prepared = await preparedProject()
    await render(prepared, renderChannel(prepared))
    const { runDramaVideo } = await import('../src/video.ts')
    await runDramaVideo({ method: 'ban', project: prepared.project,
      video: join(prepared.paths.cacheDir, 'shot_001.mp4'), labels: ['缓存字幕错误'] })
    await expect(render(prepared, renderChannel(prepared))).rejects.toThrow('缓存字幕错误')
  })

  it('refuses a banned prepared copy even when its encoded cache already exists', async () => {
    const prepared = await preparedProject()
    await render(prepared, renderChannel(prepared))
    const { fileSha256 } = await import('../src/cache.ts')
    const source = join(prepared.paths.videoDir, 'shot_001.mp4')
    await writePlaceholder(join(prepared.project, 'video-bans.json'), JSON.stringify({ version: 1, videos: [{
      sha256: await fileSha256(source), video: source, labels: ['人物对调'], reason: '用户禁用',
      banned: true, updated_at: new Date().toISOString(),
    }] }))
    const channel = renderChannel(prepared)
    await expect(render(prepared, channel)).rejects.toThrow('人物对调')
    expect(channel.calls).toEqual([])
    const { runDramaVideo } = await import('../src/video.ts')
    await runDramaVideo({ method: 'unban', project: prepared.project, video: source })
    expect((await render(prepared, renderChannel(prepared))).reused_shots).toEqual([1, 2])
    await runDramaVideo({ method: 'ban', project: prepared.project, video: source, labels: ['人物对调'] })
    await writePlaceholder(source, 'new generation at the same path')
    const replacement = await render(prepared, renderChannel(prepared))
    expect(replacement.ok).toBe(true)
    expect(replacement.encoded_shots).toEqual([1])
    expect(replacement.not_checked).toContain('content_review')
  })

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
    expect(report.written).toEqual([prepared.output, `${prepared.output}.source-record.json`,
      prepared.paths.renderLog])
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
    // The burn chain ends on the rate filters, so nothing after the subtitles can
    // anchor the picture back to the source frame rate.
    expect(burnFilter.endsWith('scale=1440:2560:flags=lanczos,tpad=stop_mode=clone:stop_duration=0.016666667,fps=60,setpts=N/(60*TB)')).toBe(true)
    expect(await readFile(join(prepared.paths.cacheDir, 'display.ass'), 'utf8')).toContain('内容由AI生成')

    const mux = channel.calls.find(call => call.args.includes('+faststart'))
    expect(mux?.args.slice(0, 4)).toEqual(['-y', '-v', 'error', '-i'])
    expect(mux?.args[mux.args.indexOf('-filter_complex') + 1] ?? '')
      .toContain('alimiter=limit=0.95:level=false[a]')
    expect(mux?.args).toContain('+faststart')
    expect(mux?.args.at(-1)).toContain('.drama-render-')
    expect(mux?.args.at(-1)).not.toBe(prepared.output)
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
    expect(second.summary).toEqual({ shots: 2, encoded: 0, reused: 2, checks: 5, failed_checks: 0, warnings: 2 })

    const forced = await render(prepared, renderChannel(prepared), true)
    expect(forced.encoded_shots).toEqual([1, 2])
    expect(forced.reused_shots).toEqual([])
  })

  it('invalidates cached pictures when selected source bytes change', async () => {
    const prepared = await preparedProject()
    await render(prepared, renderChannel(prepared))
    await writePlaceholder(join(prepared.paths.videoDir, 'shot_001.mp4'), 'clean replacement')
    const report = await render(prepared, renderChannel(prepared))
    expect(report.encoded_shots).toEqual([1])
    expect(report.reused_shots).toEqual([2])
  })

  it('does not reuse a partial cache after a failed forced encode', async () => {
    const prepared = await preparedProject()
    await render(prepared, renderChannel(prepared))
    const broken = stubChannel([
      // The ending checks run before the encode, so the failure has to be the encode itself.
      probeHandler({ [prepared.endingEffect]: { durationSeconds: 1.02 },
        [join(prepared.paths.videoDir, 'shot_001.mp4')]: { video: {} },
        [join(prepared.paths.videoDir, 'shot_002.mp4')]: { video: {} } }),
      call => (call.args.includes('lavfi') ? {} : undefined),
      call => (call.command === 'ffmpeg' ? { code: 1, stderr: 'encode interrupted', after: async () => {
        await writePlaceholder(call.args.at(-1) ?? '', 'partial')
      } } : undefined),
    ])
    await expect(render(prepared, broken, true)).rejects.toThrow('encode interrupted')
    const report = await render(prepared, renderChannel(prepared))
    expect(report.encoded_shots).toEqual([1])
    expect(report.reused_shots).toEqual([2])
  })

  it('invalidates cached pictures when durations or encoder arguments change', async () => {
    const prepared = await preparedProject()
    await render(prepared, renderChannel(prepared))
    await writePlaceholder(prepared.timeline, timelineJson([
      { shot: 1, startUs: 0, durationUs: 6_050_000 },
      { shot: 2, startUs: 6_050_000, durationUs: 108_683_332 },
    ], 114.733332))
    expect((await render(prepared, renderChannel(prepared))).encoded_shots).toEqual([1, 2])
    expect((await render(prepared, renderChannel(prepared, { gpu: false }))).encoded_shots).toEqual([1, 2])
  })

  it('reports optional BGM segments and repeated sequences as advice, not listening approval', async () => {
    const prepared = await preparedProject()
    const bgmPlan = join(prepared.project, 'bgm-plan.json')
    const segments = [{ track: 'song', source: prepared.bgm, start_seconds: 0, end_seconds: 114.733332, reason: 'quiet scene' }]
    await writePlaceholder(bgmPlan, JSON.stringify({ episodes: [
      { episode: '02', body_duration_seconds: 114.733332, segments },
      { episode: '03', body_duration_seconds: 114.733332, segments },
    ] }))
    const report = await render(prepared, renderChannel(prepared), false, bgmPlan)
    expect(report.bgm_plan).toMatchObject({ path: bgmPlan, segments, repeated_sequence_episodes: ['03'] })
    expect(report.bgm_plan.bed_sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(report.bgm_plan.intended_use).toBe('unknown')
    expect(report.bgm_plan.segments[0]?.license_info).toMatchObject({ status: 'unknown', commercial_use: 'unknown' })
    expect(report.bgm_plan.license_records[0]?.warnings).toContain('音乐授权信息未知或不完整；不能据此认定已获使用授权。')
    expect(report.not_checked).toContain('bgm_listening')
    expect(report.not_checked).not.toContain('bgm_plan')
    expect(report.ok).toBe(true)
  })

  it('rejects BGM plans with out-of-bounds segments before any encode', async () => {
    const prepared = await preparedProject()
    const bgmPlan = join(prepared.project, 'bgm-plan.json')
    await writePlaceholder(bgmPlan, JSON.stringify({ episodes: [
      { episode: '02', body_duration_seconds: 114.733332,
        segments: [{ track: 'song', source: prepared.bgm, start_seconds: 2, end_seconds: 120, reason: 'quiet scene' }] },
    ] }))
    const channel = renderChannel(prepared)
    await expect(render(prepared, channel, false, bgmPlan)).rejects.toThrow('BGM')
    expect(channel.calls).toHaveLength(0)
  })

  it('reports unchecked QA independently of a successful render', async () => {
    const prepared = await preparedProject()
    const report = await render(prepared, renderChannel(prepared))
    expect(report.ok).toBe(true)
    expect(report.not_checked).toEqual(expect.arrayContaining([
      'black_frames', 'silence', 'subtitle_bounds', 'speech_alignment', 'embedded_subtitles', 'bgm_listening',
    ]))
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
    expect(report.warnings).toEqual([
      expect.stringContaining('未提供 bgm_plan'), expect.stringContaining('SRT 不携带字体样式'),
      expect.stringContaining('已改用顺序解码的最后一帧'),
    ])
    expect(report.summary.warnings).toBe(3)
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

  it('refuses a substituted ending effect before any encode', async () => {
    const prepared = await preparedProject()
    const substituted = join(prepared.project, 'assets', 'substituted.mp4')
    await writePlaceholder(substituted, 'some other ending')
    const channel = renderChannel(prepared)
    await expect(render(prepared, channel, false, undefined, { endingEffect: substituted }))
      .rejects.toThrow('片尾特效不是随包素材')
    expect(channel.calls).toEqual([])
  })

  it('refuses a substituted ending sound before any encode', async () => {
    const prepared = await preparedProject()
    const substituted = join(prepared.project, 'audio', 'substituted.mp3')
    await writePlaceholder(substituted, 'some other ending sound')
    const channel = renderChannel(prepared)
    await expect(render(prepared, channel, false, undefined, { endingAudio: substituted }))
      .rejects.toThrow('片尾音不是随包素材')
    expect(channel.calls).toEqual([])
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

  it('falls back to the proved sequential tail when seek writes no file', async () => {
    const prepared = await preparedProject()
    const report = await render(prepared, renderChannel(prepared, { seekWrites: false }))
    expect(report.tail_frame.from_sequential_decode).toBe(true)
    expect(report.tail_frame.matches_sequential_tail).toBe(true)
    expect(report.warnings).toContain(
      'sseof 抽到的帧不是真实尾帧，已改用顺序解码的最后一帧作为片尾定格（见 tail_frame 字段）。',
    )
  })
})
