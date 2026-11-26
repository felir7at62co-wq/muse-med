/** Cooperative case cancellation and joined resource cleanup for real shell fixtures. */
import { setTimeout as delay } from 'node:timers/promises'
import type { TestContext } from 'vitest'
import { COVERAGE_TEST_TIMEOUT_ENV, parseCoverageTestTimeout } from '../../../../scripts/coverage-partitions.ts'

/** Polling defaults match this owner's Vitest configuration. */
export interface ShellActivityPolling {
  readonly timeout: number
  readonly interval: number
}

/**
 * Resolve the configured poll deadline independently of the enclosing case deadline.
 * @param raw - CI lane budget, absent for Vitest's local poll default.
 * @returns The original polling timeout and interval.
 */
export function shellActivityPolling(raw = process.env[COVERAGE_TEST_TIMEOUT_ENV]): ShellActivityPolling {
  return { timeout: parseCoverageTestTimeout(raw) ?? 1_000, interval: 50 }
}

/** Operations owned by one test body until its completion is joined. */
export interface ShellActivityScope {
  readonly signal: AbortSignal
  /** @param cleanup - Resource disposer, registered before later cancellation checks. */
  defer(cleanup: () => void | Promise<void>): void
  /** @param capture - Synchronous observations frozen after the body settles and before disposal. */
  beforeCleanup(capture: () => void): void
  /**
   * @param operation - Awaited acquisition, including one that finishes after cancellation.
   * @param dispose - Disposer registered as soon as acquisition returns.
   * @returns The acquired resource while the case remains active.
   */
  acquire<T>(operation: () => Promise<T>, dispose: (resource: T) => void | Promise<void>): Promise<T>
  /**
   * @param operation - Awaited operation guarded before invocation and after completion.
   * @returns Its value while the case remains active.
   */
  run<T>(operation: () => T | Promise<T>): Promise<T>
  /**
   * @param assertion - Original matcher retried until it succeeds, expires or is cancelled.
   * @returns After an assertion succeeds within the poll deadline.
   */
  poll(assertion: () => void | Promise<void>): Promise<void>
}

/** One execution and its idempotent joined teardown. */
export interface ShellActivityLifecycle extends ShellActivityScope {
  /**
   * @param body - Case body, executed once with this resource owner.
   * @returns After the body settles, including its cancellation failure.
   */
  execute(body: (scope: ShellActivityScope) => Promise<void>): Promise<void>
  /** @returns Once the body, observations and every disposer have settled. */
  finish(): Promise<void>
}

/**
 * Own a case's cooperative operations and resources through cancellation and disposal.
 * @param signal - Enclosing test's cancellation signal.
 * @param polling - Owner's configured poll limits.
 * @returns A lifecycle whose finish joins the body before draining resources in reverse order.
 */
export function createShellActivityCase(signal: AbortSignal, polling = shellActivityPolling()): ShellActivityLifecycle {
  const controller = new AbortController()
  const cleanups: Array<() => void | Promise<void>> = []
  const captures: Array<() => void> = []
  const abort = (): void => { controller.abort(signal.reason) }
  if (signal.aborted) abort()
  else signal.addEventListener('abort', abort, { once: true })
  let execution: Promise<void> | undefined
  let finishing: Promise<void> | undefined
  const check = (): void => { controller.signal.throwIfAborted() }
  const scope: ShellActivityLifecycle = {
    signal: controller.signal,
    defer: (cleanup) => { cleanups.push(cleanup) },
    beforeCleanup: (capture) => { captures.push(capture) },
    async acquire(operation, dispose) {
      check()
      const resource = await operation()
      cleanups.push(() => dispose(resource))
      check()
      return resource
    },
    async run(operation) {
      check()
      const value = await operation()
      check()
      return value
    },
    async poll(assertion) {
      const deadline = performance.now() + polling.timeout
      for (;;) {
        check()
        try {
          await assertion()
          check()
          return
        } catch (error) {
          check()
          const remaining = deadline - performance.now()
          if (remaining <= 0) throw error
          try { await delay(Math.min(polling.interval, remaining), undefined, { signal: controller.signal }) }
          catch (error) { check(); throw error }
        }
      }
    },
    execute(body) {
      if (execution !== undefined) throw new Error('Shell activity case already has a body')
      execution = (async () => { check(); await body(scope); check() })()
      return execution
    },
    finish() {
      return finishing ??= (async () => {
        controller.abort(new Error('Shell activity case finished'))
        try {
          // The returned execution reports body failures; teardown joins without duplicating them.
          await execution?.then(() => {}, () => {})
          const failures: unknown[] = []
          for (const capture of captures.splice(0)) {
            try { capture() } catch (error) { failures.push(error) }
          }
          while (cleanups.length > 0) {
            const cleanup = cleanups.pop()!
            try { await cleanup() } catch (error) { failures.push(error) }
          }
          if (failures.length > 0) throw new AggregateError(failures, 'Shell activity cleanup failed')
        } finally { signal.removeEventListener('abort', abort) }
      })()
    },
  }
  return scope
}

/**
 * Run one Vitest body with cancellation and cleanup that also join after an outer deadline.
 * @param test - Owning test's signal and completion hook.
 * @param body - Fixture operations and assertions.
 * @returns After the body settles; Vitest awaits disposal under its separate completion-hook deadline.
 */
export async function runShellActivityCase(
  test: Pick<TestContext, 'signal' | 'onTestFinished'>,
  body: (scope: ShellActivityScope) => Promise<void>,
): Promise<void> {
  const lifecycle = createShellActivityCase(test.signal)
  test.onTestFinished(() => lifecycle.finish())
  await lifecycle.execute(body)
}
