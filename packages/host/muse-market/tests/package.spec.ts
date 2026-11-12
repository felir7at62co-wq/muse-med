import { describe, expect, it } from 'vitest'
import { unzipSync, zipSync } from 'fflate'
import { createMarketPackage, readMarketPackage, marketDigest, marketRelease } from '../src/package.ts'
import { marketManifest, marketPath, marketSkill } from '../src/format.ts'
import { limits, manifest, resources, instructions } from './fixtures.ts'

function fileRows(files: Readonly<Record<string, Uint8Array>>) {
  return Object.entries(files).map(([path, bytes]) => ({ path, bytes: bytes.byteLength, sha256: marketDigest(bytes) }))
}

function archiveEntries(files: Readonly<Record<string, Uint8Array>> = resources, fields: Record<string, unknown> = {}) {
  return { ...files, 'muse-package.json': Buffer.from(JSON.stringify({ ...manifest, files: fileRows(files), ...fields })) }
}

function expectFileBytes(actual: Readonly<Record<string, Uint8Array>>, expected: Readonly<Record<string, Uint8Array>>): void {
  expect(Object.keys(actual).sort()).toEqual(Object.keys(expected).sort())
  for (const [path, bytes] of Object.entries(expected)) {
    const observed = actual[path]
    if (observed === undefined) throw new Error(`Missing archive file: ${path}`)
    expect(Buffer.from(observed)).toEqual(Buffer.from(bytes))
  }
}

describe('Skill publications', () => {
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

  it.each([null, { name: 1, path: 'skills/fixture-skill/SKILL.md' },
    { name: 'invalid/name', path: 'skills/invalid/name/SKILL.md' },
    { name: 'fixture-skill', path: 'skills/another-skill/SKILL.md' }])('rejects an invalid Skill manifest entry %#', (skill) => {
    expect(() => marketManifest({ ...manifest, skills: [skill] })).toThrow('invalid-manifest')
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

  it('admits portable directory entries without treating them as declared files', () => {
    const archive = zipSync({ ...archiveEntries(), 'skills/': new Uint8Array(), 'skills/fixture-skill/': new Uint8Array() })
    const parsed = readMarketPackage(archive, limits)
    expect(parsed.manifest).toEqual(manifest)
    expectFileBytes(parsed.files, resources)
    expect(() => readMarketPackage(new Uint8Array(), limits)).toThrow('archive-too-large')
  })

  it.each([Buffer.from('{'), Uint8Array.from([0xff, 0xfe])])('refuses invalid JSON or UTF-8 in the archive manifest %#', (bytes) => {
    expect(() => readMarketPackage(zipSync({ ...resources, 'muse-package.json': bytes }), limits)).toThrow('invalid-manifest')
  })

  it.each([undefined, null, {}])('requires a complete manifest file table %#', (files) => {
    expect(() => readMarketPackage(zipSync(archiveEntries(resources, { files })), limits)).toThrow('file-mismatch')
  })

  it('refuses malformed, duplicate and undeclared file table identities', () => {
    const rows = fileRows(resources)
    for (const files of [
      [null, rows[1], rows[2]],
      [{ path: 1 }, rows[1], rows[2]],
      [rows[0], rows[0], rows[2]],
      [{ ...rows[0], path: 'skills/fixture-skill/missing.txt' }, rows[1], rows[2]],
    ]) expect(() => readMarketPackage(zipSync(archiveEntries(resources, { files })), limits)).toThrow('file-mismatch')
  })

  it('refuses complete file tables that omit instructions or include another Skill resource', () => {
    const missing = { 'skills/fixture-skill/reference.txt': Buffer.from('Retained reference.') }
    expect(() => readMarketPackage(zipSync(archiveEntries(missing)), limits)).toThrow('missing-skill')
    expect(() => readMarketPackage(zipSync(archiveEntries({ ...resources, 'other-skill/resource.txt': Buffer.from('Unselected.') })), limits))
      .toThrow('undeclared-skill')
  })

  it('refuses invalid instruction bytes even when the declared digest and byte count match', () => {
    for (const body of [Buffer.from('Missing frontmatter.'), Uint8Array.from([0xff, 0xfe])]) {
      const files = { ...resources, 'skills/fixture-skill/SKILL.md': body }
      expect(() => readMarketPackage(zipSync(archiveEntries(files)), limits)).toThrow('invalid-skill')
    }
  })

  it('checks actual stored bytes when ZIP directory metadata understates expanded size', () => {
    const entries = archiveEntries(), archive = Buffer.from(zipSync(entries, { level: 0 }))
    const end = archive.length - 22
    expect(archive.readUInt32LE(end)).toBe(0x06054b50)
    let offset = archive.readUInt32LE(end + 16)
    const count = archive.readUInt16LE(end + 10)
    for (let index = 0; index < count; index++) {
      expect(archive.readUInt32LE(offset)).toBe(0x02014b50)
      // Stored entries retain their real data length while the central-directory claim is false.
      archive.writeUInt32LE(0, offset + 24)
      offset += 46 + archive.readUInt16LE(offset + 28) + archive.readUInt16LE(offset + 30) + archive.readUInt16LE(offset + 32)
    }
    const actualBytes = Object.values(entries).reduce((sum, bytes) => sum + bytes.byteLength, 0)
    expectFileBytes(unzipSync(archive), entries)
    expect(() => readMarketPackage(archive, { ...limits, expandedBytes: actualBytes - 1 })).toThrow('expanded-limit')
    const parsed = readMarketPackage(archive, { ...limits, expandedBytes: actualBytes })
    expect(parsed.manifest).toEqual(manifest)
    expectFileBytes(parsed.files, resources)
  })

  it.each(['modelInvocable: true', 'disableModelInvocation: true', 'userInvocable: true', 'user-invocable: perhaps'])(
    'retains current invocation refusals for %s', (field) => {
      expect(() => marketSkill(instructions.replace('disable-model-invocation: yes', field), 'fixture-skill')).toThrow('invalid-skill')
    })
})
