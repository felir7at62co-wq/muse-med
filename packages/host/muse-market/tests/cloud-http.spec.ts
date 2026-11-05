/** Exercise the real market provider, gateway assertions and catalog HTTP routes. */
import { chmod, mkdtemp, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { WebServer } from '@deepseek-ai/dsh-host-webserver'
import { expect, it, onTestFinished } from 'vitest'
import * as CloudHost from '../src/cloud-host.ts'
import { createMarketPackage, marketDigest } from '../src/package.ts'
import type { MarketActor, MarketManifest } from '../src/types.ts'

const secret = 'a'.repeat(48)
const authorization = 'Bearer ' + secret
const prefix = '/api/market/v1'
const admin = { id: 'a'.repeat(16), username: 'admin', admin: true }
const author = { id: 'b'.repeat(16), username: 'author', admin: false }
const reader = { id: 'c'.repeat(16), username: 'reader', admin: false }
const limits = { archiveBytes: 1024, expandedBytes: 4096, fileCount: 32 }
const manifest: MarketManifest = { formatVersion: 1, kind: 'skill', name: 'review', title: 'Review',
  description: 'Review scenes', version: '1.0.0', category: 'Production', license: 'MIT', examples: [], requirements: [],
  skills: [{ name: 'review', path: 'skills/review/SKILL.md' }] }

function archive() {
  return Buffer.from(createMarketPackage(manifest, { 'skills/review/SKILL.md': Buffer.from(
    '---\nname: review\ndescription: Review scenes\n---\nReview the supplied scenes.\n',
  ) }, limits, []))
}

function actorHeader(actor: unknown) {
  return Buffer.from(JSON.stringify(actor)).toString('base64url')
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'muse-market-http-'))
  const ctx = new Context()
  let dispose: (() => Promise<void>) | undefined
  onTestFinished(async () => {
    try { await dispose?.() }
    finally {
      try { await ctx.fiber.dispose() }
      finally { await rm(root, { recursive: true, force: true }) }
    }
  })
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 }).await()
  const policyFile = join(root, 'policy.json')
  const secretFile = join(root, 'gateway-secret')
  const storage = join(root, 'market')
  const policy = { root: storage, secretFile, allowedPlugins: ['@deepseek-ai/dsh-persona'],
    maxReleases: 20, maxActiveUploads: 1, limits }
  await writeFile(secretFile, secret + '\n', { mode: 0o600 })
  const writePolicy = (value: unknown) => writeFile(policyFile, JSON.stringify(value), { mode: 0o600 })
  await writePolicy(policy)
  const origin = 'http://127.0.0.1:' + String(ctx.webServer.port)
  return {
    root, storage, policy, policyFile, secretFile, origin, writePolicy,
    open: async (path = policyFile) => { dispose = await CloudHost.apply(ctx, { policyFile: path }) },
    close: async () => { await dispose?.(); dispose = undefined },
  }
}

async function api(origin: string, path: string, actor?: MarketActor, init?: RequestInit) {
  const headers = new Headers(init?.headers)
  headers.set('authorization', authorization)
  if (actor) headers.set('x-muse-market-actor', actorHeader(actor))
  return await fetch(origin + prefix + path, { ...init, headers })
}

