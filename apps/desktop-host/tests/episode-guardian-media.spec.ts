/** Guardian media ownership joins command outcomes and managed ranges independently. */
import { Context } from '@deepseek-ai/cordis'
import {
  SubprocessRuntime, type SubprocessHandle, type SubprocessOutcome, type SubprocessOutputRead,
  type SubprocessSpawnSpec, type SubprocessTerminalEnvironment, type SubprocessTerminalHandle,
} from '@deepseek-ai/dsh-subprocess'
import { expect, it, onTestFinished, vi } from 'vitest'
import { GuardianMediaChannel } from '../src/episode-guardian-media.ts'

const completed: SubprocessOutcome = { exitCode: 0, signal: null }

function controlledHandle(options: { output?: 'stdout-lossy' | 'stderr-lossy' | 'missing-stdout' | 'missing-stderr' } = {}) {
  const done = Promise.withResolvers<SubprocessOutcome>(), range = Promise.withResolvers<boolean>()
  const observing = Promise.withResolvers<undefined>()
  const stdout = vi.fn((): SubprocessOutputRead => ({ text: '{"streams":[]}', nextOffset: 14,
    lossy: options.output === 'stdout-lossy' }))
  const stderr = vi.fn((): SubprocessOutputRead => ({ text: 'media diagnostic', nextOffset: 16,
    lossy: options.output === 'stderr-lossy' }))
  const terminate = vi.fn()
  const waitForExit = vi.fn(async (_signal?: AbortSignal): Promise<boolean> => {
    observing.resolve(undefined)
    return await range.promise
  })
  const handle: SubprocessHandle = {
    stdin: undefined, stdout: undefined, stderr: undefined, control: undefined,
    collected: {
      ...(options.output === 'missing-stdout' ? {} : { stdout: { readFrom: stdout } }),
      ...(options.output === 'missing-stderr' ? {} : { stderr: { readFrom: stderr } }),
    }, done: done.promise, terminate, waitForExit,
  }
  return { handle, done, range, observing, stdout, stderr, terminate, waitForExit,
    finish: () => { done.resolve(completed); range.resolve(true) } }
}

/** A typed provider adapter; no native process is started by this owner suite. */
class ControlledSubprocess extends SubprocessRuntime {
  readonly calls: SubprocessSpawnSpec[] = []
  constructor(ctx: Context, private readonly create: (spec: SubprocessSpawnSpec) => SubprocessHandle) { super(ctx) }
  override async resolveExecutable(command: string): Promise<string> { return command }
  override async terminalEnvironment(): Promise<SubprocessTerminalEnvironment> { return { platform: 'posix' } }
  override async spawnTerminal(): Promise<SubprocessTerminalHandle> { throw new Error('No terminal in guardian media fixture') }
  override spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    this.calls.push(spec)
    return this.create(spec)
  }
}

function fixture(handles: ReturnType<typeof controlledHandle>[] = [controlledHandle()],
  create?: (spec: SubprocessSpawnSpec) => SubprocessHandle, request = new AbortController()) {
  const context = new Context()
  let next = 0
  const runtime = new ControlledSubprocess(context, create ?? (() => {
    const entry = handles[next++]
    if (entry === undefined) throw new Error('Unexpected media spawn')
    return entry.handle
  }))
  const channel = new GuardianMediaChannel({ subprocess: runtime, cwd: '/private/episode-stage',
    ffmpeg: '/captured/ffmpeg', ffprobe: '/captured/ffprobe', graceMs: 2000,
    stdoutBytes: 1024, stderrBytes: 512, signal: request.signal })
  onTestFinished(async () => {
    for (const handle of handles) handle.finish()
    try { await channel.stopAndJoin() } finally { await context.fiber.dispose() }
  })
  return { channel, runtime, request, handles }
}

it.each(['/captured/ffmpeg', '/captured/ffprobe'])('runs only captured %s with complete output after both joins', async (command) => {
  const handle = controlledHandle(), { channel, runtime } = fixture([handle])
  handle.finish()
  await expect(channel.run(command, ['-version'])).resolves.toEqual({ code: 0,
    stdout: '{"streams":[]}', stderr: 'media diagnostic' })
  expect(runtime.calls).toHaveLength(1)
  expect(runtime.calls[0]).toMatchObject({ argv: [command, '-version'], cwd: '/private/episode-stage',
    graceMs: 2000, stdio: { stdin: 'ignore', stdout: { maxBytes: 1024 }, stderr: { maxBytes: 512 } } })
  expect(runtime.calls[0]?.signal).toBeInstanceOf(AbortSignal)
  expect(handle.waitForExit.mock.calls).toEqual([[]])
  expect(handle.stdout).toHaveBeenCalledWith(0)
  expect(handle.stderr).toHaveBeenCalledWith(0)
  await expect(channel.stopAndJoin()).resolves.toEqual({ kind: 'empty', commands: 1 })
})

it.each([7, null])('preserves a non-success command outcome %s after a proven empty range', async (exitCode) => {
  const handle = controlledHandle(), { channel } = fixture([handle])
  handle.done.resolve({ exitCode, signal: exitCode === null ? 'SIGTERM' : null })
  handle.range.resolve(true)
  expect((await channel.run('/captured/ffmpeg', [])).code).toBe(exitCode ?? 1)
  await expect(channel.stopAndJoin()).resolves.toEqual({ kind: 'empty', commands: 1 })
})

it('does not spawn an executable outside the captured media pair', async () => {
  const { channel, runtime } = fixture([])
  await expect(channel.run('/other/ffmpeg', [])).rejects.toThrow('uncaptured media executable')
  expect(runtime.calls).toEqual([])
  await expect(channel.stopAndJoin()).resolves.toEqual({ kind: 'empty', commands: 0 })
})

