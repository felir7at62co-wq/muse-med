import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { visualizeTool } from '../src/tool.ts'
import { writeFileAtomic } from '../src/storage.ts'

const hooks = vi.hoisted(() => ({
  afterRename: undefined as ((path: string) => void) | undefined,
  afterWrite: undefined as ((path: string) => void) | undefined,
  afterRenameFailure: undefined as (() => void) | undefined,
  renameFailures: [] as (string | undefined)[],
  renameAttempts: 0,
}))

vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>()
  return {
    ...fs,
    async writeFile(...args: Parameters<typeof fs.writeFile>) {
      await fs.writeFile(...args)
      if (typeof args[0] === 'string') hooks.afterWrite?.(args[0])
    },
    async rename(...args: Parameters<typeof fs.rename>) {
      hooks.renameAttempts++
      if (hooks.renameFailures.length > 0) {
        const code = hooks.renameFailures.shift()
        hooks.afterRenameFailure?.()
        throw code === undefined ? new Error('rename failed without an error code') : Object.assign(new Error(`rename failed: ${code}`), { code })
      }
      await fs.rename(...args)
      if (typeof args[1] === 'string') hooks.afterRename?.(args[1])
    },
  }
})

let home: string

/** Convert only independent disk checks; persisted receipts retain the model-facing path. */
function diskPath(path: string): string {
  return path.startsWith('~/') || (process.platform === 'win32' && path.startsWith('~\\'))
    ? join(homedir(), path.slice(2)) : path
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'viz-commit-'))
})
afterEach(async () => {
  hooks.afterRename = undefined
  hooks.afterWrite = undefined
  hooks.afterRenameFailure = undefined
  hooks.renameFailures = []
  hooks.renameAttempts = 0
  vi.restoreAllMocks()
  await rm(home, { recursive: true, force: true })
})

function setup() {
  const ctx = {
    get: (name: string) => name === 'dshHomePath' ? (...parts: string[]) => join(home, ...parts) : undefined,
    fs: {},
  } as never
  const tool = visualizeTool(ctx, 10_000, 'whale', {
    delivery: () => true,
    fetchUrl: async () => Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]),
  })
  const execution = (signal = new AbortController().signal) => ({
    agent: { session: { id: 'sess-commit', header: {} } }, signal,
  }) as never
  const create = async () => await tool.execute({ fragment: '<p>old</p>', title: 'Lab' }, execution()) as { path: string }
  const patch = (path: string, signal: AbortSignal, fragment = '<p>new</p>') => tool.execute({
    action: 'update', path, title: 'Lab', old_str: '<p>old</p>', new_str: fragment,
  }, execution(signal))
  return { tool, execution, create, patch }
}

describe('visualization save receipts', () => {
  it('keeps the previous atomic file and removes its temp when cancelled before rename', async () => {
    const path = join(home, 'card.html')
    await writeFile(path, 'old')
    const cancel = new AbortController()
    hooks.afterWrite = candidate => {
      if (candidate.startsWith(`${path}.`) && candidate.endsWith('.tmp')) cancel.abort()
    }
    await expect(writeFileAtomic(path, 'new', cancel.signal)).rejects.toThrow()
    expect(await readFile(path, 'utf8')).toBe('old')
    expect(await readdir(home)).toEqual(['card.html'])
  })

  it('reports the saved fragment and unchanged manifest when cancelled after fragment rename', async () => {
    const { create, patch } = setup()
    const created = await create()
    const cancel = new AbortController()
    hooks.afterRename = path => {
      if (path === diskPath(created.path)) cancel.abort()
    }
    await expect(patch(created.path, cancel.signal)).rejects.toMatchObject({
      message: expect.stringContaining('Visualization save is incomplete'),
      receipt: { state: 'partial', path: created.path, fragment: 'saved', imageManifest: 'unchanged', reason: 'cancelled' },
    })
    expect(await readFile(diskPath(created.path), 'utf8')).toBe('<p>new</p>')
    expect(await readdir(join(home, 'visualize', 'sessions', 'sess-commit'))).toEqual([basename(created.path)])
  })

  it('retains a recoverable saved fragment and reports a failed second manifest commit', async () => {
    const { create, patch, tool, execution } = setup()
    const created = await create()
    const manifest = diskPath(created.path).replace(/\.html$/u, '.images.json')
    await mkdir(manifest)
    const fragment = '<p>new</p><img data-viz-src="https://example.com/plot.png">'
    await expect(patch(created.path, new AbortController().signal, fragment)).rejects.toMatchObject({
      receipt: { state: 'partial', path: created.path, fragment: 'saved', imageManifest: 'unconfirmed', reason: 'write-failed' },
    })
    expect(await readFile(diskPath(created.path), 'utf8')).toBe(fragment)
    expect((await readdir(join(home, 'visualize', 'sessions', 'sess-commit'))).some(name => name.endsWith('.tmp'))).toBe(false)
    // The returned path addresses the saved fragment; recovery patches that state.
    await rm(manifest, { recursive: true })
    const recovered = await tool.execute({ action: 'update', path: created.path, title: 'Lab', old_str: 'new', new_str: 'recovered' }, execution()) as { path: string; fragment: string }
    expect(recovered.path).toBe(created.path)
    expect(await readFile(manifest, 'utf8')).toContain('https://example.com/plot.png')
    expect(recovered.fragment).toContain('<p>recovered</p>')
  })

  it('reports both saved files when cancellation arrives after the manifest commit', async () => {
    const { create, patch } = setup()
    const created = await create()
    const manifest = diskPath(created.path).replace(/\.html$/u, '.images.json')
    const cancel = new AbortController()
    hooks.afterRename = path => {
      if (path === manifest) cancel.abort()
    }
    const fragment = '<p>new</p><img data-viz-src="https://example.com/plot.png">'
    await expect(patch(created.path, cancel.signal, fragment)).rejects.toMatchObject({
      receipt: { state: 'partial', path: created.path, fragment: 'saved', imageManifest: 'saved', reason: 'cancelled' },
    })
    expect(await readFile(diskPath(created.path), 'utf8')).toBe(fragment)
    expect(await readFile(manifest, 'utf8')).toContain('https://example.com/plot.png')
  })
})

