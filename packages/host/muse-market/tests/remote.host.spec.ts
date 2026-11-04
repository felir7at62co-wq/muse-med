/** Source Host/Gateway contract; the Connection carrier is test-owned. */
import { mkdtemp, rm } from 'node:fs/promises'
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
import type { ConnectionRpcHandler, PeerId, PeerScope } from '@deepseek-ai/dsh-client-connection'
import { expect, it, onTestFinished, vi } from 'vitest'
import MuseMarket from '../src/index.ts'
import { MuseMarketCloud } from '../src/cloud.ts'
import { createMarketPackage, readMarketPackage } from '../src/package.ts'
import type { MarketManifest } from '../src/types.ts'

it('dispatches package aliases and retains a prepared Bot portrait through export and draft upload', async () => {
  const root = await mkdtemp(join(tmpdir(), 'market-remote-'))
  const ctx = new Context()
  onTestFinished(async () => {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  })
  await ctx.plugin(Loader).await()
  ctx.loader.builtins.group = Group
  for (const plugin of [Sessions, SessionProjections, Skills]) await ctx.plugin(plugin).await()
  await ctx.plugin(Presets, { default: 'standard', selectablePresets: ['standard'] }).await()
  await ctx.agentPresets.register({ id: 'standard', plugins: [] })
  const limits = { archiveBytes: 1024 * 1024, expandedBytes: 1024 * 1024, fileCount: 32 }
  await ctx.plugin(MuseMarket, { baseUrl: 'http://127.0.0.1:9', root, accountHome: join(root, 'account'),
    requestTimeoutMs: 1000, ...limits, allowedPlugins: [] }).await()
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
  await expect(call('publishDraft', { id, publisherId, requestId })).resolves.toMatchObject({ ok: true })
  expect(upload.mock.calls.map(([publisher, key, bytes]) => [publisher, key, Buffer.from(bytes)]))
    .toEqual([[publisherId, requestId, archive], [publisherId, requestId, archive]])
  expect(await ctx.museMarket.exportPackage(id)).toEqual(exported)
  await expect(call('removePackage', { id })).resolves.toEqual({ ok: true, value: undefined })
  expect(await ctx.museMarket.installed()).toEqual([])
  const repeated = await ctx.museMarket.importPackage(Buffer.from(createMarketPackage(manifest, {}, limits, [])).toString('base64'))
  await ctx.museMarket.remove(repeated.release.id)
  expect(await ctx.museMarket.installed()).toEqual([])
})
