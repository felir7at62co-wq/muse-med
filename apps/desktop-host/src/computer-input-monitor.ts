/** Worker lifecycle and content-free snapshots for local user activity. */
import { Worker } from 'node:worker_threads'

/** Physical activity counters; no key values, pointer positions or text are exposed. */
export interface PhysicalInputSnapshot {
  available: boolean
  epoch: number
  escapeEpoch: number
  idleMs: number
}

/** Live observation owned by the computer-use plugin. */
export interface PhysicalInputMonitor {
  sample(): PhysicalInputSnapshot
  subscribe(listener: () => void): () => void
  close(): Promise<void>
}

/** Start the bundled Windows observer; failed or stale observation refuses computer input.
 * @returns A monitor whose close waits for its worker to exit.
 */
export function createPhysicalInputMonitor(): PhysicalInputMonitor {
  const memory = new SharedArrayBuffer(20)
  const state = new Int32Array(memory)
  const listeners = new Set<() => void>()
  const worker = new Worker(new URL('./computer-input-worker.js', import.meta.url), { workerData: memory })
  let closed = false
  let failed = false
  const notify = (): void => {
    for (const listener of listeners) {
      try { listener() } catch (error) { console.warn('Computer input observer callback failed', error) }
    }
  }
  worker.on('message', (message: unknown) => {
    if (message === 'physical-input' || message === 'ready') notify()
  })
  worker.on('error', (_error) => { failed = true; notify() })
  const exited = new Promise<void>((resolve) => {
    worker.once('exit', () => { failed = true; notify(); resolve() })
  })
  let closing: Promise<void> | undefined
  const age = (at: number): number => ((Date.now() & 0x7fffffff) - at) & 0x7fffffff
  return {
    sample: () => ({
      available: !closed && !failed && Atomics.load(state, 1) === 1 && age(Atomics.load(state, 3)) < 1_000,
      epoch: Atomics.load(state, 0),
      escapeEpoch: Atomics.load(state, 4),
      idleMs: age(Atomics.load(state, 2)),
    }),
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    close() {
      return closing ??= (async () => {
        closed = true
        listeners.clear()
        worker.postMessage('stop')
        const timer = setTimeout(() => { void worker.terminate() }, 1_000)
        try { await exited } finally { clearTimeout(timer) }
      })()
    },
  }
}
