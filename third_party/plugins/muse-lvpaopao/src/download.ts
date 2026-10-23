/** Verified local copy of one helper-owned, authorized first-episode file. */
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, mkdir, realpath, link, unlink, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, join, parse, relative, resolve, win32 } from 'node:path'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { Config } from './config.ts'
import { BridgeError, type Action, type Parameters, type RequestPort } from './port.ts'
import type { OutputDirectory } from './output.ts'

/** Trusted local destination and transport bounds; never model fields. */
export interface DownloadOptions {
  readonly enabled: boolean
  readonly outputDir: string
  readonly scpExecutable: string
  readonly copyTimeoutMs: number
  readonly maxMediaBytes: number
  readonly copyPollIntervalMs: number
  readonly output?: OutputDirectory
}
/** A verified local file, bound to its selected source. */
export interface LocalMedia {
  readonly localPath: string; readonly receiptPath: string; readonly bytes: number; readonly sha256: string
  readonly durationSeconds: number; readonly width: number; readonly height: number
  readonly hasAudio: boolean; readonly fullDecodePassed: true
}
interface LocalResult {
  readonly srcAppId: string; readonly dramaId: string; readonly title?: string; readonly media: LocalMedia
  readonly receiptReused: boolean; readonly businessCalls: number
  readonly episodeNo?: number
  readonly playAuthorization?: 'native-straight-playback'
}
class VerifiedLocalResult { constructor(readonly value: LocalResult) {} }
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }

/**
 * Recognize only locally minted verification; remote JSON cannot claim a local file.
 * @param value - Result after the owned RequestPort decorator.
 * @returns Verified local metadata, or undefined for ordinary helper JSON.
 */
export function localDownload(value: unknown): LocalResult | undefined {
  return value instanceof VerifiedLocalResult ? value.value : undefined
}

/**
 * Mint a result after the episode transfer has validated its source, bytes and hash.
 * @param value - Metadata produced by the trusted local copy implementation.
 * @returns An opaque value recognized by the canonical tool projector.
 */
export function verifiedEpisodeDownload(value: LocalResult & {
  readonly episodeNo: number; readonly playAuthorization: 'native-straight-playback'
}): unknown {
  return new VerifiedLocalResult(value)
}

/**
 * Validate a remote source prefix before any native download request.
 * @param config - Fixed SSH and Windows helper coordinates.
 * @param options - Trusted local output and copy settings.
 * @returns Safe forward-slash Windows parent path for scp.
 */
export function validateDownloadOptions(config: Config, options: DownloadOptions): string {
  if (!options.enabled) return ''
  if (!isAbsolute(options.outputDir) || /[\x00\r\n]/.test(options.outputDir)) throw new BridgeError('download-output-invalid')
  if (!options.scpExecutable.trim() || /[\x00\r\n]/.test(options.scpExecutable)) throw new BridgeError('download-scp-invalid')
  if (!Number.isSafeInteger(options.copyTimeoutMs) || options.copyTimeoutMs < 1000 || options.copyTimeoutMs > 1800000
    || !Number.isSafeInteger(options.maxMediaBytes) || options.maxMediaBytes < 1 || options.maxMediaBytes > 2147483648
    || !Number.isSafeInteger(options.copyPollIntervalMs) || options.copyPollIntervalMs < 50 || options.copyPollIntervalMs > 5000) throw new BridgeError('download-bound-invalid')
  const parent = win32.dirname(config.remoteHelper).replaceAll('\\', '/')
  if (!/^[A-Za-z]:\/[A-Za-z0-9_./-]+$/.test(parent) || parent.split('/').some(part => part === '..' || part === '.')) throw new BridgeError('download-remote-path-unsupported')
  return parent
}

async function outputRoot(path: string): Promise<string> {
  const absolute = resolve(path); const root = parse(absolute).root
  let current = root
  for (const part of relative(root, absolute).split(/[\\/]/).filter(Boolean)) {
    current = join(current, part)
    try { await mkdir(current, { mode: 0o700 }) }
    catch (error) { if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error }
    const info = await lstat(current)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new BridgeError('download-output-unsafe')
  }
  const canonical = await realpath(absolute)
  if (resolve(canonical) !== absolute) throw new BridgeError('download-output-unsafe')
  return canonical
}

