/** Real loopback admission, uncertain-response reconciliation and owned HTTP teardown. */
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { WebServer } from '@deepseek-ai/dsh-host-webserver'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { connect } from 'node:net'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as CloudHost from '../src/cloud-host.ts'
import { MuseMarketCatalog } from '../src/server.ts'
import type { MarketServerConfig } from '../src/server.ts'
import { parseMarketAccountId, parseMarketPublication, parseMarketPublisherId } from '../src/cloud-protocol.ts'
import type { MarketActor } from '../src/cloud-protocol.ts'
import { createMarketPackage, marketDigest } from '../src/package.ts'
import { limits, manifest, resources } from './fixtures.ts'

const permissionUnit = vi.hoisted(() => {
  const state: { file?: string; bits: number; modeReads: number; restore?: () => void } = { bits: 0, modeReads: 0 }
  return state
})
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>()
  return { ...fs, lstat: async (...args: Parameters<typeof fs.lstat>) => {
    const metadata = await fs.lstat(...args)
    if (args[0] !== permissionUnit.file) return metadata
    const observed = Object.create(metadata) as typeof metadata
    return Object.defineProperties(observed, {
      isFile: { value: () => {
        const regular = metadata.isFile()
        if (regular) {
          const platform = Object.getOwnPropertyDescriptor(process, 'platform')
          if (platform === undefined) throw new Error('Missing platform descriptor')
          permissionUnit.restore = () => { Object.defineProperty(process, 'platform', platform) }
          Object.defineProperty(process, 'platform', { ...platform, value: 'linux' })
        }
        return regular
      } },
      mode: { get: () => {
        try { permissionUnit.modeReads++; return Number(metadata.mode) | permissionUnit.bits }
        finally { permissionUnit.restore?.(); delete permissionUnit.restore }
      } },
    })
  } }
})
afterEach(() => {
  permissionUnit.restore?.(); delete permissionUnit.restore; delete permissionUnit.file
  permissionUnit.bits = 0; permissionUnit.modeReads = 0
})

const secret = 'test-market-private-secret-'.repeat(2)
const admin = { id: parseMarketAccountId('a'.repeat(16)), username: 'admin', admin: true }
const author = { id: parseMarketAccountId('b'.repeat(16)), username: 'author', admin: false }
const reader = { id: parseMarketAccountId('c'.repeat(16)), username: 'reader', admin: false }
const prefix = '/api/market/v1'
const encoded = (actor: MarketActor) => Buffer.from(JSON.stringify(actor)).toString('base64url')
const post = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const archive = () => Buffer.from(createMarketPackage(manifest, resources, limits))

it('returns the package validation refusal over native HTTP and releases upload capacity for the next request', async () => {
  const f = await fixture(), publisher = await f.invite()
  const options = { method: 'POST', headers: { 'content-type': 'application/zip', 'x-market-publisher': publisher,
    'idempotency-key': 'invalid-then-valid-package' } }
  const refused = await f.api('/uploads', author, { ...options, body: 'not a ZIP archive' })
  expect(refused.status).toBe(400)
  expect(await refused.json()).toEqual({ error: 'invalid-archive' })
  const admitted = await f.api('/uploads', author, { ...options, body: new Uint8Array(archive()) })
  expect(admitted.status).toBe(201)
  expect(parseMarketPublication(await admitted.json(), limits)).toMatchObject({ status: 'draft', revision: 1 })
  const database = f.database()
  try { expect(database.prepare('SELECT COUNT(*) AS count FROM releases').get()?.count).toBe(1) }
  finally { database.close() }
})

