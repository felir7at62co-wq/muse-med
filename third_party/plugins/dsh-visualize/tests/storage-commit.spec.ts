import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { visualizeTool } from '../src/tool.ts'
import { writeFileAtomic } from '../src/storage.ts'

const hooks = vi.hoisted(() => ({
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
      await fs.rename(...args)
      if (typeof args[1] === 'string') hooks.afterRename?.(args[1])
    },
  }
})

let home: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'viz-commit-'))
})
afterEach(async () => {
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
      if (path === created.path) cancel.abort()
    }
    await expect(patch(created.path, cancel.signal)).rejects.toMatchObject({
      message: expect.stringContaining('Visualization save is incomplete'),
      receipt: { state: 'partial', path: created.path, fragment: 'saved', imageManifest: 'unchanged', reason: 'cancelled' },
    })
    expect(await readFile(created.path, 'utf8')).toBe('<p>new</p>')
    expect(await readdir(join(home, 'visualize', 'sessions', 'sess-commit'))).toEqual([basename(created.path)])
  })

  it('retains a recoverable saved fragment and reports a failed second manifest commit', async () => {
    const { create, patch, tool, execution } = setup()
    const created = await create()
    const manifest = created.path.replace(/\.html$/u, '.images.json')
    await mkdir(manifest)
    const fragment = '<p>new</p><img data-viz-src="https://example.com/plot.png">'
    await expect(patch(created.path, new AbortController().signal, fragment)).rejects.toMatchObject({
      receipt: { state: 'partial', path: created.path, fragment: 'saved', imageManifest: 'unconfirmed', reason: 'write-failed' },
    })
    expect(await readFile(created.path, 'utf8')).toBe(fragment)
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
    const manifest = created.path.replace(/\.html$/u, '.images.json')
    const cancel = new AbortController()
    hooks.afterRename = path => {
      if (path === manifest) cancel.abort()
    }
    const fragment = '<p>new</p><img data-viz-src="https://example.com/plot.png">'
    await expect(patch(created.path, cancel.signal, fragment)).rejects.toMatchObject({
      receipt: { state: 'partial', path: created.path, fragment: 'saved', imageManifest: 'saved', reason: 'cancelled' },
    })
    expect(await readFile(created.path, 'utf8')).toBe(fragment)
    expect(await readFile(manifest, 'utf8')).toContain('https://example.com/plot.png')
  })
})
