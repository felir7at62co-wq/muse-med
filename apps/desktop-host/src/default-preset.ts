/** Launch-scoped choice of the preset new sessions start on, for comparing a trial preset with the product default. */
import { z } from 'zod'

const registryConfig = z.looseObject({ selectablePresets: z.array(z.string()).optional() })

/**
 * Build the patch layer that makes `MUSE_DEFAULT_PRESET` the default preset of this launch.
 * @param config - Composed `agent-preset-registry` row config, whose other fields are kept.
 * @param preset - Value of `MUSE_DEFAULT_PRESET`; undefined or empty leaves the product default.
 * @returns the overriding layer, or undefined when no preset is requested. A preset outside `selectablePresets` throws.
 */
export function defaultPresetLayer(
  config: unknown, preset: string | undefined,
): [{ id: string; config: Record<string, unknown> }] | undefined {
  if (preset === undefined || preset === '') return undefined
  const current = registryConfig.parse(config ?? {})
  const selectable = current.selectablePresets ?? []
  if (!selectable.includes(preset)) {
    throw new Error(`muse-med: MUSE_DEFAULT_PRESET "${preset}" is not a selectable preset (${selectable.join(', ')})`)
  }
  return [{ id: 'agent-preset-registry', config: { ...current, default: preset } }]
}
