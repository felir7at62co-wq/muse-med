import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, open, readFile, rm, symlink, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import fs from 'node:fs/promises'
import { MultipartUploadFailure, uploadImmutableMultipart } from './tos-multipart-immutable.mjs'
import { createReadStream } from 'node:fs'
import { finished } from 'node:stream/promises'
import { installSealedMultipartBridge } from './tos-multipart-bridge.mjs'
import { createTosPublisherObserver } from './tos-publish.mjs'

class CreateMultipartUploadCommand { constructor(input) { this.input = input } }
class UploadPartCommand { constructor(input) { this.input = input } }
class CompleteMultipartUploadCommand { constructor(input) { this.input = input } }
class AbortMultipartUploadCommand { constructor(input) { this.input = input } }
const commands = { CreateMultipartUploadCommand, UploadPartCommand, CompleteMultipartUploadCommand, AbortMultipartUploadCommand }
const winKey = 'releases/1.0.5/win-x64/muse-med-1.0.5-win-x64.exe'
const approvedBatch = JSON.parse(await readFile(new URL('./seal.json', import.meta.url), 'utf8'))

const MiB = 1024 ** 2
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const wireError = (http, code) => Object.assign(new Error('synthetic-private-token; signed URL must not leak'),
  { ...(http ? { $metadata: { httpStatusCode: http } } : {}), ...(code ? { code } : {}) })

async function multipartFixture(t, bytes = Buffer.from('synthetic immutable file\n')) {
  const root = await mkdtemp(join(tmpdir(), 'muse-tos-multipart-'))
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))
  const path = join(root, 'immutable binary')
  await writeFile(path, bytes)
  const file = { path, key: 'releases/1.0.5/mac-arm64/muse-med-1.0.5-mac-arm64.dmg',
    size: bytes.length, sha256: hash(bytes), contentType: 'application/octet-stream' }
  const calls = [], events = []
  let active = 0, maximumActive = 0
  const f = { root, file, calls, events, bytes, handler: undefined }
  f.client = { config: { maxAttempts: async () => 1 }, async send(command, options) {
    calls.push({ name: command.constructor.name, input: command.input, options })
    active++; maximumActive = Math.max(maximumActive, active)
    try {
      await Promise.resolve()
      if (f.handler) return await f.handler(command, options)
      if (command.constructor.name === 'CreateMultipartUploadCommand') return { UploadId: 'synthetic-upload-id' }
      if (command.constructor.name === 'UploadPartCommand') return { ETag: `"part-${command.input.PartNumber}"` }
      if (command.constructor.name === 'CompleteMultipartUploadCommand' || command.constructor.name === 'AbortMultipartUploadCommand') return {}
      assert.fail('An unapproved command was called')
    } finally { active-- }
  } }
  f.run = options => uploadImmutableMultipart({ client: f.client, file, commands, onEvent: event => events.push(event), ...options })
  f.count = name => calls.filter(call => call.name === name).length
  f.maximumActive = () => maximumActive
  return f
}

function defaults(command) {
  if (command.constructor.name === 'CreateMultipartUploadCommand') return { UploadId: 'synthetic-upload-id' }
  if (command.constructor.name === 'UploadPartCommand') return { ETag: `"part-${command.input.PartNumber}"` }
  return {}
}

test('serially stages sealed bytes and conditionally completes without touching feeds', async t => {
  const f = await multipartFixture(t, Buffer.alloc(8 * MiB + 3, 0x41))
  const result = await f.run()
  assert.deepEqual(result, { outcome: 'uploaded', parts: 2, byteCount: f.file.size, publicVerificationRequired: true })
  assert.equal(f.maximumActive(), 1)
  assert.equal(f.count('AbortMultipartUploadCommand'), 0)
  const complete = f.calls.find(call => call.name === 'CompleteMultipartUploadCommand')
  assert.equal(complete.input.IfNoneMatch, '*')
  assert.deepEqual(complete.input.MultipartUpload.Parts, [{ PartNumber: 1, ETag: '"part-1"' }, { PartNumber: 2, ETag: '"part-2"' }])
  const parts = f.calls.filter(call => call.name === 'UploadPartCommand')
  assert.equal(parts[0].input.ContentLength, 8 * MiB)
  assert.equal(parts[1].input.ContentLength, 3)
  assert.equal(hash(Buffer.concat(parts.map(part => part.input.Body))), f.file.sha256)
  assert.ok(f.calls.every(call => call.input.Bucket === 'muse' && call.input.Key === f.file.key && !call.options.abortSignal.aborted))
  assert.ok(f.events.every(event => !JSON.stringify(event).includes('synthetic-upload-id')))
})

test('replays the same part Buffer after reset without counting its hash twice', async t => {
  const f = await multipartFixture(t, Buffer.alloc(8 * MiB + 5, 0x42))
  let attempts = 0
  f.handler = command => {
    if (command.constructor.name === 'UploadPartCommand' && command.input.PartNumber === 1 && ++attempts === 1) throw wireError(null, 'ECONNRESET')
    return defaults(command)
  }
  assert.equal((await f.run()).outcome, 'uploaded')
  const calls = f.calls.filter(call => call.name === 'UploadPartCommand')
  assert.equal(calls.length, 3)
  assert.equal(calls[0].input.Body, calls[1].input.Body)
  assert.equal(f.count('CompleteMultipartUploadCommand'), 1)
})

