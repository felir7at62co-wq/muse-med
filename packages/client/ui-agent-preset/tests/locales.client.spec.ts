/** Web-localized copy for shipped presets and declared copy for every other row. */

import { describe, expect, it } from 'vitest'
import { en, presetDisplayText, zh } from '../src/client/locales.ts'

const translate = (bundle: typeof en) => (key: keyof typeof en): string => bundle[key]

describe('preset display copy', () => {
  it.each([
    ['standard', 'presetStandardName', 'presetStandardDescription'],
    ['ptc', 'presetPtcName', 'presetPtcDescription'],
    ['minimal', 'presetMinimalName', 'presetMinimalDescription'],
    ['cordis', 'presetCordisName', 'presetCordisDescription'],
    ['creation', 'presetCreationName', 'presetCreationDescription'],
  ] as const)('localizes the shipped %s preset in English and Chinese', (id, nameKey, descriptionKey) => {
    const preset = { id }

    expect(presetDisplayText(preset, translate(en)))
      .toEqual({ name: en[nameKey], description: en[descriptionKey] })
    expect(presetDisplayText(preset, translate(zh)))
      .toEqual({ name: zh[nameKey], description: zh[descriptionKey] })
  })

  it('keeps creation and Cordis authoring copy distinct', () => {
    expect(presetDisplayText({ id: 'creation' }, translate(en)).name).toBe('Creation mode')
    expect(presetDisplayText({ id: 'creation' }, translate(zh)).name).toBe('创作模式')
    expect(presetDisplayText({ id: 'cordis' }, translate(en)).name).toBe('Creator mode')
    expect(presetDisplayText({ id: 'cordis' }, translate(zh)).name).toBe('创造模式')
  })

  it('keeps declared metadata untranslated for named and unknown presets', () => {
    const fileCopy = { name: '我的标准', description: '团队自己的 preset。' }

    expect(presetDisplayText({ id: 'standard', ...fileCopy }, translate(en)))
      .toEqual(fileCopy)
    expect(presetDisplayText({ id: 'creation', ...fileCopy }, translate(zh)))
      .toEqual(fileCopy)
    expect(presetDisplayText({ id: 'creation', name: 'My creation' }, translate(en)))
      .toEqual({ name: 'My creation' })
    expect(presetDisplayText({ id: 'deployment-extra', ...fileCopy }, translate(en)))
      .toEqual(fileCopy)
    expect(presetDisplayText({ id: 'bare' }, translate(en)))
      .toEqual({ name: 'bare' })
  })
})
