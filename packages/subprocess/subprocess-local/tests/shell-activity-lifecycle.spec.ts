/** Resource and command observations pin cancellation independently of a real POSIX host. */
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { createShellActivityCase, runShellActivityCase, shellActivityPolling } from './shell-activity-lifecycle.ts'

it('keeps the local poll default separate from the CI lane budget', () => {
  expect(shellActivityPolling('')).toEqual({ timeout: 1_000, interval: 50 })
  expect(shellActivityPolling('90000')).toEqual({ timeout: 90_000, interval: 50 })
})

it('accepts a successful assertion that completes after the polling deadline', async () => {
  let now = 0
  const clock = vi.spyOn(performance, 'now').mockImplementation(() => now)
  const lifecycle = createShellActivityCase(new AbortController().signal, shellActivityPolling(''))
  try {
    await expect(lifecycle.execute(async (scope) => {
      await scope.poll(() => { now = 1_001 })
    })).resolves.toBeUndefined()
  } finally {
    clock.mockRestore()
    await lifecycle.finish()
  }
})

it('disposes normal cases in the completion hook after their body returns', async (test) => {
  const events: string[] = []
  // Completion hooks run in reverse registration order.
  test.onTestFinished(() => { expect(events).toEqual(['body', 'cleanup']) })
  await runShellActivityCase(test, async (scope) => {
    scope.defer(() => { events.push('cleanup') })
    events.push('body')
  })
  expect(events).toEqual(['body'])
})

it('cancels a pending poll without executing its following command', async () => {
  const controller = new AbortController()
  const lifecycle = createShellActivityCase(controller.signal, shellActivityPolling(''))
  const sampled = Promise.withResolvers<undefined>()
  const reason = new Error('case deadline')
  const commands: string[] = []
  const execution = lifecycle.execute(async (scope) => {
    await scope.poll(() => { sampled.resolve(undefined); expect('busy').toBe('idle') })
    await scope.run(() => { commands.push('next command') })
  })
  const result = execution.catch((error: unknown) => error)
  try {
    await sampled.promise
    controller.abort(reason)
    expect(lifecycle.signal.aborted).toBe(true)
    expect(await result).toBe(reason)
    expect(commands).toEqual([])
  } finally { await lifecycle.finish() }
})

it('joins the body before cleanup and removes a real directory acquired after cancellation', async () => {
  const controller = new AbortController()
  const lifecycle = createShellActivityCase(controller.signal)
  const created = Promise.withResolvers<string>()
  // The later await preserves the acquisition error; this observer prevents an unhandled rejection.
  void created.promise.catch(() => undefined)
  const release = Promise.withResolvers<undefined>()
  const events: string[] = []
  let directory: string | undefined
  const execution = lifecycle.execute(async (scope) => {
    scope.defer(() => { events.push('cleanup owner') })
    try {
      await scope.acquire(async () => {
        try {
          directory = await mkdtemp(join(tmpdir(), 'dsh-shell-lifecycle-'))
          events.push('directory created')
          created.resolve(directory)
          await release.promise
          return directory
        } catch (error) {
          created.reject(error)
          throw error
        }
      }, async (path) => { events.push('cleanup directory'); await rm(path, { recursive: true, force: true }) })
      events.push('command after acquisition')
    } finally { events.push('body settled') }
  })
  const result = execution.catch((error: unknown) => error)
  let finishing: Promise<void> | undefined
  try {
    const path = await created.promise
    expect(existsSync(path)).toBe(true)
    finishing = lifecycle.finish()
    expect(events).toEqual(['directory created'])
    release.resolve(undefined)
    await result
    await finishing
    expect(events).toEqual(['directory created', 'body settled', 'cleanup directory', 'cleanup owner'])
    expect(existsSync(path)).toBe(false)
  } finally {
    release.resolve(undefined)
    await result
    await (finishing ?? lifecycle.finish())
    if (directory !== undefined) await rm(directory, { recursive: true, force: true })
  }
})

it('freezes observations before disposal and drains every disposer after one fails', async () => {
  const lifecycle = createShellActivityCase(new AbortController().signal)
  const events: string[] = []
  const failure = new Error('disposer failed')
  await lifecycle.execute(async (scope) => {
    scope.beforeCleanup(() => { events.push('freeze') })
    scope.defer(() => { events.push('first disposer') })
    scope.defer(() => { events.push('second disposer'); throw failure })
  })
  await expect(lifecycle.finish()).rejects.toMatchObject({ errors: [failure] })
  expect(events).toEqual(['freeze', 'second disposer', 'first disposer'])
})
