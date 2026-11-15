/** A live zero-price selection still records its original write before the provider receives it. */
import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { JubianClient, JubianLedger } from '@deepseek-ai/dsh-jubian'
import { storyboardMethod } from '../src/methods.ts'

it('records a verified free erasure without an allowance, replays its key, and rechecks new positive prices', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jubian-free-erasure-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const ledger = new JubianLedger({ root })
  let price = 0, posts = 0
  const calls: string[] = []
  const client = new JubianClient({ baseUrl: 'https://free-erasure.invalid/prod-api',
    credential: async () => 'offline-free-erasure',
    fetch: async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString())
      expect(url.origin).toBe('https://free-erasure.invalid')
      const path = url.pathname.replace('/prod-api', '')
      calls.push(`${init?.method} ${path}`)
      let data: unknown
      if (path === '/admin/aigc/video/task/42') {
        data = { id: 42, scriptId: 2708, episodeId: 46744, episodeCount: 1 }
      } else if (path === '/admin/aigc/video/task/sub/list') {
        data = { total: 1, rows: [{ id: 990, aigcVideoTaskId: 42, taskStatus: 'succeeded',
          duration: 13.5, firstResultId: 123, parentResultId: 456,
          resultList: [{ taskType: 1, tosVideoUrl: 'https://media.example.test/source.mp4' }] }] }
      } else if (path === '/model/charge/getSelectList') {
        expect(url.search).toBe('?taskType=10')
        data = [{ id: 67, modelId: 'ark-erase-video-subtitle-pro', platformId: 'AI_MEDIA_KIT',
          unitPrice: price, unit: '元/条', videoStandards: [] }]
      } else if (path === '/aigc/storyboard/subtitleEraser') {
        posts++
        expect(price).toBe(0)
        if (typeof init?.body !== 'string') throw new Error('Expected a JSON string request body')
        const body: unknown = JSON.parse(init.body)
        expect(body).toMatchObject({ scriptId: 2708, modelId: 'ark-erase-video-subtitle-pro',
          platformId: 'AI_MEDIA_KIT', standardId: 67, taskType: 10 })
        expect(await ledger.find('verified-free')).toMatchObject({ method: 'erase_subtitle', script_id: 2708,
          quoted_amount: '0.00', quote_unit: 'CNY', quote_standard_id: 67, outcome: null })
        data = { taskId: 429001 }
      } else throw new Error(`Unexpected offline request: ${path}`)
      return new Response(JSON.stringify({ code: 200, data }), { status: 200 })
    } })
  const args = { method: 'erase_subtitle', task_id: 42, model_id: 'ark-erase-video-subtitle-pro',
    video_width: 480, video_height: 854, idempotency_key: 'verified-free' }
  const first = await storyboardMethod(client, ledger, args)
  expect(first).toMatchObject({ replayed: false, outcome: 'accepted', accepted_task_id: '429001' })
  expect(first.next).toContain('0 元/条')
  expect(calls).toHaveLength(4)
  const accepted = await ledger.find('verified-free')
  expect(accepted).toMatchObject({ quoted_amount: '0.00', quote_unit: 'CNY',
    quote_standard_id: 67, outcome: 'accepted' })
  expect(typeof accepted?.quote_observed_at).toBe('string')
  expect(await storyboardMethod(client, ledger, args)).toMatchObject({ replayed: true, outcome: 'accepted' })
  expect(calls).toHaveLength(4)
  price = 0.5
  await expect(storyboardMethod(client, ledger, { ...args, idempotency_key: 'positive-price' }))
    .rejects.toMatchObject({ code: 'BUDGET_EXCEEDED' })
  expect(posts).toBe(1)
  expect(calls).toHaveLength(7)
  expect(await ledger.records()).toHaveLength(1)
  expect(await ledger.find('positive-price')).toBeUndefined()
  await expect(access(join(root, 'authorization.json'))).rejects.toMatchObject({ code: 'ENOENT' })
})
