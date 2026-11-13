import { describe, expect, it } from 'vitest'
import { unzipSync, zipSync } from 'fflate'
import { createMarketPackage, readMarketPackage, marketDigest, marketRelease } from '../src/package.ts'
import { marketManifest, marketPath, marketSkill } from '../src/format.ts'
import { limits, manifest, resources, instructions } from './fixtures.ts'

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
