/** Preferences shared by Host persistence and Client controls. */
export type SubscriptionTool = 'image_generate' | 'video_generate' | 'x_search' | 'web_search'
/** Mirrors `PromptCacheTtl` in translate/anthropic.ts; kept here so the client bundle needs no translate import. */
export const PROMPT_CACHE_TTLS = ['5m', '1h'] as const
export type PromptCacheTtlSetting = typeof PROMPT_CACHE_TTLS[number]
export type SubagentSpeedTier = 'standard' | 'fast'
export interface AccountPreferences {
  alias?: string
  /** Absent means included. */
  poolEnabled?: boolean
  /** Absent means no separate picker entries. */
  independentEntry?: boolean
  /** Absent allows every model; [] allows none. */
  poolModels?: string[]
}
export interface ProviderPreferences {
  /** Presentation only; never used as a provider or model routing key. */
  displayName?: string
  modelDisplayNames?: Record<string, string>
  accounts?: Record<string, AccountPreferences>
  /** Absent follows discovery; an explicit selection hides newly discovered models. */
  visibleModels?: string[]
  contextWindows?: Record<string, number>
  /** Codex only: per-model defaults for subagents, independent of main-session speed. */
  subagentSpeeds?: Record<string, SubagentSpeedTier>
  tools?: Partial<Record<SubscriptionTool, boolean>>
  /** Claude only: overrides the plugin config's `claudePromptCacheTtl`; absent follows config. */
  promptCacheTtl?: PromptCacheTtlSetting
}