test('retries its expired part deadline once with a fresh signal and the same Buffer', async t => {
  const f = await multipartFixture(t)
  const owners = new Map()
  t.mock.method(AbortSignal, 'timeout', () => {
    const controller = new AbortController()
    owners.set(controller.signal, controller)
    return controller.signal
  })
  let parts = 0
  f.handler = (command, options) => {
    if (command instanceof UploadPartCommand && ++parts === 1) {
      owners.get(options.abortSignal).abort(new DOMException('synthetic deadline', 'TimeoutError'))
      throw Object.assign(new Error('synthetic-private-token'), { name: 'AbortError', code: 'ABORT_ERR' })
    }
    return defaults(command)
  }
  assert.equal((await f.run()).outcome, 'uploaded')
  const calls = f.calls.filter(call => call.name === 'UploadPartCommand')
  assert.equal(calls.length, 2)
  assert.equal(calls[0].input.Body, calls[1].input.Body)
  assert.notEqual(calls[0].options.abortSignal, calls[1].options.abortSignal)
  assert.equal(calls[0].options.abortSignal.aborted, true)
  assert.equal(calls[1].options.abortSignal.aborted, false)
  assert.equal(f.count('CompleteMultipartUploadCommand'), 1)
})

for (const kind of ['whole cancellation', 'ordinary AbortError', 'deadline plus HTTP 403'])
  test(`does not retry a part after ${kind}`, async t => {
    const f = await multipartFixture(t), whole = new AbortController(), owners = []
    t.mock.method(AbortSignal, 'timeout', () => {
      const controller = new AbortController(); owners.push(controller); return controller.signal
    })
    f.handler = command => {
      if (command instanceof UploadPartCommand) {
        if (kind === 'whole cancellation') whole.abort()
        if (kind === 'deadline plus HTTP 403') owners[1].abort(new DOMException('synthetic deadline', 'TimeoutError'))
        throw Object.assign(new Error('synthetic-private-token'), { name: 'AbortError', code: 'ABORT_ERR',
          ...(kind === 'deadline plus HTTP 403' ? { $metadata: { httpStatusCode: 403 } } : {}) })
      }
      return defaults(command)
    }
    await assert.rejects(f.run(kind === 'whole cancellation' ? { signal: whole.signal } : {}), MultipartUploadFailure)
    assert.equal(f.count('UploadPartCommand'), 1)
    assert.equal(f.count('CompleteMultipartUploadCommand'), 0)
    assert.equal(f.count('AbortMultipartUploadCommand'), 1)
    assert.equal(f.calls.at(-1).options.abortSignal.aborted, false)
  })

test('bounds a repeatedly expired part deadline to two attempts and independently aborts its task', async t => {
  const f = await multipartFixture(t), owners = new Map()
  t.mock.method(AbortSignal, 'timeout', () => {
    const controller = new AbortController(); owners.set(controller.signal, controller); return controller.signal
  })
  f.handler = (command, options) => {
    if (command instanceof UploadPartCommand) {
      owners.get(options.abortSignal).abort(new DOMException('synthetic deadline', 'TimeoutError'))
      throw Object.assign(new Error('synthetic-private-token'), { name: 'AbortError' })
    }
    return defaults(command)
  }
  await assert.rejects(f.run(), error => error.details.cleanup.state === 'aborted')
  assert.equal(f.count('UploadPartCommand'), 2)
  assert.equal(f.count('CompleteMultipartUploadCommand'), 0)
  assert.equal(f.calls.at(-1).name, 'AbortMultipartUploadCommand')
  assert.equal(f.calls.at(-1).options.abortSignal.aborted, false)
})

test('finishes short positioned reads before sending each sealed Buffer', async t => {
  const f = await multipartFixture(t), originalOpen = fs.open
  let reads = 0
  t.mock.method(fs, 'open', async (...args) => {
    const handle = await originalOpen(...args), read = handle.read.bind(handle)
    handle.read = (buffer, offset, length, position) => {
      reads++
      return read(buffer, offset, Math.min(length, 3), position)
    }
    return handle
  })
  assert.equal((await f.run()).byteCount, f.file.size)
  assert.ok(reads > 2)
  assert.equal(hash(f.calls.find(call => call.name === 'UploadPartCommand').input.Body), f.file.sha256)
})

for (const http of [400, 401, 403, 404, 412]) test(`does not retry UploadPart authentication or client HTTP ${http}`, async t => {
  const f = await multipartFixture(t)
  f.handler = command => { if (command.constructor.name === 'UploadPartCommand') throw wireError(http, 'ECONNRESET'); return defaults(command) }
  await assert.rejects(f.run(), MultipartUploadFailure)
  assert.equal(f.count('UploadPartCommand'), 1)
  assert.equal(f.count('CompleteMultipartUploadCommand'), 0)
  assert.equal(f.count('AbortMultipartUploadCommand'), 1)
})

test('bounds repeated reset attempts and aborts its own UploadId', async t => {
  const f = await multipartFixture(t)
  f.handler = command => { if (command.constructor.name === 'UploadPartCommand') throw wireError(null, 'ECONNRESET'); return defaults(command) }
  await assert.rejects(f.run(), error => error.details.cleanup.state === 'aborted')
  assert.equal(f.count('UploadPartCommand'), 2)
  const abort = f.calls.find(call => call.name === 'AbortMultipartUploadCommand')
  assert.equal(abort.input.UploadId, 'synthetic-upload-id')
})

