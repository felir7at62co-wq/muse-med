/** Resume project-scoped video completion checks from recorded submission keys. */
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream, type Stats } from 'node:fs'
import { link, lstat, mkdir, open, readFile, realpath, unlink } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { setTimeout as delay } from 'node:timers/promises'
import type { JubianClient, JubianLedger, JubianLedgerRecord } from '@deepseek-ai/dsh-jubian'
import { downloadMedia, MEDIA_LIMITS } from '@deepseek-ai/dsh-jubian-api'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { z } from 'zod'
import { recoverVideoSubmission } from './native.ts'
import { brandString } from '@deepseek-ai/dsh-brand'
import { recordedVideoPreview, recoveryProject } from './video-recovery-project.ts'
import type { ApprovedClipDirectDelivery, ApprovedVideoSourceMetadata, ApprovedVideoSourceVersion,
  VideoArtifactSha256, VideoRecoveryDigest, VideoRecoverySource } from './types.ts'
import { hashEpisodeFile, readEpisodeBytes } from './episode-delivery.ts'
import { observe, watchArgs } from './watch.ts'
import { VideoMediaDrainError, type checkVideoMedia } from './video-media-check.ts'

/**
 * Determine whether a recorded batch intent can be discovered for a project.
 * @param record - Ledger record to classify.
 * @param projectDir - Configured project root.
 * @param signal - Optional cancellation of canonical filesystem inspection.
 * @returns Whether the intent retains a preview in the project's video task directory.
 */
export async function isProjectVideoIntent(record: JubianLedgerRecord | undefined, projectDir: string,
  signal?: AbortSignal): Promise<boolean> {
  if (record === undefined) return false
  return await recordedVideoPreview(record, await recoveryProject(projectDir, signal), signal) !== undefined
}

function reviewPath(projectDir: string, key: string): string {
  return join(projectDir, 'video_tasks', 'review', createHash('sha256').update(key).digest('hex') + '.json')
}

function missing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

async function reportDirectory(path: string, create: boolean): Promise<void> {
  const directory = dirname(path)
  const tasks = dirname(directory)
  for (const ancestor of [dirname(tasks), tasks]) {
    const entry = await lstat(ancestor)
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('Video review requires real project directories')
  }
  if (create) {
    await mkdir(directory, { mode: 0o700 }).catch((error: unknown) => {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error
    })
  }
  const entry = await lstat(directory)
  if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('Video review requires a real report directory')
}

async function regularReport(path: string): Promise<void> {
  const entry = await lstat(path)
  if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('Video review requires a regular report file')
}

async function publishOnce(path: string, value: unknown, signal?: AbortSignal): Promise<boolean> {
  signal?.throwIfAborted()
  const temporary = path + '.' + randomUUID() + '.tmp'
  const handle = await open(temporary, 'wx', 0o600)
  try {
    try { await handle.writeFile(JSON.stringify(value, null, 2) + '\n', { signal }) }
    finally { await handle.close() }
    signal?.throwIfAborted()
    await link(temporary, path)
    return true
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error
    return false
  } finally {
    await unlink(temporary)
  }
}

const derivativePathSchema = z.string().max(1024)
  .regex(/^video_tasks\/(?:[^/:\\]+\/)*[^/:\\]+\.mp4$/i)
  .refine(path => path.split('/').slice(1).every(part =>
    !/[<>"|?*\u0000-\u001f]|[ .]$/.test(part)
    && !/^(?:review$|con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)))
const jsonValueSchema = z.json()
const reportSchema = z.record(z.string(), jsonValueSchema)
const outputSchema = z.object({ outputs: z.array(z.object({ video_url: z.string().min(1) })).min(1) })
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/)
const rejectionSchema = z.object({ action: z.literal('reject'), digest: sha256Schema, reason: z.string().optional() })
const reviewDecisionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('approve'), digest: sha256Schema, reason: z.undefined().optional() }),
  rejectionSchema,
])
const recoveryEvidenceSchema = z.object({
  idempotency_key: z.string(), task_id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  status: z.enum(['awaiting_review', 'provider_failed']),
  media_checks: z.array(z.object({ sha256: z.string(), video: z.boolean(), audio: z.boolean() })),
})
const reopeningSchema = z.object({ rejectionSha256: sha256Schema, reason: z.string().trim().min(1).max(1000) })
const derivativeSchema = z.object({
  kind: z.literal('derivative'),
  originalDigest: sha256Schema,
  path: derivativePathSchema,
  filename: z.string().regex(/^artifact-[a-f0-9-]{36}\.mp4$/),
  sha256: sha256Schema,
  video: z.literal(true),
  audio: z.boolean(),
})

