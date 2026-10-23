/** Explicit medium selection, persisted snapshots, and legacy fallbacks. */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_DELIVERY, audioMixFilter, deliveryScaleFilter, subtitleBurnFilter } from '../src/delivery.ts'
import { assertBodyOnlyAnimation, deliveryPolicyFor, parseTimelineDelivery, readProjectDelivery, resolveDeliveryPolicy } from '../src/delivery-policy.ts'
import { buildAssDocument } from '../src/subtitles.ts'
import { appendClips, formatTimelineDocument, parseTimelineDocument } from '../src/timeline.ts'

const temporary: string[] = []
afterEach(async () => { await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
async function project(bible?: unknown): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'drama-delivery-policy-'))
  temporary.push(path)
  if (bible !== undefined) await writeFile(join(path, 'project_config.json'), JSON.stringify({ project_bible: bible }))
  return path
}
const animation = { width: 1920, height: 1080, fps: 30, visual_medium: 'animation_3d' } as const
const fonts = { subtitleFontFamily: 'SimHei', watermarkFontFamily: 'Microsoft YaHei' }

describe('delivery metadata', () => {
  it('round trips only explicit project subtitle and audio fields into the timeline', async () => {
    const delivery = { ...animation, subtitle: { font_family: 'Noto Sans CJK SC', font_size_px: 30, margin_bottom_px: 18 },
      audio: { master_gain: 1, bgm_gain: 0 } }
    const selected = await readProjectDelivery(await project({ visual_medium: 'animation_3d', delivery }))
    expect(selected).toEqual(delivery)
    const text = formatTimelineDocument({ ...appendClips([1_000_000]), delivery: selected })
    expect(parseTimelineDocument(JSON.parse(text), 't.json').delivery).toEqual(delivery)
    expect(await readProjectDelivery(await project({ delivery: { subtitle: {}, audio: {} } })))
      .toEqual({ ...DEFAULT_DELIVERY, subtitle: {}, audio: {} })
  })
  it.each([
    { subtitle: null }, { subtitle: [] }, { subtitle: 'large' }, { audio: null }, { audio: [] },
    { subtitle: { font_family: null } }, { subtitle: { font_family: ' ' } },
    { subtitle: { font_family: 'font,injected' } }, { subtitle: { font_family: 'font\nStyle: forged' } },
    { subtitle: { font_size_px: null } }, { subtitle: { font_size_px: '30' } },
    { subtitle: { font_size_px: 0 } }, { subtitle: { font_size_px: -1 } },
    { subtitle: { font_size_px: Infinity } }, { subtitle: { font_size_px: NaN } },
    { subtitle: { margin_bottom_px: null } }, { subtitle: { margin_bottom_px: -1 } },
    { subtitle: { margin_bottom_px: 1081 } }, { subtitle: { margin_bottom_px: Infinity } },
    { audio: { master_gain: null } }, { audio: { master_gain: '1' } }, { audio: { master_gain: -1 } },
    { audio: { master_gain: 8.1 } }, { audio: { bgm_gain: Infinity } }, { audio: { bgm_gain: null } },
  ])('rejects malformed explicit style or gain values %j', (sections) => {
    expect(() => parseTimelineDelivery({ ...animation, ...sections }, 'timeline.delivery')).toThrow('timeline.delivery')
  })
  it('does not add new fields or change old timeline bytes when no override is configured', async () => {
    const delivery = await readProjectDelivery(await project({ delivery: { width: 480, height: 854, fps: 24 } }))
    expect(formatTimelineDocument({ ...appendClips([1_000_000]), delivery })).toBe(
      '{\n  "clips": [\n    {\n      "shot": 1,\n      "start_us": 0,\n      "duration_us": 1000000\n    }\n  ],\n'
      + '  "body_end": 1,\n  "delivery": {\n    "width": 480,\n    "height": 854,\n    "fps": 24\n  }\n}\n')
  })
  it('rejects only sizes that become zero at the actual ASS precision, not a subjective minimum pixel size', () => {
    expect(() => parseTimelineDelivery({ width: 480, height: 854, fps: 24,
      subtitle: { font_size_px: 0.0001 } }, 'timeline.delivery')).toThrow('换算后为 0 ASS 设计单位')
    expect(parseTimelineDelivery({ width: 480, height: 2, fps: 24,
      subtitle: { font_size_px: 0.0001 } }, 'timeline.delivery').subtitle?.font_size_px).toBe(0.0001)
  })
  it('retains explicit medium and geometry through timeline JSON round trips', () => {
    const timeline = { ...appendClips([1_000_000]), delivery: animation }
    expect(parseTimelineDocument(JSON.parse(formatTimelineDocument(timeline)), 't.json')).toEqual({ ...timeline, declaredBodyEndSeconds: 1 })
  })
  it('rejects conflicting canvas and delivery dimensions', () => {
    const timeline = JSON.parse(formatTimelineDocument({ ...appendClips([1_000_000]), delivery: animation })) as Record<string, unknown>
    expect(() => parseTimelineDocument({ ...timeline, canvas: { width: 1080, height: 1920 } }, 't.json')).toThrow('画幅冲突')
    expect(parseTimelineDocument({ ...timeline, canvas: { width: 1920, height: 1080 } }, 't.json').delivery).toEqual(animation)
  })
  it.each([null, [], {}, { width: 0, height: 2 }])('rejects malformed explicit canvas %j', (canvas) => {
    expect(() => parseTimelineDocument({ clips: [{ shot: 1, start_us: 0, duration_us: 1 }], canvas }, 't.json')).toThrow('canvas')
  })
  it('rejects an already included animation ending even with project-only medium', async () => {
    const timeline = parseTimelineDocument({ clips: [{ shot: 1, start_us: 0, duration_us: 3_000_000 }], body_end: 1 }, 't.json')
    const policy = await resolveDeliveryPolicy(await project({ visual_medium: 'animation_3d' }), timeline.delivery)
    expect(() => { assertBodyOnlyAnimation(timeline, policy) }).toThrow('仅保留正片镜头')
    expect(() => { assertBodyOnlyAnimation(timeline, deliveryPolicyFor()) }).not.toThrow()
  })
  it('rejects malformed body_end before any media work', () => {
    expect(() => parseTimelineDocument({ clips: [{ shot: 1, start_us: 0, duration_us: 1 }], body_end: null }, 't.json')).toThrow('body_end')
  })
  it('keeps absent timeline metadata absent', () => {
    const timeline = appendClips([1_000_000])
    expect(parseTimelineDocument(JSON.parse(formatTimelineDocument(timeline)), 't.json')).toEqual({ ...timeline, declaredBodyEndSeconds: 1 })
  })
  it('accepts a legacy timeline without declaring a body boundary', () => {
    const timeline = parseTimelineDocument({ clips: [{ shot: 1, start_us: 0, duration_us: 1_000_000 }] }, 't.json')
    expect(timeline).toEqual(appendClips([1_000_000]))
    expect(timeline).not.toHaveProperty('declaredBodyEndSeconds')
  })
  it.each([null, [], 'animation_3d', {}, { ...animation, visual_medium: null },
    { ...animation, visual_medium: '3D' }, { ...animation, width: 1919 },
    { ...animation, height: 0 }, { ...animation, fps: 0 }, { ...animation, fps: 241 },
    { ...animation, fps: 29.97 }, { ...animation, width: '1920' },
  ])('rejects invalid explicit timeline delivery: %j', (delivery) => {
    expect(() => parseTimelineDocument({ clips: [{ shot: 1, start_us: 0, duration_us: 1 }], delivery }, 't.json')).toThrow()
  })
  it('allows geometry metadata without a selected medium', () => {
    expect(parseTimelineDelivery(DEFAULT_DELIVERY, 'delivery')).toEqual(DEFAULT_DELIVERY)
  })
  it('snapshots project medium and delivery without changing free-text style', async () => {
    const path = await project({ visual_medium: 'animation_3d', style: 'photorealistic lighting', delivery: animation })
    expect(await readProjectDelivery(path)).toEqual(animation)
  })
  it('uses geometry defaults only for omitted fields', async () => {
    expect(await readProjectDelivery(await project({ visual_medium: 'animation_3d', delivery: { fps: 30 } })))
      .toEqual({ ...DEFAULT_DELIVERY, visual_medium: 'animation_3d', fps: 30 })
  })
  it.each([{ visual_medium: null }, { visual_medium: 'CG' }, { delivery: null }, { delivery: { width: null } }, null])(
    'rejects invalid explicit project metadata: %j', async (bible) => {
      await expect(readProjectDelivery(await project(bible))).rejects.toThrow()
    },
  )
  it('reports malformed project JSON instead of falling back', async () => {
    const path = await project()
    await writeFile(join(path, 'project_config.json'), 'broken')
    await expect(readProjectDelivery(path)).rejects.toThrow()
  })
  it('preserves legacy geometry when an existing configuration has no project bible', async () => {
    const path = await project()
    await writeFile(join(path, 'project_config.json'), JSON.stringify({ project_name: 'Legacy project' }))
    expect(await readProjectDelivery(path)).toEqual(DEFAULT_DELIVERY)
  })
  it('reports unreadable project configuration instead of treating it as missing', async () => {
    const path = await project()
    await mkdir(join(path, 'project_config.json'))
    await expect(readProjectDelivery(path)).rejects.toThrow()
  })
})

