/** A live zero-price selection still records its original write before the provider receives it. */
import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { JubianClient, JubianLedger } from '@deepseek-ai/dsh-jubian'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { MuseMediaPostprocessJobKey } from '@deepseek-ai/dsh-muse-account'
import type { MediaPostprocessClient } from '../src/mediakit.ts'
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

it.each([false, true])('routes an approved automatic erasure from Jubian with MediaKit rejection %s', async (rejected) => {
  const root = await mkdtemp(join(tmpdir(), 'jubian-erase-pilot-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const ledger = new JubianLedger({ root, defaultLimitCents: () => 500 })
  const sourceUrl = 'https://media.example.test/with-captions.mp4'
  const jobKey = brandString<MuseMediaPostprocessJobKey>('c'.repeat(64))
  const paths: string[] = []
  const client = new JubianClient({ baseUrl: 'https://erase-pilot.invalid/prod-api',
    credential: async () => 'offline-erase',
    fetch: async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString())
      expect(url.origin).toBe('https://erase-pilot.invalid')
      const path = url.pathname
      paths.push(path)
      if (path.endsWith('/task/42')) return Response.json({ code: 200, data: { id: 42, scriptId: 2708, episodeId: 46744 } })
      if (path.endsWith('/sub/list')) return Response.json({ code: 200, data: { total: 1, rows: [
        { id: 990, aigcVideoTaskId: 42, taskStatus: 'succeeded', duration: 13.5, firstResultId: 123,
          resultList: [{ taskType: 1, tosVideoUrl: sourceUrl }] },
      ] } })
      if (rejected && path.endsWith('/model/charge/getSelectList')) {
        expect(url.search).toBe('?taskType=10')
        return Response.json({ code: 200, data: [{ id: 67, modelId: 'ark-erase-video-subtitle-pro',
          platformId: 'AI_MEDIA_KIT', unitPrice: 0.5, unit: '元/条', videoStandards: [] }] })
      }
      if (rejected && path.endsWith('/aigc/storyboard/subtitleEraser')) {
        expect(claims).toBe(1)
        expect(await ledger.find(`muse-mediakit-backup-${jobKey}`)).toMatchObject({ method: 'erase_subtitle', quoted_amount: '0.50' })
        if (typeof init?.body !== 'string') throw Error('Expected a JSON string request body')
        expect(JSON.parse(init.body)).toMatchObject({ modelId: 'ark-erase-video-subtitle-pro', standardId: 67 })
        return Response.json({ code: 200, data: { taskId: 429001 } })
      }
      throw new Error(`Unexpected erasure fixture request: ${path}`)
    } })
  let submissions = 0, claims = 0
  const rejection = { state: 'rejected', code: 'MEDIAKIT_RATE_LIMITED' } as const
  const postprocess: MediaPostprocessClient = {
    previewMediaPostprocess: async (request) => {
      expect(request).toEqual({ operation: 'erase_subtitle', scriptId: 2708, taskId: 42, videoUrl: sourceUrl })
      return { state: 'ready', jobKey, amount: '1.00', unit: 'CNY' }
    },
    submitMediaPostprocess: async () => { submissions++; return rejected ? rejection : { state: 'accepted' } },
    statusMediaPostprocess: async () => rejected ? rejection : { state: 'pending' },
    claimMediaPostprocessFallback: async (key) => { expect(key).toBe(jobKey); return ++claims === 1 },
  }
  const args = { method: 'erase_subtitle', task_id: 42,
    video_width: 480, video_height: 854, idempotency_key: 'pilot-erase',
    ...(rejected ? {} : { platform_id: 'AI_MEDIA_KIT' }) }
  const result = await storyboardMethod(client, ledger, args, { postprocess })
  if (rejected) {
    expect(result).toMatchObject({ provider: 'jubian', fallback_from: 'volcengine-mediakit', accepted_task_id: '429001' })
    expect(await storyboardMethod(client, ledger, args, { postprocess })).toMatchObject({ provider: 'jubian', replayed: true })
  } else {
    expect(result).toMatchObject({ provider: 'volcengine-mediakit', processing_job_key: jobKey, status: 'accepted' })
  }
  expect(paths).toHaveLength(rejected ? 4 : 2)
  expect(submissions).toBe(1)
  expect(claims).toBe(rejected ? 1 : 0)
})