type ReviewTextReader = (path: string, signal?: AbortSignal) => Promise<string>
const readReviewText: ReviewTextReader = (path, signal) => readFile(path, { encoding: 'utf8', signal })

async function optionalReport(path: string, signal?: AbortSignal,
  readText: ReviewTextReader = readReviewText): Promise<string | undefined> {
  try {
    await regularReport(path)
    return await readText(path, signal)
  } catch (error) {
    if (!missing(error)) throw error
    return undefined
  }
}

/**
 * Hash a regular local video artifact within the media size limit.
 * @param path - Absolute path of the managed video.
 * @param signal - Optional cancellation of the read.
 * @returns Lowercase hexadecimal SHA-256 of the exact file bytes.
 */
export async function artifactHash(path: string, signal?: AbortSignal): Promise<string> {
  try {
    await regularReport(path)
    const hash = createHash('sha256')
    let size = 0
    for await (const bytes of createReadStream(path, { signal }) as AsyncIterable<Buffer>) {
      size += bytes.length
      if (size > MEDIA_LIMITS.video) throw new Error('Managed video exceeds the media limit')
      hash.update(bytes)
    }
    return hash.digest('hex')
  } catch (error) {
    throw new Error('Could not verify the managed video', { cause: error })
  }
}

type DerivativeView = { path: string; sha256: string; video: true; audio: boolean }
type SourceCandidate = { kind: 'provider' | 'derivative'; path: string; sha256: string; taskId: number; passing: boolean }
type ReviewMetadata = {
  projectDir: string
  evidence: Record<string, JsonValue>
  digest: string
  derivative: DerivativeView | null
  candidate: SourceCandidate | undefined
  decisionPath: string
  decisionBytes: string | undefined
  recorded: JsonValue
  reopeningPath: string
  reopeningBytes: string | undefined
  reopenedFrom: JsonValue | undefined
}

function candidateFor(parsed: z.infer<typeof recoveryEvidenceSchema>, derivative: DerivativeView | null): SourceCandidate | undefined {
  if (parsed.status !== 'awaiting_review') return undefined
  if (derivative !== null) return { kind: 'derivative', path: derivative.path, sha256: derivative.sha256,
    taskId: parsed.task_id, passing: derivative.audio }
  const [check] = parsed.media_checks
  if (check === undefined || parsed.media_checks.length !== 1) return undefined
  const sha256 = /^sha256:([a-f0-9]{64})$/u.exec(check.sha256)?.[1]
  if (sha256 === undefined) return undefined
  return { kind: 'provider', path: 'video_tasks/review/original-' + sha256 + '.mp4', sha256,
    taskId: parsed.task_id, passing: check.video && check.audio }
}

function validateDecision(recorded: JsonValue, digest: string): void {
  if (recorded === null) return
  if (reviewDecisionSchema.parse(recorded).digest !== digest) throw new Error('The decision belongs to another report')
}

async function readReviewMetadata(projectDir: string, key: string, signal?: AbortSignal,
  readText: ReviewTextReader = readReviewText): Promise<ReviewMetadata> {
  signal?.throwIfAborted()
  await reportDirectory(reviewPath(projectDir, key), false)
  const root = await realpath(projectDir), path = reviewPath(root, key)
  await reportDirectory(path, false)
  await regularReport(path)
  const report = await readText(path, signal)
  let digest = createHash('sha256').update(report).digest('hex')
  const evidence = reportSchema.parse(JSON.parse(report))
  const facts = recoveryEvidenceSchema.parse(evidence)
  if (facts.idempotency_key !== key) throw new Error('The video report belongs to another original key')
  let decisionPath = path + '.decision.json'
  const initial = await optionalReport(decisionPath, signal, readText)
  let decisionBytes = initial
  let recorded: JsonValue = initial === undefined ? null : jsonValueSchema.parse(JSON.parse(initial))
  let derivative: DerivativeView | null = null
  if (initial !== undefined && recorded !== null && typeof recorded === 'object'
    && !Array.isArray(recorded) && recorded.kind === 'derivative') {
    const adoption = derivativeSchema.parse(recorded)
    if (adoption.originalDigest !== digest) throw new Error('The adopted video derivative or original report changed')
    digest = createHash('sha256').update(report).update('\0').update(initial).digest('hex')
    derivative = {
      path: 'video_tasks/review/' + adoption.filename, sha256: adoption.sha256, video: adoption.video, audio: adoption.audio,
    }
    decisionPath = path + '.derivative.decision.json'
    decisionBytes = await optionalReport(decisionPath, signal, readText)
    recorded = decisionBytes === undefined ? null : jsonValueSchema.parse(JSON.parse(decisionBytes))
  }
  const reopeningPath = decisionPath + '.reopen.json'
  const reopeningBytes = await optionalReport(reopeningPath, signal, readText)
  let reopenedFrom: JsonValue | undefined
  if (reopeningBytes !== undefined) {
    const rejection = rejectionSchema.parse(recorded)
    const reopening = reopeningSchema.parse(JSON.parse(reopeningBytes))
    if (rejection.digest !== digest || decisionBytes === undefined
      || reopening.rejectionSha256 !== createHash('sha256').update(decisionBytes).digest('hex')) {
      throw new Error('The original video rejection changed after reopening')
    }
    reopenedFrom = { digest, rejectionReason: rejection.reason ?? null, reason: reopening.reason }
    digest = createHash('sha256').update(digest).update('\0').update(reopeningBytes).digest('hex')
    decisionPath += '.reopened.json'
    const active = await optionalReport(decisionPath, signal, readText)
    recorded = active === undefined ? null : jsonValueSchema.parse(JSON.parse(active))
  }
  validateDecision(recorded, digest)
  return { projectDir: root, evidence, digest, derivative, candidate: candidateFor(facts, derivative), decisionPath, decisionBytes,
    recorded, reopeningPath, reopeningBytes, reopenedFrom }
}

