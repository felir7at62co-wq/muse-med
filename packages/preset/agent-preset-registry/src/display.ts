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
 * @module @deepseek-ai/dsh-agent-preset-registry/display
 */

/**
 * Deprecated preset ids resolved to the preset that replaced them.
 *
 * Historical `short-drama-local` and `editing` sessions resolve to `short-drama`.
 * Session headers and selection events keep their recorded ids; resolution and
 * projection views use the successor. Aliases do not join the roster, and an
 * explicitly restored definition under an old id takes precedence.
 * Keep these entries while durable sessions or stored defaults can name them.
 */
export const DEPRECATED_PRESET_IDS: Readonly<Record<string, string>> = {
  'short-drama-local': 'short-drama',
  editing: 'short-drama',
}

/** Dictionary keys carrying one shipped preset's display copy. */
export type BuiltInPresetCopyKey =
  | 'presetStandardName' | 'presetStandardDescription'
  | 'presetPtcName' | 'presetPtcDescription'
  | 'presetMinimalName' | 'presetMinimalDescription'
  | 'presetCordisName' | 'presetCordisDescription'
  | 'presetCreationName' | 'presetCreationDescription'

/** Preset roster fields needed to resolve display copy. */
export interface PresetDisplaySource {
  /** Stable preset id. */
  readonly id: string
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
  creation: { name: 'presetCreationName', description: 'presetCreationDescription' },
}

/**
 * Whether a roster row is one of the shipped presets whose copy the dictionaries carry.
 * A shipped preset publishes no `name`; a declaration that names itself owns its copy.
 * @param preset - roster row.
 * @returns true for a shipped preset id without a published name.
 */
export function isBuiltInPreset(preset: PresetDisplaySource): boolean {
  return preset.name === undefined && BUILT_IN_PRESET_KEYS[preset.id] !== undefined
}

/**
 * Resolve preset display copy without making user-authored metadata translatable.
 * @param preset - roster row whose copy is being rendered.
 * @param t - active locale lookup covering {@link BuiltInPresetCopyKey}.
 * @returns localized copy for a known shipped preset, otherwise declaration metadata.
 */
export function presetDisplayText(
  preset: PresetDisplaySource,
  t: (key: BuiltInPresetCopyKey) => string,
): PresetDisplayText {
  const keys = isBuiltInPreset(preset) ? BUILT_IN_PRESET_KEYS[preset.id] : undefined
  if (keys !== undefined) return { name: t(keys.name), description: t(keys.description) }
  return {
    name: preset.name ?? preset.id,
    ...preset.description === undefined ? {} : { description: preset.description },
  }
}
