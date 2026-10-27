import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildAssHeader, subtitleRenderStyle } from '../src/delivery.ts'
import { parseTimelineDelivery, readProjectDelivery, resolveDeliveryPolicy } from '../src/delivery-policy.ts'
import { activeSubtitleVisual, parseSubtitleVisual } from '../src/subtitle-visual.ts'
import { buildAssDocument } from '../src/subtitles.ts'

const visual = { schema_version: 1 as const, reference_width: 480, reference_height: 854,
  font_size_px: 42, outline_px: 2, center_y_ratio: 0.635, max_width_ratio: 0.9 }
const geometry = { width: 480, height: 854, fps: 24 }
const fonts = { subtitleFontFamily: 'Noto Sans CJK SC', watermarkFontFamily: 'Noto Sans CJK SC' }

describe('explicit shared subtitle visual intent', () => {
  it('uses separate pixel/ASS geometry, centred anchoring and no automatic wrapping without changing text or times', () => {
    const delivery = { ...geometry, subtitle_visual: visual }
    const style = subtitleRenderStyle(delivery)
    expect(style).toMatchObject({ font_size_output_px: 42, outline_output_px: 2, center_y_output_px: 542.29,
      max_width_output_px: 432, spacing_design: 0, margin_bottom_design: 0 })
    expect(style.font_size_design).not.toBe(42)
    const document = buildAssDocument([{ index: 1, startSeconds: 39.854, endSeconds: 40.334, text: '做饭' }], fonts,
      { delivery, addWatermark: false, endingSeconds: 0, warnings: [] })
    expect(document).toContain('0:00:39.85,0:00:40.33,Default,,0,0,0,,{\\an5\\pos(540,1220.47)\\q2}做饭')
    expect(document).not.toContain('\\N')
  })

  it('scales typography with height and usable width with width, not by copying draft UI units', () => {
    const style = subtitleRenderStyle({ width: 960, height: 1708, fps: 24, subtitle_visual: visual })
    expect(style.font_size_output_px).toBe(84)
    expect(style.outline_output_px).toBe(4)
    expect(style.center_y_output_px).toBe(1084.58)
    expect(style.max_width_output_px).toBe(864)
  })

  it('uses deployment font when new intent omits it, without silently inheriting legacy engine overrides', () => {
    const delivery = { ...geometry, subtitle: { font_family: 'LegacyFont', font_size_px: 12 }, subtitle_visual: visual }
    expect(buildAssHeader(fonts, delivery)).toContain('Style: Default,Noto Sans CJK SC,')
    expect(buildAssHeader(fonts, { ...delivery, subtitle_visual: { ...visual, font_family: 'ChosenFont' } }))
      .toContain('Style: Default,ChosenFont,')
  })

  it('uses the bundled subtitle font by default while project overrides leave the watermark font intact', () => {
    const bundledFonts = { subtitleFontFamily: 'Zhuque Fangsong (technical preview)', watermarkFontFamily: 'Noto Sans CJK SC' }
    const defaults = buildAssHeader(bundledFonts, { ...geometry, subtitle_visual: visual })
    expect(defaults).toContain('Style: Default,Zhuque Fangsong (technical preview),')
    expect(defaults).toContain('Style: Watermark,Noto Sans CJK SC,')
    const explicit = buildAssHeader(bundledFonts, { ...geometry, subtitle_visual: { ...visual, font_family: 'ChosenFont' } })
    expect(explicit).toContain('Style: Default,ChosenFont,')
    expect(explicit).toContain('Style: Watermark,Noto Sans CJK SC,')
    const legacy = buildAssHeader(bundledFonts, { ...geometry, subtitle: { font_family: 'LegacyFont' } })
    expect(legacy).toContain('Style: Default,LegacyFont,')
    expect(legacy).toContain('Style: Watermark,Noto Sans CJK SC,')
  })

  it('retains byte-identical legacy ASS defaults when omitted or explicitly reset', () => {
    const legacy = { ...geometry, subtitle: { font_size_px: 30, margin_bottom_px: 90 } }
    expect(buildAssHeader(fonts, { ...legacy, subtitle_visual: {} })).toBe(buildAssHeader(fonts, legacy))
    expect(activeSubtitleVisual({ ...geometry, subtitle_visual: {} })).toBeUndefined()
  })

  it.each([{ ...visual, font_size_px: 0.0001 }, { ...visual, reference_height: Number.MIN_VALUE }])(
    'rejects numerically unrepresentable scaled typography without clamping: %j', (subtitle_visual) => {
      expect(() => parseTimelineDelivery({ ...geometry, subtitle_visual }, 'timeline')).toThrow('subtitle_visual')
    })

  it('snapshots a whole section; a saved empty reset must not inherit later project style', async () => {
    const project = await mkdtemp(join(tmpdir(), 'subtitle-visual-'))
    await writeFile(join(project, 'project_config.json'), JSON.stringify({ project_bible: { delivery: { ...geometry, subtitle_visual: visual } } }))
    expect((await readProjectDelivery(project)).subtitle_visual).toEqual(visual)
    expect((await resolveDeliveryPolicy(project, geometry)).delivery.subtitle_visual).toEqual(visual)
    expect((await resolveDeliveryPolicy(project, { ...geometry, subtitle_visual: {} })).delivery.subtitle_visual).toEqual({})
    const saved = { ...visual, font_size_px: 40 }
    expect((await resolveDeliveryPolicy(project, { ...geometry, subtitle_visual: saved })).delivery.subtitle_visual).toEqual(saved)
  })

  it.each([null, [], 'style', { schema_version: true }, { ...visual, schema_version: 2 },
    { ...visual, reference_height: 0 }, { ...visual, font_size_px: NaN }, { ...visual, outline_px: -1 },
    { ...visual, center_y_ratio: 1.01 }, { ...visual, max_width_ratio: 0 }, { ...visual, max_width_ratio: Infinity },
    { ...visual, font_family: 'bad,font' }, { ...visual, font_family: 'line\nbreak' },
  ])('rejects malformed explicit configuration rather than hiding it: %j', (value) => {
    expect(() => parseSubtitleVisual(value, 'subtitle_visual')).toThrow('subtitle_visual')
    expect(() => parseTimelineDelivery({ ...geometry, subtitle_visual: value }, 'timeline')).toThrow('subtitle_visual')
  })
})
