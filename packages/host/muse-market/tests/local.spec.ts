import { afterEach, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises'
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

async function setupLocal() {
  const root = await mkdtemp(join(tmpdir(), 'muse-market-local-')); roots.push(root)
  const config = { root, limits, allowedPlugins: [] }
  const local = new MuseMarketLocal(config)
  await local.ready()
  return { local, config, root, ledger: join(root, 'installations.json') }
}

it('rejects a relative storage path and links at the root or packages directory', async () => {
  const { root, config } = await setupLocal()
  expect(() => new MuseMarketLocal({ ...config, root: 'relative-root' })).toThrow('Market root must be absolute')
  const actual = join(root, 'actual')
  await mkdir(actual)
  const link = join(root, 'linked-root')
  await symlink(actual, link, 'junction')
  try {
    await expect(new MuseMarketLocal({ ...config, root: link }).ready()).rejects.toThrow('invalid-storage')
  } finally { await unlink(link) }
  const packages = join(root, 'packages')
  await rename(packages, join(root, 'empty-packages'))
  await symlink(actual, packages, 'junction')
  try { await expect(new MuseMarketLocal(config).ready()).rejects.toThrow('invalid-storage') }
  finally { await unlink(packages) }
  expect(await readdir(actual)).toEqual([])
})

it('refuses malformed or conflicting durable records and retains valid converted package metadata', async () => {
  const { local, ledger } = await setupLocal()
  const { release, archive } = skillPublication('review', 'review')
  const installation = { release, enabled: false }
  const source = { id: 'muse/skills/review', sha256: release.id }
  const valid = { version: 1, installations: [installation], references: { session: [release.id] } }
  const badLegacy = [{}, { ...source, id: 'review' }, { ...source, id: 'muse/bots/review' },
    { ...source, sha256: 0 }, { ...source, sha256: 'short' }, { ...source, sha256: 'f'.repeat(64) }]
  const invalid = [null, 42, [], { ...valid, version: 2 }, { ...valid, installations: {} },
    { ...valid, references: null }, { ...valid, references: 42 }, { ...valid, references: [] },
    ...[null, 42, [], {}, ...badLegacy.map(legacySource => ({ ...installation, legacySource }))]
      .map(item => ({ ...valid, installations: [item] })),
    { ...valid, installations: [installation, installation] },
    ...[null, 'not-an-array', [42], ['missing']].map(session => ({ ...valid, references: { session } })),
  ]
  await writeFile(ledger, '{')
  await expect(local.list()).rejects.toBeInstanceOf(SyntaxError)
  for (const value of invalid) {
    await writeFile(ledger, JSON.stringify(value))
    await expect(local.list()).rejects.toThrow('invalid-ledger')
  }
  await writeFile(ledger, JSON.stringify({ version: 1, installations: [], references: {} }))
  const installed = await local.install(release, archive, source)
  expect(installed.legacySource).toEqual(source)
  expect(await local.list()).toEqual([installed])
  await expect(local.install(release, archive, { ...source, id: 'muse/skills/other' })).rejects.toMatchObject({
    code: 'release-conflict', status: 409,
  })
  expect(await local.install(release, archive, source)).toEqual(installed)
})

it('rejects manifest mismatches and junctions in the verified cache', async () => {
  const { local, root } = await setupLocal()
  const { release, archive } = skillPublication('review', 'review')
  const incorrect = { ...release, manifest: { ...release.manifest, title: 'Different title' } }
  await expect(local.install(incorrect, archive)).rejects.toThrow('manifest-mismatch')
  await expect(local.install({ ...release, bytes: release.bytes + 1 }, archive)).rejects.toThrow('digest-mismatch')
  await local.install(release, archive)
  await expect(local.verify(incorrect)).rejects.toThrow('modified-installation')
  await expect(local.verify({ ...release, bytes: release.bytes + 1 })).rejects.toThrow('modified-installation')

  const packageRoot = local.directory(release)
  const movedRoot = join(root, 'moved-package')
  await rename(packageRoot, movedRoot)
  await symlink(movedRoot, packageRoot, 'junction')
  try { await expect(local.verify(release)).rejects.toThrow('modified-installation') }
  finally { await unlink(packageRoot); await rename(movedRoot, packageRoot) }

  const skillRoot = join(packageRoot, 'skills', 'review')
  const movedSkill = join(root, 'moved-skill')
  await rename(skillRoot, movedSkill)
  await symlink(movedSkill, skillRoot, 'junction')
  try { await expect(local.verify(release)).rejects.toThrow('modified-installation') }
  finally { await unlink(skillRoot); await rename(movedSkill, skillRoot) }
  await writeFile(join(skillRoot, 'SKILL.md'), 'changed instructions')
  await expect(local.verify(release)).rejects.toThrow('modified-installation')
})

it('removes an incomplete staging directory when conflicting archive paths cannot be extracted', async () => {
  const { local, root } = await setupLocal()
  const original = publication('1.0.0').release
  const archive = createMarketPackage(original.manifest, { resource: Buffer.from('file'),
    'resource/child.txt': Buffer.from('nested file') }, limits, [])
  const release = { ...original, sha256: marketDigest(archive), bytes: archive.byteLength }
  await expect(local.install(release, archive)).rejects.toSatisfy((error: NodeJS.ErrnoException) => /EEXIST|ENOTDIR/.test(error.code ?? ''))
  expect(await local.list()).toEqual([])
  expect(await readdir(join(root, 'packages'))).toEqual([])
  expect((await readdir(root)).some(name => name.startsWith('.pending-'))).toBe(false)
})

it('keeps the ledger clean when the package cache parent is no longer a directory', async () => {
  const { local, root } = await setupLocal()
  const packages = join(root, 'packages')
  await rename(packages, join(root, 'moved-packages'))
  await writeFile(packages, 'not a directory')
  const entries = (await readdir(root)).sort()
  // Windows can report EINVAL when a directory rename traverses a file.
  const errorCodes = process.platform === 'win32' ? ['ENOTDIR', 'ENOENT', 'EINVAL'] : ['ENOTDIR', 'ENOENT']
  const { release, archive } = publication('1.0.0')
  await expect(local.install(release, archive)).rejects.toSatisfy((error: NodeJS.ErrnoException) => errorCodes.includes(error.code ?? ''))
  expect(await local.list()).toEqual([])
  expect(await readFile(packages, 'utf8')).toBe('not a directory')
  expect((await readdir(root)).sort()).toEqual(entries)
})

it('protects enabled or referenced installations and rejects operations on missing releases', async () => {
  const { local } = await setupLocal()
  const { release, archive } = publication('1.0.0')
  await expect(local.enable(release.id, true)).rejects.toMatchObject({ code: 'not-installed', status: 404 })
  await expect(local.reference('new-session', [release.id])).rejects.toMatchObject({ code: 'not-installed', status: 404 })
  await expect(local.remove(release.id)).rejects.toMatchObject({ code: 'not-installed', status: 404 })
  await local.install(release, archive)
  await local.enable(release.id, true)
  await expect(local.remove(release.id)).rejects.toMatchObject({ code: 'disable-first', status: 409 })
  await local.enable(release.id, false)
  await local.reference('existing-session', [release.id])
  await expect(local.remove(release.id)).rejects.toMatchObject({ code: 'release-in-use', status: 409 })
  await expect(local.binding('existing-session')).resolves.toEqual([release])
})

it('replaces a complete session binding without retaining superseded provisional versions', async () => {
  const { local, config } = await setupLocal()
  const first = skillPublication('review', 'review', '1.0.0')
  const second = skillPublication('review', 'review', '2.0.0')
  await local.install(first.release, first.archive)
  await local.install(second.release, second.archive)
  await local.reference('blank-session', [first.release.id])
  await local.reference('blank-session', [second.release.id, second.release.id])
  expect(await local.binding('blank-session')).toEqual([second.release])
  const recovered = new MuseMarketLocal(config)
  await recovered.ready()
  expect(await recovered.binding('blank-session')).toEqual([second.release])
  await recovered.remove(first.release.id)
  await expect(recovered.remove(second.release.id)).rejects.toThrow('release-in-use')
})
