/** Public Loader paths for advisory glyph previews and production render integration. */
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools, { validateJsonSchemaValue, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import * as Render from '../src/index.ts'
import * as Media from '../src/ffmpeg.ts'
import type { DramaRenderReport, DeliverySubtitleVisual, MediaToolkit } from '../src/types.ts'
import type { SubtitleLayoutReport } from '../src/subtitle-layout.ts'
import { placeholderHandler, probeHandler, runContext, stubChannel } from './harness.ts'
import { createMediaRunner } from './audio-ffmpeg-harness.ts'

const visual: DeliverySubtitleVisual = { schema_version: 1, reference_width: 320, reference_height: 180,
  font_size_px: 30, outline_px: 2, center_y_ratio: 0.65, max_width_ratio: 0.8, font_family: 'Arial' }

async function fixture(profile: DeliverySubtitleVisual | { readonly schema_version?: never } | undefined,
  config: { ffmpegPath?: string; ffprobePath?: string; fontsDir?: string; subtitleFontFamily?: string } = {},
  shutdown?: () => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'drama-layout-loader-')), ctx = new Context()
  onTestFinished(async () => { await shutdown?.(); await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  const delivery = { visual_medium: 'animation_3d', width: 320, height: 180, fps: 12,
    ...(profile === undefined ? {} : { subtitle_visual: profile }) }
  await writeFile(join(root, 'project_config.json'), JSON.stringify({ project_bible: { visual_medium: 'animation_3d', delivery } }))
  await mkdir(join(root, 'editing'))
  await mkdir(join(root, 'audio'))
  await mkdir(join(root, 'video', '01'), { recursive: true })
  await writeFile(join(root, 'editing', '01-timeline.json'), JSON.stringify({ clips: [{ shot: 1, start_us: 0, duration_us: 1000000 }],
    body_end: 1, delivery }))
  await writeFile(join(root, 'editing', '01.srt'), '1\n00:00:00,000 --> 00:00:00,400\nWWWW\n\n2\n00:00:00,500 --> 00:00:00,900\niiii\n')
  await writeFile(join(root, 'audio', '01.wav'), 'original audio fixture')
  await writeFile(join(root, 'video', '01', 'shot_001.mp4'), 'original video fixture')
  await writeFile(join(root, 'bed.wav'), 'pure music fixture')
  const configuration = join(root, 'cordis.yml')
  await writeFile(configuration, [
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-tool-episode-render'",
    `  config: ${JSON.stringify({ preferNvenc: false, ...config })}`, '',
  ].join('\n'))
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  ctx.loader.internal = {
    version: 'v2', loadCache: new Map(),
    register() { throw new Error('Unexpected loader hooks') },
    getOrCreateModuleJob() { throw new Error('Unexpected loader job') },
    resolveSync() { throw new Error('Unexpected loader resolution') },
    load() { throw new Error('Unexpected loader load') },
    async import(specifier: string) {
      if (specifier === '@deepseek-ai/dsh-system-prompt') return SystemPrompt
      if (specifier === '@deepseek-ai/dsh-tools') return Tools
      if (specifier === '@deepseek-ai/dsh-tool-episode-render') return Render
      throw new Error(`Unexpected module: ${specifier}`)
    },
  }
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configuration).href } })
  await ctx.loader.await()
  for (const entry of ctx.loader.entries()) await entry.fiber?.await()
  const tool = ctx.tools.get('drama_render')
  if (tool === undefined) throw new Error('Missing Loader-owned drama_render')
  return { root, ctx, tool, output: join(root, 'exports', 'candidate.mp4') }
}

async function invoke(tool: ToolDefinition, args: Record<string, string | number>) {
  expect(validateJsonSchemaValue(tool.parameters, args, '')).toEqual([])
  const result = await tool.execute(args, runContext())
  expect(validateJsonSchemaValue(tool.output.schema, result, '')).toEqual([])
  return result as DramaRenderReport
}