test('does not retry ambiguous CompleteMultipartUpload failure and reports unknown completion', async t => {
  const f = await multipartFixture(t)
  f.handler = command => { if (command.constructor.name === 'CompleteMultipartUploadCommand') throw wireError(null, 'ECONNRESET'); return defaults(command) }
  await assert.rejects(f.run(), error => error.details.phase === 'complete' && error.details.completion === 'unknown' && error.details.cleanup.state === 'aborted')
  assert.equal(f.count('CompleteMultipartUploadCommand'), 1)
  assert.equal(f.count('AbortMultipartUploadCommand'), 1)
})

for (const missing of [false, true]) test(`cleans its task on complete 412 before requiring existing-object public verification: missing=${missing}`, async t => {
  const f = await multipartFixture(t)
  f.handler = command => {
    if (command.constructor.name === 'CompleteMultipartUploadCommand') throw wireError(412)
    if (missing && command.constructor.name === 'AbortMultipartUploadCommand') throw wireError(404)
    return defaults(command)
  }
  const result = await f.run()
  assert.equal(result.outcome, 'already-exists')
  assert.equal(result.publicVerificationRequired, true)
  assert.equal(result.cleanup.state, missing ? 'no-such-upload' : 'aborted')
  assert.equal(f.count('CompleteMultipartUploadCommand'), 1)
  assert.equal(f.count('AbortMultipartUploadCommand'), 1)
  assert.ok(f.calls.every(call => !call.name.includes('Delete')))
})

for (const completeStatus of [412, 503]) test(`reports cleanup failure separately after complete HTTP ${completeStatus}`, async t => {
  const f = await multipartFixture(t)
  f.handler = command => {
    if (command.constructor.name === 'CompleteMultipartUploadCommand') throw wireError(completeStatus)
    if (command.constructor.name === 'AbortMultipartUploadCommand') throw wireError(403)
    return defaults(command)
  }
  await assert.rejects(f.run(), error => error.details.status === completeStatus &&
    error.details.cleanup.state === 'abort-failed' && error.details.cleanup.status === 403 &&
    !error.message.includes('synthetic-private-token') && !JSON.stringify(error).includes('synthetic-private-token'))
  assert.equal(f.count('AbortMultipartUploadCommand'), 1)
})

test('reports unknown upload identity when Create succeeds without UploadId', async t => {
  const f = await multipartFixture(t)
  f.handler = () => ({})
  await assert.rejects(f.run(), error => error.details.phase === 'create' && error.details.completion === 'unknown' && error.details.cleanup.state === 'unknown-upload-id')
  assert.equal(f.count('CreateMultipartUploadCommand'), 1)
  assert.equal(f.count('AbortMultipartUploadCommand'), 0)
})

test('reports unknown identity after an ambiguous Create response without retrying', async t => {
  const f = await multipartFixture(t)
  f.handler = () => { throw wireError(null, 'ECONNRESET') }
  await assert.rejects(f.run(), error => error.details.cleanup.state === 'unknown-upload-id')
  assert.equal(f.calls.length, 1)
})

for (const wrong of ['size', 'hash', 'feed', 'SDK retry', 'part bound', 'attempt bound', 'deadline bound']) test(`refuses invalid ${wrong} before creating any task`, async t => {
  const f = await multipartFixture(t)
  let options = {}
  if (wrong === 'size') f.file.size++
  if (wrong === 'hash') f.file.sha256 = 'c'.repeat(64)
  if (wrong === 'feed') f.file.key = 'releases/feeds/mac-arm64/latest-mac.yml'
  if (wrong === 'SDK retry') f.client.config.maxAttempts = async () => 3
  if (wrong === 'part bound') options = { partSize: 7 * MiB }
  if (wrong === 'attempt bound') options = { maxPartAttempts: 4 }
  if (wrong === 'deadline bound') options = { requestTimeoutMs: 999 }
  await assert.rejects(f.run(options), MultipartUploadFailure)
  assert.equal(f.calls.length, 0)
})

for (const mutate of ['truncate', 'same-size hash change']) test(`aborts without Complete after source ${mutate}`, async t => {
  const f = await multipartFixture(t, Buffer.alloc(8 * MiB + 3, 0x43))
  f.handler = async command => {
    if (command.constructor.name === 'UploadPartCommand' && command.input.PartNumber === 1) {
      if (mutate === 'truncate') await truncate(f.file.path, 8 * MiB)
      else {
        const handle = await open(f.file.path, 'r+')
        try { await handle.write(Buffer.from([0x44]), 0, 1, 8 * MiB) } finally { await handle.close() }
      }
    }
    return defaults(command)
  }
  await assert.rejects(f.run(), MultipartUploadFailure)
  assert.equal(f.count('CompleteMultipartUploadCommand'), 0)
  assert.equal(f.count('AbortMultipartUploadCommand'), 1)
})

