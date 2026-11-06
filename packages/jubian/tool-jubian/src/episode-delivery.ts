/** Immutable episode admission identities and strict shared execution records. */
import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import type {} from '@deepseek-ai/cordis'
import type { VideoArtifactSha256, VideoRecoveryDigest, EpisodeAttemptId, EpisodeExecutionId, EpisodeRendererGeneration } from './types.ts'
import type { EpisodeDeliveryJob } from './episode-delivery-job.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Actual captured episode renderer; replacement retires its existing captures. */
    approvedEpisodeRenderer: ApprovedEpisodeRenderer
  }
}

export type { EpisodeAttemptId, EpisodeExecutionId, EpisodeRendererGeneration, EpisodeCancellationReason } from './types.ts'
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

/** Captured editable input; every hash is measured before renderer capture. */
export interface ApprovedEpisodeInputFile {
  readonly role: 'project' | 'plan' | 'timeline' | 'subtitle' | 'mix-profile' | 'bgm'
  readonly path: string
  readonly sha256: Sha256
  readonly bytes: number
}

/** Exact approved-plan input to the existing renderer owner. */
export interface ApprovedEpisodeCaptureInput {
  readonly projectDir: string
  readonly episode: number
  readonly planPath: string
  readonly timelinePath: string
  readonly subtitlePath: string
  readonly mixProfilePath: string
  readonly bgmPath?: string
  readonly inputHashes: readonly ApprovedEpisodeInputFile[]
  /** Editing-plan/input digest measured before renderer capture; excludes renderer identity. */
  readonly digest: Sha256
}

/** Renderer instance and immutable resolved configuration/code identity. */
export interface ApprovedEpisodeRendererIdentity {
  readonly generation: EpisodeRendererGeneration
  readonly configurationSha256: Sha256
  readonly codeSha256: Sha256
}

/** Actual renderer, media binary or selected font file retained by its owner. */
export interface ApprovedEpisodeRuntimeInput {
  readonly path: string
  readonly sha256: Sha256
  readonly bytes: number
  readonly owner: 'renderer' | 'media' | 'font'
}

/** Staged immutable approved source selected for one measured timeline shot. */
export interface ApprovedEpisodeRenderSource extends EpisodeApprovedSource {
  readonly shot: number
  readonly path: string
  readonly bytes: number
}

/** Physical work whose exact descriptor hash is produced by the renderer owner. */
export interface ApprovedEpisodeRenderInput {
  readonly identity: AttemptIdentity
  readonly execution: EpisodeExecutionId
  /** Durable coordinator policy; cancelled proof alone never authorizes recovery. */
  readonly retry: 'initial' | 'host-disconnect-recovery' | 'explicit-retry'
  readonly job: EpisodeDeliveryJob
  readonly stageRoot: string
  readonly sources: readonly ApprovedEpisodeRenderSource[]
}

/** Actual full-decode media measurements and current private candidate bytes. */
export interface ApprovedEpisodeCandidate {
  readonly path: string
  readonly sha256: Sha256
  readonly bytes: number
  readonly width: number
  readonly height: number
  readonly durationUs: number
  readonly video: true
  readonly audio: true
}

/** Same B1 terminal vocabulary; unknown never becomes an ordinary failed attempt. */
export type EpisodeRenderResult =
  | ({ readonly kind: 'drained' | 'reconcile' } & (
    { readonly proof: Extract<ExecutionDrain, { result: 'completed' }>; readonly candidate: ApprovedEpisodeCandidate }
    | { readonly proof: Exclude<ExecutionDrain, { result: 'completed' }>; readonly candidate?: never }))
  | { readonly kind: 'retry-required'; readonly proof: ExecutionDrain }
  | { readonly kind: 'unknown'; readonly previous: RunningExecution; readonly diagnostic: string }

/** Same-process capture bound to the actual provider instance, never serialized into a worker. */
export interface ApprovedEpisodeRendererCapture {
  readonly identity: ApprovedEpisodeRendererIdentity
  readonly runtimeInputs: readonly ApprovedEpisodeRuntimeInput[]
  /** Provider retirement notifies the coordinator; it must journal cancellation before aborting admitted render work. */
  readonly signal: AbortSignal
  /**
   * Stage renderer inputs, publish the exact descriptor admission, then execute the owned guardian.
   * @param input - Logical attempt, fresh physical UUID, real job callbacks and exact staged sources.
   * @param signal - Source-owner cancellation after its durable intent; provider retirement must not bypass this signal.
   * @returns Verified candidate plus drain, reconciliation, retry refusal or an unknown fence.
   */
  render(input: ApprovedEpisodeRenderInput, signal: AbortSignal): Promise<EpisodeRenderResult>
}

