/** Instance-owned admission and serial execution without a production worker registration. */
import type { EpisodeAttemptId, ExecutionIdentity } from './episode-delivery.ts'

/** An admitted execution remains owned after its short caller request returns. */
export interface EpisodeExecutionHandle<Result> {
  readonly identity: ExecutionIdentity
  readonly done: Promise<Result>
}

interface Entry<Result> {
  readonly identity: ExecutionIdentity
  readonly admission: Promise<EpisodeExecutionHandle<Result>>
  readonly settled: Promise<PromiseSettledResult<Result>>
  pending: boolean
}

function same(left: ExecutionIdentity, right: ExecutionIdentity): boolean {
  return left.attempt === right.attempt && left.execution === right.execution
    && left.planSha256 === right.planSha256 && left.projectSha256 === right.projectSha256
    && left.rendererGeneration === right.rendererGeneration && left.configurationSha256 === right.configurationSha256
    && left.descriptorSha256 === right.descriptorSha256
}

/** Own admission, queued calls and cancellation until every admitted task settles. */
export class EpisodeExecutionOwner<Result> {
  private readonly lifetime = new AbortController()
  private readonly entries = new Map<EpisodeAttemptId, Entry<Result>>()
  private readonly history = new Map<string, Entry<Result>>()
  private tail: Promise<void> = Promise.resolve()
  private closing = false
  private disposal: Promise<readonly PromiseSettledResult<Result>[]> | undefined

  /**
   * Persist exact admission before queueing; repeated identical calls share one task.
   * @param input - Captured identity, durable admission and owned execution callbacks.
   * @returns A short admission result with a separately owned completion promise.
   */
  admit(input: {
    readonly identity: ExecutionIdentity
    readonly signal?: AbortSignal
    /** Success means the exact immutable attempt/execution is durably admitted. */
    readonly prepare: (signal: AbortSignal) => Promise<void>
    /** Must join all owned work before settling, including cancellation/error paths. */
    readonly execute: (signal: AbortSignal) => Promise<Result>
  }): Promise<EpisodeExecutionHandle<Result>> {
    if (this.closing) return Promise.reject(new Error('Episode execution owner is closing'))
    if (input.signal?.aborted) {
      const reason: unknown = input.signal.reason
      return Promise.reject(reason instanceof Error ? reason : new Error('Episode admission caller is aborted', { cause: reason }))
    }
    const identity = { ...input.identity }, prepare = input.prepare, execute = input.execute
    const key = identity.attempt + ':' + identity.execution
    const previous = this.history.get(key)
    if (previous !== undefined) {
      return same(previous.identity, identity) ? previous.admission
        : Promise.reject(new Error('Episode execution identity conflicts with admitted work'))
    }
    if (this.entries.get(identity.attempt)?.pending) {
      return Promise.reject(new Error('Episode attempt already has an admitted operation'))
    }
    const signal = input.signal === undefined ? this.lifetime.signal
      : AbortSignal.any([this.lifetime.signal, input.signal])
    let settle!: (result: PromiseSettledResult<Result>) => void
    const settled = new Promise<PromiseSettledResult<Result>>((resolve) => { settle = resolve })
    const admission = Promise.resolve().then(async () => {
      signal.throwIfAborted()
      await prepare(signal)
      // Durable admission survives a disconnected caller; provider disposal still cancels work.
      const done = this.tail.then(async () => {
        this.lifetime.signal.throwIfAborted()
        return execute(this.lifetime.signal)
      })
      this.tail = done.then(() => {}, () => {})
      void done.then((value) => { entry.pending = false; settle({ status: 'fulfilled', value }) }, (reason: unknown) => {
        entry.pending = false; settle({ status: 'rejected', reason })
      })
      return { identity, done }
    })
    const entry: Entry<Result> = { identity, admission, settled, pending: true }
    this.entries.set(identity.attempt, entry); this.history.set(key, entry)
    void admission.catch((reason: unknown) => {
      entry.pending = false; this.history.delete(key)
      this.entries.delete(identity.attempt)
      settle({ status: 'rejected', reason })
    })
    return admission
  }

  /**
   * Synchronously stop admission, cancel queued/running work and join every task.
   * Rejected or unknown renderer outcomes are observations, never proof of media drain.
   * @returns Each owned task's settlement; the consumer must inspect its durable guardian outcome.
   */
  dispose(): Promise<readonly PromiseSettledResult<Result>[]> {
    if (this.disposal === undefined) {
      this.closing = true; this.lifetime.abort(new Error('Episode execution owner disposed'))
      this.disposal = Promise.all([...this.history.values()].map(entry => entry.settled))
    }
    return this.disposal
  }
}
