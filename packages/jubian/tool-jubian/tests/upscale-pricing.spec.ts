import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JubianClient, JubianLedger } from '@deepseek-ai/dsh-jubian'
import { describe, expect, it, onTestFinished } from 'vitest'
import { videoMethod } from '../src/methods.ts'
import { readUpscaleQuote } from '../src/upscale-price.ts'
import { bodyHash } from '../src/write.ts'

// Captured taskType 20 catalogue: jubian-api/tests/fixtures/catalogue-20261016.json.
const MEDIAKIT_ROW = { id: 27, modelId: 'AI MediaKit', platformId: 'AI_MEDIA_KIT',
  unitPrice: 0.375, unit: '元/分钟(1系数)', videoStandards: [
    { id: 165, modelId: 'AI MediaKit', resolution: '1080p', ratio: 'standard', height: 4, width: 0, frames: 31 },
    { id: 166, modelId: 'AI MediaKit', resolution: '720p', ratio: 'standard', height: 2, width: 0, frames: 31 },
  ] }
const SEED_ROW = { id: 55, modelId: '2074071626416742401', platformId: 'RUNNING_HUB',
  unitPrice: 1, unit: '元/条', videoStandards: [
    { id: 303, modelId: '2074071626416742401', resolution: '1080p' },
  ] }
const ARGS = { method: 'upscale', task_id: 42, idempotency_key: 'priced-upscale' } as const
const SEED_ARGS = { ...ARGS, model_id: SEED_ROW.modelId, platform_id: SEED_ROW.platformId }
const SELECTED = { modelId: SEED_ROW.modelId, platformId: SEED_ROW.platformId,
  standardId: SEED_ROW.id, videoStandardId: 303 }
