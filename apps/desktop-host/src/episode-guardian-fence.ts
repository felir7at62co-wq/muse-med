/** guardian-owned serialization for one durable episode attempt. */
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import type { AttemptIdentity, ExecutionIdentity, RunningExecution, CandidateEvidence, ExecutionDrain, EpisodeExecutionId } from '@deepseek-ai/dsh-tool-jubian/episode-delivery'
export type { AttemptIdentity, ExecutionIdentity, RunningExecution, CandidateEvidence, ExecutionDrain, EpisodeExecutionId, EpisodeAttemptId, EpisodeRendererGeneration, Sha256 } from '@deepseek-ai/dsh-tool-jubian/episode-delivery'

/**
 * File operations belong to the episode journal owner, using its strict parsers.
 * All paths are derived from the canonical captured project + attempt, never
 * supplied by protocol messages. Missing is distinct from invalid or unreadable.
 */
export interface GuardianJournal {
  /** Fixed <attempt-root>/encoder path shared by every execution UUID. */
  readonly encoderGatePath: string
  /** Read the latest complete running record; only an absent file returns undefined.
   * @returns The durable current physical execution, if any. */
  readRunning(): Promise<RunningExecution | undefined>
  /** Read an exclusive terminal record.
   * @param execution - The captured physical UUID.
   * @returns Its strict record, or undefined only when absent. */
  readDrain(execution: EpisodeExecutionId): Promise<ExecutionDrain | undefined>
  /** Re-read the admitted job and staged input hashes under the encoder lock.
   * @param identity - Exact admitted physical execution. */
  assertAdmission(identity: ExecutionIdentity): Promise<void>
  /** Arm the job, then atomically replace the running record before media starts.
   * @param record - Current guardian identity and PID. */
  writeRunning(record: RunningExecution): Promise<void>
  /** Publish exclusively; never replace different terminal facts.
   * @param record - Outcome after every managed media range became empty. */
  publishDrain(record: ExecutionDrain): Promise<void>
}

/** A failed observation keeps the running record; it never means zero media. */
export type JoinedMedia = { readonly kind: 'empty'; readonly commands: number }
  | { readonly kind: 'unknown'; readonly diagnostic: string }

export interface GuardianMedia {
  /** Stop admission, request termination and await every handle.
   * @returns Empty only after independent completion and range observations. */
  stopAndJoin(): Promise<JoinedMedia>
}

export type GuardianResult =
  | { readonly kind: 'drained'; readonly proof: ExecutionDrain }
  | { readonly kind: 'reconcile'; readonly proof: ExecutionDrain }
  | { readonly kind: 'retry-required'; readonly proof: ExecutionDrain }
  | { readonly kind: 'unknown'; readonly previous: RunningExecution; readonly diagnostic: string }

function sameAttempt(left: AttemptIdentity, right: AttemptIdentity): boolean {
  return left.attempt === right.attempt && left.planSha256 === right.planSha256
    && left.projectSha256 === right.projectSha256
    && left.rendererGeneration === right.rendererGeneration
    && left.configurationSha256 === right.configurationSha256
}

function sameExecution(left: ExecutionIdentity, right: ExecutionIdentity): boolean {
  return sameAttempt(left, right) && left.execution === right.execution
    && left.descriptorSha256 === right.descriptorSha256
}

/**
 * Run only while this guardian owns the attempt's cross-process encoder lock.
 * A dead guardian PID permits atomic-write lock takeover, not media retry.
 * @param input - Validated journal, immutable identity, lifetime and render call.
 * @returns A durable drain, a reconciliation request, or an unknown fence.
 */
export async function runWithEncoderGate(input: {
  readonly journal: GuardianJournal
  readonly identity: ExecutionIdentity
  readonly signal: AbortSignal
  readonly lockWaitMs: number
  /** Validated durable retry policy, not a boolean accepted from the renderer UI. */
  readonly retry: 'initial' | 'host-disconnect-recovery' | 'explicit-retry'
  readonly media: GuardianMedia
  /** Resolves only after the existing renderer's candidate checks passed. */
  readonly render: () => Promise<CandidateEvidence>
}): Promise<GuardianResult> {
  return await withFileLock(input.journal.encoderGatePath, async () => {
    input.signal.throwIfAborted()
    const previous = await input.journal.readRunning()
    if (previous !== undefined) {
      if (!sameAttempt(previous.identity, input.identity)) {
        throw new Error('episode guardian: attempt journal identity changed')
      }
      const proof = await input.journal.readDrain(previous.identity.execution)
      if (proof === undefined) {
        return { kind: 'unknown', previous, diagnostic: 'previous execution has no matching drain proof' }
      }
      if (!sameExecution(proof.identity, previous.identity) || proof.guardianPid !== previous.guardianPid) {
        throw new Error('episode guardian: drain proof does not match the running execution')
      }
      if (proof.result === 'completed') return { kind: 'reconcile', proof }
      const mayRetry = input.retry === 'explicit-retry'
        || (input.retry === 'host-disconnect-recovery' && proof.result === 'cancelled')
      if (!mayRetry) return { kind: 'retry-required', proof }
      if (previous.identity.execution === input.identity.execution) {
        throw new Error('episode guardian: physical execution UUID cannot be reused')
      }
    }
    if (await input.journal.readDrain(input.identity.execution) !== undefined) {
      throw new Error('episode guardian: execution UUID already has a drain record')
    }
    await input.journal.assertAdmission(input.identity)
    input.signal.throwIfAborted()
    const running: RunningExecution = {
      version: 1, kind: 'running', identity: input.identity, guardianPid: process.pid,
    }
    await input.journal.writeRunning(running)
    // A Host EOF during the journal write is cancellation before the first spawn.
    let terminal: { readonly result: 'completed'; readonly candidate: CandidateEvidence }
      | { readonly result: 'cancelled' | 'failed' } = { result: 'failed' }
    try {
      input.signal.throwIfAborted()
      const candidate = await input.render()
      input.signal.throwIfAborted()
      terminal = { result: 'completed', candidate }
    } catch (_renderFailedOrCancelled) {
      terminal = { result: input.signal.aborted ? 'cancelled' : 'failed' }
    }
    const joined = await input.media.stopAndJoin()
    if (joined.kind === 'unknown') {
      return { kind: 'unknown', previous: running, diagnostic: joined.diagnostic }
    }
    const proof: ExecutionDrain = {
      version: 1, kind: 'drained', identity: input.identity, guardianPid: process.pid,
      commands: joined.commands, ...terminal,
    }
    await input.journal.publishDrain(proof)
    return { kind: 'drained', proof }
  }, { signal: input.signal, waitMs: input.lockWaitMs })
}