/**
 * Read strict immutable approval facts without inspecting or acquiring media.
 * @param projectDir - Canonical selected project.
 * @param key - Original ledger key owned by that project.
 * @param metadataMaxBytes - Validated per-file metadata budget from consumer Config.
 * @param signal - Owning source operation cancellation.
 * @returns Expected source facts; callers must separately verify actual bytes.
 */
export async function readApprovedVideoSourceMetadata(projectDir: string, key: string,
  metadataMaxBytes: number, signal: AbortSignal): Promise<ApprovedVideoSourceMetadata> {
  const metadata = await readReviewMetadata(projectDir, key, signal, async (path, control) => {
    const bytes = await readEpisodeBytes(path, metadataMaxBytes, control)
    if (bytes === undefined) throw Object.assign(new Error('Video approval metadata is unavailable'), { code: 'ENOENT' })
    return bytes.toString('utf8')
  })
  const decision = reviewDecisionSchema.parse(metadata.recorded), candidate = metadata.candidate
  if (decision.action !== 'approve' || candidate === undefined || !candidate.passing) {
    throw new Error('Select an approved video with passing picture and audio evidence')
  }
  return { idempotencyKey: key, digest: brandString<VideoRecoveryDigest>(metadata.digest), taskId: candidate.taskId,
    kind: candidate.kind, path: candidate.path, sha256: brandString<VideoArtifactSha256>(candidate.sha256) }
}

function approvedVersion(path: string, sha256: VideoArtifactSha256, info: Stats): ApprovedVideoSourceVersion {
  return { path, sha256, dev: info.dev, ino: info.ino, size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs }
}

function sameApprovedVersion(left: ApprovedVideoSourceVersion, right: ApprovedVideoSourceVersion): boolean {
  return left.path === right.path && left.sha256 === right.sha256 && left.dev === right.dev && left.ino === right.ino
    && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs
}

/**
 * Hash one actual approved managed source outside the recovery metadata queue.
 * @param projectDir - Captured canonical project.
 * @param metadata - Strict immutable expected source facts.
 * @param signal - Owning source operation cancellation.
 * @returns Current exact-hash regular-file identity for the final short check.
 */
export async function verifyApprovedVideoSource(projectDir: string, metadata: ApprovedVideoSourceMetadata,
  signal: AbortSignal): Promise<ApprovedVideoSourceVersion> {
  const path = join(projectDir, metadata.path)
  await reportDirectory(path, false)
  await regularReport(path)
  if (await realpath(path) !== path) throw new Error('Approved source path changed')
  const before = approvedVersion(path, metadata.sha256, await lstat(path))
  const actual = (await hashEpisodeFile(path, signal)).sha256
  const afterInfo = await lstat(path), after = approvedVersion(path, metadata.sha256, afterInfo)
  signal.throwIfAborted()
  if (!afterInfo.isFile() || afterInfo.isSymbolicLink() || await realpath(path) !== path
    || actual !== metadata.sha256 || !sameApprovedVersion(before, after)) {
    throw new Error('The current approved source changed')
  }
  return after
}

/**
 * Recheck a freshly hashed source's identity without hashing media under the queue.
 * @param version - This operation's current full-hash observation.
 * @param signal - Owning source operation cancellation.
 */
