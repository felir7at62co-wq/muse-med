/**
 * The page's draft and write-set compiler: what a form value means, and which
 * path operations take the resolved section to it.
 *
 * Pure functions, so this lane drives them directly — the page and the composer
 * chip are the only callers, and each of their specs asserts its own rendering.
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_BGM_DIR, DEFAULT_DELIVERY_SPEC, DEFAULT_JIANYING_DRAFT_DIR, DRAMA_SETTINGS_DEFAULTS,
  type DramaSettings,
} from '../src/settings.ts'
import {
  defaultOps, draftOf, draftSection, landed, sameSettings, sectionOps, type DramaSettingsDraft,
} from '../src/client/section.ts'

/** A section with every field stated explicitly, so a test changes one thing. */
function section(overrides: Partial<DramaSettings> = {}): DramaSettings {
  return { ...DRAMA_SETTINGS_DEFAULTS, ...overrides }
}

/** The draft of one section, with the changes a test types into it. */
function draft(overrides: Partial<DramaSettingsDraft> = {}): DramaSettingsDraft {
  return { ...draftOf(DRAMA_SETTINGS_DEFAULTS), ...overrides }
}

describe('draftOf', () => {
  it('spells the spec numbers as the text the boxes hold', () => {
    expect(draftOf(section({ deliverySpec: { width: 1080, height: 1920, fps: 30, minBitrateMbps: 3.25 } })))
      .toEqual({
        deliveryDir: '',
        jianyingDraftDir: DEFAULT_JIANYING_DRAFT_DIR,
        width: '1080',
        height: '1920',
        fps: '30',
        minBitrateMbps: '3.25',
        bgmDir: DEFAULT_BGM_DIR,
        imageStandardId: '',
      })
  })

  it('spells a pinned image-route row as the select value that chose it', () => {
    expect(draftOf(section({ imageStandardId: 66 })).imageStandardId).toBe('66')
    expect(draftOf(DRAMA_SETTINGS_DEFAULTS).imageStandardId).toBe('')
  })
})

describe('draftSection', () => {
  it('returns the typed section with paths trimmed', () => {
    expect(draftSection(draft({
      deliveryDir: '  D:\\deliveries  ',
      jianyingDraftDir: '  D:\\draft  ',
      width: ' 1080 ',
      height: '1920',
      fps: '30',
      minBitrateMbps: '3.25',
      bgmDir: ' D:\\bgm ',
    }))).toEqual({
      deliveryDir: 'D:\\deliveries',
      jianyingDraftDir: 'D:\\draft',
      deliverySpec: { width: 1080, height: 1920, fps: 30, minBitrateMbps: 3.25 },
      bgmDir: 'D:\\bgm',
    })
  })

  it('reads a blank path box as that field’s default', () => {
    expect(draftSection(draft({ deliveryDir: '', jianyingDraftDir: '   ', bgmDir: '' })))
      .toEqual(DRAMA_SETTINGS_DEFAULTS)
  })

  it('refuses a spec box that holds no number', () => {
    expect(draftSection(draft({ width: 'wide' }))).toBeUndefined()
    expect(draftSection(draft({ height: '' }))).toBeUndefined()
    expect(draftSection(draft({ fps: '29.97x' }))).toBeUndefined()
    expect(draftSection(draft({ minBitrateMbps: ' ' }))).toBeUndefined()
  })

  it('carries the chosen image-route row as a number, and a blank select as no pin', () => {
    expect(draftSection(draft({ imageStandardId: '66' }))).toMatchObject({ imageStandardId: 66 })
    expect(draftSection(draft({ imageStandardId: '' }))).toEqual(DRAMA_SETTINGS_DEFAULTS)
    expect(draftSection(draft({ imageStandardId: '  ' }))).toEqual(DRAMA_SETTINGS_DEFAULTS)
    // Only a select can fill this box, so a value that is not a number is refused
    // rather than dropped: saving must never quietly unpin a row.
    expect(draftSection(draft({ imageStandardId: '66x' }))).toBeUndefined()
  })
})

