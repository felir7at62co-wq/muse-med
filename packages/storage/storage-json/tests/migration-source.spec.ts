import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished } from 'vitest'
import { JsonStorageBackend, jsonUnitSourcePath, readJsonUnitSource } from '../src/index.ts'

const descriptor = { name: 'workspace', version: 2, hasGlobal: true, tables: ['workspaces'] }
async function harness() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-json-source-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const backend = new JsonStorageBackend(root)
  onTestFinished(() => backend.close())
  return { root, backend }
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
