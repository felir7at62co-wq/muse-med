import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { Agent as HTTPSAgent } from 'node:https'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { finished } from 'node:stream/promises'
import { test } from 'node:test'
import { installSealedMultipartBridge } from '../tos-multipart-bridge.mjs'
import { MultipartUploadFailure, uploadImmutableMultipart } from '../tos-multipart-immutable.mjs'
import { createIsolatedMultipartTransport } from '../tos-multipart-transport.mjs'
import { createTosPublisherObserver } from '../tos-publish.mjs'

const requireSdk = createRequire(new URL('../tos-deps/package.json', import.meta.url))
const sdk = requireSdk('@aws-sdk/client-s3')
const requireSdkDependency = createRequire(requireSdk.resolve('@aws-sdk/client-s3'))
const { NodeHttpHandler } = requireSdkDependency('@smithy/node-http-handler')
const sdkVersion = requireSdk('@aws-sdk/client-s3/package.json').version
const approvedBatch = JSON.parse(await readFile(new URL('../seal.json', import.meta.url), 'utf8'))
const MiB = 1024 ** 2
const winName = 'muse-med-1.0.5-win-x64.exe'
const winKey = `releases/1.0.5/win-x64/${winName}`
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const provider = async () => ({ accessKeyId: 'synthetic-only-key', secretAccessKey: 'synthetic-only-secret' })

function factoryFixture(failAt) {
  const created = [], cleanupEvents = [], primary = new Error('synthetic constructor failure')
  const sourceClient = { config: Object.freeze({ credentials: provider, region: 'cn-beijing',
    endpoint: 'https://tos-s3-cn-beijing.volces.com', requestHandler: { original: true },
    unrelatedResolvedConfig: 'must not be copied' }), destroy() { assert.fail('The original client must remain owned by its caller') } }
  class Agent {
    constructor(options) {
      if (failAt === 'agent') throw primary
      this.options = options; this.destroyCount = 0; created.push(this)
    }
    destroy() { this.destroyCount++; if (this.failDestroy) throw new Error('synthetic-private-agent-failure') }
  }
  class Handler {
    constructor(options) {
      if (failAt === 'handler') throw primary
      this.options = options; this.destroyCount = 0; created.push(this)
    }
    destroy() { this.destroyCount++; if (this.failDestroy) throw new Error('synthetic-private-handler-failure') }
  }
  class Client {
    constructor(options) {
      if (failAt === 'client') throw primary
      this.options = options; this.destroyCount = 0; created.push(this)
    }
    destroy() { this.destroyCount++; if (this.failDestroy) throw new Error('synthetic-private-client-failure') }
  }
  const logger = { debug() {}, info() {}, warn() {}, error() {} }
  const run = () => createIsolatedMultipartTransport({ sourceClient, S3Client: Client, NodeHttpHandler: Handler,
    Agent, logger, onCleanupFailure: (...args) => cleanupEvents.push(args) })
  return { sourceClient, created, cleanupEvents, primary, run, logger, Agent, Handler, Client }
}

test('creates an isolated serial transport without copying resolved configuration or resolving credentials', () => {
  const f = factoryFixture(), before = { ...f.sourceClient.config }, transport = f.run()
  const [agent, handler, client] = f.created
  assert.equal(transport.client, client)
  assert.equal(client.options.credentials, f.sourceClient.config.credentials)
  assert.equal(client.options.logger, f.logger)
  assert.equal(client.options.region, 'cn-beijing')
  assert.equal(client.options.endpoint, 'https://tos-s3-cn-beijing.volces.com')
  assert.equal(client.options.maxAttempts, 1)
  assert.equal(client.options.expectContinueHeader, false)
  assert.equal(client.options.requestChecksumCalculation, 'WHEN_REQUIRED')
  assert.equal(client.options.responseChecksumValidation, 'WHEN_REQUIRED')
  assert.equal(client.options.requestHandler, handler)
  assert.equal(Object.hasOwn(client.options, 'unrelatedResolvedConfig'), false)
  assert.deepEqual(agent.options, { keepAlive: true, maxSockets: 1 })
  assert.equal(Object.hasOwn(agent.options, 'rejectUnauthorized'), false)
  assert.equal(handler.options.httpsAgent, agent)
  assert.deepEqual(f.sourceClient.config, before)
  transport.dispose()
  assert.ok(f.created.every(resource => resource.destroyCount === 1))
})

