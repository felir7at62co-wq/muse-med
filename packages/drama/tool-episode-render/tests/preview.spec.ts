/** Render input visibility without guessing sound contents or changing approved defaults. */
import { expect, it } from 'vitest'
import { audioMixFilter, buildAssHeader, deliveryRenderSettings } from '../src/delivery.ts'
import { resolveSettings } from '../src/index.ts'
import { buildRenderPreview, renderPreviewWarnings } from '../src/preview.ts'

it('reports the same 480p design values written into ASS and their nominal output scale', () => {
  const settings = resolveSettings({ subtitleFontFamily: 'Noto Sans CJK SC' })
  const delivery = { width: 480, height: 854, fps: 24, visual_medium: 'photorealistic' as const }
  const preview = buildRenderPreview({ settings, delivery, subtitle: '/project/23.srt', master: '/project/23.wav',
    bgm: '/project/approved-bgm.wav', bgmPlan: '/project/music.json' })
  expect(preview).toEqual({ delivery,
    subtitle: { path: '/project/23.srt', font_family: 'Noto Sans CJK SC', design_width: 1080, design_height: 1922,
      font_size_design: 40, spacing_design: -2, outline_design: 5, margin_bottom_design: 140,
      font_size_output_px: 17.773, outline_output_px: 2.222, margin_bottom_output_px: 62.206 },
    audio: { master_path: '/project/23.wav', bgm_path: '/project/approved-bgm.wav', bgm_plan_path: '/project/music.json',
      master_gain: 1.45, bgm_gain: 0.24 } })
  const header = buildAssHeader(settings, delivery)
  expect(header).toContain('PlayResY: 1922')
  expect(header).toContain('Style: Default,Noto Sans CJK SC,40,')
  expect(header).toContain('100,100,-2,0,1,5,0,2,40,40,140,1')
  expect(renderPreviewWarnings(preview)).toHaveLength(1)
})

it('keeps absent prepare music inputs visibly empty and returns advice rather than a verdict', () => {
  const preview = buildRenderPreview({ settings: resolveSettings(), delivery: { width: 1440, height: 2560, fps: 60 },
    subtitle: '/project/23.srt', master: '/project/23.wav' })
  expect(preview.audio).toMatchObject({ bgm_path: '', bgm_plan_path: '' })
  expect(preview.subtitle.font_size_output_px).toBe(53.333)
  expect(renderPreviewWarnings(preview)).toEqual([
    expect.stringContaining('尚未提供 BGM 文件'), expect.stringContaining('空计划不表示没有混入 BGM'),
    expect.stringContaining('SRT 不携带字体样式'),
  ])
})

it('does not label a selected bed as absent just because its optional plan is missing', () => {
  const preview = buildRenderPreview({ settings: resolveSettings(), delivery: { width: 480, height: 854, fps: 24 },
    subtitle: '/project/23.srt', master: '/project/23.wav', bgm: '/project/approved-bgm.wav' })
  expect(preview.audio.bgm_path).toBe('/project/approved-bgm.wav')
  expect(renderPreviewWarnings(preview)).toHaveLength(2)
  expect(renderPreviewWarnings(preview).join('\n')).not.toContain('尚未提供 BGM 文件')
})

it('reports the project style and zero-capable gains used by the actual ASS and mix', () => {
  const settings = resolveSettings({ subtitleFontFamily: 'Deployment font', watermarkFontFamily: 'Unchanged watermark' })
  const delivery = { width: 480, height: 854, fps: 24, subtitle: {
    font_family: 'Project font', font_size_px: 30, margin_bottom_px: 18 }, audio: { master_gain: 1, bgm_gain: 0 } }
  const preview = buildRenderPreview({ settings, delivery, subtitle: '23.srt', master: '23.wav' })
  expect(preview.delivery).toEqual({ width: 480, height: 854, fps: 24 })
  expect(preview.subtitle).toMatchObject({ font_family: 'Project font', font_size_design: 67.518,
    font_size_output_px: 30, margin_bottom_design: 41, margin_bottom_output_px: 18.217 })
  expect(preview.audio).toMatchObject({ master_gain: 1, bgm_gain: 0 })
  const header = buildAssHeader(settings, delivery)
  expect(header).toContain('Style: Default,Project font,67.518,')
  expect(header).toContain('0,2,40,40,41,1')
  expect(header).toContain('Style: Watermark,Unchanged watermark,44,')
  const effective = deliveryRenderSettings(settings, delivery)
  expect(effective.watermarkFontFamily).toBe(settings.watermarkFontFamily)
  expect(effective.fontsDir).toBe(settings.fontsDir)
  expect(audioMixFilter({ bodyEndSeconds: 1, totalSeconds: 1, endingSeconds: 0,
    masterVolume: effective.masterVolume, bgmVolume: effective.bgmVolume })).toContain('volume=0[a1]')
  expect(settings.masterVolume).toBe(1.45)
})

it('keeps the old ASS bytes and filter command when optional sections are absent or empty', () => {
  const settings = resolveSettings()
  const delivery = { width: 480, height: 854, fps: 24 }
  expect(buildAssHeader(settings, { ...delivery, subtitle: {} })).toBe(buildAssHeader(settings, delivery))
  expect(deliveryRenderSettings(settings, delivery)).toEqual(settings)
  expect(deliveryRenderSettings(settings, { ...delivery, audio: {} })).toEqual(settings)
})
