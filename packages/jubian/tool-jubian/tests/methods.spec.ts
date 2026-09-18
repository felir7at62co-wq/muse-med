import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { JubianClient, JubianLedger } from '@deepseek-ai/dsh-jubian'
import { assetMethod, catalogMethod, mediaMethod, storyboardMethod, videoMethod } from '../src/methods.ts'
import type { MethodArgs } from '../src/methods.ts'

const IMAGE_CATALOGUE = [{ id: 42, standardId: 42, modelId: 'gpt-image-2', platformId: 'YU_DIAN', unitPrice: 0.5,
  unit: '张', genTypes: [{ id: 7, type: 3 }],
  videoStandards: [{ id: 91, ratio: '16:9', resolution: '1K', width: 1280, height: 720, genNum: 1 }] }]

const STORYBOARD = { id: 916953, scriptId: 2708, isGenerate: 0, storyboardName: '第1集-分镜1',
  modelConfig: JSON.stringify({ platformId: 'YU_DIAN', modelId: 'doubao-seedance-2-0-1', standardId: 11, genType: 3,
    modelGenerationTypeId: 7, videoStandardId: 91, duration: 8, ratio: '9:16', resolution: '720p', genNum: 1,
    materialList: [], backupModelList: [] }),
  storyboardMaterialList: [] }

/** A client stub that records every request and answers from a path-keyed table. */
function stubClient(handler: (request: { method: string; path: string; body?: Record<string, unknown> }) => unknown) {
  const calls: { method: string; path: string; body?: Record<string, unknown> }[] = []
  const client = new JubianClient({ credential: async () => 'token',
    fetch: async (url: string | URL | Request, init?: RequestInit) => {
      const request = { method: String(init?.method), path: (url as URL).toString(),
        ...(typeof init?.body === 'string' ? { body: JSON.parse(init.body) as Record<string, unknown> } : {}) }
      calls.push(request)
      const data = handler(request)
      return new Response(JSON.stringify({ code: 200, data }), { status: 200 })
    } })
  return { calls, client }
}

let root: string
let ledger: JubianLedger
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'jubian-tools-'))
  ledger = new JubianLedger({ root })
})

describe('jubian_catalog reads', () => {
  it('addresses each catalogue endpoint exactly once', async () => {
    const cases: [MethodArgs, string, string, unknown][] = [
      [{ method: 'models', task_type: 2 }, 'GET', '/model/charge/getSelectList?taskType=2', []],
      [{ method: 'rate', standard_id: 42 }, 'GET', '/model/charge/42', { unitPrice: 0.5 }],
      [{ method: 'script', script_id: 2708 }, 'GET', '/aigc/script/2708', { id: 2708, name: 'x', productionType: 2 }],
      [{ method: 'episodes', script_id: 2708, page_num: 1, page_size: 20 }, 'GET',
        '/aigc/episode/list?scriptId=2708&pageNum=1&pageSize=20', { total: 0, rows: [] }],
    ]
    for (const [args, method, suffix, data] of cases) {
      const { client, calls } = stubClient(() => data)
      await catalogMethod(client, args)
      expect(calls.length).toBe(1)
      expect(calls[0]!.method).toBe(method)
      expect(calls[0]!.path.endsWith(suffix)).toBe(true)
    }
  })

  it('refuses an unsupported model task type instead of guessing one', async () => {
    const { client, calls } = stubClient(() => [])
    await expect(catalogMethod(client, { method: 'models', task_type: 9 })).rejects.toThrow()
    expect(calls.length).toBe(0)
  })
})

