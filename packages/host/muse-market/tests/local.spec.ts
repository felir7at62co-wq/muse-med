import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, readFile, readdir, rename, symlink, unlink, writeFile } from 'node:fs/promises'
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
  it('refuses a pre-existing linked storage root before writing any ledger or cache', async () => {
    const value = await fixture(), retained = join(value.root, 'retained-market'), linked = join(value.root, 'linked-market')
    await mkdir(retained)
    await symlink(retained, linked, process.platform === 'win32' ? 'junction' : 'dir')
    try {
      await expect(new MuseMarketLocal({ root: linked, limits }).ready()).rejects.toThrow('invalid-storage')
      expect(await readdir(retained)).toEqual([])
      expect(await value.local.list()).toEqual([])
    } finally { await unlink(linked) }
  })

  it('refuses a regular file occupying the selected installation directory without deleting it', async () => {
    const value = await fixture(), release = marketRelease(value.archive, limits)
    const destination = join(value.market, 'packages', release.id)
    await writeFile(destination, 'retained unrelated regular file')
    await expect(value.local.install(value.archive)).rejects.toThrow('modified-installation')
    expect(await readFile(destination, 'utf8')).toBe('retained unrelated regular file')
    expect(await value.local.list()).toEqual([])
  })

  it('rejects durable release metadata that disagrees with its complete cached archive', async () => {
    const value = await fixture(), installed = await value.local.install(value.archive)
    await writeFile(join(value.market, 'installations.json'), JSON.stringify({ version: 1, installations: [{
      ...installed, release: { ...installed.release, manifest: { ...manifest, version: '2.0.0' } },
    }] }))
    const [selected] = await value.local.list()
    if (selected === undefined) throw new Error('Missing retained release metadata')
    await expect(value.local.verify(selected.release)).rejects.toThrow('modified-installation')
    expect(await readFile(join(value.market, 'packages', installed.release.id, 'publication.zip'))).toEqual(Buffer.from(value.archive))
  })

  it('removes a failed extraction and admits a later valid import after resource paths collide', async () => {
    const value = await fixture()
    const conflicting = createMarketPackage(manifest, { ...resources,
      'skills/fixture-skill/conflict': Buffer.from('a regular resource'),
      'skills/fixture-skill/conflict/child.txt': Buffer.from('a child requiring a directory'),
    }, limits)
    await expect(value.local.install(conflicting)).rejects.toHaveProperty('code', expect.stringMatching(/^(EEXIST|ENOTDIR)$/u))
    expect(await value.local.list()).toEqual([])
    expect((await readdir(value.market)).filter(name => name.startsWith('.pending-'))).toEqual([])
    expect(await readdir(join(value.market, 'packages'))).toEqual([])
    const installed = await value.local.install(value.archive)
    expect(await value.local.verify(installed.release)).toEqual(Buffer.from(value.archive))
    expect(await value.local.list()).toEqual([installed])
  })

  it('refuses relative storage and a directory where a ledger document is required', async () => {
    expect(() => new MuseMarketLocal({ root: 'relative-market', limits })).toThrow('invalid-storage')
    const value = await fixture()
    await mkdir(join(value.market, 'installations.json'))
    await expect(value.local.list()).rejects.toThrow('invalid-storage')
  })

  it.each([
    { id: 'not-a-release' }, { sha256: '0'.repeat(64) }, { bytes: 0 }, { bytes: 1.5 },
    { bytes: '512' }, { bytes: limits.archiveBytes + 1 },
  ])('refuses malformed durable release identities without rewriting the ledger %#', async (change) => {
    const value = await fixture(), file = join(value.market, 'installations.json')
    const bytes = JSON.stringify({ version: 1, installations: [{ enabled: false,
      release: { ...marketRelease(value.archive, limits), ...change } }] })
    await writeFile(file, bytes)
    await expect(value.local.list()).rejects.toThrow('invalid-ledger')
    expect(await readFile(file, 'utf8')).toBe(bytes)
  })

  it('refuses duplicate durable release records instead of silently deduplicating them', async () => {
    const value = await fixture(), file = join(value.market, 'installations.json')
    const entry = { enabled: false, release: marketRelease(value.archive, limits) }
    const bytes = JSON.stringify({ version: 1, installations: [entry, entry] })
    await writeFile(file, bytes)
    await expect(value.local.list()).rejects.toThrow('invalid-ledger')
    expect(await readFile(file, 'utf8')).toBe(bytes)
  })

  it.each([{ activationRevision: -1 }, { activationRevision: 0.5 }, { activationRevision: '0' }, { defaults: [] }])(
    'refuses malformed durable activation metadata before returning an installation list %#', async (change) => {
      const value = await fixture(), file = join(value.market, 'installations.json')
      const bytes = JSON.stringify({ version: 2, activationRevision: 0, installations: [], defaults: {}, ...change })
      await writeFile(file, bytes)
      await expect(value.local.list()).rejects.toThrow('invalid-ledger')
      expect(await readFile(file, 'utf8')).toBe(bytes)
    },
  )

  it.each(['invalid skill name', 'another-skill', 'fixture-skill'])('refuses a durable default without its exact installed Skill (%s)', async (name) => {
    const value = await fixture(), file = join(value.market, 'installations.json')
    const release = marketRelease(value.archive, limits)
    const bytes = JSON.stringify({ version: 2, activationRevision: 1,
      installations: [{ enabled: false, release }], defaults: { [name]: name === 'fixture-skill' ? '0'.repeat(64) : release.id } })
    await writeFile(file, bytes)
    await expect(value.local.list()).rejects.toThrow('invalid-ledger')
    expect(await readFile(file, 'utf8')).toBe(bytes)
  })

  it('requires explicit activation initialization and rejects an invalid selection without committing it', async () => {
    const value = await fixture()
    await expect(value.local.defaults()).rejects.toThrow('activation-not-initialized')
    await value.local.initializeActivation()
    const before = await readFile(join(value.market, 'installations.json'))
    await expect(value.local.setDefault({ skillName: 'invalid skill name', expected: null, target: null }))
      .rejects.toThrow('invalid-selection')
    expect(await readFile(join(value.market, 'installations.json'))).toEqual(before)
    expect(await value.local.defaults()).toEqual({ revision: 0, defaults: [] })
  })

  it('refuses removal of a valid release identity that was never installed', async () => {
    const value = await fixture(), release = marketRelease(value.archive, limits)
    await expect(value.local.remove(release.id)).rejects.toThrow('not-installed')
    expect(await value.local.list()).toEqual([])
  })

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

  it.each(['file', 'directory'] as const)('refuses an extra extracted %s, preserving the immutable archive', async (kind) => {
    const value = await fixture(), installed = await value.local.install(value.archive)
    const destination = join(value.market, 'packages', installed.release.id)
    if (kind === 'file') await writeFile(join(destination, 'extra.txt'), 'unowned')
    else await mkdir(join(destination, 'unowned-directory'))
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
