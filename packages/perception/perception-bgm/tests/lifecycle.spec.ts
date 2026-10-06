/** Admitted local operations retain teardown ownership across filesystem and worker waits. */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { apply, inject } from '../src/index.ts'

function barrier() { return { entered: Promise.withResolvers<undefined>(), release: Promise.withResolvers<undefined>() } }

const hooks = vi.hoisted(() => ({
  read: undefined as ({ path: string } & ReturnType<typeof barrier>) | undefined,
  write: undefined as ({ path: string } & ReturnType<typeof barrier>) | undefined,
  start: undefined as ReturnType<typeof barrier> | undefined,
  analysis: undefined as ReturnType<typeof barrier> | undefined,
  starts: 0, calls: 0, disposals: 0, writes: 0,
}))
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>()
  return { ...fs,
    async readdir(path: string, options: { withFileTypes: true }) {
      if (hooks.read?.path === path) { hooks.read.entered.resolve(undefined); await hooks.read.release.promise }
      return await fs.readdir(path, options)
    },
    async writeFile(...args: Parameters<typeof fs.writeFile>) {
      if (hooks.write?.path === args[0]) { hooks.writes++; hooks.write.entered.resolve(undefined); await hooks.write.release.promise }
      await fs.writeFile(...args)
    },
  }
})
vi.mock('../src/worker.ts', () => ({ EmotionWorker: class {
  alive = false
  async start() {
    hooks.starts++; this.alive = true
    if (hooks.start) { hooks.start.entered.resolve(undefined); await hooks.start.release.promise }
    return { ready: true, face: 'emotion', missing: [] }
  }
  async call() {
    hooks.calls++
    if (hooks.analysis) { hooks.analysis.entered.resolve(undefined); await hooks.analysis.release.promise }
    return { valence: 6, arousal: 3, moods: ['calm'] }
  }
  async dispose() { hooks.disposals++; this.alive = false }
} }))

const contexts: Context[] = [], roots: string[] = []
beforeEach(() => {
  hooks.read = undefined; hooks.write = undefined; hooks.start = undefined; hooks.analysis = undefined
  hooks.starts = 0; hooks.calls = 0; hooks.disposals = 0; hooks.writes = 0
})
afterEach(async () => {
  hooks.read?.release.resolve(undefined); hooks.write?.release.resolve(undefined)
  hooks.start?.release.resolve(undefined); hooks.analysis?.release.resolve(undefined)
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'bgm-lifetime-')); roots.push(root)
  const music = join(root, 'music'), indexPath = join(root, 'index.json')
  await mkdir(music); await writeFile(join(music, 'a.mp3'), 'first audio'); await writeFile(join(music, 'b.mp3'), 'second audio')
  const ctx = new Context(); contexts.push(ctx)
  await ctx.plugin(SystemPrompt).await(); await ctx.plugin(ToolRuntime, { mode: 'native' }).await()
  const plugin = ctx.plugin({ name: 'perception-bgm', apply, inject }, { pythonExecutable: process.execPath, indexPath })
  await plugin.await()
  const removed = barrier().entered
  ctx.on('tools/change', () => { if (ctx.tools.get('bgm_match') === undefined) removed.resolve(undefined) })
  return { music, indexPath, plugin, removed,
    run: (signal = new AbortController().signal) => ctx.tools.execute({ callId: ToolCallId('bgm-lifecycle'),
      name: 'bgm_match', arguments: { method: 'index', directory: music }, signal }) }
}

it('waits for an admitted directory read and refuses worker creation after unload', async () => {
  const f = await fixture()
  hooks.read = { path: f.music, ...barrier() }
  const work = f.run(); await hooks.read.entered.promise
  const disposing = f.plugin.dispose(); await f.removed.promise
  let disposed = false
  const markDisposed = () => { disposed = true }
  void disposing.then(markDisposed, markDisposed)
  try {
    await Promise.resolve(undefined); expect(disposed).toBe(false)
    hooks.read.release.resolve(undefined)
    const result = await work; await disposing
    expect(result.isError).toBe(true)
    expect({ isError: result.isError, content: result.content }).toMatchInlineSnapshot(`
      {
        "content": [
          {
            "text": "Error: perception-bgm: plugin unloaded",
            "type": "text",
          },
        ],
        "isError": true,
      }
    `)
    expect(hooks.starts).toBe(0); expect(hooks.calls).toBe(0)
    await expect(readFile(f.indexPath)).rejects.toMatchObject({ code: 'ENOENT' })
  } finally { hooks.read.release.resolve(undefined); await Promise.allSettled([work, disposing]) }
})