for (const etag of [undefined, '', '  ', 'part\r\n']) test(`rejects unusable part ETag ${JSON.stringify(etag)} before Complete`, async t => {
  const f = await multipartFixture(t)
  f.handler = command => command.constructor.name === 'UploadPartCommand' ? { ETag: etag } : defaults(command)
  await assert.rejects(f.run(), MultipartUploadFailure)
  assert.equal(f.count('CompleteMultipartUploadCommand'), 0)
  assert.equal(f.count('AbortMultipartUploadCommand'), 1)
})

test('cancellation waits for independent abort cleanup without a cancelled signal', async t => {
  const f = await multipartFixture(t)
  const controller = new AbortController()
  await assert.rejects(f.run({ signal: controller.signal, onEvent: event => { if (event.status === 'multipart-created') controller.abort() } }), MultipartUploadFailure)
  const abort = f.calls.find(call => call.name === 'AbortMultipartUploadCommand')
  assert.ok(abort)
  assert.equal(abort.options.abortSignal.aborted, false)
  assert.equal(f.count('UploadPartCommand'), 0)
})

test('rejects a linked local source before creating any task', async t => {
  const f = await multipartFixture(t)
  const linked = join(f.root, 'linked source')
  await symlink(f.file.path, linked)
  f.file.path = linked
  await assert.rejects(f.run(), MultipartUploadFailure)
  assert.equal(f.calls.length, 0)
})

for (const failedUpload of [false, true]) test(`awaits file close and preserves prior cleanup diagnostics: failedUpload=${failedUpload}`, async t => {
  const f = await multipartFixture(t)
  const originalOpen = fs.open
  t.mock.method(fs, 'open', async (...args) => {
    const handle = await originalOpen(...args)
    const close = handle.close.bind(handle)
    handle.close = async () => { await close(); throw wireError(500) }
    return handle
  })
  if (failedUpload) f.handler = command => {
    if (command.constructor.name === 'CompleteMultipartUploadCommand') throw wireError(412)
    if (command.constructor.name === 'AbortMultipartUploadCommand') throw wireError(403)
    return defaults(command)
  }
  await assert.rejects(f.run(), error => {
    assert.ok(error instanceof MultipartUploadFailure)
    if (failedUpload) assert.deepEqual(error.details, { phase: 'complete', status: 412,
      completion: 'existing-object', cleanup: { state: 'abort-failed', status: 403, error: { errorName: 'Error', code: null, syscall: null, status: 403, attempts: null, totalRetryDelayMs: null } }, fileCloseFailed: true })
    else assert.equal(error.details.phase, 'file-close')
    assert.ok(!JSON.stringify(error).includes('synthetic-private-token'))
    return true
  })
})

const largeSize = 8 * 1024 ** 2 + 1
const binaryTypes = new Map([
  ['muse-med-1.0.5-mac-arm64.dmg', 'application/x-apple-diskimage'],
  ['muse-med-1.0.5-mac-arm64.zip', 'application/zip'],
  ['muse-med-1.0.5-mac-arm64.zip.blockmap', 'application/octet-stream'],
  ['muse-med-1.0.5-win-x64.exe', 'application/vnd.microsoft.portable-executable'],
  ['muse-med-1.0.5-win-x64.exe.blockmap', 'application/octet-stream'],
])
const binaryNames = [...binaryTypes.keys()]
const allNames = [...binaryNames, 'latest-mac.yml', 'rc-mac.yml', 'latest.yml', 'rc.yml', 'muse-desktop-builds.json', 'muse-desktop-SHA256SUMS.txt']

async function bridgeFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'muse-tos-bridge-'))
  const artifactDirectories = Object.fromEntries(['mac-arm64', 'win-x64'].map(target => [target, join(root, target)]))
  for (const dir of Object.values(artifactDirectories)) await mkdir(dir)
  const streams = [], calls = [], uploads = [], events = []
  t.after(async () => {
    for (const stream of streams) { stream.destroy(); await finished(stream, { cleanup: true }).catch(() => {}) }
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  })
  class S3Client { constructor() { this.config = {} } async send(command, options) { calls.push({ client: this, command, options }); return { original: true } } }
  class PutObjectCommand { constructor(input) { this.input = input } }
  class S3ServiceException extends Error { constructor(options) { super(options.message); Object.assign(this, options) } }
  const client = new S3Client()
  const seal = { schemaVersion: 1, repository: 'felir7at62co-wq/muse-med', version: '1.0.5',
    sourceCommit: approvedBatch.sourceCommit, sourceRun: approvedBatch.sourceRun,
    releases: [{ id: 1, tag: 'v1.0.5', prerelease: false }, { id: 2, tag: 'v1.0.5-rc.muse-stable', prerelease: true }],
    files: allNames.map(filename => ({ filename, size: binaryTypes.has(filename) && !filename.endsWith('.blockmap') ? largeSize : 9, sha256: 'a'.repeat(64) })) }
  const f = { client, seal, streams, calls, uploads, events, artifactDirectories, root,
    S3Client, PutObjectCommand, S3ServiceException, selectedKeys: [winKey], result: { outcome: 'uploaded', publicVerificationRequired: true } }
  f.install = () => { const restore = installSealedMultipartBridge({ S3Client, PutObjectCommand, S3ServiceException, commands, seal,
    selectedKeys: f.selectedKeys, artifactDirectories, multipartUpload: async options => { uploads.push(options); if (f.error) throw f.error; return f.result },
    onEvent: event => events.push(event) }); t.after(restore); return restore }
  f.command = async (filename = binaryNames[3]) => {
    const target = filename.includes('mac-arm64') ? 'mac-arm64' : 'win-x64'
    const path = join(artifactDirectories[target], filename)
    await writeFile(path, 'synthetic stream not consumed by fake uploader')
    const body = createReadStream(path); body.on('error', () => {}); streams.push(body)
    return new PutObjectCommand({ Bucket: 'muse', Key: `releases/1.0.5/${target}/${filename}`, Body: body,
      ContentLength: seal.files.find(file => file.filename === filename).size, ContentType: binaryTypes.get(filename),
      CacheControl: 'public, max-age=31536000, immutable', IfNoneMatch: '*' })
  }
  f.options = { abortSignal: AbortSignal.timeout(30000) }
  return f
}