test('disposes its client, handler and agent once even when called repeatedly before any request', () => {
  const f = factoryFixture(), transport = f.run()
  transport.dispose(); transport.dispose()
  assert.ok(f.created.every(resource => resource.destroyCount === 1))
  assert.deepEqual(f.cleanupEvents, [])
})

for (const failAt of ['agent', 'handler', 'client']) test(`releases acquired resources when ${failAt} construction fails without replacing the constructor error`, () => {
  const f = factoryFixture(failAt)
  assert.throws(f.run, error => error === f.primary)
  assert.ok(f.created.every(resource => resource.destroyCount === 1))
})

test('continues releasing all owned resources after a destroy failure and reports no raw error arguments', () => {
  const f = factoryFixture(), transport = f.run()
  f.created[2].failDestroy = true
  assert.throws(transport.dispose)
  assert.ok(f.created.every(resource => resource.destroyCount === 1))
  assert.deepEqual(f.cleanupEvents, [[]])
  assert.ok(!JSON.stringify(f.cleanupEvents).includes('synthetic-private'))
  transport.dispose()
  assert.ok(f.created.every(resource => resource.destroyCount === 1))
})

test('retains the constructor failure even when cleaning an already acquired resource fails', () => {
  const f = factoryFixture('client')
  class FailingAgent extends f.Agent { constructor(options) { super(options); this.failDestroy = true } }
  assert.throws(() => createIsolatedMultipartTransport({ sourceClient: f.sourceClient, S3Client: f.Client,
    NodeHttpHandler: f.Handler, Agent: FailingAgent, onCleanupFailure: (...args) => f.cleanupEvents.push(args) }), error => error === f.primary)
  assert.ok(f.created.every(resource => resource.destroyCount === 1))
  assert.deepEqual(f.cleanupEvents, [[]])
})

function recorder({ failPart = false } = {}) {
  const requests = []
  return { requests, metadata: { handlerProtocol: 'http/1.1' }, destroy() {}, async handle(request) {
    requests.push({ method: request.method, hostname: request.hostname, protocol: request.protocol,
      path: request.path, expect: request.headers.Expect ?? request.headers.expect,
      contentLength: Number(request.headers['content-length']), ifNoneMatch: request.headers['if-none-match'], body: request.body })
    const initiating = request.method === 'POST' && Object.hasOwn(request.query, 'uploads')
    const completing = request.method === 'POST' && Object.hasOwn(request.query, 'uploadId')
    const denied = failPart && request.method === 'PUT'
    const body = denied ? '<Error><Code>AccessDenied</Code><Message>synthetic denial</Message></Error>'
      : initiating ? '<InitiateMultipartUploadResult><Bucket>muse</Bucket><Key>synthetic</Key><UploadId>synthetic-upload</UploadId></InitiateMultipartUploadResult>'
      : completing ? '<CompleteMultipartUploadResult><Bucket>muse</Bucket><Key>synthetic</Key><ETag>synthetic-etag</ETag></CompleteMultipartUploadResult>' : ''
    return { response: { statusCode: denied ? 403 : request.method === 'DELETE' ? 204 : 200,
      headers: { 'content-type': 'application/xml', etag: '"synthetic-part"' }, body: Readable.from([Buffer.from(body)]) } }
  } }
}

