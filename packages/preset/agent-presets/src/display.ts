/**
 * Display resolution for roster presets, shared by every surface that renders
 * preset names: shipped presets resolve through locale dictionary keys, and
 * user-authored metadata is never translated. A pure fold with no imports, so
 * browser bundles inline it and the Host uses the same single home for which
 * shipped id carries which copy key.
 *
 * It also carries {@link DEPRECATED_PRESET_IDS}, the one mapping from a renamed
 * preset id to its successor: roster resolution, the session projection's wire
 * view, and the default comparison all read this table rather than keeping a
 * copy each.
 * @module @deepseek-ai/dsh-agent-presets/display
 */

/**
 * Deprecated preset ids resolved to the preset that replaced them.
 *
 * The product's own short-drama preset was renamed from `short-drama-local` to
 * `short-drama`. A session created before that rename names the old id in its
 * creation header and in every `agent-preset/selected` event after it, and this
 * version has no alias mechanism, so resuming one failed with
 * `agent-preset/not-found` — a durable record outlived the directory that
 * answered it.
 *
 * The mapping is resolution-only: the alias never joins the roster (`list` and
 * the picker still show exactly what the roots supply), and a real preset wins
 * the lookup, so a directory restored under the old id keeps answering for
 * itself.
 *
 * Delete an entry once no durable record can still name it. For
 * `short-drama-local` that is when no session created before the rename
 * (2026-09-26) remains resumable, and no settings document still stores it as
 * the chosen default.
 */
export const DEPRECATED_PRESET_IDS: Readonly<Record<string, string>> = {
  'short-drama-local': 'short-drama',
}

/** Dictionary keys carrying one shipped preset's display copy. */
export type BuiltInPresetCopyKey =
  | 'presetStandardName' | 'presetStandardDescription'
  | 'presetPtcName' | 'presetPtcDescription'
  | 'presetMinimalName' | 'presetMinimalDescription'
  | 'presetCordisName' | 'presetCordisDescription'

/** Preset roster fields needed to resolve display copy. */
export interface PresetDisplaySource {
  /** Stable preset id. */
  readonly id: string
  /** Whether the deployment ships the preset or the user owns it. */
  readonly trust: 'system' | 'user'
  /** Unlocalized name published by the preset. */
  readonly name?: string
  /** Unlocalized description published by the preset. */
  readonly description?: string
}

/** Display copy resolved for the active locale. */
export interface PresetDisplayText {
  /** Localized built-in name or the preset's own fallback name. */
  readonly name: string
  /** Localized built-in description or the preset's own description. */
  readonly description?: string
}

interface PresetLocaleKeys {
  readonly name: BuiltInPresetCopyKey
  readonly description: BuiltInPresetCopyKey
}

const BUILT_IN_PRESET_KEYS: Readonly<Partial<Record<string, PresetLocaleKeys>>> = {
  standard: { name: 'presetStandardName', description: 'presetStandardDescription' },
  ptc: { name: 'presetPtcName', description: 'presetPtcDescription' },
  minimal: { name: 'presetMinimalName', description: 'presetMinimalDescription' },
  cordis: { name: 'presetCordisName', description: 'presetCordisDescription' },
}

/**
 * Resolve preset display copy without making user-authored metadata translatable.
 * @param preset - roster row whose copy is being rendered.
 * @param t - active locale lookup covering {@link BuiltInPresetCopyKey}.
 * @returns localized copy for a known shipped preset, otherwise file metadata.
 */
export function presetDisplayText(
  preset: PresetDisplaySource,
  t: (key: BuiltInPresetCopyKey) => string,
): PresetDisplayText {
  const keys = preset.trust === 'system' ? BUILT_IN_PRESET_KEYS[preset.id] : undefined
  if (keys !== undefined) return { name: t(keys.name), description: t(keys.description) }
  return {
    name: preset.name ?? preset.id,
    ...preset.description === undefined ? {} : { description: preset.description },
  }
}
