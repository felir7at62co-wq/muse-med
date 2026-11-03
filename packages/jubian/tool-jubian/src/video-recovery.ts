/** Resume project-scoped video completion checks from recorded submission keys. */
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { link, lstat, mkdir, open, readFile, realpath, unlink, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { setTimeout as delay } from 'node:timers/promises'
import type { JubianClient, JubianLedger, JubianLedgerRecord } from '@deepseek-ai/dsh-jubian'
import { downloadMedia, MEDIA_LIMITS } from '@deepseek-ai/dsh-jubian-api'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { z } from 'zod'
import { recoverVideoSubmission } from './native.ts'
import { observe, watchArgs } from './watch.ts'
import type { checkVideoMedia } from './video-media-check.ts'

/**
 * Determine whether a recorded batch intent can be discovered for a project.
 * @param record - Ledger record to classify.
 * @param projectDir - Configured project root.
 * @returns Whether the intent retains a preview in the project's video task directory.
 */
export function isProjectVideoIntent(record: JubianLedgerRecord | undefined, projectDir: string): boolean {
  return record?.method === 'storyboard_native_submit' && record.outcome !== 'not_sent'
    && (record.before_task_ids !== undefined || record.outcome === 'accepted') && record.video_preview_path !== undefined
    && isAbsolute(record.video_preview_path)
    && relative(dirname(record.video_preview_path), resolve(projectDir, 'video_tasks')) === ''
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

async function publishOnce(path: string, value: unknown): Promise<boolean> {
  const temporary = path + '.' + randomUUID() + '.tmp'
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  try {
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
const derivativeSchema = z.object({
  kind: z.literal('derivative'),
  originalDigest: sha256Schema,
  path: derivativePathSchema,
  filename: z.string().regex(/^artifact-[a-f0-9-]{36}\.mp4$/),
  sha256: sha256Schema,
  video: z.literal(true),
  audio: z.boolean(),
})

async function optionalReport(path: string): Promise<string | undefined> {
  try {
    await regularReport(path)
    return await readFile(path, 'utf8')
  } catch (error) {
    if (!missing(error)) throw error
    return undefined
  }
}

async function artifactHash(path: string): Promise<string> {
  try {
    await regularReport(path)
    const hash = createHash('sha256')
    let size = 0
    for await (const bytes of createReadStream(path)) {
      if (!Buffer.isBuffer(bytes)) throw new Error('Managed video must be read as bytes')
      size += bytes.length
      if (size > MEDIA_LIMITS.video) throw new Error('Managed video exceeds the media limit')
      hash.update(bytes)
    }
    return hash.digest('hex')
  } catch (error) {
    throw new Error('Could not verify the managed video', { cause: error })
  }
}

/**
 * Read the project report or record one human decision bound to its exact bytes.
 * @param projectDir - Authorized project directory.
 * @param key - Original submission key.
 * @param decision - Optional explicitly authorized decision and report digest.
 * @returns Original evidence, active digest, optional derivative and recorded decision.
 */
export async function reviewRecoveredVideo(projectDir: string, key: string,
  decision?: { action: 'approve' | 'reject'; digest: string; reason?: string }): Promise<Record<string, JsonValue>> {
  const path = reviewPath(projectDir, key)
  await reportDirectory(path, false)
  await regularReport(path)
  const report = await readFile(path, 'utf8')
  let digest = createHash('sha256').update(report).digest('hex')
  const evidence = reportSchema.parse(JSON.parse(report))
  let decisionPath = path + '.decision.json'
  const initial = await optionalReport(decisionPath)
  let recorded: JsonValue = initial === undefined ? null : jsonValueSchema.parse(JSON.parse(initial))
  let derivative: JsonValue = null
  if (initial !== undefined && recorded !== null && typeof recorded === 'object' && !Array.isArray(recorded) && recorded.kind === 'derivative') {
    const adoption = derivativeSchema.parse(recorded)
    const managed = join(dirname(path), adoption.filename)
    if (adoption.originalDigest !== digest || adoption.sha256 !== await artifactHash(managed)) {
      throw new Error('The adopted video derivative or original report changed')
    }
    digest = createHash('sha256').update(report).update('\0').update(initial).digest('hex')
    derivative = {
      path: 'video_tasks/review/' + adoption.filename, sha256: adoption.sha256, video: adoption.video, audio: adoption.audio,
    }
    decisionPath = path + '.derivative.decision.json'
    const active = await optionalReport(decisionPath)
    recorded = active === undefined ? null : jsonValueSchema.parse(JSON.parse(active))
  }
  if (decision !== undefined) {
    if (decision.digest !== digest || evidence.status !== 'awaiting_review' || evidence.idempotency_key !== key) {
      throw new Error('Video review report changed or is not awaiting review')
    }
    if (recorded === null && await publishOnce(decisionPath, decision)) {
      recorded = decision
    } else {
      const existing = await optionalReport(decisionPath)
      recorded = existing === undefined ? null : jsonValueSchema.parse(JSON.parse(existing))
      if (recorded === null || typeof recorded !== 'object' || Array.isArray(recorded)
        || recorded.action !== decision.action || recorded.digest !== decision.digest || recorded.reason !== decision.reason) {
        throw new Error('A different video review decision is already recorded')
      }
    }
  }
  return { evidence, digest, derivative, decision: recorded }
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
  const report = await reviewRecoveredVideo(projectDir, key)
  const evidence = report.evidence
  if (report.digest !== digest || report.derivative !== null || report.decision !== null
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
    if (!checks.video || sha256 !== await artifactHash(managed)) throw new Error('Video derivative could not be decoded or changed')
    const current = await reviewRecoveredVideo(root, key)
    if (current.digest !== digest || current.decision !== null || current.derivative !== null) {
      throw new Error('Video review changed before the derivative could be adopted')
    }
    signal.throwIfAborted()
    published = await publishOnce(review + '.decision.json', {
      kind: 'derivative', originalDigest: digest, path: source, filename, sha256, ...checks,
    })
    if (!published) throw new Error('Video review changed before the derivative could be adopted')
    return await reviewRecoveredVideo(root, key)
  } finally {
    await handle.close()
    if (capture.opened && !published) await unlink(managed)
  }
}

function outputUrls(result: string | undefined): string[] {
  const parsed = outputSchema.safeParse(JSON.parse(result ?? '{}'))
  if (!parsed.success) throw new Error('Verified video operation has no media outputs')
  return parsed.data.outputs.map(output => output.video_url)
}

/**
 * Materialize one approved provider output without changing its report or decision.
 * @param projectDir - Authorized project whose review directory owns the copy.
 * @param taskId - Verified generation operation recorded in the approved report.
 * @param sha256 - Approved bare SHA-256 digest of the original output.
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
  if (await artifactHash(path) !== digest) throw new Error('Managed video bytes differ from the approved output')
  signal.throwIfAborted()
  return path
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
          if (isProjectVideoIntent(record, projectDir) && !finished.has(record.idempotency_key)) {
            pending.add(record.idempotency_key)
          }
        }
      } catch {
        if (isAborted(signal)) return
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
          })
        }
        pending.delete(key)
        finished.add(key)
      } catch {
        if (isAborted(signal)) return
        onError(key)
      }
    }
    if (keys === undefined || pending.size > 0) {
      try { await delay(intervalMs, undefined, { signal }) }
      catch (error) { if (!isAborted(signal)) throw error }
    }
  }
}
