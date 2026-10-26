/** Real libass glyph widths, evidence capture and non-blocking probe failures. */
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { measureSubtitleLayout } from '../src/subtitle-layout.ts'
import type { MediaToolkit, RenderSettings, SubtitleCue, TimelineDelivery } from '../src/types.ts'
import { createMediaRunner } from './audio-ffmpeg-harness.ts'

const visual = { schema_version: 1 as const, reference_width: 320, reference_height: 180,
  font_size_px: 30, outline_px: 2, center_y_ratio: 0.65, max_width_ratio: 0.8, font_family: 'Arial' }
const delivery: TimelineDelivery = { width: 320, height: 180, fps: 12, subtitle_visual: visual }
const settings: RenderSettings = { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', fontsDir: 'unused-fonts',
  subtitleFontFamily: 'Arial', watermarkFontFamily: 'Arial', masterVolume: 1, bgmVolume: 1, preferNvenc: false }
const cue = (text: string, index = 1): SubtitleCue => ({ index, startSeconds: 3.4, endSeconds: 5.6, text })

async function directory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'drama-subtitle-layout-'))
  onTestFinished(async () => { await rm(root, { recursive: true, force: true }) })
  return root
}

function stub(stderr = 'fontselect: (Arial, 400, 0) -> ArialMT, 0, ArialMT\n'
  + '[Parsed_bbox_0] n:0 pts:0 x1:400 x2:499 y1:100 y2:119 w:100 h:20', code = 0) {
  const run = vi.fn(async (_command: string, args: readonly string[]) => {
    if (code === 0) for (const file of args.filter(value => value.endsWith('.png'))) await writeFile(file, 'test-image', { flag: 'wx' })
    return { code, stdout: 'captured stdout', stderr }
  })
  return { toolkit: { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', channel: { run } } satisfies MediaToolkit, run }
}

it('leaves legacy delivery and the evidence directory untouched without an explicit visual profile', async () => {
  const root = await directory(), process = stub()
  const result = await measureSubtitleLayout({ toolkit: process.toolkit, settings,
    delivery: { width: 320, height: 180, fps: 12 }, cues: [cue('旧字幕')], directory: join(root, 'unused') })
  expect(result.report.status).toBe('not_requested')
  expect(result.warnings).toEqual([])
  expect(result.written).toEqual([])
  expect(process.run).not.toHaveBeenCalled()
  expect(await readdir(root)).toEqual([])
})

it('treats an explicitly empty visual section as legacy delivery without a probe', async () => {
  const root = await directory(), process = stub()
  const result = await measureSubtitleLayout({ toolkit: process.toolkit, settings,
    delivery: { ...delivery, subtitle_visual: {} }, cues: [cue('旧字幕')], directory: root })
  expect(result.report.status).toBe('not_requested')
  expect(result.written).toEqual([])
  expect(process.run).not.toHaveBeenCalled()
  expect(await readdir(root)).toEqual([])
})

it('probes distinct text once and preserves each original cue time with complete logs', async () => {
  const root = await directory(), process = stub()
  const cues = [cue('WWWW'), cue('iiii', 2), { ...cue('WWWW', 3), startSeconds: 8, endSeconds: 9 }]
  const original = structuredClone(cues)
  const result = await measureSubtitleLayout({ toolkit: process.toolkit, settings, delivery, cues, directory: root })
  expect(cues).toEqual(original)
  expect(process.run).toHaveBeenCalledTimes(2)
  expect(result.report).toMatchObject({ status: 'measured', probe_size: { width: 960, height: 180 } })
  expect(result.report.entries[0]).toMatchObject({ cues: [
    { index: 1, start_seconds: 3.4, end_seconds: 5.6 }, { index: 3, start_seconds: 8, end_seconds: 9 }],
  status: 'measured', ink_bounds: { width: 100, height: 20 }, outline_allowance_px: 4,
  width_with_outline_estimate_px: 104, fits_available_width: true })
  const first = result.report.entries[0]!
  expect(await readFile(first.files.stderr, 'utf8')).toContain('fontselect: (Arial')
  expect(await readFile(first.files.stdout, 'utf8')).toBe('captured stdout')
  expect(await readFile(first.files.ass, 'utf8')).toContain('WrapStyle: 2')
  expect(first.files).toHaveProperty('delivery_preview')
  expect(await readFile(first.files.delivery_ass, 'utf8')).toContain('\\an5\\pos(960,702)\\q2')
  expect(first.fontselect_trace).toEqual(['fontselect: (Arial, 400, 0) -> ArialMT, 0, ArialMT'])
  const command = JSON.parse(await readFile(first.files.command, 'utf8')) as { args: string[] }
  expect(command.args.join(' ')).toContain('scale=1920:360')
  expect(command.args.join(' ')).toContain('color=c=black:s=320x180')
  expect(command.args.join(' ')).toContain('scale=640:360')
  expect(command.args.join(' ')).toContain('bbox=min_val=1')
  expect(result.written).toContain(first.files.preview)
  expect(result.written).toContain(first.files.delivery_preview)
  expect(result.report.report_path).not.toBeNull()
  expect(JSON.parse(await readFile(result.report.report_path!, 'utf8'))).toEqual(result.report)
})

it('warns about measured overwidth while leaving text and timestamps unchanged', async () => {
  const root = await directory(), process = stub('[Parsed_bbox] x1:200 x2:599 y1:50 y2:79 w:400 h:30')
  const result = await measureSubtitleLayout({ toolkit: process.toolkit, settings, delivery, cues: [cue('长句')], directory: root })
  expect(result.report.entries[0]).toMatchObject({ status: 'measured', fits_available_width: false,
    available_width_px: 256, width_with_outline_estimate_px: 404, text: '长句' })
  expect(result.warnings.join('\n')).toContain('超过项目可用宽')
  expect(result.warnings.join('\n')).toContain('实际字体尚未确认')
})

it('does not claim fit when the three-times-wide probe reaches an edge', async () => {
  const root = await directory(), process = stub('[Parsed_bbox] x1:0 x2:959 y1:50 y2:79 w:960 h:30')
  const result = await measureSubtitleLayout({ toolkit: process.toolkit, settings, delivery, cues: [cue('极长句')], directory: root })
  expect(result.report.entries[0]).toMatchObject({ status: 'clipped', fits_available_width: null })
  expect(result.warnings.join('\n')).toContain('完整宽度尚未确认')
})

it('retains complete decoder stderr and reports a failed probe instead of claiming fit', async () => {
  const root = await directory(), process = stub('failed filter\ncomplete native error detail', 3)
  const result = await measureSubtitleLayout({ toolkit: process.toolkit, settings, delivery, cues: [cue('字幕')], directory: root })
  const first = result.report.entries[0]!
  expect(result.report.status).toBe('partial')
  expect(first).toMatchObject({ status: 'not_measured', ink_bounds: null, fits_available_width: null })
  expect(await readFile(first.files.stderr, 'utf8')).toBe('failed filter\ncomplete native error detail')
  expect(result.warnings.join('\n')).toContain('退出码 3')
  expect(result.written).not.toContain(first.files.preview)
  expect(result.written).not.toContain(first.files.delivery_preview)
})

it('reports empty white-pixel bounds and authored newlines without guessing a width', async () => {
  const root = await directory(), process = stub('[Parsed_bbox] x1:960 x2:0 y1:180 y2:0 w:0 h:0')
  const result = await measureSubtitleLayout({ toolkit: process.toolkit, settings, delivery, cues: [cue('两\n行')], directory: root })
  expect(result.report.entries[0]).toMatchObject({ status: 'not_measured', fits_available_width: null })
  expect(result.warnings.join('\n')).toContain('原文包含换行')
  expect(result.warnings.join('\n')).toContain('未取得白字边界')
})

it('keeps a thrown runtime failure in the per-text evidence', async () => {
  const root = await directory()
  const toolkit: MediaToolkit = { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', channel: { run: async () => { throw new Error('runtime unavailable') } } }
  const result = await measureSubtitleLayout({ toolkit, settings, delivery, cues: [cue('台词')], directory: root })
  expect(result.report.entries[0]?.fits_available_width).toBeNull()
  expect(await readFile(result.report.entries[0]!.files.stderr, 'utf8')).toContain('runtime unavailable')
  expect(result.warnings.join('\n')).toContain('退出码 null')
})

it('keeps measurement directory failures advisory', async () => {
  const root = await directory(), process = stub(), blocked = join(root, 'file')
  await writeFile(blocked, 'not a directory')
  const result = await measureSubtitleLayout({ toolkit: process.toolkit, settings, delivery, cues: [cue('字幕')], directory: blocked })
  expect(result.report.status).toBe('not_measured')
  expect(result.warnings.join('\n')).toContain('不阻断制作')
  expect(process.run).not.toHaveBeenCalled()
})

const ffmpeg = process.env.DSH_FFMPEG_PATH, ffprobe = process.env.DSH_FFPROBE_PATH
const packagedFonts = ffmpeg === undefined ? '' : join(dirname(ffmpeg), '../../fonts')
const fonts = process.env.DSH_FONTS_DIR ?? packagedFonts
const hasNoto = existsSync(join(fonts, 'NotoSansCJKsc-Regular.otf'))

async function nativeInput(family: string) {
  if (!ffmpeg || !ffprobe) throw new Error('Native layout test requires explicit FFmpeg and ffprobe paths')
  const root = await mkdtemp(join(tmpdir(), 'drama-subtitle-layout-native-'))
  const owner = createMediaRunner()
  onTestFinished(async () => { await owner.dispose(); await rm(root, { recursive: true, force: true }) })
  const run = vi.fn(async (command: string, args: readonly string[]) => {
    const result = await owner.runCommand(command, args)
    expect(result.interrupted, result.stderr).toBe(false)
    expect(result.signal, result.stderr).toBeNull()
    return result
  })
  await mkdir(join(root, 'evidence'))
  return { toolkit: { ffmpeg, ffprobe, channel: { run } },
    settings: { ...settings, ffmpeg, ffprobe, fontsDir: fonts, subtitleFontFamily: family },
    delivery: { ...delivery, subtitle_visual: { ...visual, font_family: family } },
    directory: join(root, 'evidence'), run }
}

it.skipIf(!ffmpeg || !ffprobe)('measures actual WWWW and iiii differently and flags a real overwide line', async () => {
  const input = await nativeInput(hasNoto ? 'Noto Sans CJK SC' : 'Arial')
  const result = await measureSubtitleLayout({ ...input, cues: [cue('WWWW'), cue('iiii', 2), cue('W'.repeat(30), 3), cue('WWWW', 4)] })
  expect(result.report.status, result.warnings.join('\n')).toBe('measured')
  expect(input.run).toHaveBeenCalledTimes(3)
  const [wide, narrow, overwide] = result.report.entries
  expect(wide?.ink_bounds?.width).toBeGreaterThan((narrow?.ink_bounds?.width ?? Infinity) * 2)
  expect(wide?.fontselect_trace.length).toBeGreaterThan(0)
  expect(overwide?.fits_available_width).toBe(false)
  expect(overwide?.ink_bounds?.width).toBeGreaterThan(input.delivery.width)
}, 60_000)

it.skipIf(!ffmpeg || !ffprobe || !hasNoto)('keeps natural Chinese width and shows real 480px clipping or word-timed single-line splits at the same centre', async () => {
  const input = { ...await nativeInput('Noto Sans CJK SC'), delivery: { width: 480, height: 854, fps: 24,
    subtitle_visual: { ...visual, reference_width: 480, reference_height: 854, font_size_px: 52,
      center_y_ratio: 0.635, max_width_ratio: 0.9, font_family: 'Noto Sans CJK SC' } } }
  // These adjacent cue times use the observed word boundary, not character-time division.
  const cues = [{ index: 1, text: '可我现在每天按时起每天都干活', startSeconds: 64.528, endSeconds: 66.488 },
    { index: 2, text: '可我现在每天按时起', startSeconds: 64.528, endSeconds: 65.848 },
    { index: 3, text: '每天都干活', startSeconds: 65.848, endSeconds: 66.488 }]
  const result = await measureSubtitleLayout({ ...input, cues })
  expect(result.report.status, result.warnings.join('\n')).toBe('measured')
  expect(result.report.entries[0]?.ink_bounds?.width).toBeGreaterThan(480)
  expect(result.report.entries[0]?.fontselect_trace.join('\n')).toContain('Noto')
  expect(result.report.entries[0]?.fits_available_width).toBe(false)
  expect(result.report.entries.slice(1).map(entry => entry.fits_available_width)).toEqual([true, true])
  const visible: { left: number; right: number; top: number; bottom: number; width: number; height: number }[] = []
  for (const entry of result.report.entries) {
    expect(entry.files).toHaveProperty('delivery_preview')
    const png = await readFile(entry.files.delivery_preview)
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([480, 854])
    const ass = await readFile(entry.files.delivery_ass, 'utf8')
    expect(ass).toContain('\\an5\\pos(540,1220.47)\\q2')
    expect(ass).not.toContain('\\N')
    const image = await input.toolkit.channel.run(input.toolkit.ffmpeg, ['-hide_banner', '-v', 'info',
      '-i', entry.files.delivery_preview, '-vf', "format=gray,lut=y='if(gte(val,32),255,0)',bbox=min_val=1",
      '-frames:v', '1', '-f', 'null', '-'])
    expect(image.code, image.stderr).toBe(0)
    const bounds = /x1:\s*(\d+)\s+x2:\s*(\d+)\s+y1:\s*(\d+)\s+y2:\s*(\d+)\s+w:\s*(\d+)\s+h:\s*(\d+)/u.exec(image.stderr)
    if (bounds === null) throw new Error(`Missing decoded delivery-image bounds: ${image.stderr}`)
    visible.push({ left: Number(bounds[1]), right: Number(bounds[2]), top: Number(bounds[3]),
      bottom: Number(bounds[4]), width: Number(bounds[5]), height: Number(bounds[6]) })
  }
  expect(visible[0]).toMatchObject({ left: 0, right: 479, width: 480 })
  for (const bounds of visible.slice(1)) {
    expect(bounds.left).toBeGreaterThan(0)
    expect(bounds.right).toBeLessThan(479)
    expect(bounds.width).toBeLessThan(432)
  }
  const centres = visible.map(bounds => (bounds.top + bounds.bottom + 1) / 2)
  expect(Math.max(...centres) - Math.min(...centres)).toBeLessThanOrEqual(1)
  // Ink centres may differ slightly from the ASS anchor because of font metrics.
  for (const centre of centres) expect(Math.abs(centre - 854 * 0.635)).toBeLessThanOrEqual(3)
  for (const bounds of visible) expect(bounds.height).toBeLessThan(52)
  expect(result.report.entries.map(entry => entry.cues[0])).toEqual(cues.map(row => ({
    index: row.index, start_seconds: row.startSeconds, end_seconds: row.endSeconds })))
}, 60_000)
