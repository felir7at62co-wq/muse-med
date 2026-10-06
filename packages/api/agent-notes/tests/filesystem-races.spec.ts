/** Filesystem changes between metadata observations must not widen note access. */
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FsError } from '@deepseek-ai/dsh-fs'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import { failureOf, openNotes, writeNote, type Harness } from './harness.ts'

let harness: Harness

beforeEach(async () => {
  harness = await openNotes('dsh-agent-notes-observation-')
})

afterEach(async () => {
  vi.restoreAllMocks()
  await harness.dispose()
})

describe('agentNotes catalog observations', () => {
  it('lists root notes in title order within one category', async () => {
    await writeNote(harness, 'a.md', '# Zebra\n')
    await writeNote(harness, 'b.md', '# Alpha\n')
    const catalog = await harness.notes.list()
    expect(catalog.notes.map(({ id, category, title }) => ({ id, category, title }))).toEqual([
      { id: 'b.md', category: '', title: 'Alpha' },
      { id: 'a.md', category: '', title: 'Zebra' },
    ])
  })

  it('includes notes at the directory depth limit and does not enter the next level', async () => {
    const directories = Array.from({ length: 8 }, (_value, index) => `d${String(index)}`)
    const included = [...directories, 'included.md'].join('/')
    await writeNote(harness, included, '# Included\n')
    await writeNote(harness, [...directories, 'deeper', 'hidden.md'].join('/'), '# Too deep\n')
    expect((await harness.notes.list()).notes.map(note => note.id)).toEqual([included])
  })

  it('skips a listed directory that disappears before its path metadata is read', async () => {
    const category = join(harness.root, 'vanishing')
    await mkdir(category)
    const listDir = harness.ctx.fs.listDir.bind(harness.ctx.fs)
    vi.spyOn(harness.ctx.fs, 'listDir').mockImplementation(async (target, signal) => {
      const entries = await listDir(target, signal)
      await rm(category, { recursive: true })
      return entries
    })
    await expect(harness.notes.list()).resolves.toMatchObject({ notes: [], truncated: false })
  })

  it('keeps the read headline without a modification time when the file is removed after reading', async () => {
    const path = await writeNote(harness, 'note.md', '# Read before removal\n')
    const readText = harness.ctx.fs.readText.bind(harness.ctx.fs)
    vi.spyOn(harness.ctx.fs, 'readText').mockImplementation(async (target, signal) => {
      const text = await readText(target, signal)
      await rm(path)
      return text
    })
    expect((await harness.notes.list()).notes).toEqual([
      { id: 'note.md', category: '', title: 'Read before removal' },
    ])
  })
})

describe('agentNotes read observations', () => {
  it('refuses a regular file reached through an intermediate directory link outside the root', async (test) => {
    await writeFile(join(harness.outside, 'secret.md'), '# Private\n')
    const category = join(harness.root, 'linked')
    try {
      await symlink(harness.outside, category, 'junction')
    } catch (error) {
      if (process.platform !== 'win32') throw error
      test.skip()
      return
    }
    const readText = vi.spyOn(harness.ctx.fs, 'readText')
    await expect(failureOf(harness.notes.read('linked/secret.md'))).resolves.toMatchObject({
      code: 'agent-note/outside-root', details: { id: 'linked/secret.md' },
    })
    expect(readText).not.toHaveBeenCalled()
    await expect(readFile(join(harness.outside, 'secret.md'), 'utf8')).resolves.toBe('# Private\n')
  })

  it.each(['removed', 'directory'] as const)('refuses a note that becomes %s after its path probe', async (change) => {
    const id = 'category/note.md'
    const path = await writeNote(harness, id, '# Original\n')
    const resolve = harness.ctx.fs.resolve.bind(harness.ctx.fs)
    vi.spyOn(harness.ctx.fs, 'resolve').mockImplementation(async (name, options) => {
      const target = await resolve(name, options)
      if (name === id) {
        await rm(path)
        if (change === 'directory') await mkdir(path)
      }
      return target
    })
    const readText = vi.spyOn(harness.ctx.fs, 'readText')
    const failure = await failureOf(harness.notes.read(id))
    expect(failure).toMatchObject({
      code: change === 'removed' ? 'agent-note/not-found' : 'agent-note/not-regular-file',
      details: { id, ...change === 'directory' ? { kind: 'directory' } : {} },
    })
    expect(readText).not.toHaveBeenCalled()
  })

  it('reports UTF-8 bytes when the backend omits optional file sizes', async () => {
    const id = 'note.md'
    const original = '# 字节\n'
    await writeNote(harness, id, original)
    const stat = harness.ctx.fs.stat.bind(harness.ctx.fs)
    vi.spyOn(harness.ctx.fs, 'stat').mockImplementation(async (target, signal) => {
      const info = await stat(target, signal)
      return info === undefined ? undefined : { type: info.type, version: info.version }
    })
    const read = await harness.notes.read(id)
    expect(read.bytes).toBe(Buffer.byteLength(original, 'utf8'))
    const replacement = '# 新文本\n'
    const saved = await harness.notes.save(id, replacement, read.version)
    expect(saved.bytes).toBe(Buffer.byteLength(replacement, 'utf8'))
    expect(saved.version).not.toBe(read.version)
    await expect(readFile(join(harness.root, id), 'utf8')).resolves.toBe(replacement)
  })
})

describe('agentNotes save outcomes', () => {
  it.each(['null', '17', '{}', '[]'])('refuses JSON text %s before accessing the filesystem', async (json) => {
    expect(remoteMethods(harness.notes).map(marker => marker.method)).toContain('save')
    const text: unknown = JSON.parse(json)
    const method: unknown = Reflect.get(harness.notes, 'save')
    if (typeof method !== 'function') throw new Error('save Remote method is missing')
    const lstat = vi.spyOn(harness.ctx.fs, 'lstat')
    const result: unknown = Reflect.apply(method, harness.notes, ['note.md', text, 'previous-version'])
    if (!(result instanceof Promise)) throw new Error('save Remote method did not return a promise')
    const failure = await failureOf(result)
    expect(failure).toEqual({ code: 'gateway/bad-request', details: {} })
    expect(lstat).not.toHaveBeenCalled()
  })

  it.each([
    new FsError('backend write denied', 'FS_PERMISSION_DENIED'),
    new Error('backend transport closed'),
    null,
    'backend disconnected',
  ])('preserves a non-stale backend refusal without changing note bytes (%s)', async (error) => {
    const path = await writeNote(harness, 'note.md', '# Original\n')
    const read = await harness.notes.read('note.md')
    vi.spyOn(harness.ctx.fs, 'writeText').mockRejectedValue(error)
    await expect(harness.notes.save('note.md', '# Replacement\n', read.version)).rejects.toBe(error)
    await expect(readFile(path, 'utf8')).resolves.toBe('# Original\n')
  })

  it('retains the accepted write version and byte count when a later observer removes the note', async () => {
    const path = await writeNote(harness, 'note.md', '# Original\n')
    const read = await harness.notes.read('note.md')
    const writeText = harness.ctx.fs.writeText.bind(harness.ctx.fs)
    vi.spyOn(harness.ctx.fs, 'writeText').mockImplementation(async (...args) => {
      const outcome = await writeText(...args)
      await expect(readFile(path, 'utf8')).resolves.toBe('# 已写入\n')
      await rm(path)
      return outcome
    })
    const saved = await harness.notes.save('note.md', '# 已写入\n', read.version)
    expect(saved.version).not.toBe(read.version)
    expect(saved.bytes).toBe(Buffer.byteLength('# 已写入\n', 'utf8'))
    await expect(readFile(path, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
