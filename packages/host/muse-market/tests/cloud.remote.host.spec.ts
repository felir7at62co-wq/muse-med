/** Source-generated Remote codecs and JSON Schema consumed by the real Host Gateway. */
import { beforeAll, expect, it, onTestFinished } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Skills from '@deepseek-ai/dsh-skill'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import type { TypertContribution } from '@deepseek-ai/dsh-typert-registry'
import type { TypertRemoteInfo } from '@deepseek-ai/dsh-typert-protocol'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import TypertGateway from '@deepseek-ai/dsh-api-gateway'
import RemoteAccess from '@deepseek-ai/dsh-api-remote-access'
import { Peer } from '@deepseek-ai/dsh-client-connection'
import { WorkspaceAnalyzer, FaceModelEmitter } from '@deepseek-ai/dsh-typert-generator'
import { assertSupportedJsonSchema, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { join, resolve } from 'node:path'
import { executableRemoteModule } from '../../../typert/generator/tests/remote-module.ts'
import { writeMuseSession } from '../../muse-account/src/session.ts'
import MuseMarket from '../src/index.ts'
import MuseMarketCloud, { parseMarketPublicationId, parseMarketPublisherId, parseMarketUploadRequestId } from '../src/cloud.ts'
import { createMarketPackage, marketDigest } from '../src/package.ts'
import { parseMarketPublication } from '../src/cloud-protocol.ts'
import { bundle, limits, manifest, metadata, resources } from './fixtures.ts'

let host: TypertContribution, remote: TypertRemoteInfo
beforeAll(async () => {
  const [face] = new WorkspaceAnalyzer({ root: resolve(import.meta.dirname, '../../../..'),
    packages: ['@deepseek-ai/dsh-muse-market'], faces: ['host'], rejectBuildOutputs: true }).analyze().faces
  if (face === undefined) throw new Error('Missing market Host program')
  const artifact = new FaceModelEmitter(face).emit('@deepseek-ai/dsh-muse-market')
  if (artifact?.remote === undefined) throw new Error('Missing source-generated market Remote')
  host = (await executableRemoteModule<{ TYPERT: TypertContribution }>(artifact.js)).TYPERT
  remote = (await executableRemoteModule<{ TYPERT_REMOTE: TypertRemoteInfo }>(artifact.remote.js)).TYPERT_REMOTE
}, 60_000)

async function fixture() {
  const source = await bundle(), ctx = new Context()
  const archive = Buffer.from(createMarketPackage(manifest, resources, limits))
  let publication = parseMarketPublication({ id: 'a'.repeat(32), publisherId: 'b'.repeat(32), publisher: 'Writing team',
    manifest, sha256: marketDigest(archive), bytes: archive.byteLength, status: 'draft', reviewNote: '', revision: 1,
    createdAt: '2026-11-09T00:00:00.000Z' }, limits)
  const paths: string[] = []
  const server = createServer((req, res) => {
    paths.push(req.url ?? '')
    if (req.url?.endsWith('/download')) {
      res.writeHead(200, { 'content-type': 'application/zip', 'content-length': String(archive.byteLength), 'x-content-sha256': publication.sha256 })
      res.end(archive); return
    }
    let result: unknown = publication
    if (req.url?.startsWith('/api/market/v1/catalog?')) result = { items: [publication] }
    if (req.url === '/api/market/v1/me') result = { accountId: 'd'.repeat(16), publishers: [{ id: publication.publisherId, title: publication.publisher }], admin: true }
    if (req.url?.endsWith('/review')) { publication = { ...publication, revision: 2, status: 'pending' }; result = publication }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(result))
  })
  onTestFinished(async () => {
    try { await ctx.fiber.dispose() }
    finally {
      server.closeAllConnections(); await new Promise<void>((done) => { server.close(() => { done() }) })
      await source.cleanup()
    }
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Missing loopback address')
  const origin = `http://127.0.0.1:${address.port}`, sessionFile = join(source.root, 'session.json')
  await writeMuseSession(sessionFile, { baseUrl: origin, username: 'author', cookie: '__Host-muse=private-fixture-session' })
  await ctx.plugin(TypertRegistry).await(); await ctx.plugin(RemoteAccess).await(); await ctx.plugin(TypertGateway).await()
  await ctx.plugin(Skills).await(); ctx.skills.register(source.skill)
  await ctx.plugin(MuseMarket, { root: join(source.root, 'market'), ...limits }).await()
  await ctx.plugin(MuseMarketCloud, { baseUrl: origin, sessionFile }).await()
  ctx.typert.register(host); ctx.typert.remotes.register(remote)
  const peer = new Peer(ctx, { principal: { kind: 'owner' } })
  const call = (method: string, args: Record<string, unknown>) => ctx.typertGateway.invoke({ namespace: 'museMarketCloud', method, args, peer })
  const consume = async (method: string, args: Record<string, unknown>) => {
    const descriptor = remote.methods[`museMarketCloud/${method}`]
    if (descriptor === undefined) throw new Error('Missing generated descriptor')
    const input = descriptor.input({ strict: true }), schema = input.jsonSchema
    if (schema === undefined) throw new Error('Missing JSON Schema')
    assertSupportedJsonSchema(schema)
    expect(validateJsonSchemaValue(schema, args)).toEqual([])
    expect(input.create().parse(args)).toEqual(args)
    const result = await call(method, args)
    expect(descriptor.result.create().parse(result)).toEqual(result)
    return result
  }
  return { source, ctx, call, consume, paths, publication, archive, beforeSkills: await ctx.skills.list() }
}

it('dispatches all six generated operations with whole DTOs and independent local storage', async () => {
  const f = await fixture(), initial = f.publication
  expect(remoteMethods(f.ctx.museMarketCloud).map(row => row.method)).toEqual([
    'catalog', 'identity', 'getPublication', 'publishDraft', 'installPublication', 'review',
  ])
  expect(await f.consume('catalog', { q: 'fixture-skill', mine: true })).toEqual([initial])
  expect(await f.consume('identity', {})).toEqual({ accountId: 'd'.repeat(16), publishers: [{ id: initial.publisherId, title: initial.publisher }], admin: true })
  expect(await f.consume('getPublication', { id: parseMarketPublicationId(initial.id) })).toEqual(initial)
  const prepared = await f.ctx.museMarket.prepare(metadata, f.source.skill.name)
  expect(await f.consume('publishDraft', { localId: prepared.release.id, publisherId: parseMarketPublisherId(initial.publisherId),
    requestId: parseMarketUploadRequestId('remote-original-key') })).toEqual(initial)
  await f.ctx.museMarket.removePackage(prepared.release.id)
  expect(await f.ctx.museMarket.installed()).toEqual([])
  const installed = await f.consume('installPublication', { id: initial.id, expectedSha256: initial.sha256 })
  expect(installed).toEqual({ publication: initial, installation: prepared })
  const pending = await f.consume('review', { id: initial.id, revision: 1, action: 'submit', note: '' })
  expect(pending).toEqual({ ...initial, status: 'pending', revision: 2 })
  expect(f.paths.filter(path => path.endsWith('/review'))).toHaveLength(1)
  expect(f.ctx.get('museMarketActivation')).toBeUndefined()
  expect(await f.ctx.skills.list()).toEqual(f.beforeSkills)
})

it('rejects malformed wire arguments before HTTP and preserves structured domain failures', async () => {
  const f = await fixture()
  for (const [method, args] of [
    ['catalog', { q: 7, mine: false }], ['catalog', { q: '', mine: 'yes' }],
    ['getPublication', { id: 7 }], ['review', { id: f.publication.id, revision: 1, action: 'activate', note: '' }],
  ] as const) {
    const descriptor = remote.methods[`museMarketCloud/${method}`]
    if (descriptor === undefined) throw new Error('Missing method')
    const schema = descriptor.input({ strict: true }).jsonSchema
    if (schema === undefined) throw new Error('Missing schema')
    assertSupportedJsonSchema(schema)
    expect(validateJsonSchemaValue(schema, args).length).toBeGreaterThan(0)
    await expect(f.call(method, args)).rejects.toMatchObject({ code: 'gateway/input-invalid' })
  }
  await expect(f.call('getPublication', { id: 'a'.repeat(64) })).rejects.toMatchObject({
    code: 'muse-market/cloud-failed', details: { code: 'invalid-publication', status: 400 },
  })
  expect(f.paths).toEqual([])
})