describe('jubian_asset reads and the side-effecting GET', () => {
  it('addresses asset and material endpoints, including the POST-shaped read', async () => {
    const cases: [MethodArgs, string, unknown][] = [
      [{ method: 'get', asset_id: 83749 }, '/aigc/asset/83749', { id: 83749, name: 'x', assetType: 1 }],
      [{ method: 'list', script_id: 2708, page_num: 1, page_size: 200 },
        '/aigc/asset/list?scriptId=2708&pageNum=1&pageSize=200', { total: 0, rows: [] }],
      [{ method: 'materials', script_id: 2708 },
        '/aigc/material/list?scriptId=2708&isUsed=1&pageNum=1&pageSize=1000', { total: 0, rows: [] }],
      [{ method: 'generated_image', asset_id: 83749 },
        '/aigc/material/getGeneratedImageByAssetId?assetId=83749', { url: 'https://x/y.png', materialId: 1 }],
    ]
    for (const [args, suffix, data] of cases) {
      const { client, calls } = stubClient(() => data)
      await assetMethod(client, ledger, args)
      expect(calls.length).toBe(1)
      expect(calls[0]!.path.endsWith(suffix)).toBe(true)
    }
  })

  it('records casting confirmation under the ledger even though the verb is GET', async () => {
    const { client, calls } = stubClient(() => null)
    const result = await assetMethod(client, ledger, { method: 'confirm_casting', idempotency_key: 'k-9',
      material_id: 900 })
    expect(calls[0]!.method).toBe('GET')
    expect(calls[0]!.path.endsWith('/aigc/material/confirm/900')).toBe(true)
    expect(result.outcome).toBe('accepted')
    expect((await ledger.find('k-9'))?.method).toBe('confirm_casting')
  })

  it('removes a parent asset with the query parameters the workbench sends', async () => {
    // Captured from the workbench: a DELETE with no body, and `scriptId` plus
    // `isParent=1` in the query. The archived contract names neither parameter,
    // so a request built from the contract alone would be refused.
    const { client, calls } = stubClient(() => null)
    const result = await assetMethod(client, ledger, { method: 'remove', idempotency_key: 'k-rm',
      asset_id: 113076, script_id: 2708 })
    expect(calls.length).toBe(1)
    expect(calls[0]!.method).toBe('DELETE')
    expect(calls[0]!.path.endsWith('/aigc/asset/removeAsset/113076?scriptId=2708&isParent=1')).toBe(true)
    expect(calls[0]!.body).toBeUndefined()
    expect(result.outcome).toBe('accepted')
    expect((await ledger.find('k-rm'))?.method).toBe('asset_remove')
    expect(String(result.next)).toContain('不可恢复')
  })

  it('refuses a removal with no idempotency key, and sends nothing', async () => {
    const { client, calls } = stubClient(() => null)
    await expect(assetMethod(client, ledger, { method: 'remove', asset_id: 1, script_id: 2708 })).rejects.toThrow()
    expect(calls.length).toBe(0)
  })
})

describe('jubian_video', () => {
  it('sends the subtask read as a POST with the parent identity in its body', async () => {
    const { client, calls } = stubClient(() => ({ total: 0, rows: [] }))
    await videoMethod(client, ledger, { method: 'subtasks', task_id: 335343 })
    expect(calls[0]!.method).toBe('POST')
    expect(calls[0]!.path.endsWith('/admin/aigc/video/task/sub/list')).toBe(true)
    expect(calls[0]!.body).toEqual({ aigcVideoTaskId: 335343 })
  })

  it('requires an idempotency key for the paid image generation and sends nothing without one', async () => {
    const { client, calls } = stubClient(request => request.path.includes('getSelectList')
      ? IMAGE_CATALOGUE : 83749)
    await expect(videoMethod(client, ledger, { method: 'image_generate', script_id: 2708,
      asset_name: '陆沉舟', asset_type: 1, prompt: '一位中年男性' })).rejects.toThrow()
    expect(calls.length).toBe(0)
  })

  it('quotes, records and settles one image generation', async () => {
    const { client, calls } = stubClient(request => request.path.includes('getSelectList')
      ? IMAGE_CATALOGUE : 83749)
    const result = await videoMethod(client, ledger, { method: 'image_generate', idempotency_key: 'k-1',
      script_id: 2708, asset_name: '陆沉舟', asset_type: 1, prompt: '一位中年男性' })
    expect(calls.length).toBe(2)
    expect(calls[1]!.method).toBe('POST')
    expect(result.outcome).toBe('accepted')
    expect(result.parent_asset_id).toBe(83749)
    const record = await ledger.find('k-1')
    expect(record?.outcome).toBe('accepted')
    expect(record?.quoted_amount).toBe('0.5')
  })

  it('never sends a second paid request for a key it already recorded', async () => {
    const first = stubClient(request => request.path.includes('getSelectList') ? IMAGE_CATALOGUE : 83749)
    const initial = await videoMethod(first.client, ledger, { method: 'image_generate', idempotency_key: 'k-2',
      script_id: 2708, asset_name: 'x', asset_type: 1, prompt: 'p' })
    expect(initial.replayed).toBe(false)
    const second = stubClient(() => IMAGE_CATALOGUE)
    const replayed = await videoMethod(second.client, ledger, { method: 'image_generate', idempotency_key: 'k-2',
      script_id: 2708, asset_name: 'x', asset_type: 1, prompt: 'p' })
    expect(second.calls.length).toBe(0)
    expect(replayed.replayed).toBe(true)
  })
})