export async function assertApprovedVideoSourceVersion(version: ApprovedVideoSourceVersion, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  await reportDirectory(version.path, false)
  const actual = await lstat(version.path)
  if (!actual.isFile() || actual.isSymbolicLink() || await realpath(version.path) !== version.path
    || !sameApprovedVersion(version, approvedVersion(version.path, version.sha256, actual))) {
    throw new Error('The approved source changed after hashing')
  }
}

function sourceState(candidate: SourceCandidate, state: 'verified' | 'changed' | 'unreadable'): VideoRecoverySource {
  const identity = { path: candidate.path, sha256: brandString<VideoArtifactSha256>(candidate.sha256) }
  return candidate.kind === 'provider' ? { kind: 'provider', ...identity, state } : { kind: 'derivative', ...identity, state }
}

async function inspectSource(projectDir: string, candidate: SourceCandidate | undefined,
  signal?: AbortSignal): Promise<VideoRecoverySource> {
  signal?.throwIfAborted()
  if (candidate === undefined) return { kind: 'none', state: 'unverifiable' }
  const path = join(projectDir, candidate.path)
  try {
    await reportDirectory(path, false)
    await regularReport(path)
    const canonical = await realpath(path)
    signal?.throwIfAborted()
    if (relative(path, canonical) !== '') return sourceState(candidate, 'unreadable')
    const actual = await artifactHash(path, signal)
    signal?.throwIfAborted()
    return sourceState(candidate, actual === candidate.sha256 ? 'verified' : 'changed')
  } catch (error) {
    signal?.throwIfAborted()
    if (missing(error) || (error instanceof Error && missing(error.cause))) {
      const identity = { path: candidate.path, sha256: brandString<VideoArtifactSha256>(candidate.sha256) }
      return candidate.kind === 'provider'
        ? { kind: 'provider', ...identity, state: 'unmaterialized' } : { kind: 'derivative', ...identity, state: 'missing' }
    }
    return sourceState(candidate, 'unreadable')
  }
}

/**
 * Read immutable review facts and current local source state, or explicitly record a decision.
 * New approvals require passing tracks and a matching current source.
 * Reads, rejections and recorded decision reuse may report an unavailable source.
 * @param projectDir - Authorized project directory.
 * @param key - Original submission key.
 * @param decision - Optional decision or reason to reopen the exact rejected report digest.
 * @param signal - Cancellation of reads and writes before publication.
 * @param clientForProject - Explicit read transport for a new provider approval only; acquisition requires signal.
 * @returns Original evidence, unchanged active digest, current source state, derivative and persisted decision.
 */
export async function reviewRecoveredVideo(projectDir: string, key: string,
  decision?: { action: 'approve' | 'reject' | 'reopen'; digest: string; reason?: string }, signal?: AbortSignal,
  clientForProject?: () => JubianClient): Promise<Record<string, JsonValue>> {
  let metadata = await readReviewMetadata(projectDir, key, signal)
  if (decision?.action === 'reopen') {
    const rejection = rejectionSchema.safeParse(metadata.recorded)
    if (metadata.reopeningBytes !== undefined || !rejection.success || metadata.decisionBytes === undefined
      || rejection.data.digest !== metadata.digest || decision.digest !== metadata.digest
      || metadata.evidence.status !== 'awaiting_review' || metadata.evidence.idempotency_key !== key) {
      throw new Error('Only the current rejected review can be reopened once')
    }
    const reopening = reopeningSchema.parse({
      rejectionSha256: createHash('sha256').update(metadata.decisionBytes).digest('hex'), reason: decision.reason,
    })
    if (!await publishOnce(metadata.reopeningPath, reopening, signal)) throw new Error('The rejected review has already been reopened')
    return reviewRecoveredVideo(metadata.projectDir, key, undefined, signal)
  }
  if (decision !== undefined) {
    if (decision.digest !== metadata.digest || metadata.evidence.status !== 'awaiting_review'
      || metadata.evidence.idempotency_key !== key) {
      throw new Error('Video review report changed or is not awaiting review')
    }
    if (decision.action === 'approve' && metadata.recorded === null) {
      const candidate = metadata.candidate
      if (candidate === undefined || !candidate.passing) throw new Error('Video approval requires passing picture and audio evidence')
      if (candidate.kind === 'provider' && clientForProject !== undefined) {
        if (signal === undefined) throw new Error('Provider acquisition requires operation cancellation')
        await materializeApprovedProviderVideo(metadata.projectDir, candidate.taskId, candidate.sha256, clientForProject, signal)
      }
      metadata = await readReviewMetadata(projectDir, key, signal)
      if (metadata.digest !== decision.digest) throw new Error('Video review report changed before approval')
      const source = await inspectSource(metadata.projectDir, metadata.candidate, signal)
      if (source.state !== 'verified') throw new Error('Video approval requires a verified current source')
    }
    if (metadata.recorded === null && await publishOnce(metadata.decisionPath, decision, signal)) {
      metadata.recorded = decision
    } else {
      const existing = await optionalReport(metadata.decisionPath, signal)
      metadata.recorded = existing === undefined ? null : jsonValueSchema.parse(JSON.parse(existing))
      if (metadata.recorded === null || typeof metadata.recorded !== 'object' || Array.isArray(metadata.recorded)
        || metadata.recorded.action !== decision.action || metadata.recorded.digest !== decision.digest
        || metadata.recorded.reason !== decision.reason) {
        throw new Error('A different video review decision is already recorded')
      }
    }
  }
  const source = await inspectSource(metadata.projectDir, metadata.candidate, signal)
  return { evidence: metadata.evidence, digest: metadata.digest, derivative: metadata.derivative, decision: metadata.recorded, source,
    ...(metadata.reopenedFrom === undefined ? {} : { reopened_from: metadata.reopenedFrom }) }
}

