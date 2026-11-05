/** Restore the current tool preset for previously installed, audited Bot sessions. */
import type { MarketLegacyResource } from './types.ts'

type LegacyBotSource = Pick<MarketLegacyResource, 'id' | 'sha256'>
type LegacyBasePreset = 'short-drama' | 'standard'
type LegacyCodingProvider = 'codex' | 'claude-code'

interface PinnedBot {
  readonly sha256: string
  readonly preset: LegacyBasePreset
  readonly provider?: LegacyCodingProvider
}

const pinnedBots = new Map<string, PinnedBot>([
  ['muse/bots/codex-coding', { sha256: '29f298d04e2b77a5313170a2bff4c06c907c9d5d5a65f94adb7e8e88d357272d', preset: 'standard', provider: 'codex' }],
  ['muse/bots/claude-code-coding', { sha256: 'b850b5103e92a79024d787ba123ae39c3d3ed78f4b1b1d8d84747ccdf1630b76', preset: 'standard', provider: 'claude-code' }],
  ['muse/bots/short-drama-director', { sha256: 'e2d576d0766eccf5c348aab4a9dbc63f1246c4f37e2a269c20c6cedc1bda4653', preset: 'short-drama' }],
  ['muse/bots/anime-3d-assets', { sha256: '9cf990a59e7ac135c20a62d18a3969a8908fefcb831caf27da75a54e0425e4ed', preset: 'short-drama' }],
  ['muse/bots/storyboard-director-16-9', { sha256: '53c53c34ee234b1c3b4fd2c81075b3d717b43415692a87a7310e9a868e377129', preset: 'short-drama' }],
  ['muse/bots/commercial-poster-designer', { sha256: 'a451d894cabcbf4f7b3fe74d41b7025214b46ed7895079c453d4809a7d9cea9e', preset: 'short-drama' }],
  ['muse/bots/screenplay-editor', { sha256: 'b72e9f64abd26b73c3980a149082c3198370af530ef1e0c9658a24038c9bb5d6', preset: 'short-drama' }],
])

/** Resolve a historical session's trusted preset and optional coding provider.
 * @param source Original identity and archive digest retained in the local ledger.
 * @returns Current tool configuration, or undefined for an unknown archive.
 */
export function legacyBotCompatibility(source: LegacyBotSource):
{ preset: LegacyBasePreset; provider: LegacyCodingProvider | undefined } | undefined {
  const bot = pinnedBots.get(source.id)
  return bot?.sha256 === source.sha256 ? { preset: bot.preset, provider: bot.provider } : undefined
}
