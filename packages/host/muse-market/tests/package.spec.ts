import { describe, expect, it } from 'vitest'
import { unzipSync, zipSync } from 'fflate'
import { createMarketPackage, readMarketPackage, marketDigest, marketRelease } from '../src/package.ts'
import { marketManifest, marketPath, marketSkill } from '../src/format.ts'
import { limits, manifest, resources, instructions } from './fixtures.ts'

function wireArchive(files: Record<string, Uint8Array>, change: Record<string, unknown> = {}): Uint8Array {
  const rows = Object.entries(files).map(([path, bytes]) => ({ path, bytes: bytes.byteLength, sha256: marketDigest(bytes) }))
  return zipSync({ ...files, 'muse-package.json': Buffer.from(JSON.stringify({ ...manifest, files: rows, ...change })) }, { level: 0 })
}

describe('Skill publications', () => {
  it('retains the exact release identity for Unicode resource-name ordering', () => {
    const files = { ...resources, 'skills/fixture-skill/assets/é.txt': Buffer.from('accent'),
      'skills/fixture-skill/assets/𐀀.txt': Buffer.from('supplementary'), 'skills/fixture-skill/assets/！.txt': Buffer.from('wide') }
    expect(marketDigest(createMarketPackage(manifest, files, limits))).toBe('9df4635058000fa2c3360e62fe68d6739b6e7b5b41baa5a627047a3c7b41b5f5')
  })
  it('accepts directory records while verifying only declared regular resources', () => {
    const entries = unzipSync(createMarketPackage(manifest, resources, limits))
    const archive = zipSync({ 'skills/': new Uint8Array(), 'skills/fixture-skill/': new Uint8Array(), ...entries })
    expect(readMarketPackage(archive, limits).manifest).toEqual(manifest)
    expect(Object.keys(readMarketPackage(archive, limits).files).sort()).toEqual(Object.keys(resources).sort())
  })

  it.each(['{', '\ufffd'] as const)('refuses malformed manifest JSON %j', (text) => {
    expect(() => readMarketPackage(zipSync({ 'muse-package.json': Buffer.from(text) }), limits)).toThrow('invalid-manifest')
  })

  it('refuses a nonarray resource inventory and invalid or repeated inventory rows', () => {
    for (const files of [null, {}, [null, null, null], [{ path: 1 }, null, null]]) {
      expect(() => readMarketPackage(wireArchive(resources, { files }), limits)).toThrow('file-mismatch')
    }
    const rows = Object.entries(resources).map(([path, bytes]) => ({ path, bytes: bytes.byteLength, sha256: marketDigest(bytes) }))
    expect(() => readMarketPackage(wireArchive(resources, { files: [rows[0], rows[0], rows[2]] }), limits)).toThrow('file-mismatch')
  })

  it('refuses resources outside the declared Skill even when their file inventory matches', () => {
    expect(() => readMarketPackage(wireArchive({ ...resources, 'another-skill/private.txt': Buffer.from('unselected') }), limits))
      .toThrow('undeclared-skill')
  })

  it('requires the declared instruction file and validates its exact frontmatter bytes', () => {
    const { 'skills/fixture-skill/SKILL.md': _instructions, ...missing } = resources
    expect(() => readMarketPackage(wireArchive(missing), limits)).toThrow('missing-skill')
    expect(() => readMarketPackage(wireArchive({ ...resources, 'skills/fixture-skill/SKILL.md': Buffer.from('Not Skill instructions') }), limits))
      .toThrow('invalid-skill')
  })

  it('bounds actual expanded bytes when ZIP directory entries understate their uncompressed lengths', () => {
    const bytes = Buffer.from(wireArchive(resources)), view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    let offset = view.getUint32(bytes.byteLength - 6, true)
    const count = view.getUint16(bytes.byteLength - 12, true)
    for (let entry = 0; entry < count; entry++) {
      expect(view.getUint32(offset, true)).toBe(0x02014b50)
      view.setUint32(offset + 24, 0, true)
      offset += 46 + view.getUint16(offset + 28, true) + view.getUint16(offset + 30, true) + view.getUint16(offset + 32, true)
    }
    const expandedBytes = Object.values(unzipSync(bytes)).reduce((sum, value) => sum + value.byteLength, 0)
    expect(() => readMarketPackage(bytes, { ...limits, expandedBytes: expandedBytes - 1 })).toThrow('expanded-limit')
  })
  it('roundtrips binary resources, original instructions and deterministic release identity', () => {
    const archive = createMarketPackage(manifest, resources, limits)
    expect(createMarketPackage(manifest, resources, limits)).toEqual(archive)
    expect(createMarketPackage(manifest, Object.fromEntries(Object.entries(resources).reverse()), limits)).toEqual(archive)
    const decoded = readMarketPackage(archive, limits)
    expect(decoded.manifest).toEqual(manifest)
    for (const [path, bytes] of Object.entries(resources)) expect(Buffer.from(decoded.files[path]!)).toEqual(Buffer.from(bytes))
    expect(marketRelease(archive, limits)).toMatchObject({
      id: marketDigest(archive), sha256: marketDigest(archive), bytes: archive.byteLength,
    })
    expect(marketSkill(instructions, 'fixture-skill')).toEqual({ description: 'Review a scene.', content: 'Read references/rules.txt before reviewing.',
      whenToUse: 'For local scene review.', metadata: { audience: 'writers', tags: ['scene', '中文'] },
      invocation: { modelInvocable: false, userInvocable: true } })
  })

  it.each(['../escape', '/absolute', 'C:/drive', 'a\\b', '.env', 'nested/.git/config', 'NUL.txt', 'case./file', 'a?b', 'a|b', 'a\0b'])(
    'refuses nonportable or private resource name %j', (path) => { expect(marketPath(path)).toBe(false) })

  it.each([{ kind: 'bot' }, { plugins: [] }, { skills: [] }, { formatVersion: 2 }])('rejects non-Skill publication metadata %j', (change) => {
    expect(() => marketManifest({ ...manifest, ...change })).toThrow()
  })

  it.each([{ title: '' }, { version: '../latest' }])('refuses incomplete or nonversioned release metadata %j', (change) => {
    expect(() => marketManifest({ ...manifest, ...change })).toThrow('invalid-manifest')
  })

  it('rejects undeclared, altered, missing and case-colliding archive entries', () => {
    const entries = unzipSync(createMarketPackage(manifest, resources, limits))
    const content = { ...entries, 'skills/fixture-skill/assets/sample.bin': Buffer.from('changed') }
    expect(() => readMarketPackage(zipSync(content), limits)).toThrow('file-mismatch')
    expect(() => readMarketPackage(zipSync({ ...entries, EXTRA: Buffer.from('extra') }), limits)).toThrow('file-mismatch')
    expect(() => readMarketPackage(zipSync({ ...entries, 'skills/fixture-skill/skill.md': Buffer.from(instructions) }), limits)).toThrow('invalid-path')
    delete entries['muse-package.json']
    expect(() => readMarketPackage(zipSync(entries), limits)).toThrow('invalid-manifest')
  })

  it('enforces compressed, expanded, manifest and entry-count bounds', () => {
    const archive = createMarketPackage(manifest, resources, limits)
    expect(() => readMarketPackage(archive, { ...limits, archiveBytes: archive.byteLength - 1 })).toThrow('archive-too-large')
    expect(() => readMarketPackage(archive, { ...limits, expandedBytes: 4 })).toThrow('expanded-limit')
    expect(() => readMarketPackage(archive, { ...limits, recordBytes: 4 })).toThrow('invalid-manifest')
    expect(() => readMarketPackage(archive, { ...limits, fileCount: 1 })).toThrow('expanded-limit')
    expect(() => readMarketPackage(Buffer.from('not a ZIP'), limits)).toThrow('invalid-archive')
  })

  it.each(['modelInvocable: true', 'disableModelInvocation: true', 'userInvocable: true', 'user-invocable: perhaps'])(
    'retains current invocation refusals for %s', (field) => {
      expect(() => marketSkill(instructions.replace('disable-model-invocation: yes', field), 'fixture-skill')).toThrow('invalid-skill')
    })
})
