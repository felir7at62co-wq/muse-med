/** Immutable episode admission identities and strict shared execution records. */
import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { z } from 'zod'
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'
import type { VideoArtifactSha256, VideoRecoveryDigest } from './types.ts'

/** Logical episode delivery attempt retained across physical executions. */
export type EpisodeAttemptId = Branded<'EpisodeAttemptId'>
/** One physical renderer execution; an armed value cannot be reused. */
export type EpisodeExecutionId = Branded<'EpisodeExecutionId'>
/** Captured renderer provider generation. */
export type EpisodeRendererGeneration = Branded<'EpisodeRendererGeneration'>
/** Exact artifact hash, shared with original-video approval. */
export type Sha256 = VideoArtifactSha256

/** Immutable admission facts shared by every execution of one attempt. */
export interface AttemptIdentity {
  readonly attempt: EpisodeAttemptId
  readonly planSha256: Sha256
  readonly projectSha256: Sha256
  readonly rendererGeneration: EpisodeRendererGeneration
  readonly configurationSha256: Sha256
}

/** Descriptor identity for one physical execution. */
export interface ExecutionIdentity extends AttemptIdentity {
  readonly execution: EpisodeExecutionId
  readonly descriptorSha256: Sha256
}

/** Guardian record written only after the job arms its execution reference. */
export interface RunningExecution {
  readonly version: 1
  readonly kind: 'running'
  readonly identity: ExecutionIdentity
  readonly guardianPid: number
}

/** Actual candidate bytes after renderer media validation. */
export interface CandidateEvidence {
  readonly outputSha256: Sha256
  readonly outputBytes: number
}

/** Media outcome with an independently observed empty managed process range. */
export type ExecutionDrain = {
  readonly version: 1
  readonly kind: 'drained'
  readonly identity: ExecutionIdentity
  readonly guardianPid: number
  readonly commands: number
} & ({ readonly result: 'completed'; readonly candidate: CandidateEvidence }
  | { readonly result: 'cancelled' | 'failed' })

/** Original approved source facts; admission does not manufacture human decisions. */
export interface EpisodeApprovedSource {
  readonly idempotencyKey: string
  readonly digest: VideoRecoveryDigest
  readonly sha256: VideoArtifactSha256
}

const attempt = z.uuid().transform(value => brandString<EpisodeAttemptId>(value))
const execution = z.uuid().transform(value => brandString<EpisodeExecutionId>(value))
const generation = z.uuid().transform(value => brandString<EpisodeRendererGeneration>(value))
/** Strict lowercase artifact digest parser for durable and worker records. */
export const episodeHashSchema = z.string().regex(/^[a-f0-9]{64}$/u)
  .transform(value => brandString<Sha256>(value))
/** Logical attempt parser; extra fields are not ignored. */
export const attemptIdentitySchema = z.strictObject({ attempt, planSha256: episodeHashSchema,
  projectSha256: episodeHashSchema, rendererGeneration: generation, configurationSha256: episodeHashSchema })
/** Full physical execution parser. */
export const executionIdentitySchema = attemptIdentitySchema.extend({ execution, descriptorSha256: episodeHashSchema })
/** Running records never imply that a disappeared guardian stopped its media. */
export const runningExecutionSchema = z.strictObject({ version: z.literal(1), kind: z.literal('running'),
  identity: executionIdentitySchema, guardianPid: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) })
const drainBase = { version: z.literal(1), kind: z.literal('drained'), identity: executionIdentitySchema,
  guardianPid: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  commands: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) }
/** Strict terminal parser; cancelled/failed records cannot carry invented candidates. */
export const executionDrainSchema = z.discriminatedUnion('result', [
  z.strictObject({ ...drainBase, result: z.literal('completed'), candidate: z.strictObject({
    outputSha256: episodeHashSchema, outputBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }) }),
  z.strictObject({ ...drainBase, result: z.enum(['cancelled', 'failed']) }),
])

/**
 * Read one bounded regular journal file without treating invalid content as absent.
 * @param path - Captured local journal path.
 * @param maxBytes - Positive validated record budget.
 * @returns Parsed JSON, or undefined only when the path is absent.
 */
export async function readEpisodeRecord(path: string, maxBytes: number): Promise<unknown> {
  let before
  try { before = await lstat(path) } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
    throw error
  }
  if (!before.isFile() || before.size > maxBytes) throw new Error('Episode journal must be a bounded regular file')
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const opened = await file.stat()
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size > maxBytes) {
      throw new Error('Episode journal changed while opening')
    }
    const buffer = Buffer.alloc(maxBytes + 1)
    let count = 0
    while (count < buffer.length) {
      const read = await file.read(buffer, count, buffer.length - count, null)
      if (read.bytesRead === 0) break
      count += read.bytesRead
    }
    const after = await file.stat()
    if (count > maxBytes || count !== opened.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) {
      throw new Error('Episode journal changed or exceeded its budget')
    }
    const value: unknown = JSON.parse(buffer.subarray(0, count).toString('utf8'))
    return value
  } finally { await file.close() }
}

export { createEpisodeDeliveryJob } from './episode-delivery-job.ts'
export type { EpisodeDeliveryAdmission, EpisodeExecutionAdmission, EpisodeDeliveryJob, EpisodeDeliveryJobRecord } from './episode-delivery-job.ts'
export { EpisodeExecutionOwner } from './episode-execution.ts'
