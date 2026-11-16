/** Original-source installation identity survives restarts without trusting names or modified archives. */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { zipSync } from 'fflate'
import { MarketLegacyInstallations } from '../src/legacy-installations.ts'
import { parseMarketLegacyCatalog } from '../src/legacy.ts'
import { createLegacySkillPackage } from '../src/legacy-skill.ts'
import { MuseMarketLocal } from '../src/local.ts'
import { directory, instructions, limits } from './fixtures.ts'
import { originalCatalogEntry } from './legacy-fixtures.ts'

function source(name = 'fixture-skill', body = 'Original reference') {
  const archive = zipSync({ [`${name}/SKILL.md`]: Buffer.from(instructions.replaceAll('fixture-skill', name)),
    [`${name}/references/rules.txt`]: Buffer.from(body) })
  const resource = parseMarketLegacyCatalog({ schemaVersion: 1, entries: [originalCatalogEntry(archive, name)] }, '', limits, 100)[0]!
  return { resource, archive }
}

async function fixture() {
  const owner = await directory()
  onTestFinished(owner.cleanup)
  const config = { root: owner.root, limits }, local = new MuseMarketLocal(config)
  await local.ready()
  const original = source()
  const installation = await local.install(createLegacySkillPackage(original.resource, original.archive, limits))
  return { ...owner, ...original, installation, config, local,
    file: join(owner.root, 'legacy-installations.json'), links: new MarketLegacyInstallations(config) }
}

it('restores a verified exact original identity after reopening and omits it after removal', async () => {
  const f = await fixture()
  expect(await f.links.resolve([f.resource])).toEqual([f.resource])
  await f.links.remember(f.resource, f.installation.release.id)
  const reopened = new MarketLegacyInstallations(f.config)
  expect(await reopened.resolve([f.resource])).toEqual([{ ...f.resource, installationId: f.installation.release.id }])
  await f.local.remove(f.installation.release.id)
  expect(await reopened.resolve([f.resource])).toEqual([f.resource])
})

it('does not match a changed source digest, different source id or unrelated archive', async () => {
  const f = await fixture()
  await f.links.remember(f.resource, f.installation.release.id)
  const changed = source('fixture-skill', 'Changed reference').resource
  const other = source('other-skill').resource
  await f.links.remember(other, f.installation.release.id)
  expect(await f.links.resolve([changed, other, { ...f.resource, version: '0.2.0' }]))
    .toEqual([changed, other, { ...f.resource, version: '0.2.0' }])
})

it.each(['publication.zip', 'skills/fixture-skill/references/rules.txt'])('omits an installation with modified %s', async (relative) => {
  const f = await fixture()
  await f.links.remember(f.resource, f.installation.release.id)
  await writeFile(join(f.root, 'packages', f.installation.release.id, relative), 'Modified content')
  expect(await f.links.resolve([f.resource])).toEqual([f.resource])
})

it('preserves independent completed imports under concurrent sidecar writers', async () => {
  const f = await fixture(), other = source('other-skill')
  const installed = await f.local.install(createLegacySkillPackage(other.resource, other.archive, limits))
  const secondWriter = new MarketLegacyInstallations(f.config)
  await Promise.all([f.links.remember(f.resource, f.installation.release.id), secondWriter.remember(other.resource, installed.release.id)])
  expect(await new MarketLegacyInstallations(f.config).resolve([f.resource, other.resource])).toEqual([
    { ...f.resource, installationId: f.installation.release.id }, { ...other.resource, installationId: installed.release.id },
  ])
  await f.links.remember(f.resource, f.installation.release.id)
  expect(await f.links.resolve([f.resource, other.resource])).toHaveLength(2)
})

it('keeps unexpected verification failures visible instead of reporting an uninstalled resource', async () => {
  const f = await fixture(), failure = Object.assign(new Error('Storage I/O failed'), { code: 'EIO' })
  await f.links.remember(f.resource, f.installation.release.id)
  const verify = vi.spyOn(MuseMarketLocal.prototype, 'verify').mockRejectedValue(failure)
  onTestFinished(() => { verify.mockRestore() })
  await expect(f.links.resolve([f.resource])).rejects.toBe(failure)
})

it('rejects malformed sidecar records and does not overwrite them when recording an import', async () => {
  const f = await fixture()
  const row = { id: f.resource.id, sha256: f.resource.sha256, installationId: f.installation.release.id }
  for (const value of [null, { version: 2, bindings: [] }, { version: 1, bindings: 'invalid' },
    { version: 1, bindings: [null] }, { version: 1, bindings: [{ ...row, id: 'muse/skills/../escape' }] },
    { version: 1, bindings: [{ ...row, sha256: 'invalid' }] },
    { version: 1, bindings: [{ ...row, installationId: 'invalid' }] },
    { version: 1, bindings: [row, row] }, { version: 1, bindings: [], extra: true }]) {
    const bytes = JSON.stringify(value)
    await writeFile(f.file, bytes)
    await expect(f.links.resolve([f.resource])).rejects.toThrow('invalid-legacy-installations')
    await expect(f.links.remember(f.resource, f.installation.release.id)).rejects.toThrow('invalid-legacy-installations')
    expect(await readFile(f.file, 'utf8')).toBe(bytes)
  }
  await writeFile(f.file, '{invalid-json')
  await expect(f.links.resolve([f.resource])).rejects.toThrow('invalid-legacy-installations')
})

it('rejects unsafe sidecar files and enforces the configured record size on writes', async () => {
  const f = await fixture()
  await mkdir(f.file)
  await expect(f.links.resolve([f.resource])).rejects.toThrow('invalid-storage')
  const other = await directory()
  onTestFinished(other.cleanup)
  const small = new MarketLegacyInstallations({ root: other.root, limits: { ...limits, recordBytes: 80 } })
  await expect(small.remember(f.resource, f.installation.release.id)).rejects.toThrow('record-too-large')
})
