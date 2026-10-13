/** Registered tools keep a missing or busy shared voice slot local to its original registration. */
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { JubianLedger } from '@deepseek-ai/dsh-jubian'
import { encodeVoiceSlot } from '@deepseek-ai/dsh-jubian-api'
import { MemoryCredentials } from '../../../credentials/credentials/tests/memory.ts'
import { configurationFixture } from '../../../settings/settings/tests/configuration-fixture.ts'
import * as Jubian from '../src/index.ts'

afterEach(() => { vi.restoreAllMocks() })

it.each(['no-provider', 'busy', 'sign-in-required', 'account-changed', 'not-configured', 'network', 'unavailable', 'asset-deleted'])
('reports %s as a pending voice registration that permits other authorized work', async (reason) => {
  const requests: string[] = [], actions: string[] = []
  const deleted = { id: 13, scriptId: 2708, assetType: 4, delFlag: '1',
    assetName: `周海生 ${encodeVoiceSlot(2708, 'zhou', 'adult')}`, url: 'https://media.example/voice.wav' }
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString())
    requests.push(`${init?.method} ${url.pathname}`)
    if (init?.method !== 'GET') throw new Error('Unexpected provider write')
    if (url.pathname.endsWith('/aigc/asset/list')) return Response.json({ code: 200,
      data: reason === 'asset-deleted' ? { total: 1, rows: [deleted] } : { total: 0, rows: [] } })
    if (reason === 'asset-deleted' && url.pathname.endsWith('/aigc/asset/13')) return Response.json({ code: 200, data: deleted })
    throw new Error('Unexpected provider read')
  })
  const { ctx, home } = await configurationFixture({ hmr: false, rows: [
    { id: 'prompt', name: 'cordis:prompt' }, { id: 'tools', name: 'cordis:tools' },
    { id: 'credentials', name: 'cordis:credentials', config: { JUBIANAI_ADMIN_TOKEN: 'mock-private' } },
  ], builtins: { prompt: SystemPrompt, tools: Tools, credentials: MemoryCredentials, jubian: Jubian } })
  await ctx.loader.create({ name: 'cordis:jubian', config: { workspaceSecrets: false, ledgerRoot: join(home, 'ledger') } })
  await ctx.loader.await()
  for (const entry of ctx.loader.entries()) await entry.fiber?.await()
  if (reason !== 'no-provider') ctx.provide('museAccount', { requestVoiceSlot: async (request: { action: string }) => {
    actions.push(request.action)
    if (reason === 'busy') return { state: 'busy', script_id: 2708, character_id: 'zhou', voice_period_id: 'adult',
      blocking_state: 'submitted' }
    throw Object.assign(new Error('private-provider-secret private-session'), { code: reason })
  } } as never)
  const args = { method: 'register', asset_type: 4, script_id: 2708, character_id: 'zhou', voice_period_id: 'adult',
    asset_name: '周海生', asset_url: 'https://media.example/voice.wav', idempotency_key: 'original-registration' }
  const result = await ctx.tools.execute({ callId: ToolCallId(`pending-${reason}`), name: 'jubian_asset', arguments: args,
    signal: new AbortController().signal })
  expect(result.isError, JSON.stringify(result.content)).toBe(false)
  expect(result.value).toMatchObject({ failure_scope: 'voice_registration', work_can_continue: true, submission_attempted: false,
    retry_registration: false, original_idempotency_key: args.idempotency_key,
    reason_code: reason === 'no-provider' ? 'not-configured' : reason })
  expect(Array.isArray(result.value)).toBe(false)
  expect(JSON.stringify(result.value)).toContain(reason === 'asset-deleted'
    ? '继续不依赖此声线的其他独立已授权工作' : '继续无此参考音频的已授权初始视频或其他独立工作')
  expect(JSON.stringify(result.content)).not.toContain('private-provider-secret')
  expect(JSON.stringify(result.value)).not.toContain('lease_id')
  expect(requests.every(row => row.startsWith('GET'))).toBe(true)
  expect(actions).toEqual(reason === 'no-provider' || reason === 'asset-deleted' ? [] : ['acquire'])
  expect(await new JubianLedger({ root: join(home, 'ledger') }).records()).toEqual([])
})