/**
 * Adopt one checked MP4 without modifying the provider report or source file.
 * @param projectDir - Authorized project directory.
 * @param key - Original submission key.
 * @param digest - Current digest of the undecided provider report.
 * @param sourcePath - Project-relative MP4 path under video_tasks.
 * @param inspect - Decoder for the managed copy of the source.
 * @param signal - Host cancellation.
 * @returns The original evidence and its newly active derivative.
 */
export async function adoptRecoveredVideo(projectDir: string, key: string, digest: string, sourcePath: string,
  inspect: (path: string) => Promise<{ video: boolean; audio: boolean }>,
  signal: AbortSignal): Promise<Record<string, JsonValue>> {
  const report = await reviewRecoveredVideo(projectDir, key, undefined, signal)
  const evidence = report.evidence
  if (report.digest !== digest || report.derivative !== null || report.decision !== null || report.reopened_from !== undefined
    || evidence === null || typeof evidence !== 'object' || Array.isArray(evidence)
    || evidence.status !== 'awaiting_review' || evidence.idempotency_key !== key) {
    throw new Error('Video adoption requires an undecided provider report')
  }

  const source = derivativePathSchema.parse(sourcePath)
  const root = await realpath(projectDir)
  const parts = source.split('/')
  let parent = root
  for (const part of parts.slice(0, -1)) {
    parent = join(parent, part)
    const entry = await lstat(parent)
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('Video derivative requires real project directories')
  }
  const path = join(root, ...parts)
  const entry = await lstat(path)
  if (!entry.isFile() || entry.isSymbolicLink() || relative(path, await realpath(path)) !== '') {
    throw new Error('Video derivative must be a regular project file')
  }
  const review = reviewPath(root, key)
  const filename = 'artifact-' + randomUUID() + '.mp4'
  const managed = join(dirname(review), filename)
  const handle = await open(path, 'r')
  const capture = { opened: false }
  let published = false
  let cleanupSafe = true
  try {
    const stat = await handle.stat()
    if (stat.ino !== entry.ino || stat.dev !== entry.dev || !stat.isFile()
      || stat.size < 1 || stat.size > MEDIA_LIMITS.video || relative(path, await realpath(path)) !== '') {
      throw new Error('Video derivative changed before capture or exceeds the media limit')
    }
    const hash = createHash('sha256')
    let size = 0
    const meter = new Transform({
      transform(bytes: Buffer, _encoding, done) {
        size += bytes.length
        if (size > MEDIA_LIMITS.video) {
          done(new Error('Video derivative exceeds the media limit'))
          return
        }
        hash.update(bytes)
        done(null, bytes)
      },
    })
    const output = createWriteStream(managed, { flags: 'wx', mode: 0o600 })
    output.once('open', () => { capture.opened = true })
    await pipeline(handle.createReadStream({ autoClose: false }), meter, output, { signal })
    const sha256 = hash.digest('hex')
    const checks = await inspect(managed)
    if (!checks.video || sha256 !== await artifactHash(managed, signal)) throw new Error('Video derivative could not be decoded or changed')
    const current = await reviewRecoveredVideo(root, key, undefined, signal)
    if (current.digest !== digest || current.decision !== null || current.derivative !== null) {
      throw new Error('Video review changed before the derivative could be adopted')
    }
    signal.throwIfAborted()
    published = await publishOnce(review + '.decision.json', {
      kind: 'derivative', originalDigest: digest, path: source, filename, sha256, ...checks,
    }, signal)
    if (!published) throw new Error('Video review changed before the derivative could be adopted')
    return await reviewRecoveredVideo(root, key, undefined, signal)
  } catch (error) {
    cleanupSafe = !(error instanceof VideoMediaDrainError)
    throw error
  } finally {
    await handle.close()
    if (capture.opened && !published && cleanupSafe) await unlink(managed)
  }
}