it.each(['destroyed', 'ended'] as const)('unit: ignores late delivery after the native response is %s', async (ending) => {
  for (const operation of ['refusal', 'catalog', 'missing', 'download'] as const) {
    const f = await fixture()
    let path = operation === 'missing' ? '/absent' : '/catalog'
    if (operation === 'download') {
      const publisher = await f.invite()
      const uploaded = await f.api('/uploads', author, { method: 'POST', body: new Uint8Array(archive()),
        headers: { 'content-type': 'application/zip', 'x-market-publisher': publisher, 'idempotency-key': 'closed-carrier-cache' } })
      expect(uploaded.status).toBe(201)
      const record = parseMarketPublication(await uploaded.json(), limits)
      path = `/releases/${record.id}/download`
    }
    await f.close()
    const done = Promise.withResolvers<undefined>(), register = f.ctx.webServer.register.bind(f.ctx.webServer)
    let deliveries = 0, writes = 0
    const installing = vi.spyOn(f.ctx.webServer, 'register').mockImplementation((route) => {
      if (route.kind !== 'prefix' || route.path !== prefix || !('handler' in route)) return register(route)
      return register({ ...route, handler: async (request, response) => {
        deliveries++
        if (ending === 'destroyed') response.destroy()
        else response.end('carrier completed')
        const writing = vi.spyOn(response, 'writeHead')
        try { await route.handler(request, response) }
        finally { writes += writing.mock.calls.length; writing.mockRestore(); done.resolve(undefined) }
      } })
    })
    onTestFinished(() => { installing.mockRestore() })
    try {
      await f.open(); installing.mockRestore()
      const pending = (operation === 'refusal'
        ? fetch(f.origin + prefix + path)
        : f.api(path, author)).then(async response => ({ status: response.status, body: await response.text() }),
        (error: unknown) => ({ error }))
      await done.promise
      const result = await pending
      expect(deliveries).toBe(1)
      expect(writes).toBe(0)
      if (ending === 'destroyed') expect(result).toHaveProperty('error')
      else expect(result).toEqual({ status: 200, body: 'carrier completed' })
    } finally { installing.mockRestore(); await f.close() }
  }
})

it.each([
  { revision: '1', action: 'submit', note: '' },
  { revision: 1, action: 7, note: '' },
  { revision: 1, action: 'submit', note: 7 },
  { revision: 1, action: 'unsupported', note: '' },
])('refuses a malformed review DTO before any publication lookup or mutation %#', async (body) => {
  const f = await fixture(), response = await f.api(`/releases/${'0'.repeat(32)}/review`, author, post(body))
  expect(response.status).toBe(400)
  expect(await response.json()).toEqual({ error: 'invalid-request' })
  const database = f.database()
  try { expect(database.prepare('SELECT COUNT(*) AS count FROM releases').get()?.count).toBe(0) }
  finally { database.close() }
})

it.each([
  { file: 'policy.json', bits: 0o022, code: 'unsafe-policy' },
  { file: 'secret', bits: 0o077, code: 'unsafe-secret' },
])('unit: rejects POSIX mode bits on $file with a scoped OS/stat face', async ({ file, bits, code }) => {
  const f = await fixture(); await f.close()
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')
  permissionUnit.file = join(f.root, file); permissionUnit.bits = bits
  try {
    // Only the synchronous isFile/size/platform/mode expression sees this
    // OS face; the mode getter restores the descriptor before rejection.
    await expect(f.open()).rejects.toMatchObject({ code })
    expect(permissionUnit.modeReads).toBe(1)
    expect(permissionUnit.restore).toBeUndefined()
    expect(Object.getOwnPropertyDescriptor(process, 'platform')).toEqual(platform)
    expect((await fetch(f.origin + prefix + '/catalog')).status).toBe(404)
  } finally { permissionUnit.restore?.(); delete permissionUnit.restore; delete permissionUnit.file }
})

it.each(['policy.json', 'secret'])('refuses an oversized %s before re-registering the cloud route', async (file) => {
  const f = await fixture(); await f.close()
  await writeFile(join(f.root, file), 'x'.repeat(file === 'policy.json' ? 65537 : 1025))
  await expect(f.open()).rejects.toMatchObject({ code: file === 'policy.json' ? 'unsafe-policy' : 'unsafe-secret' })
  expect((await fetch(f.origin + prefix + '/catalog')).status).toBe(404)
})

it('refuses a noncanonical actor assertion before catalog admission', async () => {
  const f = await fixture()
  expect(Buffer.from('e31', 'base64url').toString()).toBe('{}')
  const response = await fetch(f.origin + prefix + '/catalog', {
    headers: { authorization: `Bearer ${secret}`, 'x-muse-market-actor': 'e31' },
  })
  expect(response.status).toBe(400)
  expect(await response.json()).toEqual({ error: 'invalid-actor' })
})

it('requires the dedicated IPv4 carrier even on another actual loopback address', async () => {
  const f = await fixture(), ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(WebServer, { host: '127.0.0.2', port: 0 }).await()
  await expect(ctx.plugin(CloudHost, { policyFile: join(f.root, 'policy.json') }).await())
    .rejects.toMatchObject({ code: 'loopback-required' })
})

