import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createLegacyBotPackage, legacyBotCompatibility } from '../src/legacy-bot.ts'
import { marketRecord } from '../src/format.ts'
import { marketDigest, readMarketPackage } from '../src/package.ts'
import type { MarketLegacyResource } from '../src/types.ts'

const archive = readFileSync(new URL('./fixtures/legacy-bot/storyboard-director-16-9-0.1.0.tgz', import.meta.url))
const limits = { archiveBytes: 64 * 1024, expandedBytes: 128 * 1024, fileCount: 16 }
const allowed = ['@deepseek-ai/dsh-persona', '@deepseek-ai/dsh-tool-skill']
const storyboard: MarketLegacyResource = {
  id: 'muse/bots/storyboard-director-16-9', kind: 'bot', title: '16:9 分镜导演', description: '目录描述',
  category: '镜头分镜', version: '0.1.0', requirements: [], requiredSkills: [], validation: '',
  sha256: '53c53c34ee234b1c3b4fd2c81075b3d717b43415692a87a7310e9a868e377129',
  href: '/market/downloads/bot-storyboard-director-16-9-0.1.0.tgz',
}

describe('first-batch Bot compatibility', () => {
  it.each([
    ['codex-coding', '29f298d04e2b77a5313170a2bff4c06c907c9d5d5a65f94adb7e8e88d357272d', 'standard', 'codex'],
    ['claude-code-coding', 'b850b5103e92a79024d787ba123ae39c3d3ed78f4b1b1d8d84747ccdf1630b76', 'standard', 'claude-code'],
    ['short-drama-director', 'e2d576d0766eccf5c348aab4a9dbc63f1246c4f37e2a269c20c6cedc1bda4653', 'short-drama', undefined],
    ['anime-3d-assets', '9cf990a59e7ac135c20a62d18a3969a8908fefcb831caf27da75a54e0425e4ed', 'short-drama', undefined],
    ['storyboard-director-16-9', storyboard.sha256, 'short-drama', undefined],
    ['commercial-poster-designer', 'a451d894cabcbf4f7b3fe74d41b7025214b46ed7895079c453d4809a7d9cea9e', 'short-drama', undefined],
    ['screenplay-editor', 'b72e9f64abd26b73c3980a149082c3198370af530ef1e0c9658a24038c9bb5d6', 'short-drama', undefined],
  ] as const)('pins the current preset and provider for %s', (slug, sha256, preset, provider) => {
    const source = { ...storyboard, id: `muse/bots/${slug}`, sha256 }
    expect(legacyBotCompatibility(source)).toEqual({ preset, provider })
  })

  it('retains the exact storyboard persona and imports only declarative rows', () => {
    const converted = createLegacyBotPackage(storyboard, archive, limits, allowed)
    const { manifest, files } = readMarketPackage(converted, limits, allowed)
    expect(manifest).toMatchObject({
      kind: 'bot', name: 'storyboard-director-16-9', title: '16:9 分镜导演', version: '0.1.0', license: 'UNLICENSED',
      presetPortrait: 'horizontal-storyboard-director', skills: [],
      plugins: [
        { name: '@deepseek-ai/dsh-persona' },
        { name: '@deepseek-ai/dsh-tool-skill', config: { scopedCatalogOwner: true } },
      ],
    })
    const persona = manifest.plugins?.[0]?.config
    if (!marketRecord(persona) || typeof persona.prefix !== 'string' || typeof persona.suffix !== 'string') throw new Error('Missing persona')
    expect(marketDigest(Buffer.from(persona.prefix)))
      .toBe('73f570534c75c97bad80f3baf6061fcccd376828a66a4b18d8562ba005578565')
    expect(marketDigest(Buffer.from(persona.suffix)))
      .toBe('c097ba4cea0c6906b4eb1eee848d89e6d011e61827f9706756c369f54b85f3a0')
    expect(files).toEqual({})
  })

  it('rejects an unpinned identity, a changed archive and disallowed runtime rows', () => {
    const wrongIdentity = { ...storyboard, id: 'muse/bots/other' }
    const wrongPin = { ...storyboard, sha256: 'a'.repeat(64) }
    expect(legacyBotCompatibility(wrongIdentity)).toBeUndefined()
    expect(legacyBotCompatibility(wrongPin)).toBeUndefined()
    expect(() => createLegacyBotPackage(wrongIdentity, archive, limits, allowed)).toThrow('unsupported-legacy-package')
    expect(() => createLegacyBotPackage({ ...storyboard, kind: 'skill' }, archive, limits, allowed)).toThrow('unsupported-legacy-package')
    expect(() => createLegacyBotPackage(storyboard, archive.subarray(1), limits, allowed)).toThrow('digest-mismatch')
    expect(() => createLegacyBotPackage(storyboard, archive, { ...limits, archiveBytes: 2 }, allowed)).toThrow('archive-too-large')
    expect(() => createLegacyBotPackage(storyboard, archive, limits, ['@deepseek-ai/dsh-persona'])).toThrow('invalid-manifest')
  })
})
