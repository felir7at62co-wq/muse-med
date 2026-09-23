import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { JubianLedger } from '@deepseek-ai/dsh-jubian'
import { expect, it, vi } from 'vitest'
import { apply } from '../src/index.ts'

it('applies the live drama budget before a paid image request without an authorization file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jubian-settings-budget-'))
  const registered: { name: string; execute: (args: unknown) => Promise<unknown> }[] = []
  const section = { seriesBudgetCents: 0 }
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
    const path = url instanceof Request ? url.url : url.toString()
    if (!path.includes('/model/charge/getSelectList?taskType=2')) {
      throw new Error(`Unexpected provider request: ${path}`)
    }
    return new Response(JSON.stringify({ code: 200, data: [{ id: 42, standardId: 42, modelId: 'gpt-image-2',
      platformId: 'YU_DIAN', unitPrice: 0.5, unit: '张', genTypes: [{ id: 7, type: 3 }],
      videoStandards: [{ id: 91, ratio: '16:9', resolution: '1K', width: 1280, height: 720, genNum: 1 }] }] }),
    { status: 200 })
  })
  try {
    const ctx = { plugin: () => {}, get: (name: string) => name === 'settings'
      ? { get: () => section } : undefined,
    tools: { register: (tool: { name: string; execute: (args: unknown) => Promise<unknown> }) => {
      registered.push(tool); return () => {}
    } }, credentials: { resolve: async () => ({ value: 'token' }) } } as unknown as Context
    apply(ctx, { ledgerRoot: root, workspaceSecrets: false, baseUrl: 'https://jubian.example.test' })
    const video = registered.find(tool => tool.name === 'jubian_video')!
    await expect(video.execute({ method: 'image_generate', script_id: 2708, asset_name: 'x', asset_type: 1,
      prompt: 'p', idempotency_key: 'new-paid-image' })).rejects.toThrow('授权上限 0.00 CNY')
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(await new JubianLedger({ root }).records()).toEqual([])
  } finally {
    fetch.mockRestore()
    await rm(root, { recursive: true, force: true })
  }
})