it('releases a failed duplicate route acquisition before a later clean cloud boot', async () => {
  const f = await fixture(); await f.close()
  const release = f.ctx.webServer.register({ kind: 'prefix', path: prefix, handler: (_request, response) => { response.end('occupied') } })
  onTestFinished(release)
  try { await expect(f.open()).rejects.toThrow('duplicate prefix route') }
  finally { await f.close(); release() }
  await f.open()
  const response = await f.api('/catalog', null)
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ items: [] })
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'muse-market-http-')), ctx = new Context()
  let handle: { dispose(): Promise<void> } | undefined
  const close = async () => { await handle?.dispose(); handle = undefined }
  onTestFinished(async () => {
    try { await close() } finally {
      try { await ctx.fiber.dispose() } finally { await rm(root, { recursive: true, force: true }) }
    }
  })
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 }).await()
  const config: MarketServerConfig = { root: join(root, 'catalog'), limits, maxReleases: 100, maxActiveUploads: 2,
    jsonRequestBytes: 16384, jsonResponseBytes: 2 * 1024 * 1024, catalogLimit: 100 }
  const secretFile = join(root, 'secret'), policyFile = join(root, 'policy.json')
  await writeFile(secretFile, secret, { mode: 0o600 })
  const writePolicy = async (extra: Partial<MarketServerConfig> = {}) => {
    await writeFile(policyFile, JSON.stringify({ ...config, ...extra, secretFile }), { mode: 0o600 })
  }
  await writePolicy()
  const open = async () => {
    const fiber = ctx.plugin(CloudHost, { policyFile }); handle = fiber; await fiber.await()
  }
  await open()
  const origin = `http://127.0.0.1:${ctx.webServer.port}`
  const api = (path: string, actor: MarketActor | null, init: RequestInit = {}) => {
    const headers = new Headers(init.headers); headers.set('authorization', `Bearer ${secret}`)
    if (actor !== null) headers.set('x-muse-market-actor', encoded(actor))
    return fetch(origin + prefix + path, { ...init, headers })
  }
  const invite = async () => {
    const response = await api('/publishers', admin, post({ title: 'HTTP team', accountId: author.id }))
    expect(response.status).toBe(201)
    const value: unknown = await response.json()
    if (value === null || typeof value !== 'object' || !('id' in value)) throw new Error('Missing publisher identity')
    return parseMarketPublisherId(value.id)
  }
  const database = () => new DatabaseSync(join(config.root, 'market.sqlite'))
  return { root, ctx, config, origin, api, invite, database, close, open, writePolicy }
}

async function heldReply(origin: string, path: string, actor: MarketActor, body: Buffer,
  headers: Record<string, string>, contentLength = body.byteLength) {
  const url = new URL(origin), socket = connect({ host: url.hostname, port: Number(url.port) })
  const closed = new Promise<void>((resolve) => { socket.once('close', () => { resolve() }) })
  const errors: Error[] = []; socket.on('error', (error) => { errors.push(error) })
  onTestFinished(async () => { socket.destroy(); await closed })
  await once(socket, 'connect')
  socket.pause()
  let received = 0; socket.on('data', (chunk) => { received += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.byteLength })
  const fields = { host: url.host, authorization: `Bearer ${secret}`, 'x-muse-market-actor': encoded(actor),
    'content-length': String(contentLength), connection: 'close', ...headers }
  const head = `POST ${prefix + path} HTTP/1.1\r\n` + Object.entries(fields).map(([name, value]) => `${name}: ${value}\r\n`).join('') + '\r\n'
  socket.write(Buffer.concat([Buffer.from(head), body]))
  return { socket, closed, errors, received: () => received }
}

it('authenticates the private gateway before reading a complete actor assertion', async () => {
  const f = await fixture()
  expect((await fetch(f.origin + prefix + '/catalog')).status).toBe(401)
  expect((await f.api('/catalog', null)).status).toBe(200)
  expect((await f.api('/me', null)).status).toBe(401)
  expect((await fetch(f.origin + prefix + '/me', { headers: { authorization: `Bearer ${secret}`,
    'x-muse-market-actor': encoded(admin) + '!' } })).status).toBe(400)
  expect((await fetch(f.origin + prefix + '/me', { headers: { authorization: `Bearer ${secret}`,
    'x-muse-market-actor': Buffer.from(JSON.stringify({ ...admin, admin: 'yes' })).toString('base64url') } })).status).toBe(400)
  const identity = await f.api('/me', reader)
  expect(await identity.json()).toEqual({ accountId: reader.id, publishers: [], admin: false })
})

