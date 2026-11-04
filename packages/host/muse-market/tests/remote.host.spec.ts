/** Source Host/Gateway contract; the Connection carrier is test-owned. */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Group from '@deepseek-ai/cordis-plugin-group'
import Sessions from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import Skills from '@deepseek-ai/dsh-skill'
import Presets from '@deepseek-ai/dsh-agent-preset-registry'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import TypertGateway from '@deepseek-ai/dsh-api-gateway'
import { writeMuseSession } from '@deepseek-ai/dsh-muse-account/session'
import type { ConnectionRpcHandler, PeerId, PeerScope } from '@deepseek-ai/dsh-client-connection'
import { expect, it, onTestFinished, vi } from 'vitest'
import { zipSync } from 'fflate'
import MuseMarket from '../src/index.ts'
import { MuseMarketCloud } from '../src/cloud.ts'
import { createMarketPackage, marketDigest, readMarketPackage } from '../src/package.ts'
import type { MarketManifest, MarketRelease } from '../src/types.ts'

it('dispatches original discovery and package operations through the Host Gateway', async () => {
  const root = await mkdtemp(join(tmpdir(), 'market-remote-'))
  const ctx = new Context()
  const cookie = '__Host-muse=fixture-cookie'
  const original = { id: 'muse/bots/original-director', kind: 'bot', name: 'Original Director', description: 'Storyboard preparation',
    category: 'Video', version: '1.0.0', validation: 'Preview', sha256: 'a'.repeat(64),
    package: 'downloads/original-director.tgz', requirements: ['Muse'] }
  const requested: { path: string | undefined; cookie: string | undefined }[] = []
  const skillBody = Buffer.from('---\nname: original-editor\ndescription: Edit a scene\n---\nPreserve the dialogue.\n')
  const skillArchive = zipSync({ 'original-editor/SKILL.md': skillBody })
  const originalSkill = { ...original, id: 'muse/skills/original-editor', kind: 'skill', name: 'Original Editor',
    package: 'downloads/original-editor.zip', sha256: marketDigest(skillArchive) }
  let downloadBytes = skillArchive
  let payload: unknown = { entries: [original, originalSkill] }
  const cloudFixture: { download?: { release: MarketRelease; archive: Buffer } } = {}
  const server = createServer((request, response) => {
    requested.push({ path: request.url, cookie: request.headers.cookie })
    if (request.url === '/market/' + originalSkill.package) {
      response.end(downloadBytes)
      return
    }
    const cloudDownload = cloudFixture.download
    if (cloudDownload && request.url === `/api/market/v1/releases/${cloudDownload.release.id}/download`) {
      response.end(cloudDownload.archive)
      return
    }
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify(cloudDownload && request.url === `/api/market/v1/releases/${cloudDownload.release.id}`
      ? cloudDownload.release : payload))
  })
  onTestFinished(async () => {
    try { await ctx.fiber.dispose() }
    finally {
      if (server.listening) await new Promise<void>((resolve, reject) => {
        server.close((error) => { if (error) reject(error); else resolve() })
      })
      await rm(root, { recursive: true, force: true })
    }
  })
  const listening = once(server, 'listening')
  server.listen(0, '127.0.0.1')
  await listening
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Fixture server has no loopback port')
  const baseUrl = `http://127.0.0.1:${address.port}`
  const accountHome = join(root, 'account')
  await writeMuseSession(join(accountHome, 'session.json'), { baseUrl, cookie, username: 'fixture' })
  await ctx.plugin(Loader).await()
  ctx.loader.builtins.group = Group
  for (const plugin of [Sessions, SessionProjections, Skills]) await ctx.plugin(plugin).await()
  await ctx.plugin(Presets, { default: 'standard', selectablePresets: ['standard'] }).await()
  await ctx.agentPresets.register({ id: 'standard', plugins: [] })
  const limits = { archiveBytes: 1024 * 1024, expandedBytes: 1024 * 1024, fileCount: 32 }
  await ctx.plugin(MuseMarket, { baseUrl, root, accountHome, ...limits, allowedPlugins: [] }).await()
  await ctx.plugin(TypertRegistry).await()
  let dispatch: ConnectionRpcHandler | undefined, claims: ((endpoint: string) => boolean) | undefined
  ctx.provide('connection', { rpc: { intercept(_channel: string, matches: (endpoint: string) => boolean, handler: ConnectionRpcHandler) {
    dispatch = handler; claims = matches
    return () => { dispatch = undefined; claims = undefined }
  } } })
  await ctx.plugin(TypertGateway).await()
  const peer: PeerScope = { id: 'market-remote-peer' as PeerId, ctx, dispose: async () => {} }
  async function call(method: string, args: Record<string, unknown>) {
    if (!dispatch) throw new Error('Gateway has no Connection interceptor')
    return await dispatch(`museMarket/${method}`, { args }, new AbortController().signal, peer)
  }
  expect(claims?.('museMarket/installPackage')).toBe(true)
  expect(claims?.('museMarket/removePackage')).toBe(true)
  expect(claims?.('museMarket/install')).toBe(false)
  expect(claims?.('museMarket/remove')).toBe(false)
  await expect(call('legacyCatalog', { query: 'DIRECTOR video', kind: 'bot' })).resolves.toEqual({ ok: true, value: [{
    id: original.id, kind: original.kind, title: original.name, description: original.description,
    category: original.category, version: original.version, validation: original.validation, sha256: original.sha256,
    requirements: original.requirements, requiredSkills: [], href: `${baseUrl}/market/${original.package}`,
  }] })
  expect(requested).toEqual([{ path: '/market/catalog.json', cookie: undefined }])
  payload = { entries: [{ ...original, package: 'downloads/../redirect.zip' }] }
  await expect(call('legacyCatalog', { query: '', kind: '' })).resolves.toMatchObject({ ok: false, error: { details: { code: 'invalid-response' } } })
  payload = { entries: [original, originalSkill] }
  const legacyArgs = { id: originalSkill.id, sha256: originalSkill.sha256 }
  await expect(call('installLegacy', { ...legacyArgs, sha256: 'b'.repeat(64) }))
    .resolves.toMatchObject({ ok: false, error: { details: { code: 'legacy-catalog-changed' } } })
  expect(requested.at(-1)).toEqual({ path: '/market/catalog.json', cookie: undefined })
  downloadBytes = new Uint8Array([0])
  await expect(call('installLegacy', legacyArgs)).resolves.toMatchObject({ ok: false, error: { details: { code: 'digest-mismatch' } } })
  expect(await ctx.museMarket.installed()).toEqual([])
  downloadBytes = skillArchive
  await expect(call('installLegacy', legacyArgs)).resolves.toMatchObject({ ok: true, value: { enabled: false, legacySource: legacyArgs } })
  expect(requested.slice(-2)).toEqual([
    { path: '/market/catalog.json', cookie: undefined }, { path: '/market/' + originalSkill.package, cookie: undefined },
  ])
  const [legacy] = await ctx.museMarket.installed()
  if (!legacy) throw new Error('Original Skill missing from local storage')
  await expect(call('exportPackage', { id: legacy.release.id }))
    .resolves.toMatchObject({ ok: false, error: { details: { code: 'legacy-not-exportable' } } })
  const legacyFiles = readMarketPackage(await readFile(join(root, 'packages', legacy.release.sha256, 'publication.zip')), limits, []).files
  expect(Buffer.from(legacyFiles['skills/original-editor/SKILL.md'] ?? [])).toEqual(skillBody)
  await ctx.museMarket.enable(legacy.release.id, true)
  await expect(call('installLegacy', legacyArgs)).resolves.toMatchObject({ ok: true, value: { enabled: true, legacySource: legacyArgs } })
  await expect(call('publishDraft', { id: legacy.release.id, publisherId: legacy.release.publisherId, requestId: 'legacy-request' }))
    .resolves.toMatchObject({ ok: false, error: { details: { code: 'legacy-not-publishable' } } })
  await ctx.museMarket.enable(legacy.release.id, false)
  await ctx.museMarket.remove(legacy.release.id)
  const invalidRelease = { code: 'muse-market/operation-failed', message: 'Muse market operation failed', details: { code: 'invalid-release' } }
  await expect(call('installPackage', { id: 'invalid' })).resolves.toEqual({ ok: false, error: invalidRelease })
  await expect(ctx.museMarket.install('invalid' as Parameters<MuseMarket['install']>[0])).rejects.toMatchObject(invalidRelease)

  const manifest: MarketManifest = { formatVersion: 1, kind: 'bot', name: 'remote-review', title: 'Remote review',
    description: 'Local Remote regression', version: '1.0.0', license: 'MIT', category: 'test',
    examples: [], requirements: [], skills: [], plugins: [] }
  await expect(call('prepare', { metadata: { ...manifest, presetPortrait: 'video-editor' }, skillNames: [], botId: 'standard' }))
    .resolves.toMatchObject({ ok: true, value: { release: { manifest: { presetPortrait: 'video-editor' } }, enabled: false } })
  const [prepared] = await ctx.museMarket.installed()
  if (!prepared) throw new Error('Prepared Bot missing from local storage')
  const { id, publisherId } = prepared.release
  const exported = await ctx.museMarket.exportPackage(id)
  const archive = Buffer.from(exported.base64, 'base64')
  expect(readMarketPackage(archive, limits, []).manifest.presetPortrait).toBe('video-editor')

  const upload = vi.spyOn(MuseMarketCloud.prototype, 'upload').mockResolvedValue(prepared.release)
  onTestFinished(() => { upload.mockRestore() })
  const requestId = 'portrait-request'
  await expect(call('publishDraft', { id, publisherId, requestId })).resolves.toMatchObject({ ok: true })
  await expect(call('publishDraft', { id, publisherId, requestId, presetPortrait: 'coding-assistant' })).resolves.toMatchObject({ ok: true })
  expect(upload.mock.calls.map(([publisher, key, bytes]) => [publisher, key, Buffer.from(bytes)]))
    .toEqual([[publisherId, requestId, archive], [publisherId, requestId, archive]])
  expect(await ctx.museMarket.exportPackage(id)).toEqual(exported)
  await expect(call('removePackage', { id })).resolves.toEqual({ ok: true, value: undefined })
  expect(await ctx.museMarket.installed()).toEqual([])
  const originalArchive = Buffer.from(createMarketPackage(manifest, {}, limits, [])).toString('base64')
  const repeated = await ctx.museMarket.importPackage(originalArchive)
  const unboundArgs = { id: repeated.release.id, publisherId, requestId: 'automatic-portrait-request' }
  upload.mockClear()
  await expect(call('publishDraft', { ...unboundArgs, presetPortrait: 'not-in-the-portrait-library' }))
    .resolves.toMatchObject({ ok: false, error: { details: { code: 'invalid-manifest' } } })
  expect(upload).not.toHaveBeenCalled()
  await expect(call('publishDraft', { ...unboundArgs, presetPortrait: 'coding-assistant' })).resolves.toMatchObject({ ok: true })
  await expect(call('publishDraft', { ...unboundArgs, presetPortrait: 'coding-assistant' })).resolves.toMatchObject({ ok: true })
  const [first, second] = upload.mock.calls
  if (!first) throw new Error('Bot archive did not reach the upload service')
  expect(first.slice(0, 2)).toEqual([publisherId, unboundArgs.requestId])
  expect(second).toEqual(first)
  expect(readMarketPackage(first[2], limits, []).manifest.presetPortrait).toBe('coding-assistant')
  expect((await ctx.museMarket.exportPackage(repeated.release.id)).base64).toBe(originalArchive)
  await ctx.museMarket.remove(repeated.release.id)
  expect(await ctx.museMarket.installed()).toEqual([])

  const cloudRelease: MarketRelease = { ...prepared.release, id: '1'.repeat(32) as MarketRelease['id'],
    publisherId: '2'.repeat(32) as MarketRelease['publisherId'], publisher: 'Fixture studio', status: 'published' }
  cloudFixture.download = { release: cloudRelease, archive }
  const importedArchive = { base64: exported.base64 }
  await expect(call('installPackage', { id: cloudRelease.id })).resolves.toEqual({ ok: true, value: { release: cloudRelease, enabled: false } })
  await expect(call('importPackage', importedArchive)).resolves.toEqual({ ok: true, value: { release: cloudRelease, enabled: false } })
  await ctx.museMarket.enable(cloudRelease.id, true)
  await expect(call('importPackage', importedArchive)).resolves.toEqual({ ok: true, value: { release: cloudRelease, enabled: true } })
  expect(await ctx.museMarket.installed()).toEqual([{ release: cloudRelease, enabled: true }])
  await expect(call('exportPackage', { id: cloudRelease.id })).resolves.toEqual({ ok: true, value: exported })
  upload.mockClear()
  await expect(call('publishDraft', { id: cloudRelease.id, publisherId, requestId })).resolves.toMatchObject({ ok: true })
  expect(upload.mock.calls.map(([publisher, key, bytes]) => [publisher, key, Buffer.from(bytes)]))
    .toEqual([[publisherId, requestId, archive]])

  await expect(call('prepare', { metadata: { ...manifest, presetPortrait: 'video-editor' }, skillNames: [], botId: 'standard' }))
    .resolves.toMatchObject({ ok: true, value: { release: { id, status: 'draft' }, enabled: false } })
  expect((await ctx.museMarket.installed()).map(item => [item.release.id, item.enabled]))
    .toEqual([[cloudRelease.id, true], [id, false]])
  await expect(call('importPackage', importedArchive)).resolves.toEqual({ ok: true, value: { release: cloudRelease, enabled: true } })
  await expect(call('importPackage', { base64: originalArchive }))
    .resolves.toMatchObject({ ok: true, value: { release: { id: repeated.release.id, status: 'draft' }, enabled: false } })
})
