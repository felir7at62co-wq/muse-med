import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import MuseMarket from '../src/index.ts'
import { readMarketPackage } from '../src/package.ts'
import { bundle, limits, metadata, resources } from './fixtures.ts'

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
  return { ...value, market, skills, marketFiber, unregister }
}

describe('local publication service', () => {
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
    expect(await value.skills.list()).toHaveLength(1)
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
})