it.each([
  { maxReleases: 0 }, { maxActiveUploads: 33 }, { catalogLimit: 101 },
  { jsonRequestBytes: 1023 }, { jsonResponseBytes: 64 * 1024 * 1024 + 1 },
  { root: 'relative-catalog' }, { limits: { ...limits, fileCount: 1 } },
])('rejects invalid deployment policy before reopening its cloud route %#', async (change) => {
  const f = await fixture(); await f.close(); await f.writePolicy(change)
  await expect(f.open()).rejects.toMatchObject({ code: 'invalid-policy' })
  const response = await fetch(f.origin + prefix + '/catalog')
  expect(response.status).toBe(404)
})

it('requires an absolute policy file and a bounded secret before registering a cloud route', async () => {
  const f = await fixture(); await f.close()
  const relative = f.ctx.plugin(CloudHost, { policyFile: 'relative-policy.json' })
  try { await expect(relative.await()).rejects.toMatchObject({ code: 'invalid-policy' }) }
  finally { await relative.dispose() }
  await writeFile(join(f.root, 'secret'), 'too-short')
  await expect(f.open()).rejects.toMatchObject({ code: 'invalid-secret' })
  expect((await fetch(f.origin + prefix + '/catalog')).status).toBe(404)
})

it.each([
  ['/catalog?kind=bot', 400, 'skill-only'], ['/catalog?mine=perhaps', 400, 'invalid-query'],
  ['/catalog?q=' + 'x'.repeat(201), 400, 'invalid-query'], ['/absent', 404, 'not-found'],
] as const)('returns the explicit catalog refusal for %s', async (path, status, error) => {
  const f = await fixture(), response = await f.api(path, author)
  expect(response.status).toBe(status)
  expect(await response.json()).toEqual({ error })
})

it.each(['{', '[]', '{"title":"HTTP team"}'])('refuses an invalid publisher request body %#', async (body) => {
  const f = await fixture(), response = await f.api('/publishers', admin, { method: 'POST', body })
  expect(response.status).toBe(400)
  expect(await response.json()).toEqual({ error: body === '{' ? 'invalid-json' : 'invalid-request' })
  const database = f.database()
  try { expect(database.prepare('SELECT COUNT(*) AS count FROM publishers').get()?.count).toBe(0) }
  finally { database.close() }
})

it('reconciles a committed upload after its original HTTP response is deliberately unobserved', async () => {
  const f = await fixture(), publisher = await f.invite(), bytes = archive()
  const committed = Promise.withResolvers<Awaited<ReturnType<MuseMarketCatalog['upload']>>>()
  // oxlint-disable-next-line typescript/unbound-method -- The observer reapplies the original receiver with apply().
  const original = MuseMarketCatalog.prototype.upload
  const spy = vi.spyOn(MuseMarketCatalog.prototype, 'upload').mockImplementation(async function (this: MuseMarketCatalog, ...args) {
    const value = await original.apply(this, args); committed.resolve(value); return value
  })
  onTestFinished(() => { spy.mockRestore() })
  const headers = { 'content-type': 'application/zip', 'x-market-publisher': publisher, 'idempotency-key': 'lost-upload-original' }
  const lost = await heldReply(f.origin, '/uploads', author, bytes, headers)
  const publication = await committed.promise
  expect(lost.received()).toBe(0)
  lost.socket.destroy(); await lost.closed
  const retry = await f.api('/uploads', author, { method: 'POST', headers, body: bytes })
  expect(retry.status).toBe(201)
  const restored = parseMarketPublication(await retry.json(), limits)
  expect(restored).toEqual(publication)
  const database = f.database()
  try { expect(database.prepare('SELECT COUNT(*) AS count FROM releases').get()?.count).toBe(1) }
  finally { database.close() }
  expect(await readdir(join(f.config.root, 'blobs'))).toEqual([publication.sha256 + '.zip'])
  expect(await readFile(join(f.config.root, 'blobs', publication.sha256 + '.zip'))).toEqual(bytes)
  const conflict = await f.api('/uploads', author, { method: 'POST', headers,
    body: Buffer.from(createMarketPackage({ ...manifest, version: '2.0.0' }, resources, limits)) })
  expect(conflict.status).toBe(409)
})

