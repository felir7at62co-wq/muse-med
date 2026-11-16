/** Small original-format Skill archives shared by catalog and transport regressions. */
import { zipSync } from 'fflate'
import { marketDigest } from '../src/package.ts'
import { instructions } from './fixtures.ts'

export function originalSkillArchive(): Uint8Array {
  return zipSync({ 'fixture-skill/': new Uint8Array(), 'fixture-skill/SKILL.md': Buffer.from(instructions),
    'fixture-skill/assets/reference.bin': Uint8Array.of(0, 255, 31) })
}

export function originalCatalogEntry(archive: Uint8Array, name = 'fixture-skill') {
  return { id: `muse/skills/${name}`, kind: 'skill', slug: name, name: 'Original Skill',
    description: 'Review a scene with original resources.', category: 'writing', version: '0.1.0',
    requirements: ['Muse'], validation: 'Files verified; model use not evaluated.',
    sha256: marketDigest(archive), bytes: archive.byteLength, package: `downloads/skill-${name}-0.1.0.zip` }
}
