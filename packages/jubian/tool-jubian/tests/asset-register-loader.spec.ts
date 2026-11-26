/** Real Loader composition preserves exact uploaded-image registration identities across tool replays. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { JubianLedger } from '@deepseek-ai/dsh-jubian'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { executeModelToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import { MemoryCredentials } from '../../../credentials/credentials/tests/memory.ts'
import { configurationFixture } from '../../../settings/settings/tests/configuration-fixture.ts'
import * as Jubian from '../src/index.ts'

it('registers one exact image, retains its ID on replay and refuses changed requests through loaded tools', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jubian-asset-loader-'))
  let ctx: Context | undefined
  const rows: Record<string, unknown>[] = [], posts: Record<string, unknown>[] = []
  const imageUrl = 'https://media.example/coat.png'
  const transport = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString())
    expect(url.origin).toBe('https://image-registration.invalid')
    const path = url.pathname.replace('/prod-api', '')
    if (init?.method === 'POST' && path === '/aigc/asset') {
      if (typeof init.body !== 'string') throw new Error('Expected a JSON registration')
      const body = JSON.parse(init.body) as Record<string, unknown>
      posts.push(body)
      rows.push({ id: 501, scriptId: 2708, assetType: 3, assetName: body.assetName, assetUrl: body.url },
        { id: 502, scriptId: 2708, assetType: 3, assetName: 'another coat', assetUrl: 'https://media.example/other.png' })
      return Response.json({ code: 200, data: null })
    }
    expect(init?.method).toBe('GET')
    if (path === '/aigc/asset/list') {
      expect(url.searchParams.get('scriptId')).toBe('2708')
      return Response.json({ code: 200, data: { total: rows.length, rows } })
    }
    return Response.json({ code: 200, data: rows.find(row => path === `/aigc/asset/${String(row.id)}`) ?? null })
  })
  try {
    const configured = await configurationFixture({ hmr: false, rows: [
      { id: 'executor', name: 'cordis:native-executor' }, { id: 'prompt', name: 'cordis:prompt' },
      { id: 'tools', name: 'cordis:tools' }, { id: 'credentials', name: 'cordis:credentials',
        config: { JUBIANAI_ADMIN_TOKEN: 'offline-asset-loader' } },
      { id: 'jubian', name: 'cordis:jubian', config: { baseUrl: 'https://image-registration.invalid/prod-api',
        ledgerRoot: root, workspaceSecrets: false } },
    ], builtins: { 'native-executor': NativeToolExecutor, prompt: SystemPrompt, tools: Tools,
      credentials: MemoryCredentials, jubian: Jubian } })
    ctx = configured.ctx
    const loaded = ctx
    const invoke = async (call: string, changes: Record<string, unknown> = {}) => await executeModelToolFixture(loaded, {
      callId: ToolCallId(call), name: 'jubian_asset', signal: new AbortController().signal,
      arguments: { method: 'register', script_id: 2708, asset_type: 3, asset_name: 'lead coat',
        asset_url: imageUrl, idempotency_key: 'original-asset-key', ...changes },
    })
    expect((await invoke('register-image')).value).toMatchObject({ created_asset_id: 501, new_asset_ids: [501],
      verified_readback: true, replayed: false })
    expect((await invoke('replay-image')).value).toMatchObject({ created_asset_id: 501, new_asset_ids: [],
      verified_readback: true, replayed: true })
    const changed = await invoke('changed-image', { asset_url: 'https://media.example/replacement.png' })
    expect(changed.isError).toBe(true)
    expect(changed.content).toHaveLength(1)
    expect(changed.content).toMatchObject([{ type: 'text' }])
    expect(changed.content[0]).toHaveProperty('text', expect.stringContaining('different'))
    expect(posts).toEqual([{ scriptId: 2708, assetName: 'lead coat', assetType: 3, isLocal: 1, url: imageUrl }])
    expect(await new JubianLedger({ root }).records()).toMatchObject([{ script_id: 2708, method: 'asset_register', outcome: 'accepted' }])
  } finally {
    await ctx?.fiber.dispose()
    transport.mockRestore()
    await rm(root, { recursive: true, force: true })
  }
})
