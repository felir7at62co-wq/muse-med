import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SkillCandidate, SkillProvider } from '@deepseek-ai/dsh-skill'
import { MuseMarketLocal } from '../src/local.ts'
import { createMarketPackage, marketDigest } from '../src/package.ts'
import { createMarketSkillProvider } from '../src/skills.ts'
import type { MarketManifest, MarketRelease } from '../src/types.ts'

const roots: string[] = []
const limits = { archiveBytes: 1024 * 1024, expandedBytes: 1024 * 1024, fileCount: 32 }
afterEach(async () => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function localStore() {
  const root = await mkdtemp(join(tmpdir(), 'market-provider-')); roots.push(root)
  const local = new MuseMarketLocal({ root, limits, allowedPlugins: [] }); await local.ready()
  return local
}

async function install(local: MuseMarketLocal, name: string, policy = ''): Promise<MarketRelease> {
  const manifest: MarketManifest = { formatVersion: 1, kind: 'skill', name, title: name, description: `Use ${name}`,
    version: '1.0.0', license: 'MIT', category: 'script', examples: [], requirements: [],
    skills: [{ name, path: `skills/${name}/SKILL.md` }] }
  const archive = createMarketPackage(manifest, {
    [`skills/${name}/SKILL.md`]: Buffer.from(`---\nname: ${name}\ndescription: Use ${name}\n${policy}---\nInstructions for ${name}`),
  }, limits, [])
  const sha256 = marketDigest(archive)
  const release: MarketRelease = { id: sha256 as MarketRelease['id'], publisherId: '0000000000000000' as MarketRelease['publisherId'],
    publisher: 'Local', manifest, sha256, bytes: archive.byteLength, status: 'draft', reviewNote: '', revision: 1,
    createdAt: '2026-11-02T00:00:00.000Z' }
  await local.install(release, archive)
  return release
}

async function candidates(provider: SkillProvider): Promise<readonly SkillCandidate[]> {
  const result = await provider.list({})
  return 'candidates' in result ? result.candidates : result
}

it('keeps instruction bodies out of provider catalog candidates', async () => {
  const local = await localStore()
  const release = await install(local, 'review')
  const provider = createMarketSkillProvider(local, [release], 'market-test')
  const rows = await candidates(provider)
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({ name: 'review', description: 'Use review', provider: 'market-test',
    invocation: { modelInvocable: true, userInvocable: true } })
  expect(rows[0]).not.toHaveProperty('content')
  expect(JSON.stringify(rows)).not.toContain('Instructions for review')
  expect(await provider.get(rows[0]!, {})).toMatchObject({ name: 'review', content: 'Instructions for review' })
})

it('reverifies only the selected release when loading a catalog candidate', async () => {
  const local = await localStore()
  const alpha = await install(local, 'alpha'), beta = await install(local, 'beta'), gamma = await install(local, 'gamma')
  const provider = createMarketSkillProvider(local, [alpha, beta, gamma], 'market-test')
  const rows = await candidates(provider)
  await writeFile(join(local.directory(alpha), 'skills/alpha/SKILL.md'), 'modified unrelated Skill')
  const verify = vi.spyOn(local, 'verify')
  const target = rows.find(row => row.name === 'beta')!
  expect(await provider.get(target, {})).toMatchObject({ name: 'beta', content: 'Instructions for beta' })
  expect(verify).toHaveBeenCalledTimes(1)
  expect(verify).toHaveBeenCalledWith(beta)
  await expect(provider.list({})).rejects.toThrow('modified-installation')
})

it('does not read installed releases for an unknown candidate name', async () => {
  const local = await localStore()
  const release = await install(local, 'review')
  const provider = createMarketSkillProvider(local, [release], 'market-test')
  const [known] = await candidates(provider)
  const verify = vi.spyOn(local, 'verify')
  expect(await provider.get({ ...known!, name: 'missing', locator: 'missing' }, {})).toBeUndefined()
  expect(verify).not.toHaveBeenCalled()
})

it('rejects edited instructions when loading a previously listed candidate', async () => {
  const local = await localStore()
  const release = await install(local, 'review')
  const provider = createMarketSkillProvider(local, [release], 'market-test')
  const [candidate] = await candidates(provider)
  await writeFile(join(local.directory(release), 'skills/review/SKILL.md'), 'modified selected Skill')
  await expect(provider.get(candidate!, {})).rejects.toThrow('modified-installation')
})

it.each([
  ['manual', 'disable-model-invocation: true\n', false, true],
  ['automatic', 'user-invocable: false\n', true, false],
  ['disabled', 'disable-model-invocation: true\nuser-invocable: false\n', false, false],
] as const)('preserves independent invocation policies for %s Skills', async (name, policy, modelInvocable, userInvocable) => {
  const local = await localStore()
  const release = await install(local, name, policy)
  const provider = createMarketSkillProvider(local, [release], 'market-test')
  const [candidate] = await candidates(provider)
  expect(candidate?.invocation).toEqual({ modelInvocable, userInvocable })
  expect((await provider.get(candidate!, {}))?.invocation).toEqual({ modelInvocable, userInvocable })
})

it('rejects an aborted lookup before verifying releases', async () => {
  const local = await localStore()
  const release = await install(local, 'review')
  const provider = createMarketSkillProvider(local, [release], 'market-test')
  const [candidate] = await candidates(provider)
  const controller = new AbortController(), reason = new Error('lookup cancelled')
  controller.abort(reason)
  const verify = vi.spyOn(local, 'verify')
  await expect(provider.list({ signal: controller.signal })).rejects.toBe(reason)
  await expect(provider.get(candidate!, { signal: controller.signal })).rejects.toBe(reason)
  expect(verify).not.toHaveBeenCalled()
})