function post(body: unknown): RequestInit {
  return { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
}

async function outcome(response: Response) {
  const body: unknown = await response.json()
  return { status: response.status, body }
}

function replyId(value: unknown): string {
  if (!value || typeof value !== 'object' || !('id' in value) || typeof value.id !== 'string') {
    throw new Error('Market did not return a release or publisher ID')
  }
  return value.id
}

async function invite(origin: string): Promise<string> {
  const response = await api(origin, '/publishers', admin, post({ title: 'Studio', accountId: author.id }))
  expect(response.status).toBe(201)
  return replyId(await response.json())
}

it('rejects a direct authenticated Bot ZIP upload before creating a cloud release', async () => {
  const fixture = await setup()
  await fixture.open()
  const publisher = await invite(fixture.origin)
  const bytes = createMarketPackage({ ...manifest, kind: 'bot', skills: [], plugins: [] }, {}, limits, [])
  const uploaded = await api(fixture.origin, '/uploads', author, { method: 'POST', headers: {
    'content-type': 'application/zip', 'x-market-publisher': publisher, 'idempotency-key': 'retired-bot-upload',
  }, body: Buffer.from(bytes) })
  expect(await outcome(uploaded)).toEqual({ status: 400, body: { error: 'skill-only' } })
  expect(await outcome(await api(fixture.origin, '/catalog?mine=true', author)))
    .toEqual({ status: 200, body: { items: [] } })
})

it('validates the administrator policy, bounded limits and private secret before registering a route', async () => {
  const fixture = await setup()
  const { root, policy, policyFile, secretFile, writePolicy } = fixture
  await expect(fixture.open('relative-policy.json')).rejects.toThrow('Market requires loopback and an absolute policy path')
  await expect(fixture.open(root)).rejects.toThrow('Market policy must be administrator-owned')
  const policyLink = join(root, 'policy-link')
  await symlink(root, policyLink, 'junction')
  try { await expect(fixture.open(policyLink)).rejects.toThrow('Market policy must be administrator-owned') }
  finally { await unlink(policyLink) }

  for (const invalid of [null, 42, [], { ...policy, root: 0 }, { ...policy, secretFile: null },
    { ...policy, secretFile: 'relative-secret' }, { ...policy, allowedPlugins: {} },
    { ...policy, allowedPlugins: [42] }, { ...policy, allowedPlugins: ['foreign'] },
    { ...policy, limits: null }, { ...policy, limits: 'limits' }, { ...policy, limits: [] }]) {
    await writePolicy(invalid)
    await expect(fixture.open()).rejects.toThrow('Invalid market policy')
  }
  for (const maxReleases of ['20', 1.5, 0, 100001]) {
    await writePolicy({ ...policy, maxReleases })
    await expect(fixture.open()).rejects.toThrow('Invalid market resource limit')
  }
  await writePolicy({ ...policy, secretFile: root })
  await expect(fixture.open()).rejects.toThrow('Market secret file must be private')
  const secretLink = join(root, 'secret-link')
  await symlink(root, secretLink, 'junction')
  try {
    await writePolicy({ ...policy, secretFile: secretLink })
    await expect(fixture.open()).rejects.toThrow('Market secret file must be private')
  } finally { await unlink(secretLink) }
  await writePolicy(policy)

  if (process.platform !== 'win32') {
    await chmod(policyFile, 0o622)
    await expect(fixture.open()).rejects.toThrow('Market policy must be administrator-owned')
    await chmod(policyFile, 0o600)
    await chmod(secretFile, 0o644)
    await expect(fixture.open()).rejects.toThrow('Market secret file must be private')
    await chmod(secretFile, 0o600)
  }
  await writeFile(secretFile, 'short')
  await expect(fixture.open()).rejects.toThrow('Invalid market gateway secret')
  await writeFile(secretFile, secret)
  await fixture.open()
  expect(await outcome(await api(fixture.origin, '/catalog'))).toEqual({ status: 200, body: { items: [] } })
  await fixture.close()
  expect((await api(fixture.origin, '/catalog')).status).toBe(404)
})

it('rejects untrusted gateway authorization and invalid actor assertions before route admission', async () => {
  const { origin, open } = await setup()
  await open()
  const me = origin + prefix + '/me'
  expect((await fetch(me)).status).toBe(401)
  for (const invalid of ['', 'Bearer ' + 'b'.repeat(48)]) {
    expect((await fetch(me, { headers: { authorization: invalid } })).status).toBe(401)
  }
  for (const invalid of ['x'.repeat(1025), '---',
    ...[null, 1, {}, { id: 0 }, { id: 'short' }, { id: admin.id }, { ...admin, username: 0 },
      { ...admin, username: '' }, { ...admin, username: 'n'.repeat(33) },
      { id: admin.id, username: 'admin' }, { ...admin, admin: 'yes' }].map(actorHeader)]) {
    expect((await fetch(me, { headers: { authorization, 'x-muse-market-actor': invalid } })).status).toBe(400)
  }
  expect(await outcome(await api(origin, '/me'))).toEqual({ status: 401, body: { error: 'login-required' } })
  expect(await outcome(await api(origin, '/me', reader))).toEqual({ status: 200, body: { publishers: [], admin: false } })
})

it('serves authenticated invitations, immutable uploads, review transitions and exact downloads', async () => {
  const { origin, storage, open } = await setup()
  await open()
  const team = await invite(origin)
  const bytes = archive()
  const requestHeaders = { 'content-type': 'application/zip', 'x-market-publisher': team, 'idempotency-key': 'upload-0001' }
  const upload = (actor: MarketActor, init?: RequestInit) => api(origin, '/uploads', actor, {
    method: 'POST', body: bytes, headers: requestHeaders, ...init,
  })
  expect(await outcome(await api(origin, '/me', author))).toEqual({ status: 200, body: {
    publishers: [{ id: team, title: 'Studio' }], admin: false,
  } })
  expect(await outcome(await api(origin, '/me', admin))).toEqual({ status: 200, body: {
    publishers: [{ id: team, title: 'Studio' }], admin: true,
  } })
  expect(await outcome(await upload(reader))).toEqual({ status: 403, body: { error: 'publisher-required' } })
  expect(await outcome(await upload(author, { headers: {} }))).toEqual({ status: 404, body: { error: 'not-found' } })
  expect(await outcome(await upload(author, { headers: { 'x-market-publisher': team } }))).toEqual({
    status: 400, body: { error: 'invalid-request-id' },
  })
  expect(await outcome(await upload(author, { body: Buffer.alloc(limits.archiveBytes + 1) }))).toEqual({
    status: 413, body: { error: 'request-too-large' },
  })
  const created = await upload(author)
  expect(created.status).toBe(201)
  const draft: unknown = await created.json()
  const releasePath = '/releases/' + replyId(draft)
  expect(draft).toMatchObject({ revision: 1, status: 'draft', publisherId: team, sha256: marketDigest(bytes) })
  expect(await outcome(await api(origin, releasePath))).toEqual({ status: 404, body: { error: 'not-found' } })
  expect(await outcome(await api(origin, '/catalog?mine=true', author))).toEqual({ status: 200, body: { items: [draft] } })
  expect(await outcome(await api(origin, '/catalog?mine=true', admin))).toEqual({ status: 200, body: { items: [draft] } })
  expect(await outcome(await api(origin, '/catalog?mine=true', reader))).toEqual({ status: 200, body: { items: [] } })
  expect(await outcome(await api(origin, '/catalog?mine=true'))).toEqual({ status: 401, body: { error: 'login-required' } })
  const review = (actor: MarketActor, revision: number, action: string, note?: string) =>
    api(origin, releasePath + '/review', actor, post({ revision, action, note }))
  expect(await outcome(await review(author, 1, 'submit'))).toMatchObject({ status: 200, body: { status: 'pending', revision: 2 } })
  expect(await outcome(await review(admin, 2, 'reject', ' '))).toEqual({ status: 409, body: { error: 'invalid-transition' } })
  expect(await outcome(await review(admin, 2, 'reject', 'n'.repeat(2001)))).toEqual({ status: 400, body: { error: 'invalid-review' } })
  expect(await outcome(await review(admin, 2, 'reject', 'Check the license'))).toMatchObject({
    status: 200, body: { status: 'rejected', revision: 3, reviewNote: 'Check the license' },
  })
  expect(await outcome(await review(author, 3, 'submit', ''))).toMatchObject({ status: 200, body: { status: 'pending', revision: 4 } })
  const approved = await outcome(await review(admin, 4, 'approve', 'Reviewed'))
  expect(approved).toMatchObject({ status: 200, body: { status: 'published', revision: 5 } })
  expect(await outcome(await api(origin, releasePath))).toEqual(approved)
  expect(await outcome(await api(origin, '/catalog?q=studio+review&kind=skill'))).toEqual({
    status: 200, body: { items: [approved.body] },
  })
  expect(await outcome(await api(origin, '/catalog?q=' + 'x'.repeat(201)))).toEqual({ status: 400, body: { error: 'invalid-query' } })
  expect(await outcome(await api(origin, '/catalog?kind=unknown'))).toEqual({ status: 400, body: { error: 'invalid-query' } })
  expect(await outcome(await api(origin, releasePath + '/download'))).toEqual({ status: 401, body: { error: 'login-required' } })
  const download = await api(origin, releasePath + '/download', reader)
  expect(download.status).toBe(200)
  expect(download.headers.get('x-content-sha256')).toBe(marketDigest(bytes))
  expect(download.headers.get('content-disposition')).toBe('attachment; filename="review-1.0.0.zip"')
  expect(Buffer.from(await download.arrayBuffer())).toEqual(bytes)
  await unlink(join(storage, 'blobs', marketDigest(bytes) + '.zip'))
  expect(await outcome(await api(origin, releasePath + '/download', reader))).toEqual({ status: 500, body: { error: 'market-unavailable' } })
  expect(await outcome(await review(author, 5, 'withdraw', 'Archived'))).toMatchObject({ status: 200, body: { status: 'withdrawn' } })
  expect(await outcome(await api(origin, '/catalog'))).toEqual({ status: 200, body: { items: [] } })
})

it('returns bounded client errors for malformed JSON, unsupported methods and invalid route arguments', async () => {
  const { origin, open } = await setup()
  await open()
  for (const body of ['{', 'null', 'false', '[]']) {
    expect(await outcome(await api(origin, '/publishers', admin, { method: 'POST', body }))).toEqual({
      status: 400, body: { error: 'invalid-json' },
    })
  }
  expect(await outcome(await api(origin, '/publishers', admin, { method: 'POST', body: 'x'.repeat(16385) }))).toEqual({
    status: 413, body: { error: 'request-too-large' },
  })
  const releasePath = '/releases/' + 'a'.repeat(32) + '/review'
  for (const [path, body] of [['/unknown', {}], ['/publishers', {}], ['/publishers', { title: 'Studio' }],
    [releasePath, { revision: '1', action: 'submit' }], [releasePath, { revision: 1, action: 42 }]] as const) {
    expect(await outcome(await api(origin, path, admin, post(body)))).toEqual({ status: 400, body: { error: 'invalid-request' } })
  }
  expect(await outcome(await api(origin, '/catalog', admin, { method: 'DELETE' }))).toEqual({ status: 404, body: { error: 'not-found' } })
})

it('cancels an incomplete upload and waits for the request to close during provider teardown', async () => {
  const fixture = await setup()
  await fixture.open()
  const team = await invite(fixture.origin)
  const headers = { authorization, 'x-muse-market-actor': actorHeader(author), 'x-market-publisher': team,
    'idempotency-key': 'unfinished-upload', 'content-length': '100' }
  const upload = request(fixture.origin + prefix + '/uploads', { method: 'POST', headers })
  const closed = Promise.withResolvers<undefined>()
  const disconnected = Promise.withResolvers<Error>()
  upload.once('error', disconnected.resolve)
  upload.once('close', () => { closed.resolve(undefined) })
  onTestFinished(async () => { upload.destroy(); await closed.promise })
  upload.write('partial')
  await expect.poll(async () => {
    const response = await api(fixture.origin, '/uploads', author, { method: 'POST', body: 'invalid',
      headers: { 'x-market-publisher': team, 'idempotency-key': 'contention-probe' } })
    await response.text()
    return response.status
  }, { timeout: 10000 }).toBe(429)
  await fixture.close()
  await closed.promise
  await expect(disconnected.promise).resolves.toMatchObject({ code: 'ECONNRESET' })
  expect((await api(fixture.origin, '/catalog')).status).toBe(404)
})
