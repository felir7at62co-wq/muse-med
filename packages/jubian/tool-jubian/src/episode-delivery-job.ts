/** Project-owned episode admission and arm-before-running journal adapter. */
import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, realpath, mkdir, open, link, unlink, readdir } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { z } from 'zod'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { brandString } from '@deepseek-ai/dsh-brand'
import { attemptIdentitySchema, executionIdentitySchema, runningExecutionSchema,
  executionDrainSchema, episodeHashSchema, readEpisodeRecord } from './episode-delivery.ts'
import type { AttemptIdentity, ExecutionIdentity, EpisodeApprovedSource, EpisodeExecutionId,
  RunningExecution, Sha256 } from './episode-delivery.ts'
import type { VideoRecoveryDigest } from './types.ts'
import { hashEpisodeFileHandle } from './episode-file-hash.ts'

/** Actual staged inputs and the original human-approved source identities. */
export interface EpisodeDeliveryAdmission {
  readonly approvals: readonly EpisodeApprovedSource[]
  readonly inputs: readonly { readonly path: string; readonly sha256: Sha256; readonly bytes: number }[]
}

/** One captured physical descriptor and new output, with a durable retry policy. */
export interface EpisodeExecutionAdmission {
  readonly identity: ExecutionIdentity
  readonly descriptorPath: string
  readonly candidatePath: string
  readonly retry: 'initial' | 'host-disconnect-recovery' | 'explicit-retry'
}

/** Durable logical job; every armed physical UUID remains recorded. */
export interface EpisodeDeliveryJobRecord extends EpisodeDeliveryAdmission {
  readonly version: 1
  readonly kind: 'episode-delivery'
  readonly projectDir: string
  readonly identity: AttemptIdentity
  readonly executionRef: RunningExecution | null
  readonly armedExecutions: readonly EpisodeExecutionId[]
}

/** Narrow journal callbacks consumed by a guardian, without a Host dependency. */
export interface EpisodeDeliveryJob {
  readonly attemptRoot: string
  /**
   * Read the exact logical job; invalid records reject.
   * @returns The captured job, or undefined only when it has not been admitted.
   */
  read(): Promise<EpisodeDeliveryJobRecord | undefined>
  /**
   * Persist or reconcile the same immutable admission before queueing work.
   * @param input - Captured original approvals and actual staged file hashes.
   * @returns The committed job, preserving any armed execution history.
   */
  admit(input: EpisodeDeliveryAdmission): Promise<EpisodeDeliveryJobRecord>
  /**
   * Persist one execution descriptor without arming or launching media.
   * @param input - Exact descriptor, new candidate path and durable retry policy.
   * @returns The committed or identical existing physical admission.
   */
  admitExecution(input: EpisodeExecutionAdmission): Promise<EpisodeExecutionAdmission>
  /**
   * Read one previously admitted physical descriptor.
   * @param execution - Physical UUID within this captured attempt.
   * @returns The descriptor, or undefined only when it was not admitted.
   */
  readExecution(execution: EpisodeExecutionId): Promise<EpisodeExecutionAdmission | undefined>
  /**
   * Recheck durable ownership, inputs, descriptor and a still-unoccupied candidate.
   * @param identity - Exact physical execution to verify before the one-shot arm.
   */
  assertAdmission(identity: ExecutionIdentity): Promise<void>
  /**
   * Consume this owner's immediately preceding successful assertAdmission once.
   * Recheck durable ownership and file versions under the brief writer lock,
   * then commit the execution reference before the guardian writes execution.json.
   * @param record - Exact verified physical execution and guardian PID.
   */
  armExecution(record: RunningExecution): Promise<void>
}

function schemas() {
  const approval = z.strictObject({ idempotencyKey: z.string().min(1),
    digest: z.string().regex(/^[a-f0-9]{64}$/u).transform(value => brandString<VideoRecoveryDigest>(value)),
    sha256: episodeHashSchema })
  const admission = z.strictObject({ approvals: z.array(approval).min(1), inputs: z.array(z.strictObject({
    path: z.string().min(1), sha256: episodeHashSchema,
    bytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })).min(1) })
  const execution = z.strictObject({ identity: executionIdentitySchema, descriptorPath: z.string().min(1),
    candidatePath: z.string().min(1), retry: z.enum(['initial', 'host-disconnect-recovery', 'explicit-retry']) })
  const record = admission.extend({ version: z.literal(1), kind: z.literal('episode-delivery'),
    projectDir: z.string().min(1), identity: attemptIdentitySchema, executionRef: runningExecutionSchema.nullable(),
    armedExecutions: z.array(z.uuid().transform(value => brandString<EpisodeExecutionId>(value))),
  }).refine(value => new Set(value.armedExecutions).size === value.armedExecutions.length
    && (value.executionRef === null ? value.armedExecutions.length === 0
      : value.armedExecutions.at(-1) === value.executionRef.identity.execution
        && same(value.executionRef.identity, value.identity)), 'Invalid armed execution history or ownership')
  return { admission, execution, record }
}

