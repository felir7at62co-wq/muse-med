/** Browser and Node package adapters share byte identity and reject the same unsafe archive inputs. */
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { unzipSync, zipSync } from 'fflate'
import { createLegacySkillPackageBrowser, createMarketPackageBrowser, marketDigestBrowser,
  marketReleaseBrowser, prepareMarketUploadBrowser, readMarketPackageBrowser } from '@deepseek-ai/dsh-muse-market/browser'
import { createLegacySkillPackage } from '../src/legacy-skill.ts'
import { parseMarketLegacyCatalog } from '../src/legacy.ts'
import { createMarketPackage, marketDigest, marketRelease, readMarketPackage } from '../src/package.ts'
import { instructions, limits, manifest, resources } from './fixtures.ts'
import { originalCatalogEntry, originalSkillArchive } from './legacy-fixtures.ts'
import { encodeMarketPackageContent } from '../src/package-content.ts'

function selected(archive: Uint8Array, name = 'fixture-skill') {
  const resource = parseMarketLegacyCatalog({ schemaVersion: 1, entries: [originalCatalogEntry(archive, name)] }, '', limits, 100)[0]
  if (resource === undefined) throw new Error('Missing original fixture')
  return resource
}

describe('browser publication codec', () => {
  it('refuses cryptographic verification when the browser does not expose Web Crypto', async () => {
    try {
      vi.stubGlobal('crypto', undefined)
      await expect(marketDigestBrowser(Uint8Array.of(80, 75))).rejects.toThrow('crypto-unavailable')
      vi.stubGlobal('crypto', {})
      await expect(marketDigestBrowser(Uint8Array.of(80, 75))).rejects.toThrow('crypto-unavailable')
    } finally { vi.unstubAllGlobals() }
  })

  it('rejects a same-length binary edit after structural validation in both hashing adapters', async () => {
    const entries = unzipSync(createMarketPackage(manifest, resources, limits))
    const binary = entries['skills/fixture-skill/assets/sample.bin']!
    const edited = new Uint8Array(binary)
    edited[0] = edited[0]! ^ 0xff
    const archive = zipSync({ ...entries, 'skills/fixture-skill/assets/sample.bin': edited })
    expect(() => readMarketPackage(archive, limits)).toThrow('file-mismatch')
    await expect(readMarketPackageBrowser(archive, limits)).rejects.toThrow('file-mismatch')
  })

  it('requires independently supplied resource hashes before encoding a complete package', () => {
    expect(() => encodeMarketPackageContent(manifest, resources, new Map())).toThrow('file-mismatch')
  })

  it('creates, verifies and fingerprints the same exact bytes as the Node codec', async () => {
    const expected = createMarketPackage(manifest, resources, limits)
    const actual = await createMarketPackageBrowser(manifest, resources, limits)
    expect(actual).toEqual(expected)
    expect(await marketDigestBrowser(actual)).toBe(marketDigest(expected))
    expect(await marketReleaseBrowser(actual, limits)).toEqual(marketRelease(expected, limits))
    const decoded = await readMarketPackageBrowser(actual, limits)
    expect(decoded.manifest).toEqual(manifest)
    expect(decoded.skillInstructions).toBe(decoded.files[decoded.manifest.skills[0].path])
    for (const [path, bytes] of Object.entries(resources)) expect(decoded.files[path]).toEqual(new Uint8Array(bytes))
  })

  it('snapshots caller-owned metadata, archives and resources before asynchronous digest work', async () => {
    const files = Object.fromEntries(Object.entries(resources).map(([path, bytes]) => [path, new Uint8Array(bytes)]))
    const metadata = { ...manifest, examples: ['Original example'] }
    const expected = createMarketPackage(metadata, files, limits)
    const pending = createMarketPackageBrowser(metadata, files, limits)
    files['skills/fixture-skill/assets/sample.bin']!.fill(12)
    metadata.examples[0] = 'Changed during hashing'
    expect(await pending).toEqual(expected)
    const input = new Uint8Array(expected), read = readMarketPackageBrowser(input, limits)
    input.fill(0)
    expect((await read).manifest.examples).toEqual(['Original example'])
  })

  it('binds only an absent portrait, retains every resource and leaves the input unchanged', async () => {
    const original = createMarketPackage(manifest, resources, limits), snapshot = new Uint8Array(original)
    const prepared = await prepareMarketUploadBrowser(original, 'episode-planner', limits)
    const decoded = readMarketPackage(prepared, limits)
    expect(decoded.manifest.presetPortrait).toBe('episode-planner')
    for (const [path, bytes] of Object.entries(resources)) expect(decoded.files[path]).toEqual(new Uint8Array(bytes))
    expect(original).toEqual(snapshot)
    expect(prepared).toEqual(createMarketPackage({ ...manifest, presetPortrait: 'episode-planner' }, resources, limits))
    expect(await prepareMarketUploadBrowser(prepared, 'storyboard-reviewer', limits)).toEqual(prepared)
    await expect(prepareMarketUploadBrowser(prepared, '../portrait', limits)).rejects.toThrow('invalid-manifest')
  })

  it('refuses changed resources, unsafe paths, malformed Skill text and size limits', async () => {
    const archive = createMarketPackage(manifest, resources, limits), entries = unzipSync(archive)
    const changed = zipSync({ ...entries, 'skills/fixture-skill/assets/sample.bin': Uint8Array.of(99) })
    await expect(readMarketPackageBrowser(changed, limits)).rejects.toThrow('file-mismatch')
    await expect(readMarketPackageBrowser(zipSync({ ...entries, '../escape': Uint8Array.of(1) }), limits)).rejects.toThrow('invalid-path')
    await expect(readMarketPackageBrowser(archive, { ...limits, archiveBytes: 1 })).rejects.toThrow('archive-too-large')
    await expect(readMarketPackageBrowser(archive, { ...limits, expandedBytes: 1 })).rejects.toThrow('expanded-limit')
    await expect(readMarketPackageBrowser(archive, { ...limits, fileCount: 1 })).rejects.toThrow('expanded-limit')
    await expect(readMarketPackageBrowser(archive, { ...limits, recordBytes: 1 })).rejects.toThrow('invalid-manifest')
    await expect(createMarketPackageBrowser(manifest, { ...resources, 'skills/fixture-skill/SKILL.md': Uint8Array.of(255) }, limits))
      .rejects.toThrow('invalid-skill')
  })
})

