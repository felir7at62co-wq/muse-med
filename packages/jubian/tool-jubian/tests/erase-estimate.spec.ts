import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JubianClient, JubianLedger } from '@deepseek-ai/dsh-jubian'
import { describe, expect, it, onTestFinished } from 'vitest'
import { storyboardMethod } from '../src/methods.ts'

const ARGS = { method: 'erase_subtitle', task_id: 42, video_width: 480, video_height: 854,
  idempotency_key: 'erase-estimate' } as const
const MODELS = ['quzimuToB', 'ark-erase-video-subtitle-pro'] as const
// This is a caller-declared test reservation, not a conversion of a directory price.
const ESTIMATE = { estimated_cost_cny: '1.00',
  estimate_basis: 'Offline test caller reservation from a separately supplied comparable-cost estimate; not a provider quote.' }

interface ProviderCall { method: string; path: string; body?: Record<string, unknown> }

async function fixture(options: {
  limitCents?: number
  approvedEstimate?: string
  interrupted?: boolean
  catalogue?: unknown
  expectedQuote?: string
  catalogueFailureCode?: number
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'jubian-erase-estimate-'))
  onTestFinished(async () => { await rm(root, { recursive: true, force: true }) })
  const ledger = new JubianLedger({ root, defaultLimitCents: () => options.limitCents ?? 400_000 })
  if (options.approvedEstimate !== undefined) await writeFile(join(root, 'authorization.json'), JSON.stringify({
    version: 1, projects: { '2708': { limit: '4000', unit: 'CNY', estimates: { erase_subtitle: options.approvedEstimate } } },
  }))
  const calls: ProviderCall[] = []
  const client = new JubianClient({ baseUrl: 'https://erase-estimate.invalid', credential: async () => 'offline-fixture-token',
    fetch: async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString())
      expect(url.origin, 'all provider traffic must remain inside this fixture').toBe('https://erase-estimate.invalid')
      const call: ProviderCall = { method: init?.method ?? 'GET', path: url.pathname + url.search,
        ...(typeof init?.body === 'string' ? { body: JSON.parse(init.body) as Record<string, unknown> } : {}) }
      calls.push(call)
      let data: unknown
      if (call.method === 'GET' && call.path === '/admin/aigc/video/task/42') {
        data = { id: 42, scriptId: 2708, episodeId: 46744, episodeCount: 1, taskName: 'fixture-source' }
      } else if (call.method === 'POST' && call.path === '/admin/aigc/video/task/sub/list') {
        data = { total: 1, rows: [{ id: 990, aigcVideoTaskId: 42, taskStatus: 'succeeded', duration: 13.5,
          firstResultId: 123, parentResultId: 456,
          resultList: [{ taskType: 1, tosVideoUrl: 'https://media.example.test/source.mp4' }] }] }
      } else if (call.method === 'POST' && call.path === '/aigc/storyboard/subtitleEraser') {
        expect(await ledger.find(ARGS.idempotency_key)).toMatchObject({ outcome: null,
          quoted_amount: options.expectedQuote ?? '1.00',
          quote_unit: 'CNY', method: 'erase_subtitle', script_id: 2708 })
        if (options.interrupted) throw new Error('Offline submission interrupted')
        data = { taskId: 429001 }
      } else if (call.method === 'GET' && call.path === '/model/charge/getSelectList?taskType=10') {
        if (options.catalogue === undefined) return new Response(JSON.stringify({
          code: options.catalogueFailureCode ?? 403, msg: 'private provider detail' }), { status: 200 })
        data = options.catalogue
      } else throw new Error(`Unexpected offline request: ${call.method} ${call.path}`)
      return new Response(JSON.stringify({ code: 200, data }), { status: 200 })
    } })
  return { root, ledger, client, calls,
    paidCalls: () => calls.filter(call => call.path === '/aigc/storyboard/subtitleEraser') }
}

