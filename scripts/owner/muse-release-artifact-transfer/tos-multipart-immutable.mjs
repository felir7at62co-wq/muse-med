/** Serial, conditional multipart writes using the existing official AWS S3 SDK; importing performs no upload. */
import { constants } from 'node:fs'
import fs from 'node:fs/promises'
import { createHash } from 'node:crypto'
const MiB = 1024 ** 2
const allowedKeys = new Set([
  'releases/1.0.5/mac-arm64/muse-med-1.0.5-mac-arm64.dmg',
  'releases/1.0.5/mac-arm64/muse-med-1.0.5-mac-arm64.zip',
  'releases/1.0.5/mac-arm64/muse-med-1.0.5-mac-arm64.zip.blockmap',
  'releases/1.0.5/win-x64/muse-med-1.0.5-win-x64.exe',
  'releases/1.0.5/win-x64/muse-med-1.0.5-win-x64.exe.blockmap',
])

function status(error) {
  const value = error?.$metadata?.httpStatusCode
  return Number.isInteger(value) && value >= 100 && value <= 599 ? value : null
}

function retryable(error) {
  const http = status(error)
  if (http !== null) return http === 408 || http === 429 || http >= 500
  return ['ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ECONNABORTED'].includes(error?.code) || error?.name === 'TimeoutError'
}