function outputUrls(result: string | undefined): string[] {
  const parsed = outputSchema.safeParse(JSON.parse(result ?? '{}'))
  if (!parsed.success) throw new Error('Verified video operation has no media outputs')
  return parsed.data.outputs.map(output => output.video_url)
}

/**
 * Materialize exact provider bytes for an explicit approval or delivery without changing the report or decision.
 * @param projectDir - Authorized project whose review directory owns the copy.
 * @param taskId - Verified generation operation recorded in the approved report.
 * @param sha256 - Recorded bare SHA-256 digest of the original output.
 * @param clientForProject - Creates the project's read-only provider client on a cache miss.
 * @param signal - Cancellation for provider reads and local publication.
 * @returns Absolute path to the project-owned bytes matching the approved digest.
 */
export async function materializeApprovedProviderVideo(projectDir: string, taskId: number, sha256: string,
  clientForProject: () => JubianClient, signal: AbortSignal): Promise<string> {
  const digest = sha256Schema.parse(sha256)
  const path = join(projectDir, 'video_tasks', 'review', 'original-' + digest + '.mp4')
  await reportDirectory(path, false)
  let present = true
  try { await regularReport(path) }
  catch (error) {
    if (!missing(error)) throw error
    present = false
  }
  signal.throwIfAborted()
  if (!present) {
    const outcome = await observe(clientForProject(), watchArgs({ task_id: taskId, stage: 'generate' }), signal)
    if (outcome?.status !== 'completed') throw new Error('The approved provider output could not be verified')
    const urls = outputUrls(outcome.result)
    const [url] = urls
    if (urls.length !== 1 || url === undefined) throw new Error('The approved task must have one verified provider output')
    const media = await downloadMedia(url, { kind: 'video', signal })
    if (media.sha256 !== 'sha256:' + digest) throw new Error('Provider video bytes differ from the approved output')
    const temporary = path + '.' + randomUUID() + '.tmp'
    const handle = await open(temporary, 'wx', 0o600)
    try {
      try { await handle.writeFile(media.bytes, { signal }) }
      finally { await handle.close() }
      signal.throwIfAborted()
      await reportDirectory(path, false)
      try { await link(temporary, path) }
      catch (error) {
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error
      }
    } finally {
      await unlink(temporary)
    }
  }
  if (await artifactHash(path, signal) !== digest) throw new Error('Managed video bytes differ from the approved output')
  signal.throwIfAborted()
  return path
}

const approvedVideoDeliverySchema = z.object({ path: z.string(), sha256: sha256Schema })

function directDeliveryPath(taskId: number, reviewDigest: string): string {
  return 'exports/Muse-approved-' + String(taskId) + '-' + reviewDigest + '.mp4'
}

function directDeliveryReceipt(projectDir: string, reviewDigest: string): string {
  return join(projectDir, 'video_tasks', 'review', reviewDigest + '.direct-delivery.json')
}

/**
 * Read a direct MP4 delivery receipt for the active approval.
 * @param projectDir - Authorized project directory.
 * @param taskId - Approved provider task ID.
 * @param reviewDigest - Exact approved report digest.
 * @param sha256 - Approved media hash.
 * @returns The recorded delivery when its filename and hash match the approval.
 */
async function readApprovedVideoDeliveryReceipt(projectDir: string, taskId: number, reviewDigest: string,
  sha256: string, signal?: AbortSignal): Promise<ApprovedClipDirectDelivery | undefined> {
  const source = await optionalReport(directDeliveryReceipt(projectDir, reviewDigest), signal)
  if (source === undefined) return undefined
  const receipt = approvedVideoDeliverySchema.parse(JSON.parse(source))
  if (receipt.path !== directDeliveryPath(taskId, reviewDigest) || receipt.sha256 !== sha256) {
    throw new Error('Direct delivery receipt does not match the approved video')
  }
  return { path: receipt.path, sha256: brandString<VideoArtifactSha256>(receipt.sha256) }
}

/** Current-file failure for a previously saved direct delivery receipt. */
export class VideoDeliveryFileError extends Error {
  /**
   * @param problem - Missing, changed or unreadable exported file.
   * @param options - Original filesystem failure when available.
   */
  constructor(readonly problem: 'missing' | 'changed' | 'unreadable', options?: ErrorOptions) {
    super('The approved MP4 delivery is ' + problem, options)
  }
}

