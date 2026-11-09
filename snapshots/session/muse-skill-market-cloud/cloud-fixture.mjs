/** Real gateway authentication, cloud moderation and digest-selected disabled local installation. */
import assert from 'node:assert/strict'
import http from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAccountServer } from '../../../services/muse-accounts/gateway.mjs'
import { createMarketProxy } from '../../../services/muse-accounts/market-proxy.mjs'
import { openStore } from '../../../services/muse-accounts/store.mjs'
import { importSnapshotModule } from '../muse-fixture-import.mjs'

export const name = 'market-cloud-fixture'
export const inject = ['tools', 'skills', 'agents', 'sessions', 'sessionProjections']
const publisherId = '11111111111111111111111111111111'
const publicationId = '22222222222222222222222222222222'
const createdAt = '2026-11-09T00:00:00.000Z'
const limits = { archiveBytes: 1048576, expandedBytes: 2097152, fileCount: 32, recordBytes: 1048576 }
const operations = ['read-draft', 'submit', 'reader-private', 'approve', 'install']

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  return `http://127.0.0.1:${address.port}`
}
async function close(server) {
  if (server === undefined) return
  server.closeAllConnections()
  await new Promise((resolve, reject) => server.close(error => {
    if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') reject(error)
    else resolve()
  }))
}

/**
 * Exercise actual HTTP roles and whole Remote results through a supported Headless profile.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Shipped Headless context.
 * @param {{executor:'native'|'ptc'}} config - Actual executor selected by the scenario patch.
 */
