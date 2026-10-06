/** Media adapters fail closed on provider output, cancellation, and confinement errors. */
import { Readable } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import { SubprocessRuntime, type SubprocessHandle, type SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { SandboxProvider } from '@deepseek-ai/dsh-sandbox'
import { afterEach, expect, it, vi } from 'vitest'
import { runMedia, parseVideoMetadata } from '../src/media.ts'

const contexts: Context[] = []
afterEach(async () => {
  vi.useRealTimers()
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})
const policy = { mode: 'danger-full-access', workspaceRoot: process.cwd() } as const
const limits = { timeoutMs: 10_000, maxBytes: 100, graceMs: 100 }

async function fixture(kind: 'success' | 'stdout-missing' | 'encoded' | 'overflow' | 'failed' | 'spawn-error' | 'pending' | 'no-diagnostic') {
  const ctx = new Context()
  contexts.push(ctx)
  const calls: SubprocessSpawnSpec[] = [], cleanup: string[] = []
  const spawned = Promise.withResolvers<undefined>()
  class MediaRuntime extends SubprocessRuntime {
    async resolveExecutable(command: string): Promise<string> { return command }
    terminalEnvironment(): never { throw new Error('No terminal inspection') }
    spawnTerminal(): never { throw new Error('No terminal allocation') }
    spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
      calls.push(spec)
      const stdout = kind === 'stdout-missing' ? undefined : kind === 'pending'
        ? Readable.from((async function* () {
          await new Promise<void>(resolve => spec.signal?.addEventListener('abort', () => { resolve() }, { once: true }))
          yield Buffer.alloc(0)
        })())
        : Readable.from([kind === 'encoded' ? 'encoded provider output' : Buffer.from(kind === 'overflow' ? 'x'.repeat(101) : 'bytes')])
      spawned.resolve(undefined)
      return { stdout, stdin: undefined, stderr: undefined, control: undefined,
        collected: kind === 'no-diagnostic' ? {} : { stderr: { readFrom: () => ({ text: 'decoder diagnostic', nextOffset: 18, lossy: false }) } },
        done: kind === 'spawn-error' ? Promise.reject(new Error('media executable unavailable'))
          : Promise.resolve({ exitCode: kind === 'failed' ? 7 : 0, signal: null }),
        terminate() { cleanup.push('terminate') }, waitForExit: async () => { cleanup.push('wait'); return true },
      }
    }
  }
  await ctx.plugin(MediaRuntime).await()
  return { ctx, calls, cleanup, spawned }
}

it.each(['stdout-missing', 'encoded', 'overflow', 'failed', 'spawn-error'] as const)(
  'rejects %s media output and awaits owned process cleanup', async (kind) => {
    const f = await fixture(kind)
    const message = { 'stdout-missing': 'output stream', encoded: 'non-binary', overflow: 'byte limit',
      failed: 'exit 7', 'spawn-error': 'executable unavailable' }[kind]
    await expect(runMedia(f.ctx, ['media'], policy, undefined, limits)).rejects.toThrow(message)
    expect(f.cleanup).toEqual(['terminate', 'wait'])
  })

it('accepts binary output when a provider does not expose collected stderr', async () => {
  const f = await fixture('no-diagnostic')
  expect(await runMedia(f.ctx, ['media'], policy, undefined, limits)).toEqual({ bytes: Buffer.from('bytes'), diagnostic: '' })
})

it('rejects an already-cancelled operation before spawning', async () => {
  const f = await fixture('success'), controller = new AbortController()
  controller.abort(new Error('cancelled before media'))
  await expect(runMedia(f.ctx, ['media'], policy, controller.signal, limits)).rejects.toThrow('cancelled before media')
  expect(f.calls).toEqual([])
  expect(f.cleanup).toEqual([])
})

it('aborts a pending media command at its owned deadline and waits for cleanup', async () => {
  const f = await fixture('pending')
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const operation = runMedia(f.ctx, ['media'], policy, undefined, limits)
  const failed = expect(operation).rejects.toThrow('timed out')
  await f.spawned.promise
  await vi.advanceTimersByTimeAsync(limits.timeoutMs)
  await failed
  expect(f.cleanup).toEqual(['terminate', 'wait'])
})

it('requires a confinement provider and forwards its returned command', async () => {
  const f = await fixture('success'), confinedPolicy = { ...policy, mode: 'read-only' } as const
  await expect(runMedia(f.ctx, ['media', 'input'], confinedPolicy, undefined, limits)).rejects.toMatchObject({ code: 'SANDBOX_UNAVAILABLE' })
  expect(f.calls).toEqual([])
  class Confinement extends SandboxProvider {
    async confine(argv: readonly string[]) { return { argv: ['fixture-runner', ...argv], enforcement: 'full' as const,
      denialSignatures: [], runnerFailureRules: [] } }
  }
  await f.ctx.plugin(Confinement).await()
  expect(await runMedia(f.ctx, ['media', 'input'], confinedPolicy, undefined, limits)).toEqual({ bytes: Buffer.from('bytes'), diagnostic: 'decoder diagnostic' })
  expect(f.calls[0]?.argv).toEqual(['fixture-runner', 'media', 'input'])
})

it.each([
  { duration: 0, width: 2, height: 2, codec_name: 'h264' },
  { duration: 'Infinity', width: 2, height: 2, codec_name: 'h264' },
  { duration: 4, width: 0, height: 2, codec_name: 'h264' },
  { duration: 4, width: 1.5, height: 2, codec_name: 'h264' },
  { duration: 4, width: 2, height: -1, codec_name: 'h264' },
  { duration: 4, width: 2, height: 1.5, codec_name: 'h264' },
  { duration: 4, width: 2, height: 2, codec_name: null },
])('rejects invalid persisted probe facts %#', ({ duration, ...stream }) => {
  expect(() => parseVideoMetadata(Buffer.from(JSON.stringify({ format: { duration }, streams: [{ codec_type: 'video', ...stream }] })))).toThrow('invalid')
})

it('reports audio presence without inventing video observations', () => {
  expect(parseVideoMetadata(Buffer.from(JSON.stringify({ format: { duration: '4' }, streams: [null, 2, {},
    { codec_type: 'video', width: 2, height: 2, codec_name: 'h264' }, { codec_type: 'audio' }] })))).toMatchObject({ has_audio: true })
})