interface RemoteMedia { relativePath: string; bytes: number; sha256: string; durationSeconds: number; width: number; height: number; hasAudio: boolean }
function mediaResult(value: unknown, params: Parameters, maxBytes: number): { media: RemoteMedia; title?: string; receiptReused: boolean; businessCalls: number } {
  if (!record(value) || value.operation !== 'download_first_episode' || value.status !== 'download-returned'
    || value.identityMatched !== true || value.srcAppId !== params.srcAppId || value.dramaId !== params.dramaId
    || value.serialNo !== 1 || value.isFirstMediaFree !== true || value.isStraight !== true || !record(value.media)
    || typeof value.receiptReused !== 'boolean' || !Number.isSafeInteger(value.businessCalls) || Number(value.businessCalls) < 0 || Number(value.businessCalls) > 2
    || (value.receiptReused === true && value.businessCalls !== 0)) throw new BridgeError('download-source-unconfirmed')
  const media = value.media
  if (typeof media.relativePath !== 'string' || !/^downloads\/[A-Za-z0-9_-]{1,128}\/media\/episode-01\.mp4$/.test(media.relativePath)
    || !Number.isSafeInteger(media.bytes) || Number(media.bytes) < 1 || Number(media.bytes) > maxBytes
    || typeof media.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(media.sha256)
    || typeof media.durationSeconds !== 'number' || !Number.isFinite(media.durationSeconds) || media.durationSeconds <= 0
    || !Number.isSafeInteger(media.width) || Number(media.width) <= 0 || !Number.isSafeInteger(media.height) || Number(media.height) <= 0
    || typeof media.hasAudio !== 'boolean' || media.fullDecodePassed !== true) throw new BridgeError('download-media-invalid')
  const title = typeof value.title === 'string' && value.title.length <= 300 && !/[\x00-\x1f]|https?:\/\//i.test(value.title) ? value.title : undefined
  return { receiptReused: value.receiptReused, businessCalls: Number(value.businessCalls), media: { relativePath: media.relativePath, bytes: Number(media.bytes), sha256: media.sha256,
    durationSeconds: media.durationSeconds, width: Number(media.width), height: Number(media.height), hasAudio: media.hasAudio }, ...(title === undefined ? {} : { title }) }
}

/** RequestPort decorator that commits a file only after local byte/hash verification. */
export class DownloadRequestPort implements RequestPort {
  private readonly lifetime = new AbortController()
  private readonly operations = new Set<Promise<unknown>>()
  private closing = false
  private disposal: Promise<void> | undefined
  private readonly parent: string
  private readonly cleanupFailures: BridgeError[] = []

  constructor(private readonly inner: RequestPort, private readonly subprocess: SubprocessRuntime,
    private readonly config: Config, private readonly options: DownloadOptions) {
    this.parent = validateDownloadOptions(config, options)
  }

  /**
   * Forward reads unchanged; a download requires a configured local copy lane.
   * @param action - High-level operation.
   * @param params - Validated source fields.
   * @param signal - Initiating cancellation.
   * @returns Ordinary helper JSON or locally verified download metadata.
   */
  request(action: Action, params: Parameters, signal: AbortSignal): Promise<unknown> {
    if (this.closing) return Promise.reject(new BridgeError('connection-closed'))
    const active = AbortSignal.any([signal, this.lifetime.signal])
    const work = this.perform(action, params, active)
    this.operations.add(work)
    void work.then(() => this.operations.delete(work), () => this.operations.delete(work))
    return work
  }

