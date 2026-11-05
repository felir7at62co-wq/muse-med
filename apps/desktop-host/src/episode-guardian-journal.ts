/** Bounded journal parsing and exclusive drain publication. */
import { link, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { executionIdentitySchema as identity, runningExecutionSchema as running, executionDrainSchema as drain, readEpisodeRecord } from '@deepseek-ai/dsh-tool-jubian/episode-delivery'
import type { EpisodeExecutionId, ExecutionIdentity, RunningExecution, ExecutionDrain, GuardianJournal } from './episode-guardian-fence.ts'
import type { GuardianParsers } from './episode-guardian-protocol.ts'

const result = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('drained'), proof: drain }),
  z.strictObject({ kind: z.literal('reconcile'), proof: drain }),
  z.strictObject({ kind: z.literal('retry-required'), proof: drain }),
  z.strictObject({ kind: z.literal('unknown'), previous: running, diagnostic: z.string() }),
])

/** Strict worker wire parsers using the shared durable identity schemas. */
export const guardianParsers: GuardianParsers = {
  parseRequest: value => z.strictObject({ version: z.literal(1), kind: z.literal('run'), identity }).parse(value),
  parseReply: (value) => {
    const reply = z.strictObject({ version: z.literal(1), kind: z.literal('result'), identity, result }).parse(value)
    const evidence = reply.result.kind === 'unknown' ? reply.result.previous : reply.result.proof
    for (const key of ['attempt', 'planSha256', 'projectSha256', 'rendererGeneration', 'configurationSha256'] as const) {
      if (evidence.identity[key] !== reply.identity[key]) throw new Error('episode guardian: reply attempt identity mismatch')
    }
    if (reply.result.kind === 'drained'
      && (evidence.identity.execution !== reply.identity.execution
        || evidence.identity.descriptorSha256 !== reply.identity.descriptorSha256)) {
      throw new Error('episode guardian: drained execution identity mismatch')
    }
    if ((reply.result.kind === 'reconcile' && reply.result.proof.result !== 'completed')
      || (reply.result.kind === 'retry-required' && reply.result.proof.result === 'completed')) {
      throw new Error('episode guardian: reply outcome does not match its result tag')
    }
    return reply
  },
}

/**
 * Build paths only from an already validated private attempt root. The two
 * callbacks belong to the durable episode job, never mutable UI state.
 * Atomic writes preserve complete files across process exit; fsync/power loss
 * durability is outside atomic-write's current promise.
 * @param input - Private attempt directory, byte budget and job callbacks.
 * @returns The encoder lock and strict running/drain journal operations.
 */
export function createGuardianJournal(input: {
  readonly attemptRoot: string
  readonly recordBytes: number
  /** Includes missing execution_ref detection when the job is already armed. */
  readonly assertAdmission: (identity: ExecutionIdentity) => Promise<void>
  /** Under the brief job lock, persist execution_ref before writing running. */
  readonly armExecution: (record: RunningExecution) => Promise<void>
}): GuardianJournal {
  const statePath = join(input.attemptRoot, 'execution.json')
  const proofPath = (id: EpisodeExecutionId): string => join(input.attemptRoot, `drained-${id}.json`)
  const encode = (record: RunningExecution | ExecutionDrain): string => {
    const bytes = JSON.stringify(record) + '\n'
    if (Buffer.byteLength(bytes) > input.recordBytes) throw new Error('episode guardian: journal record exceeds limit')
    return bytes
  }
  return {
    encoderGatePath: join(input.attemptRoot, 'encoder'),
    readRunning: async () => {
      const value = await readEpisodeRecord(statePath, input.recordBytes)
      return value === undefined ? undefined : running.parse(value)
    },
    readDrain: async (id) => {
      const value = await readEpisodeRecord(proofPath(id), input.recordBytes)
      return value === undefined ? undefined : drain.parse(value)
    },
    assertAdmission: input.assertAdmission,
    writeRunning: async (record) => {
      const parsed = running.parse(record)
      const content = encode(parsed)
      await input.armExecution(parsed)
      await writeFileAtomic(statePath, content, { mode: 0o600, dirMode: 0o700 })
    },
    publishDrain: async (record) => {
      const parsed = drain.parse(record)
      const content = encode(parsed)
      const target = proofPath(parsed.identity.execution)
      const existing = await readEpisodeRecord(target, input.recordBytes)
      if (existing !== undefined) {
        if (encode(drain.parse(existing)) !== content) {
          throw new Error('episode guardian: conflicting drain proof')
        }
        return
      }
      const prepared = join(input.attemptRoot, `drain-${parsed.identity.execution}.prepared.json`)
      await writeFileAtomic(prepared, content, { mode: 0o600, dirMode: 0o700 })
      // link is atomic and refuses an occupied target; no drain proof is overwritten.
      await link(prepared, target)
      await unlink(prepared)
    },
  }
}
