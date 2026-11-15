import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { visualizeTool } from '../src/tool.ts'
import { writeFileAtomic } from '../src/storage.ts'

const hooks = vi.hoisted(() => ({
  beforeRename: undefined as ((from: string, to: string) => void) | undefined,
  afterRename: undefined as ((path: string) => void) | undefined,
  afterWrite: undefined as ((path: string) => void) | undefined,
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
      hooks.beforeRename?.(String(args[0]), String(args[1]))
      await fs.rename(...args)
      if (typeof args[1] === 'string') hooks.afterRename?.(args[1])
    },
  }
})

let home: string

/** Expand the reported home alias before direct filesystem assertions. */
const diskPath = (path: string) => path.startsWith('~/') ? join(homedir(), path.slice(2)) : path

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'viz-commit-'))
})
afterEach(async () => {
  hooks.beforeRename = undefined
  hooks.afterRename = undefined
  hooks.afterWrite = undefined
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
  it.each(['EPERM', 'EBUSY'])('retries only the Windows rename after %s and writes the temp once', async code => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
    const path = join(home, 'card.html')
    const candidates: string[] = []
    const writes: string[] = []
    hooks.afterWrite = candidate => writes.push(candidate)
    hooks.beforeRename = (from, to) => {
      expect(to).toBe(path)
      candidates.push(from)
      if (candidates.length < 3) throw Object.assign(new Error('sharing conflict'), { code })
    }
    try {
      await writeFileAtomic(path, 'saved')
      expect(candidates).toHaveLength(3)
      expect(new Set(candidates).size).toBe(1)
      expect(writes).toEqual([candidates[0]])
      expect(await readFile(path, 'utf8')).toBe('saved')
      expect(await readdir(home)).toEqual(['card.html'])
    } finally {
      Object.defineProperty(process, 'platform', platform)
    }
  })

  it('retains the previous fragment and partial receipt when Windows rename retries are exhausted', async () => {
    const { create, patch } = setup()
    const created = await create()
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
    const cause = Object.assign(new Error('sharing conflict'), { code: 'EPERM' })
    let attempts = 0
    hooks.beforeRename = () => { attempts++; throw cause }
    try {
      await expect(patch(created.path, new AbortController().signal)).rejects.toMatchObject({
        cause,
        receipt: { state: 'partial', path: created.path, fragment: 'unconfirmed', imageManifest: 'unchanged', reason: 'write-failed' },
      })
      expect(attempts).toBe(5)
      expect(await readFile(diskPath(created.path), 'utf8')).toBe('<p>old</p>')
      expect(await readdir(join(home, 'visualize', 'sessions', 'sess-commit'))).toEqual([basename(created.path)])
    } finally {
      Object.defineProperty(process, 'platform', platform)
    }
  })

  it.each([['win32', 'EACCES'], ['linux', 'EPERM']])('does not retry %s rename failure %s', async (value, code) => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { ...platform, value })
    const path = join(home, 'card.html')
    const cause = Object.assign(new Error('rename failed'), { code })
    let attempts = 0
    hooks.beforeRename = () => { attempts++; throw cause }
    try {
      await expect(writeFileAtomic(path, 'new')).rejects.toBe(cause)
      expect(attempts).toBe(1)
      expect(await readdir(home)).toEqual([])
    } finally {
      Object.defineProperty(process, 'platform', platform)
    }
  })

  it('stops a pending Windows rename retry when cancelled', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
    const cancel = new AbortController()
    let attempts = 0
    hooks.beforeRename = () => {
      attempts++
      cancel.abort(new Error('cancelled retry'))
      throw Object.assign(new Error('sharing conflict'), { code: 'EBUSY' })
    }
    try {
      await expect(writeFileAtomic(join(home, 'card.html'), 'new', cancel.signal)).rejects.toThrow()
      expect(attempts).toBe(1)
      expect(await readdir(home)).toEqual([])
    } finally {
      Object.defineProperty(process, 'platform', platform)
    }
  })

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
