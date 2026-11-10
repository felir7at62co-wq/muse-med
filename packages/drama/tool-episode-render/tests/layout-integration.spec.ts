/** Public Loader paths for advisory glyph previews and production render integration. */
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
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
import * as Layout from '../src/subtitle-layout.ts'
import type { DramaRenderReport, DeliverySubtitleVisual, MediaToolkit } from '../src/types.ts'
import type { SubtitleLayoutReport } from '../src/subtitle-layout.ts'
import { decodeHandler, placeholderHandler, probeHandler, runContext, stubChannel } from './harness.ts'
import { createMediaRunner } from './audio-ffmpeg-harness.ts'
import { fileSha256 } from '../src/cache.ts'
import { buildSourceRecord, sourceRecordPathFor, writeSourceRecord } from '../src/source-record.ts'

const visual: DeliverySubtitleVisual = { schema_version: 1, reference_width: 320, reference_height: 180,
  font_size_px: 30, outline_px: 2, center_y_ratio: 0.65, max_width_ratio: 0.8, font_family: 'Arial' }

async function fixture(profile: DeliverySubtitleVisual | { readonly schema_version?: never } | undefined,
  config: {
    normalizeSubtitleText?: boolean
    ffmpegPath?: string
    ffprobePath?: string
    fontsDir?: string
    subtitleFontFamily?: string
  } = {},
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

function externalStub(output: string, layoutCode = 0, layoutStderr?: string) {
  return stubChannel([
    probeHandler({
      [join(output, '..', '..', 'video', '01', 'shot_001.mp4')]: { durationSeconds: 1, video: { fps: 12 } },
      [output]: { durationSeconds: 1, sizeBytes: 1_000_000, bitRateBps: 8_000_000,
        video: { width: 320, height: 180, fps: 12 }, audio: {} },
    }),
    call => call.args.some(argument => argument.includes('bbox=min_val=1')) ? {
      code: layoutCode, stderr: layoutCode === 0
        ? layoutStderr ?? 'fontselect: (Arial, 400, 0) -> ArialMT, 0, ArialMT\n[Parsed_bbox] x1:200 x2:599 y1:50 y2:79 w:400 h:30'
        : 'layout-only decoder failure\nfull native diagnostics',
      after: async () => {
        if (layoutCode === 0) for (const file of call.args.filter(argument => argument.endsWith('.png'))) await writeFile(file, 'probe image')
      },
    } : undefined,
    decodeHandler(1),
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

it('measures normalized display text without rewriting the authored subtitle', async () => {
  const input = await fixture(visual, { normalizeSubtitleText: true }), external = externalStub(input.output)
  const factory = vi.spyOn(Media, 'createMediaToolkit').mockReturnValue({ ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', channel: external.channel })
  onTestFinished(() => { factory.mockRestore() })
  const subtitle = join(input.root, 'editing', '01.srt')
  const authored = '1\n00:00:00,000 --> 00:00:00,400\n你好，\n世界！\n'
  await writeFile(subtitle, authored)
  const result = await invoke(input.tool, { method: 'subtitle_layout', project: input.root, episode: 1,
    timeline: 'editing/01-timeline.json', subtitle_srt: 'editing/01.srt' })
  const saved = JSON.parse(await readFile(result.subtitle_layout?.report_path ?? '', 'utf8')) as SubtitleLayoutReport
  expect(saved.entries.map(entry => entry.text)).toEqual(['你好 世界'])
  expect(await readFile(subtitle, 'utf8')).toBe(authored)
})

it('returns repair checks before encoding when layout fails and preserves the existing output', async () => {
  const input = await fixture(visual), external = externalStub(input.output, 7)
  await mkdir(join(input.root, 'exports'))
  await writeFile(input.output, 'previous reviewed delivery')
  const priorRecord = sourceRecordPathFor(input.output)
  await writeSourceRecord(priorRecord, buildSourceRecord({ episode: '01', output: input.output,
    outputSha256: await fileSha256(input.output), sizeBytes: (await stat(input.output)).size,
    durationSeconds: 1, inputs: [], encoder: 'retained', checks: [], now: new Date(0) }))
  const recordBytes = await readFile(priorRecord), oldFile = await stat(input.output), oldRecord = await stat(priorRecord)
  const factory = vi.spyOn(Media, 'createMediaToolkit').mockReturnValue({ ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', channel: external.channel })
  onTestFinished(() => { factory.mockRestore() })
  const result = await invoke(input.tool, { method: 'render', project: input.root, episode: 1,
    timeline: 'editing/01-timeline.json', subtitle_srt: 'editing/01.srt', last_shot: 1, bgm: 'bed.wav', output: input.output })
  expect(result).toMatchObject({ ok: false, output: '', encoded_shots: [], reused_shots: [], subtitle_layout: { status: 'partial', measured_texts: 0,
    overwidth_cue_indexes: [], uncertain_cue_indexes: [1, 2], preview_paths: [] } })
  expect(await readFile(input.output, 'utf8')).toBe('previous reviewed delivery')
  expect(await readFile(priorRecord)).toEqual(recordBytes)
  expect(await stat(input.output)).toMatchObject({ dev: oldFile.dev, ino: oldFile.ino })
  expect(await stat(priorRecord)).toMatchObject({ dev: oldRecord.dev, ino: oldRecord.ino })
  expect(result.warnings.join('\n')).toContain('退出码 7')
  expect(result.checks.find(check => check.id === 'subtitle_display_width')).toMatchObject({ ok: false, severity: 'failure' })
  expect(result.checks.map(({ id, severity, ok, fix }) => ({ id, severity, ok, fix }))).toMatchInlineSnapshot(`
    [
      {
        "fix": "",
        "id": "subtitle_display_text",
        "ok": true,
        "severity": "failure",
      },
      {
        "fix": "取得实际字形测量；超宽句仅按完整匹配的同源字词时间拆分后重试。缺真词证据时保留原文字和时码待复核，不缩字号、不换字体、不猜时间。",
        "id": "subtitle_display_width",
        "ok": false,
        "severity": "failure",
      },
      {
        "fix": "检查随包字体与 libass 字族选择日志后重试，保持配置的交付字族（Muse 直出为朱雀仿宋），不以系统替代字体交付。",
        "id": "subtitle_display_font",
        "ok": false,
        "severity": "failure",
      },
    ]
  `)
  expect(result.failures.join('\n')).toContain('缺真词证据')
  expect(external.calls.filter(call => call.command === 'ffprobe').map(call => call.args.at(-1)))
    .toEqual([join(input.root, 'video', '01', 'shot_001.mp4')])
  expect(external.calls.some(call => call.command === 'ffmpeg')).toBe(true)
  expect(external.calls.every(call => call.command === 'ffprobe'
    || (call.command === 'ffmpeg' && call.args.some(argument => argument.includes('bbox=min_val=1'))))).toBe(true)
  expect(await readFile(result.subtitle_layout!.stderr_paths[0]!, 'utf8')).toBe('layout-only decoder failure\nfull native diagnostics')
  expect(result.written).toContain(result.subtitle_layout!.report_path)
  expect(await readFile(result.log_path, 'utf8')).toContain('subtitle_layout=')
})

it('returns pending repair when layout has no saved report without encoding the episode', async () => {
  const input = await fixture(visual), external = externalStub(input.output)
  const factory = vi.spyOn(Media, 'createMediaToolkit').mockReturnValue({ ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', channel: external.channel })
  const measurement = vi.spyOn(Layout, 'measureSubtitleLayout').mockResolvedValueOnce({
    report: { schema_version: 1, status: 'not_measured', delivery_size: { width: 320, height: 180 },
      probe_size: { width: 960, height: 180 }, requested_font: 'Arial', entries: [], report_path: null },
    warnings: ['字幕字形测量未完成：证据目录不可写；保留已写证据，启用字幕视觉配置的交付仍需通过显示检查。'], written: [],
  })
  onTestFinished(() => { measurement.mockRestore(); factory.mockRestore() })
  const result = await invoke(input.tool, { method: 'render', project: input.root, episode: 1,
    timeline: 'editing/01-timeline.json', subtitle_srt: 'editing/01.srt', last_shot: 1, bgm: 'bed.wav', output: input.output })
  expect(result).toMatchObject({ ok: false, output: '', encoded_shots: [], reused_shots: [],
    subtitle_layout: { status: 'not_measured', report_path: '' } })
  expect(result.warnings.join('\n')).toContain('证据目录不可写')
  expect(await readFile(result.log_path, 'utf8')).toContain('subtitle_layout=(not saved) status=not_measured')
  expect(external.calls.map(call => ({ command: call.command, file: call.args.at(-1) })))
    .toEqual([{ command: 'ffprobe', file: join(input.root, 'video', '01', 'shot_001.mp4') }])
  expect(existsSync(input.output)).toBe(false)
})

it.each([
  ['overwide', 'fontselect: (Arial, 400, 0) -> ArialMT, 0, ArialMT\n[Parsed_bbox] x1:200 x2:599 y1:50 y2:79 w:400 h:30', 'subtitle_display_width'],
  ['wrong font', 'fontselect: (Arial, 400, 0) -> SystemFallback, 0, SystemFallback\n[Parsed_bbox] x1:200 x2:299 y1:50 y2:79 w:100 h:30', 'subtitle_display_font'],
  ['missing font trace', '[Parsed_bbox] x1:200 x2:299 y1:50 y2:79 w:100 h:30', 'subtitle_display_font'],
])('blocks $0 before episode encoding through the registered Loader tool', async (_label, trace, id) => {
  const input = await fixture(visual), external = externalStub(input.output, 0, trace)
  const factory = vi.spyOn(Media, 'createMediaToolkit').mockReturnValue({ ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', channel: external.channel })
  onTestFinished(() => { factory.mockRestore() })
  const authored = await readFile(join(input.root, 'editing', '01.srt'))
  const result = await invoke(input.tool, { method: 'render', project: input.root, episode: 1,
    timeline: 'editing/01-timeline.json', subtitle_srt: 'editing/01.srt', last_shot: 1, bgm: 'bed.wav', output: input.output })
  expect(result).toMatchObject({ ok: false, output: '', encoded_shots: [], reused_shots: [] })
  expect(result.checks.find(check => check.id === id)).toMatchObject({ ok: false, severity: 'failure' })
  expect(existsSync(input.output)).toBe(false)
  expect(await readFile(join(input.root, 'editing', '01.srt'))).toEqual(authored)
  expect(external.calls.filter(call => call.command === 'ffprobe').map(call => call.args.at(-1)))
    .toEqual([join(input.root, 'video', '01', 'shot_001.mp4')])
  expect(external.calls.some(call => call.command === 'ffmpeg')).toBe(true)
  expect(external.calls.every(call => call.command === 'ffprobe'
    || (call.command === 'ffmpeg' && call.args.some(argument => argument.includes('bbox=min_val=1'))))).toBe(true)
})

it.each(['你好\n世界', String.raw`你好\N世界`, '你好，世界！'])('rejects an unnormalized visual display %j before encoding', async (text) => {
  const input = await fixture(visual)
  const external = externalStub(input.output, 0, 'fontselect: (Arial, 400, 0) -> ArialMT, 0, ArialMT\n[Parsed_bbox] x1:200 x2:299 y1:50 y2:79 w:100 h:30')
  const factory = vi.spyOn(Media, 'createMediaToolkit').mockReturnValue({ ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', channel: external.channel })
  onTestFinished(() => { factory.mockRestore() })
  await writeFile(join(input.root, 'editing', '01.srt'), `1\n00:00:00,125 --> 00:00:00,875\n${text}\n`)
  const result = await invoke(input.tool, { method: 'render', project: input.root, episode: 1,
    timeline: 'editing/01-timeline.json', subtitle_srt: 'editing/01.srt', last_shot: 1, bgm: 'bed.wav', output: input.output })
  expect(result).toMatchObject({ ok: false, output: '', encoded_shots: [], reused_shots: [] })
  expect(result.checks.find(check => check.id === 'subtitle_display_text')).toMatchObject({ ok: false, severity: 'failure' })
  expect(external.calls.filter(call => call.command === 'ffprobe').map(call => call.args.at(-1)))
    .toEqual([join(input.root, 'video', '01', 'shot_001.mp4')])
  expect(external.calls.some(call => call.command === 'ffmpeg')).toBe(true)
  expect(external.calls.every(call => call.command === 'ffprobe'
    || (call.command === 'ffmpeg' && call.args.some(argument => argument.includes('bbox=min_val=1'))))).toBe(true)
})

it('renders normalized single-line dialogue with the bundled Zhuque face through Loader', async () => {
  const input = await fixture({ ...visual, font_family: 'Zhuque Fangsong (technical preview)' }, { normalizeSubtitleText: true })
  const external = externalStub(input.output, 0, 'fontselect: (Zhuque Fangsong (technical preview), 400, 0) -> ZhuqueFangsong-Regular, 0, ZhuqueFangsong-Regular\n[Parsed_bbox] x1:200 x2:299 y1:50 y2:79 w:100 h:30')
  const factory = vi.spyOn(Media, 'createMediaToolkit').mockReturnValue({ ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', channel: external.channel })
  onTestFinished(() => { factory.mockRestore() })
  const subtitle = join(input.root, 'editing', '01.srt')
  const authored = '1\n00:00:00,125 --> 00:00:00,875\n你好，\\N世界！\n'
  await writeFile(subtitle, authored)
  const result = await invoke(input.tool, { method: 'render', project: input.root, episode: 1,
    timeline: 'editing/01-timeline.json', subtitle_srt: 'editing/01.srt', last_shot: 1, bgm: 'bed.wav', output: input.output })
  expect(result).toMatchObject({ ok: true, output: input.output, encoded_shots: [1] })
  expect(result.checks.filter(check => check.id.startsWith('subtitle_display_')).every(check => check.ok)).toBe(true)
  expect(await readFile(subtitle, 'utf8')).toBe(authored)
  expect(await readFile(result.render_preview!.subtitle.path, 'utf8')).toBe('1\n00:00:00,125 --> 00:00:00,875\n你好 世界\n')
  const ass = await readFile(join(input.root, 'exports', '.render_cache', '01', 'display.ass'), 'utf8')
  expect(ass).toContain('Style: Default,Zhuque Fangsong (technical preview),')
  expect(ass).not.toContain('\\N')
})

it.each([
  { label: 'matching measured display', text: '价格99.9%', trace: 'ArialMT', width: 100, code: 0, failed: '' },
  { label: 'overwide stored display', text: '你好世界', trace: 'ArialMT', width: 400, code: 0, failed: 'subtitle_display_width' },
  { label: 'unmeasured stored display', text: '你好世界', trace: 'ArialMT', width: 100, code: 7, failed: 'subtitle_display_width' },
  { label: 'fallback font', text: '你好世界', trace: 'SystemFallback', width: 100, code: 0, failed: 'subtitle_display_font' },
  { label: 'physical multiline display', text: '你好\n世界', trace: 'ArialMT', width: 100, code: 0, failed: 'subtitle_display_text' },
  { label: 'literal multiline display', text: String.raw`你好\N世界`, trace: 'ArialMT', width: 100, code: 0, failed: 'subtitle_display_text' },
  { label: 'ordinary punctuation', text: '你好，世界！', trace: 'ArialMT', width: 100, code: 0, failed: 'subtitle_display_text' },
])('verifies $label without normalizing or rewriting the claimed burned display', async ({ text, trace, width, code, failed }) => {
  const input = await fixture(visual, { normalizeSubtitleText: true })
  const external = externalStub(input.output, code, `fontselect: (Arial, 400, 0) -> ${trace}, 0, ${trace}\n[Parsed_bbox] x1:200 x2:${String(199 + width)} y1:50 y2:79 w:${String(width)} h:30`)
  const factory = vi.spyOn(Media, 'createMediaToolkit').mockReturnValue({ ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', channel: external.channel })
  onTestFinished(() => { factory.mockRestore() })
  const subtitle = join(input.root, 'editing', '01.srt')
  const authored = `1\n00:00:00,125 --> 00:00:00,875\n${text}\n`
  await writeFile(subtitle, authored)
  await mkdir(join(input.root, 'exports'))
  await writeFile(input.output, 'existing stored video')
  const result = await invoke(input.tool, { method: 'verify', project: input.root, episode: 1,
    timeline: 'editing/01-timeline.json', subtitle_srt: 'editing/01.srt', output: input.output })
  expect(result.ok, result.failures.join('\n')).toBe(!failed)
  if (failed) expect(result.checks.find(check => check.id === failed)).toMatchObject({ ok: false, severity: 'failure' })
  const report = JSON.parse(await readFile(result.subtitle_layout!.report_path, 'utf8')) as SubtitleLayoutReport
  expect(report.entries.map(entry => entry.text)).toEqual([text])
  expect(await readFile(subtitle, 'utf8')).toBe(authored)
  expect(await readFile(input.output, 'utf8')).toBe('existing stored video')
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


it('retains a resolved overlay in a failed visual preflight without encoding its source', async () => {
  const input = await fixture(visual, { normalizeSubtitleText: true }), external = externalStub(input.output)
  const factory = vi.spyOn(Media, 'createMediaToolkit').mockReturnValue({ ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', channel: external.channel })
  onTestFinished(() => { factory.mockRestore() })
  const plan = join(input.root, 'overlay.json')
  await writeFile(plan, '{"schema_version":1,"decisions":[]}')
  const result = await invoke(input.tool, { method: 'render', project: input.root, episode: 1,
    timeline: 'editing/01-timeline.json', subtitle_srt: 'editing/01.srt', subtitle_plan: plan,
    last_shot: 1, bgm: 'bed.wav', output: input.output })
  expect(result).toMatchObject({ ok: false, output: '', encoded_shots: [], subtitle_overlay: { plan_path: plan } })
  expect(external.calls.filter(call => call.command === 'ffprobe').map(call => call.args.at(-1)))
    .toEqual([join(input.root, 'video', '01', 'shot_001.mp4')])
  expect(external.calls.some(call => call.command === 'ffmpeg')).toBe(true)
  expect(external.calls.every(call => call.command === 'ffprobe'
    || (call.command === 'ffmpeg' && call.args.some(argument => argument.includes('bbox=min_val=1'))))).toBe(true)
})

it.skipIf(!nativeAvailable)('refuses a real fallback font before body encoding and preserves its previous output', async () => {
  if (!ffmpeg || !ffprobe) throw new Error('Native preflight requires explicit bundled media paths')
  const owner = createMediaRunner(), family = 'Muse Fixture Missing Font Family'
  const input = await fixture({ ...visual, font_family: family },
    { ffmpegPath: ffmpeg, ffprobePath: ffprobe, fontsDir: fonts, subtitleFontFamily: family }, owner.dispose)
  const calls: (readonly string[])[] = []
  const toolkit: MediaToolkit = { ffmpeg, ffprobe, channel: { run: async (command, args) => {
    calls.push(args)
    return await owner.runCommand(command, args)
  } } }
  const factory = vi.spyOn(Media, 'createMediaToolkit').mockReturnValue(toolkit)
  onTestFinished(() => { factory.mockRestore() })
  await mkdir(join(input.root, 'exports'))
  await writeFile(input.output, 'previous reviewed output')
  const before = await stat(input.output), original = await readFile(input.output)
  const result = await invoke(input.tool, { method: 'render', project: input.root, episode: 1,
    timeline: 'editing/01-timeline.json', subtitle_srt: 'editing/01.srt', last_shot: 1, bgm: 'bed.wav', output: input.output })
  expect(result).toMatchObject({ ok: false, output: '', encoded_shots: [], reused_shots: [] })
  expect(result.checks.find(check => check.id === 'subtitle_display_font')).toMatchObject({ ok: false, severity: 'failure' })
  expect(await readFile(input.output)).toEqual(original)
  expect(await stat(input.output)).toMatchObject({ dev: before.dev, ino: before.ino })
  expect(calls.length).toBeGreaterThan(0)
  expect(calls.every(args => args.some(argument => argument.includes('bbox=min_val=1')))).toBe(true)
})

it.skipIf(!nativeAvailable || !existsSync(join(fonts, 'ZhuqueFangsong-Regular.ttf'))).each([
  'Noto Sans CJK SC', 'Zhuque Fangsong (technical preview)',
])('renders and verifies the exact selected display with real deployed %s', async (family) => {
  if (!ffmpeg || !ffprobe) throw new Error('Native render requires explicit bundled media paths')
  const owner = createMediaRunner()
  const style: DeliverySubtitleVisual = { schema_version: 1, reference_width: 480, reference_height: 854,
    font_size_px: 46, outline_px: 1.25, center_y_ratio: 0.736747073, max_width_ratio: 0.9, font_family: family }
  const input = await fixture(style, { normalizeSubtitleText: true, ffmpegPath: ffmpeg,
    ffprobePath: ffprobe, fontsDir: fonts, subtitleFontFamily: family }, owner.dispose)
  const delivery = { visual_medium: 'animation_3d', width: 480, height: 854, fps: 24, subtitle_visual: style }
  await writeFile(join(input.root, 'project_config.json'), JSON.stringify({ project_bible: { visual_medium: 'animation_3d', delivery } }))
  await writeFile(join(input.root, 'editing/01-timeline.json'), JSON.stringify({
    clips: [{ shot: 1, start_us: 0, duration_us: 1000000 }], body_end: 1, delivery }))
  const source = join(input.root, 'video/01/shot_001.mp4'), master = join(input.root, 'audio/01.wav')
  const generated = await owner.runCommand(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=480x854:rate=24:duration=1',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-shortest', source])
  expect(generated.code, generated.stderr).toBe(0)
  const audio = await owner.runCommand(ffmpeg, ['-y', '-v', 'error', '-i', source, '-vn', '-c:a', 'pcm_s16le', master])
  expect(audio.code, audio.stderr).toBe(0)
  const subtitle = join(input.root, 'editing/01.srt'), authored = '1\n00:00:00,125 --> 00:00:00,875\n你好，\\N世界！\n'
  await writeFile(subtitle, authored)
  const profile = join(input.root, 'mix.json')
  await writeFile(profile, '{"schema_version":1,"mode":"no_bgm","analysis_window_ms":100}')
  const toolkit: MediaToolkit = { ffmpeg, ffprobe, channel: { run: async (command, args) => await owner.runCommand(command, args) } }
  const factory = vi.spyOn(Media, 'createMediaToolkit').mockReturnValue(toolkit)
  onTestFinished(() => { factory.mockRestore() })
  const rendered = await invoke(input.tool, { method: 'render', project: input.root, episode: 1,
    timeline: 'editing/01-timeline.json', subtitle_srt: 'editing/01.srt', last_shot: 1, mix_profile: profile, output: input.output })
  expect(rendered.ok, JSON.stringify(rendered.failures)).toBe(true)
  expect(rendered.checks.filter(check => check.id.startsWith('subtitle_display_')).map(check => check.ok)).toEqual([true, true, true])
  const display = rendered.render_preview?.subtitle.path
  if (display === undefined) throw new Error('Missing actual rendered display subtitle')
  const beforeVideo = await fileSha256(input.output), beforeSrt = await readFile(display)
  const verified = await invoke(input.tool, { method: 'verify', project: input.root, episode: 1,
    timeline: 'editing/01-timeline.json', subtitle_srt: display, output: input.output })
  expect(verified.ok, JSON.stringify(verified.failures)).toBe(true)
  expect(verified.checks.filter(check => check.id.startsWith('subtitle_display_')).map(check => check.ok)).toEqual([true, true, true])
  expect(await fileSha256(input.output)).toBe(beforeVideo)
  expect(await readFile(display)).toEqual(beforeSrt)
  expect(await readFile(subtitle, 'utf8')).toBe(authored)
  expect(verified.written.length).toBeGreaterThan(0)
}, 60_000)
