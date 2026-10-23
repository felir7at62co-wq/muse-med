/** Resumable copy of one original native episode request into its Session-owned directory. */
import { createHash } from 'node:crypto'
import { constants, createReadStream, type Stats } from 'node:fs'
import { lstat, open, readFile, realpath, link, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep, win32 } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { Config } from './config.ts'
import { verifiedEpisodeDownload, type LocalMedia } from './download.ts'
import { childOutput, type OutputDirectory } from './output.ts'
import { BridgeError, type Action, type Parameters, type RequestPort } from './port.ts'

/** Session output, original operation directory, and deployment-owned copy bounds. */
export interface EpisodeCopyOptions {
  readonly output: OutputDirectory
  readonly directory: string
  readonly chunkBytes: number
  readonly maxMediaBytes: number
  readonly copyTimeoutMs: number
}
interface Media {
  relativePath: string; bytes: number; sha256: string; durationSeconds: number
  width: number; height: number; hasAudio: boolean
}
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const missing = (error: unknown): boolean => error instanceof Error && 'code' in error && error.code === 'ENOENT'
const inside = (root: string, path: string): boolean => {
  const suffix = relative(root, path)
  return suffix !== '' && suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix)
}
const fileName = (episodeNo: number): string => `episode-${String(episodeNo).padStart(4, '0')}.mp4`

function response(value: unknown, params: Parameters, limit: number): { media: Media; reused: boolean; calls: number; title?: string } {
  if (!record(value) || value.operation !== 'download_episode' || value.srcAppId !== params.srcAppId
    || value.dramaId !== params.dramaId || value.episodeNo !== params.episodeNo || value.idempotencyKey !== params.idempotencyKey) throw new BridgeError('download-source-unconfirmed')
  if (value.status !== 'download-returned') {
    if (typeof value.status === 'string' && /^[a-z][a-z0-9-]{0,95}$/.test(value.status)) throw new BridgeError(value.status)
    throw new BridgeError('invalid-response')
  }
  if (value.identityMatched !== true || value.serialNo !== params.episodeNo || value.isStraight !== true
    || value.playAuthorization !== 'native-straight-playback' || typeof value.receiptReused !== 'boolean'
    || !Number.isSafeInteger(value.businessCalls) || Number(value.businessCalls) < 0 || Number(value.businessCalls) > 2
    || value.receiptReused && value.businessCalls !== 0 || !record(value.media)) throw new BridgeError('download-source-unconfirmed')
  const media = value.media
  if (media.relativePath !== `downloads/${params.idempotencyKey}/media/${fileName(Number(params.episodeNo))}`
    || !Number.isSafeInteger(media.bytes) || Number(media.bytes) <= 0 || Number(media.bytes) > limit
    || typeof media.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(media.sha256)
    || typeof media.durationSeconds !== 'number' || !Number.isFinite(media.durationSeconds) || media.durationSeconds <= 0
    || !Number.isSafeInteger(media.width) || Number(media.width) <= 0 || !Number.isSafeInteger(media.height) || Number(media.height) <= 0
    || typeof media.hasAudio !== 'boolean' || media.fullDecodePassed !== true) throw new BridgeError('download-media-invalid')
  const title = typeof value.title === 'string' && value.title.length <= 300 && !/[\x00-\x1f]|https?:\/\//i.test(value.title) ? value.title : undefined
  return { media: { relativePath: String(media.relativePath), bytes: Number(media.bytes), sha256: media.sha256,
    durationSeconds: media.durationSeconds, width: Number(media.width), height: Number(media.height), hasAudio: media.hasAudio },
    reused: value.receiptReused, calls: Number(value.businessCalls), ...(title === undefined ? {} : { title }) }
}
async function hashFile(path: string, signal: AbortSignal): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const before = await handle.stat()
    if (!before.isFile()) throw new BridgeError('download-output-unsafe')
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(path, { fd: handle.fd, autoClose: false, signal })) hash.update(chunk)
    const after = await handle.stat()
    if (!sameFile(before, after)) throw new BridgeError('download-output-replaced')
    return hash.digest('hex')
  } finally { await handle.close() }
}
function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs
}
async function regular(path: string): Promise<Stats> {
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new BridgeError('download-output-unsafe')
  return info
}

