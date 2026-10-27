import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JubianClient, JubianLedger } from '@deepseek-ai/dsh-jubian'
import { describe, expect, it, onTestFinished } from 'vitest'
import { estimateEraseRate } from '../src/erase-price.ts'
import { storyboardMethod } from '../src/methods.ts'

const regional = { id: 26, modelId: 'quzimuToB', platformId: 'YU_DIAN', unitPrice: 0.505, unit: '元/分钟', videoStandards: [] }
const automatic = { id: 67, modelId: 'ark-erase-video-subtitle-pro', platformId: 'AI_MEDIA_KIT', unitPrice: 0, unit: '元/条', videoStandards: [] }
const request = { modelId: 'quzimuToB', platformId: 'YU_DIAN', standardId: 26, duration: 13.5 }

describe('subtitle erasure catalogue estimates', () => {
  it.each([[13.5, '0.51'], [60, '0.51'], [60.01, '1.02']])('rounds the duration and rate upward for %s seconds', (duration, amount) => {
    expect(estimateEraseRate([regional], { ...request, duration })).toMatchObject({ amount, unit: 'CNY' })
  })

  it('does not turn a zero, missing, unsupported, conflicting or invalid rate into a budget estimate', () => {
    for (const catalogue of [null, [], [null, 'bad', automatic], [regional, regional], [{ ...regional, unitPrice: 0 }],
      [{ ...regional, unitPrice: -1 }], [{ ...regional, unitPrice: '0.505' }],
      [{ ...regional, unitPrice: Number.NaN }], [{ ...regional, unitPrice: Number.MAX_VALUE }],
      [{ ...regional, unit: '元/条' }], [{ ...regional, platformId: 'OTHER' }], [{ ...regional, id: 27 }]]) {
      expect(estimateEraseRate(catalogue, request)).toBeUndefined()
    }
    for (const duration of [0, -1, Number.NaN, Number.MAX_VALUE, '13.5']) {
      expect(estimateEraseRate([regional], { ...request, duration })).toBeUndefined()
    }
    expect(estimateEraseRate([{ ...regional, id: undefined, standardId: 26 }], request)?.amount).toBe('0.51')
  })

  async function fixture(options: { catalogue: unknown; limitCents?: number }) {
    const root = await mkdtemp(join(tmpdir(), 'jubian-erase-rate-'))
    onTestFinished(async () => { await rm(root, { recursive: true, force: true }) })
    const ledger = new JubianLedger({ root, defaultLimitCents: () => options.limitCents ?? 400_000 })
    const calls: string[] = []
    const client = new JubianClient({ baseUrl: 'https://erase-rate.invalid', credential: async () => 'fixture-token',
      fetch: async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : input.toString())
        expect(url.origin).toBe('https://erase-rate.invalid')
        calls.push(url.pathname + url.search)
        let data: unknown
        if (url.pathname === '/admin/aigc/video/task/42') data = { id: 42, scriptId: 2708, episodeId: 46744, episodeCount: 1, taskName: 'source' }
        else if (url.pathname === '/admin/aigc/video/task/sub/list') data = { total: 1, rows: [{ id: 990, aigcVideoTaskId: 42,
          taskStatus: 'succeeded', duration: 13.5, firstResultId: 123, parentResultId: 456,
          resultList: [{ taskType: 1, tosVideoUrl: 'https://media.example.test/source.mp4' }] }] }
        else if (url.pathname === '/model/charge/getSelectList') data = options.catalogue
        else if (url.pathname === '/aigc/storyboard/subtitleEraser') {
          expect(init?.method).toBe('POST')
          expect(await ledger.find('rate-estimate')).toMatchObject({ quoted_amount: '0.51', quote_unit: 'CNY', outcome: null })
          data = { taskId: 429001 }
        } else throw new Error(`unexpected request: ${url.pathname}`)
        return new Response(JSON.stringify({ code: 200, data }), { status: 200 })
      } })
    return { client, ledger, calls }
  }

  it('reserves the live positive minute-rate estimate before one submission and never resends a replay', async () => {
    const { client, ledger, calls } = await fixture({ catalogue: [regional, automatic] })
    const args = { method: 'erase_subtitle', task_id: 42, model_id: 'quzimuToB', video_width: 480, video_height: 854,
      idempotency_key: 'rate-estimate' } as const
    const result = await storyboardMethod(client, ledger, args)
    expect(result).toMatchObject({ outcome: 'accepted', accepted_task_id: '429001' })
    expect(result.next).toContain('不是供应商报价或实际结算')
    expect(result.next).toContain('0.505 元/分钟')
    expect(calls.filter(path => path === '/aigc/storyboard/subtitleEraser')).toHaveLength(1)
    const count = calls.length
    expect(await storyboardMethod(client, ledger, args)).toMatchObject({ replayed: true })
    expect(calls).toHaveLength(count)
  })

  it('does not submit the zero-priced model or a rate above the project budget', async () => {
    for (const [model_id, limitCents] of [['ark-erase-video-subtitle-pro', 400_000], ['quzimuToB', 50]] as const) {
      const { client, ledger, calls } = await fixture({ catalogue: [regional, automatic], limitCents })
      await expect(storyboardMethod(client, ledger, { method: 'erase_subtitle', task_id: 42, model_id,
        video_width: 480, video_height: 854, idempotency_key: 'rate-estimate' })).rejects.toMatchObject({ code: 'BUDGET_EXCEEDED' })
      expect(calls).not.toContain('/aigc/storyboard/subtitleEraser')
      expect(await ledger.records()).toEqual([])
    }
  })
})
