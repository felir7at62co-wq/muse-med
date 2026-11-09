import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, readFile, rename, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { MuseMarketLocal, readMarketBytes } from '../src/local.ts'
import { createMarketPackage, marketRelease } from '../src/package.ts'
import { directory, limits, manifest, resources } from './fixtures.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { await Promise.all(cleanups.splice(0).map(cleanup => cleanup())) })
async function fixture() {
  const value = await directory(); cleanups.push(value.cleanup)
  const local = new MuseMarketLocal({ root: join(value.root, 'market'), limits })
  await local.ready()
  const archive = createMarketPackage(manifest, resources, limits)
  return { ...value, local, archive, market: join(value.root, 'market') }
}

describe('local publication transactions', () => {
  it('deduplicates concurrent imports, survives restart, exports exact bytes and removes only the record', async () => {
    const value = await fixture()
    const other = new MuseMarketLocal({ root: value.market, limits })
    const [first, duplicate] = await Promise.all([value.local.install(value.archive), other.install(value.archive)])
    expect(first).toEqual(duplicate)
    expect(first.enabled).toBe(false)
    expect(await other.list()).toEqual([first])
    expect(await other.verify(first.release)).toEqual(Buffer.from(value.archive))
    await other.remove(first.release.id)
    expect(await value.local.list()).toEqual([])
    expect(await readFile(join(value.market, 'packages', first.release.id, 'publication.zip'))).toEqual(Buffer.from(value.archive))
    expect(await value.local.install(value.archive)).toEqual(first)
  })

  it('refuses placeholder and corrupted cache trees without committing an installation', async () => {
    const value = await fixture(), release = marketRelease(value.archive, limits)
    const destination = join(value.market, 'packages', release.id)
    await mkdir(destination)
    await expect(value.local.install(value.archive)).rejects.toThrow()
    expect(await value.local.list()).toEqual([])
    await rename(destination, destination + '.placeholder')
    const installed = await value.local.install(value.archive)
    await writeFile(join(destination, 'skills/fixture-skill/assets/sample.bin'), 'changed')
    await expect(value.local.verify(installed.release)).rejects.toThrow('modified-installation')
    await expect(value.local.install(value.archive)).rejects.toThrow('modified-installation')
  })

  it('refuses missing and extra extracted files, preserving the immutable archive', async () => {
    const value = await fixture(), installed = await value.local.install(value.archive)
    const destination = join(value.market, 'packages', installed.release.id)
    await writeFile(join(destination, 'extra.txt'), 'unowned')
    await expect(value.local.verify(installed.release)).rejects.toThrow('modified-installation')
    expect(await readFile(join(destination, 'publication.zip'))).toEqual(Buffer.from(value.archive))
  })

  it('commits only the ledger after complete installation and refuses an oversized ledger update', async () => {
    const value = await fixture(), constrained = new MuseMarketLocal({ root: value.market, limits: { ...limits, recordBytes: 1024 } })
    const first = await constrained.install(value.archive)
    const second = createMarketPackage({ ...manifest, version: '1.0.1' }, resources, limits)
    await expect(constrained.install(second)).rejects.toThrow('record-too-large')
    expect(await value.local.list()).toEqual([first])
    expect(await value.local.install(second)).toHaveProperty('enabled', false)
  })

  it('rejects corrupt, active and linked ledger records rather than treating them as fresh', async () => {
    const value = await fixture(), file = join(value.market, 'installations.json')
    await writeFile(file, '{')
    await expect(value.local.list()).rejects.toThrow('invalid-ledger')
    await writeFile(file, JSON.stringify({ version: 1, installations: [{ enabled: true, release: marketRelease(value.archive, limits) }] }))
    await expect(value.local.list()).rejects.toThrow('invalid-ledger')
    if (process.platform !== 'win32') {
      await rename(file, file + '.real')
      await symlink(file + '.real', file)
      await expect(value.local.list()).rejects.toThrow('invalid-storage')
    }
  })

  it('bounds regular-file reads and refuses directories and file links', async () => {
    const value = await fixture(), file = join(value.root, 'resource')
    await writeFile(file, '12345')
    await expect(readMarketBytes(file, 4)).rejects.toThrow('invalid-storage')
    expect(await readMarketBytes(file, 5)).toEqual(Buffer.from('12345'))
    await expect(readMarketBytes(value.root, 8)).rejects.toThrow('invalid-storage')
    if (process.platform !== 'win32') {
      const link = join(value.root, 'link'); await symlink(file, link)
      await expect(readMarketBytes(link, 8)).rejects.toThrow('invalid-storage')
    }
  })
})