describe('browser original Skill conversion', () => {
  it('preserves original resource bytes and matches the Node converter exactly', async () => {
    const archive = originalSkillArchive(), resource = selected(archive)
    const converted = await createLegacySkillPackageBrowser(resource, archive, limits)
    expect(converted).toEqual(createLegacySkillPackage(resource, archive, limits))
    expect((await readMarketPackageBrowser(converted, limits)).files['skills/fixture-skill/SKILL.md'])
      .toEqual(new TextEncoder().encode(instructions))
    await expect(createLegacySkillPackageBrowser({ ...resource, sha256: '0'.repeat(64) }, archive, limits)).rejects.toThrow('digest-mismatch')
    await expect(createLegacySkillPackageBrowser({ ...resource, bytes: archive.byteLength + 1 }, archive, limits)).rejects.toThrow('digest-mismatch')
  })

  it('uses the same reviewed Office helper and reference relocation as the Node converter', async () => {
    const archive = readFileSync(new URL('./fixtures/legacy-office-docx-0.1.0.zip', import.meta.url))
    const resource = selected(archive, 'office-docx')
    const converted = await createLegacySkillPackageBrowser(resource, archive, limits)
    expect(converted).toEqual(createLegacySkillPackage(resource, archive, limits))
    const entries = unzipSync(archive)
    const changed = zipSync({ ...entries, 'scripts/check_office.py': new TextEncoder().encode('different helper') })
    await expect(createLegacySkillPackageBrowser(selected(changed, 'office-docx'), changed, limits)).rejects.toThrow('digest-mismatch')
    const outside = zipSync({ ...entries, 'another/secret.txt': Uint8Array.of(1) })
    await expect(createLegacySkillPackageBrowser(selected(outside, 'office-docx'), outside, limits)).rejects.toThrow('invalid-path')
  })
})