/** Each copy owns its cancellation and children; it only borrows the Host's native connection. */
export class EpisodeDownloadRequestPort implements RequestPort {
  private readonly lifetime = new AbortController()
  private readonly work = new Set<Promise<unknown>>()
  private cleanupFailed = false
  private closing = false
  private disposal: Promise<void> | undefined

  constructor(private readonly inner: RequestPort, private readonly subprocess: SubprocessRuntime,
    private readonly config: Config, private readonly options: EpisodeCopyOptions) {
    if (!Number.isSafeInteger(options.chunkBytes) || options.chunkBytes < 1 || options.chunkBytes > 8388608
      || !Number.isSafeInteger(options.copyTimeoutMs) || options.copyTimeoutMs < 1000
      || !Number.isSafeInteger(options.maxMediaBytes) || options.maxMediaBytes < 1) throw new BridgeError('download-bound-invalid')
  }

  /**
   * Reuse an original key for native acquisition and verified local publication.
   * @param action - Download or metadata-only status reconciliation.
   * @param params - Exact source, episode and original durable idempotency key.
   * @param signal - Request cancellation, independent of the shared Host.
   * @returns Trusted local media only after complete byte and hash verification.
   */
  request(action: Action, params: Parameters, signal: AbortSignal): Promise<unknown> {
    if (this.closing) return Promise.reject(new BridgeError('connection-closed'))
    const active = AbortSignal.any([signal, this.lifetime.signal])
    const work = this.perform(action, params, active)
    this.work.add(work)
    void work.then(() => this.work.delete(work), () => this.work.delete(work))
    return work
  }