function safeError(error) {
  const names = ['TimeoutError', 'AbortError', 'Error', 'TypeError', 'RequestTimeout', 'PreconditionFailed', 'NoSuchUpload']
  const codes = ['ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ECONNABORTED', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ABORT_ERR']
  const integer = value => Number.isSafeInteger(value) && value >= 0 ? value : null
  return { errorName: names.includes(error?.name) ? error.name : 'SDKError',
    code: codes.includes(error?.code) ? error.code : null,
    syscall: ['read', 'write', 'connect', 'getaddrinfo'].includes(error?.syscall) ? error.syscall : null,
    status: status(error), attempts: integer(error?.$metadata?.attempts), totalRetryDelayMs: integer(error?.$metadata?.totalRetryDelay) }
}

function check(condition) {
  if (!condition) throw new Error('Sealed multipart input validation failed')
}

async function exactBuffer(handle, offset, length) {
  const bytes = Buffer.alloc(length)
  let position = 0
  while (position < length) {
    const read = await handle.read(bytes, position, length - position, offset + position)
    check(read.bytesRead > 0)
    position += read.bytesRead
  }
  return bytes
}

async function sealedHash(handle, size) {
  const hash = createHash('sha256')
  for (let offset = 0; offset < size; offset += MiB) hash.update(await exactBuffer(handle, offset, Math.min(MiB, size - offset)))
  const after = await handle.stat()
  check(after.isFile() && after.size === size)
  return hash.digest('hex')
}

/** Fixed safe diagnostics, without credentials, URLs, upload IDs or raw SDK errors. */
export class MultipartUploadFailure extends Error {
  constructor(details) {
    super('Muse TOS: multipart upload did not complete; reconcile the object before retrying.')
    this.name = 'MultipartUploadFailure'
    this.details = Object.freeze(details)
  }
}

/**
 * Stage immutable release bytes serially, then atomically complete only if the key is absent.
 * @param options - Existing S3 client and command classes from its same SDK module, maxAttempts:1, sealed file, partSize (8–64MiB), maxPartAttempts (1–3), requestTimeoutMs (1–600 seconds), optional whole-operation signal and safe event observer. A part deadline may retry within the part bound; whole-operation cancellation never retries.
 * @returns Upload/precondition result requiring the original publisher's complete anonymous size/SHA256 verification before any feed update.
 */
export async function uploadImmutableMultipart({ client, file, commands, partSize = 8 * MiB, maxPartAttempts = 2,
  requestTimeoutMs = 120000, signal, onEvent = () => {} }) {
  let handle, uploadId, failure, phase = 'local-verification'
  let completed = false
  const { CreateMultipartUploadCommand, UploadPartCommand, CompleteMultipartUploadCommand, AbortMultipartUploadCommand } = commands ?? {}
  const requestSignal = () => signal ? AbortSignal.any([signal, AbortSignal.timeout(requestTimeoutMs)]) : AbortSignal.timeout(requestTimeoutMs)
  async function send(command, requestPhase, abortSignal) {
    const started = performance.now()
    onEvent({ stage: 'multipart-sdk-request-started', key: file.key, phase: requestPhase })
    try {
      const response = await client.send(command, { abortSignal })
      onEvent({ stage: 'multipart-sdk-request-completed', key: file.key, phase: requestPhase,
        elapsedMs: Math.round(performance.now() - started), status: status(response) })
      return response
    } catch (error) {
      onEvent({ stage: 'multipart-sdk-request-failed', key: file.key, phase: requestPhase,
        elapsedMs: Math.round(performance.now() - started), ...safeError(error) })
      throw error
    }
  }
  async function abortOwned() {
    if (!uploadId) return { state: phase === 'create' ? 'unknown-upload-id' : 'not-created', status: null }
    try {
      // Do not reuse the cancelled upload signal: cleanup needs its own finite deadline.
      await send(new AbortMultipartUploadCommand({ Bucket: 'muse', Key: file.key, UploadId: uploadId }), 'abort', AbortSignal.timeout(30000))
      return { state: 'aborted', status: null }
    } catch (error) {
      if (status(error) === 404 || error?.name === 'NoSuchUpload') return { state: 'no-such-upload', status: 404 }
      return { state: 'abort-failed', status: status(error), error: safeError(error) }
    }
  }
  try {
    check(file !== null && typeof file === 'object' && allowedKeys.has(file.key))
    check(typeof file.path === 'string' && Number.isSafeInteger(file.size) && file.size > 0 && /^[a-f0-9]{64}$/u.test(file.sha256))
    check(typeof file.contentType === 'string' && Number.isSafeInteger(partSize) && partSize >= 8 * MiB && partSize <= 64 * MiB)
    check(Number.isSafeInteger(maxPartAttempts) && maxPartAttempts >= 1 && maxPartAttempts <= 3)
    check(Number.isSafeInteger(requestTimeoutMs) && requestTimeoutMs >= 1000 && requestTimeoutMs <= 600000)
    check(Math.ceil(file.size / partSize) <= 10000 && Number.isInteger(constants.O_NOFOLLOW))
    check(typeof client?.send === 'function' && typeof client.config?.maxAttempts === 'function' && await client.config.maxAttempts() === 1)
    check([CreateMultipartUploadCommand, UploadPartCommand, CompleteMultipartUploadCommand, AbortMultipartUploadCommand].every(command => typeof command === 'function'))
    signal?.throwIfAborted()
    handle = await fs.open(file.path, constants.O_RDONLY | constants.O_NOFOLLOW)
    const initial = await handle.stat()
    check(initial.isFile() && initial.size === file.size && await sealedHash(handle, file.size) === file.sha256)
    signal?.throwIfAborted()
    phase = 'create'
    const created = await send(new CreateMultipartUploadCommand({ Bucket: 'muse', Key: file.key,
      ContentType: file.contentType, CacheControl: 'public, max-age=31536000, immutable',
      Metadata: { sha256: file.sha256 } }), 'create', requestSignal())
    check(typeof created.UploadId === 'string' && created.UploadId.length > 0)
    uploadId = created.UploadId
    onEvent({ status: 'multipart-created', key: file.key, concurrency: 1, partSize, maxPartAttempts })
    const parts = [], transmittedHash = createHash('sha256')
    let byteCount = 0
    for (let offset = 0, partNumber = 1; offset < file.size; offset += partSize, partNumber++) {
      phase = 'part'
      signal?.throwIfAborted()
      const body = await exactBuffer(handle, offset, Math.min(partSize, file.size - offset))
      transmittedHash.update(body)
      byteCount += body.length
      let response
      for (let attempt = 1; attempt <= maxPartAttempts; attempt++) {
        signal?.throwIfAborted()
        const attemptSignal = requestSignal()
        try {
          response = await send(new UploadPartCommand({ Bucket: 'muse', Key: file.key, UploadId: uploadId,
            PartNumber: partNumber, ContentLength: body.length, Body: body }), 'part', attemptSignal)
          break
        } catch (error) {
          const ownDeadline = status(error) === null && error?.name === 'AbortError' && attemptSignal.aborted
            && attemptSignal.reason?.name === 'TimeoutError'
          if (signal?.aborted || attempt === maxPartAttempts || !(ownDeadline || retryable(error))) throw error
          onEvent({ status: 'multipart-part-retry', key: file.key, partNumber, attempt })
        }
      }
      check(typeof response?.ETag === 'string' && response.ETag.trim().length > 0 && !/[\r\n]/u.test(response.ETag))
      parts.push({ PartNumber: partNumber, ETag: response.ETag })
      onEvent({ status: 'multipart-part-staged', key: file.key, partNumber, byteCount })
    }
    phase = 'local-verification'
    check(byteCount === file.size && transmittedHash.digest('hex') === file.sha256 && (await handle.stat()).size === file.size)
    phase = 'complete'
    signal?.throwIfAborted()
    try {
      await send(new CompleteMultipartUploadCommand({ Bucket: 'muse', Key: file.key, UploadId: uploadId,
        MultipartUpload: { Parts: parts }, IfNoneMatch: '*' }), 'complete', requestSignal())
      completed = true
      return { outcome: 'uploaded', parts: parts.length, byteCount, publicVerificationRequired: true }
    } catch (error) {
      if (status(error) !== 412) throw error
      const cleanup = await abortOwned()
      if (cleanup.state === 'abort-failed') throw new MultipartUploadFailure({ phase, status: 412,
        completion: 'existing-object', cleanup })
      completed = true
      return { outcome: 'already-exists', parts: parts.length, byteCount, cleanup, publicVerificationRequired: true }
    }
  } catch (error) {
    if (error instanceof MultipartUploadFailure) { failure = error; throw error }
    const cleanup = completed ? { state: 'not-needed', status: null } : await abortOwned()
    failure = new MultipartUploadFailure({ phase, status: status(error), error: safeError(error),
      completion: phase === 'complete' || phase === 'create' ? 'unknown' : 'not-completed', cleanup })
    throw failure
  } finally {
    if (handle) {
      try { await handle.close() }
      catch (error) {
        if (failure) throw new MultipartUploadFailure({ ...failure.details, fileCloseFailed: true })
        throw new MultipartUploadFailure({ phase: 'file-close', status: null,
          completion: completed ? 'committed-or-existing' : 'unknown', cleanup: { state: 'file-close-failed', status: null } })
      }
    }
  }
}