for (const filename of binaryNames.filter(name => !name.endsWith('.blockmap'))) test(`intercepts only the sealed large binary ${filename}`, async t => {
  const f = await bridgeFixture(t); f.selectedKeys = [`releases/1.0.5/${filename.includes('mac-arm64') ? 'mac-arm64' : 'win-x64'}/${filename}`]; f.install()
  const command = await f.command(filename)
  assert.deepEqual(await f.client.send(command, f.options), { $metadata: { httpStatusCode: 200 } })
  assert.equal(f.calls.length, 0)
  assert.equal(f.uploads.length, 1)
  const upload = f.uploads[0]
  assert.equal(upload.client, f.client)
  assert.equal(upload.signal, f.options.abortSignal)
  assert.equal(upload.partSize, 8 * 1024 ** 2)
  assert.equal(upload.maxPartAttempts, 2)
  assert.deepEqual(upload.file, { key: command.input.Key, path: command.input.Body.path,
    size: command.input.ContentLength, sha256: 'a'.repeat(64), contentType: command.input.ContentType })
  assert.deepEqual(f.events.at(-1), { stage: 'multipart-finished', key: command.input.Key,
    outcome: 'uploaded', publicVerificationRequired: true })
})

for (const filename of binaryNames.filter(name => name.endsWith('.blockmap'))) test(`passes the original small blockmap unchanged ${filename}`, async t => {
  const f = await bridgeFixture(t); f.install()
  const command = await f.command(filename)
  assert.deepEqual(await f.client.send(command, f.options), { original: true })
  assert.equal(f.calls[0].client, f.client)
  assert.equal(f.calls[0].command, command)
  assert.equal(f.calls[0].options, f.options)
  assert.equal(f.uploads.length, 0)
})

for (const key of ['releases/feeds/mac-arm64/latest-mac.yml', 'releases/feeds/mac-arm64/rc-mac.yml',
  'releases/feeds/win-x64/latest.yml', 'releases/feeds/win-x64/rc.yml', 'unrelated-key']) test(`passes original non-binary PUT unchanged ${key}`, async t => {
  const f = await bridgeFixture(t); f.install()
  const command = new f.PutObjectCommand({ Bucket: 'muse', Key: key, Body: 'synthetic feed' })
  assert.deepEqual(await f.client.send(command, f.options), { original: true })
  assert.equal(f.calls[0].command, command)
  assert.equal(f.calls[0].options, f.options)
  assert.equal(f.uploads.length, 0)
})

test('passes multipart SDK commands through without recursive interception', async t => {
  const f = await bridgeFixture(t); f.install()
  const command = { input: { Key: 'releases/1.0.5/mac-arm64/muse-med-1.0.5-mac-arm64.dmg' } }
  assert.deepEqual(await f.client.send(command, f.options), { original: true })
  assert.equal(f.uploads.length, 0)
})

for (const change of ['bucket', 'size', 'type', 'cache', 'condition', 'source', 'body', 'extra input', 'missing input', 'signal'])
  test(`rejects changed sealed binary ${change} before uploading`, async t => {
    const f = await bridgeFixture(t); f.install()
    const command = await f.command()
    if (change === 'bucket') command.input.Bucket = 'other'
    if (change === 'size') command.input.ContentLength++
    if (change === 'type') command.input.ContentType = 'text/plain'
    if (change === 'cache') command.input.CacheControl = 'no-cache'
    if (change === 'condition') delete command.input.IfNoneMatch
    if (change === 'source') command.input.Body.path = join(f.root, 'another source')
    if (change === 'body') command.input.Body = Buffer.from('other source')
    if (change === 'extra input') command.input.Metadata = { unsupported: 'value' }
    if (change === 'missing input') delete command.input.ContentType
    await assert.rejects(f.client.send(command, change === 'signal' ? {} : f.options), /sealed multipart bridge input/u)
    assert.equal(f.uploads.length, 0)
    assert.equal(f.calls.length, 0)
  })