function externalStub(output: string, layoutCode = 0) {
  return stubChannel([
    probeHandler({ [output]: { durationSeconds: 1, sizeBytes: 1_000_000, bitRateBps: 8_000_000,
      video: { width: 320, height: 180, fps: 12 }, audio: {} } }),
    call => call.args.some(argument => argument.includes('bbox=min_val=1')) ? {
      code: layoutCode, stderr: layoutCode === 0
        ? 'fontselect: (Arial, 400, 0) -> ArialMT, 0, ArialMT\n[Parsed_bbox] x1:200 x2:599 y1:50 y2:79 w:400 h:30'
        : 'layout-only decoder failure\nfull native diagnostics',
      after: async () => {
        if (layoutCode === 0) for (const file of call.args.filter(argument => argument.endsWith('.png'))) await writeFile(file, 'probe image')
      },
    } : undefined,
    placeholderHandler(),
  ])
}

it('runs standalone layout through Loader, returns a closed compact schema and preserves previous previews', async () => {
  const input = await fixture(visual), external = externalStub(input.output)
  const factory = vi.spyOn(Media, 'createMediaToolkit').mockReturnValue({ ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', channel: external.channel })
  onTestFinished(() => { factory.mockRestore() })
  const subtitle = join(input.root, 'editing', '01.srt'), before = await readFile(subtitle)
  const args = { method: 'subtitle_layout', project: input.root, episode: 1,
    timeline: 'editing/01-timeline.json', subtitle_srt: 'editing/01.srt' }
  const first = await invoke(input.tool, args)
  expect(first).toMatchObject({ ok: true, method: 'subtitle_layout', output: '',
    subtitle_layout: { status: 'measured', distinct_texts: 2, measured_texts: 2, overwidth_cue_indexes: [1, 2], uncertain_cue_indexes: [] } })
  expect(first.subtitle_layout?.preview_paths).toHaveLength(2)
  expect(first.subtitle_layout?.preview_paths.every(path => path.endsWith('.delivery.png'))).toBe(true)
  expect(first.warnings.join('\n')).toContain('超过项目可用宽')
  const reportPath = first.subtitle_layout!.report_path, reportBytes = await readFile(reportPath)
  const saved = JSON.parse(reportBytes.toString('utf8')) as SubtitleLayoutReport
  expect(first.subtitle_layout?.preview_paths).toEqual(saved.entries.map(entry => entry.files.delivery_preview))
  const second = await invoke(input.tool, args)
  expect(second.subtitle_layout?.report_path).not.toBe(reportPath)
  expect(await readFile(reportPath)).toEqual(reportBytes)
  expect(await readFile(subtitle)).toEqual(before)
  expect(external.calls.every(call => call.args.some(argument => argument.includes('bbox=min_val=1')))).toBe(true)
  expect(validateJsonSchemaValue(input.tool.output.schema,
    { ...first, subtitle_layout: { ...first.subtitle_layout, undeclared_raw_log: 'must reject' } }, '').length).toBeGreaterThan(0)
  const entry = [...input.ctx.loader.entries()].find(item => item.options.name === '@deepseek-ai/dsh-tool-episode-render')
  await entry?.fiber?.dispose()
  expect(input.ctx.tools.get('drama_render')).toBeUndefined()
})

it('keeps native render output when its advisory layout subprocess fails and exposes complete error evidence', async () => {
  const input = await fixture(visual), external = externalStub(input.output, 7)
  const factory = vi.spyOn(Media, 'createMediaToolkit').mockReturnValue({ ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', channel: external.channel })
  onTestFinished(() => { factory.mockRestore() })
  const result = await invoke(input.tool, { method: 'render', project: input.root, episode: 1,
    timeline: 'editing/01-timeline.json', subtitle_srt: 'editing/01.srt', last_shot: 1, bgm: 'bed.wav', output: input.output })
  expect(result).toMatchObject({ ok: true, output: input.output, subtitle_layout: { status: 'partial', measured_texts: 0,
    overwidth_cue_indexes: [], uncertain_cue_indexes: [1, 2], preview_paths: [] } })
  expect(await readFile(input.output, 'utf8')).toBe('media')
  expect(result.warnings.join('\n')).toContain('退出码 7')
  expect(result.failures).toEqual([])
  expect(await readFile(result.subtitle_layout!.stderr_paths[0]!, 'utf8')).toBe('layout-only decoder failure\nfull native diagnostics')
  expect(result.written).toContain(result.subtitle_layout!.report_path)
  expect(await readFile(result.log_path, 'utf8')).toContain('subtitle_layout=')
})

it.each([undefined, {}])('leaves legacy render return fields and media calls unchanged for profile %j', async (profile) => {
  const input = await fixture(profile), external = externalStub(input.output)
  const factory = vi.spyOn(Media, 'createMediaToolkit').mockReturnValue({ ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', channel: external.channel })
  onTestFinished(() => { factory.mockRestore() })
  const result = await invoke(input.tool, { method: 'render', project: input.root, episode: 1,
    timeline: 'editing/01-timeline.json', subtitle_srt: 'editing/01.srt', last_shot: 1, bgm: 'bed.wav', output: input.output })
  expect(result.ok).toBe(true)
  expect(result).not.toHaveProperty('subtitle_layout')
  expect(external.calls.some(call => call.args.some(argument => argument.includes('bbox=min_val=1')))).toBe(false)
})

it('reports disabled standalone layout without launching media and requires its actual input paths', async () => {
  const input = await fixture({}), external = externalStub(input.output)
  const factory = vi.spyOn(Media, 'createMediaToolkit').mockReturnValue({ ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', channel: external.channel })
  onTestFinished(() => { factory.mockRestore() })
  const result = await invoke(input.tool, { method: 'subtitle_layout', project: input.root, episode: 1,
    timeline: 'editing/01-timeline.json', subtitle_srt: 'editing/01.srt' })
  expect(result).toMatchObject({ ok: true, written: [], subtitle_layout: { status: 'not_requested', report_path: '', distinct_texts: 0 } })
  expect(external.calls).toEqual([])
  expect(() => Render.resolveCall({ method: 'subtitle_layout', project: input.root, episode: 1 })).toThrow('timeline')
})

const ffmpeg = process.env.DSH_FFMPEG_PATH, ffprobe = process.env.DSH_FFPROBE_PATH
const fonts = ffmpeg === undefined ? '' : join(dirname(ffmpeg), '../../fonts')
const nativeAvailable = Boolean(ffmpeg && ffprobe && existsSync(join(fonts, 'NotoSansCJKsc-Regular.otf')))

it.skipIf(!nativeAvailable)('uses the public Loader tool with real deployed FFmpeg/Noto to produce measured glyph PNGs', async () => {
  if (!ffmpeg || !ffprobe) throw new Error('Native test requires explicit bundled runtime paths')
  const owner = createMediaRunner()
  const input = await fixture({ ...visual, font_family: 'Noto Sans CJK SC' },
    { ffmpegPath: ffmpeg, ffprobePath: ffprobe, fontsDir: fonts, subtitleFontFamily: 'Noto Sans CJK SC' }, owner.dispose)
  const toolkit: MediaToolkit = { ffmpeg, ffprobe, channel: { run: async (command, args) => {
    const result = await owner.runCommand(command, args)
    expect(result.interrupted, result.stderr).toBe(false)
    expect(result.signal, result.stderr).toBeNull()
    return result
  } } }
  const factory = vi.spyOn(Media, 'createMediaToolkit').mockReturnValue(toolkit)
  onTestFinished(() => { factory.mockRestore() })
  const result = await invoke(input.tool, { method: 'subtitle_layout', project: input.root, episode: 1,
    timeline: 'editing/01-timeline.json', subtitle_srt: 'editing/01.srt' })
  expect(result).toMatchObject({ ok: true, subtitle_layout: { status: 'measured', measured_texts: 2 } })
  const report = JSON.parse(await readFile(result.subtitle_layout!.report_path, 'utf8')) as SubtitleLayoutReport
  expect(report.entries[0]?.ink_bounds?.width).toBeGreaterThan((report.entries[1]?.ink_bounds?.width ?? Infinity) * 2)
  for (const preview of result.subtitle_layout!.preview_paths) {
    const png = await readFile(preview)
    expect(png.subarray(1, 4).toString()).toBe('PNG')
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([320, 180])
  }
  expect(report.entries[0]?.fontselect_trace.join('\n')).toContain('Noto')
}, 60_000)
