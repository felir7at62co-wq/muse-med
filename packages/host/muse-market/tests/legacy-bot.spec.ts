import { describe, expect, it } from 'vitest'
import { legacyBotCompatibility } from '../src/legacy-bot.ts'

describe('installed historical Bot recovery', () => {
  it.each([
    ['codex-coding', '29f298d04e2b77a5313170a2bff4c06c907c9d5d5a65f94adb7e8e88d357272d', 'standard', 'codex'],
    ['claude-code-coding', 'b850b5103e92a79024d787ba123ae39c3d3ed78f4b1b1d8d84747ccdf1630b76', 'standard', 'claude-code'],
    ['short-drama-director', 'e2d576d0766eccf5c348aab4a9dbc63f1246c4f37e2a269c20c6cedc1bda4653', 'short-drama', undefined],
    ['anime-3d-assets', '9cf990a59e7ac135c20a62d18a3969a8908fefcb831caf27da75a54e0425e4ed', 'short-drama', undefined],
    ['storyboard-director-16-9', '53c53c34ee234b1c3b4fd2c81075b3d717b43415692a87a7310e9a868e377129', 'short-drama', undefined],
    ['commercial-poster-designer', 'a451d894cabcbf4f7b3fe74d41b7025214b46ed7895079c453d4809a7d9cea9e', 'short-drama', undefined],
    ['screenplay-editor', 'b72e9f64abd26b73c3980a149082c3198370af530ef1e0c9658a24038c9bb5d6', 'short-drama', undefined],
  ] as const)('pins the current preset and provider for %s', (slug, sha256, preset, provider) => {
    const source = { id: `muse/bots/${slug}`, sha256 }
    expect(legacyBotCompatibility(source)).toEqual({ preset, provider })
  })

  it('rejects an unknown archive identity or digest', () => {
    expect(legacyBotCompatibility({ id: 'muse/bots/missing', sha256: 'a'.repeat(64) })).toBeUndefined()
    expect(legacyBotCompatibility({ id: 'muse/bots/codex-coding', sha256: 'a'.repeat(64) })).toBeUndefined()
  })
})