describe('medium delivery resolution', () => {
  it('inherits missing sections independently without merging fields into a saved section', async () => {
    const path = await project({ visual_medium: 'animation_3d', delivery: {
      subtitle: { font_family: 'Changed font', font_size_px: 80 }, audio: { master_gain: 0, bgm_gain: 0.5 } } })
    expect((await resolveDeliveryPolicy(path, { ...animation, subtitle: { font_size_px: 30 } })).delivery)
      .toEqual({ ...animation, subtitle: { font_size_px: 30 }, audio: { master_gain: 0, bgm_gain: 0.5 } })
    expect((await resolveDeliveryPolicy(path, { ...animation, audio: {} })).delivery)
      .toEqual({ ...animation, audio: {}, subtitle: { font_family: 'Changed font', font_size_px: 80 } })
    expect((await resolveDeliveryPolicy(path, { ...animation, subtitle: {}, audio: {} })).delivery)
      .toEqual({ ...animation, subtitle: {}, audio: {} })
  })
  it('validates current explicit sections even when a saved section takes precedence', async () => {
    const path = await project({ delivery: { audio: null } })
    await expect(resolveDeliveryPolicy(path, { ...animation, audio: { master_gain: 1 } })).rejects.toThrow('.audio')
  })
  it('checks inherited output margins against the saved frame, not only the newer project frame', async () => {
    const path = await project({ delivery: { height: 2560, subtitle: { margin_bottom_px: 1500 } } })
    await expect(resolveDeliveryPolicy(path, animation)).rejects.toThrow('margin_bottom_px')
  })
  it('validates the precision of a project font size against the saved output geometry before rendering', async () => {
    const path = await project({ delivery: { width: 480, height: 2, fps: 24, subtitle: { font_size_px: 0.0001 } } })
    expect((await readProjectDelivery(path)).subtitle?.font_size_px).toBe(0.0001)
    await expect(resolveDeliveryPolicy(path, { width: 480, height: 854, fps: 24 })).rejects.toThrow('换算后为 0 ASS 设计单位')
  })
  it('warns and preserves legacy treatment when neither document selects a medium', async () => {
    const policy = await resolveDeliveryPolicy(await project({ style: '3D动画', aspect_ratio: '16:9' }))
    expect(policy).toMatchObject({ endingSeconds: 2, addWatermark: true, delivery: DEFAULT_DELIVERY })
    expect(policy.warnings[0]).toContain('未设置 visual_medium')
  })
  it('keeps a 2D style as free text and does not silently select 3D treatment', async () => {
    const policy = await resolveDeliveryPolicy(await project({ style: '二维国漫', aspect_ratio: '16:9' }))
    expect(policy).toMatchObject({ endingSeconds: 2, addWatermark: true, delivery: DEFAULT_DELIVERY })
    expect(policy.warnings).toHaveLength(1)
  })
  it('accepts an explicit project medium for an old timeline without guessing its geometry', async () => {
    const policy = await resolveDeliveryPolicy(await project({ visual_medium: 'animation_3d', delivery: animation }))
    expect(policy).toMatchObject({ endingSeconds: 0, addWatermark: false,
      delivery: { ...DEFAULT_DELIVERY, visual_medium: 'animation_3d' } })
    expect(policy.warnings).toEqual([])
  })
  it('accepts a standalone snapshot without project configuration', async () => {
    expect(await resolveDeliveryPolicy(await project(), animation)).toEqual(deliveryPolicyFor(animation))
  })
  it('uses snapshot geometry rather than newer project geometry', async () => {
    const path = await project({ visual_medium: 'animation_3d', delivery: { width: 1280, height: 720, fps: 24 } })
    expect((await resolveDeliveryPolicy(path, animation)).delivery).toEqual(animation)
  })
  it('requires prepare again when explicit media disagree', async () => {
    const path = await project({ visual_medium: 'photorealistic' })
    await expect(resolveDeliveryPolicy(path, animation)).rejects.toThrow('请重跑 prepare')
  })
  it('does not hide invalid project metadata behind a valid snapshot', async () => {
    await expect(resolveDeliveryPolicy(await project({ visual_medium: null }), animation)).rejects.toThrow('visual_medium')
  })
  it('removes both the ASS style and event for animation while retaining dialogue', () => {
    const ass = buildAssDocument([{ index: 1, startSeconds: 0, endSeconds: 1, text: '台词' }], fonts, deliveryPolicyFor(animation))
    expect(ass).not.toContain('Watermark')
    expect(ass).not.toContain('内容由AI生成')
    expect(ass).toContain('台词')
    expect(ass).toContain('PlayResX: 1920\nPlayResY: 1080')
  })
  it('preserves the legacy ASS output for an explicit photorealistic medium', () => {
    expect(buildAssDocument([], fonts, deliveryPolicyFor({ ...DEFAULT_DELIVERY, visual_medium: 'photorealistic' })))
      .toBe(buildAssDocument([], fonts))
  })
  it('mixes only master and BGM when no ending is selected', () => {
    const graph = audioMixFilter({ bodyEndSeconds: 10, totalSeconds: 10, endingSeconds: 0, masterVolume: 1.45, bgmVolume: 0.24 })
    expect(graph).toContain('[a0][a1]amix=inputs=2')
    expect(graph).not.toContain('[3:a]')
    expect(graph).not.toContain('adelay')
    expect(graph).toContain('atrim=0:10.000000,alimiter')
  })
  it('carries snapshot canvas and rate into scale and burn filters', () => {
    expect(deliveryScaleFilter('yuv420p', animation)).toContain('crop=1920:1080,tpad=stop_mode=clone:stop_duration=0.033333333,fps=30')
    expect(subtitleBurnFilter('display.ass', 'fonts', animation)).toContain('scale=3840:2160')
    expect(subtitleBurnFilter('display.ass', 'fonts', animation)).toContain('fps=30,setpts=N/(30*TB)')
  })
})
