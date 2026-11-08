/** Validate the public startup policy without exposing Session or account state. */
import Schema from '@deepseek-ai/schemastery'
import type { Volatile } from '@deepseek-ai/cordis'

/** Validated presentation settings shared by Host and Client. */
export interface Config {
  /** Live switch for all conversation presentation contributions. */
  readonly enabled: Volatile<boolean>
  /** Horizontal pixels occupied by one second in the shot timeline. */
  readonly pixelsPerSecond: number
}

/** Validated timeline scale owned by this plugin. */
export const Config = Schema.object({
  enabled: Schema.boolean().default(true).volatile(),
  pixelsPerSecond: Schema.number().min(1).default(48),
})

/** Non-secret, resolved startup values; subsequent switches use accepted settings. */
export interface PresentationConfig {
  readonly enabled: boolean
  readonly pixelsPerSecond: number
}

const BootstrapConfig = Schema.object({
  enabled: Schema.boolean().default(true),
  pixelsPerSecond: Schema.number().min(1).default(48),
})

/** Canonical profile entry exposed by the live configuration form. */
export const SETTINGS_ENTRY = 'ui-session-video'

/** Page bootstrap key for non-secret presentation configuration. */
export const SESSION_VIDEO_CONFIG_GLOBAL = '__MUSE_SESSION_VIDEO_CONFIG__'

/**
 * Resolve the Host's public bootstrap policy before registering the video surface.
 * @returns Validated policy, using the schema defaults when the Host supplied none.
 */
export function readSessionVideoConfig(): PresentationConfig {
  const value: unknown = Reflect.get(globalThis, SESSION_VIDEO_CONFIG_GLOBAL)
  if (value === undefined) return BootstrapConfig({})
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid Session video configuration')
  const pixelsPerSecond: unknown = Reflect.get(value, 'pixelsPerSecond')
  const enabled: unknown = Reflect.get(value, 'enabled')
  if (pixelsPerSecond !== undefined && typeof pixelsPerSecond !== 'number') throw new TypeError('Invalid Session video timeline scale')
  if (enabled !== undefined && typeof enabled !== 'boolean') throw new TypeError('Invalid Session video enabled setting')
  return BootstrapConfig({ ...(enabled === undefined ? {} : { enabled }), ...(pixelsPerSecond === undefined ? {} : { pixelsPerSecond }) })
}