for (const change of ['schema', 'version', 'source', 'run', 'repository', 'duplicate file', 'unknown file', 'missing file', 'size', 'hash', 'directory'])
  test(`rejects invalid bridge identity ${change} before installing`, async t => {
    const f = await bridgeFixture(t)
    if (change === 'schema') f.seal.schemaVersion++
    if (change === 'version') f.seal.version = '1.0.4'
    if (change === 'source') f.seal.sourceCommit = 'invalid-source'
    if (change === 'run') f.seal.sourceRun = 0
    if (change === 'repository') f.seal.repository = 'other/repository'
    if (change === 'duplicate file') f.seal.files[1] = f.seal.files[0]
    if (change === 'unknown file') f.seal.files[0].filename = 'unknown-file'
    if (change === 'missing file') f.seal.files.pop()
    if (change === 'size') f.seal.files[0].size = 0
    if (change === 'hash') f.seal.files[0].sha256 = 'private-invalid-value'
    if (change === 'directory') f.artifactDirectories['mac-arm64'] = 'relative-directory'
    const original = f.S3Client.prototype.send
    assert.throws(f.install)
    assert.equal(f.S3Client.prototype.send, original)
    assert.equal(f.uploads.length, 0)
  })

for (const change of ['sourceCommit', 'sourceRun'])
  test(`rejects a well-formed bridge ${change} belonging to another release batch`, async t => {
    const f = await bridgeFixture(t), original = f.S3Client.prototype.send
    if (change === 'sourceCommit') f.seal.sourceCommit = 'b'.repeat(40)
    else f.seal.sourceRun++
    assert.throws(f.install, /sealed multipart bridge input/u)
    assert.equal(f.S3Client.prototype.send, original)
    assert.equal(f.uploads.length, 0)
    assert.equal(f.calls.length, 0)
  })

test('converts complete 412 into the original publisher precondition path that still requires public verification', async t => {
  const f = await bridgeFixture(t); f.result = { outcome: 'already-exists', publicVerificationRequired: true }; f.install()
  await assert.rejects(f.client.send(await f.command(), f.options), error => error instanceof f.S3ServiceException &&
    error.name === 'PreconditionFailed' && error.$metadata.httpStatusCode === 412)
  assert.equal(f.uploads.length, 1)
  assert.equal(f.events.at(-1).publicVerificationRequired, true)
})

test('preserves unknown completion and cleanup failure without converting either to HTTP 412 success', async t => {
  const f = await bridgeFixture(t)
  f.error = new MultipartUploadFailure({ phase: 'complete', status: null, completion: 'unknown',
    cleanup: { state: 'abort-failed', status: 403 } }); f.install()
  await assert.rejects(f.client.send(await f.command(), f.options), error => error === f.error && !error.$metadata)
  assert.deepEqual(f.events, [{ stage: 'multipart-failed', key: winKey, details: f.error.details }])
})

test('requires the helper public-verification obligation before returning success', async t => {
  const f = await bridgeFixture(t); f.result = { outcome: 'uploaded' }; f.install()
  await assert.rejects(f.client.send(await f.command(), f.options), /sealed multipart bridge input/u)
})

for (const kind of ['feed', 'small']) for (const result of ['sync', 'promise', 'throw'])
  test(`retains original ${kind} send ${result} identity`, async t => {
    const f = await bridgeFixture(t)
    const identity = result === 'promise' ? Promise.resolve({ original: true }) : new Error('synthetic-original-error')
    let received
    f.S3Client.prototype.send = function (...args) {
      received = { client: this, args }
      if (result === 'throw') throw identity
      return identity
    }
    f.install()
    const command = kind === 'small' ? await f.command(binaryNames[2]) : new f.PutObjectCommand({ Key: 'releases/feeds/mac-arm64/latest-mac.yml' })
    const callback = () => {}
    if (result === 'throw') assert.throws(() => f.client.send(command, f.options, callback), error => error === identity)
    else assert.equal(f.client.send(command, f.options, callback), identity)
    assert.equal(received.client, f.client)
    assert.deepEqual(received.args, [command, f.options, callback])
    assert.equal(f.uploads.length, 0)
  })

test('precondition conversion still runs complete public verification before mutable feed writes', async t => {
  const f = await bridgeFixture(t); f.result = { outcome: 'already-exists', publicVerificationRequired: true }; f.install()
  const order = []
  // This is the original publisher's catch/verification ordering, without network operations.
  try { await f.client.send(await f.command(), f.options) }
  catch (error) { if (error.$metadata?.httpStatusCode !== 412) throw error }
  order.push('complete-anonymous-size-and-sha256-verification')
  await f.client.send(new f.PutObjectCommand({ Key: 'releases/feeds/mac-arm64/latest-mac.yml', Body: 'synthetic' }), f.options)
  order.push('feed')
  assert.deepEqual(order, ['complete-anonymous-size-and-sha256-verification', 'feed'])
  assert.equal(f.calls.length, 1)
})

test('uses a plain safe SDK logger without forwarding raw SDK arguments', async t => {
  const f = await bridgeFixture(t); f.install()
  await f.client.send(await f.command(), f.options)
  const logger = f.client.config.logger
  logger.warn('synthetic-private-token', new Error('signed-url?secret=synthetic'))
  logger.error({ credentials: 'synthetic-private-token' })
  assert.deepEqual(f.events.slice(-2), ['warn', 'error'].map(level => ({ stage: 'sdk-log', level,
    key: winKey })))
  assert.ok(!JSON.stringify(f.events).includes('synthetic-private-token'))
  assert.ok(!JSON.stringify(f.events).includes('signed-url'))
})

