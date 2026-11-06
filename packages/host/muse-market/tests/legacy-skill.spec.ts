import { readFileSync } from 'node:fs'
import { zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { createLegacySkillPackage } from '../src/legacy-skill.ts'
import { marketDigest, readMarketPackage } from '../src/package.ts'
import type { MarketLegacyResource } from '../src/types.ts'
import { underreportedStoredZip } from './fixtures/stored-zip.ts'

const limits = { archiveBytes: 1024 * 1024, expandedBytes: 2 * 1024 * 1024, fileCount: 32 }
const instructions = Buffer.from('---\r\nname: review\r\ndescription: Review scripts\r\n---\r\nReview the supplied script.\r\n')
const helperPath = 'scripts/check_office.py'
const officeHelper = readFileSync(new URL('../../../skill/skill-office/assets/scripts/check_office.py', import.meta.url))

function resource(name: string, archive: Uint8Array): MarketLegacyResource {
  return { id: `muse/skills/${name}`, kind: 'skill', title: 'Original Skill', description: 'Reviews work',
    category: 'writing', version: '0.1.0', requirements: ['Muse'], requiredSkills: [], validation: 'Files checked',
    sha256: marketDigest(archive), href: `https://example.test/market/downloads/${name}.zip`,
  }
}

describe('original Skill ZIP conversion', () => {
  it('retains original instruction and binary resource bytes with the original name and version', () => {
    const resourceBytes = Uint8Array.of(0, 16, 255)
    const archive = zipSync({ 'review/': new Uint8Array(), 'review/SKILL.md': instructions,
      'review/assets/reference.bin': resourceBytes,
    })
    const result = readMarketPackage(createLegacySkillPackage(resource('review', archive), archive, limits, []), limits, [])
    expect(result.manifest).toMatchObject({ kind: 'skill', name: 'review', title: 'Original Skill', version: '0.1.0',
      license: 'NOASSERTION', requirements: ['Muse'], skills: [{ name: 'review', path: 'skills/review/SKILL.md' }],
    })
    expect(Buffer.from(result.files['skills/review/SKILL.md'] ?? [])).toEqual(instructions)
    expect(result.files['skills/review/assets/reference.bin']).toEqual(resourceBytes)
  })

  it.each(['review/../escape', 'other/notes.md', 'review/skill.md', 'review/keys/secret.pem'])('rejects out-of-scope or colliding path %s', (path) => {
    const archive = zipSync({ 'review/SKILL.md': instructions, [path]: Buffer.from('unexpected') })
    expect(() => createLegacySkillPackage(resource('review', archive), archive, limits, [])).toThrow('invalid-path')
  })

  it('checks the selected archive identity and rejects unsafe archive sizes before publishing', () => {
    const archive = zipSync({ 'review/SKILL.md': instructions })
    const selected = resource('review', archive)
    expect(() => createLegacySkillPackage({ ...selected, sha256: 'a'.repeat(64) }, archive, limits, [])).toThrow('digest-mismatch')
    expect(() => createLegacySkillPackage({ ...selected, kind: 'bot' }, archive, limits, [])).toThrow('invalid-release')
    expect(() => createLegacySkillPackage(selected, archive, { ...limits, archiveBytes: 20 }, [])).toThrow('archive-too-large')
    expect(() => createLegacySkillPackage(selected, archive, { ...limits, expandedBytes: 20 }, [])).toThrow('expanded-limit')
  })

  it('refuses missing instructions, malformed ZIPs and dishonest expanded sizes', () => {
    const malformed = Buffer.alloc(24, 65)
    expect(() => createLegacySkillPackage(resource('review', malformed), malformed, limits, [])).toThrow('invalid-archive')
    const noInstructions = zipSync({ 'review/note.md': Buffer.from('Only a reference') })
    expect(() => createLegacySkillPackage(resource('review', noInstructions), noInstructions, limits, [])).toThrow('missing-skill')
    const underreported = underreportedStoredZip({ 'review/SKILL.md': instructions })
    expect(() => createLegacySkillPackage(resource('review', underreported), underreported, { ...limits, expandedBytes: 1 }, []))
      .toThrow('expanded-limit')
  })

  it.each(['office-docx', 'office-pptx', 'office-xlsx'])('relocates the exact reviewed Office helper for %s', (name) => {
    const original = `---\nname: ${name}\ndescription: Office fixture\n---\nUse <skill-directory>/../${helperPath} with the workspace Python.\n`
    const archive = zipSync({ [`${name}/SKILL.md`]: Buffer.from(original), [helperPath]: officeHelper })
    const result = readMarketPackage(createLegacySkillPackage(resource(name, archive), archive, limits, []), limits, [])
    expect(Buffer.from(result.files[`skills/${name}/${helperPath}`] ?? [])).toEqual(officeHelper)
    expect(Buffer.from(result.files[`skills/${name}/SKILL.md`] ?? []).toString())
      .toBe(original.replace(`/../${helperPath}`, `/${helperPath}`))
  })

  it('rejects unreviewed or duplicate Office helper bytes', () => {
    const body = Buffer.from(`---\nname: office-docx\ndescription: Office fixture\n---\nUse <skill-directory>/../${helperPath}.\n`)
    const changed = zipSync({ 'office-docx/SKILL.md': body, [helperPath]: Buffer.from('different helper') })
    expect(() => createLegacySkillPackage(resource('office-docx', changed), changed, limits, [])).toThrow('digest-mismatch')
    const duplicate = zipSync({ 'office-docx/SKILL.md': body, [helperPath]: officeHelper, [`office-docx/${helperPath}`]: officeHelper })
    expect(() => createLegacySkillPackage(resource('office-docx', duplicate), duplicate, limits, [])).toThrow('invalid-path')
    for (const instructions of [Buffer.from('The helper is not referenced'), Buffer.concat([body, Buffer.from([255])])]) {
      const invalid = zipSync({ 'office-docx/SKILL.md': instructions, [helperPath]: officeHelper })
      expect(() => createLegacySkillPackage(resource('office-docx', invalid), invalid, limits, [])).toThrow('invalid-skill')
    }
  })
})
