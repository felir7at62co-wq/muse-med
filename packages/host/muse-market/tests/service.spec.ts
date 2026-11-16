import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import MuseMarket from '../src/index.ts'
import { createMarketPackage, marketRelease, readMarketPackage } from '../src/package.ts'
import { MuseMarketLocal } from '../src/local.ts'
import { bundle, limits, manifest, metadata, resources } from './fixtures.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
async function fixture() {
  const value = await bundle(); cleanups.push(value.cleanup)
  const ctx = new Context()
  await ctx.plugin(SkillRegistry)
  const skills = ctx.get('skills')
  if (!skills) throw new Error('Skill registry did not load')
  const unregister = skills.register(value.skill)
  const marketFiber = ctx.plugin(MuseMarket, { root: join(value.root, 'market'), ...limits })
  await marketFiber
  const market = ctx.get('museMarket')
  if (!market) throw new Error('Local market service did not load')
  cleanups.push(async () => { await marketFiber.dispose(); unregister(); await ctx.fiber.dispose() })
  return { ...value, ctx, market, skills, marketFiber, unregister }
}

describe('local publication service', () => {
  it('refuses relative storage before creating a service', async () => {
    const ctx = new Context()
    try { expect(() => new MuseMarket(ctx, { ...limits, root: 'relative-market' })).toThrow('invalid-storage') }
    finally { await ctx.fiber.dispose() }
  })

  it('keeps committed inventory usable when an observer throws and permits recovery from a failed removal hook', async () => {
    const value = await fixture()
    let observed = 0
    const stopObserver = value.ctx.on('muse-market/inventory-changed', () => { observed++; throw new Error('observer failed') })
    const prepared = await value.market.prepare(metadata, value.skill.name)
    expect(observed).toBe(1)
    expect(await value.market.installed()).toEqual([prepared])
    stopObserver()
    const stopHook = value.ctx.on('muse-market/before-remove', async () => { throw new Error('hook failed') })
    await expect(value.market.removePackage(prepared.release.id)).rejects.toMatchObject({ details: { code: 'storage-unavailable' } })
    expect(await value.market.installed()).toEqual([prepared])
    stopHook()
    await value.market.removePackage(prepared.release.id)
    expect(await value.market.installed()).toEqual([])
  })

  it('omits an absent source usage hint and rejects noncanonical base64 without changing inventory', async () => {
    const value = await fixture(), noHint = { ...value.skill }
    value.unregister(); delete noHint.whenToUse
    const stop = value.skills.register(noHint)
    try {
      expect(await value.market.sources()).toEqual({ complete: true, skills: [{ name: noHint.name, description: noHint.description }] })
      await expect(value.market.importPackage('Zh==')).rejects.toMatchObject({ details: { code: 'invalid-archive' } })
      expect(await value.market.installed()).toEqual([])
    } finally { stop() }
  })

  it('prepares, deduplicates, exports and removes through the actual service while the registry stays unchanged', async () => {
    const value = await fixture(), before = await value.skills.list()
    expect(await value.market.sources()).toEqual({
      skills: [{ name: value.skill.name, description: value.skill.description, whenToUse: value.skill.whenToUse }], complete: true,
    })
    const prepared = await value.market.prepare(metadata, value.skill.name)
    expect(prepared.enabled).toBe(false)
    const exported = await value.market.exportPackage(prepared.release.id)
    expect(exported.name).toBe('fixture-release-1.0.0.zip')
    const bytes = Buffer.from(exported.base64, 'base64')
    const decoded = readMarketPackage(bytes, limits)
    for (const [path, expected] of Object.entries(resources)) expect(Buffer.from(decoded.files[path]!)).toEqual(Buffer.from(expected))
    expect(await value.market.importPackage(exported.base64)).toEqual(prepared)
    expect(await value.market.installed()).toEqual([prepared])
    await value.market.removePackage(prepared.release.id)
    expect(await value.market.installed()).toEqual([])
    expect(await value.skills.list()).toEqual(before)
  })

  it('returns bounded error codes for malformed archives, missing sources and changed resources', async () => {
    const value = await fixture()
    await expect(value.market.importPackage('not base64!')).rejects.toMatchObject({ code: 'muse-market/operation-failed', details: { code: 'invalid-archive' } })
    await expect(value.market.prepare(metadata, 'absent')).rejects.toMatchObject({ details: { code: 'missing-skill' } })
    const installed = await value.market.prepare(metadata, value.skill.name)
    await writeFile(join(value.root, 'market', 'packages', installed.release.id, 'skills/fixture-skill/assets/sample.bin'), 'altered')
    await expect(value.market.exportPackage(installed.release.id)).rejects.toMatchObject({ details: { code: 'modified-installation' } })
  })

  it('rejects new operations after service disposal without leaving a registry contribution', async () => {
    const value = await fixture()
    await value.marketFiber.dispose()
    await expect(value.market.installed()).rejects.toMatchObject({ details: { code: 'closing' } })
    await expect(value.market.prepareUpload(marketRelease(createMarketPackage(manifest, resources, limits), limits).id, 'episode-planner'))
      .rejects.toMatchObject({ details: { code: 'closing' } })
    expect(await value.skills.list()).toHaveLength(1)
  })

  it('retains explicit author portrait metadata while preparing the complete resource bundle', async () => {
    const value = await fixture()
    const prepared = await value.market.prepare({ ...metadata, presetPortrait: 'episode-planner' }, value.skill.name)
    expect(prepared.release.manifest.presetPortrait).toBe('episode-planner')
    const decoded = readMarketPackage(Buffer.from((await value.market.exportPackage(prepared.release.id)).base64, 'base64'), limits)
    expect(decoded.manifest).toEqual(prepared.release.manifest)
    for (const [path, bytes] of Object.entries(resources)) expect(Buffer.from(decoded.files[path]!)).toEqual(Buffer.from(bytes))
  })

  it('prepares an installed disabled version without requiring the source in the global Skill registry', async () => {
    const value = await fixture(), original = await value.market.prepare(metadata, value.skill.name)
    const originalExport = await value.market.exportPackage(original.release.id)
    const local = new MuseMarketLocal(value.market.publicationStorage())
    await local.initializeActivation()
    await local.setDefault({ skillName: value.skill.name, expected: null, target: original.release.id })
    const defaults = await local.defaults()
    value.unregister()
    const source = { name: value.skill.name, description: metadata.description,
      sourceId: `market:${original.release.id}`, version: metadata.version }
    expect(await value.market.sources()).toEqual({ complete: true, skills: [source] })
    const author = { ...metadata, name: 'authored-release', version: '2.0.0', presetPortrait: 'episode-planner' }
    const prepared = await value.market.prepare(author, source.sourceId)
    expect(prepared.enabled).toBe(false)
    expect(prepared.release.manifest).toEqual({ ...author, formatVersion: 1, kind: 'skill', skills: original.release.manifest.skills })
    const decoded = readMarketPackage(Buffer.from((await value.market.exportPackage(prepared.release.id)).base64, 'base64'), limits)
    for (const [path, bytes] of Object.entries(resources)) expect(Buffer.from(decoded.files[path]!)).toEqual(Buffer.from(bytes))
    expect(await value.market.exportPackage(original.release.id)).toEqual(originalExport)
    expect(await value.market.prepare(author, source.sourceId)).toEqual(prepared)
    expect(await value.market.installed()).toEqual([original, prepared])
    expect(await local.defaults()).toEqual(defaults)
    expect(await value.skills.list()).toEqual([])
  })

  it('lists separate retained source selectors for different versions with the same invocation name', async () => {
    const value = await fixture()
    const first = await value.market.prepare(metadata, value.skill.name)
    const second = await value.market.prepare({ ...metadata, version: '2.0.0' }, value.skill.name)
    const sources = await value.market.sources()
    expect(sources.skills).toEqual([
      { name: value.skill.name, description: value.skill.description, whenToUse: value.skill.whenToUse },
      { name: value.skill.name, description: metadata.description, sourceId: `market:${first.release.id}`, version: '1.0.0' },
      { name: value.skill.name, description: metadata.description, sourceId: `market:${second.release.id}`, version: '2.0.0' },
    ])
  })

  it('refuses malformed, missing and modified retained preparation sources without replacing their records', async () => {
    const value = await fixture(), original = await value.market.prepare(metadata, value.skill.name)
    for (const source of ['market:../outside', 'market:' + 'A'.repeat(64), 'market:' + 'a'.repeat(63)]) {
      await expect(value.market.prepare(metadata, source)).rejects.toMatchObject({ details: { code: 'invalid-selection' } })
    }
    const missing = marketRelease(createMarketPackage({ ...manifest, version: '9.0.0' }, resources, limits), limits).id
    await expect(value.market.prepare(metadata, `market:${missing}`)).rejects.toMatchObject({ details: { code: 'not-installed' } })
    await writeFile(join(value.root, 'market', 'packages', original.release.id, 'skills/fixture-skill/assets/sample.bin'), 'altered')
    await expect(value.market.prepare({ ...metadata, version: '2.0.0' }, `market:${original.release.id}`))
      .rejects.toMatchObject({ details: { code: 'modified-installation' } })
    expect(await value.market.installed()).toEqual([original])
  })

  it('binds a portrait in a separate deterministic package and preserves the original and activation defaults', async () => {
    const value = await fixture(), original = await value.market.prepare(metadata, value.skill.name)
    const originalExport = await value.market.exportPackage(original.release.id)
    const local = new MuseMarketLocal(value.market.publicationStorage())
    await local.initializeActivation()
    await local.setDefault({ skillName: value.skill.name, expected: null, target: original.release.id })
    const defaults = await local.defaults()
    const [prepared, duplicate] = await Promise.all([
      value.market.prepareUpload(original.release.id, 'episode-planner'),
      value.market.prepareUpload(original.release.id, 'episode-planner'),
    ])
    expect(duplicate).toEqual(prepared)
    expect(prepared.release.id).not.toBe(original.release.id)
    expect(prepared.release.manifest).toEqual({ ...original.release.manifest, presetPortrait: 'episode-planner' })
    expect(prepared.enabled).toBe(false)
    const decoded = readMarketPackage(Buffer.from((await value.market.exportPackage(prepared.release.id)).base64, 'base64'), limits)
    for (const [path, bytes] of Object.entries(resources)) expect(Buffer.from(decoded.files[path]!)).toEqual(Buffer.from(bytes))
    expect(await value.market.exportPackage(original.release.id)).toEqual(originalExport)
    expect(await value.market.installed()).toEqual([original, prepared])
    expect(await local.defaults()).toEqual(defaults)
    expect(await value.market.prepareUpload(prepared.release.id, 'storyboard-reviewer')).toEqual(prepared)
    expect(await value.market.installed()).toEqual([original, prepared])
  })

  it.each(['', '../portrait', 'https://example.com/image.png', 'Uppercase', 'a'.repeat(65)])(
    'refuses unsafe portrait metadata %j before creating another release', async (presetPortrait) => {
      const value = await fixture(), original = await value.market.prepare(metadata, value.skill.name)
      await expect(value.market.prepare({ ...metadata, presetPortrait }, value.skill.name))
        .rejects.toMatchObject({ details: { code: 'invalid-manifest' } })
      await expect(value.market.prepareUpload(original.release.id, presetPortrait))
        .rejects.toMatchObject({ details: { code: 'invalid-manifest' } })
      expect(await value.market.installed()).toEqual([original])
    })

  it('refuses missing and modified upload sources even when the original has a bound portrait', async () => {
    const value = await fixture()
    const missing = marketRelease(createMarketPackage({ ...manifest, version: '9.0.0' }, resources, limits), limits).id
    await expect(value.market.prepareUpload(missing, 'episode-planner')).rejects.toMatchObject({ details: { code: 'not-installed' } })
    const original = await value.market.prepare({ ...metadata, presetPortrait: 'episode-planner' }, value.skill.name)
    await writeFile(join(value.root, 'market', 'packages', original.release.id, 'skills/fixture-skill/assets/sample.bin'), 'altered')
    await expect(value.market.prepareUpload(original.release.id, 'storyboard-reviewer'))
      .rejects.toMatchObject({ details: { code: 'modified-installation' } })
    expect(await value.market.installed()).toEqual([original])
  })

  it('retains discovery completeness for both partial and empty source observations', async () => {
    const value = await fixture()
    const undo = value.skills.registerProvider(() => ({ name: 'incomplete-fixture',
      list: async () => ({ candidates: [], complete: false }), get: async () => undefined }))
    try {
      expect(await value.market.sources()).toMatchObject({ complete: false, skills: [{ name: value.skill.name }] })
      value.unregister()
      expect(await value.market.sources()).toEqual({ complete: false, skills: [] })
    } finally { undo() }
    expect(await value.market.sources()).toEqual({ complete: true, skills: [] })
  })

  it('commits inventory changes even when an observer fails, and continues serving later operations', async () => {
    const value = await fixture(), warn = vi.spyOn(value.ctx.logger, 'warn').mockImplementation(() => {})
    const off = value.ctx.on('muse-market/inventory-changed', () => { throw new Error('Observer failed') })
    try {
      const installed = await value.market.prepare(metadata, value.skill.name)
      expect(await value.market.installed()).toEqual([installed])
      expect(warn).toHaveBeenCalled()
      await value.market.removePackage(installed.release.id)
      expect(await value.market.installed()).toEqual([])
      await expect(value.market.exportPackage(installed.release.id)).rejects.toMatchObject({ details: { code: 'not-installed' } })
    } finally { off(); warn.mockRestore() }
  })

  it('reports provider failures as unavailable storage and admits the next authoring request', async () => {
    const value = await fixture()
    const off = value.skills.registerProvider(() => ({ name: 'failing-author-source',
      list: async () => [{ name: 'unavailable-skill', description: 'Unavailable instructions.', source: 'fixture',
        provider: 'failing-author-source', rank: 0, locator: 'unavailable', invocation: { modelInvocable: true, userInvocable: true } }],
      get: async () => { throw new Error('Provider could not read the instructions') } }))
    try {
      await expect(value.market.prepare(metadata, 'unavailable-skill')).rejects.toMatchObject({ details: { code: 'storage-unavailable' } })
      expect(await value.market.installed()).toEqual([])
    } finally { off() }
    expect(await value.market.prepare(metadata, value.skill.name)).toHaveProperty('enabled', false)
  })

  it('rejects noncanonical archive encodings without changing the inventory', async () => {
    const value = await fixture()
    await expect(value.market.importPackage('A')).rejects.toMatchObject({ details: { code: 'invalid-archive' } })
    await expect(value.market.importPackage('A'.repeat(Math.ceil(limits.archiveBytes / 3) * 4 + 1)))
      .rejects.toMatchObject({ details: { code: 'invalid-archive' } })
    expect(await value.market.installed()).toEqual([])
  })

  it('lists a source without optional routing without synthesizing that field', async () => {
    const value = await fixture()
    const off = value.skills.register({ name: 'virtual-review', description: 'Review a short scene.', content: 'Review it.', source: 'fixture' })
    try {
      expect((await value.market.sources()).skills.find(skill => skill.name === 'virtual-review'))
        .toEqual({ name: 'virtual-review', description: 'Review a short scene.' })
    } finally { off() }
  })

  it('refuses a relative storage root before creating the publication service', async () => {
    const ctx = new Context(); cleanups.push(() => ctx.fiber.dispose())
    await ctx.plugin(SkillRegistry).await()
    await expect(ctx.plugin(MuseMarket, { root: 'relative-market', ...limits }).await()).rejects.toMatchObject({ code: 'invalid-storage' })
    expect(ctx.get('museMarket')).toBeUndefined()
  })
})