/**
 * Verify both the saved receipt and its current regular file bytes.
 * @param projectDir - Canonical authorized project directory.
 * @param taskId - Approved provider task ID.
 * @param reviewDigest - Exact approved report digest.
 * @param sha256 - Approved bare file hash.
 * @param signal - Optional cancellation of filesystem verification.
 * @returns Verified delivery, or undefined when no receipt was published.
 */
export async function readApprovedVideoDelivery(projectDir: string, taskId: number, reviewDigest: string,
  sha256: string, signal?: AbortSignal): Promise<ApprovedClipDirectDelivery | undefined> {
  const receipt = await readApprovedVideoDeliveryReceipt(projectDir, taskId, reviewDigest, sha256, signal)
  if (receipt === undefined) return undefined
  const path = join(projectDir, receipt.path)
  try {
    await regularReport(path)
    if (await artifactHash(path, signal) !== sha256) throw new VideoDeliveryFileError('changed')
  } catch (error) {
    signal?.throwIfAborted()
    if (error instanceof VideoDeliveryFileError) throw error
    throw new VideoDeliveryFileError(missing(error) ? 'missing' : 'unreadable', { cause: error })
  }
  return receipt
}

async function assertExportDirectory(directory: string): Promise<void> {
  const folder = await lstat(directory)
  if (!folder.isDirectory() || folder.isSymbolicLink() || relative(directory, await realpath(directory)) !== '') {
    throw new Error('The project exports directory must be local')
  }
}

async function approvedDestinationExists(path: string): Promise<boolean> {
  try {
    await regularReport(path)
    return true
  } catch (error) {
    if (!missing(error)) throw error
    return false
  }
}

async function copyApprovedVideo(source: string, destination: string, sha256: string, signal: AbortSignal): Promise<void> {
  const temporary = destination + '.' + randomUUID() + '.tmp'
  const capture = { opened: false }
  const output = createWriteStream(temporary, { flags: 'wx', mode: 0o600, flush: true })
  output.once('open', () => { capture.opened = true })
  try {
    const input = createReadStream(source, { end: MEDIA_LIMITS.video })
    await pipeline(input, output, { signal })
    if (await artifactHash(temporary, signal) !== sha256) throw new Error('Approved media changed during direct delivery')
    await assertExportDirectory(dirname(destination))
    signal.throwIfAborted()
    try { await link(temporary, destination) } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error
    }
  } finally {
    if (capture.opened) await unlink(temporary)
  }
}

/**
 * Reuse an existing approved export, repairing only its missing receipt.
 * @param projectDir - Canonical authorized project directory.
 * @param taskId - Approved provider task ID.
 * @param reviewDigest - Exact approved report digest.
 * @param sha256 - Approved bare file hash.
 * @param signal - Cancellation before receipt publication.
 * @returns Verified delivery without consulting its source, or undefined when the output is absent.
 */
export async function recoverApprovedVideoDelivery(projectDir: string, taskId: number, reviewDigest: string,
  sha256: string, signal: AbortSignal): Promise<ApprovedClipDirectDelivery | undefined> {
  const receiptPath = directDeliveryReceipt(projectDir, reviewDigest)
  const previous = await readApprovedVideoDeliveryReceipt(projectDir, taskId, reviewDigest, sha256, signal)
  const path = directDeliveryPath(taskId, reviewDigest)
  const destination = join(projectDir, path)
  if (!await approvedDestinationExists(destination)) return undefined
  await assertExportDirectory(dirname(destination))
  if (await artifactHash(destination, signal) !== sha256) throw new Error('Direct delivery destination already contains different bytes')
  signal.throwIfAborted()
  if (previous !== undefined) return previous
  await reportDirectory(receiptPath, false)
  const receipt = { path, sha256: brandString<VideoArtifactSha256>(sha256) }
  if (await publishOnce(receiptPath, receipt, signal)) return receipt
  const concurrent = await readApprovedVideoDelivery(projectDir, taskId, reviewDigest, sha256, signal)
  if (concurrent === undefined) throw new Error('Direct delivery receipt changed during publication')
  return concurrent
}

/**
 * Publish an exact approved MP4 and its durable delivery receipt without an editor.
 * @param projectDir - Authorized project directory.
 * @param taskId - Approved provider task ID.
 * @param reviewDigest - Exact approved report digest.
 * @param source - Absolute path of the project-owned reviewed video.
 * @param sha256 - Approved media hash.
 * @param signal - Cancellation of the local copy and verification.
 * @returns The verified project-relative MP4 path and bare SHA-256 digest.
 */
