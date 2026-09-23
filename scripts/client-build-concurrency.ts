/** Optional process-local bound for the native Client workspace build. */
import type { TsdownHooks } from 'tsdown'

/**
 * Bound native bundles without changing tsdown's workspace or configuration selection.
 * @param value - Unset for native defaults, otherwise a positive integer concurrency.
 * @returns Root hooks; package-local prepare/before hooks must compose these in bounded mode.
 */
export function clientBuildConcurrency(value: string | undefined): Partial<TsdownHooks> | undefined {
  if (value === undefined) return undefined
  const limit = Number(value)
  if (!/^[1-9]\d*$/u.test(value) || !Number.isSafeInteger(limit)) {
    throw new Error('DSH_BUILD_CLIENT_CONCURRENCY must be a positive safe integer')
  }
  let active = 0, selected = 0, completed = 0
  let failure: Error | undefined
  const waiting: Array<{ resolve: () => void; reject: (error: Error) => void }> = []
  const fail = (error: Error): void => {
    failure ??= error
    for (const waiter of waiting.splice(0)) waiter.reject(failure)
  }
  return {
    async 'build:prepare'({ options }) {
      if (options.watch) throw new Error('Bounded Client builds do not support watch mode')
      selected++
      if (failure !== undefined) throw failure
      if (active >= limit) await new Promise<void>((resolve, reject) => { waiting.push({ resolve, reject }) })
      else active++
    },
    'build:before'({ buildOptions }) {
      let closed = false
      buildOptions.plugins = [buildOptions.plugins, {
        name: 'dsh-client-build-concurrency',
        buildEnd(error) { if (error) fail(error) },
        renderError(error) { fail(error) },
        closeBundle: {
          order: 'post', sequential: true,
          handler() {
            if (closed) return
            closed = true
            // tsdown's build:done waits for all same-package faces; release before that barrier.
            const next = waiting.shift()
            if (next) next.resolve()
            else active--
            completed++
            if (failure === undefined && completed === selected) console.log(`client build: bundled ${completed}/${selected} native configs (concurrency ${limit})`)
          },
        },
      }]
    },
  }
}