/**
 * Parse one strict durable logical job without creating or mutating its directory.
 * @param value - Parsed bounded journal JSON.
 * @returns Validated immutable admission and armed execution history.
 */
export function parseEpisodeDeliveryJobRecord(value: unknown): EpisodeDeliveryJobRecord {
  return schemas().record.parse(value)
}

function absent(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

function same(left: AttemptIdentity, right: AttemptIdentity): boolean {
  return left.attempt === right.attempt && left.planSha256 === right.planSha256
    && left.projectSha256 === right.projectSha256 && left.rendererGeneration === right.rendererGeneration
    && left.configurationSha256 === right.configurationSha256
}

function attemptFacts(value: AttemptIdentity): AttemptIdentity {
  return { attempt: value.attempt, planSha256: value.planSha256, projectSha256: value.projectSha256,
    rendererGeneration: value.rendererGeneration, configurationSha256: value.configurationSha256 }
}

interface FileVersion {
  readonly path: string
  readonly dev: number
  readonly ino: number
  readonly size: number
  readonly mtimeMs: number
  readonly ctimeMs: number
}

async function directory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 })
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== path) {
    throw new Error('Episode job directory must be canonical and regular')
  }
}

async function hashFile(path: string, signal?: AbortSignal): Promise<{ sha256: string; bytes: number; version: FileVersion }> {
  signal?.throwIfAborted()
  const before = await lstat(path)
  if (!before.isFile()) throw new Error('Episode input must be a regular file')
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const opened = await file.stat()
    if (opened.dev !== before.dev || opened.ino !== before.ino || !opened.isFile()) {
      throw new Error('Episode input changed while opening')
    }
    const { sha256, bytes } = await hashEpisodeFileHandle(file, signal)
    const after = await file.stat(), current = await lstat(path)
    if (bytes !== opened.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs
      || !current.isFile() || current.dev !== opened.dev || current.ino !== opened.ino) {
      throw new Error('Episode input changed during hashing')
    }
    return { sha256, bytes,
      version: { path, dev: current.dev, ino: current.ino, size: current.size, mtimeMs: current.mtimeMs, ctimeMs: current.ctimeMs } }
  } finally { await file.close() }
}

/**
 * Capture one canonical project and derive all journal paths from its attempt UUID.
 * @param options - Immutable identity, record/lock limits and guardian operation signal.
 * @returns A durable admission owner whose callbacks fit the guardian journal.
 */