function actualSource(t, requestHandler) {
  assert.equal(sdkVersion, '3.1142.0')
  const client = new sdk.S3Client({ region: 'cn-beijing', endpoint: 'https://tos-s3-cn-beijing.volces.com',
    credentials: provider, maxAttempts: 1, requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED', ...(requestHandler ? { requestHandler } : {}) })
  t.after(() => client.destroy())
  return client
}

test('the pinned official SDK emits Expect 100-continue for a default 8 MiB part without network access', async t => {
  const handler = recorder(), source = actualSource(t, handler), body = Buffer.alloc(8 * MiB, 0x41)
  await source.send(new sdk.UploadPartCommand({ Bucket: 'muse', Key: winKey, UploadId: 'synthetic-upload',
    PartNumber: 1, ContentLength: body.length, Body: body }))
  assert.equal(handler.requests.length, 1)
  const request = handler.requests[0]
  assert.equal(request.expect, '100-continue')
  assert.equal(request.contentLength, body.length)
  assert.equal(request.body, body)
  assert.equal(request.protocol, 'https:')
  assert.equal(request.hostname, 'muse.tos-s3-cn-beijing.volces.com')
})

test('the isolated pinned SDK removes Expect while preserving the exact 8 MiB body, endpoint and source client', async t => {
  const originalRecorder = recorder(), source = actualSource(t, originalRecorder)
  const originalHandler = source.config.requestHandler, originalExpect = source.config.expectContinueHeader
  const transport = createIsolatedMultipartTransport({ sourceClient: source, S3Client: sdk.S3Client,
    NodeHttpHandler, Agent: HTTPSAgent })
  t.after(() => transport.dispose())
  const handler = transport.client.config.requestHandler, configured = await handler.configProvider
  assert.equal(configured.httpsAgent.keepAlive, true)
  assert.equal(configured.httpsAgent.maxSockets, 1)
  assert.equal(Object.hasOwn(configured.httpsAgent.options, 'rejectUnauthorized'), false)
  assert.equal(handler.externalAgent, true)
  const captured = recorder()
  handler.handle = captured.handle
  const body = Buffer.alloc(8 * MiB, 0x42)
  await transport.client.send(new sdk.UploadPartCommand({ Bucket: 'muse', Key: winKey, UploadId: 'synthetic-upload',
    PartNumber: 1, ContentLength: body.length, Body: body }))
  assert.equal(captured.requests.length, 1)
  assert.equal(captured.requests[0].expect, undefined)
  assert.equal(captured.requests[0].contentLength, body.length)
  assert.equal(captured.requests[0].body, body)
  assert.equal(captured.requests[0].hostname, 'muse.tos-s3-cn-beijing.volces.com')
  assert.equal(captured.requests[0].protocol, 'https:')
  assert.equal(source.config.requestHandler, originalHandler)
  assert.equal(source.config.expectContinueHeader, originalExpect)
  assert.equal(originalRecorder.requests.length, 0)
  transport.dispose()
})

test('retains the same configured owned agent across isolated SDK requests without establishing sockets', async t => {
  const originalRecorder = recorder(), source = actualSource(t, originalRecorder)
  const sourceHandler = source.config.requestHandler, sourceExpect = source.config.expectContinueHeader
  const transport = createIsolatedMultipartTransport({ sourceClient: source, S3Client: sdk.S3Client,
    NodeHttpHandler, Agent: HTTPSAgent })
  t.after(() => transport.dispose())
  const handler = transport.client.config.requestHandler, firstConfig = await handler.configProvider
  const agent = firstConfig.httpsAgent
  assert.equal(agent.keepAlive, true)
  assert.equal(agent.maxSockets, 1)
  assert.equal(Object.hasOwn(agent.options, 'rejectUnauthorized'), false)
  assert.equal(handler.externalAgent, true)
  assert.equal(await handler.configProvider, firstConfig)
  const captured = recorder()
  handler.handle = captured.handle
  const body = Buffer.alloc(8 * MiB, 0x44)
  for (const PartNumber of [1, 2]) await transport.client.send(new sdk.UploadPartCommand({ Bucket: 'muse', Key: winKey,
    UploadId: 'synthetic-upload', PartNumber, ContentLength: body.length, Body: body }))
  assert.equal(transport.client.config.requestHandler, handler)
  assert.equal((await handler.configProvider).httpsAgent, agent)
  assert.equal(captured.requests.length, 2)
  assert.ok(captured.requests.every(request => request.expect === undefined && request.body === body && request.contentLength === body.length))
  assert.equal(Object.keys(agent.sockets).length, 0)
  assert.equal(Object.keys(agent.freeSockets).length, 0)
  assert.equal(source.config.requestHandler, sourceHandler)
  assert.equal(source.config.expectContinueHeader, sourceExpect)
  assert.equal(originalRecorder.requests.length, 0)
  transport.dispose()
})

test('serially submits the official multipart commands through the isolated recorder and conditionally completes', async t => {
  const root = await mkdtemp(join(tmpdir(), 'muse-no-expect-wire-'))
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))
  const bytes = Buffer.alloc(8 * MiB + 3, 0x43), path = join(root, winName)
  await writeFile(path, bytes)
  const source = actualSource(t), transport = createIsolatedMultipartTransport({ sourceClient: source,
    S3Client: sdk.S3Client, NodeHttpHandler, Agent: HTTPSAgent })
  t.after(() => transport.dispose())
  const handler = recorder(), actualHandler = transport.client.config.requestHandler
  let active = 0, maxActive = 0
  actualHandler.handle = async request => {
    active++; maxActive = Math.max(maxActive, active)
    try { return await handler.handle(request) } finally { active-- }
  }
  const result = await uploadImmutableMultipart({ client: transport.client, commands: sdk,
    file: { path, key: winKey, size: bytes.length, sha256: hash(bytes), contentType: 'application/vnd.microsoft.portable-executable' } })
  assert.equal(result.outcome, 'uploaded')
  assert.equal(result.publicVerificationRequired, true)
  assert.equal(maxActive, 1)
  assert.deepEqual(handler.requests.map(request => request.method), ['POST', 'PUT', 'PUT', 'POST'])
  assert.equal(handler.requests.at(-1).ifNoneMatch, '*')
  assert.ok(handler.requests.every(request => request.expect === undefined && request.protocol === 'https:'))
  assert.equal(hash(Buffer.concat(handler.requests.filter(request => request.method === 'PUT').map(request => request.body))), hash(bytes))
  transport.dispose()
})