describe('sectionOps', () => {
  it('writes nothing while the section already states the draft', () => {
    expect(sectionOps(DRAMA_SETTINGS_DEFAULTS, DRAMA_SETTINGS_DEFAULTS)).toEqual([])
    expect(sectionOps(section({ deliveryDir: 'D:\\out' }), section({ deliveryDir: 'D:\\out' }))).toEqual([])
  })

  it('sets every field that differs and clears one that returns to its default', () => {
    const current = section({ deliveryDir: 'D:\\out', bgmDir: 'D:\\bgm' })
    expect(sectionOps(current, section({ deliveryDir: 'D:\\other', bgmDir: DEFAULT_BGM_DIR })))
      .toEqual([
        { op: 'set', path: ['deliveryDir'], value: 'D:\\other' },
        { op: 'unset', path: ['bgmDir'] },
      ])
  })

  it('writes and clears each scalar field on its own', () => {
    expect(sectionOps(section({ deliveryDir: 'D:\\out' }), DRAMA_SETTINGS_DEFAULTS))
      .toEqual([{ op: 'unset', path: ['deliveryDir'] }])
    expect(sectionOps(DRAMA_SETTINGS_DEFAULTS, section({ jianyingDraftDir: 'D:\\draft' })))
      .toEqual([{ op: 'set', path: ['jianyingDraftDir'], value: 'D:\\draft' }])
    expect(sectionOps(section({ jianyingDraftDir: 'D:\\draft' }), DRAMA_SETTINGS_DEFAULTS))
      .toEqual([{ op: 'unset', path: ['jianyingDraftDir'] }])
    expect(sectionOps(DRAMA_SETTINGS_DEFAULTS, section({ bgmDir: 'D:\\bgm' })))
      .toEqual([{ op: 'set', path: ['bgmDir'], value: 'D:\\bgm' }])
  })

  it('pins the image-route row when one is chosen and clears it when none is', () => {
    expect(sectionOps(DRAMA_SETTINGS_DEFAULTS, section({ imageStandardId: 66 })))
      .toEqual([{ op: 'set', path: ['imageStandardId'], value: 66 }])
    expect(sectionOps(section({ imageStandardId: 66 }), DRAMA_SETTINGS_DEFAULTS))
      .toEqual([{ op: 'unset', path: ['imageStandardId'] }])
    // Repinning a different row is one write, never an unset followed by a set.
    expect(sectionOps(section({ imageStandardId: 66 }), section({ imageStandardId: 76 })))
      .toEqual([{ op: 'set', path: ['imageStandardId'], value: 76 }])
  })

  it('writes the spec as one object and clears it when it states the default', () => {
    const changed = { width: 1080, height: 1920, fps: 30, minBitrateMbps: 3.25 }
    expect(sectionOps(DRAMA_SETTINGS_DEFAULTS, section({ deliverySpec: changed })))
      .toEqual([{ op: 'set', path: ['deliverySpec'], value: changed }])
    expect(sectionOps(section({ deliverySpec: changed }), DRAMA_SETTINGS_DEFAULTS))
      .toEqual([{ op: 'unset', path: ['deliverySpec'] }])
  })

  it('compares the spec field by field', () => {
    const one = DEFAULT_DELIVERY_SPEC
    expect(sectionOps(section({ deliverySpec: one }), section({ deliverySpec: { ...one, width: 1080 } }))).toHaveLength(1)
    expect(sectionOps(section({ deliverySpec: one }), section({ deliverySpec: { ...one, height: 1080 } }))).toHaveLength(1)
    expect(sectionOps(section({ deliverySpec: one }), section({ deliverySpec: { ...one, fps: 30 } }))).toHaveLength(1)
    expect(sectionOps(section({ deliverySpec: one }), section({ deliverySpec: { ...one, minBitrateMbps: 3 } }))).toHaveLength(1)
  })

  it('clears every field for a restore', () => {
    expect(defaultOps()).toEqual([
      { op: 'unset', path: ['deliveryDir'] },
      { op: 'unset', path: ['jianyingDraftDir'] },
      { op: 'unset', path: ['deliverySpec'] },
      { op: 'unset', path: ['bgmDir'] },
      { op: 'unset', path: ['imageStandardId'] },
    ])
  })

  it('treats a namespace that has not resolved yet as holding no user layer', () => {
    expect(sectionOps(undefined, DRAMA_SETTINGS_DEFAULTS)).toEqual([])
    expect(sectionOps(undefined, section({ bgmDir: 'D:\\bgm', deliveryDir: 'D:\\out' })))
      .toEqual([
        { op: 'set', path: ['deliveryDir'], value: 'D:\\out' },
        { op: 'set', path: ['bgmDir'], value: 'D:\\bgm' },
      ])
  })
})

describe('landed', () => {
  it('is true only for a resolved section that states the intended value', () => {
    expect(landed(DRAMA_SETTINGS_DEFAULTS, section())).toBe(true)
    expect(landed(section({ bgmDir: 'D:\\bgm' }), DRAMA_SETTINGS_DEFAULTS)).toBe(false)
    expect(landed(undefined, DRAMA_SETTINGS_DEFAULTS)).toBe(false)
  })
})

describe('sameSettings', () => {
  it('is true only while every field states the intended value', () => {
    expect(sameSettings(DRAMA_SETTINGS_DEFAULTS, section())).toBe(true)
    expect(sameSettings(DRAMA_SETTINGS_DEFAULTS, section({ deliveryDir: 'D:\\out' }))).toBe(false)
    expect(sameSettings(DRAMA_SETTINGS_DEFAULTS, section({ jianyingDraftDir: 'D:\\draft' }))).toBe(false)
    expect(sameSettings(DRAMA_SETTINGS_DEFAULTS, section({ bgmDir: 'D:\\bgm' }))).toBe(false)
    expect(sameSettings(DRAMA_SETTINGS_DEFAULTS, section({ imageStandardId: 66 }))).toBe(false)
    expect(sameSettings(section({ imageStandardId: 66 }), section({ imageStandardId: 76 }))).toBe(false)
    expect(sameSettings(DRAMA_SETTINGS_DEFAULTS, section({ deliverySpec: { ...DEFAULT_DELIVERY_SPEC, fps: 30 } })))
      .toBe(false)
  })
})
