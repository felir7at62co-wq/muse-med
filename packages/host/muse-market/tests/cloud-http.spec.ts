/** Real loopback admission, uncertain-response reconciliation and owned HTTP teardown. */
import { expect, it, onTestFinished, vi } from 'vitest'
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

const secret = 'test-market-private-secret-'.repeat(2)
const admin = { id: parseMarketAccountId('a'.repeat(16)), username: 'admin', admin: true }
const author = { id: parseMarketAccountId('b'.repeat(16)), username: 'author', admin: false }
const reader = { id: parseMarketAccountId('c'.repeat(16)), username: 'reader', admin: false }
const prefix = '/api/market/v1'
const encoded = (actor: MarketActor) => Buffer.from(JSON.stringify(actor)).toString('base64url')
const post = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const archive = () => Buffer.from(createMarketPackage(manifest, resources, limits))

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
  expect(await identity.json()).toEqual({ publishers: [], admin: false })
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