for (const filename of binaryNames.slice(0, 2)) test(`keeps an existing Mac binary on the original SDK path when only Windows is selected: ${filename}`, async t => {
  const f = await bridgeFixture(t); f.install()
  const command = await f.command(filename)
  assert.deepEqual(await f.client.send(command, f.options), { original: true })
  assert.equal(f.calls[0].command, command)
  assert.equal(f.calls[0].options, f.options)
  assert.equal(f.uploads.length, 0)
})

test('retains the optional default selecting all three sealed large binaries', async t => {
  const f = await bridgeFixture(t); f.selectedKeys = undefined; f.install()
  for (const filename of binaryNames.filter(name => !name.endsWith('.blockmap'))) {
    await f.client.send(await f.command(filename), f.options)
  }
  assert.equal(f.uploads.length, 3)
  assert.equal(f.calls.length, 0)
})

for (const kind of ['empty', 'duplicate', 'foreign', 'feed', 'small blockmap', 'not array'])
  test(`refuses a selected multipart subset that is ${kind} before patching the SDK`, async t => {
    const f = await bridgeFixture(t), original = f.S3Client.prototype.send
    if (kind === 'empty') f.selectedKeys = []
    if (kind === 'duplicate') f.selectedKeys = [winKey, winKey]
    if (kind === 'foreign') f.selectedKeys = ['releases/other/win-x64/file.exe']
    if (kind === 'feed') f.selectedKeys = ['releases/feeds/win-x64/latest.yml']
    if (kind === 'small blockmap') f.selectedKeys = [`${winKey}.blockmap`]
    if (kind === 'not array') f.selectedKeys = winKey
    assert.throws(f.install)
    assert.equal(f.S3Client.prototype.send, original)
    assert.equal(f.uploads.length, 0)
  })

test('omits private wire error fields and exposes only allowlisted request diagnostics', async t => {
  const f = await multipartFixture(t)
  f.handler = command => {
    if (command instanceof UploadPartCommand) throw Object.assign(new Error('synthetic-private-token signed-url'), {
      name: 'synthetic-private-name', code: 'EPIPE', syscall: 'write', UploadId: 'synthetic-private-upload',
      credentials: 'synthetic-private-token', $metadata: { attempts: 1, totalRetryDelay: 0 },
    })
    return defaults(command)
  }
  await assert.rejects(f.run(), error => {
    const output = JSON.stringify({ message: error.message, details: error.details, events: f.events })
    assert.ok(!output.includes('synthetic-private'))
    assert.ok(!output.includes('signed-url'))
    assert.equal(error.details.error.code, 'EPIPE')
    assert.equal(error.details.error.syscall, 'write')
    assert.equal(error.details.error.errorName, 'SDKError')
    return true
  })
  assert.equal(f.count('UploadPartCommand'), 2)
  assert.equal(f.count('AbortMultipartUploadCommand'), 1)
})

function observerFixture() {
  const sourceCommit = 'a'.repeat(40)
  const artifacts = binaryNames.map(filename => ({ filename,
    key: `releases/1.0.5/${filename.includes('mac-arm64') ? 'mac-arm64' : 'win-x64'}/${filename}`,
    size: filename.endsWith('.blockmap') ? 9 : largeSize, sha256: 'b'.repeat(64) }))
  const metadata = ['latest-mac.yml', 'rc-mac.yml', 'latest.yml', 'rc.yml'].map(filename => ({
    key: `releases/feeds/${filename.includes('mac') ? 'mac-arm64' : 'win-x64'}/${filename}`, sha256: 'c'.repeat(64),
  }))
  const plan = { version: '1.0.5', sourceCommit, artifacts, metadata }, events = []
  const observer = createTosPublisherObserver(plan, event => events.push(event))
  const finish = () => {
    for (const { key, size, sha256 } of artifacts) observer.observe(JSON.stringify({ stage: 'binary-verified', key, size, sha256 }))
    for (const { key, sha256 } of metadata) observer.observe(JSON.stringify({ stage: 'feed-verified', key, sha256 }))
    observer.observe(JSON.stringify({ stage: 'published', version: plan.version, sourceCommit, binaries: 5, feeds: 4 }))
    return observer.complete(0)
  }
  return { observer, finish, plan, events }
}

test('admits safe serial multipart progress without replacing five full binary proofs and four feed proofs', () => {
  const f = observerFixture()
  const progress = [
    { stage: 'multipart-sdk-request-started', key: winKey, phase: 'create' },
    { status: 'multipart-created', key: winKey, concurrency: 1, partSize: 8 * MiB, maxPartAttempts: 2 },
    { stage: 'multipart-sdk-request-failed', key: winKey, phase: 'part', elapsedMs: 120000, code: 'ABORT_ERR', syscall: 'write' },
    { status: 'multipart-part-retry', key: winKey, partNumber: 1, attempt: 1 },
    { stage: 'multipart-sdk-request-completed', key: winKey, phase: 'part', elapsedMs: 25, status: 200 },
    { status: 'multipart-part-staged', key: winKey, partNumber: 1, byteCount: 8 * MiB },
    { stage: 'multipart-finished', key: winKey, outcome: 'uploaded', publicVerificationRequired: true },
  ]
  for (const event of progress) f.observer.observe(JSON.stringify(event))
  assert.throws(() => f.observer.complete(0), /completion/u)
  const receipt = f.finish()
  assert.equal(receipt.binaries.length, 5)
  assert.equal(receipt.feeds.length, 4)
  assert.equal(f.events.at(-1).stage, 'published')
  assert.equal(f.events.filter(event => event.stage === 'binary-verified').length, 5)
})