export async function publishApprovedVideo(projectDir: string, taskId: number, reviewDigest: string, source: string,
  sha256: string, signal: AbortSignal): Promise<ApprovedClipDirectDelivery> {
  const existing = await recoverApprovedVideoDelivery(projectDir, taskId, reviewDigest, sha256, signal)
  if (existing !== undefined) return existing
  const receiptPath = directDeliveryReceipt(projectDir, reviewDigest)
  await reportDirectory(receiptPath, false)
  const previous = await readApprovedVideoDeliveryReceipt(projectDir, taskId, reviewDigest, sha256, signal)
  if (relative(source, await realpath(source)) !== '' || await artifactHash(source, signal) !== sha256) {
    throw new Error('Approved media changed before direct delivery')
  }

  const path = directDeliveryPath(taskId, reviewDigest)
  const destination = join(projectDir, path)
  const directory = dirname(destination)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await assertExportDirectory(directory)
  if (!await approvedDestinationExists(destination)) {
    await copyApprovedVideo(source, destination, sha256, signal)
  }
  if (await artifactHash(destination, signal) !== sha256) {
    throw new Error('Direct delivery destination already contains different bytes')
  }
  signal.throwIfAborted()
  const receipt = { path, sha256: brandString<VideoArtifactSha256>(sha256) }
  if (previous !== undefined || await publishOnce(receiptPath, receipt, signal)) return receipt
  const concurrent = await readApprovedVideoDelivery(projectDir, taskId, reviewDigest, sha256, signal)
  if (concurrent === undefined) throw new Error('Direct delivery receipt changed during publication')
  return concurrent
}

// Cancellation can change across awaits within a single worker iteration.
function isAborted(signal: AbortSignal): boolean {
  return signal.aborted
}

/**
 * Poll recorded submissions and publish provider evidence in their project.
 * @param client - Provider transport scoped to the configured project.
 * @param ledger - Original write ledger.
 * @param projectDir - Project root containing the frozen previews.
 * @param keys - Original keys to recover, or undefined to discover recorded submissions in the project.
 * @param intervalMs - Delay between checks of unresolved tasks.
 * @param signal - Host shutdown signal.
 * @param onError - Receives the key whose check failed.
 * @param inspect - Decodes each verified output before publishing it for human review.
 * @returns Completion after the explicit keys have evidence, or shutdown has drained the loop.
 */
export async function runVideoRecovery(client: JubianClient, ledger: JubianLedger, projectDir: string,
  keys: readonly string[] | undefined, intervalMs: number, signal: AbortSignal, onError: (key: string) => void,
  inspect: (url: string, signal: AbortSignal) => ReturnType<typeof checkVideoMedia>): Promise<void> {
  const pending = new Set(keys)
  const finished = new Set<string>()
  while (!isAborted(signal) && (keys === undefined || pending.size > 0)) {
    if (keys === undefined) {
      try {
        for (const record of await ledger.records()) {
          if (await isProjectVideoIntent(record, projectDir, signal) && !finished.has(record.idempotency_key)) {
            pending.add(record.idempotency_key)
          }
        }
      } catch (error) {
        if (isAborted(signal)) return
        void error // A failed read remains pending for the next operator-configured poll.
        onError('ledger')
      }
    }
    for (const key of pending) {
      if (isAborted(signal)) return
      const reportPath = reviewPath(projectDir, key)
      try {
        let exists = false
        try {
          await reportDirectory(reportPath, false)
          await regularReport(reportPath)
          exists = true
        } catch (error) {
          if (!missing(error)) throw error
        }
        if (!exists) {
          const recovery = await recoverVideoSubmission(client, ledger, projectDir, key, signal)
          if (isAborted(signal)) return
          if (recovery?.status !== 'submitted') continue
          const args = watchArgs({ task_id: Number(recovery.task_id), stage: 'generate' })
          const outcome = await observe(client, args, signal)
          if (isAborted(signal)) return
          if (!outcome) continue
          const mediaChecks = []
          if (outcome.status === 'completed') {
            for (const url of outputUrls(outcome.result)) mediaChecks.push(await inspect(url, signal))
          }
          if (isAborted(signal)) return
          await reportDirectory(reportPath, true)
          signal.throwIfAborted()
          await publishOnce(reportPath, {
            idempotency_key: key, task_id: args.task_id,
            status: outcome.status === 'completed' ? 'awaiting_review' : 'provider_failed',
            provider_detail: outcome.detail,
            media_checks: mediaChecks,
          }, signal)
        }
        pending.delete(key)
        finished.add(key)
      } catch (error) {
        if (error instanceof VideoMediaDrainError) throw error
        if (isAborted(signal)) return
        void error // A failed read remains pending for the next operator-configured poll.
        onError(key)
      }
    }
    if (keys === undefined || pending.size > 0) {
      try { await delay(intervalMs, undefined, { signal }) }
      catch (error) { if (!isAborted(signal)) throw error }
    }
  }
}
