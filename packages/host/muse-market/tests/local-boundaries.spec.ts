/** Durable ledger validation and file-system failure atomicity. */
import { expect, it, onTestFinished, vi } from 'vitest'
import * as files from 'node:fs/promises'
import { join } from 'node:path'
import { MuseMarketLocal, readMarketBytes } from '../src/local.ts'
import { createMarketPackage, marketRelease } from '../src/package.ts'
import { directory, instructions, limits, manifest, resources } from './fixtures.ts'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))

async function fixture() {
  const owner = await directory(); onTestFinished(owner.cleanup)
  const root = join(owner.root, 'market'), local = new MuseMarketLocal({ root, limits })
  await local.ready()
  const archive = createMarketPackage(manifest, resources, limits), release = marketRelease(archive, limits)
  return { ...owner, root, local, archive, release, ledger: join(root, 'installations.json') }
}

it.each([
  null, { version: 1, installations: {} }, { version: 1, installations: [null] },
  { version: 1, installations: [{ enabled: false, release: {} }] },
  { version: 2, installations: [], activationRevision: -1, defaults: {} },
  { version: 2, installations: [], activationRevision: 0, defaults: { 'fixture-skill': 'f'.repeat(64) } },
])('refuses malformed durable ledger %j', async (value) => {
  const f = await fixture(); await files.writeFile(f.ledger, JSON.stringify(value))
  await expect(f.local.list()).rejects.toThrow('invalid-ledger')
})

it('refuses duplicate installations and invalid release facts without rewriting them', async () => {
  const f = await fixture(), item = { enabled: false, release: f.release }
  for (const installations of [[item, item], [{ ...item, release: { ...f.release, bytes: 0 } }]]) {
    const before = JSON.stringify({ version: 1, installations }); await files.writeFile(f.ledger, before)
    await expect(f.local.list()).rejects.toThrow('invalid-ledger')
    expect(await files.readFile(f.ledger, 'utf8')).toBe(before)
  }
})

it('requires explicit activation migration and a valid invocation name', async () => {
  const f = await fixture()
  await expect(f.local.defaults()).rejects.toThrow('activation-not-initialized')
  await expect(f.local.setDefault({ skillName: '../bad', expected: null, target: null })).rejects.toThrow('invalid-selection')
  await expect(f.local.remove(f.release.id)).rejects.toThrow('not-installed')
  await f.local.initializeActivation()
  expect(await f.local.captureDefaults()).toEqual([])
})

it('captures a Skill with no optional when-to-use field', async () => {
  const f = await fixture()
  const item = await f.local.install(createMarketPackage(manifest, { ...resources,
    'skills/fixture-skill/SKILL.md': Buffer.from(instructions.replace('whenToUse: For local scene review.\n', '')) }, limits))
  await f.local.initializeActivation()
  await f.local.setDefault({ skillName: 'fixture-skill', expected: null, target: item.release.id })
  expect((await f.local.captureDefaults())[0]?.skill).not.toHaveProperty('whenToUse')
})

it('rejects a relative storage root and linked directory roots', async () => {
  const f = await fixture()
  expect(() => new MuseMarketLocal({ root: 'relative', limits })).toThrow('invalid-storage')
  const linked = join(f.root, 'linked')
  await files.symlink(f.root, linked, 'junction')
  onTestFinished(() => files.unlink(linked))
  await expect(new MuseMarketLocal({ root: linked, limits }).ready()).rejects.toThrow('invalid-storage')
})

it.each(['directory', 'metadata', 'extra-directory', 'missing-file', 'linked-root'] as const)('refuses altered installation %s', async (mode) => {
  const f = await fixture(), item = await f.local.install(f.archive), cached = join(f.root, 'packages', item.release.id)
  if (mode === 'directory') {
    await files.rename(cached, cached + '.held'); await files.writeFile(cached, 'not a directory')
  } else if (mode === 'extra-directory') await files.mkdir(join(cached, 'unowned'))
  else if (mode === 'missing-file') await files.unlink(join(cached, 'skills/fixture-skill/assets/sample.bin'))
  else if (mode === 'linked-root') {
    await files.rename(cached, cached + '.held'); await files.symlink(cached + '.held', cached, 'junction')
    onTestFinished(() => files.unlink(cached))
  }
  const release = mode === 'metadata' ? { ...item.release, bytes: item.release.bytes + 1 } : item.release
  await expect(f.local.verify(release)).rejects.toThrow()
})

it.each(['before-open', 'after-read'] as const)('refuses a byte-identical file replacement %s', async (phase) => {
  const f = await fixture(), file = join(f.root, 'resource'), held = file + '.held'
  await files.writeFile(file, '12345')
  const lstat = files.lstat; let count = 0
  const inspect = vi.spyOn(files, 'lstat').mockImplementation(async (...args) => {
    const info = await lstat(...args)
    if (args[0] === file && ++count === (phase === 'before-open' ? 1 : 2)) {
      await files.rename(file, held); await files.writeFile(file, '12345')
      if (phase === 'after-read') return lstat(...args)
    }
    return info
  })
  try { await expect(readMarketBytes(file, 5)).rejects.toThrow(phase === 'before-open' ? 'invalid-storage' : 'changed-resource') }
  finally { inspect.mockRestore() }
  expect(await files.readFile(held, 'utf8')).toBe('12345')
})

