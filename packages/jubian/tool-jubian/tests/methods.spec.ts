import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { JubianClient, JubianLedger } from '@deepseek-ai/dsh-jubian'
import { assetMethod, catalogMethod, mediaMethod, resolveImageBatchOptions, storyboardMethod, videoMethod } from '../src/methods.ts'
import type { MethodArgs } from '../src/methods.ts'
import { requireArguments } from '../src/write.ts'

const IMAGE_CATALOGUE = [{ id: 42, standardId: 42, modelId: 'gpt-image-2', platformId: 'YU_DIAN', unitPrice: 0.5,
  unit: '张', genTypes: [{ id: 7, type: 3 }],
  videoStandards: [{ id: 91, ratio: '16:9', resolution: '1K', width: 1280, height: 720, genNum: 1 }] }]

// The live account catalogue lists gpt-image-2 twice: two platforms, two prices.
const MULTI_IMAGE_CATALOGUE = [
  { id: 66, modelId: 'gpt-image-2', platformId: 'KU_AI', unitPrice: 0.12, unit: '张',
    genTypes: [{ id: 7, type: 3 }],
    videoStandards: [{ id: 91, ratio: '16:9', resolution: '1K', width: 1280, height: 720, genNum: 1 }] },
  { id: 76, modelId: 'gpt-image-2', platformId: 'DUO_YUAN_TAN_SUO', unitPrice: 1.05, unit: '条',
    genTypes: [{ id: 8, type: 3 }],
    videoStandards: [{ id: 92, ratio: '16:9', resolution: '1K', width: 1280, height: 720, genNum: 1 }] },
]

/** The generated image row the endpoint really answers with: a list, `assetUrl` and `id`. */
const GENERATED_IMAGE = [{ id: 900, assetId: 83749, assetUrl: 'https://x/gen.png', hsAssetStatus: 'Active' }]

// What the provider stores on every storyboard it holds, generated or not.
const STORYBOARD = { id: 916953, scriptId: 2708, isGenerate: 1, storyboardName: '第1集-分镜1',
  modelConfig: JSON.stringify({ platformId: 'YU_DIAN', modelId: 'doubao-seedance-2-0-260128', standardId: 11, genType: 3,
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
      const data = await handler(request)
      return new Response(JSON.stringify({ code: 200, data }), { status: 200 })
    } })
  return { calls, client }
}

let root: string
let ledger: JubianLedger
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'jubian-tools-'))
  ledger = new JubianLedger({ root })
  await writeFile(join(root, 'authorization.json'), JSON.stringify({ version: 1, projects: {
    '2708': { limit: '1000', unit: 'CNY', estimates: {
      image_generate: '1', storyboard_generate: '1', erase_subtitle: '1', video_upscale: '1',
    } },
  } }))
})

/** A provider stub for the paid image path, with a scripted sequence of asset statuses. */
function imageProvider(catalogue: unknown = IMAGE_CATALOGUE, statuses: string[] = ['Active']) {
  let reads = 0
  return stubClient((request) => {
    if (request.path.includes('getSelectList')) return catalogue
    if (request.path.includes('getGeneratedImageByAssetId')) return GENERATED_IMAGE
    if (request.method === 'GET' && request.path.includes('/aigc/asset/')) {
      const status = statuses[Math.min(reads, statuses.length - 1)]
      reads += 1
      return { id: 83749, name: '陆沉舟', assetType: 1, hsLocal: 0, hsAssetStatus: status }
    }
    return 83749
  })
}

/** Readback seams that advance instantly, so a poll loop costs no wall clock. */
function imageDeps(
  image: { selection?: { platformId?: string; standardId?: number }; timeoutMs?: number; pollMs?: number } = {},
) {
  const clock = { value: 0 }
  return { image: {
    ...(image.selection === undefined ? {} : { selection: image.selection }),
    activeTimeoutMs: image.timeoutMs ?? 180_000,
    pollIntervalMs: image.pollMs ?? 100,
    now: (): number => clock.value,
    sleep: async (ms: number): Promise<void> => { clock.value += ms },
  } }
}