test('the isolated official SDK aborts its failed multipart task before disposing only its owned transport', async t => {
  const root = await mkdtemp(join(tmpdir(), 'muse-no-expect-abort-'))
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))
  const path = join(root, winName), bytes = Buffer.from('synthetic small source')
  await writeFile(path, bytes)
  const source = actualSource(t), transport = createIsolatedMultipartTransport({ sourceClient: source,
    S3Client: sdk.S3Client, NodeHttpHandler, Agent: HTTPSAgent })
  t.after(() => transport.dispose())
  const captured = recorder({ failPart: true }), handler = transport.client.config.requestHandler
  handler.handle = captured.handle
  const order = [], destroy = handler.destroy.bind(handler)
  t.mock.method(handler, 'destroy', () => { order.push('owned-transport-destroyed'); destroy() })
  await assert.rejects(uploadImmutableMultipart({ client: transport.client, commands: sdk,
    file: { path, key: winKey, size: bytes.length, sha256: hash(bytes), contentType: 'application/vnd.microsoft.portable-executable' } }), error => {
    assert.equal(error.details.status, 403)
    assert.equal(error.details.cleanup.state, 'aborted')
    order.push('owned-task-abort-completed')
    return true
  })
  assert.deepEqual(captured.requests.map(request => request.method), ['POST', 'PUT', 'DELETE'])
  transport.dispose()
  assert.equal(order[0], 'owned-task-abort-completed')
  assert.ok(order.slice(1).every(value => value === 'owned-transport-destroyed'))
  assert.equal(source.config.expectContinueHeader, 2 * MiB)
})

