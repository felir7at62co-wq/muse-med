import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildAssHeader, subtitleRenderStyle } from '../src/delivery.ts'
import { parseTimelineDelivery, readProjectDelivery, resolveDeliveryPolicy } from '../src/delivery-policy.ts'
import { activeSubtitleVisual, parseSubtitleVisual } from '../src/subtitle-visual.ts'
import { buildAssDocument } from '../src/subtitles.ts'
import { parseTimelineDocument } from '../src/timeline.ts'

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

  it('uses the deployment visual only when neither project nor timeline selected a subtitle style', async () => {
    const project = await mkdtemp(join(tmpdir(), 'subtitle-default-'))
    expect((await readProjectDelivery(project, visual)).subtitle_visual).toEqual(visual)
    expect((await resolveDeliveryPolicy(project, geometry, visual)).delivery.subtitle_visual).toEqual(visual)
    expect((await resolveDeliveryPolicy(project, { ...geometry, subtitle_visual: {} }, visual)).delivery.subtitle_visual).toEqual({})
    expect((await resolveDeliveryPolicy(project, { ...geometry, subtitle: { font_size_px: 24 } }, visual)).delivery.subtitle_visual)
      .toBeUndefined()
    await writeFile(join(project, 'project_config.json'), JSON.stringify({ project_bible: { delivery: { subtitle: { font_size_px: 30 } } } }))
    expect((await readProjectDelivery(project, visual)).subtitle_visual).toBeUndefined()
    expect((await resolveDeliveryPolicy(project, geometry, visual)).delivery.subtitle_visual).toBeUndefined()
    await writeFile(join(project, 'project_config.json'), JSON.stringify({ project_bible: { delivery: { subtitle_visual: {} } } }))
    expect((await readProjectDelivery(project, visual)).subtitle_visual).toEqual({})
  })

  it('applies the product visual to EP46-shaped existing projects with geometry but no subtitle settings', async () => {
    const project = await mkdtemp(join(tmpdir(), 'subtitle-ep46-shape-'))
    const productVisual = { schema_version: 1 as const, reference_width: 480, reference_height: 854,
      font_size_px: 48, outline_px: 2, center_y_ratio: 0.736747073, max_width_ratio: 0.9 }
    // Regression fixture based on the reported EP46 project configuration; unrelated fields are omitted.
    await writeFile(join(project, 'project_config.json'), JSON.stringify({ project_bible: {
      delivery: { width: 1440, height: 2560, fps: 60, min_bitrate_mbps: 4.6 },
    } }))
    const prepared = await readProjectDelivery(project, productVisual)
    expect(prepared).toMatchObject({ width: 1440, height: 2560, fps: 60, subtitle_visual: productVisual })
    expect((await resolveDeliveryPolicy(project, { width: 1440, height: 2560, fps: 60 }, productVisual)).delivery)
      .toMatchObject({ width: 1440, height: 2560, fps: 60, subtitle_visual: productVisual })
  })

  it('documents that EP26-shaped legacy project and saved timeline styles are not automatically migrated', async () => {
    const project = await mkdtemp(join(tmpdir(), 'subtitle-ep26-shape-'))
    const productVisual = { schema_version: 1 as const, reference_width: 480, reference_height: 854,
      font_size_px: 48, outline_px: 2, center_y_ratio: 0.736747073, max_width_ratio: 0.9 }
    const oldVisual = { ...productVisual, font_size_px: 52, font_family: 'Noto Sans CJK SC' }
    const oldSubtitle = { font_size_px: 30 }
    await writeFile(join(project, 'project_config.json'), JSON.stringify({ project_bible: {
      delivery: { ...geometry, subtitle: oldSubtitle, subtitle_visual: oldVisual },
    } }))
    const oldProject = await readProjectDelivery(project, productVisual)
    expect(oldProject).toMatchObject({ subtitle: oldSubtitle, subtitle_visual: oldVisual })
    expect((await resolveDeliveryPolicy(project, oldProject, productVisual)).delivery.subtitle_visual).toEqual(oldVisual)

    // Changing the project does not rewrite a saved timeline. A new prepare is required.
    await writeFile(join(project, 'project_config.json'), JSON.stringify({ project_bible: {
      delivery: { ...geometry, subtitle_visual: productVisual },
    } }))
    expect((await readProjectDelivery(project, productVisual)).subtitle_visual).toEqual(productVisual)
    expect((await resolveDeliveryPolicy(project, oldProject, productVisual)).delivery.subtitle_visual).toEqual(oldVisual)
    expect((await resolveDeliveryPolicy(project, geometry, productVisual)).delivery.subtitle_visual).toEqual(productVisual)

    // A legacy subtitle section alone is also an explicit override, even without subtitle_visual.
    await writeFile(join(project, 'project_config.json'), JSON.stringify({ project_bible: {
      delivery: { ...geometry, subtitle: oldSubtitle },
    } }))
    const legacyOnly = await readProjectDelivery(project, productVisual)
    expect(legacyOnly).toMatchObject({ subtitle: oldSubtitle })
    expect(legacyOnly.subtitle_visual).toBeUndefined()
    expect((await resolveDeliveryPolicy(project, { ...geometry, subtitle: oldSubtitle }, productVisual)).delivery)
      .toMatchObject({ subtitle: oldSubtitle })
    expect((await resolveDeliveryPolicy(project, { ...geometry, subtitle: oldSubtitle }, productVisual)).delivery.subtitle_visual)
      .toBeUndefined()
  })

  it('enforces the Muse product visual for EP26-shaped project and old timeline without modifying saved data', async () => {
    const project = await mkdtemp(join(tmpdir(), 'subtitle-force-ep26-'))
    const productVisual = { schema_version: 1 as const, reference_width: 480, reference_height: 854,
      font_size_px: 48, outline_px: 2, center_y_ratio: 0.736747073, max_width_ratio: 0.9 }
    const config = JSON.stringify({ project_bible: { delivery: { ...geometry,
      subtitle: { font_size_px: 70, font_family: 'LegacyFont' },
      subtitle_visual: { ...productVisual, font_size_px: 52, font_family: 'Noto Sans CJK SC' },
      audio: { master_gain: 1.2 }, draft_style: { watermark: { font_size_ui: 7 }, subtitle: { font_size_ui: -100 } },
    } } })
    const configPath = join(project, 'project_config.json')
    await writeFile(configPath, config)
    const prepared = await readProjectDelivery(project, productVisual, true)
    expect(prepared).toMatchObject({ ...geometry, subtitle_visual: productVisual, audio: { master_gain: 1.2 } })
    expect(prepared.subtitle).toBeUndefined()
    for (const oldTimeline of [
      { ...geometry, subtitle: { font_family: 'OldFamily', font_size_px: 35 } },
      { ...geometry, subtitle_visual: {} },
      { ...geometry, subtitle_visual: { ...productVisual, font_size_px: 65, font_family: 'OldFamily' } },
    ]) {
      const selected = (await resolveDeliveryPolicy(project, oldTimeline, productVisual, true)).delivery
      expect(selected).toMatchObject({ ...geometry, subtitle_visual: productVisual, audio: { master_gain: 1.2 },
        draft_style: { watermark: { font_size_ui: 7 } } })
      expect(selected.subtitle).toBeUndefined()
      expect(buildAssHeader({ subtitleFontFamily: 'Zhuque Fangsong (technical preview)', watermarkFontFamily: 'Noto Sans CJK SC' }, selected))
        .toContain('Style: Default,Zhuque Fangsong (technical preview),')
    }
    expect(await readFile(configPath, 'utf8')).toBe(config)
    // No product flag means unrelated integrations retain their existing overrides.
    await writeFile(configPath, JSON.stringify({ project_bible: { delivery: { ...geometry, subtitle_visual: {} } } }))
    expect((await resolveDeliveryPolicy(project, { ...geometry, subtitle_visual: {} }, productVisual)).delivery.subtitle_visual).toEqual({})
  })

  it('enforces the product visual for an EP46-shaped geometry while preserving frame rate and dimensions', async () => {
    const project = await mkdtemp(join(tmpdir(), 'subtitle-force-ep46-'))
    const productVisual = { ...visual, font_size_px: 48, center_y_ratio: 0.736747073 }
    await writeFile(join(project, 'project_config.json'), JSON.stringify({ project_bible: {
      delivery: { width: 1440, height: 2560, fps: 60, subtitle: { font_family: 'OldFamily', font_size_px: 88 } },
    } }))
    const prepared = await readProjectDelivery(project, productVisual, true)
    expect(prepared).toMatchObject({ width: 1440, height: 2560, fps: 60, subtitle_visual: productVisual })
    expect((await resolveDeliveryPolicy(project, { width: 1440, height: 2560, fps: 60,
      subtitle_visual: { ...visual, font_family: 'OldFamily' } }, productVisual, true)).delivery)
      .toEqual(prepared)
  })

  it('ignores unusable old subtitle fields only in enforced mode while still validating unrelated timeline fields', () => {
    const document = { clips: [{ shot: 1, start_us: 0, duration_us: 1_000_000 }],
      delivery: { ...geometry, subtitle: null, subtitle_visual: { schema_version: 999 },
        visual_medium: 'photorealistic', audio: { master_gain: 1.2 },
        draft_style: { watermark: { font_size_ui: 7 }, subtitle: { font_size_ui: -100 } } } }
    expect(() => parseTimelineDocument(document, 'old-timeline')).toThrow('subtitle')
    expect(parseTimelineDocument(document, 'old-timeline', true).delivery).toEqual({ ...geometry,
      visual_medium: 'photorealistic', audio: { master_gain: 1.2 }, draft_style: { watermark: { font_size_ui: 7 } } })
    for (const invalid of [{ width: 481 }, { audio: { master_gain: -1 } }, { visual_medium: 'unknown' },
      { draft_style: { watermark: { font_size_ui: -1 } } }]) {
      expect(() => parseTimelineDocument({ ...document, delivery: { ...document.delivery, ...invalid } }, 'old-timeline', true)).toThrow()
    }
  })

  it.each([{ width: 1920, height: 1080, fps: 30 }, { width: 1080, height: 1080, fps: 30 }])(
    'keeps old non-portrait style precedence and does not inject the portrait fallback: %j', async (canvas) => {
      const project = await mkdtemp(join(tmpdir(), 'subtitle-product-nonportrait-'))
      const oldStyle = { font_size_px: 25, font_family: 'LegacyFont' }
      const config = JSON.stringify({ project_bible: { delivery: { ...canvas, subtitle: oldStyle,
        draft_style: { subtitle: { font_size_ui: 7 }, watermark: { font_size_ui: 7 } } } } })
      await writeFile(join(project, 'project_config.json'), config)
      const prepared = await readProjectDelivery(project, visual, true)
      expect(prepared).toMatchObject({ ...canvas, subtitle: oldStyle, draft_style: { subtitle: { font_size_ui: 7 } } })
      expect(prepared.subtitle_visual).toBeUndefined()
      const saved = { ...canvas, subtitle: { font_size_px: 20, font_family: 'SavedFont' } }
      expect((await resolveDeliveryPolicy(project, saved, visual, true)).delivery).toMatchObject(saved)
      const document = { clips: [{ shot: 1, start_us: 0, duration_us: 1_000_000 }], delivery: saved }
      expect(parseTimelineDocument(document, 'nonportrait', true).delivery).toMatchObject(saved)
      expect(() => parseTimelineDocument({ ...document, delivery: { ...saved, subtitle: null } }, 'nonportrait', true)).toThrow()
      await writeFile(join(project, 'project_config.json'), JSON.stringify({ project_bible: { delivery: canvas } }))
      expect((await readProjectDelivery(project, visual, true)).subtitle_visual).toBeUndefined()
      expect((await resolveDeliveryPolicy(project, canvas, visual, true)).delivery.subtitle_visual).toBeUndefined()
    })

  it('uses actual timeline geometry to choose enforcement when the project and timeline orientation differ', async () => {
    const project = await mkdtemp(join(tmpdir(), 'subtitle-force-orientation-'))
    const projectConfig = { project_bible: { delivery: { width: 1920, height: 1080, fps: 30,
      subtitle_visual: { schema_version: 999 }, draft_style: { subtitle: null, watermark: { font_size_ui: 7 } } } } }
    await writeFile(join(project, 'project_config.json'), JSON.stringify(projectConfig))
    const portraitTimeline = { ...geometry, subtitle: { font_size_px: 22, font_family: 'SavedFont' } }
    expect((await resolveDeliveryPolicy(project, portraitTimeline, visual, true)).delivery)
      .toMatchObject({ ...geometry, subtitle_visual: visual, draft_style: { watermark: { font_size_ui: 7 } } })
    const landscapeTimeline = { width: 1920, height: 1080, fps: 30 }
    await expect(resolveDeliveryPolicy(project, landscapeTimeline, visual, true)).rejects.toThrow('subtitle_visual')
    await writeFile(join(project, 'project_config.json'), JSON.stringify({ project_bible: { delivery: { ...geometry,
      subtitle: { font_size_px: 31, font_family: 'ProjectFont' } } } }))
    const landscapeSaved = { ...landscapeTimeline, subtitle: { font_size_px: 18, font_family: 'SavedFont' } }
    expect((await resolveDeliveryPolicy(project, landscapeSaved, visual, true)).delivery).toMatchObject(landscapeSaved)
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