export async function createEpisodeDeliveryJob(options: {
  readonly projectDir: string
  readonly identity: AttemptIdentity
  readonly recordBytes: number
  readonly lockWaitMs: number
  readonly signal?: AbortSignal
}): Promise<EpisodeDeliveryJob> {
  options.signal?.throwIfAborted()
  const identity = attemptIdentitySchema.parse(attemptFacts(options.identity))
  if (!isAbsolute(options.projectDir) || !Number.isSafeInteger(options.recordBytes) || options.recordBytes < 1
    || !Number.isSafeInteger(options.lockWaitMs) || options.lockWaitMs < 1) throw new Error('Invalid episode job configuration')
  const projectInfo = await lstat(options.projectDir)
  if (!projectInfo.isDirectory() || projectInfo.isSymbolicLink()) throw new Error('Episode project must be a regular directory')
  const projectDir = await realpath(options.projectDir)
  let parent = projectDir
  for (const segment of ['.muse', 'episode-delivery', identity.attempt]) {
    parent = join(parent, segment); await directory(parent)
  }
  const attemptRoot = parent, jobPath = join(attemptRoot, 'job.json'), parse = schemas()
  const executionPath = (id: EpisodeExecutionId): string => join(attemptRoot, `admitted-${z.uuid().parse(id)}.json`)
  const encode = (value: EpisodeDeliveryJobRecord | EpisodeExecutionAdmission): string => {
    const content = JSON.stringify(value) + '\n'
    if (Buffer.byteLength(content) > options.recordBytes) throw new Error('Episode job record exceeds its budget')
    return content
  }
  const ownedPath = async (path: string): Promise<void> => {
    const suffix = relative(attemptRoot, path)
    if (!isAbsolute(path) || suffix === '' || suffix === '..' || suffix.startsWith('..' + sep) || isAbsolute(suffix)
      || await realpath(dirname(path)) !== dirname(path)) throw new Error('Episode path escapes its captured attempt')
  }
  const read = async (): Promise<EpisodeDeliveryJobRecord | undefined> => {
    const value = await readEpisodeRecord(jobPath, options.recordBytes)
    if (value === undefined) return undefined
    const record = parse.record.parse(value)
    if (record.projectDir !== projectDir || !same(record.identity, identity)) throw new Error('Episode job identity changed')
    return record
  }
  const required = async (): Promise<EpisodeDeliveryJobRecord> => {
    const record = await read()
    if (record === undefined) throw new Error('Episode job has not been admitted')
    return record
  }
  const inputs = async (record: EpisodeDeliveryAdmission): Promise<FileVersion[]> => {
    if (new Set(record.inputs.map(row => row.path)).size !== record.inputs.length
      || new Set(record.approvals.map(row => row.idempotencyKey)).size !== record.approvals.length) {
      throw new Error('Episode admission contains duplicate inputs or original keys')
    }
    const versions: FileVersion[] = []
    for (const input of record.inputs) {
      await ownedPath(input.path)
      const actual = await hashFile(input.path, options.signal)
      if (actual.sha256 !== input.sha256 || actual.bytes !== input.bytes) throw new Error('Episode staged input changed')
      versions.push(actual.version)
    }
    return versions
  }
  const readExecution = async (id: EpisodeExecutionId): Promise<EpisodeExecutionAdmission | undefined> => {
    const value = await readEpisodeRecord(executionPath(id), options.recordBytes)
    if (value === undefined) return undefined
    const record = parse.execution.parse(value)
    if (!same(record.identity, identity) || record.identity.execution !== id) throw new Error('Episode execution identity changed')
    return record
  }
  const admissionState = async (requested: ExecutionIdentity) => {
    const record = await required(), execution = await readExecution(requested.execution)
    if (execution === undefined || JSON.stringify(execution.identity) !== JSON.stringify(executionIdentitySchema.parse(requested))) {
      throw new Error('Episode physical execution has not been admitted')
    }
    if (record.armedExecutions.includes(requested.execution)) throw new Error('Episode physical execution UUID is already occupied')
    const runningValue = await readEpisodeRecord(join(attemptRoot, 'execution.json'), options.recordBytes)
    if (record.executionRef === null) {
      if (runningValue !== undefined) throw new Error('Episode has an unowned running execution')
    } else {
      if (runningValue === undefined) throw new Error('Episode armed execution has no running record; state is unknown')
      const running = runningExecutionSchema.parse(runningValue)
      const proofValue = await readEpisodeRecord(join(attemptRoot, `drained-${running.identity.execution}.json`), options.recordBytes)
      if (JSON.stringify(running) !== JSON.stringify(record.executionRef) || proofValue === undefined) {
        throw new Error('Episode armed execution lacks matching drain evidence; state is unknown')
      }
      const proof = executionDrainSchema.parse(proofValue)
      if (JSON.stringify(proof.identity) !== JSON.stringify(running.identity) || proof.guardianPid !== running.guardianPid) {
        throw new Error('Episode drain proof does not match its armed execution')
      }
      if (proof.result === 'completed' || execution.retry === 'initial'
        || (execution.retry === 'host-disconnect-recovery' && proof.result !== 'cancelled')) {
        throw new Error('Episode retry requires reconciliation or an explicit durable retry')
      }
    }
    if (await readEpisodeRecord(join(attemptRoot, `drained-${requested.execution}.json`), options.recordBytes) !== undefined) {
      throw new Error('Episode physical execution already has historical evidence')
    }
    await ownedPath(execution.descriptorPath); await ownedPath(execution.candidatePath)
    let occupied = true
    try { await lstat(execution.candidatePath) } catch (error) { if (absent(error)) occupied = false; else throw error }
    if (occupied) throw new Error('Episode candidate destination is occupied')
    return { record, execution }
  }
  let verification: {
    readonly identity: ExecutionIdentity
    readonly record: string
    readonly execution: string
    readonly versions: readonly FileVersion[]
  } | undefined
  const assertAdmission = async (requested: ExecutionIdentity): Promise<void> => {
    verification = undefined
    const current = await admissionState(requested)
    const versions = await inputs(current.record)
    const descriptor = await hashFile(current.execution.descriptorPath, options.signal)
    if (descriptor.sha256 !== requested.descriptorSha256) throw new Error('Episode descriptor changed')
    verification = { identity: executionIdentitySchema.parse(requested), record: encode(current.record),
      execution: encode(current.execution), versions: [...versions, descriptor.version] }
  }
  const locked = <Result>(action: () => Promise<Result>): Promise<Result> =>
    withFileLock(jobPath, action, { ...(options.signal === undefined ? {} : { signal: options.signal }), waitMs: options.lockWaitMs })
  return {
    attemptRoot, read, readExecution, assertAdmission,
    admit: async (input) => {
      const admission = parse.admission.parse(input)
      await inputs(admission)
      return locked(async () => {
        const existing = await read()
        if (existing !== undefined) {
          const admitted = parse.admission.parse({ approvals: existing.approvals, inputs: existing.inputs })
          if (JSON.stringify(admitted) !== JSON.stringify(admission)) {
            throw new Error('Episode attempt already has a different admission')
          }
          return existing
        }
        const evidence = await readdir(attemptRoot)
        if (evidence.some(name => name === 'execution.json' || name.startsWith('admitted-') || name.startsWith('drained-')
          || (name.startsWith('drain-') || name.startsWith('admission-')) && name.endsWith('.prepared.json'))) {
          throw new Error('Episode job is missing but execution evidence remains; state is unknown')
        }
        const record: EpisodeDeliveryJobRecord = { ...admission, version: 1, kind: 'episode-delivery',
          projectDir, identity, executionRef: null, armedExecutions: [] }
        options.signal?.throwIfAborted()
        await writeFileAtomic(jobPath, encode(record), { mode: 0o600, dirMode: 0o700 })
        return record
      })
    },
    admitExecution: async (input) => {
      const record = parse.execution.parse(input)
      if (!same(record.identity, identity)) throw new Error('Episode descriptor belongs to another attempt')
      await ownedPath(record.descriptorPath); await ownedPath(record.candidatePath)
      const descriptor = await hashFile(record.descriptorPath, options.signal)
      if (descriptor.sha256 !== record.identity.descriptorSha256) throw new Error('Episode descriptor changed')
      return locked(async () => {
        await required()
        const existing = await readExecution(record.identity.execution)
        if (existing !== undefined) {
          if (JSON.stringify(existing) !== JSON.stringify(record)) throw new Error('Episode execution admission conflicts')
          return existing
        }
        const prepared = join(attemptRoot, `admission-${randomUUID()}.prepared.json`)
        options.signal?.throwIfAborted()
        await writeFileAtomic(prepared, encode(record), { mode: 0o600, dirMode: 0o700 })
        try { await link(prepared, executionPath(record.identity.execution)) } finally { await unlink(prepared) }
        return record
      })
    },
    armExecution: record => locked(async () => {
      const running = runningExecutionSchema.parse(record)
      const checked = verification
      verification = undefined
      if (checked === undefined || JSON.stringify(checked.identity) !== JSON.stringify(running.identity)) {
        throw new Error('Episode execution requires a current owned admission verification')
      }
      const current = await admissionState(running.identity), job = current.record
      if (encode(job) !== checked.record || encode(current.execution) !== checked.execution) {
        throw new Error('Episode admission changed before arming')
      }
      for (const version of checked.versions) {
        const actual = await lstat(version.path)
        if (!actual.isFile() || actual.dev !== version.dev || actual.ino !== version.ino || actual.size !== version.size
          || actual.mtimeMs !== version.mtimeMs || actual.ctimeMs !== version.ctimeMs) {
          throw new Error('Episode input changed after verification')
        }
      }
      options.signal?.throwIfAborted()
      await writeFileAtomic(jobPath, encode({ ...job, executionRef: running,
        armedExecutions: [...job.armedExecutions, running.identity.execution] }), { mode: 0o600, dirMode: 0o700 })
    }),
  }
}