  private async perform(action: Action, params: Parameters, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted()
    if (action !== 'download_episode' && action !== 'download_status') return await this.inner.request(action, params, signal)
    if (typeof params.srcAppId !== 'string' || !/^wx[0-9a-f]{16}$/.test(params.srcAppId)
      || typeof params.dramaId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(params.dramaId)
      || !Number.isSafeInteger(params.episodeNo) || Number(params.episodeNo) < 1
      || typeof params.idempotencyKey !== 'string' || !/^[a-f0-9]{64}$/.test(params.idempotencyKey)) throw new BridgeError('invalid-arguments')
    const output = childOutput(this.options.output, this.options.directory)
    await output.check()
    const raw = await this.inner.request(action, params, signal)
    if (!record(raw) || raw.operation !== 'download_episode' || raw.srcAppId !== params.srcAppId
      || raw.dramaId !== params.dramaId || raw.episodeNo !== params.episodeNo
      || raw.idempotencyKey !== params.idempotencyKey) throw new BridgeError('download-source-unconfirmed')
    if (action === 'download_status' && record(raw) && raw.status !== 'download-returned') return raw
    const remote = response(raw, params, this.options.maxMediaBytes)
    signal.throwIfAborted()
    await output.create(); await output.check()
    const file = join(output.path, fileName(Number(params.episodeNo)))
    const part = file + '.part', transfer = file + '.copy.json', receiptPath = file + '.receipt.json'
    const binding = { schemaVersion: 1, srcAppId: params.srcAppId, dramaId: params.dramaId,
      episodeNo: params.episodeNo, idempotencyKey: params.idempotencyKey, bytes: remote.media.bytes, sha256: remote.media.sha256 }
    let complete = false
    let verifiedFile: Stats | undefined
    try {
      const present = await regular(file)
      if (present.size !== remote.media.bytes || await hashFile(file, signal) !== remote.media.sha256) throw new BridgeError('download-existing-file-mismatch')
      verifiedFile = await regular(file)
      if (!sameFile(present, verifiedFile)) throw new BridgeError('download-output-replaced')
      complete = true
    } catch (error) { if (!missing(error)) throw error }
    if (!complete) {
      try {
        await regular(transfer)
        const prior: unknown = JSON.parse(await readFile(transfer, 'utf8'))
        if (JSON.stringify(prior) !== JSON.stringify(binding)) throw new BridgeError('download-copy-binding-conflict')
      } catch (error) {
        if (!missing(error)) throw error
        try { await lstat(part); throw new BridgeError('download-unowned-partial') }
        catch (failure) { if (!missing(failure)) throw failure }
        await output.check(); await writeFileAtomic(transfer, JSON.stringify(binding), { mode: 0o600 })
      }
      const active = AbortSignal.any([signal, AbortSignal.timeout(this.options.copyTimeoutMs)])
      if (this.config.transport === 'local') await this.copyLocal(remote.media, part, output, active)
      else await this.copySsh(remote.media, part, active)
      await output.check()
      const copied = await regular(part)
      if (copied.size !== remote.media.bytes || await hashFile(part, active) !== remote.media.sha256) throw new BridgeError('download-hash-mismatch')
      active.throwIfAborted(); await output.check()
      if (!sameFile(copied, await regular(part))) throw new BridgeError('download-output-replaced')
      await link(part, file)
      const published = await lstat(file)
      try {
        if (published.dev !== copied.dev || published.ino !== copied.ino || published.size !== copied.size
          || await hashFile(file, active) !== remote.media.sha256) throw new BridgeError('download-output-replaced')
        const currentPart = await lstat(part)
        if (currentPart.dev !== copied.dev || currentPart.ino !== copied.ino) throw new BridgeError('download-output-replaced')
        await unlink(part)
        verifiedFile = await regular(file)
        if (verifiedFile.dev !== published.dev || verifiedFile.ino !== published.ino || verifiedFile.size !== published.size
          || verifiedFile.mtimeMs !== published.mtimeMs) throw new BridgeError('download-output-replaced')
      } catch (error) {
        const currentFile = await lstat(file)
        if (currentFile.dev === published.dev && currentFile.ino === published.ino) await unlink(file)
        throw error
      }
    }
    const media: LocalMedia = { localPath: file, receiptPath, bytes: remote.media.bytes, sha256: remote.media.sha256,
      durationSeconds: remote.media.durationSeconds, width: remote.media.width, height: remote.media.height,
      hasAudio: remote.media.hasAudio, fullDecodePassed: true }
    await output.check(); signal.throwIfAborted()
    if (verifiedFile === undefined || !sameFile(verifiedFile, await regular(file))) throw new BridgeError('download-output-replaced')
    await writeFileAtomic(receiptPath, JSON.stringify({ ...binding, kind: 'verified-episode-copy',
      helperSha256: this.config.helperSha256, media, receiptReused: remote.reused }, null, 2) + '\n', { mode: 0o600 })
    if (!sameFile(verifiedFile, await regular(file))) throw new BridgeError('download-output-replaced')
    return verifiedEpisodeDownload({ srcAppId: params.srcAppId, dramaId: params.dramaId,
      episodeNo: Number(params.episodeNo), playAuthorization: 'native-straight-playback',
      receiptReused: remote.reused, businessCalls: remote.calls, media, ...(remote.title === undefined ? {} : { title: remote.title }) })
  }

