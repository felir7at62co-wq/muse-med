/**
 * Display resolution: shipped presets resolve through dictionary keys, and
 * user-authored metadata is never translated.
 */

import { describe, expect, it } from 'vitest'
import { isBuiltInPreset, presetDisplayText, type BuiltInPresetCopyKey } from '../src/display.ts'

const t = (key: BuiltInPresetCopyKey): string => `t:${key}`

describe('presetDisplayText', () => {
  it.each([
    ['standard', 'presetStandardName', 'presetStandardDescription'],
    ['ptc', 'presetPtcName', 'presetPtcDescription'],
    ['minimal', 'presetMinimalName', 'presetMinimalDescription'],
    ['cordis', 'presetCordisName', 'presetCordisDescription'],
    ['creation', 'presetCreationName', 'presetCreationDescription'],
  ] as const)('resolves the shipped %s preset through its dictionary keys', (id, name, description) => {
    expect(isBuiltInPreset({ id })).toBe(true)
    expect(presetDisplayText({ id }, t)).toEqual({ name: t(name), description: t(description) })
  })

  it('keeps user-authored metadata untranslated', () => {
    expect(presetDisplayText({ id: 'mine', name: '我的模式', description: '自述' }, t))
      .toEqual({ name: '我的模式', description: '自述' })
  })

  it('keeps a named creation override untranslated', () => {
    const preset = { id: 'creation', name: 'My creative workflow', description: 'Team instructions' }
    expect(isBuiltInPreset(preset)).toBe(false)
    expect(presetDisplayText(preset, t)).toEqual({ name: preset.name, description: preset.description })
    expect(presetDisplayText({ id: 'creation', name: 'My creation' }, t)).toEqual({ name: 'My creation' })
  })

  it('falls back to the id for a preset publishing no metadata', () => {
    // A system id outside the shipped set behaves like authored metadata:
    // there is no dictionary copy to resolve.
    expect(presetDisplayText({ id: 'future' }, t)).toEqual({ name: 'future' })
    expect(presetDisplayText({ id: 'bare' }, t)).toEqual({ name: 'bare' })
  })
})
