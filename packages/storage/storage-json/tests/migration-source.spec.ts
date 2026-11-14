import { mkdtemp, readFile, realpath, rm, writeFile, rename } from 'node:fs/promises'
import * as files from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { JsonStorageBackend, jsonUnitSourcePath, readJsonUnitSource } from '../src/index.ts'

const descriptor = { name: 'workspace', version: 2, hasGlobal: true, tables: ['workspaces'] }
vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
async function harness() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-json-source-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const backend = new JsonStorageBackend(root)
  onTestFinished(() => backend.close())
  return { root, backend }
}

describe('explicit JSON migration source', () => {
  it('resolves a missing configured root without creating it', async () => {
    const h = await harness(), root = join(h.root, 'not-created'), backend = new JsonStorageBackend(root)
    onTestFinished(() => backend.close())
    const path = join(root, 'workspace.json')
    expect(await jsonUnitSourcePath(backend, descriptor)).toBe(path)
    expect(await readJsonUnitSource(backend, descriptor)).toEqual({ path, text: undefined })
    await expect(files.stat(root)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each(['realpath', 'open'] as const)('preserves a nonmissing %s failure instead of treating the source as absent', async (phase) => {
    const h = await harness(), failure = Object.assign(Error('Source access denied'), { code: 'EACCES' })
    const inspect = phase === 'realpath' ? vi.spyOn(files, 'realpath').mockRejectedValueOnce(failure)
      : vi.spyOn(files, 'open').mockRejectedValueOnce(failure)
    try { await expect(readJsonUnitSource(h.backend, descriptor)).rejects.toBe(failure) }
    finally { inspect.mockRestore() }
  })

  it('rejects an identical-byte file replacement after reading the opened migration source', async () => {
    const h = await harness(), path = await jsonUnitSourcePath(h.backend, descriptor), held = join(h.root, 'held.json')
    const text = JSON.stringify({ unit: { name: 'workspace', version: 2 }, global: null, tables: { workspaces: {} } })
    await writeFile(path, text)
    const stat = files.stat
    const inspect = vi.spyOn(files, 'stat').mockImplementation(async (...args) => {
      if (args[0] === path) { await rename(path, held); await writeFile(path, text) }
      return stat(...args)
    })
    try { await expect(readJsonUnitSource(h.backend, descriptor)).rejects.toThrow('changed while reading') }
    finally { inspect.mockRestore() }
    expect(await readFile(held, 'utf8')).toBe(text)
    expect(await readFile(path, 'utf8')).toBe(text)
  })

  it('rejects a backend closed while reading and releases its owned descriptor', async () => {
    const h = await harness(), path = await jsonUnitSourcePath(h.backend, descriptor)
    await writeFile(path, JSON.stringify({ unit: { name: 'workspace', version: 2 }, global: null, tables: { workspaces: {} } }))
    const open = files.open, entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
    let closed = false
    const inspect = vi.spyOn(files, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args)
      if (args[0] === path) {
        const read = handle.readFile.bind(handle), close = handle.close.bind(handle)
        Object.defineProperty(handle, 'readFile', { value: async (...input: Parameters<typeof handle.readFile>) => {
          entered.resolve(undefined); await release.promise; return read(...input)
        } })
        Object.defineProperty(handle, 'close', { value: async () => { await close(); closed = true } })
      }
      return handle
    })
    const outcome = readJsonUnitSource(h.backend, descriptor).then(value => ({ value }), (error: unknown) => ({ error }))
    try {
      await entered.promise; await h.backend.close(); release.resolve(undefined)
      expect(await outcome).toMatchObject({ error: { message: 'migration source JSON backend closed while reading' } })
      expect(closed).toBe(true)
    } finally { release.resolve(undefined); await outcome; inspect.mockRestore() }
  })
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

  it('distinguishes a missing unit from a malformed or unsupported-version document', async () => {
    const h = await harness()
    const path = await jsonUnitSourcePath(h.backend, descriptor)
    expect(await readJsonUnitSource(h.backend, descriptor)).toEqual({ path, text: undefined })
    await writeFile(path, '{broken')
    await expect(readJsonUnitSource(h.backend, descriptor)).rejects.toThrow('not valid JSON')
    await writeFile(path, JSON.stringify({ unit: { name: 'workspace', version: 99 }, global: null, tables: {} }))
    await expect(readJsonUnitSource(h.backend, descriptor)).rejects.toThrow('not accepted')
  })
})