it('does not spawn after its live request is aborted', async () => {
  const { channel, runtime, request } = fixture([])
  request.abort(new Error('request cancelled'))
  await expect(channel.run('/captured/ffprobe', [])).rejects.toThrow()
  expect(runtime.calls).toEqual([])
  await expect(channel.stopAndJoin()).resolves.toEqual({ kind: 'empty', commands: 0 })
})

it('does not spawn when the request was aborted before channel construction', async () => {
  const request = new AbortController()
  request.abort()
  const { channel, runtime } = fixture([], undefined, request)
  await expect(channel.run('/captured/ffprobe', [])).rejects.toThrow()
  expect(runtime.calls).toEqual([])
  await expect(channel.stopAndJoin()).resolves.toEqual({ kind: 'empty', commands: 0 })
})

it('does not read output when the command is done but its managed range is still occupied', async () => {
  const handle = controlledHandle(), { channel } = fixture([handle])
  const result = channel.run('/captured/ffprobe', [])
  await handle.observing.promise
  handle.done.resolve(completed)
  await handle.done.promise
  expect(handle.stdout).not.toHaveBeenCalled()
  expect(handle.stderr).not.toHaveBeenCalled()
  handle.range.resolve(true)
  await expect(result).resolves.toMatchObject({ code: 0 })
})

it('observes the managed range even when the command outcome rejects', async () => {
  const handle = controlledHandle(), { channel } = fixture([handle])
  const failure = new Error('command outcome unavailable')
  const result = channel.run('/captured/ffmpeg', [])
  const rejected = expect(result).rejects.toBe(failure)
  handle.done.reject(failure)
  await handle.observing.promise
  expect(handle.waitForExit.mock.calls).toEqual([[]])
  handle.range.resolve(true)
  await rejected
  await expect(channel.stopAndJoin()).resolves.toMatchObject({ kind: 'unknown' })
  expect(handle.stdout).not.toHaveBeenCalled()
})

it('keeps unknown when the managed range cannot be observed after command completion', async () => {
  const handle = controlledHandle(), { channel } = fixture([handle])
  const failure = new Error('provider lost range observation')
  const result = channel.run('/captured/ffmpeg', [])
  const rejected = expect(result).rejects.toBe(failure)
  await handle.observing.promise
  handle.done.resolve(completed)
  handle.range.reject(failure)
  await rejected
  await expect(channel.stopAndJoin()).resolves.toMatchObject({ kind: 'unknown' })
  expect(handle.stdout).not.toHaveBeenCalled()
})

it('closes admission synchronously and joins every range without the aborted caller signal', async () => {
  const first = controlledHandle(), second = controlledHandle()
  const { channel, runtime, request } = fixture([first, second])
  const firstRun = channel.run('/captured/ffmpeg', []), secondRun = channel.run('/captured/ffprobe', [])
  const outcomes = Promise.allSettled([firstRun, secondRun])
  await Promise.all([first.observing.promise, second.observing.promise])
  request.abort(new Error('Host pipe closed'))
  const joined = channel.stopAndJoin()
  expect(channel.stopAndJoin()).toBe(joined)
  await expect(channel.run('/captured/ffmpeg', [])).rejects.toThrow('media channel is closed')
  expect(runtime.calls).toHaveLength(2)
  expect(runtime.calls.every(call => call.signal?.aborted)).toBe(true)
  expect(first.terminate).toHaveBeenCalledOnce()
  expect(second.terminate).toHaveBeenCalledOnce()
  expect(first.waitForExit.mock.calls).toEqual([[]])
  expect(second.waitForExit.mock.calls).toEqual([[]])
  first.finish(); second.finish()
  await expect(joined).resolves.toEqual({ kind: 'empty', commands: 2 })
  expect((await outcomes).map(result => result.status)).toEqual(['rejected', 'rejected'])
  expect(first.stdout).not.toHaveBeenCalled()
  expect(second.stdout).not.toHaveBeenCalled()
})

it('does not turn a termination failure into a proven empty result', async () => {
  const handle = controlledHandle(), { channel } = fixture([handle])
  handle.finish()
  await channel.run('/captured/ffmpeg', [])
  handle.terminate.mockImplementation(() => { throw new Error('termination observation failed') })
  await expect(channel.stopAndJoin()).resolves.toMatchObject({ kind: 'unknown' })
  expect(handle.waitForExit).toHaveBeenCalledOnce()
})

it('fences a synchronous spawn failure whose managed handle was never returned', async () => {
  const failure = new Error('spawn failed before handle publication')
  const { channel, runtime } = fixture([], () => { throw failure })
  await expect(channel.run('/captured/ffmpeg', [])).rejects.toBe(failure)
  await expect(channel.run('/captured/ffprobe', [])).rejects.toThrow('media channel is closed')
  expect(runtime.calls).toHaveLength(1)
  await expect(channel.stopAndJoin()).resolves.toMatchObject({ kind: 'unknown' })
})

it.each(['stdout-lossy', 'stderr-lossy', 'missing-stdout', 'missing-stderr'] as const)(
  'refuses incomplete %s without discarding the completed range observation', async (output) => {
    const handle = controlledHandle({ output }), { channel } = fixture([handle])
    handle.finish()
    await expect(channel.run('/captured/ffprobe', [])).rejects.toThrow('complete media output exceeded')
    expect(handle.waitForExit.mock.calls).toEqual([[]])
    await expect(channel.stopAndJoin()).resolves.toEqual({ kind: 'empty', commands: 1 })
  })