async function bridgeFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'muse-isolated-bridge-'))
  const dirs = Object.fromEntries(['mac-arm64', 'win-x64'].map(target => [target, join(root, target)]))
  for (const dir of Object.values(dirs)) await mkdir(dir)
  const streams = [], calls = [], events = [], uploads = [], transports = []
  t.after(async () => {
    for (const stream of streams) { stream.destroy(); await finished(stream, { cleanup: true }).catch(() => {}) }
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  })
  class Client {
    constructor() { this.config = { credentials: provider, logger: { original: true } }; this.destroyCount = 0 }
    send(...args) { calls.push({ client: this, args }); return Promise.resolve({ original: true }) }
    destroy() { this.destroyCount++ }
  }
  class Put { constructor(input) { this.input = input } }
  class ServiceException extends Error { constructor(options) { super(options.message); Object.assign(this, options) } }
  const client = new Client(), originalConfig = { ...client.config }
  const seal = structuredClone(approvedBatch)
  for (const file of seal.files) { file.size = file.filename.endsWith('.blockmap') ? 9 : 8 * MiB + 1; file.sha256 = 'a'.repeat(64) }
  const f = { root, dirs, client, originalConfig, calls, events, uploads, transports,
    result: { outcome: 'uploaded', publicVerificationRequired: true } }
  f.install = () => {
    const restore = installSealedMultipartBridge({ S3Client: Client, PutObjectCommand: Put, S3ServiceException: ServiceException,
      commands: sdk, seal, artifactDirectories: dirs, selectedKeys: [winKey],
      createMultipartTransport(options) {
        assert.equal(options.sourceClient, client)
        if (f.constructionFailure) throw f.constructionFailure
        const owned = new Client(), transport = { client: owned, disposed: 0, dispose() {
          this.disposed++; owned.destroy()
          if (f.disposeFailure) { options.onCleanupFailure(); throw f.disposeFailure }
        } }
        owned.config.logger = options.logger; transports.push(transport)
        return transport
      }, multipartUpload: async options => {
        uploads.push(options)
        if (f.uploadFailure) throw f.uploadFailure
        return f.result
      }, onEvent: event => events.push(event) })
    t.after(restore)
  }
  f.command = async (filename = winName) => {
    const target = filename.includes('mac-arm64') ? 'mac-arm64' : 'win-x64', path = join(dirs[target], filename)
    await writeFile(path, 'synthetic source not consumed by fake helper')
    const body = createReadStream(path); body.on('error', () => {}); streams.push(body)
    return new Put({ Bucket: 'muse', Key: `releases/1.0.5/${target}/${filename}`, Body: body, ContentLength: 8 * MiB + 1,
      ContentType: filename.endsWith('.dmg') ? 'application/x-apple-diskimage' : 'application/vnd.microsoft.portable-executable',
      CacheControl: 'public, max-age=31536000, immutable', IfNoneMatch: '*' })
  }
  f.options = { abortSignal: AbortSignal.timeout(30000) }
  return f
}

test('uses and disposes only the selected Windows transport while leaving the Mac client configuration unchanged', async t => {
  const f = await bridgeFixture(t); f.install()
  const mac = await f.command('muse-med-1.0.5-mac-arm64.dmg')
  assert.deepEqual(await f.client.send(mac, f.options), { original: true })
  assert.equal(f.transports.length, 0)
  assert.deepEqual(await f.client.send(await f.command(), f.options), { $metadata: { httpStatusCode: 200 } })
  assert.equal(f.uploads[0].client, f.transports[0].client)
  assert.equal(f.uploads[0].commands, sdk)
  assert.equal(f.uploads[0].signal, f.options.abortSignal)
  assert.equal(f.transports[0].disposed, 1)
  assert.equal(f.transports[0].client.destroyCount, 1)
  assert.equal(f.client.destroyCount, 0)
  assert.deepEqual(f.client.config, f.originalConfig)
})

for (const kind of ['part failure with aborted task', 'unknown complete', 'failure plus disposal failure'])
  test(`disposes the selected transport after ${kind} without replacing the upload failure`, async t => {
    const f = await bridgeFixture(t)
    f.uploadFailure = new MultipartUploadFailure({ phase: kind === 'unknown complete' ? 'complete' : 'part',
      status: null, completion: kind === 'unknown complete' ? 'unknown' : 'not-completed', cleanup: { state: 'aborted', status: null } })
    if (kind === 'failure plus disposal failure') f.disposeFailure = new Error('synthetic-private-dispose-failure')
    f.install()
    await assert.rejects(f.client.send(await f.command(), f.options), error => error === f.uploadFailure)
    assert.equal(f.transports[0].disposed, 1)
    assert.equal(f.client.destroyCount, 0)
    assert.ok(!JSON.stringify(f.events).includes('synthetic-private'))
  })

