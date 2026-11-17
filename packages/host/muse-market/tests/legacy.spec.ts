/** Original catalog parsing, archive admission and the reviewed Office helper relocation. */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { unzipSync, zipSync } from 'fflate'
import { isMarketLegacyDownloadPath, parseMarketLegacyCatalog, parseMarketLegacyResourceId } from '../src/legacy.ts'
import { createLegacySkillPackage } from '../src/legacy-skill.ts'
import { marketDigest, readMarketPackage } from '../src/package.ts'
import { instructions, limits } from './fixtures.ts'
import { originalCatalogEntry, originalSkillArchive } from './legacy-fixtures.ts'

function selected(archive: Uint8Array, name = 'fixture-skill') {
  const entry = parseMarketLegacyCatalog({ schemaVersion: 1, entries: [originalCatalogEntry(archive, name)] }, '', limits, 100)[0]
  if (entry === undefined) throw new Error('Missing original fixture resource')
  return entry
}

describe('original Skill catalog', () => {
  it('preserves stable identities and safe download paths while searching Skills only', () => {
    const archive = originalSkillArchive(), entry = originalCatalogEntry(archive)
    const catalog = { schemaVersion: 1, entries: [entry, { id: 'muse/bots/retired', kind: 'bot' }] }
    expect(parseMarketLegacyCatalog(catalog, 'Original scene', limits, 100)).toEqual([{
      id: entry.id, name: entry.slug, title: entry.name, description: entry.description, category: entry.category,
      version: entry.version, requirements: entry.requirements, requiredSkills: [], validation: entry.validation,
      sha256: entry.sha256, bytes: entry.bytes, downloadPath: '/market/' + entry.package,
    }])
    expect(parseMarketLegacyCatalog(catalog, 'unrelated', limits, 100)).toEqual([])
    expect(parseMarketLegacyCatalog({ ...catalog, entries: [{ ...entry, requiredSkills: ['media-import'] }] }, '', limits, 100)[0])
      .toMatchObject({ requiredSkills: ['media-import'] })
    expect(() => parseMarketLegacyCatalog(catalog, 'x'.repeat(201), limits, 100)).toThrow('invalid-query')
    expect(() => parseMarketLegacyCatalog(catalog, '', limits, 1)).toThrow('invalid-response')
  })

  it.each(['https://other.test/a.zip', '//other.test/a.zip', '/market/downloads/../a.zip', '/market/downloads/%2e%2e.zip',
    '/market/downloads/a.zip?download=1', '/market/downloads/a\\b.zip', '/market/downloads/a.tgz'])('refuses a nonlocal download path %s', (path) => {
    expect(isMarketLegacyDownloadPath(path)).toBe(false)
  })

  it('rejects malformed, duplicated and mismatched original catalog records', () => {
    const entry = originalCatalogEntry(originalSkillArchive())
    for (const catalog of [null, { schemaVersion: 2, entries: [entry] }, { schemaVersion: 1, entries: [null] },
      { schemaVersion: 1, entries: [entry, entry] },
      ...[{ slug: 'another' }, { kind: 'plugin' }, { package: 'downloads/%2e%2e.zip' }, { bytes: 0 },
        { bytes: limits.archiveBytes + 1 }, { sha256: 'not-a-digest' }, { requirements: ['x', 7] }, { validation: '' },
        { requiredSkills: ['valid', 7] }, { requiredSkills: Array.from({ length: 101 }, () => 'skill') }]
        .map(change => ({ schemaVersion: 1, entries: [{ ...entry, ...change }] }))]) {
      expect(() => parseMarketLegacyCatalog(catalog, '', limits, 100)).toThrow('invalid-response')
    }
    expect(parseMarketLegacyResourceId(entry.id)).toBe(entry.id)
    for (const id of ['a'.repeat(32), 'muse/bots/retired', 'muse/skills/../a', 7]) {
      expect(() => parseMarketLegacyResourceId(id)).toThrow('invalid-legacy-resource')
    }
  })
})