  private async copyLocal(media: Media, part: string, output: OutputDirectory, signal: AbortSignal): Promise<void> {
    const root = await realpath(dirname(this.config.localHelper))
    const source = resolve(root, media.relativePath)
    if (!inside(root, source)) throw new BridgeError('download-source-unconfirmed')
    let path = root
    for (const component of relative(root, source).split(sep)) {
      path = join(path, component)
      const info = await lstat(path)
      if (info.isSymbolicLink() || resolve(await realpath(path)) !== path) throw new BridgeError('download-source-unconfirmed')
    }
    const original = await regular(source)
    if (original.size !== media.bytes) throw new BridgeError('download-size-mismatch')
    const input = await open(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    let destination: Awaited<ReturnType<typeof open>> | undefined
    try {
      await output.check()
      let offset = 0
      try { offset = (await regular(part)).size }
      catch (error) { if (!missing(error)) throw error }
      if (offset > media.bytes) throw new BridgeError('download-size-mismatch')
      destination = await open(part, constants.O_RDWR | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0), 0o600)
      const initial = await destination.stat()
      if (!initial.isFile() || initial.nlink !== 1 || initial.size !== offset) throw new BridgeError('download-output-unsafe')
      const buffer = Buffer.alloc(this.options.chunkBytes), other = Buffer.alloc(this.options.chunkBytes)
      for (let position = 0; position < offset;) {
        signal.throwIfAborted()
        const count = Math.min(buffer.length, offset - position)
        const [left, right] = await Promise.all([input.read(buffer, 0, count, position), destination.read(other, 0, count, position)])
        if (left.bytesRead !== count || right.bytesRead !== count || !buffer.subarray(0, count).equals(other.subarray(0, count))) throw new BridgeError('download-prefix-mismatch')
        position += count
      }
      while (offset < media.bytes) {
        signal.throwIfAborted(); await output.check()
        const current = await regular(part)
        if (current.dev !== initial.dev || current.ino !== initial.ino) throw new BridgeError('download-output-replaced')
        const count = Math.min(buffer.length, media.bytes - offset)
        const read = await input.read(buffer, 0, count, offset)
        if (read.bytesRead !== count) throw new BridgeError('download-size-mismatch')
        let written = 0
        while (written < count) {
          const progress = (await destination.write(buffer, written, count - written, offset + written)).bytesWritten
          if (progress <= 0) throw new BridgeError('download-copy-failed')
          written += progress
        }
        offset += count
      }
      await destination.sync()
      const after = await input.stat()
      if (after.dev !== original.dev || after.ino !== original.ino || after.size !== original.size || after.mtimeMs !== original.mtimeMs) throw new BridgeError('download-source-unconfirmed')
    } finally { await destination?.close(); await input.close() }
  }

  private async copySsh(media: Media, part: string, signal: AbortSignal): Promise<void> {
    const parent = win32.dirname(this.config.remoteHelper).replaceAll('\\', '/')
    if (!/^[A-Za-z]:\/[A-Za-z0-9_./-]+$/.test(parent)) throw new BridgeError('download-remote-path-unsupported')
    try { await lstat(part); throw new BridgeError('download-remote-copy-resume-unavailable') }
    catch (error) { if (!missing(error)) throw error }
    const handle = this.subprocess.spawn({ argv: [this.config.scpExecutable, '-O', '-S', this.config.sshExecutable,
      '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ForwardAgent=no',
      `${this.config.sshHostAlias}:${parent}/${media.relativePath}`, part], cwd: this.config.cwd,
      stdio: { stdin: 'ignore', stdout: { maxBytes: 16384 }, stderr: { maxBytes: 16384 } }, signal, graceMs: this.config.shutdownTimeoutMs })
    let result
    try { result = await handle.done }
    finally {
      if (signal.aborted) handle.terminate()
      if (!await handle.waitForExit(AbortSignal.timeout(this.config.shutdownTimeoutMs))) {
        this.cleanupFailed = true; throw new BridgeError('download-copy-cleanup-unconfirmed')
      }
    }
    signal.throwIfAborted()
    if (result.exitCode !== 0 || result.signal !== null) throw new BridgeError('download-copy-failed')
  }

  /** Cancel only this copy and wait for all owned file handles or children. */
  dispose(): Promise<void> {
    return this.disposal ??= (async () => {
      this.closing = true; this.lifetime.abort(); await Promise.allSettled([...this.work])
      if (this.cleanupFailed) throw new BridgeError('download-copy-cleanup-unconfirmed')
    })()
  }
}