test('projects safe multipart failures and stops publication while omitting upload identities and raw causes', () => {
  const f = observerFixture(), details = { phase: 'complete', status: null, completion: 'unknown',
    cleanup: { state: 'abort-failed', status: null, UploadId: 'synthetic-private-id', error: 'synthetic-private-token' },
    fileCloseFailed: true, UploadId: 'synthetic-private-id', error: { message: 'signed-url?synthetic-private' } }
  f.observer.observe(JSON.stringify({ stage: 'multipart-failed', key: winKey, details }))
  assert.throws(() => f.finish(), /continued after failure/u)
  assert.throws(() => f.observer.complete(0))
  assert.deepEqual(f.events[0].details, { phase: 'complete', status: null, completion: 'unknown',
    cleanup: { state: 'abort-failed', status: null }, fileCloseFailed: true })
  assert.ok(!JSON.stringify(f.events).includes('synthetic-private'))
  assert.ok(!JSON.stringify(f.events).includes('signed-url'))
})

test('projects request diagnostics without forwarding unrecognized code, name, URL, or upload IDs', () => {
  const f = observerFixture()
  f.observer.observe(JSON.stringify({ stage: 'multipart-sdk-request-failed', key: winKey, phase: 'part', elapsedMs: 5,
    code: 'signed-url?synthetic-private', syscall: 'synthetic-private', errorName: 'synthetic-private',
    UploadId: 'synthetic-private', message: 'synthetic-private-token' }))
  assert.deepEqual(f.events, [{ stage: 'multipart-sdk-request-failed', key: winKey, phase: 'part', elapsedMs: 5 }])
  assert.ok(!JSON.stringify(f.events).includes('synthetic-private'))
})

test('retains allowlisted multipart error names and an explicitly unknown HTTP status', () => {
  const f = observerFixture()
  f.observer.observe(JSON.stringify({ stage: 'multipart-sdk-request-failed', key: winKey, phase: 'part',
    elapsedMs: 120000, status: null, errorName: 'AbortError', code: 'ABORT_ERR', syscall: 'write',
    attempts: 1, totalRetryDelayMs: 0, message: 'synthetic-private-token', UploadId: 'synthetic-private-id' }))
  assert.deepEqual(f.events, [{ stage: 'multipart-sdk-request-failed', key: winKey, phase: 'part', elapsedMs: 120000,
    status: null, errorName: 'AbortError', code: 'ABORT_ERR', syscall: 'write', attempts: 1, totalRetryDelayMs: 0 }])
  assert.ok(!JSON.stringify(f.events).includes('synthetic-private'))
})

for (const kind of ['foreign key', 'feed key', 'blockmap key', 'parallel', 'part size', 'attempt bound', 'retry bound',
  'invalid part number', 'excess bytes', 'invalid phase', 'missing public verification', 'invalid failure phase',
  'invalid completion', 'invalid cleanup', 'invalid status', 'invalid close flag'])
  test(`rejects invalid multipart observer evidence: ${kind}`, () => {
    const f = observerFixture()
    let event = { status: 'multipart-created', key: winKey, concurrency: 1, partSize: 8 * MiB, maxPartAttempts: 2 }
    if (kind === 'foreign key') event.key = 'synthetic-other-key'
    if (kind === 'feed key') event.key = f.plan.metadata[0].key
    if (kind === 'blockmap key') event.key = `${winKey}.blockmap`
    if (kind === 'parallel') event.concurrency = 2
    if (kind === 'part size') event.partSize = 16 * MiB
    if (kind === 'attempt bound') event.maxPartAttempts = 3
    if (kind === 'retry bound') event = { status: 'multipart-part-retry', key: winKey, partNumber: 1, attempt: 2 }
    if (kind === 'invalid part number') event = { status: 'multipart-part-staged', key: winKey, partNumber: 0, byteCount: 1 }
    if (kind === 'excess bytes') event = { status: 'multipart-part-staged', key: winKey, partNumber: 1, byteCount: largeSize + 1 }
    if (kind === 'invalid phase') event = { stage: 'multipart-sdk-request-started', key: winKey, phase: 'delete' }
    if (kind === 'missing public verification') event = { stage: 'multipart-finished', key: winKey, outcome: 'uploaded' }
    if (kind.startsWith('invalid failure') || ['invalid completion', 'invalid cleanup', 'invalid status', 'invalid close flag'].includes(kind)) {
      event = { stage: 'multipart-failed', key: winKey, details: { phase: 'part', status: null,
        completion: 'not-completed', cleanup: { state: 'aborted', status: null } } }
      if (kind === 'invalid failure phase') event.details.phase = 'delete'
      if (kind === 'invalid completion') event.details.completion = 'synthetic-other'
      if (kind === 'invalid cleanup') event.details.cleanup.state = 'deleted-object'
      if (kind === 'invalid status') event.details.status = 'synthetic-secret'
      if (kind === 'invalid close flag') event.details.fileCloseFailed = 'synthetic-secret'
    }
    assert.throws(() => f.observer.observe(JSON.stringify(event)))
  })