describe('atomic replacement under Windows contention', () => {
  it('retries only the bounded transient rename errors and leaves a complete replacement', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const path = join(home, 'card.html')
    await writeFile(path, 'old')
    hooks.renameFailures = ['EPERM', 'EACCES', 'EBUSY']
    await writeFileAtomic(path, 'new')
    expect(hooks.renameAttempts).toBe(4)
    expect(await readFile(path, 'utf8')).toBe('new')
    expect(await readdir(home)).toEqual(['card.html'])
  })

  it('stops after eight retries and retains the previous file without a temporary sibling', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const path = join(home, 'card.html')
    await writeFile(path, 'old')
    hooks.renameFailures = Array.from({ length: 9 }, () => 'EPERM')
    await expect(writeFileAtomic(path, 'new')).rejects.toMatchObject({ code: 'EPERM' })
    expect(hooks.renameAttempts).toBe(9)
    expect(await readFile(path, 'utf8')).toBe('old')
    expect(await readdir(home)).toEqual(['card.html'])
  })

  it('cancels a transient replacement before another attempt and cleans its private temp', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const path = join(home, 'card.html')
    await writeFile(path, 'old')
    const cancel = new AbortController()
    const reason = new Error('cancelled replacement')
    hooks.renameFailures = ['EPERM']
    hooks.afterRenameFailure = () => { cancel.abort(reason) }
    await expect(writeFileAtomic(path, 'new', cancel.signal)).rejects.toBe(reason)
    expect(hooks.renameAttempts).toBe(1)
    expect(await readFile(path, 'utf8')).toBe('old')
    expect(await readdir(home)).toEqual(['card.html'])
  })

  it.each(['ENOSPC', 'EEXIST', undefined])('preserves an unrecognized rename error %s without retrying', async (code) => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const path = join(home, 'card.html')
    await writeFile(path, 'old')
    hooks.renameFailures = [code]
    const operation = expect(writeFileAtomic(path, 'new')).rejects
    if (code === undefined) await operation.toThrow('rename failed without an error code')
    else await operation.toMatchObject({ code })
    expect(hooks.renameAttempts).toBe(1)
    expect(await readFile(path, 'utf8')).toBe('old')
    expect(await readdir(home)).toEqual(['card.html'])
  })

  it('does not retry a POSIX permission failure', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    const path = join(home, 'card.html')
    await writeFile(path, 'old')
    hooks.renameFailures = ['EPERM']
    await expect(writeFileAtomic(path, 'new')).rejects.toMatchObject({ code: 'EPERM' })
    expect(hooks.renameAttempts).toBe(1)
    expect(await readFile(path, 'utf8')).toBe('old')
    expect(await readdir(home)).toEqual(['card.html'])
  })
})
