/** Preserve original PUT behavior while suppressing SDK argument logging and emitting bounded diagnostics. */
import { createRequire } from 'node:module'
import { resolve } from 'node:path'

const publisher = process.env.MUSE_TOS_APPROVED_PUBLISHER
if (!publisher || !process.argv[1] || resolve(process.argv[1]) !== publisher) {
  throw new Error('Approved publisher entry is required')
}
const { S3Client, PutObjectCommand } = createRequire(publisher)('@aws-sdk/client-s3')
const original = S3Client.prototype.send
const networkCodes = new Set(['ETIMEDOUT', 'ECONNRESET', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH', 'ABORT_ERR'])
const integer = value => Number.isSafeInteger(value) && value >= 0 ? value : null
const report = event => process.stdout.write(`${JSON.stringify(event)}\n`)
S3Client.prototype.send = function (command, ...args) {
  if (!(command instanceof PutObjectCommand) || command.input.Bucket !== 'muse'
    || !/^releases\/(?:[0-9]+\.[0-9]+\.[0-9]+|feeds)\//u.test(command.input.Key)
    || args.some(value => typeof value === 'function')) return Reflect.apply(original, this, [command, ...args])
  const key = command.input.Key, started = performance.now()
  this.config.logger = { debug() {}, info() {}, warn() { report({ stage: 'sdk-log', level: 'warn', key }) },
    error() { report({ stage: 'sdk-log', level: 'error', key }) } }
  const facts = () => ({ key, elapsedMs: Math.round(performance.now() - started), contentLength: integer(command.input.ContentLength),
    sourceBytesRead: integer(command.input.Body?.bytesRead) })
  report({ stage: 'sdk-request-started', key, contentLength: integer(command.input.ContentLength) })
  return Reflect.apply(original, this, [command, ...args]).then(result => {
    report({ stage: 'sdk-request-completed', ...facts(), status: integer(result?.$metadata?.httpStatusCode),
      attempts: integer(result?.$metadata?.attempts) })
    return result
  }, error => {
    report({ stage: 'sdk-request-failed', ...facts(), status: integer(error?.$metadata?.httpStatusCode),
      attempts: integer(error?.$metadata?.attempts), totalRetryDelayMs: integer(error?.$metadata?.totalRetryDelay),
      code: networkCodes.has(error?.code) ? error.code : null,
      syscall: ['read', 'write', 'connect', 'getaddrinfo'].includes(error?.syscall) ? error.syscall : null })
    throw error
  })
}