describe('caller-declared erasure reservations', () => {
  it.each(MODELS)('keeps %s unpriced when catalogue access is denied and no estimate is approved', async (model_id) => {
    const { client, ledger, paidCalls } = await fixture()
    await expect(storyboardMethod(client, ledger, { ...ARGS, model_id })).rejects.toMatchObject({ code: 'BUDGET_EXCEEDED' })
    expect(paidCalls()).toEqual([])
    expect(await ledger.records()).toEqual([])
  })

  it.each([
    { model_id: MODELS[0], cataloguePrice: 0.505, unit: '元/分钟', expectedQuote: '0.51' },
    { model_id: MODELS[1], cataloguePrice: 0, unit: '元/条', expectedQuote: '0.01' },
  ])('uses the live catalogue for $model_id without a caller estimate', async ({ model_id,
    cataloguePrice, unit, expectedQuote }) => {
    const catalogue = [{ id: model_id === MODELS[0] ? 26 : 67,
      platformId: model_id === MODELS[0] ? 'YU_DIAN' : 'AI_MEDIA_KIT', modelId: model_id,
      unitPrice: cataloguePrice, unit, videoStandards: [] }]
    const { client, ledger, root, calls, paidCalls } = await fixture({ catalogue, expectedQuote })
    const args = { ...ARGS, model_id }
    const result = await storyboardMethod(client, ledger, args)
    expect(result).toMatchObject({ outcome: 'accepted', accepted_task_id: '429001',
      budget: { status: 'authorized' } })
    expect(result.next).toContain('实际结算')
    expect(paidCalls()).toHaveLength(1)
    expect(await ledger.find(ARGS.idempotency_key)).toMatchObject({ quoted_amount: expectedQuote,
      quote_unit: 'CNY', outcome: 'accepted' })
    const count = calls.length
    expect(await storyboardMethod(client, new JubianLedger({ root }), args)).toMatchObject({ replayed: true })
    expect(calls).toHaveLength(count)
  })

  it('refuses a malformed live price before recording an intent or sending', async () => {
    const catalogue = [{ id: 26, platformId: 'YU_DIAN', modelId: MODELS[0],
      unitPrice: -1, unit: '元/分钟', videoStandards: [] }]
    const { client, ledger, paidCalls } = await fixture({ catalogue })
    await expect(storyboardMethod(client, ledger, { ...ARGS, model_id: MODELS[0] }))
      .rejects.toMatchObject({ code: 'CONTRACT_CHANGED' })
    expect(paidCalls()).toEqual([])
    expect(await ledger.records()).toEqual([])
  })

  it('does not fall back to pinned selectors for an unknown model when catalogue access is denied', async () => {
    const { client, ledger, paidCalls } = await fixture()
    await expect(storyboardMethod(client, ledger, { ...ARGS, model_id: 'new-eraser', erase_mode: 'region' }))
      .rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
    expect(paidCalls()).toEqual([])
    expect(await ledger.records()).toEqual([])
  })

  it('does not mask a catalogue rate limit as an approved estimate', async () => {
    const { client, ledger, paidCalls } = await fixture({ approvedEstimate: '1.00', catalogueFailureCode: 429 })
    await expect(storyboardMethod(client, ledger, { ...ARGS, model_id: MODELS[0] }))
      .rejects.toMatchObject({ code: 'RATE_LIMITED' })
    expect(paidCalls()).toEqual([])
    expect(await ledger.records()).toEqual([])
  })

  it.each(MODELS)('reserves the explicit estimate for %s before submitting once', async (model_id) => {
    const { client, ledger, calls, paidCalls } = await fixture()
    const result = await storyboardMethod(client, ledger, { ...ARGS, model_id, ...ESTIMATE })
    expect(result).toMatchObject({ outcome: 'accepted', accepted_task_id: '429001', budget: { status: 'authorized' } })
    expect(result.next).toContain('估算')
    expect(result.next).toContain('不是供应商报价或实际结算金额')
    expect(paidCalls()).toHaveLength(1)
    expect(paidCalls()[0]?.body).toMatchObject({ modelId: model_id, scriptId: 2708, taskType: 10,
      duration: 13.5, firstResultId: 123, parentResultId: 456, videoUrl: 'https://media.example.test/source.mp4' })
    expect(paidCalls()[0]?.body).not.toHaveProperty('estimated_cost_cny')
    expect(paidCalls()[0]?.body).not.toHaveProperty('estimate_basis')
    expect(await ledger.records()).toHaveLength(1)
    expect(await ledger.find(ARGS.idempotency_key)).toMatchObject({ quoted_amount: '1.00', quote_unit: 'CNY' })
    const callCount = calls.length
    expect(await storyboardMethod(client, new JubianLedger({ root: ledger.root }), { ...ARGS, model_id, ...ESTIMATE }))
      .toMatchObject({ replayed: true, outcome: 'accepted' })
    expect(calls).toHaveLength(callCount)
    expect(paidCalls()).toHaveLength(1)
  })

  it('preserves the existing trusted authorization estimate when the call omits one', async () => {
    const { client, ledger, paidCalls } = await fixture({ approvedEstimate: '1.00' })
    await expect(storyboardMethod(client, ledger, { ...ARGS, model_id: MODELS[0] })).resolves.toMatchObject({ outcome: 'accepted' })
    expect(paidCalls()).toHaveLength(1)
    expect(await ledger.find(ARGS.idempotency_key)).toMatchObject({ quoted_amount: '1.00' })
  })

  it.each([
    { estimated_cost_cny: '0', estimate_basis: 'not free' },
    { estimated_cost_cny: '-1', estimate_basis: 'invalid negative' },
    { estimated_cost_cny: 'NaN', estimate_basis: 'invalid number' },
    { estimated_cost_cny: '1.00', estimate_basis: ' ' },
    { estimated_cost_cny: '1.00' },
    { estimate_basis: 'amount missing' },
  ])('rejects an unusable explicit estimate before any paid intent: %j', async (estimate) => {
    const { client, ledger, paidCalls } = await fixture()
    await expect(storyboardMethod(client, ledger, { ...ARGS, model_id: MODELS[0], ...estimate }))
      .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    expect(paidCalls()).toEqual([])
    expect(await ledger.records()).toEqual([])
  })

  it('does not enlarge the project cap to accommodate the declared estimate', async () => {
    const { client, ledger, paidCalls } = await fixture({ limitCents: 99 })
    await expect(storyboardMethod(client, ledger, { ...ARGS, model_id: MODELS[0], ...ESTIMATE }))
      .rejects.toMatchObject({ code: 'BUDGET_EXCEEDED' })
    expect(paidCalls()).toEqual([])
    expect(await ledger.records()).toEqual([])
  })

  it('does not hide an invalid explicit estimate behind a trusted authorization estimate', async () => {
    const { client, ledger, paidCalls } = await fixture({ approvedEstimate: '1.00' })
    await expect(storyboardMethod(client, ledger, { ...ARGS, model_id: MODELS[0],
      estimated_cost_cny: '0', estimate_basis: 'invalid caller amount' }))
      .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    expect(paidCalls()).toEqual([])
    expect(await ledger.records()).toEqual([])
  })

  it('keeps an interrupted estimated submission unknown and never resends its key', async () => {
    const { client, ledger, root, calls, paidCalls } = await fixture({ interrupted: true })
    const args = { ...ARGS, model_id: MODELS[0], ...ESTIMATE }
    await expect(storyboardMethod(client, ledger, args)).rejects.toMatchObject({ code: 'NETWORK_ERROR' })
    expect(await ledger.find(ARGS.idempotency_key)).toMatchObject({ outcome: 'unknown', quoted_amount: '1.00' })
    const callCount = calls.length
    expect(await storyboardMethod(client, new JubianLedger({ root }), args)).toMatchObject({ replayed: true, outcome: 'unknown' })
    expect(calls).toHaveLength(callCount)
    expect(paidCalls()).toHaveLength(1)
  })
})
