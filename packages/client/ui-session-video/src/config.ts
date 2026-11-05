/** Validate the public startup policy without exposing Session or account state. */
import Schema from '@deepseek-ai/schemastery'

/** Validated presentation settings shared by Host and Client. */
export interface Config {
  /** Horizontal pixels occupied by one second in the shot timeline. */
  readonly pixelsPerSecond: number
}

/** Validated timeline scale owned by this plugin. */
export const Config: Schema<Partial<Config>, Config> = Schema.object({
  pixelsPerSecond: Schema.number().min(1).default(48),
})

/** Page bootstrap key for non-secret presentation configuration. */
export const SESSION_VIDEO_CONFIG_GLOBAL = '__MUSE_SESSION_VIDEO_CONFIG__'

/**
 * Resolve the Host's public bootstrap policy before registering the video surface.
 * @returns Validated policy, using the schema defaults when the Host supplied none.
 */
export function readSessionVideoConfig(): Config {
  const value: unknown = Reflect.get(globalThis, SESSION_VIDEO_CONFIG_GLOBAL)
  if (value === undefined) return Config({})
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid Session video configuration')
  const pixelsPerSecond: unknown = Reflect.get(value, 'pixelsPerSecond')
  if (pixelsPerSecond === undefined) return Config({})
  if (typeof pixelsPerSecond !== 'number') throw new TypeError('Invalid Session video timeline scale')
  return Config({ pixelsPerSecond })
}