describe('original Skill conversion', () => {
  it('retains every resource byte and deterministically deduplicates the resulting publication', () => {
    const original = originalSkillArchive(), resource = selected(original)
    const archive = createLegacySkillPackage(resource, original, limits), decoded = readMarketPackage(archive, limits)
    expect(createLegacySkillPackage(resource, original, limits)).toEqual(archive)
    expect(decoded.manifest).toMatchObject({ name: 'fixture-skill', version: '0.1.0', license: 'NOASSERTION',
      title: resource.title, requirements: resource.requirements })
    expect(Object.keys(decoded.files)).toHaveLength(2)
    expect(Buffer.from(decoded.files['skills/fixture-skill/SKILL.md']!)).toEqual(Buffer.from(instructions))
    expect(decoded.files['skills/fixture-skill/assets/reference.bin']).toEqual(Uint8Array.of(0, 255, 31))
  })

  it.each(['fixture-skill/../escape', 'another/SKILL.md', 'fixture-skill/skill.md', 'fixture-skill/.env',
    'fixture-skill/secret.pem'])('rejects unsafe or case-colliding original paths: %s', (path) => {
    const archive = zipSync({ 'fixture-skill/SKILL.md': Buffer.from(instructions), [path]: Buffer.from('unexpected') })
    expect(() => createLegacySkillPackage(selected(archive), archive, limits)).toThrow('invalid-path')
  })

  it('refuses changed bytes, missing instructions, malformed ZIPs and archive limits', () => {
    const original = originalSkillArchive(), resource = selected(original)
    expect(() => createLegacySkillPackage({ ...resource, sha256: 'a'.repeat(64) }, original, limits)).toThrow('digest-mismatch')
    expect(() => createLegacySkillPackage({ ...resource, bytes: resource.bytes + 1 }, original, limits)).toThrow('digest-mismatch')
    expect(() => createLegacySkillPackage(resource, original, { ...limits, archiveBytes: 20 })).toThrow('archive-too-large')
    expect(() => createLegacySkillPackage(resource, original, { ...limits, fileCount: 1 })).toThrow('expanded-limit')
    expect(() => createLegacySkillPackage(resource, original, { ...limits, expandedBytes: 1 })).toThrow('expanded-limit')
    const missing = zipSync({ 'fixture-skill/readme.txt': Buffer.from('No instructions') })
    expect(() => createLegacySkillPackage(selected(missing), missing, limits)).toThrow('missing-skill')
    const malformed = Buffer.alloc(24, 65)
    expect(() => createLegacySkillPackage(selected(malformed), malformed, limits)).toThrow('invalid-archive')
  })

  it('checks actual expanded bytes when a stored ZIP understates its directory size', () => {
    const original = zipSync({ 'fixture-skill/SKILL.md': Buffer.from(instructions) }, { level: 0 })
    const headers = new DataView(original.buffer, original.byteOffset, original.byteLength)
    const directory = headers.getUint32(original.byteLength - 22 + 16, true)
    expect(headers.getUint32(directory, true)).toBe(0x02014b50)
    headers.setUint32(directory + 24, 0, true)
    expect(() => createLegacySkillPackage(selected(original), original, { ...limits, expandedBytes: 1 })).toThrow('expanded-limit')
  })

  it('relocates only the reviewed original Office helper and updates its reference', () => {
    const original = readFileSync(new URL('./fixtures/legacy-office-docx-0.1.0.zip', import.meta.url))
    expect(marketDigest(original)).toBe('13b258381a0a889a81451ee28cc0df7f0e90eebca6dd6b35a9151fa619137dc9')
    const entries = unzipSync(original), helper = entries['scripts/check_office.py']!
    const archive = createLegacySkillPackage(selected(original, 'office-docx'), original, limits)
    const decoded = readMarketPackage(archive, limits)
    expect(Buffer.from(decoded.files['skills/office-docx/scripts/check_office.py']!)).toEqual(Buffer.from(helper))
    const before = new TextDecoder().decode(entries['office-docx/SKILL.md'])
    expect(new TextDecoder().decode(decoded.files['skills/office-docx/SKILL.md']))
      .toBe(before.replaceAll('<skill-directory>/../scripts/check_office.py', '<skill-directory>/scripts/check_office.py'))
    for (const [path, bytes] of Object.entries(entries)) {
      if (path === 'office-docx/SKILL.md' || path === 'scripts/check_office.py') continue
      expect(Buffer.from(decoded.files[`skills/${path}`]!)).toEqual(Buffer.from(bytes))
    }
    const changed = zipSync({ ...entries, 'scripts/check_office.py': Buffer.from('different helper') })
    expect(() => createLegacySkillPackage(selected(changed, 'office-docx'), changed, limits)).toThrow('digest-mismatch')
    const duplicate = zipSync({ ...entries, 'office-docx/scripts/check_office.py': helper })
    expect(() => createLegacySkillPackage(selected(duplicate, 'office-docx'), duplicate, limits)).toThrow('invalid-path')
    const noReference = zipSync({ ...entries, 'office-docx/SKILL.md': Buffer.from('No helper reference') })
    expect(() => createLegacySkillPackage(selected(noReference, 'office-docx'), noReference, limits)).toThrow('invalid-skill')
    const invalidText = zipSync({ ...entries, 'office-docx/SKILL.md': Uint8Array.of(255) })
    expect(() => createLegacySkillPackage(selected(invalidText, 'office-docx'), invalidText, limits)).toThrow('invalid-skill')
  })
})
