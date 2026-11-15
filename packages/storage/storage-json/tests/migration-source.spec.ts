import { chmod, mkdtemp, readFile, realpath, rename, rm, utimes, writeFile } from 'node:fs/promises'
import * as Files from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { JsonStorageBackend, jsonUnitSourcePath, readJsonUnitSource } from '../src/index.ts'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
const nativeFiles = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
afterEach(() => { vi.restoreAllMocks() })

const descriptor = { name: 'workspace', version: 2, hasGlobal: true, tables: ['workspaces'] }
async function harness() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-json-source-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const backend = new JsonStorageBackend(root)
  onTestFinished(() => backend.close())
  return { root, backend }
}

async function sourceDocument() {
  const h = await harness(), path = await jsonUnitSourcePath(h.backend, descriptor)
  const text = JSON.stringify({ unit: { name: 'workspace', version: 2 }, global: null, tables: { workspaces: {} } })
  await writeFile(path, text)
  return { ...h, path, text }
}

/** Put the real file change between the handle's read and its following identity check. */
function afterSourceRead(path: string, change: () => Promise<void>) {
  let seen: Files.FileHandle | undefined
  vi.spyOn(Files, 'open').mockImplementation(async (...args) => {
    const handle = await nativeFiles.open(...args)
    if (String(args[0]) !== path) return handle
    onTestFinished(() => handle.close())
    seen = handle
    const read = handle.readFile.bind(handle)
    vi.spyOn(handle, 'readFile').mockImplementationOnce(async (options) => {
      const text = await read(options)
      await change()
      return text
    })
    return handle
  })
  return async () => {
    if (seen === undefined) throw new Error('Migration did not open the selected source')
    await expect(seen.stat()).rejects.toMatchObject({ code: 'EBADF' })
  }
}

describe('explicit JSON migration source', () => {
  it('reads a complete current disk snapshot instead of the opened unit cache', async () => {
    const h = await harness()
    const unit = await h.backend.kv.open(descriptor)
    await unit.putRecord('workspaces', 'first', { title: 'cached' })
    const path = await jsonUnitSourcePath(h.backend, descriptor)
    const text = JSON.stringify({ unit: { name: 'workspace', version: 2 }, global: null, tables: { workspaces: { second: { title: 'fresh' } } } })
    await writeFile(path, text)
    expect((await unit.loadAll()).tables.workspaces).toEqual({ first: { title: 'cached' } })
    expect(await readJsonUnitSource(h.backend, descriptor)).toEqual({ path, text })
    expect(await readFile(path, 'utf8')).toBe(text)
  })

  it('resolves the configured custom root and refuses unsupported or closed backends', async () => {
    const h = await harness()
    expect(await jsonUnitSourcePath(h.backend, descriptor)).toBe(join(await realpath(h.root), 'workspace.json'))
    await expect(readJsonUnitSource({ close: () => Promise.resolve() }, descriptor)).rejects.toThrow('not a live JSON')
    await expect(readJsonUnitSource(h.backend, { ...descriptor, layout: 'per-record' })).rejects.toThrow('single-unit')
    await h.backend.close()
    await expect(readJsonUnitSource(h.backend, descriptor)).rejects.toThrow('not a live JSON')
  })

  it('refuses an in-flight migration read after its backend closes without changing the source', async () => {
    const h = await harness(), path = await jsonUnitSourcePath(h.backend, descriptor)
    const text = JSON.stringify({ unit: { name: 'workspace', version: 2 }, global: null,
      tables: { workspaces: { first: { title: 'retained source' } } } })
    await writeFile(path, text)
    const reading = readJsonUnitSource(h.backend, descriptor)
    const refused = expect(reading).rejects.toThrow('migration source JSON backend closed while reading')
    await h.backend.close()
    await refused
    expect(await readFile(path, 'utf8')).toBe(text)
    await expect(readJsonUnitSource(h.backend, descriptor)).rejects.toThrow('not a live JSON')
  })

  it('distinguishes a missing unit from a malformed or unsupported-version document', async () => {
    const h = await harness()
    const path = await jsonUnitSourcePath(h.backend, descriptor)
    expect(await readJsonUnitSource(h.backend, descriptor)).toEqual({ path, text: undefined })
    await writeFile(path, '{broken')
    await expect(readJsonUnitSource(h.backend, descriptor)).rejects.toThrow('not valid JSON')
    await writeFile(path, JSON.stringify({ unit: { name: 'workspace', version: 99 }, global: null, tables: {} }))
    await expect(readJsonUnitSource(h.backend, descriptor)).rejects.toThrow('not accepted')
  })

  it('keeps an absent configured root absent while resolving its source identity', async () => {
    const h = await harness(), root = join(h.root, 'not-created'), backend = new JsonStorageBackend(root)
    onTestFinished(() => backend.close())
    const path = join(resolve(root), 'workspace.json')
    expect(await readJsonUnitSource(backend, descriptor)).toEqual({ path, text: undefined })
    await expect(nativeFiles.stat(root)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('propagates root lookup and source-open permission errors without treating them as missing', async () => {
    const h = await harness(), denied = Object.assign(new Error('denied migration source'), { code: 'EACCES' })
    const lookup = vi.spyOn(Files, 'realpath').mockRejectedValueOnce(denied)
    await expect(readJsonUnitSource(h.backend, descriptor)).rejects.toBe(denied)
    lookup.mockRestore()
    vi.spyOn(Files, 'open').mockRejectedValueOnce(denied)
    await expect(readJsonUnitSource(h.backend, descriptor)).rejects.toBe(denied)
  })

  it.each(['replacement', 'size', 'mtime'] as const)('rejects a real source %s while its handle is being read', async (kind) => {
    const h = await sourceDocument()
    const closed = afterSourceRead(h.path, async () => {
      if (kind === 'replacement') {
        await rename(h.path, `${h.path}.old`)
        await writeFile(h.path, h.text)
      } else if (kind === 'size') await writeFile(h.path, `${h.text}\n`)
      else await utimes(h.path, new Date(0), new Date(0))
    })
    await expect(readJsonUnitSource(h.backend, descriptor)).rejects.toThrow('changed while reading')
    await closed()
    expect(await readFile(h.path, 'utf8')).toBe(kind === 'size' ? `${h.text}\n` : h.text)
  })

  // Windows chmod does not provide this POSIX permission/ctime transition.
  it.skipIf(process.platform === 'win32')('rejects a POSIX permission change with unchanged bytes and mtime', async () => {
    const h = await sourceDocument(), before = await nativeFiles.stat(h.path, { bigint: true })
    const closed = afterSourceRead(h.path, async () => { await chmod(h.path, Number(before.mode) ^ 0o100) })
    await expect(readJsonUnitSource(h.backend, descriptor)).rejects.toThrow('changed while reading')
    const after = await nativeFiles.stat(h.path, { bigint: true })
    expect(after.mtimeNs).toBe(before.mtimeNs)
    expect(after.ctimeNs).not.toBe(before.ctimeNs)
    expect(await readFile(h.path, 'utf8')).toBe(h.text)
    await closed()
  })

  it('rejects backend closure during the read and still closes the real file handle', async () => {
    const h = await sourceDocument(), closed = afterSourceRead(h.path, () => h.backend.close())
    await expect(readJsonUnitSource(h.backend, descriptor)).rejects.toThrow('backend closed while reading')
    await closed()
    expect(await readFile(h.path, 'utf8')).toBe(h.text)
  })
})
