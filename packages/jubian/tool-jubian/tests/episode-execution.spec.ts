/** Admission and disposal use deterministic barriers, without process-global state. */
import { randomUUID } from 'node:crypto'
import { expect, it, onTestFinished } from 'vitest'
import { EpisodeExecutionOwner, executionIdentitySchema } from '../src/episode-delivery.ts'

function barrier() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => { release = resolve })
  return { promise, release }
}

function identity() {
  return executionIdentitySchema.parse({ attempt: randomUUID(), execution: randomUUID(), rendererGeneration: randomUUID(),
    planSha256: '1'.repeat(64), projectSha256: '2'.repeat(64), configurationSha256: '3'.repeat(64), descriptorSha256: '4'.repeat(64) })
}

it('deduplicates exact admission while preserving original execution facts', async () => {
  const owner = new EpisodeExecutionOwner<number>(), hold = barrier(), entered = barrier(), value = identity()
  onTestFinished(async () => { hold.release(); await owner.dispose() })
  let prepared = 0, executed = 0
  const input = { identity: value, prepare: async () => { prepared++; entered.release(); await hold.promise },
    execute: async () => { executed++; return 7 } }
  const first = owner.admit(input), duplicate = owner.admit(input)
  expect(duplicate).toBe(first); await entered.promise
  expect(prepared).toBe(1); expect(executed).toBe(0)
  await expect(owner.admit({ ...input, identity: { ...value, descriptorSha256: '5'.repeat(64) as typeof value.descriptorSha256 } }))
    .rejects.toThrow('identity conflicts')
  await expect(owner.admit({ ...input, identity: { ...value, execution: identity().execution } }))
    .rejects.toThrow('already has an admitted operation')
  hold.release(); const handle = await first
  expect(await handle.done).toBe(7); expect(executed).toBe(1)
  expect(await owner.admit(input)).toBe(handle)
  expect(executed).toBe(1)
})

it('serializes admitted executions but does not hold the next durable admission', async () => {
  const owner = new EpisodeExecutionOwner<number>(), firstRunning = barrier(), releaseFirst = barrier()
  onTestFinished(async () => { releaseFirst.release(); await owner.dispose() })
  const order: string[] = []
  const first = await owner.admit({ identity: identity(), prepare: async () => { order.push('admit1') }, execute: async () => {
    order.push('run1'); firstRunning.release(); await releaseFirst.promise; return 1
  } })
  await firstRunning.promise
  const second = await owner.admit({ identity: identity(), prepare: async () => { order.push('admit2') },
    execute: async () => { order.push('run2'); return 2 } })
  expect(order).toEqual(['admit1', 'run1', 'admit2'])
  releaseFirst.release()
  expect(await Promise.all([first.done, second.done])).toEqual([1, 2])
  expect(order).toEqual(['admit1', 'run1', 'admit2', 'run2'])
})

it('retains provider-owned execution after the admitted caller disconnects', async () => {
  const owner = new EpisodeExecutionOwner<number>(), caller = new AbortController(), hold = barrier()
  onTestFinished(async () => { hold.release(); await owner.dispose() })
  let executionSignal: AbortSignal | undefined
  const handle = await owner.admit({ identity: identity(), signal: caller.signal, prepare: async () => {}, execute: async (signal) => {
    executionSignal = signal; await hold.promise; signal.throwIfAborted(); return 8
  } })
  caller.abort(); hold.release()
  expect(await handle.done).toBe(8); expect(executionSignal?.aborted).toBe(false)
})

it('closes admission synchronously and waits for running cleanup while cancelling queued work', async () => {
  const owner = new EpisodeExecutionOwner<number>(), running = barrier(), cancelled = barrier(), joined = barrier()
  onTestFinished(async () => { joined.release(); await owner.dispose() })
  const first = await owner.admit({ identity: identity(), prepare: async () => {}, execute: async (signal) => {
    signal.addEventListener('abort', cancelled.release, { once: true }); running.release()
    await cancelled.promise; await joined.promise; signal.throwIfAborted(); return 1
  } })
  await running.promise
  let queuedRuns = 0
  const second = await owner.admit({ identity: identity(), prepare: async () => {}, execute: async () => { queuedRuns++; return 2 } })
  const disposal = owner.dispose()
  expect(owner.dispose()).toBe(disposal)
  await expect(owner.admit({ identity: identity(), prepare: async () => {}, execute: async () => 3 })).rejects.toThrow('closing')
  await cancelled.promise
  let disposed = false; void disposal.then(() => { disposed = true })
  expect(disposed).toBe(false); expect(queuedRuns).toBe(0)
  joined.release()
  expect((await disposal).map(result => result.status)).toEqual(['rejected', 'rejected'])
  await expect(first.done).rejects.toThrow('disposed'); await expect(second.done).rejects.toThrow('disposed')
  expect(queuedRuns).toBe(0)
})

it('joins cancelled preparation and never executes an uncommitted admission', async () => {
  const owner = new EpisodeExecutionOwner<number>(), entered = barrier(), cleanup = barrier()
  onTestFinished(async () => { cleanup.release(); await owner.dispose() })
  let executed = 0
  const pending = owner.admit({ identity: identity(), prepare: async (signal) => {
    entered.release(); await cleanup.promise; signal.throwIfAborted()
  }, execute: async () => { executed++; return 1 } })
  await entered.promise
  const rejected = expect(pending).rejects.toThrow('disposed'), disposal = owner.dispose()
  cleanup.release(); await rejected
  expect((await disposal)[0]?.status).toBe('rejected'); expect(executed).toBe(0)
})

it('permits a new admission after failed preparation and preserves settled failures', async () => {
  const owner = new EpisodeExecutionOwner<number>(), value = identity()
  onTestFinished(async () => { await owner.dispose() })
  await expect(owner.admit({ identity: value,
    prepare: async () => { throw new Error('not committed') }, execute: async () => 1 }))
    .rejects.toThrow('not committed')
  const first = await owner.admit({ identity: value, prepare: async () => {},
    execute: async () => { throw new Error('renderer failed') } })
  await expect(first.done).rejects.toThrow('renderer failed')
  const next = await owner.admit({ identity: { ...value, execution: identity().execution },
    prepare: async () => {}, execute: async () => 2 })
  expect(await next.done).toBe(2)
  expect((await owner.dispose()).map(result => result.status)).toEqual(['rejected', 'fulfilled'])
})

it('refuses already aborted callers without admitting work', async () => {
  const owner = new EpisodeExecutionOwner<number>(), caller = new AbortController(); caller.abort(new Error('caller stopped'))
  let prepared = 0
  await expect(owner.admit({ identity: identity(), signal: caller.signal, prepare: async () => { prepared++ }, execute: async () => 1 }))
    .rejects.toThrow('caller stopped')
  expect(prepared).toBe(0); expect(await owner.dispose()).toEqual([])
})

it('normalizes a non-Error AbortSignal reason without admitting work', async () => {
  const owner = new EpisodeExecutionOwner<number>(), caller = new AbortController(); caller.abort('closed')
  await expect(owner.admit({ identity: identity(), signal: caller.signal, prepare: async () => {}, execute: async () => 1 }))
    .rejects.toMatchObject({ message: 'Episode admission caller is aborted', cause: 'closed' })
  expect(await owner.dispose()).toEqual([])
})