it('refuses file growth beyond the read budget and closes the owned descriptor', async () => {
  const f = await fixture(), file = join(f.root, 'resource'); await files.writeFile(file, '12345')
  const open = files.open; let closed = false
  const inspect = vi.spyOn(files, 'open').mockImplementation(async (...args) => {
    const handle = await open(...args)
    if (args[0] === file) {
      const stat = handle.stat.bind(handle), close = handle.close.bind(handle)
      Object.defineProperty(handle, 'stat', { value: async (...statArgs: Parameters<typeof handle.stat>) => {
        const result = await stat(...statArgs); await files.appendFile(file, '6'); return result
      } })
      Object.defineProperty(handle, 'close', { value: async () => { await close(); closed = true } })
    }
    return handle
  })
  try { await expect(readMarketBytes(file, 5)).rejects.toThrow('invalid-storage') }
  finally { inspect.mockRestore() }
  expect(closed).toBe(true)
})

it('uses the platform-specific regular-file flags while preserving exact bytes', async () => {
  const f = await fixture(), file = join(f.root, 'resource'); await files.writeFile(file, '12345')
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')
  if (descriptor === undefined) throw Error('Missing platform descriptor')
  try {
    Object.defineProperty(process, 'platform', { ...descriptor, value: process.platform === 'win32' ? 'linux' : 'win32' })
    expect(await readMarketBytes(file, 5)).toEqual(Buffer.from('12345'))
  } finally { Object.defineProperty(process, 'platform', descriptor) }
})

it('rechecks extracted bytes changed after directory traversal', async () => {
  const f = await fixture(), item = await f.local.install(f.archive)
  const file = join(f.root, 'packages', item.release.id, 'skills/fixture-skill/assets/sample.bin'), lstat = files.lstat
  let count = 0
  const inspect = vi.spyOn(files, 'lstat').mockImplementation(async (...args) => {
    if (args[0] === file && ++count === 3) await files.writeFile(file, Buffer.from([0, 0, 0, 0]))
    return lstat(...args)
  })
  try { await expect(f.local.verify(item.release)).rejects.toThrow('modified-installation') }
  finally { inspect.mockRestore() }
  expect(count).toBeGreaterThanOrEqual(3)
})

it('cleans staging files after extraction fails and allows a later successful import', async () => {
  const f = await fixture(), failure = Object.assign(new Error('Disk full'), { code: 'ENOSPC' })
  const write = files.writeFile
  const inject = vi.spyOn(files, 'writeFile').mockImplementation(async (...args) => {
    if (typeof args[0] === 'string' && args[0].endsWith('publication.zip')) throw failure
    return write(...args)
  })
  try { await expect(f.local.install(f.archive)).rejects.toBe(failure) } finally { inject.mockRestore() }
  expect(await files.readdir(f.root)).toEqual(['packages'])
  expect(await f.local.install(f.archive)).toHaveProperty('release', f.release)
})

it('propagates nonmissing storage inspection failures instead of treating them as empty', async () => {
  const f = await fixture(), failure = Object.assign(new Error('Denied'), { code: 'EACCES' }), lstat = files.lstat
  const inject = vi.spyOn(files, 'lstat').mockImplementation(async (...args) => {
    if (args[0] === f.ledger || args[0] === join(f.root, 'packages', f.release.id)) throw failure
    return lstat(...args)
  })
  try { await expect(f.local.list()).rejects.toBe(failure) } finally { inject.mockRestore() }
  await files.writeFile(f.ledger, JSON.stringify({ version: 1, installations: [] }))
  const destination = vi.spyOn(files, 'lstat').mockImplementation(async (...args) => {
    if (args[0] === join(f.root, 'packages', f.release.id)) throw failure
    return lstat(...args)
  })
  try { await expect(f.local.install(f.archive)).rejects.toBe(failure) } finally { destination.mockRestore() }
})

it('accepts an identical existing migration backup and preserves other backup failures', async () => {
  const f = await fixture(); await f.local.install(f.archive)
  const backup = join(f.root, 'installations.v1.backup.json'), before = await files.readFile(f.ledger)
  await files.writeFile(backup, before); await f.local.initializeActivation()
  expect(await files.readFile(backup)).toEqual(before)
  await files.writeFile(f.ledger, before)
  const write = files.writeFile, failure = Object.assign(new Error('Backup denied'), { code: 'EACCES' })
  const inject = vi.spyOn(files, 'writeFile').mockImplementation(async (...args) => {
    if (args[0] === backup) throw failure
    return write(...args)
  })
  try { await expect(f.local.initializeActivation()).rejects.toBe(failure) } finally { inject.mockRestore() }
  expect(await files.readFile(f.ledger)).toEqual(before)
})

it('preserves a failed second migration read before backup or successor writes', async () => {
  const f = await fixture(); await f.local.install(f.archive)
  const lstat = files.lstat, failure = Object.assign(new Error('Storage unavailable'), { code: 'EIO' }); let count = 0
  const inject = vi.spyOn(files, 'lstat').mockImplementation(async (...args) => {
    if (args[0] === f.ledger && ++count === 3) throw failure
    return lstat(...args)
  })
  try { await expect(f.local.initializeActivation()).rejects.toBe(failure) } finally { inject.mockRestore() }
  await expect(files.readFile(join(f.root, 'installations.v1.backup.json'))).rejects.toMatchObject({ code: 'ENOENT' })
})
