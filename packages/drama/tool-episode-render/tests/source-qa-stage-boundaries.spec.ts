/** Staged evidence rejects changed files while retaining its captured original identities. */
import { createHash } from 'node:crypto'
import * as Fs from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createSourceQaStagedAccess } from '../src/source-qa.ts'
import { cleanup, tempProject } from './harness.ts'

vi.mock('node:fs/promises', async load => ({ ...await load<typeof import('node:fs/promises')>() }))
const roots: string[] = []
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(cleanup)) })

async function fixture() {
  const project = await Fs.realpath(await tempProject())
  roots.push(project)
  const stage = join(project, 'private-stage'), originalPath = join(project, 'original.data')
  const stagedPath = join(stage, 'copy.data'), bytes = Buffer.from('original evidence')
  await Fs.mkdir(stage)
  await Promise.all([Fs.writeFile(originalPath, bytes), Fs.writeFile(stagedPath, bytes)])
  const file = { originalPath, stagedPath, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
  const signal = new AbortController().signal
  return { project, stage, file, signal }
}

it.each(['relative project', 'relative stage', 'invalid directory', 'ambiguous alias'] as const)
('rejects invalid captured identities before any read: %s', async (fault) => {
  const f = await fixture()
  if (fault === 'relative project' || fault === 'relative stage') {
    expect(() => createSourceQaStagedAccess(fault === 'relative project' ? '.' : f.project,
      fault === 'relative stage' ? '.' : f.stage, [f.file], f.signal)).toThrow('canonical absolute roots')
  } else if (fault === 'invalid directory') {
    expect(() => createSourceQaStagedAccess(f.project, f.stage, [f.file], f.signal,
      [{ originalPath: f.project, entries: ['../outside'] }])).toThrow('invalid directory snapshot')
  } else {
    const alias = join(f.project, 'shared-alias')
    expect(() => createSourceQaStagedAccess(f.project, f.stage, [{ ...f.file, aliases: [alias] },
      { ...f.file, originalPath: join(f.project, 'second.data'), stagedPath: join(f.stage, 'second.data'), aliases: [alias] }], f.signal))
      .toThrow('ambiguous alias')
  }
})

it('resolves captured aliases and returns detached directory snapshots', async () => {
  const f = await fixture(), alias = join(f.project, 'alias.data')
  const access = createSourceQaStagedAccess(f.project, f.stage, [{ ...f.file, aliases: [alias] }], f.signal,
    [{ originalPath: f.project, entries: ['original.data'] }])
  expect(access.stagedPath(alias)).toBe(f.file.stagedPath)
  expect(access.logical(alias)).toBe(f.file.originalPath)
  expect(await access.hash(alias)).toBe(f.file.sha256)
  const names = access.list(f.project)
  expect(names).toEqual(['original.data'])
  expect(access.list(f.project)).not.toBe(names)
})

it('refuses oversized captured evidence before allocating its contents', async () => {
  const f = await fixture(), bytes = 64 * 1024 * 1024 + 1
  await Fs.truncate(f.file.stagedPath, bytes)
  const access = createSourceQaStagedAccess(f.project, f.stage, [{ ...f.file, bytes }], f.signal)
  await expect(access.read(f.file.originalPath)).rejects.toThrow('exceeds its read limit')
})

it.each(['replace before open', 'grow during read', 'change after read'] as const)
('rejects a real staged file mutation and closes its descriptor: %s', async (fault) => {
  const f = await fixture(), access = createSourceQaStagedAccess(f.project, f.stage, [f.file], f.signal)
  const open = Fs.open
  let closed = false
  vi.spyOn(Fs, 'open').mockImplementation(async (...args) => {
    if (String(args[0]) === f.file.stagedPath && fault === 'replace before open') {
      await Fs.rename(f.file.stagedPath, f.file.stagedPath + '.held')
      await Fs.writeFile(f.file.stagedPath, 'original evidence')
    }
    const handle = await open(...args)
    if (String(args[0]) !== f.file.stagedPath) return handle
    const close = handle.close.bind(handle)
    Object.defineProperty(handle, 'close', { value: async () => { closed = true; await close() } })
    if (fault === 'grow during read') {
      const read = handle.read.bind(handle)
      let changed = false
      Object.defineProperty(handle, 'read', { value: async (buffer: Buffer, offset: number, length: number, position: number | null) => {
        const result = await read(buffer, offset, length, position)
        if (!changed) { changed = true; await Fs.appendFile(f.file.stagedPath, '!') }
        return result
      } })
    } else if (fault === 'change after read') {
      const stat = handle.stat.bind(handle)
      let inspected = false
      Object.defineProperty(handle, 'stat', { value: async () => {
        if (inspected) await Fs.appendFile(f.file.stagedPath, '!')
        inspected = true
        return await stat()
      } })
    }
    return handle
  })
  await expect(access.read(f.file.originalPath)).rejects.toThrow('stage file changed')
  expect(closed).toBe(true)
})
