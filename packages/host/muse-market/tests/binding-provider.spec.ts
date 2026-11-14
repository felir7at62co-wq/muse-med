import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import { createScope } from '@deepseek-ai/dsh-scope'
import { join } from 'node:path'
import { rename } from 'node:fs/promises'
import { MuseMarketLocal } from '../src/local.ts'
import { createMarketPackage } from '../src/package.ts'
import { createMarketSkillProvider } from '../src/skills.ts'
import { marketBindingProjectionDefinition } from '../src/session.ts'
import { directory, limits, manifest, resources, instructions } from './fixtures.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
async function fixture(withUsageHint = true) {
  const value = await directory(); cleanups.push(value.cleanup)
  const storage = { root: join(value.root, 'market'), limits }, local = new MuseMarketLocal(storage)
  await local.ready()
  const files = withUsageHint ? resources : { ...resources,
    'skills/fixture-skill/SKILL.md': Buffer.from(instructions.replace('whenToUse: For local scene review.\n', '')) }
  const installed = await local.install(createMarketPackage(manifest, files, limits))
  await local.initializeActivation()
  await local.setDefault({ skillName: 'fixture-skill', expected: null, target: installed.release.id })
  return { ...value, local, storage, installed, entries: await local.captureDefaults() }
}

describe('Session-bound market provider', () => {
  it('retains a selected Skill without an optional usage hint through persisted binding and body loading', async () => {
    const value = await fixture(false)
    const restored = marketBindingProjectionDefinition.stateSchema.parse({ bound: true, requested: false, releases: value.entries })
    expect(restored.releases[0]?.skill).not.toHaveProperty('whenToUse')
    const provider = createMarketSkillProvider(value.local, value.storage, () => restored.releases, 'without-usage-hint')
    const observed = await provider.list({})
    const candidates = 'candidates' in observed ? observed.candidates : observed
    const candidate = candidates[0]
    if (!candidate) throw Error('Expected the selected Skill without a usage hint')
    expect((await provider.get(candidate, {}))?.whenToUse).toBeUndefined()
  })

  it('loads exact retained instructions and current metadata from the selected archive', async () => {
    const value = await fixture(), provider = createMarketSkillProvider(value.local, value.storage, () => value.entries, 'bound-fixture')
    const observed = await provider.list({})
    const candidates = 'candidates' in observed ? observed.candidates : observed
    if (candidates[0] === undefined) throw new Error('Expected one complete candidate')
    expect(await provider.get(candidates[0], {})).toMatchObject({ source: 'muse-market', description: 'Review a scene.',
      whenToUse: 'For local scene review.', metadata: { audience: 'writers', tags: ['scene', '中文'] },
      invocation: { modelInvocable: false, userInvocable: true } })
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

  it('refuses a stale candidate when its exact release or Skill name is no longer selected', async () => {
    const value = await fixture()
    let selected = value.entries
    const provider = createMarketSkillProvider(value.local, value.storage, () => selected, 'changing-selection')
    const observed = await provider.list({})
    const candidates = 'candidates' in observed ? observed.candidates : observed
    const candidate = candidates[0]
    if (!candidate) throw Error('Expected one retained candidate')
    await expect(provider.get({ ...candidate, name: 'another-skill' }, {})).rejects.toThrow('bound-release-unavailable')
    selected = []
    await expect(provider.get(candidate, {})).rejects.toThrow('bound-release-unavailable')
  })
})
