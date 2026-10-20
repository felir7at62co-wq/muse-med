import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JubianClient, JubianLedger } from '@deepseek-ai/dsh-jubian'
import { describe, expect, it, onTestFinished } from 'vitest'
import { videoMethod } from '../src/methods.ts'
import { readUpscaleQuote } from '../src/upscale-price.ts'

// Captured taskType 20 catalogue: jubian-api/tests/fixtures/catalogue-20261016.json.
const SEED_ROW = { id: 55, modelId: '2074071626416742401', platformId: 'RUNNING_HUB',
  unitPrice: 1, unit: '元/条', videoStandards: [
    { id: 303, modelId: '2074071626416742401', resolution: '1080p' },
  ] }
const ARGS = { method: 'upscale', task_id: 42, idempotency_key: 'priced-upscale' } as const
const SELECTED = { modelId: SEED_ROW.modelId, platformId: SEED_ROW.platformId,
  standardId: SEED_ROW.id, videoStandardId: 303 }

interface ProviderCall {
  method: string
  path: string
  body?: Record<string, unknown>
}

/** Own one ledger and simulate only the external provider transport. */
async function fixture(options: {
  catalogue?: unknown
  limitCents?: number
  catalogueDenied?: boolean
  catalogueOverflow?: boolean
  submitInterrupted?: boolean
  approvedEstimate?: string
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'jubian-upscale-price-'))
  onTestFinished(async () => { await rm(root, { recursive: true, force: true }) })
  const ledger = new JubianLedger({ root, defaultLimitCents: () => options.limitCents ?? 400_000 })
  if (options.approvedEstimate !== undefined) await writeFile(join(root, 'authorization.json'), JSON.stringify({
    version: 1, projects: { '2708': { limit: '4000', unit: 'CNY',
      estimates: { video_upscale: options.approvedEstimate } } },
  }))
  const calls: ProviderCall[] = []
  const client = new JubianClient({ baseUrl: 'https://jubian.example.test', credential: async () => 'fixture-token',
    fetch: async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
      const call: ProviderCall = { method: String(init?.method), path: url.pathname + url.search,
        ...(typeof init?.body === 'string' ? { body: JSON.parse(init.body) as Record<string, unknown> } : {}) }
      calls.push(call)
      let data: unknown
      if (call.method === 'GET' && call.path === '/model/charge/getSelectList?taskType=20') {
        if (options.catalogueDenied) return new Response(JSON.stringify({ code: 403, msg: 'denied' }), { status: 200 })
        if (options.catalogueOverflow) return new Response(JSON.stringify({ code: 200, data: [SEED_ROW] })
          .replace('"unitPrice":1', '"unitPrice":1e400'), { status: 200 })
        data = options.catalogue ?? [SEED_ROW]
      } else if (call.method === 'GET' && call.path === '/admin/aigc/video/task/42') {
        data = { id: 42, scriptId: 2708, episodeId: 46744, episodeCount: 1 }
      } else if (call.method === 'POST' && url.pathname === '/admin/aigc/video/task/sub/list') {
        data = { total: 1, rows: [{ id: 990, aigcVideoTaskId: 42, taskStatus: 'succeeded',
          duration: 13.5, firstResultId: 123, parentResultId: 456,
          resultList: [{ tosVideoUrl: 'https://media.example.test/source.mp4' }] }] }
      } else if (call.method === 'POST' && call.path === '/aigc/storyboard/hdConversion') {
        if (options.submitInterrupted) throw new Error('Simulated provider interruption')
        data = 429001
      } else throw new Error(`Unexpected fixture request: ${call.method} ${call.path}`)
      return new Response(JSON.stringify({ code: 200, data }), { status: 200 })
    } })
  return { root, ledger, client, calls,
    paidCalls: () => calls.filter(call => call.path === '/aigc/storyboard/hdConversion') }
}