test('disposes an existing-object result before returning the original publisher precondition path', async t => {
  const f = await bridgeFixture(t); f.result = { outcome: 'already-exists', publicVerificationRequired: true }; f.install()
  await assert.rejects(f.client.send(await f.command(), f.options), error => error.$metadata?.httpStatusCode === 412)
  assert.equal(f.transports[0].disposed, 1)
  assert.equal(f.client.destroyCount, 0)
})

for (const outcome of ['uploaded', 'already-exists'])
  test(`stops ${outcome} from reaching feed promotion when transport disposal fails`, async t => {
    const f = await bridgeFixture(t); f.result = { outcome, publicVerificationRequired: true }
    f.disposeFailure = new Error('synthetic-private-dispose-failure'); f.install()
    await assert.rejects(f.client.send(await f.command(), f.options), error => error instanceof MultipartUploadFailure &&
      error.details.phase === 'transport-cleanup' && error.details.completion === 'committed-or-existing' &&
      error.details.cleanup.state === 'transport-disposal-failed' && !error.$metadata)
    assert.equal(f.transports[0].disposed, 1)
    assert.equal(f.client.destroyCount, 0)
    assert.ok(!JSON.stringify(f.events).includes('synthetic-private'))
  })

test('stops transport construction failure before any upload and leaves the original client alive', async t => {
  const f = await bridgeFixture(t); f.constructionFailure = new Error('synthetic-constructor-failure'); f.install()
  await assert.rejects(f.client.send(await f.command(), f.options), error => error === f.constructionFailure)
  assert.equal(f.uploads.length, 0)
  assert.equal(f.transports.length, 0)
  assert.equal(f.client.destroyCount, 0)
  assert.deepEqual(f.client.config, f.originalConfig)
})

function cleanupObserver(onEvent = () => {}) {
  return createTosPublisherObserver({ version: '1.0.5', sourceCommit: 'a'.repeat(40),
    artifacts: [{ filename: winName, key: winKey, size: 8 * MiB + 1, sha256: 'a'.repeat(64) }], metadata: [] }, onEvent)
}

test('transport cleanup observer accepts the bridge failure, safely projects details and blocks publication', async t => {
  const f = await bridgeFixture(t); f.disposeFailure = new Error('synthetic-private-dispose-failure'); f.install()
  await assert.rejects(f.client.send(await f.command(), f.options), MultipartUploadFailure)
  const event = f.events.find(value => value.stage === 'multipart-failed' && value.details.phase === 'transport-cleanup')
  assert.ok(event)
  const observed = [], observer = cleanupObserver(value => observed.push(value))
  observer.observe(JSON.stringify({ ...event, UploadId: 'synthetic-private-id', error: 'synthetic-private-token',
    details: { ...event.details, error: 'signed-url?synthetic-private',
      cleanup: { ...event.details.cleanup, UploadId: 'synthetic-private-id' } } }))
  assert.deepEqual(observed, [{ stage: 'failed', key: winKey,
    detail: 'Conditional multipart did not complete; reconcile object and owned task.',
    details: { phase: 'transport-cleanup', status: null, completion: 'committed-or-existing',
      cleanup: { state: 'transport-disposal-failed', status: null } } }])
  assert.throws(() => observer.complete(0), /reported failure/u)
  assert.ok(!JSON.stringify(observed).includes('synthetic-private'))
  assert.ok(!JSON.stringify(observed).includes('signed-url'))
})

for (const field of ['phase', 'cleanup state'])
  test(`transport cleanup observer rejects an unknown ${field}`, () => {
    const observer = cleanupObserver(), details = { phase: 'transport-cleanup', status: null, completion: 'committed-or-existing',
      cleanup: { state: 'transport-disposal-failed', status: null } }
    if (field === 'phase') details.phase = 'unknown-transport-phase'
    else details.cleanup.state = 'unknown-transport-state'
    assert.throws(() => observer.observe(JSON.stringify({ stage: 'multipart-failed', key: winKey, details })))
  })