/** Renderer Definition; the Host supplies the provider and the episode service consumes it. */
export interface ApprovedEpisodeRenderer {
  /**
   * Capture actual resolved settings, selected media/fonts and code without reading later mutable Settings.
   * @param input - Canonical project and strict current editing-plan snapshot.
   * @param signal - Capture cancellation; an admitted capture also retains its provider lifetime.
   * @returns An immutable identity and render closure belonging to this actual provider instance.
   */
  capture(input: ApprovedEpisodeCaptureInput, signal: AbortSignal): Promise<ApprovedEpisodeRendererCapture>
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
 * Read exact bounded regular bytes without treating invalid files as absent.
 * @param path - Captured local journal path.
 * @param maxBytes - Positive validated record budget.
 * @param signal - Operation cancellation; cleanup still closes the descriptor.
 * @returns Exact bytes, or undefined only when the path is absent.
 */
export async function readEpisodeBytes(path: string, maxBytes: number, signal?: AbortSignal): Promise<Buffer | undefined> {
  signal?.throwIfAborted()
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
      signal?.throwIfAborted()
      const read = await file.read(buffer, count, buffer.length - count, null)
      if (read.bytesRead === 0) break
      count += read.bytesRead
    }
    const after = await file.stat()
    if (count > maxBytes || count !== opened.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) {
      throw new Error('Episode journal changed or exceeded its budget')
    }
    signal?.throwIfAborted()
    return buffer.subarray(0, count)
  } finally { await file.close() }
}

/** Stable local file identity measured while streaming every byte without a provider download limit. */
export interface EpisodeFileVersion {
  readonly path: string
  readonly sha256: Sha256
  readonly bytes: number
  readonly dev: number
  readonly ino: number
  readonly mtimeMs: number
  readonly ctimeMs: number
}

/**
 * Hash a local regular file through one descriptor and reject concurrent replacement or mutation.
 * @param path - Canonical local file owned by the caller.
 * @param signal - Hash cancellation; the descriptor is always closed.
 * @returns Exact SHA, byte count and current file version, without the provider download ceiling.
 */
export async function hashEpisodeFile(path: string, signal: AbortSignal): Promise<EpisodeFileVersion> {
  signal.throwIfAborted()
  const before = await lstat(path)
  if (!before.isFile()) throw new Error('Episode input must be a regular file')
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const opened = await file.stat()
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error('Episode input changed while opening')
    }
    const hash = createHash('sha256'), buffer = Buffer.alloc(65536)
    let bytes = 0
    while (true) {
      signal.throwIfAborted()
      const read = await file.read(buffer, 0, buffer.length, null)
      if (read.bytesRead === 0) break
      hash.update(buffer.subarray(0, read.bytesRead)); bytes += read.bytesRead
    }
    const after = await file.stat(), current = await lstat(path)
    if (!current.isFile() || current.dev !== opened.dev || current.ino !== opened.ino
      || bytes !== opened.size || after.size !== opened.size || current.size !== opened.size
      || after.mtimeMs !== opened.mtimeMs || current.mtimeMs !== opened.mtimeMs
      || after.ctimeMs !== opened.ctimeMs || current.ctimeMs !== opened.ctimeMs) {
      throw new Error('Episode input changed during hashing')
    }
    signal.throwIfAborted()
    return { path, sha256: brandString<Sha256>(hash.digest('hex')), bytes,
      dev: current.dev, ino: current.ino, mtimeMs: current.mtimeMs, ctimeMs: current.ctimeMs }
  } finally { await file.close() }
}

/**
 * Check a previously hashed file version without rereading its full content.
 * @param version - Same-process evidence captured by hashEpisodeFile.
 * @param signal - Short verification cancellation.
 */
export async function assertEpisodeFileVersion(version: EpisodeFileVersion, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  const current = await lstat(version.path)
  if (!current.isFile() || current.dev !== version.dev || current.ino !== version.ino
    || current.size !== version.bytes || current.mtimeMs !== version.mtimeMs || current.ctimeMs !== version.ctimeMs) {
    throw new Error('Episode input changed since verification')
  }
}

/**
 * Read one bounded regular JSON record; invalid content is never treated as absent.
 * @param path - Captured local journal path.
 * @param maxBytes - Positive validated record budget.
 * @returns Parsed JSON, or undefined only when the path is absent.
 */
export async function readEpisodeRecord(path: string, maxBytes: number): Promise<unknown> {
  const bytes = await readEpisodeBytes(path, maxBytes)
  if (bytes === undefined) return undefined
  const value: unknown = JSON.parse(bytes.toString('utf8'))
  return value
}

export { createEpisodeDeliveryJob, parseEpisodeDeliveryJobRecord } from './episode-delivery-job.ts'
export type { EpisodeDeliveryAdmission, EpisodeExecutionAdmission, EpisodeDeliveryJob, EpisodeDeliveryJobRecord } from './episode-delivery-job.ts'
export { EpisodeExecutionOwner } from './episode-execution.ts'