export async function apply(ctx, config) {
  const root = await mkdtemp(join(tmpdir(), 'muse-market-cloud-snapshot-'))
  let gateway, carrier, proxy, webFiber, hostFiber, clientFiber
  ctx.effect(() => async () => {
    await clientFiber?.dispose()
    await close(gateway ?? carrier)
    await proxy?.close()
    await hostFiber?.dispose()
    await webFiber?.dispose()
    await rm(root, { recursive: true, force: true })
  })
  const market = await importSnapshotModule(new URL('../../../packages/host/muse-market/src/index.ts', import.meta.url),
    new URL('../../../packages/host/muse-market/lib/index.js', import.meta.url))
  const activation = await importSnapshotModule(new URL('../../../packages/host/muse-market/src/activation.ts', import.meta.url),
    new URL('../../../packages/host/muse-market/lib/activation.js', import.meta.url))
  const archiveModule = await importSnapshotModule(new URL('../../../packages/host/muse-market/src/package.ts', import.meta.url),
    new URL('../../../packages/host/muse-market/lib/package.js', import.meta.url))
  const backend = await importSnapshotModule(new URL('../../../packages/host/muse-market/src/server.ts', import.meta.url),
    new URL('../../../packages/host/muse-market/lib/types/server.js', import.meta.url))
  const host = await importSnapshotModule(new URL('../../../packages/host/muse-market/src/cloud-host.ts', import.meta.url),
    new URL('../../../packages/host/muse-market/lib/cloud-host.js', import.meta.url))
  const client = await importSnapshotModule(new URL('../../../packages/host/muse-market/src/cloud.ts', import.meta.url),
    new URL('../../../packages/host/muse-market/lib/cloud.js', import.meta.url))
  const web = await importSnapshotModule(new URL('../../../packages/host/webserver/src/index.ts', import.meta.url),
    new URL('../../../packages/host/webserver/lib/index.js', import.meta.url))
  const sessions = await importSnapshotModule(new URL('../../../packages/host/muse-account/src/session.ts', import.meta.url),
    new URL('../../../packages/host/muse-account/lib/types/session.js', import.meta.url))
  const store = await openStore(join(root, 'accounts.json'))
  const creator = await store.create('snapshot_creator', 'snapshot-password')
  await store.create('snapshot_admin', 'snapshot-password', { admin: true })
  await store.create('snapshot_reader', 'snapshot-password')
  const manifest = { formatVersion: 1, kind: 'skill', name: 'cloud-scene-review', title: 'Cloud scene review',
    description: 'Review continuity using an immutable Skill publication.', version: '1.0.0', license: 'MIT',
    category: 'writing', examples: ['Review the supplied scene.'], requirements: ['The original scene.'],
    skills: [{ name: 'cloud-scene-review', path: 'skills/cloud-scene-review/SKILL.md' }] }
  const resources = {
    'skills/cloud-scene-review/SKILL.md': Buffer.from('---\nname: cloud-scene-review\ndescription: Review continuity using an immutable Skill publication.\nwhenToUse: For scene continuity review.\n---\nPreserve the original action and dialogue.\n'),
    'skills/cloud-scene-review/references/rules.md': Buffer.from('Retain the source scene order.\n'),
    'skills/cloud-scene-review/examples/scene.bin': Buffer.from([0, 255, 1, 128]),
  }
  const archive = archiveModule.createMarketPackage(manifest, resources, limits)
  const parsed = archiveModule.readMarketPackage(archive, limits)
  const sha256 = archiveModule.marketDigest(archive)
  const storage = join(root, 'catalog')
  const policy = { root: storage, secretFile: join(root, 'secret'), maxReleases: 20, maxActiveUploads: 4,
    limits, jsonRequestBytes: 16384, jsonResponseBytes: 1048576, catalogLimit: 100 }
  await writeFile(policy.secretFile, 'snapshot-market-shared-secret-0000000000000000', { mode: 0o600 })
  const seedOwner = await backend.MuseMarketCatalog.open(policy)
  await seedOwner.close()
  await mkdir(join(storage, 'blobs'), { recursive: true })
  await writeFile(join(storage, 'blobs', sha256 + '.zip'), archive, { mode: 0o600 })
  const database = new DatabaseSync(join(storage, 'market.sqlite'))
  try {
    database.prepare('INSERT INTO publishers(id,title) VALUES(?,?)').run(publisherId, 'Snapshot Studio')
    database.prepare('INSERT INTO members(publisherId,accountId) VALUES(?,?)').run(publisherId, creator.id)
    database.prepare(`INSERT INTO releases(id,publisherId,manifest,name,version,sha256,bytes,status,reviewNote,revision,createdAt,actorId,requestId)
      VALUES(?,?,?,?,?,?,?,'draft','',1,?,?,?)`).run(publicationId, publisherId, JSON.stringify(parsed.manifest),
      parsed.manifest.name, parsed.manifest.version, sha256, archive.byteLength, createdAt, creator.id, 'snapshot-upload-original')
  } finally { database.close() }
  const policyFile = join(root, 'policy.json')
  await writeFile(policyFile, JSON.stringify(policy), { mode: 0o600 })
  webFiber = ctx.plugin(web.default, { host: '127.0.0.1', port: 0, compression: 'none' }); await webFiber.await()
  let webServer
  await ctx.inject(['webServer'], owner => { webServer = owner.webServer }).await()
  assert.ok(webServer)
  hostFiber = ctx.plugin(host, { policyFile }); await hostFiber.await()
  proxy = await createMarketProxy({ upstream: webServer.getOrigin(), secretFile: policy.secretFile,
    archiveBytes: limits.archiveBytes, jsonRequestBytes: policy.jsonRequestBytes, jsonResponseBytes: policy.jsonResponseBytes,
    requestTimeoutMs: 30000, requestRatePerMinute: 120 })
  carrier = http.createServer()
  const origin = await listen(carrier)
  let tenantStarts = 0
  gateway = createAccountServer({ httpServer: carrier, publicOrigin: origin, store, market: proxy, workspaceMode: 'desktop',
    runtime: { ensure: async () => { tenantStarts++; throw new Error('Cloud market does not start a tenant') } } })
  const sessionFile = join(root, 'account', 'session.json')
  await ctx.plugin(market.default, { root: join(root, 'local'), ...limits }).await()
  let local
  await ctx.inject(['museMarket'], owner => { local = owner.museMarket }).await()
  assert.ok(local)
  await ctx.plugin(activation.default).await()
  let active
  await ctx.inject(['museMarketActivation'], owner => { active = owner.museMarketActivation }).await()
  assert.ok(active)
  clientFiber = ctx.plugin(client.default, { baseUrl: origin, sessionFile, requestTimeoutMs: 30000,
    jsonRequestBytes: 16384, jsonResponseBytes: 1048576, catalogLimit: 100 }); await clientFiber.await()
  let cloud
  await ctx.inject(['museMarketCloud'], owner => { cloud = owner.museMarketCloud }).await()
  assert.ok(cloud)
  const beforeDefaults = await active.defaults()
  assert.equal((await local.installed()).length, 0)
  async function login(username) {
    const response = await fetch(origin + '/login', { method: 'POST', redirect: 'manual', headers: { origin },
      body: new URLSearchParams({ username, password: 'snapshot-password' }) })
    assert.equal(response.status, 303)
    const cookie = response.headers.getSetCookie().find(value => value.startsWith('__Host-muse='))?.split(';')[0]
    assert.ok(cookie)
    await sessions.writeMuseSession(sessionFile, { baseUrl: origin, cookie, username })
  }
  const full = new Map(), observed = new Set()
  let primary, requests = 0, calls = 0, proofWritten = false
  const starts = [], settles = []
  ctx.on('agent/created', ({ agent }) => {
    assert.equal(primary, undefined); primary = agent
    agent.ctx.effect(() => agent.ctx.tools.restrict({ allow: ['market_cloud'], includeOwn: true }))
  })
  ctx.effect(() => ctx.tools.register({ name: 'market_cloud',
    description: 'Verify the real cloud draft, explicit submission, authorization, review and selected-archive installation.',
    parameters: { type: 'object', required: ['operation'], additionalProperties: false,
      properties: { operation: { type: 'string', enum: operations } } },
    output: { schema: {}, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args) {
      const expected = operations[calls++]
      assert.equal(args.operation, expected)
      if (expected === 'read-draft' || expected === 'submit') {
        await login('snapshot_creator')
        if (expected === 'read-draft') {
          const value = await cloud.getPublication(publicationId)
          assert.equal(value.status, 'draft'); assert.equal(value.revision, 1)
          return value
        }
        const value = await cloud.review(publicationId, 1, 'submit', 'Ready for review.')
        assert.equal(value.status, 'pending'); assert.equal(value.revision, 2)
        return value
      }
      if (expected === 'reader-private') {
        await login('snapshot_reader')
        try { await cloud.getPublication(publicationId) }
        catch (error) {
          assert.equal(error.details?.status, 404)
          assert.equal(typeof error.details?.code, 'string')
          return { refused: true, name: error.name, details: error.details }
        }
        assert.fail('A reader must not receive a private draft')
      }
      if (expected === 'approve') {
        await login('snapshot_admin')
        const value = await cloud.review(publicationId, 2, 'approve', 'Approved for the public catalog.')
        assert.equal(value.status, 'published'); assert.equal(value.revision, 3)
        return value
      }
      assert.equal(expected, 'install')
      await login('snapshot_reader')
      const value = await cloud.installPublication(publicationId, sha256)
      assert.equal(value.publication.status, 'published')
      assert.equal(value.installation.enabled, false)
      assert.equal(value.installation.release.id, sha256)
      assert.notEqual(value.publication.id, value.installation.release.id)
      assert.deepEqual(await active.defaults(), beforeDefaults)
      assert.equal((await local.installed()).length, 1)
      assert.deepEqual(await ctx.skills.list({ scope: primary }), [])
      const exported = await local.exportPackage(value.installation.release.id)
      assert.equal(archiveModule.marketDigest(Buffer.from(exported.base64, 'base64')), sha256)
      return value
    },
  }))
  ctx.on('session/event', (_session, event) => {
    if (event.type === 'tool/result') full.set(event.data.message.toolCallId, event.data.message)
    if (event.type === 'tool/ptc-dispatch-start') starts.push(event.data)
    if (event.type === 'tool/ptc-dispatch') { assert.equal(event.data.isError, false); settles.push(event.data) }
  })
  ctx.on('llm/stream', async function* (options, next) {
    requests++
    for (const message of options.messages) {
      if (message.role !== 'tool' || !message.toolCallId.startsWith('call_cloud_')) continue
      const result = full.get(message.toolCallId)
      assert.ok(result)
      assert.notEqual(result.isError, true, JSON.stringify(result.content))
      assert.deepEqual(message.content, result.content)
      observed.add(message.toolCallId)
    }
    if (!proofWritten && observed.size === 5) {
      assert.equal(calls, 5); assert.equal(requests, 6); assert.equal(tenantStarts, 0)
      assert.equal(starts.length, config.executor === 'ptc' ? 5 : 0); assert.equal(settles.length, starts.length)
      assert.deepEqual(await active.defaults(), beforeDefaults)
      await writeFile(join(process.cwd(), 'market-cloud-proof.json'), JSON.stringify({ publicationId, publisherId,
        archiveSha256: sha256, realGatewayAuthentication: true, privateDraftRefusedToReader: true,
        explicitSubmissionAndApproval: true, publishedRevision: 3, wholeArchivePreserved: true,
        distinctLocalAndCloudIdentities: true, localInstallDisabled: true, activationDefaultsUnchanged: true,
        completeResultsReachedNextModel: true, modelRequests: requests, toolCalls: calls,
        ptcDispatchStarts: starts.length, ptcDispatchSettles: settles.length, tenantStarts }, null, 2) + '\n', { flag: 'wx' })
      proofWritten = true
    }
    yield* next()
  })
  ctx.on('agent/turn-stopping', () => { assert.equal(proofWritten, true) })
}
