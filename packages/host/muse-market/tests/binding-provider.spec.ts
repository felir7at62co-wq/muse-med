import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry, { type SkillCandidate } from '@deepseek-ai/dsh-skill'
import { createScope } from '@deepseek-ai/dsh-scope'
import { join } from 'node:path'
import { rename } from 'node:fs/promises'
import { MuseMarketLocal } from '../src/local.ts'
import { createMarketPackage } from '../src/package.ts'
import { createMarketSkillProvider } from '../src/skills.ts'
import { directory, limits, manifest, resources } from './fixtures.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
async function fixture() {
  const value = await directory(); cleanups.push(value.cleanup)
  const storage = { root: join(value.root, 'market'), limits }, local = new MuseMarketLocal(storage)
  await local.ready()
  const installed = await local.install(createMarketPackage(manifest, resources, limits))
  await local.initializeActivation()
  await local.setDefault({ skillName: 'fixture-skill', expected: null, target: installed.release.id })
  return { ...value, local, storage, installed, entries: await local.captureDefaults() }
}

describe('Session-bound market provider', () => {
  it('loads exact retained instructions and current metadata from the selected archive', async () => {
    const value = await fixture(), provider = createMarketSkillProvider(value.local, value.storage, () => value.entries, 'bound-fixture')
    const observed = await provider.list({})
    const candidates = 'candidates' in observed ? observed.candidates : observed
    if (candidates[0] === undefined) throw new Error('Expected one complete candidate')
    expect(await provider.get(candidates[0], {})).toMatchObject({ source: 'muse-market', description: 'Review a scene.',
      whenToUse: 'For local scene review.', metadata: { audience: 'writers', tags: ['scene', '中文'] },
      invocation: { modelInvocable: false, userInvocable: true } })
  })

  it('loads an exact archive whose Skill has no optional routing text', async () => {
    const value = await fixture()
    const body = Buffer.from('---\nname: fixture-skill\ndescription: Review a scene.\n---\nKeep the original scene.\n')
    const installed = await value.local.install(createMarketPackage({ ...manifest, version: '2.0.0' },
      { 'skills/fixture-skill/SKILL.md': body }, limits))
    await value.local.setDefault({ skillName: 'fixture-skill', expected: value.installed.release.id, target: installed.release.id })
    const entries = await value.local.captureDefaults()
    const provider = createMarketSkillProvider(value.local, value.storage, async () => entries, 'minimal-fixture')
    const observed = await provider.list({ signal: new AbortController().signal })
    const candidates = 'candidates' in observed ? observed.candidates : observed
    const candidate = candidates[0]
    if (candidate === undefined) throw new Error('Expected one complete candidate')
    expect(await provider.get(candidate, { signal: new AbortController().signal })).toEqual({
      name: 'fixture-skill', description: 'Review a scene.', content: 'Keep the original scene.',
      invocation: { modelInvocable: true, userInvocable: true }, source: 'muse-market', provider: 'minimal-fixture',
      path: candidate.path, resourceBase: candidate.resourceBase,
    })
    expect(entries[0]?.skill).not.toHaveProperty('whenToUse')
  })

  it('refuses a candidate removed from the current release set instead of using its stale locator', async () => {
    const value = await fixture()
    let entries = value.entries
    const provider = createMarketSkillProvider(value.local, value.storage, () => entries, 'current-fixture')
    const observed = await provider.list({})
    const candidates = 'candidates' in observed ? observed.candidates : observed
    const candidate = candidates[0]
    if (candidate === undefined) throw new Error('Expected one complete candidate')
    entries = []
    await expect(provider.get(candidate, {})).rejects.toThrow('bound-release-unavailable')
    expect(await value.local.verify(value.installed.release)).toEqual(Buffer.from(createMarketPackage(manifest, resources, limits)))
  })

  it('honors cancellation before discovery and before reading a selected candidate', async () => {
    const value = await fixture(), controller = new AbortController(), reason = new Error('caller canceled Skill load')
    const provider = createMarketSkillProvider(value.local, value.storage, () => value.entries, 'cancel-fixture')
    const observed = await provider.list({})
    const candidates = 'candidates' in observed ? observed.candidates : observed
    const candidate: SkillCandidate | undefined = candidates[0]
    if (candidate === undefined) throw new Error('Expected one complete candidate')
    controller.abort(reason)
    await expect(provider.list({ signal: controller.signal })).rejects.toBe(reason)
    await expect(provider.get(candidate, { signal: controller.signal })).rejects.toBe(reason)
    expect(await provider.list({})).toEqual(candidates)
  })

  it('keeps a fixed candidate and refuses a missing cache instead of selecting a lower scoped version', async () => {
    const value = await fixture(), ctx = new Context()
    await ctx.plugin(SkillRegistry).await()
    cleanups.push(() => ctx.fiber.dispose())
    const skills = ctx.get('skills')
    if (skills === undefined) throw new Error('Missing actual registry')
    skills.register({ name: 'fixture-skill', description: 'Wrong fallback.', content: 'Must not load.', source: 'fallback' })
    const key = {}, scope = createScope(ctx, key)
    await scope.ctx.plugin({ inject: ['skills'], apply: (view) => {
      view.effect(() => view.skills.registerProvider(() => createMarketSkillProvider(value.local, value.storage,
        () => value.entries, 'pinned-fixture')))
    } }).await()
    try {
      expect((await skills.get('fixture-skill', { scope: key }))?.source).toBe('muse-market')
      await rename(join(value.storage.root, 'packages', value.installed.release.id), join(value.storage.root, 'lost-cache'))
      expect((await skills.list({ scope: key })).find(row => row.name === 'fixture-skill')?.source).toBe('muse-market')
      await expect(skills.get('fixture-skill', { scope: key })).rejects.toMatchObject({ code: 'ENOENT' })
    } finally { await scope.dispose() }
    expect((await skills.get('fixture-skill'))?.source).toBe('fallback')
  })

  it('refuses recorded candidate policy or routing facts that do not match the archive', async () => {
    const value = await fixture(), entry = value.entries[0]
    if (entry === undefined) throw new Error('Expected binding')
    const forged = { ...entry, skill: { ...entry.skill, invocation: { modelInvocable: true, userInvocable: false } } }
    const provider = createMarketSkillProvider(value.local, value.storage, () => [forged], 'inconsistent-fixture')
    const observed = await provider.list({})
    const candidates = 'candidates' in observed ? observed.candidates : observed
    if (candidates[0] === undefined) throw new Error('Expected one complete candidate')
    await expect(provider.get(candidates[0], {})).rejects.toThrow('bound-release-mismatch')
  })
})
