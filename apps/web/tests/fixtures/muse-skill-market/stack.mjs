/** Actual private accounts, catalog and Host services for Skill-market browser interactions. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { createAccountServer } from '../../../../../services/muse-accounts/gateway.mjs'
import { createMarketProxy } from '../../../../../services/muse-accounts/market-proxy.mjs'
import { openStore } from '../../../../../services/muse-accounts/store.mjs'

export const name = 'muse-skill-market-browser-stack'
export const inject = ['skills', 'agents', 'sessionProjections', 'sessionQuery']
const repository = new URL('../../../../../', import.meta.url)
const limits = { archiveBytes: 1048576, expandedBytes: 2097152, fileCount: 32, recordBytes: 1048576 }
const password = 'browser-market-local-password'

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  // Chromium accepts the production Secure account cookie on its trusted localhost origin.
  return `http://localhost:${address.port}`
}
async function close(server) {
  if (server === undefined) return
  server.closeAllConnections()
  await new Promise((resolve, reject) => server.close(error => {
    if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') reject(error)
    else resolve()
  }))
}
function archive(packageModule, skillName, title, body, version = '1.0.0') {
  const manifest = { formatVersion: 1, kind: 'skill', name: skillName, title, version,
    description: 'Keep source scene order and dialogue.', license: 'MIT', category: 'writing',
    examples: ['Review the supplied scene.'], requirements: ['The original scene.'],
    skills: [{ name: skillName, path: `skills/${skillName}/SKILL.md` }] }
  const bytes = Buffer.from(packageModule.createMarketPackage(manifest, {
    [`skills/${skillName}/SKILL.md`]: Buffer.from(`---\nname: ${skillName}\ndescription: Keep source scene order and dialogue.\nwhenToUse: For scene continuity review.\n---\n${body}\n`),
    [`skills/${skillName}/references/rules.md`]: Buffer.from('Preserve the source scene order.\n'),
    [`skills/${skillName}/examples/scene.bin`]: Buffer.from([0, 255, 1, 128]),
  }, limits))
  return { manifest, bytes, sha256: packageModule.marketDigest(bytes), body }
}

/** Mount actual product plugins and seed publications only through authenticated HTTP writes. */
export async function apply(ctx) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'muse-skill-market-browser-')))
  const catalogContext = new Context()
  let gateway, carrier, proxy
  ctx.effect(() => async () => {
    const failures = []
    await close(gateway ?? carrier).catch(error => failures.push(error))
    await proxy?.close().catch(error => failures.push(error))
    await catalogContext.fiber.dispose().catch(error => failures.push(error))
    await rm(root, { recursive: true, force: true }).catch(error => failures.push(error))
    if (failures.length > 0) throw new AggregateError(failures, 'Skill-market browser fixture cleanup failed')
  })
  const load = path => import(new URL(path, repository).href)
  const [market, activation, cloud, cloudHost, web, packageModule, session, filesystem] = await Promise.all([
    load('packages/host/muse-market/lib/index.js'),
    load('packages/host/muse-market/lib/activation.js'),
    load('packages/host/muse-market/lib/cloud.js'),
    load('packages/host/muse-market/lib/cloud-host.js'),
    load('packages/host/webserver/lib/index.js'),
    load('packages/host/muse-market/lib/package.js'),
    load('packages/host/muse-account/lib/types/session.js'),
    load('packages/skill/skill-filesystem/lib/index.js'),
  ])
  const authorName = 'browser-author-review', authorRoot = join(root, 'creator-skills'), authorBody = 'Retain each source event and motive.'
  const authorFiles = {
    'SKILL.md': Buffer.from(`---\nname: ${authorName}\ndescription: Review source events and motives.\nwhenToUse: For script continuity review.\n---\n${authorBody}\n`),
    'references/rules.md': Buffer.from('Use the original scene order.\n'),
    'examples/source.bin': Buffer.from([0, 255, 2, 128]),
  }
  await mkdir(join(authorRoot, authorName, 'references'), { recursive: true })
  await mkdir(join(authorRoot, authorName, 'examples'), { recursive: true })
  for (const [path, bytes] of Object.entries(authorFiles)) await writeFile(join(authorRoot, authorName, path), bytes, { mode: 0o600 })
  await ctx.plugin(filesystem, { providerName: 'market-browser-author', includeDefaultRoots: false, includeProjectRoots: false,
    customSkillDirs: [authorRoot], watch: false }).await()
  const localArchive = archive(packageModule, 'browser-local-review', 'Local scene review', 'Never reverse the source scene order.')
  const localArchiveV2 = archive(packageModule, 'browser-local-review', 'Local scene review',
    'Version two checks each motive and preserves the source scene order.', '2.0.0')
  const cloudArchive = archive(packageModule, 'browser-cloud-review', 'Cloud scene review', 'Keep the original dialogue and sequence.')
  const secretFile = join(root, 'secret'), policyFile = join(root, 'catalog-policy.json')
  await writeFile(secretFile, 'browser-market-shared-secret-0000000000000000', { mode: 0o600 })
  await writeFile(policyFile, JSON.stringify({ root: join(root, 'catalog'), secretFile, limits,
    maxReleases: 20, maxActiveUploads: 4, jsonRequestBytes: 16384, jsonResponseBytes: 1048576, catalogLimit: 100 }), { mode: 0o600 })
  await catalogContext.plugin(web.default, { host: '127.0.0.1', port: 0, compression: 'none' }).await()
  await catalogContext.plugin(cloudHost, { policyFile }).await()
  proxy = await createMarketProxy({ upstream: catalogContext.webServer.getOrigin(), secretFile,
    archiveBytes: limits.archiveBytes, jsonRequestBytes: 16384, jsonResponseBytes: 1048576,
    requestTimeoutMs: 30000, requestRatePerMinute: 10000 })
  const store = await openStore(join(root, 'accounts.json'))
  const roles = {
    creator: await store.create('market_creator', password),
    admin: await store.create('market_admin', password, { admin: true }),
    reader: await store.create('market_reader', password),
  }
  carrier = createServer()
  const origin = await listen(carrier)
  let tenantStarts = 0
  gateway = createAccountServer({ httpServer: carrier, publicOrigin: origin, store, market: proxy, workspaceMode: 'desktop',
    cookieName: '__Host-muse', devOnlyAdmin: false, environment: 'development', maintenanceFile: join(root, 'maintenance.json'),
    runtime: { ensure: async () => { tenantStarts++; throw new Error('Skill-market browsing must not start a tenant') } } })
  const logouts = []
  const observeLogout = (request, response) => {
    if (request.method !== 'POST' || request.url?.split('?')[0] !== '/logout') return
    response.once('finish', () => { logouts.push({ method: request.method, path: '/logout', status: response.statusCode }) })
  }
  gateway.on('request', observeLogout)
  ctx.effect(() => () => { gateway.off('request', observeLogout) })
  const sessionFile = join(root, 'account', 'session.json')
  async function login(role) {
    const response = await fetch(origin + '/login', { method: 'POST', redirect: 'manual', headers: { origin },
      body: new URLSearchParams({ username: roles[role].username, password }) })
    assert.equal(response.status, 303)
    const cookie = response.headers.getSetCookie().find(value => value.startsWith('__Host-muse='))?.split(';')[0]
    assert.ok(cookie)
    return cookie
  }
  async function request(path, cookie, init = {}) {
    const response = await fetch(origin + '/api/market/v1' + path, { ...init,
      headers: { cookie, origin, ...init.headers }, signal: AbortSignal.timeout(30000) })
    assert.ok(response.ok, `${response.status}: ${await response.clone().text()}`)
    return response
  }
  const json = (body) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const adminCookie = await login('admin'), creatorCookie = await login('creator')
  const invitation = await request('/publishers', adminCookie, json({ title: 'Browser Studio', accountId: roles.creator.id }))
  const { id: publisherId } = await invitation.json()
  assert.match(publisherId, /^[a-f0-9]{32}$/u)
  const uploaded = await request('/uploads', creatorCookie, { method: 'POST', headers: {
    'content-type': 'application/zip', 'x-market-publisher': publisherId, 'idempotency-key': 'browser-seed-cloud-original',
  }, body: cloudArchive.bytes })
  const draft = await uploaded.json()
  assert.equal(draft.status, 'draft'); assert.equal(draft.sha256, cloudArchive.sha256)
  const submitted = await request(`/releases/${draft.id}/review`, creatorCookie, json({ revision: draft.revision, action: 'submit', note: '' }))
  const pending = await submitted.json()
  const approved = await request(`/releases/${draft.id}/review`, adminCookie,
    json({ revision: pending.revision, action: 'approve', note: 'Reviewed through the actual gateway.' }))
  const publication = await approved.json()
  assert.equal(publication.status, 'published'); assert.equal(publication.revision, 3)
  await session.writeMuseSession(sessionFile, { baseUrl: origin, cookie: creatorCookie, username: roles.creator.username })
  await ctx.plugin(market.default, { root: join(root, 'local'), ...limits }).await()
  await ctx.plugin(activation.default).await()
  await ctx.plugin(cloud.default, { baseUrl: origin, sessionFile, requestTimeoutMs: 30000,
    jsonRequestBytes: 16384, jsonResponseBytes: 1048576, catalogLimit: 100 }).await()
  ctx.provide('marketBrowserStack', {
    root, origin, roles, password, publisherId, publication, localArchive, localArchiveV2, cloudArchive,
    authorName, authorBody, authorFiles,
    logoutReceipts: () => logouts.map(value => ({ ...value })),
    tenantStarts: () => tenantStarts,
    async login(role) {
      const cookie = await login(role)
      await session.writeMuseSession(sessionFile, { baseUrl: origin, cookie, username: roles[role].username })
    },
  })
}