describe('jubian_storyboard', () => {
  it('reads the snapshot with the requested identity', async () => {
    const { client, calls } = stubClient(() => STORYBOARD)
    const result = await storyboardMethod(client, ledger, { method: 'get', storyboard_id: 916953 })
    expect(calls[0]!.path.endsWith('/aigc/storyboard/916953')).toBe(true)
    expect((result.storyboard as { content_duration_ms: number }).content_duration_ms).toBe(7000)
  })

  it('saves with generation disabled and generates from the same snapshot', async () => {
    const save = stubClient(() => STORYBOARD)
    await storyboardMethod(save.client, ledger, { method: 'save', idempotency_key: 'k-3', storyboard_id: 916953 })
    expect(save.calls[1]!.method).toBe('PUT')
    expect(save.calls[1]!.body!.isGenerate).toBe(0)

    const generate = stubClient(() => STORYBOARD)
    await storyboardMethod(generate.client, ledger, { method: 'generate', idempotency_key: 'k-4',
      storyboard_id: 916953, content_duration_ms: 7000 })
    expect(generate.calls[1]!.method).toBe('PUT')
    expect(generate.calls[1]!.body!.isGenerate).toBe(1)
  })

  it('refuses to generate when the package duration disagrees with the saved snapshot, before sending', async () => {
    const { client, calls } = stubClient(() => STORYBOARD)
    await expect(storyboardMethod(client, ledger, { method: 'generate', idempotency_key: 'k-5',
      storyboard_id: 916953, content_duration_ms: 12000 })).rejects.toThrow()
    expect(calls.length).toBe(1)
  })

  it('compiles the erasure body without any catalogue read', async () => {
    const { client, calls } = stubClient(request => request.path.includes('sub/list')
      ? { total: 1, rows: [{ id: 972949, aigcVideoTaskId: 428322, taskStatus: 'succeeded', duration: 13,
        modelId: 'doubao-seedance-2-0-260128', resolution: '720p',
        resultList: [{ taskType: 1, hdCount: 0, lastTaskType: 1,
          tosVideoUrl: 'https://jubian-aigc.tos-cn-beijing.volces.com/prod/media/v.mp4' }] }] }
      : { id: 428322, taskType: 1, taskStatus: 'succeeded', episodeId: 46734, episodeCount: 1,
        taskName: 'null-第1集' })
    await storyboardMethod(client, ledger, { method: 'erase_subtitle', idempotency_key: 'k-6',
      task_id: 428322, script_id: 2708, model_id: 'quzimuToB', video_width: 720, video_height: 1280 })
    // Two reads then one submit — the selectors are pinned, so no catalogue call.
    expect(calls.length).toBe(3)
    expect(calls.some(call => call.path.includes('getSelectList'))).toBe(false)
    expect(calls[2]!.path.endsWith('/aigc/storyboard/subtitleEraser')).toBe(true)
    expect(calls[2]!.body).toMatchObject({ taskType: 10, standardId: 26, platformId: 'YU_DIAN',
      modelId: 'quzimuToB', videoStandardId: null,
      episodeId: 46734, episodeCount: 1, firstResultId: 972949, duration: 13,
      zimuLeft: 0, zimuTop: 570, zimuWidth: 719, zimuHeight: 720,
      videoWidth: 720, videoHeight: 1280 })
  })
})

describe('jubian_media', () => {
  it('writes the downloaded bytes to disk and returns the path, never the payload', async () => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64')
    const original = globalThis.fetch
    globalThis.fetch = async () => new Response(png, { status: 200 })
    const target = join(root, 'nested', 'cover.png')
    try {
      const result = await mediaMethod({ method: 'media', media_kind: 'image',
        media_url: 'https://jubian-aigc.tos-cn-beijing.volces.com/a/b.png', output_path: target })
      expect(result.path).toBe(target)
      expect(result.media_type).toBe('image/png')
      expect(result.base64).toBeUndefined()
      expect((await readFile(target)).equals(png)).toBe(true)
    } finally {
      globalThis.fetch = original
      await rm(root, { recursive: true, force: true })
    }
  })
})