describe('jubian_video resolution guidance', () => {
  it.each([undefined, '1080p'])('keeps %s resolution hints separate from paid authorization', async (target) => {
    const { client, calls } = stubClient(() => ({ total: 3, rows: [
      { id: 1, resolution: '720p' }, { id: 2, resolution: '1080p' }, { id: 3 },
    ] }))
    try {
      const result = await videoMethod(client, ledger, { method: 'subtasks', task_id: 42,
        ...(target === undefined ? {} : { delivery_resolution: target }) })
      expect((result.subtasks as { rows: { needs_upscale: boolean | null }[] }).rows.map(row => row.needs_upscale))
        .toEqual(target === undefined ? [null, null, null] : [true, false, null])
      expect(result.guidance).toContain('仅提示实际分辨率低于交付尺寸，不是内容不可用判定，也不构成付费义务')
      expect(result.guidance).toContain('SD2.5 默认使用原片，不自动提交或等待高清')
      expect(result.guidance).toContain('任何模型都不能仅因 needs_upscale=true 自动付费')
      expect(result.guidance).toContain('仅在用户明确要求或授权具体高清处理时调用 upscale（包括 SD2.5）')
      expect(result.guidance).toContain('普通导出尺寸与真实源分辨率须分别如实报告')
      expect(result.guidance).not.toContain('必须先转高清才能使用')
      expect(calls).toHaveLength(1)
      expect(calls[0]?.path).toContain('/admin/aigc/video/task/sub/list')
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})

describe('jubian_video upscale', () => {
  it('posts the workbench HD conversion body once under the same ledger key', async () => {
    const { client, calls } = stubClient((request) => {
      if (request.method === 'GET') return { id: 42, scriptId: 2708, episodeId: 46744, episodeCount: 1 }
      if (request.path.endsWith('/sub/list')) return { total: 1, rows: [{ id: 990,
        aigcVideoTaskId: 42, duration: 13.5, firstResultId: 1007193, parentResultId: 1007193,
        resultList: [{ tosVideoUrl: 'https://example.test/source.mp4' }] }] }
      return 429001
    })
    try {
      const args = { method: 'upscale', task_id: 42, task_name: 'EP11-P1-HD', idempotency_key: 'hd-once' }
      expect(await videoMethod(client, ledger, args)).toMatchObject({ outcome: 'accepted', accepted_task_id: '429001' })
      expect(calls[2]).toEqual({ method: 'POST',
        path: 'https://web.jubianai.net/prod-api/aigc/storyboard/hdConversion',
        body: { scriptId: 2708, episodeId: 46744, episodeCount: 1,
          firstResultId: 1007193, parentResultId: 1007193, duration: 13.5,
          taskName: 'EP11-P1-HD', taskType: 20, modelId: '2074071626416742401',
          platformId: 'RUNNING_HUB', standardId: 55, videoStandardId: 303,
          videoUrl: 'https://example.test/source.mp4' } })
      expect(await videoMethod(client, new JubianLedger({ root }), args)).toMatchObject({ replayed: true })
      expect(calls).toHaveLength(3)
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('does not resend an unknown upscale recorded before the route repair', async () => {
    const { client, calls } = stubClient(() => { throw new Error('must not send') })
    try {
      await ledger.begin({ idempotencyKey: 'old-route', method: 'video_upscale', requestSha256: 'sha256:old' })
      await ledger.settle('old-route', { httpStatus: null, applicationCode: null,
        responseSha256: null, outcome: 'unknown' })
      expect(await videoMethod(client, new JubianLedger({ root }), {
        method: 'upscale', task_id: 42, idempotency_key: 'old-route',
      })).toMatchObject({ replayed: true, outcome: 'unknown', accepted_task_id: null })
      expect(calls).toHaveLength(0)
    } finally { await rm(root, { recursive: true, force: true }) }
  })
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

  it('reads the provider scriptName through the public catalogue tool without extra requests', async () => {
    const { client, calls } = stubClient(() => ({ id: 2708, scriptName: '山海自有相逢处',
      privateToken: 'must-not-leak' }))
    const result = await catalogMethod(client, { method: 'script', script_id: 2708 })
    expect(result).toEqual({ script: { script_id: 2708, name: '山海自有相逢处', production_type: null } })
    expect(JSON.stringify(result)).not.toContain('must-not-leak')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.method).toBe('GET')
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
        '/aigc/material/getGeneratedImageByAssetId?assetId=83749',
        [{ id: 1, assetUrl: 'https://x/y.png', hsAssetStatus: 'Active' }]],
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
    const { client, calls } = imageProvider()
    await expect(videoMethod(client, ledger, { method: 'image_generate', script_id: 2708,
      asset_name: '陆沉舟', asset_type: 1, prompt: '一位中年男性' })).rejects.toThrow()
    expect(calls.length).toBe(0)
  })

  it('rejects an unknown asset category even when asset_type is valid', async () => {
    const { client, calls } = imageProvider()
    await expect(videoMethod(client, ledger, { method: 'image_generate', script_id: 2708,
      idempotency_key: 'invalid-category', asset_name: '陆沉舟', asset_category: '未知' as '角色',
      asset_type: 1, prompt: '一位中年男性' }, imageDeps())).rejects.toThrow(/asset_category/u)
    expect(calls).toEqual([])
    expect(await ledger.records()).toEqual([])
  })

  const batchItem = (key: string, name: string) => ({
    idempotency_key: key, asset_name: name, asset_category: '角色' as const,
    episode: '01', prompt: `角色 ${name}`,
  })

  it('prechecks every batch item and refuses duplicate keys or targets before any provider read', async () => {
    const { client, calls } = imageProvider()
    for (const items of [
      [batchItem('a', '甲'), { ...batchItem('b', '乙'), prompt: '' }],
      [batchItem('a', '甲'), batchItem('a', '乙')],
      [batchItem('a', '甲'), batchItem('b', '甲')],
      [batchItem('a', '甲'), { ...batchItem('b', '乙'), parent_asset_id: 9 },
        { ...batchItem('c', '丙'), parent_asset_id: 9 }],
    ]) {
      await expect(videoMethod(client, ledger, { method: 'image_generate_batch', script_id: 2708,
        items })).rejects.toThrow()
    }
    expect(calls).toEqual([])
    expect(await ledger.records()).toEqual([])
  })

  it.each([
    ['control character in the second prompt', { prompt: '镜头\u0000服装' }],
    ['malformed Unicode in the second name', { asset_name: '\ud800' }],
    ['padded platform in the second item', { image_platform_id: ' YU_DIAN ' }],
  ])('refuses a %s before the first paid item starts', async (_reason, change) => {
    const { client, calls } = imageProvider()
    await expect(videoMethod(client, ledger, { method: 'image_generate_batch', script_id: 2708,
      items: [batchItem('local-a', '甲'), { ...batchItem('local-b', '乙'), ...change }] },
    { ...imageDeps(), imageBatch: { concurrency: 1, maxItems: 3 } })).rejects.toThrow(/items\[1\]/u)
    expect(calls).toEqual([])
    expect(await ledger.records()).toEqual([])
  })

  it('checks every selected image model row before submitting any paid batch item', async () => {
    const { client, calls } = imageProvider()
    await expect(videoMethod(client, ledger, { method: 'image_generate_batch', script_id: 2708,
      items: [batchItem('model-a', '甲'), { ...batchItem('model-b', '乙'), image_platform_id: 'OTHER' }] },
    { ...imageDeps(), imageBatch: { concurrency: 1, maxItems: 3 } })).rejects.toThrow()
    expect(calls.filter(call => call.method === 'POST')).toEqual([])
    expect(await ledger.records()).toEqual([])
  })

  it('keeps the batch concurrency bounded and returns each result in input order', async () => {
    let inFlight = 0
    let peak = 0
    let accepted = 0
    let release!: () => void
    const firstWave = new Promise<void>((resolve) => { release = resolve })
    const { client, calls } = stubClient(async (request) => {
      if (request.path.includes('getSelectList')) return IMAGE_CATALOGUE
      if (request.method === 'POST' && request.path.endsWith('/aigc/asset')) {
        inFlight += 1
        peak = Math.max(peak, inFlight)
        const id = 83749 + accepted++
        if (inFlight === 2) release()
        await firstWave
        inFlight -= 1
        return id
      }
      if (request.path.includes('getGeneratedImageByAssetId')) {
        const id = Number(new URL(request.path).searchParams.get('assetId'))
        return [{ id: id + 1000, assetId: id, assetUrl: `https://x/${id}.png`, hsAssetStatus: 'Active' }]
      }
      if (request.method === 'GET' && request.path.includes('/aigc/asset/')) {
        const id = Number(request.path.split('/').at(-1))
        return { id, name: 'asset', assetType: 1, hsLocal: 0, hsAssetStatus: 'Active' }
      }
      return null
    })
    const result = await videoMethod(client, ledger, { method: 'image_generate_batch', script_id: 2708,
      items: [batchItem('batch-a', '甲'), batchItem('batch-b', '乙'), batchItem('batch-c', '丙')]
        .map(item => ({ ...item, references: ['https://example.test/confirmed-identity.png'] })) },
    { ...imageDeps(), imageBatch: { concurrency: 2, maxItems: 3 } })
    expect(peak).toBe(2)
    expect(calls.filter(request => request.path.includes('getSelectList'))).toHaveLength(1)
    expect(calls.filter(request => request.method === 'POST')).toHaveLength(3)
    expect(calls.filter(request => request.method === 'POST').map(request =>
      (JSON.parse(String(request.body?.modelConfig)) as { materialList: unknown }).materialList))
      .toEqual(Array.from({ length: 3 }, () => [{ materialUrl: 'https://example.test/confirmed-identity.png',
        materialType: 'image', sortOrder: 1 }]))
    expect(result.results).toMatchObject([
      { idempotency_key: 'batch-a', status: 'returned', outcome: 'accepted' },
      { idempotency_key: 'batch-b', status: 'returned', outcome: 'accepted' },
      { idempotency_key: 'batch-c', status: 'returned', outcome: 'accepted' },
    ])
    expect(result).toMatchObject({ returned: 3, errors: 0 })
    expect((await ledger.records()).filter(record => record.outcome === 'accepted')).toHaveLength(3)
  })

  it('uses the shared ledger to refuse an unapproved overlapping charge', async () => {
    await writeFile(join(root, 'authorization.json'), JSON.stringify({ version: 1, projects: {
      '2708': { limit: '0.5', unit: 'CNY', estimates: { image_generate: '0.5' } },
    } }))
    const { client, calls } = imageProvider()
    const result = await videoMethod(client, ledger, { method: 'image_generate_batch', script_id: 2708,
      items: [batchItem('budget-a', '甲'), batchItem('budget-b', '乙')] },
    { ...imageDeps(), imageBatch: { concurrency: 2, maxItems: 3 } })
    expect(calls.filter(request => request.method === 'POST')).toHaveLength(1)
    expect((result.results as Array<{ outcome: string }>).map(row => row.outcome).sort())
      .toEqual(['accepted', 'not_sent'])
    expect(await ledger.records()).toHaveLength(1)
  })

  it('submits every accepted item before long image readbacks occupy the concurrency slots', async () => {
    let posted = 0
    const { client, calls } = stubClient((request) => {
      if (request.path.includes('getSelectList')) return IMAGE_CATALOGUE
      if (request.method === 'POST' && request.path.endsWith('/aigc/asset')) return 83749 + posted++
      if (request.method === 'GET' && request.path.includes('/aigc/asset/')) {
        const id = Number(request.path.split('/').at(-1))
        return { id, name: 'asset', assetType: 1, hsLocal: 0,
          hsAssetStatus: posted === 3 ? 'Active' : 'Submitted' }
      }
      if (request.path.includes('getGeneratedImageByAssetId')) {
        const id = Number(new URL(request.path).searchParams.get('assetId'))
        return [{ id: id + 1000, assetId: id, assetUrl: `https://x/${id}.png`, hsAssetStatus: 'Active' }]
      }
      return null
    })
    const result = await videoMethod(client, ledger, { method: 'image_generate_batch', script_id: 2708,
      items: [batchItem('submit-a', '甲'), batchItem('submit-b', '乙'), batchItem('submit-c', '丙')] },
    { ...imageDeps({ timeoutMs: 300, pollMs: 100 }), imageBatch: { concurrency: 2, maxItems: 3 } })
    expect(calls.filter(call => call.method === 'POST')).toHaveLength(3)
    expect(result.results).toMatchObject([
      { status: 'returned', asset_status: 'active' },
      { status: 'returned', asset_status: 'active' },
      { status: 'returned', asset_status: 'active' },
    ])
  })

  it('records an ambiguous item and never resends it when the batch is replayed', async () => {
    const { client, calls } = stubClient((request) => {
      if (request.path.includes('getSelectList')) return IMAGE_CATALOGUE
      if (request.method === 'POST' && request.body?.assetName === 'EP01｜角色｜甲') {
        throw new Error('connection ended after submit')
      }
      if (request.method === 'POST') return 83749
      if (request.path.includes('getGeneratedImageByAssetId')) return GENERATED_IMAGE
      return { id: 83749, name: '乙', assetType: 1, hsLocal: 0, hsAssetStatus: 'Active' }
    })
    const args = { method: 'image_generate_batch', script_id: 2708,
      items: [batchItem('unknown-a', '甲'), batchItem('known-b', '乙')] }
    const first = await videoMethod(client, ledger, args, { ...imageDeps(),
      imageBatch: { concurrency: 2, maxItems: 3 } })
    expect(first.results).toMatchObject([
      { idempotency_key: 'unknown-a', status: 'error', outcome: 'unknown' },
      { idempotency_key: 'known-b', status: 'returned', outcome: 'accepted' },
    ])
    expect((await ledger.find('unknown-a'))?.outcome).toBe('unknown')
    const paidCalls = calls.filter(call => call.method === 'POST').length
    const replayed = await videoMethod(client, ledger, args, { ...imageDeps(),
      imageBatch: { concurrency: 2, maxItems: 3 } })
    expect(calls.filter(call => call.method === 'POST')).toHaveLength(paidCalls)
    expect(replayed.results).toMatchObject([
      { idempotency_key: 'unknown-a', replayed: true, outcome: 'unknown', asset_status: 'replayed' },
      { idempotency_key: 'known-b', replayed: true, outcome: 'accepted', asset_status: 'replayed' },
    ])
  })

  it('keeps the accepted asset ID when readback fails after a paid request', async () => {
    const { client, calls } = stubClient((request) => {
      if (request.path.includes('getSelectList')) return IMAGE_CATALOGUE
      if (request.method === 'POST' && request.path.endsWith('/aigc/asset')) return 83749
      if (request.method === 'GET' && request.path.includes('/aigc/asset/')) {
        throw new Error('asset readback unavailable')
      }
      return null
    })
    const result = await videoMethod(client, ledger, { method: 'image_generate_batch', script_id: 2708,
      items: [batchItem('accepted-readback', '甲')] }, { ...imageDeps(),
      imageBatch: { concurrency: 1, maxItems: 3 } })
    expect(result.results).toMatchObject([{ idempotency_key: 'accepted-readback', status: 'returned',
      outcome: 'accepted', parent_asset_id: 83749, asset_status: 'unverified' }])
    expect((result.results as Array<{ readback_error: string }>)[0]?.readback_error)
      .toContain('资产 ID 为 83749，但回读失败')
    expect(calls.filter(call => call.method === 'POST')).toHaveLength(1)
  })

  it.each([
    ['another project', 2709, batchItem('reuse-key', '甲')],
    ['another asset', 2708, batchItem('reuse-key', '乙')],
    ['another prompt', 2708, { ...batchItem('reuse-key', '甲'), prompt: '另一套提示词' }],
  ])('refuses a prior image key used for %s instead of attributing it to this item', async (_reason, scriptId, item) => {
    const { client, calls } = imageProvider()
    await videoMethod(client, ledger, { method: 'image_generate', script_id: 2708,
      ...batchItem('reuse-key', '甲') }, imageDeps())
    const paidCalls = calls.filter(call => call.method === 'POST').length
    const result = await videoMethod(client, ledger, { method: 'image_generate_batch', script_id: scriptId,
      items: [item] }, { ...imageDeps(), imageBatch: { concurrency: 1, maxItems: 3 } })
    expect(result.results).toMatchObject([{ status: 'error', idempotency_key: 'reuse-key',
      record_script_id: 2708 }])
    expect((result.results as Array<{ error: string }>)[0]?.error).toMatch(/different write|different image request/u)
    expect(calls.filter(call => call.method === 'POST')).toHaveLength(paidCalls)
  })

  it('rejects a batch larger than the configured bound before any provider read', async () => {
    const { client, calls } = imageProvider()
    await expect(videoMethod(client, ledger, { method: 'image_generate_batch', script_id: 2708,
      items: [batchItem('a', '甲'), batchItem('b', '乙'), batchItem('c', '丙')] },
    { imageBatch: { concurrency: 2, maxItems: 2 } })).rejects.toThrow(/1\.\.2/u)
    expect(calls).toEqual([])
  })

  it('validates deployment batch limits', () => {
    expect(resolveImageBatchOptions()).toEqual({ concurrency: 3, maxItems: 12 })
    expect(() => resolveImageBatchOptions({ imageBatchConcurrency: 0 })).toThrow(/imageBatchConcurrency/u)
    expect(() => resolveImageBatchOptions({ imageBatchConcurrency: 9 })).toThrow(/imageBatchConcurrency/u)
    expect(() => resolveImageBatchOptions({ imageBatchMaxItems: 101 })).toThrow(/imageBatchMaxItems/u)
  })

  it('quotes, records, settles, then reads the asset back until it is Active', async () => {
    const { client, calls } = imageProvider()
    const result = await videoMethod(client, ledger, { method: 'image_generate', idempotency_key: 'k-1',
      script_id: 2708, asset_name: '陆沉舟', asset_type: 1, prompt: '一位中年男性' }, imageDeps())
    // Catalogue, the one paid write, the asset status read, then the generated image.
    expect(calls.map(call => call.method)).toEqual(['GET', 'POST', 'GET', 'GET'])
    expect(calls[1]!.path.endsWith('/aigc/asset')).toBe(true)
    expect(calls[3]!.path).toContain('getGeneratedImageByAssetId?assetId=83749')
    expect(result.outcome).toBe('accepted')
    expect(result.parent_asset_id).toBe(83749)
    expect(result.asset_status).toBe('active')
    expect(result.material_id).toBe(900)
    expect(result.image_url).toBe('https://x/gen.png')
    const record = await ledger.find('k-1')
    expect(record?.outcome).toBe('accepted')
    expect(record?.quoted_amount).toBe('0.5')
  })

  it('polls a pending asset instead of returning an accepted asset with no image', async () => {
    const { client, calls } = imageProvider(IMAGE_CATALOGUE, ['Pending', 'Pending', 'Active'])
    const result = await videoMethod(client, ledger, { method: 'image_generate', idempotency_key: 'k-poll',
      script_id: 2708, asset_name: 'x', asset_type: 1, prompt: 'p' }, imageDeps())
    expect(result.asset_status).toBe('active')
    expect(result.material_id).toBe(900)
    expect(calls.filter(call => call.path.includes('/aigc/asset/')).length).toBe(3)
  })

  it('reports a readback timeout explicitly and never resends the paid write', async () => {
    const { client, calls } = imageProvider(IMAGE_CATALOGUE, ['Pending'])
    const result = await videoMethod(client, ledger, { method: 'image_generate', idempotency_key: 'k-timeout',
      script_id: 2708, asset_name: 'x', asset_type: 1, prompt: 'p' }, imageDeps({ timeoutMs: 1000, pollMs: 100 }))
    expect(result.asset_status).toBe('timeout')
    expect(result.material_id).toBeNull()
    expect(result.image_url).toBeNull()
    expect(String(result.readback_error)).toContain('回读超时')
    expect(String(result.readback_error)).toContain('Active')
    expect(String(result.next)).toContain('不要换 key 重投')
    expect(calls.filter(call => call.method === 'POST').length).toBe(1)
    expect((await ledger.find('k-timeout'))?.outcome).toBe('accepted')
  })

  it('refuses to buy from one of several gpt-image-2 rows and sends no request', async () => {
    const { client, calls } = imageProvider(MULTI_IMAGE_CATALOGUE)
    await expect(videoMethod(client, ledger, { method: 'image_generate', idempotency_key: 'k-multi',
      script_id: 2708, asset_name: 'x', asset_type: 1, prompt: 'p' }, imageDeps()))
      .rejects.toThrow(/KU_AI.*DUO_YUAN_TAN_SUO|DUO_YUAN_TAN_SUO.*KU_AI/)
    expect(calls.filter(call => call.method === 'POST').length).toBe(0)
    // The refusal happens while the body is compiled, so the ledger records nothing either.
    expect(await ledger.find('k-multi')).toBeUndefined()
  })

  it('buys from the pinned row and echoes which row the price belongs to', async () => {
    const { client, calls } = imageProvider(MULTI_IMAGE_CATALOGUE)
    const result = await videoMethod(client, ledger, { method: 'image_generate', idempotency_key: 'k-pin',
      script_id: 2708, asset_name: 'x', asset_type: 1, prompt: 'p' },
    imageDeps({ selection: { platformId: 'KU_AI' } }))
    const config = JSON.parse(calls[1]!.body!.modelConfig as string) as Record<string, unknown>
    expect(config).toMatchObject({ standardId: 66, platformId: 'KU_AI', videoStandardId: 91 })
    expect(result.model_selection).toEqual({ standard_id: 66, platform_id: 'KU_AI' })
    // 0.12 is the pinned platform's price; 1.05 belongs to the other row.
    expect((await ledger.find('k-pin'))?.quoted_amount).toBe('0.12')
  })

  it('uses a requested backup platform for one paid image without changing the primary selection', async () => {
    const { client, calls } = imageProvider(MULTI_IMAGE_CATALOGUE)
    const result = await videoMethod(client, ledger, { method: 'image_generate', idempotency_key: 'k-backup',
      script_id: 2708, asset_name: 'x', asset_type: 1, prompt: 'p', image_platform_id: 'DUO_YUAN_TAN_SUO' },
    imageDeps({ selection: { platformId: 'KU_AI' } }))
    const config = JSON.parse(calls[1]!.body!.modelConfig as string) as Record<string, unknown>
    expect(config).toMatchObject({ standardId: 76, platformId: 'DUO_YUAN_TAN_SUO', videoStandardId: 92 })
    expect(result.model_selection).toEqual({ standard_id: 76, platform_id: 'DUO_YUAN_TAN_SUO' })
    expect((await ledger.find('k-backup'))?.quoted_amount).toBe('1.05')
  })

  it('never sends a second paid request for a key it already recorded', async () => {
    const first = imageProvider()
    const initial = await videoMethod(first.client, ledger, { method: 'image_generate', idempotency_key: 'k-2',
      script_id: 2708, asset_name: 'x', asset_type: 1, prompt: 'p' }, imageDeps())
    expect(initial.replayed).toBe(false)
    const second = stubClient(() => IMAGE_CATALOGUE)
    const replayed = await videoMethod(second.client, ledger, { method: 'image_generate', idempotency_key: 'k-2',
      script_id: 2708, asset_name: 'x', asset_type: 1, prompt: 'p' }, imageDeps())
    expect(second.calls.map(call => call.method)).toEqual(['GET'])
    expect(replayed.replayed).toBe(true)
    expect(replayed.asset_status).toBe('replayed')
    expect(replayed.material_id).toBeNull()
  })

  it.each([
    ['another project', 2709, 'x', 'p'],
    ['another asset', 2708, 'y', 'p'],
    ['another prompt', 2708, 'x', 'different'],
  ])('rejects a direct image key reused for %s without a second paid request', async (_reason, scriptId, name, prompt) => {
    const { client, calls } = imageProvider()
    await videoMethod(client, ledger, { method: 'image_generate', script_id: 2708,
      idempotency_key: 'direct-reuse', asset_name: 'x', asset_type: 1, prompt: 'p' }, imageDeps())
    const paidCalls = calls.filter(call => call.method === 'POST').length
    await expect(videoMethod(client, ledger, { method: 'image_generate', script_id: scriptId,
      idempotency_key: 'direct-reuse', asset_name: name, asset_type: 1, prompt }, imageDeps()))
      .rejects.toThrow(/different image request/u)
    expect(calls.filter(call => call.method === 'POST')).toHaveLength(paidCalls)
  })
})

describe('jubian_storyboard', () => {
  it('reads the snapshot with the requested identity', async () => {
    const { client, calls } = stubClient(() => STORYBOARD)
    const result = await storyboardMethod(client, ledger, { method: 'get', storyboard_id: 916953 })
    expect(calls[0]!.path.endsWith('/aigc/storyboard/916953')).toBe(true)
    expect((result.storyboard as { content_duration_ms: number }).content_duration_ms).toBe(7000)
  })

  it('creates from a frozen JSON body file', async () => {
    const bodyPath = join(root, 'storyboard.json')
    await writeFile(bodyPath, JSON.stringify({ scriptId: 2708, episodeCount: 4, isGenerate: 0 }))
    const { client, calls } = stubClient(() => 1572762)
    await storyboardMethod(client, ledger, { method: 'create', idempotency_key: 'k-file', body_path: bodyPath })
    expect(calls[0]).toMatchObject({ method: 'POST', body: { scriptId: 2708, episodeCount: 4, isGenerate: 0 } })
  })

  it.each(['inline', 'file'])('creates without generation even when the %s input requests it', async (mode) => {
    const body = { scriptId: 2708, episodeCount: 4, isGenerate: 1, content: 'preserve this prompt' }
    const bodyPath = join(root, 'requested-generation.json')
    await writeFile(bodyPath, JSON.stringify(body))
    const { client, calls } = stubClient(() => 1572762)
    await storyboardMethod(client, ledger, { method: 'create', idempotency_key: `free-${mode}`,
      ...(mode === 'file' ? { body_path: bodyPath } : { body }) })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ method: 'POST', body: { ...body, isGenerate: 0 } })
    expect(body.isGenerate).toBe(1)
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

  it('reads the storyboard but never submits paid generation without a project grant', async () => {
    await rm(join(root, 'authorization.json'))
    const { client, calls } = stubClient(() => STORYBOARD)
    await expect(storyboardMethod(client, ledger, { method: 'generate', idempotency_key: 'ungranted',
      storyboard_id: 916953, content_duration_ms: 7000 })).rejects.toThrow('authorization.json')
    expect(calls.map(call => call.method)).toEqual(['GET'])
    expect(await ledger.records()).toEqual([])
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
    const result = await storyboardMethod(client, ledger, { method: 'erase_subtitle', idempotency_key: 'k-6',
      task_id: 428322, script_id: 2708, model_id: 'quzimuToB', video_width: 720, video_height: 1280 })
    expect(result.next).toContain('subtitle_erased=true')
    expect(result.next).not.toContain('last_task_type=10')
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

  it('reads the project from the task row, so erase_subtitle needs no script_id', async () => {
    // Regression: the description promised "task_id and the frame size" while the
    // body demanded script_id, so a caller following the description failed with a
    // bare CONTRACT_CHANGED and no request ever left.
    const { client, calls } = stubClient(request => request.path.includes('sub/list')
      ? { total: 1, rows: [{ id: 972949, aigcVideoTaskId: 428322, taskStatus: 'succeeded', duration: 13,
        modelId: 'doubao-seedance-2-0-260128', resolution: '720p',
        resultList: [{ taskType: 1, hdCount: 0, lastTaskType: 1,
          tosVideoUrl: 'https://jubian-aigc.tos-cn-beijing.volces.com/prod/media/v.mp4' }] }] }
      : { id: 428322, taskType: 1, taskStatus: 'succeeded', scriptId: 2708, episodeId: 46734,
        episodeCount: 1, taskName: 'null-第1集' })
    await storyboardMethod(client, ledger, { method: 'erase_subtitle', idempotency_key: 'k-6b',
      task_id: 428322, model_id: 'quzimuToB', video_width: 720, video_height: 1280 })
    expect(calls.length).toBe(3)
    expect(calls[2]!.path.endsWith('/aigc/storyboard/subtitleEraser')).toBe(true)
    expect(calls[2]!.body).toMatchObject({ scriptId: 2708 })
  })

  it('refuses an erasure with no model rather than defaulting to one', async () => {
    const { client, calls } = stubClient(request => request.path.includes('sub/list')
      ? { total: 1, rows: [{ id: 972949, aigcVideoTaskId: 428322, taskStatus: 'succeeded', duration: 13,
        modelId: 'doubao-seedance-2-0-260128', resolution: '720p',
        resultList: [{ taskType: 1, hdCount: 0, lastTaskType: 1,
          tosVideoUrl: 'https://jubian-aigc.tos-cn-beijing.volces.com/prod/media/v.mp4' }] }] }
      : { id: 428322, taskType: 1, taskStatus: 'succeeded', scriptId: 2708, episodeId: 46734,
        episodeCount: 1, taskName: 'null-第1集' })
    await expect(storyboardMethod(client, ledger, { method: 'erase_subtitle', idempotency_key: 'k-6c',
      task_id: 428322, video_width: 720, video_height: 1280 })).rejects.toThrow(/model_id/)
    expect(calls.some(call => call.path.includes('subtitleEraser'))).toBe(false)
  })
})

describe('required arguments', () => {
  it('names the missing argument and lets nothing reach the transport', () => {
    // The schema is one object per tool, so it cannot say "required for this
    // method only"; this check is what turns that into an actionable failure.
    expect(() => {
      requireArguments('jubian_storyboard',
        { method: 'erase_subtitle', task_id: 1, model_id: 'quzimuToB', video_width: 720 })
    }).toThrow(/jubian_storyboard erase_subtitle requires video_height/)
    expect(() => {
      requireArguments('jubian_catalog', { method: 'script' })
    }).toThrow(/jubian_catalog script requires script_id/)
  })

  it('accepts a method whose derived arguments are absent from the call', () => {
    expect(() => {
      requireArguments('jubian_storyboard',
        { method: 'erase_subtitle', task_id: 1, model_id: 'quzimuToB', video_width: 720, video_height: 1280 })
    }).not.toThrow()
    expect(() => {
      requireArguments('jubian_video', { method: 'upscale', task_id: 1 })
    }).not.toThrow()
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