it('reports caller cancellation after a queued directory read without writing an empty index', async () => {
  const f = await fixture(), controller = new AbortController()
  hooks.read = { path: f.music, ...barrier() }
  const work = f.run(controller.signal); await hooks.read.entered.promise
  try {
    controller.abort(); hooks.read.release.resolve(undefined)
    const result = await work
    expect(result.isError).toBe(true)
    expect({ isError: result.isError, content: result.content }).toMatchInlineSnapshot(`
      {
        "content": [
          {
            "text": "Error: This operation was aborted",
            "type": "text",
          },
        ],
        "isError": true,
      }
    `)
    expect(hooks.starts).toBe(0)
    await expect(readFile(f.indexPath)).rejects.toMatchObject({ code: 'ENOENT' })
  } finally { hooks.read.release.resolve(undefined); await Promise.allSettled([work]) }
})

it('drains an already-started index write and stops the next track before unload completes', async () => {
  const f = await fixture()
  hooks.write = { path: f.indexPath, ...barrier() }
  const work = f.run(); await hooks.write.entered.promise
  const disposing = f.plugin.dispose(); await f.removed.promise
  let disposed = false
  const markDisposed = () => { disposed = true }
  void disposing.then(markDisposed, markDisposed)
  try {
    await Promise.resolve(undefined); expect(disposed).toBe(false)
    hooks.write.release.resolve(undefined)
    const result = await work; await disposing
    expect(result.isError).toBe(true)
    expect(hooks.calls).toBe(1); expect(hooks.disposals).toBe(1); expect(hooks.writes).toBe(1)
    expect(JSON.parse(await readFile(f.indexPath, 'utf8'))).toEqual([expect.objectContaining({ path: join(f.music, 'a.mp3') })])
  } finally { hooks.write.release.resolve(undefined); await Promise.allSettled([work, disposing]) }
})


it('drains a worker handshake and refuses the first analysis after unload', async () => {
  const f = await fixture()
  hooks.start = barrier()
  const work = f.run(); await hooks.start.entered.promise
  const disposing = f.plugin.dispose(); await f.removed.promise
  let disposed = false
  const markDisposed = () => { disposed = true }
  void disposing.then(markDisposed, markDisposed)
  try {
    await Promise.resolve(undefined); expect(disposed).toBe(false)
    hooks.start.release.resolve(undefined)
    const result = await work; await disposing
    expect(result.isError).toBe(true)
    expect(result.content).toEqual([{ type: 'text', text: 'Error: perception-bgm: plugin unloaded' }])
    expect(hooks.starts).toBe(1); expect(hooks.calls).toBe(0); expect(hooks.disposals).toBe(1)
    await expect(readFile(f.indexPath)).rejects.toMatchObject({ code: 'ENOENT' })
  } finally { hooks.start.release.resolve(undefined); await Promise.allSettled([work, disposing]) }
})

it('waits for an admitted analysis without persisting its late result after unload', async () => {
  const f = await fixture()
  hooks.analysis = barrier()
  const work = f.run(); await hooks.analysis.entered.promise
  const disposing = f.plugin.dispose(); await f.removed.promise
  let disposed = false
  const markDisposed = () => { disposed = true }
  void disposing.then(markDisposed, markDisposed)
  try {
    await Promise.resolve(undefined); expect(disposed).toBe(false)
    hooks.analysis.release.resolve(undefined)
    const result = await work; await disposing
    expect(result.isError).toBe(true)
    expect(result.content).toEqual([{ type: 'text', text: 'Error: perception-bgm: plugin unloaded' }])
    expect(hooks.calls).toBe(1); expect(hooks.disposals).toBe(1)
    await expect(readFile(f.indexPath)).rejects.toMatchObject({ code: 'ENOENT' })
  } finally { hooks.analysis.release.resolve(undefined); await Promise.allSettled([work, disposing]) }
})