describe('live upscale pricing without operator estimates', () => {
  it('prices default SeedVR2 from its live catalogue before reserving and submitting', async () => {
    const { client, ledger, calls, paidCalls } = await fixture()
    expect(await videoMethod(client, ledger, ARGS)).toMatchObject({ outcome: 'accepted', accepted_task_id: '429001' })
    expect(calls.filter(call => call.path === '/model/charge/getSelectList?taskType=20')).toHaveLength(1)
    expect(paidCalls()).toMatchObject([{ body: { modelId: SEED_ROW.modelId, platformId: 'RUNNING_HUB',
      standardId: 55, videoStandardId: 303, duration: 13.5 } }])
    const record = await ledger.find(ARGS.idempotency_key)
    expect(record).toMatchObject({ method: 'video_upscale', script_id: 2708,
      outcome: 'accepted', quoted_amount: '1.00', quote_unit: 'CNY', quote_standard_id: 55 })
    expect(Number.isFinite(Date.parse(record?.quote_observed_at ?? ''))).toBe(true)
  })

  it('refuses a known price above the current budget without a paid intent or submission', async () => {
    const { client, ledger, paidCalls } = await fixture({ limitCents: 99 })
    await expect(videoMethod(client, ledger, ARGS)).rejects.toMatchObject({ code: 'BUDGET_EXCEEDED' })
    expect(paidCalls()).toEqual([])
    expect(await ledger.records()).toEqual([])
  })

  it.each([
    { price: 1.1, amount: '1.10' },
    { price: 0.07, amount: '0.07' },
    { price: 1.001, amount: '1.01' },
    { price: 0.000001, amount: '0.01' },
    { price: 1e-7, amount: '0.01' },
  ])('reserves the positive per-item price $price without rounding below its decimal amount', async ({ price, amount }) => {
    const { client, ledger, paidCalls } = await fixture({ catalogue: [{ ...SEED_ROW, unitPrice: price }] })
    await videoMethod(client, ledger, ARGS)
    expect(paidCalls()).toHaveLength(1)
    expect(await ledger.find(ARGS.idempotency_key)).toMatchObject({ quoted_amount: amount, quote_unit: 'CNY' })
  })

  it('resolves explicit model, platform and output resolution with that row\'s price', async () => {
    const row = { ...SEED_ROW, id: 77, modelId: 'fixture-upscale-model', platformId: 'FIXTURE_PLATFORM',
      unitPrice: 1.25, videoStandards: [{ id: 701, modelId: 'fixture-upscale-model', resolution: '720p' }] }
    const { client, ledger, paidCalls } = await fixture({ catalogue: [SEED_ROW, row] })
    await videoMethod(client, ledger, { ...ARGS, model_id: row.modelId, platform_id: row.platformId, resolution: '720p' })
    expect(paidCalls()).toMatchObject([{ body: { modelId: row.modelId, platformId: row.platformId,
      standardId: 77, videoStandardId: 701 } }])
    expect(await ledger.find(ARGS.idempotency_key)).toMatchObject({ quoted_amount: '1.25', quote_standard_id: 77 })
  })

  it('does not inherit the default platform when an explicit model has one different live platform', async () => {
    const row = { ...SEED_ROW, platformId: 'FIXTURE_PLATFORM', unitPrice: 1.25 }
    const { client, ledger, paidCalls } = await fixture({ catalogue: [row] })
    await videoMethod(client, ledger, { ...ARGS, model_id: row.modelId })
    expect(paidCalls()).toMatchObject([{ body: { platformId: row.platformId, standardId: row.id } }])
    expect(await ledger.find(ARGS.idempotency_key)).toMatchObject({ quoted_amount: '1.25' })
  })

  it('keeps the default platform when the same model is also offered by another platform', async () => {
    const other = { ...SEED_ROW, id: 99, platformId: 'FIXTURE_PLATFORM', unitPrice: 0.01 }
    const { client, ledger, paidCalls } = await fixture({ catalogue: [other, SEED_ROW] })
    await videoMethod(client, ledger, ARGS)
    expect(paidCalls()).toMatchObject([{ body: { platformId: 'RUNNING_HUB', standardId: 55 } }])
    expect(await ledger.find(ARGS.idempotency_key)).toMatchObject({ quoted_amount: '1.00', quote_standard_id: 55 })
  })

  it('binds the quote to the selected model and platform instead of another row with the same id', async () => {
    const other = { ...SEED_ROW, platformId: 'FIXTURE_PLATFORM', unitPrice: 0.01 }
    const { client, ledger, paidCalls } = await fixture({ catalogue: [other, { ...SEED_ROW, unitPrice: 1.25 }] })
    await videoMethod(client, ledger, { ...ARGS, model_id: SEED_ROW.modelId, platform_id: SEED_ROW.platformId })
    expect(paidCalls()).toHaveLength(1)
    expect(await ledger.find(ARGS.idempotency_key)).toMatchObject({ quoted_amount: '1.25', quote_standard_id: 55 })
  })

  it.each([
    { label: 'missing price', row: { ...SEED_ROW, unitPrice: undefined } },
    { label: 'missing unit', row: { ...SEED_ROW, unit: undefined } },
    { label: 'unknown unit', row: { ...SEED_ROW, unit: 'credits' } },
    { label: 'per-second unit', row: { ...SEED_ROW, unit: '元/秒' } },
    { label: 'unresolved per-minute coefficient', row: { ...SEED_ROW, unit: '元/分钟(1系数)' } },
  ])('refuses $label without an operator estimate or paid submission', async ({ row }) => {
    const { client, ledger, paidCalls } = await fixture({ catalogue: [row] })
    await expect(videoMethod(client, ledger, ARGS)).rejects.toMatchObject({ code: 'BUDGET_EXCEEDED' })
    expect(paidCalls()).toEqual([])
    expect(await ledger.records()).toEqual([])
  })

  it.each([0, -1, Number.MAX_SAFE_INTEGER])('rejects unusable per-item price %s without a paid submission', async (price) => {
    const { client, ledger, paidCalls } = await fixture({ catalogue: [{ ...SEED_ROW, unitPrice: price }] })
    await expect(videoMethod(client, ledger, ARGS)).rejects.toMatchObject({ code: 'CONTRACT_CHANGED' })
    expect(paidCalls()).toEqual([])
    expect(await ledger.records()).toEqual([])
  })

  it('rejects a non-finite number decoded from the provider catalogue', async () => {
    const { client, ledger, paidCalls } = await fixture({ catalogueOverflow: true })
    await expect(videoMethod(client, ledger, ARGS)).rejects.toMatchObject({ code: 'CONTRACT_CHANGED' })
    expect(paidCalls()).toEqual([])
    expect(await ledger.records()).toEqual([])
  })

  it.each([
    { label: 'missing price', row: { ...SEED_ROW, unitPrice: undefined } },
    { label: 'null price', row: { ...SEED_ROW, unitPrice: null } },
    { label: 'missing unit', row: { ...SEED_ROW, unit: undefined } },
    { label: 'unresolved coefficient', row: { ...SEED_ROW, unit: '元/分钟(1系数)' } },
  ])('preserves an existing operator-approved estimate for $label', async ({ row }) => {
    const { client, ledger, paidCalls } = await fixture({ catalogue: [row], approvedEstimate: '2.50' })
    await videoMethod(client, ledger, ARGS)
    expect(paidCalls()).toHaveLength(1)
    expect(await ledger.find(ARGS.idempotency_key)).toMatchObject({ quoted_amount: '2.50', quote_unit: 'CNY',
      quote_standard_id: SEED_ROW.id })
  })

  it.each([0, -1, 'NaN'])('does not substitute an operator estimate for invalid price %s', async (price) => {
    const { client, ledger, paidCalls } = await fixture({ catalogue: [{ ...SEED_ROW, unitPrice: price }],
      approvedEstimate: '2.50' })
    await expect(videoMethod(client, ledger, ARGS)).rejects.toMatchObject({ code: 'CONTRACT_CHANGED' })
    expect(paidCalls()).toEqual([])
    expect(await ledger.records()).toEqual([])
  })

  it('does not substitute an operator estimate for a non-finite provider price', async () => {
    const { client, ledger, paidCalls } = await fixture({ catalogueOverflow: true, approvedEstimate: '2.50' })
    await expect(videoMethod(client, ledger, ARGS)).rejects.toMatchObject({ code: 'CONTRACT_CHANGED' })
    expect(paidCalls()).toEqual([])
    expect(await ledger.records()).toEqual([])
  })

  it('requires the default model to remain present in the live catalogue', async () => {
    const { client, ledger, paidCalls } = await fixture({ catalogue: [] })
    await expect(videoMethod(client, ledger, ARGS)).rejects.toMatchObject({ code: 'CONTRACT_CHANGED' })
    expect(paidCalls()).toEqual([])
    expect(await ledger.records()).toEqual([])
  })

  it('propagates a catalogue application-level 403 without a paid intent or submission', async () => {
    const { client, ledger, paidCalls } = await fixture({ catalogueDenied: true })
    await expect(videoMethod(client, ledger, ARGS)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
    expect(paidCalls()).toEqual([])
    expect(await ledger.records()).toEqual([])
  })

  it('replays an accepted upscale after opening the ledger again without another provider request', async () => {
    const { client, ledger, root, calls, paidCalls } = await fixture()
    await videoMethod(client, ledger, ARGS)
    const count = calls.length
    expect(await videoMethod(client, new JubianLedger({ root }), ARGS))
      .toMatchObject({ replayed: true, outcome: 'accepted', accepted_task_id: null })
    expect(calls).toHaveLength(count)
    expect(paidCalls()).toHaveLength(1)
    expect(await ledger.records()).toHaveLength(1)
  })

  it('retains an interrupted submission as unknown and never resubmits the same key', async () => {
    const { client, ledger, root, calls, paidCalls } = await fixture({ submitInterrupted: true })
    await expect(videoMethod(client, ledger, ARGS)).rejects.toMatchObject({ code: 'NETWORK_ERROR' })
    expect(await ledger.find(ARGS.idempotency_key)).toMatchObject({ outcome: 'unknown', quoted_amount: '1.00' })
    const count = calls.length
    expect(await videoMethod(client, new JubianLedger({ root }), ARGS))
      .toMatchObject({ replayed: true, outcome: 'unknown', accepted_task_id: null })
    expect(calls).toHaveLength(count)
    expect(paidCalls()).toHaveLength(1)
  })
})

describe('selected upscale quote validation', () => {
  it.each([undefined, null, {}, 'catalogue'])('rejects a non-array catalogue %j', (catalogue) => {
    expect(() => readUpscaleQuote(catalogue, SELECTED)).toThrow('Invalid live upscale price')
  })

  it('rejects a catalogue with no exact selected row', () => {
    expect(() => readUpscaleQuote([], SELECTED)).toThrow('Invalid live upscale price')
  })

  it('skips non-object and mismatching rows before using an exact standardId match', () => {
    const { id, ...row } = SEED_ROW
    expect(readUpscaleQuote([null, [], 1, {}, { ...SEED_ROW, modelId: 'other-model' },
      { ...SEED_ROW, platformId: 'OTHER_PLATFORM' }, { ...SEED_ROW, id: 99 },
      { ...row, standardId: id }], SELECTED)).toEqual({ amount: '1.00', unit: 'CNY' })
  })

  it.each([undefined, null])('leaves missing price %j to the existing operator-estimate policy', (price) => {
    expect(readUpscaleQuote([{ ...SEED_ROW, unitPrice: price }], SELECTED)).toEqual({})
  })

  it.each(['1', 'NaN', Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1, 0, {}, [], true])
  ('rejects malformed or nonpositive price %j', (price) => {
    expect(() => readUpscaleQuote([{ ...SEED_ROW, unitPrice: price }], SELECTED)).toThrow('Invalid live upscale price')
  })

  it.each([
    { price: 1e-7, amount: '0.01' },
    { price: 0.29, amount: '0.29' },
    { price: 90071992547409.9, amount: '90071992547409.90' },
  ])('quotes safe decimal price $price as $amount', ({ price, amount }) => {
    expect(readUpscaleQuote([{ ...SEED_ROW, unitPrice: price }], SELECTED)).toEqual({ amount, unit: 'CNY' })
  })

  it.each([90071992547409.92, Number.MAX_SAFE_INTEGER, 1e21])('rejects a quote outside safe cents: %s', (price) => {
    expect(() => readUpscaleQuote([{ ...SEED_ROW, unitPrice: price }], SELECTED)).toThrow('Invalid live upscale price')
  })
})