  private async perform(action: Action, params: Parameters, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted()
    if (action !== 'download_first_episode') return await this.inner.request(action, params, signal)
    if (!this.options.enabled) throw new BridgeError('capability-not-ready')
    if (typeof params.dramaId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(params.dramaId)
      || typeof params.srcAppId !== 'string' || !/^wx[0-9a-f]{16}$/.test(params.srcAppId)) throw new BridgeError('download-source-invalid')
    // Destination checks precede acquisition of a native media address.
    if (this.options.output !== undefined) await this.options.output.create()
    const root = this.options.output?.path ?? await outputRoot(this.options.outputDir)
    await this.options.output?.check()
    signal.throwIfAborted()
    const directory = join(root, randomUUID()); await mkdir(directory, { mode: 0o700 })
    const identity = await lstat(directory)
    const checkDirectory = async (): Promise<void> => {
      await this.options.output?.check()
      const current = await lstat(directory)
      if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== identity.dev || current.ino !== identity.ino
        || resolve(await realpath(directory)) !== directory) throw new BridgeError('download-output-replaced')
    }
    let committed = false
    let copyCleanupConfirmed = true
    try {
      await checkDirectory()
      const raw = await this.inner.request(action, params, signal)
      signal.throwIfAborted()
      await checkDirectory()
      const remote = mediaResult(raw, params, this.options.maxMediaBytes)
      const part = join(directory, 'episode-01.part'), file = join(directory, 'episode-01.mp4')
      const source = this.config.sshHostAlias + ':' + this.parent + '/' + remote.media.relativePath
      const active = AbortSignal.any([signal, AbortSignal.timeout(this.options.copyTimeoutMs)])
      const handle = this.subprocess.spawn({ argv: [this.options.scpExecutable, '-O', '-S', this.config.sshExecutable,
        '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ForwardAgent=no', source, part],
        cwd: this.config.cwd, stdio: { stdin: 'ignore', stdout: { maxBytes: 16384 }, stderr: { maxBytes: 16384 } },
        graceMs: this.config.shutdownTimeoutMs, signal: active })
      copyCleanupConfirmed = false
      let observedTooLarge = false
      let monitorWork: Promise<void> | undefined
      const monitor = setInterval(() => {
        if (monitorWork !== undefined) return
        monitorWork = lstat(part).then(info => {
          if (info.size > remote.media.bytes || info.size > this.options.maxMediaBytes) { observedTooLarge = true; handle.terminate() }
        }, error => { void error; /* The private part file may not yet exist. */ })
          .catch(error => { void error; /* Transfer completion still owns its exact exit and file verification. */ })
          .finally(() => { monitorWork = undefined })
      }, this.options.copyPollIntervalMs)
      let outcome: Awaited<typeof handle.done>
      try { outcome = await handle.done }
      finally {
        clearInterval(monitor)
        await monitorWork
        if (active.aborted) handle.terminate()
        const gone = await handle.waitForExit(AbortSignal.timeout(this.config.shutdownTimeoutMs))
        if (!gone) {
          const error = new BridgeError('download-copy-cleanup-unconfirmed')
          this.cleanupFailures.push(error); throw error
        }
        copyCleanupConfirmed = true
      }
      if (active.aborted) throw new BridgeError(signal.aborted ? 'cancelled' : 'download-copy-timeout')
      if (outcome.exitCode !== 0 || outcome.signal !== null) throw new BridgeError('download-copy-failed')
      if (observedTooLarge) throw new BridgeError('download-size-mismatch')
      await checkDirectory()
      const info = await lstat(part)
      if (!info.isFile() || info.isSymbolicLink() || info.size !== remote.media.bytes) throw new BridgeError('download-size-mismatch')
      const hash = createHash('sha256')
      for await (const chunk of createReadStream(part, { signal: active })) hash.update(chunk)
      if (hash.digest('hex') !== remote.media.sha256) throw new BridgeError('download-hash-mismatch')
      active.throwIfAborted()
      await checkDirectory()
      await link(part, file); await unlink(part)
      const receiptPath = join(directory, 'receipt.json')
      const media: LocalMedia = { localPath: file, receiptPath, bytes: remote.media.bytes, sha256: remote.media.sha256,
        durationSeconds: remote.media.durationSeconds, width: remote.media.width, height: remote.media.height,
        hasAudio: remote.media.hasAudio, fullDecodePassed: true }
      await checkDirectory()
      await writeFile(receiptPath, JSON.stringify({ kind: 'verified-first-episode-copy', srcAppId: params.srcAppId,
        dramaId: params.dramaId, episode: 1, helperSha256: this.config.helperSha256,
        receiptReused: remote.receiptReused, businessCalls: remote.businessCalls, media }, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
      signal.throwIfAborted(); committed = true
      return new VerifiedLocalResult({ srcAppId: params.srcAppId, dramaId: params.dramaId, ...('title' in remote ? { title: remote.title } : {}),
        receiptReused: remote.receiptReused, businessCalls: remote.businessCalls, media })
    } finally {
      if (!committed && copyCleanupConfirmed) {
        // Replaced ancestors must never turn cleanup into deletion outside this operation.
        await checkDirectory()
        await rm(directory, { recursive: true, force: true })
      }
    }
  }

  /** Stop admission, cancel owned copies, then await the underlying helper cleanup. */
  dispose(): Promise<void> {
    return this.disposal ??= (async () => {
      this.closing = true; this.lifetime.abort()
      await Promise.allSettled([...this.operations])
      await this.inner.dispose()
      if (this.cleanupFailures.length > 0) throw new AggregateError(this.cleanupFailures, 'download-copy-cleanup-unconfirmed')
    })()
  }
}
