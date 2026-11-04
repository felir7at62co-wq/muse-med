import { afterEach, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MuseMarketLocal } from '../src/local.ts'
import { createMarketPackage, marketDigest } from '../src/package.ts'
import type { MarketManifest, MarketRelease } from '../src/types.ts'
const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
const limits = { archiveBytes: 1024 * 1024, expandedBytes: 2 * 1024 * 1024, fileCount: 32 }
function publication(version: string, kind: 'bot' | 'skill' = 'bot') {
  const manifest: MarketManifest = { formatVersion: 1, kind, name: 'script-review', title: 'Script review', description: 'Review scripts',
    version, license: 'MIT', category: 'script', examples: [], requirements: [], skills: [], ...(kind === 'bot' ? { plugins: [] } : {}) }
  const archive = createMarketPackage(manifest, {}, limits, [])
  const sha256 = marketDigest(archive)
  const release: MarketRelease = { id: sha256 as MarketRelease['id'], publisherId: '0000000000000000' as MarketRelease['publisherId'],
    publisher: 'Local', manifest, sha256, bytes: archive.byteLength, status: 'draft', reviewNote: '', revision: 1, createdAt: '2026-11-02T00:00:00.000Z' }
  return { release, archive }
}
function skillPublication(packageName: string, skillName: string, version = '1.0.0') {
  const manifest: MarketManifest = { formatVersion: 1, kind: 'skill', name: packageName, title: packageName,
    description: 'Review scripts', version, license: 'MIT', category: 'script', examples: [], requirements: [],
    skills: [{ name: skillName, path: `skills/${skillName}/SKILL.md` }] }
  const archive = createMarketPackage(manifest, { [`skills/${skillName}/SKILL.md`]: Buffer.from(
    `---\nname: ${skillName}\ndescription: Review scripts\n---\nReview the supplied script.\n`,
  ) }, limits, [])
  const sha256 = marketDigest(archive)
  const release: MarketRelease = { id: sha256 as MarketRelease['id'], publisherId: '0000000000000000' as MarketRelease['publisherId'],
    publisher: 'Local', manifest, sha256, bytes: archive.byteLength, status: 'draft', reviewNote: '', revision: 1,
    createdAt: '2026-11-02T00:00:00.000Z' }
  return { release, archive }
}

it('keeps multiple downloaded Bot versions disabled until explicitly enabled and restores references', async () => {
  const root = await mkdtemp(join(tmpdir(), 'muse-market-local-')); roots.push(root)
  const config = { root, limits, allowedPlugins: [] }
  const local = new MuseMarketLocal(config); await local.ready()
  const v1 = publication('1.0.0'), v2 = publication('2.0.0')
  expect((await local.install(v1.release, v1.archive)).enabled).toBe(false)
  await local.enable(v1.release.id, true)
  await local.reference('existing-session', [v1.release.id])
  await local.install(v2.release, v2.archive)
  const recovered = new MuseMarketLocal(config); await recovered.ready()
  expect((await recovered.list()).map(item => [item.release.manifest.version, item.enabled])).toEqual([['1.0.0', true], ['2.0.0', false]])
  await expect(recovered.enable(v1.release.id, false)).rejects.toThrow('release-in-use')
  await expect(recovered.remove(v1.release.id)).rejects.toThrow('release-in-use')
  await recovered.remove(v2.release.id)
  expect(Buffer.from(await recovered.verify(v1.release))).toEqual(Buffer.from(v1.archive))
})

it('rejects mismatched download bytes and modified cached archives', async () => {
  const root = await mkdtemp(join(tmpdir(), 'muse-market-corruption-')); roots.push(root)
  const local = new MuseMarketLocal({ root, limits, allowedPlugins: [] }); await local.ready()
  const v1 = publication('1.0.0'), v2 = publication('2.0.0')
  await expect(local.install(v1.release, v2.archive)).rejects.toThrow('digest-mismatch')
  await local.install(v1.release, v1.archive)
  await writeFile(join(local.directory(v1.release), 'publication.zip'), 'changed')
  await expect(local.enable(v1.release.id, true)).rejects.toThrow('modified-installation')
  expect((await local.list())[0]?.enabled).toBe(false)
})

it('preserves a referenced local draft when matching cloud bytes arrive under a new release identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'muse-market-identities-')); roots.push(root)
  const local = new MuseMarketLocal({ root, limits, allowedPlugins: [] }); await local.ready()
  const draft = publication('1.0.0')
  const cloud: MarketRelease = { ...draft.release, id: '11111111111111111111111111111111' as MarketRelease['id'],
    publisherId: '2222222222222222' as MarketRelease['publisherId'], publisher: 'Publisher', status: 'published' }
  await local.install(draft.release, draft.archive)
  await local.enable(draft.release.id, true)
  await local.reference('existing-session', [draft.release.id])
  await local.install(cloud, draft.archive)
  expect(new Set((await local.list()).map(item => item.release.id))).toEqual(new Set([draft.release.id, cloud.id]))
  await expect(local.remove(draft.release.id)).rejects.toThrow('release-in-use')
  await local.remove(cloud.id)
})

it('detects standalone Skill conflicts by callable name instead of package name', async () => {
  const conflictRoot = await mkdtemp(join(tmpdir(), 'muse-market-skill-conflict-')); roots.push(conflictRoot)
  const conflict = new MuseMarketLocal({ root: conflictRoot, limits, allowedPlugins: [] }); await conflict.ready()
  const first = skillPublication('review-basic', 'review'), second = skillPublication('review-pro', 'review')
  await conflict.install(first.release, first.archive); await conflict.install(second.release, second.archive)
  await conflict.enable(first.release.id, true)
  await expect(conflict.enable(second.release.id, true)).rejects.toThrow('skill-name-conflict')

  const distinctRoot = await mkdtemp(join(tmpdir(), 'muse-market-skill-distinct-')); roots.push(distinctRoot)
  const distinct = new MuseMarketLocal({ root: distinctRoot, limits, allowedPlugins: [] }); await distinct.ready()
  const alpha = skillPublication('review-suite', 'review-alpha'), beta = skillPublication('review-suite', 'review-beta')
  await distinct.install(alpha.release, alpha.archive); await distinct.install(beta.release, beta.archive)
  await distinct.enable(alpha.release.id, true)
  await expect(distinct.enable(beta.release.id, true)).resolves.toMatchObject({ enabled: true })
})