it('reads the original publication after a lost review response and refuses its stale revision', async () => {
  const f = await fixture(), publisher = await f.invite()
  const upload = await f.api('/uploads', author, { method: 'POST', headers: {
    'content-type': 'application/zip', 'x-market-publisher': publisher, 'idempotency-key': 'review-original-upload',
  }, body: archive() })
  const draft = parseMarketPublication(await upload.json(), limits)
  const committed = Promise.withResolvers<Awaited<ReturnType<MuseMarketCatalog['transition']>>>()
  // oxlint-disable-next-line typescript/unbound-method -- The observer reapplies the original receiver with apply().
  const original = MuseMarketCatalog.prototype.transition
  const spy = vi.spyOn(MuseMarketCatalog.prototype, 'transition').mockImplementation(async function (this: MuseMarketCatalog, ...args) {
    const value = await original.apply(this, args); committed.resolve(value); return value
  })
  onTestFinished(() => { spy.mockRestore() })
  const body = Buffer.from(JSON.stringify({ revision: draft.revision, action: 'submit', note: '' }))
  const lost = await heldReply(f.origin, `/releases/${draft.id}/review`, author, body, { 'content-type': 'application/json' })
  const pending = await committed.promise
  expect(lost.received()).toBe(0); lost.socket.destroy(); await lost.closed
  expect(pending).toMatchObject({ id: draft.id, status: 'pending', revision: 2 })
  const readback = await f.api(`/releases/${draft.id}`, author)
  expect(parseMarketPublication(await readback.json(), limits)).toEqual(pending)
  expect((await f.api(`/releases/${draft.id}/review`, author, post({ revision: 1, action: 'submit', note: '' }))).status).toBe(409)
  const database = f.database()
  try { expect(database.prepare('SELECT COUNT(*) AS count FROM reviews').get()?.count).toBe(1) }
  finally { database.close() }
})

it('owns partial upload readers through unload and reopens the same catalog without a stale reservation', async () => {
  const f = await fixture(), publisher = await f.invite(), bytes = archive()
  const reserved = Promise.withResolvers<undefined>()
  // oxlint-disable-next-line typescript/unbound-method -- The observer reapplies the original receiver with apply().
  const original = MuseMarketCatalog.prototype.reserveUpload
  const spy = vi.spyOn(MuseMarketCatalog.prototype, 'reserveUpload').mockImplementation(function (this: MuseMarketCatalog, ...args) {
    const release = original.apply(this, args); reserved.resolve(undefined); return release
  })
  onTestFinished(() => { spy.mockRestore() })
  const headers = { 'content-type': 'application/zip', 'x-market-publisher': publisher, 'idempotency-key': 'partial-upload-key' }
  const partial = await heldReply(f.origin, '/uploads', author, bytes.subarray(0, 16), headers, bytes.byteLength)
  await reserved.promise
  expect((await f.api('/uploads', author, { method: 'POST', headers, body: bytes })).status).toBe(429)
  await f.close(); partial.socket.destroy(); await partial.closed
  await f.open()
  const completed = await f.api('/uploads', author, { method: 'POST', headers, body: bytes })
  expect(completed.status).toBe(201)
  const publication = parseMarketPublication(await completed.json(), limits)
  expect(publication.sha256).toBe(marketDigest(bytes))
  const download = await f.api(`/releases/${publication.id}/download`, author)
  expect(download.headers.get('x-content-sha256')).toBe(publication.sha256)
  expect(download.headers.get('content-length')).toBe(String(bytes.byteLength))
  expect(Buffer.from(await download.arrayBuffer())).toEqual(bytes)
})

it('refuses oversized JSON responses explicitly and admits no oversized request record', async () => {
  const f = await fixture(), publisher = await f.invite()
  const bytes = Buffer.from(createMarketPackage({ ...manifest, description: 'Large metadata '.repeat(90) }, resources, limits))
  const uploaded = await f.api('/uploads', author, { method: 'POST', headers: {
    'content-type': 'application/zip', 'x-market-publisher': publisher, 'idempotency-key': 'bounded-response-key',
  }, body: bytes })
  const publication = parseMarketPublication(await uploaded.json(), limits)
  await f.close(); await f.writePolicy({ jsonResponseBytes: 1024, jsonRequestBytes: 1024 }); await f.open()
  const result = await f.api('/catalog?mine=true', author)
  expect(result.status).toBe(507); expect(await result.json()).toEqual({ error: 'response-too-large' })
  expect((await f.api(`/releases/${publication.id}/review`, author, { method: 'POST', body: Buffer.alloc(1025) })).status).toBe(413)
  const database = f.database()
  try { expect(database.prepare('SELECT revision FROM releases WHERE id=?').get(publication.id)?.revision).toBe(1) }
  finally { database.close() }
})