const MEDIAKIT_1080P = { modelId: MEDIAKIT_ROW.modelId, platformId: MEDIAKIT_ROW.platformId,
  standardId: MEDIAKIT_ROW.id, videoStandardId: 165 }

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
  duration?: number
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
        data = options.catalogue ?? [MEDIAKIT_ROW, SEED_ROW]
      } else if (call.method === 'GET' && call.path === '/admin/aigc/video/task/42') {
        data = { id: 42, scriptId: 2708, episodeId: 46744, episodeCount: 1 }
      } else if (call.method === 'POST' && url.pathname === '/admin/aigc/video/task/sub/list') {
        data = { total: 1, rows: [{ id: 990, aigcVideoTaskId: 42, taskStatus: 'succeeded',
          duration: options.duration ?? 13.5, firstResultId: 123, parentResultId: 456,
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
  it('prices default MediaKit 1080p from its live per-minute coefficient before reserving and submitting', async () => {
    const { client, ledger, calls, paidCalls } = await fixture()
    expect(await videoMethod(client, ledger, ARGS)).toMatchObject({ outcome: 'accepted', accepted_task_id: '429001' })
    expect(calls.filter(call => call.path === '/model/charge/getSelectList?taskType=20')).toHaveLength(1)
    expect(paidCalls()).toMatchObject([{ body: { modelId: 'AI MediaKit', platformId: 'AI_MEDIA_KIT',
      standardId: 27, videoStandardId: 165, duration: 13.5 } }])
    const record = await ledger.find(ARGS.idempotency_key)
    // 0.375 per coefficient-minute, coefficient 4 for 1080p, one started minute.
    expect(record).toMatchObject({ method: 'video_upscale', script_id: 2708,
      outcome: 'accepted', quoted_amount: '1.50', quote_unit: 'CNY', quote_standard_id: 27 })
    expect(Number.isFinite(Date.parse(record?.quote_observed_at ?? ''))).toBe(true)
  })

  it('prices an explicitly named SeedVR2 per item and submits its selectors', async () => {
    const { client, ledger, paidCalls } = await fixture()
    expect(await videoMethod(client, ledger, SEED_ARGS)).toMatchObject({ outcome: 'accepted', accepted_task_id: '429001' })
    expect(paidCalls()).toMatchObject([{ body: { modelId: SEED_ROW.modelId, platformId: 'RUNNING_HUB',
      standardId: 55, videoStandardId: 303, duration: 13.5 } }])
    expect(await ledger.find(ARGS.idempotency_key)).toMatchObject({ quoted_amount: '1.00', quote_standard_id: 55 })
  })

  it('prices an explicit MediaKit 720p standard with its own coefficient', async () => {
    const { client, ledger, paidCalls } = await fixture()
    await videoMethod(client, ledger, { ...ARGS, resolution: '720p' })
    expect(paidCalls()).toMatchObject([{ body: { modelId: 'AI MediaKit', standardId: 27, videoStandardId: 166 } }])
    expect(await ledger.find(ARGS.idempotency_key)).toMatchObject({ quoted_amount: '0.75', quote_standard_id: 27 })
  })

  it('does not fall back to SeedVR2 when the live catalogue no longer lists MediaKit', async () => {
    const { client, ledger, paidCalls } = await fixture({ catalogue: [SEED_ROW] })
    await expect(videoMethod(client, ledger, ARGS)).rejects.toMatchObject({ code: 'CONTRACT_CHANGED' })
    expect(paidCalls()).toEqual([])
    expect(await ledger.records()).toEqual([])
  })

  it('does not fall back to SeedVR2 when MediaKit no longer offers the default 1080p standard', async () => {
    const mediaKit720 = { ...MEDIAKIT_ROW, videoStandards: [MEDIAKIT_ROW.videoStandards[1]] }
    const { client, ledger, paidCalls } = await fixture({ catalogue: [mediaKit720, SEED_ROW] })
    await expect(videoMethod(client, ledger, ARGS)).rejects.toMatchObject({ code: 'CONTRACT_CHANGED',
      detail: 'Select one supported output resolution from the live model standards' })
    expect(paidCalls()).toEqual([])
    expect(await ledger.records()).toEqual([])
  })

  it('selects SeedVR2 when model_id alone names it', async () => {
    const { client, ledger, paidCalls } = await fixture()
    await videoMethod(client, ledger, { ...ARGS, model_id: SEED_ROW.modelId })
    expect(paidCalls()).toMatchObject([{ body: { modelId: SEED_ROW.modelId, platformId: 'RUNNING_HUB',
      standardId: 55, videoStandardId: 303 } }])
    expect(await ledger.find(ARGS.idempotency_key)).toMatchObject({ quoted_amount: '1.00', quote_standard_id: 55 })
  })

  it('does not turn a platform without a model into SeedVR2', async () => {
    const { client, ledger, paidCalls } = await fixture()
    await expect(videoMethod(client, ledger, { ...ARGS, platform_id: SEED_ROW.platformId }))
      .rejects.toMatchObject({ code: 'CONTRACT_CHANGED' })
    expect(paidCalls()).toEqual([])
    expect(await ledger.records()).toEqual([])
  })

  it.each([
    { duration: 60, amount: '1.50' },
    { duration: 60.5, amount: '3.00' },
    { duration: 125, amount: '4.50' },
  ])('reserves MediaKit 1080p for every started minute of a $duration second source', async ({ duration, amount }) => {
    const { client, ledger, paidCalls } = await fixture({ duration })
    await videoMethod(client, ledger, ARGS)
    expect(paidCalls()).toMatchObject([{ body: { modelId: 'AI MediaKit', videoStandardId: 165, duration } }])
    expect(await ledger.find(ARGS.idempotency_key)).toMatchObject({ quoted_amount: amount, quote_standard_id: 27 })
  })

  it('rejects a non-positive source duration before reserving a per-minute price', async () => {
    const { client, ledger, paidCalls } = await fixture({ duration: 0 })
    await expect(videoMethod(client, ledger, ARGS)).rejects.toMatchObject({ code: 'CONTRACT_CHANGED',
      detail: 'Invalid source duration for a per-minute upscale price' })
    expect(paidCalls()).toEqual([])
    expect(await ledger.records()).toEqual([])
  })

  it('replays an accepted SeedVR2 key from before the MediaKit default without any provider read', async () => {
    const { client, ledger, calls } = await fixture()
    const seedVr2Body = { scriptId: 2708, episodeId: 46744, episodeCount: 1, firstResultId: 123, parentResultId: 456,
      duration: 13.5, taskName: 'task-42-高清转换', taskType: 20, modelId: SEED_ROW.modelId, platformId: SEED_ROW.platformId,
      standardId: 55, videoStandardId: 303, videoUrl: 'https://media.example.test/source.mp4' }
    await ledger.begin({ idempotencyKey: ARGS.idempotency_key, method: 'video_upscale', requestSha256: bodyHash(seedVr2Body),
      scriptId: 2708, quotedAmount: '1.00', quoteUnit: 'CNY', quoteStandardId: 55 })
    await ledger.settle(ARGS.idempotency_key, { httpStatus: 200, applicationCode: 200, responseSha256: null,
      outcome: 'accepted' })
    expect(await videoMethod(client, ledger, ARGS))
      .toMatchObject({ replayed: true, outcome: 'accepted', accepted_task_id: null })
    expect(calls).toEqual([])
    expect(await ledger.records()).toMatchObject([{ request_sha256: bodyHash(seedVr2Body), quoted_amount: '1.00',
      quote_standard_id: 55, outcome: 'accepted' }])
  })

  it('refuses a known price above the current budget without a paid intent or submission', async () => {
    const { client, ledger, paidCalls } = await fixture({ limitCents: 149 })
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
    await videoMethod(client, ledger, SEED_ARGS)
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
    const other = { ...MEDIAKIT_ROW, id: 99, platformId: 'FIXTURE_PLATFORM', unitPrice: 0.01 }
    const { client, ledger, paidCalls } = await fixture({ catalogue: [other, MEDIAKIT_ROW] })
    await videoMethod(client, ledger, ARGS)
    expect(paidCalls()).toMatchObject([{ body: { platformId: 'AI_MEDIA_KIT', standardId: 27 } }])
    expect(await ledger.find(ARGS.idempotency_key)).toMatchObject({ quoted_amount: '1.50', quote_standard_id: 27 })
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
    { label: 'per-minute coefficient without a standard coefficient', row: { ...SEED_ROW, unit: '元/分钟(1系数)' } },
  ])('refuses $label without an operator estimate or paid submission', async ({ row }) => {
    const { client, ledger, paidCalls } = await fixture({ catalogue: [row] })
    await expect(videoMethod(client, ledger, SEED_ARGS)).rejects.toMatchObject({ code: 'BUDGET_EXCEEDED' })
    expect(paidCalls()).toEqual([])
    expect(await ledger.records()).toEqual([])
  })

  it.each([0, -1, Number.MAX_SAFE_INTEGER])('rejects unusable per-item price %s without a paid submission', async (price) => {
    const { client, ledger, paidCalls } = await fixture({ catalogue: [{ ...SEED_ROW, unitPrice: price }] })
    await expect(videoMethod(client, ledger, SEED_ARGS)).rejects.toMatchObject({ code: 'CONTRACT_CHANGED' })
    expect(paidCalls()).toEqual([])
    expect(await ledger.records()).toEqual([])
  })

  it('rejects a non-finite number decoded from the provider catalogue', async () => {
    const { client, ledger, paidCalls } = await fixture({ catalogueOverflow: true })
    await expect(videoMethod(client, ledger, SEED_ARGS)).rejects.toMatchObject({ code: 'CONTRACT_CHANGED' })
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
    await videoMethod(client, ledger, SEED_ARGS)
    expect(paidCalls()).toHaveLength(1)
    expect(await ledger.find(ARGS.idempotency_key)).toMatchObject({ quoted_amount: '2.50', quote_unit: 'CNY',
      quote_standard_id: SEED_ROW.id })
  })

  it('preserves an existing operator-approved estimate for a MediaKit standard without a coefficient', async () => {
    const row = { ...MEDIAKIT_ROW, videoStandards: [{ id: 165, modelId: 'AI MediaKit', resolution: '1080p' }] }
    const { client, ledger, paidCalls } = await fixture({ catalogue: [row], approvedEstimate: '2.50' })
    await videoMethod(client, ledger, ARGS)
    expect(paidCalls()).toMatchObject([{ body: { modelId: 'AI MediaKit', standardId: 27, videoStandardId: 165 } }])
    expect(await ledger.find(ARGS.idempotency_key)).toMatchObject({ quoted_amount: '2.50', quote_standard_id: 27 })
  })

  it.each([0, -1, 'NaN'])('does not substitute an operator estimate for invalid price %s', async (price) => {
    const { client, ledger, paidCalls } = await fixture({ catalogue: [{ ...SEED_ROW, unitPrice: price }],
      approvedEstimate: '2.50' })
    await expect(videoMethod(client, ledger, SEED_ARGS)).rejects.toMatchObject({ code: 'CONTRACT_CHANGED' })
    expect(paidCalls()).toEqual([])
    expect(await ledger.records()).toEqual([])
  })

  it('does not substitute an operator estimate for a non-finite provider price', async () => {
    const { client, ledger, paidCalls } = await fixture({ catalogueOverflow: true, approvedEstimate: '2.50' })
    await expect(videoMethod(client, ledger, SEED_ARGS)).rejects.toMatchObject({ code: 'CONTRACT_CHANGED' })
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
    expect(await ledger.find(ARGS.idempotency_key)).toMatchObject({ outcome: 'unknown', quoted_amount: '1.50' })
    const count = calls.length
    expect(await videoMethod(client, new JubianLedger({ root }), ARGS))
      .toMatchObject({ replayed: true, outcome: 'unknown', accepted_task_id: null })
    expect(calls).toHaveLength(count)
    expect(paidCalls()).toHaveLength(1)
  })
})

describe('selected upscale quote validation', () => {
  it.each([undefined, null, {}, 'catalogue'])('rejects a non-array catalogue %j', (catalogue) => {
    expect(() => readUpscaleQuote(catalogue, SELECTED, 13.5)).toThrow('Invalid live upscale price')
  })

  it('rejects a catalogue with no exact selected row', () => {
    expect(() => readUpscaleQuote([], SELECTED, 13.5)).toThrow('Invalid live upscale price')
  })

  it('skips non-object and mismatching rows before using an exact standardId match', () => {
    const { id, ...row } = SEED_ROW
    expect(readUpscaleQuote([null, [], 1, {}, { ...SEED_ROW, modelId: 'other-model' },
      { ...SEED_ROW, platformId: 'OTHER_PLATFORM' }, { ...SEED_ROW, id: 99 },
      { ...row, standardId: id }], SELECTED, 13.5)).toEqual({ amount: '1.00', unit: 'CNY' })
  })

  it.each([undefined, null])('leaves missing price %j to the existing operator-estimate policy', (price) => {
    expect(readUpscaleQuote([{ ...SEED_ROW, unitPrice: price }], SELECTED, 13.5)).toEqual({})
  })

  it.each(['1', 'NaN', Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1, 0, {}, [], true])
  ('rejects malformed or nonpositive price %j', (price) => {
    expect(() => readUpscaleQuote([{ ...SEED_ROW, unitPrice: price }], SELECTED, 13.5)).toThrow('Invalid live upscale price')
  })

  it.each([
    { price: 1e-7, amount: '0.01' },
    { price: 0.29, amount: '0.29' },
    { price: 90071992547409.9, amount: '90071992547409.90' },
  ])('quotes safe decimal price $price as $amount', ({ price, amount }) => {
    expect(readUpscaleQuote([{ ...SEED_ROW, unitPrice: price }], SELECTED, 13.5)).toEqual({ amount, unit: 'CNY' })
  })

  it.each([90071992547409.92, Number.MAX_SAFE_INTEGER, 1e21])('rejects a quote outside safe cents: %s', (price) => {
    expect(() => readUpscaleQuote([{ ...SEED_ROW, unitPrice: price }], SELECTED, 13.5)).toThrow('Invalid live upscale price')
  })

  it('quotes a per-item price without reading the duration', () => {
    expect(readUpscaleQuote([SEED_ROW], SELECTED, Number.NaN)).toEqual({ amount: '1.00', unit: 'CNY' })
  })

  it.each([
    { duration: 13.5, videoStandardId: 165, amount: '1.50' },
    { duration: 60, videoStandardId: 165, amount: '1.50' },
    { duration: 60.01, videoStandardId: 165, amount: '3.00' },
    { duration: 13.5, videoStandardId: 166, amount: '0.75' },
    { duration: 125, videoStandardId: 166, amount: '2.25' },
  ])('quotes MediaKit standard $videoStandardId for $duration seconds as $amount', ({ duration, videoStandardId, amount }) => {
    expect(readUpscaleQuote([MEDIAKIT_ROW], { ...MEDIAKIT_1080P, videoStandardId }, duration))
      .toEqual({ amount, unit: 'CNY' })
  })

  it.each([
    { label: 'an absent standard', standards: [] },
    { label: 'a non-list standard field', standards: null },
    { label: 'a non-object standard', standards: [null, 165] },
    { label: 'a missing coefficient', standards: [{ id: 165, width: 0 }] },
    { label: 'a fractional coefficient', standards: [{ id: 165, height: 1.5, width: 0 }] },
    { label: 'a zero coefficient', standards: [{ id: 165, height: 0, width: 0 }] },
    { label: 'a text coefficient', standards: [{ id: 165, height: '4', width: 0 }] },
    { label: 'a height without the zero width', standards: [{ id: 165, height: 4 }] },
    { label: 'pixel dimensions', standards: [{ id: 165, height: 1920, width: 1080 }] },
  ])('leaves $label to the existing operator-estimate policy', ({ standards }) => {
    expect(readUpscaleQuote([{ ...MEDIAKIT_ROW, videoStandards: standards }], MEDIAKIT_1080P, 13.5)).toEqual({})
  })

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])('rejects unusable duration %s for a per-minute price', (duration) => {
    expect(() => readUpscaleQuote([MEDIAKIT_ROW], MEDIAKIT_1080P, duration))
      .toThrow('Invalid source duration for a per-minute upscale price')
  })

  it('rejects a per-minute quote outside safe cents', () => {
    expect(() => readUpscaleQuote([MEDIAKIT_ROW], MEDIAKIT_1080P, 1e300)).toThrow('Invalid live upscale price')
  })
})
