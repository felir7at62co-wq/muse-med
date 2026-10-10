/** Intercept only sealed large binary PUTs; retain the original publisher's public verification and feed order. */
import { ReadStream, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { isAbsolute, join } from 'node:path'
import { MultipartUploadFailure, uploadImmutableMultipart } from './tos-multipart-immutable.mjs'
import { validateTransferSeal } from './transfer.mjs'

/** Exact original publication seal bytes approved for this release transport. */
export const APPROVED_MULTIPART_SEAL_SHA256 = 'f1a8b957392ba1ab6ae4544e996cd48c4f3d9d70b99e228f7fcc9081dd23b24d'
const approvedSealBytes = readFileSync(new URL('./seal.json', import.meta.url))
check(createHash('sha256').update(approvedSealBytes).digest('hex') === APPROVED_MULTIPART_SEAL_SHA256)
const approvedSeal = validateTransferSeal(JSON.parse(approvedSealBytes.toString('utf8')))
const version = '1.0.5'
const binaries = [
  ['mac-arm64', 'muse-med-1.0.5-mac-arm64.dmg', 'application/x-apple-diskimage'],
  ['mac-arm64', 'muse-med-1.0.5-mac-arm64.zip', 'application/zip'],
  ['mac-arm64', 'muse-med-1.0.5-mac-arm64.zip.blockmap', 'application/octet-stream'],
  ['win-x64', 'muse-med-1.0.5-win-x64.exe', 'application/vnd.microsoft.portable-executable'],
  ['win-x64', 'muse-med-1.0.5-win-x64.exe.blockmap', 'application/octet-stream'],
]
const allNames = new Set([...binaries.map(([, name]) => name), 'latest-mac.yml', 'rc-mac.yml', 'latest.yml', 'rc.yml',
  'muse-desktop-builds.json', 'muse-desktop-SHA256SUMS.txt'])
const keys = ['Bucket', 'Key', 'Body', 'ContentLength', 'ContentType', 'CacheControl', 'IfNoneMatch']
function check(condition) {
  if (!condition) throw new Error('Muse TOS: sealed multipart bridge input validation failed.')
}

/**
 * Install a reversible SDK send interceptor with injectable upload function for pure owner tests.
 * @param options - Pinned release seal, original artifact directories and SDK classes, optional selectedKeys subset and owned transport factory, plus safe JSON events. Transport disposal failures prevent successful publication; upload errors remain primary.
 * @returns Function restoring the original SDK send method; import and installation perform no upload.
 */
export function installSealedMultipartBridge({ S3Client, PutObjectCommand, S3ServiceException, commands, seal, artifactDirectories, selectedKeys,
  createMultipartTransport, multipartUpload = uploadImmutableMultipart, onEvent = () => {} }) {
  validateTransferSeal(seal)
  check(seal.version === version && seal.sourceCommit === approvedSeal.sourceCommit && seal.sourceRun === approvedSeal.sourceRun)
  const files = new Map()
  for (const file of seal.files) {
    check(allNames.has(file.filename) && !files.has(file.filename) && Number.isSafeInteger(file.size) && file.size > 0 &&
      /^[a-f0-9]{64}$/u.test(file.sha256))
    files.set(file.filename, file)
  }
  const sealed = new Map(binaries.map(([target, filename, contentType]) => {
    check(typeof artifactDirectories?.[target] === 'string' && isAbsolute(artifactDirectories[target]))
    const { size, sha256 } = files.get(filename)
    const key = `releases/${version}/${target}/${filename}`
    return [key, { key, path: join(artifactDirectories[target], filename), size, sha256, contentType }]
  }))
  const largeKeys = new Set([...sealed].filter(([, file]) => /\.(?:dmg|zip|exe)$/u.test(file.path) && file.size > 8 * 1024 ** 2).map(([key]) => key))
  check(selectedKeys === undefined || Array.isArray(selectedKeys) && selectedKeys.length > 0
    && new Set(selectedKeys).size === selectedKeys.length && selectedKeys.every(key => largeKeys.has(key)))
  const selected = selectedKeys === undefined ? largeKeys : new Set(selectedKeys)
  check(typeof S3Client?.prototype?.send === 'function' && typeof PutObjectCommand === 'function' && typeof S3ServiceException === 'function')
  const originalSend = S3Client.prototype.send
  function send(command, options) {
    if (!(command instanceof PutObjectCommand) || !selected.has(command.input.Key)) return Reflect.apply(originalSend, this, arguments)
    const file = sealed.get(command.input.Key), input = command.input
    // The original publisher owns small blockmaps, as well as all four mutable feeds.
    if (file.size <= 8 * 1024 ** 2) return Reflect.apply(originalSend, this, arguments)
    const client = this
    return (async () => {
    check(Object.keys(input).length === keys.length && keys.every(key => Object.hasOwn(input, key)))
    check(input.Bucket === 'muse' && input.ContentLength === file.size && input.ContentType === file.contentType &&
      input.CacheControl === 'public, max-age=31536000, immutable' && input.IfNoneMatch === '*' &&
      input.Body instanceof ReadStream && input.Body.path === file.path && input.Body.bytesRead === 0 && !input.Body.destroyed)
    check(options?.abortSignal instanceof AbortSignal)
    // Suppress Smithy's raw streaming-error console fallback; never forward SDK log arguments.
    const reportSdk = level => {
      try { onEvent({ stage: 'sdk-log', level, key: file.key }) }
      catch (_error) { /* Diagnostics do not replace upload outcomes. */ }
    }
    const logger = { debug() {}, info() {}, warn() { reportSdk('warn') }, error() { reportSdk('error') } }
    let transport, successfulResult = false, primaryFailure, cleanupReported = false
    const cleanupDetails = () => ({ phase: 'transport-cleanup', status: null,
      completion: successfulResult ? 'committed-or-existing' : 'unknown',
      cleanup: { state: 'transport-disposal-failed', status: null } })
    const reportCleanupFailure = () => {
      if (cleanupReported) return
      cleanupReported = true
      try { onEvent({ stage: 'multipart-failed', key: file.key, details: cleanupDetails() }) }
      catch (_error) { /* Diagnostic failures do not replace the upload or disposal outcome. */ }
    }
    try {
      let uploadClient = client
      if (createMultipartTransport) {
        transport = createMultipartTransport({ sourceClient: client, logger, onCleanupFailure: reportCleanupFailure })
        uploadClient = transport.client
      } else client.config.logger = logger
      const result = await multipartUpload({ client: uploadClient, file, commands, signal: options.abortSignal, partSize: 8 * 1024 ** 2,
        maxPartAttempts: 2, onEvent })
      check(result?.publicVerificationRequired === true && ['uploaded', 'already-exists'].includes(result.outcome))
      successfulResult = true
      onEvent({ stage: 'multipart-finished', key: file.key, outcome: result.outcome, publicVerificationRequired: true })
      if (result.outcome === 'already-exists') throw new S3ServiceException({ name: 'PreconditionFailed', $fault: 'client',
        $metadata: { httpStatusCode: 412 }, message: 'Muse TOS: immutable object exists; complete public verification is required.' })
      return { $metadata: { httpStatusCode: 200 } }
    } catch (error) {
      primaryFailure = error
      if (error instanceof MultipartUploadFailure) {
        try { onEvent({ stage: 'multipart-failed', key: file.key, details: error.details }) }
        catch (_diagnosticError) { /* Upload failure remains primary when its diagnostic observer fails. */ }
      }
      throw error
    } finally {
      if (transport) {
        try { transport.dispose() }
        catch (_error) {
          reportCleanupFailure()
          // An accepted 412 is an upload result; failed transport disposal must prevent channel promotion.
          if (!primaryFailure || successfulResult) throw new MultipartUploadFailure(cleanupDetails())
        }
      }
    }
    })()
  }
  S3Client.prototype.send = send
  return () => { check(S3Client.prototype.send === send); S3Client.prototype.send = originalSend }
}
