/** Type declarations for the shared plain-Node read snapshot plugin. */
import type { Context } from '@deepseek-ai/cordis'
import type Schema from '@deepseek-ai/schemastery'

/** Exact scenario-owned seed paths resolved by the real filesystem provider. */
export interface Config {
  files: string[]
  /** Maximum bytes hashed per owned file; defaults to 1024. */
  maxBytes?: number
  /** Owned JSON reports whose script, assets_manifest and written paths use a portable workspace prefix. */
  reportFiles?: string[]
}

/** Required seed paths; non-seed targets retain their real provider versions. */
export const Config: Schema<Config>
export const name: 'read-snapshot-version'
export const inject: string[]

/**
 * Install the effect-owned content-version wrapper implemented by the adjacent MJS module.
 * @param ctx - Scenario context with the shipped filesystem provider.
 * @param config - Exact workspace files whose versions must be portable, with resolved defaults.
 * @returns When the scenario-owned version effect is installed.
 */
export function apply(ctx: Context, config: Config): Promise<void>
