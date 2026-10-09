import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { JubianClient, JubianError, JubianLedger } from '@deepseek-ai/dsh-jubian'
import { assetMethod, catalogMethod, mediaMethod, resolveImageBatchOptions, resolveStoryboardBatchOptions, storyboardMethod, videoMethod } from '../src/methods.ts'
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

const PORTRAIT_IMAGE_CATALOGUE = [{ id: 66, modelId: 'gpt-image-2', platformId: 'KU_AI',
  unitPrice: 0.12, unit: '张', genTypes: [{ id: 7, type: 3 }], videoStandards: [
    { id: 91, ratio: '16:9', resolution: '1K', width: 1280, height: 720, genNum: 1 },
    { id: 93, ratio: '9:16', resolution: '1K', width: 720, height: 1280, genNum: 1 },
  ] }]

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
      return data instanceof Response ? data : new Response(JSON.stringify({ code: 200, data }), { status: 200 })
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
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

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
  it.each([{ page_num: 0 }, { page_num: 1.5 }, { page_size: 0 }, { page_size: 1001 }])
  ('rejects invalid pagination before a provider read %j', async (pagination) => {
    const { client, calls } = stubClient(() => ({ rows: [] }))
    await expect(catalogMethod(client, { method: 'episodes', script_id: 2708, ...pagination })).rejects.toThrow('page_num')
    expect(calls).toEqual([])
  })

  it('uses the default episode page and rejects unrelated methods', async () => {
    const { client, calls } = stubClient(() => ({ rows: [] }))
    await catalogMethod(client, { method: 'episodes', script_id: 2708 })
    expect(calls[0]?.path).toContain('pageNum=1&pageSize=20')
    await expect(catalogMethod(client, { method: 'get' })).rejects.toThrow()
    expect(calls).toHaveLength(1)
  })
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
    expect(result).toEqual({ script: { script_id: 2708, name: '山海自有相逢处', production_type: null, project_settings: {} } })
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
  it('reads an audio asset through the category-specific dispatch without mutating the provider', async () => {
    const { client, calls } = stubClient(() => ({ id: 77, scriptId: 2708, assetType: 4,
      assetName: 'voice', assetUrl: 'https://media.example/voice.wav', isLocal: 1 }))
    expect(await assetMethod(client, ledger, { method: 'audio_get', script_id: 2708, asset_id: 77 }))
      .toMatchObject({ asset: { asset_id: 77, asset_type: 4 } })
    expect(calls.map(call => call.method)).toEqual(['GET'])
  })

  it.each([undefined, 'voice'])('lists audio with the optional name filter %s', async (asset_name) => {
    const { client, calls } = stubClient(() => ({ rows: [], total: 0 }))
    expect(await assetMethod(client, ledger, { method: 'audio_list', script_id: 2708,
      ...(asset_name === undefined ? {} : { asset_name }) })).toMatchObject({ assets: [], complete: true })
    expect(calls[0]?.path.includes('assetName=voice')).toBe(asset_name !== undefined)
  })

  it('rejects an empty audio upload path before any transport call', async () => {
    const { client, calls } = stubClient(() => null)
    await expect(assetMethod(client, ledger, { method: 'upload_audio', audio_path: ' ' }))
      .rejects.toThrow('audio_path')
    expect(calls).toEqual([])
  })

  it('dispatches reference-image upload refusal before any account or object request', async () => {
    const { client, calls } = stubClient(() => null)
    const transport = vi.fn<typeof fetch>()
    await expect(assetMethod(client, ledger, { method: 'upload_reference', image_path: join(root, 'missing.png') },
      { reference: { fetch: transport } })).rejects.toThrow(JubianError)
    expect(calls).toEqual([])
    expect(transport).not.toHaveBeenCalled()
  })

  it.each(['audio_delete_preview', 'register'])('uses the default complete-reference bounds for audio %s', async (method) => {
    await writeFile(join(root, 'project_config.json'), JSON.stringify({ jubian_script_id: 2708 }))
    const { client, calls } = stubClient(request => request.path.includes('/asset/77')
      ? { id: 77, scriptId: 2708, assetType: 4, assetName: 'voice', assetUrl: 'https://media.example/voice.wav', isLocal: 1 }
      : request.path.includes('selectNoPage') ? [] : { rows: [], total: 0 })
    if (method === 'register') {
      await expect(assetMethod(client, ledger, { method, script_id: 2708, asset_name: ' ', asset_type: 4,
        asset_url: 'https://media.example/voice.wav', idempotency_key: 'register-default-bounds' })).rejects.toThrow('asset_name')
    } else {
      expect(await assetMethod(client, ledger, { method, project_dir: root, script_id: 2708, asset_id: 77,
        delete_reason: 'User approved unused voice cleanup', authorization_basis: 'User approved removing audio asset 77' }))
        .toMatchObject({ status: 'inspection_required', references: { characters: [], storyboards: [], complete: true } })
    }
    expect(calls.some(call => call.method !== 'GET')).toBe(false)
  })
  it.each([{ id: 113077, scriptId: 2708, assetType: 1 }, { id: 113076, scriptId: 2709, assetType: 1 },
    { id: 113076, scriptId: 2708, assetType: null }, { id: 113076, scriptId: 2708, assetType: 4 }])
  ('refuses removal when live project, identity or category disagrees %j', async (asset) => {
    const { client, calls } = stubClient(() => asset)
    await expect(assetMethod(client, ledger, { method: 'remove', idempotency_key: 'remove-mismatch',
      asset_id: 113076, script_id: 2708 })).rejects.toThrow()
    expect(calls.map(call => call.method)).toEqual(['GET'])
    expect(await ledger.records()).toEqual([])
  })

  it('replays a recorded removal without reading or deleting the asset again', async () => {
    const { client, calls } = stubClient(() => ({ id: 113076, scriptId: 2708, assetType: 1 }))
    const args = { method: 'remove', idempotency_key: 'remove-once', asset_id: 113076, script_id: 2708 }
    await assetMethod(client, ledger, args)
    await expect(assetMethod(client, ledger, args)).resolves.toMatchObject({ replayed: true })
    expect(calls.map(call => call.method)).toEqual(['GET', 'DELETE'])
  })

  it('requires an explicit supported asset registration category', async () => {
    const { client, calls } = stubClient(() => null)
    await expect(assetMethod(client, ledger, { method: 'register', idempotency_key: 'bad-register',
      script_id: 2708, asset_name: 'lead', asset_url: 'https://media.example/lead.jpg', asset_type: 5 }))
      .rejects.toThrow('asset_type')
    await expect(assetMethod(client, ledger, { method: 'models' })).rejects.toThrow()
    expect(calls).toEqual([])
  })

  it.each([1, 2])('identifies %i new matching registered assets without selecting ambiguous rows', async (count) => {
    let reads = 0
    const { client, calls } = stubClient((request) => {
      if (request.method === 'POST') return null
      return { rows: reads++ === 0 ? [{ id: 10, assetType: 1 }] : [{ id: 10, assetType: 1 },
        ...Array.from({ length: count }, (_, index) => ({ id: 11 + index, assetType: 1 })), { id: 20, assetType: 2 }] }
    })
    const args = { method: 'register', idempotency_key: 'register-once', script_id: 2708,
      asset_name: 'lead', asset_url: 'https://media.example/lead.jpg', asset_type: 1 }
    const result = await assetMethod(client, ledger, args)
    expect(result).toMatchObject({ outcome: 'accepted', created_asset_id: count === 1 ? 11 : null,
      new_asset_ids: count === 1 ? [11] : [11, 12] })
    expect(calls.find(call => call.method === 'POST')?.body)
      .toEqual({ scriptId: 2708, assetName: 'lead', assetType: 1, isLocal: 1, url: 'https://media.example/lead.jpg' })
    await expect(assetMethod(client, ledger, args)).resolves.toMatchObject({ replayed: true, created_asset_id: null })
    expect(calls.filter(call => call.method === 'POST')).toHaveLength(1)
  })
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
    const { client, calls } = stubClient(() => ({ id: 113076, scriptId: 2708, assetType: 1 }))
    const result = await assetMethod(client, ledger, { method: 'remove', idempotency_key: 'k-rm',
      asset_id: 113076, script_id: 2708 })
    expect(calls.length).toBe(2)
    expect(calls[0]!.method).toBe('GET')
    expect(calls[1]!.method).toBe('DELETE')
    expect(calls[1]!.path.endsWith('/aigc/asset/removeAsset/113076?scriptId=2708&isParent=1')).toBe(true)
    expect(calls[1]!.body).toBeUndefined()
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
  it('rejects a missing batch project before catalogue access or ledger writes', async () => {
    const { client, calls } = imageProvider()
    await expect(videoMethod(client, ledger, { method: 'image_generate_batch',
      items: [{ idempotency_key: 'missing-project', asset_name: 'lead', asset_type: 1, prompt: 'ready' }] }))
      .rejects.toThrow('positive script_id')
    expect(calls).toEqual([])
    expect(await ledger.records()).toEqual([])
  })
  it('retains serialized storage failure evidence rather than marking a batch item as definitely unsent', async () => {
    const { client, calls } = imageProvider()
    const find = vi.spyOn(ledger, 'find').mockRejectedValue('storage service disconnected')
    onTestFinished(() => { find.mockRestore() })
    const result = await videoMethod(client, ledger, { method: 'image_generate_batch', script_id: 2708,
      items: [{ idempotency_key: 'serialized-storage-error', asset_name: 'lead', asset_type: 1, prompt: 'ready' }] }, imageDeps())
    expect(result.results).toMatchObject([{ status: 'error', outcome: 'unknown',
      ledger_error: 'storage service disconnected', error: 'storage service disconnected' }])
    expect(calls.filter(call => call.method === 'POST')).toEqual([])
  })

  it('updates an existing image parent in a default-bound batch and uses the saved estimate when catalogue prices are unavailable', async () => {
    const { unitPrice: _price, ...row } = IMAGE_CATALOGUE[0]!
    const { client, calls } = imageProvider([row])
    expect(await videoMethod(client, ledger, { method: 'image_generate_batch', script_id: 2708,
      items: [{ idempotency_key: 'update-parent', parent_asset_id: 77, asset_name: 'lead', asset_type: 1, prompt: 'ready' }] }))
      .toMatchObject({ returned: 1, errors: 0, results: [{ asset_status: 'active' }] })
    expect(calls.filter(call => call.method === 'PUT')).toHaveLength(1)
    expect((await ledger.find('update-parent'))?.quoted_amount).toBe('1.00')
    const task = stubClient(() => ({ rows: [], total: 0 }))
    await videoMethod(task.client, ledger, { method: 'tasks', script_id: 2708 })
    expect(task.calls[0]?.path).toContain('pageNum=1')
  })

  it('rejects a missing episode identity and unknown retry statuses before a remote write', async () => {
    const { client, calls } = stubClient(request => request.path.includes('sub/list')
      ? { rows: [{ id: 99, duration: 8, resultList: [{ tosVideoUrl: 'https://media.example/source.mp4' }] }] }
      : { id: 42, scriptId: 2708 })
    await expect(videoMethod(client, ledger, { method: 'upscale', task_id: 42, idempotency_key: 'missing-episode' }))
      .rejects.toThrow()
    await expect(videoMethod(client, ledger, { method: 'retry', task_id: 42, idempotency_key: 'unknown-status' })).rejects.toThrow()
    expect(calls.filter(call => call.path.includes('hdConversion') || call.path.includes('/retry/'))).toEqual([])
  })

  it('retries a parent-terminal failure whose legacy child omits status and has no file or charge', async () => {
    const { client, calls } = stubClient(request => request.path.includes('sub/list')
      ? { rows: [{ id: 99 }] } : { id: 42, taskStatus: 'failed', realCost: '0' })
    expect(await videoMethod(client, ledger, { method: 'retry', task_id: 42, idempotency_key: 'legacy-failure' }))
      .toMatchObject({ outcome: 'accepted' })
    expect(calls.at(-1)?.path).toContain('/retry/42')
  })
  it('reports a batch item as uncertain when the ledger cannot be read for its original key', async () => {
    const { client, calls } = imageProvider()
    const find = vi.spyOn(ledger, 'find').mockRejectedValue(new Error('ledger storage unavailable'))
    onTestFinished(() => { find.mockRestore() })
    const result = await videoMethod(client, ledger, { method: 'image_generate_batch', script_id: 2708,
      items: [{ idempotency_key: 'unreadable-key', asset_name: 'lead', asset_type: 1, prompt: 'ready' }] }, imageDeps())
    expect(result.results).toMatchObject([{ status: 'error', outcome: 'unknown',
      ledger_error: 'ledger storage unavailable', record_id: null }])
    expect(calls.filter(call => call.method === 'POST')).toEqual([])
  })

  it('returns the original unsettled reservation when image-batch submission and settlement both lose their connection', async () => {
    const { client, calls } = stubClient(request => request.path.includes('getSelectList') ? IMAGE_CATALOGUE
      : new Response(JSON.stringify({ code: 400, msg: 'provider refused' }), { status: 400 }))
    const settle = vi.spyOn(ledger, 'settle').mockRejectedValue(new Error('settlement storage unavailable'))
    onTestFinished(() => { settle.mockRestore() })
    const result = await videoMethod(client, ledger, { method: 'image_generate_batch', script_id: 2708,
      items: [{ idempotency_key: 'unsettled-item', asset_name: 'lead', asset_type: 1, prompt: 'ready' }] }, imageDeps())
    expect(result.results).toMatchObject([{ status: 'error', outcome: 'unknown', record_script_id: 2708 }])
    expect(calls.filter(call => call.method === 'POST')).toHaveLength(1)
    expect((await ledger.find('unsettled-item'))?.outcome).toBeNull()
  })

  it('reports an accepted batch item with no asset ID without attempting an invented asset read', async () => {
    const { client, calls } = stubClient(request => request.path.includes('getSelectList') ? IMAGE_CATALOGUE : null)
    const result = await videoMethod(client, ledger, { method: 'image_generate_batch', script_id: 2708,
      items: [{ idempotency_key: 'no-asset-id', asset_name: 'lead', asset_type: 1, prompt: 'ready' }] }, imageDeps())
    expect(result.results).toMatchObject([{ status: 'returned', outcome: 'accepted', parent_asset_id: null, asset_status: 'unverified' }])
    expect(calls.map(call => call.method)).toEqual(['GET', 'POST'])
  })
  it('polls with the deployment defaults and releases the timer after the generated image appears', async () => {
    vi.useFakeTimers()
    onTestFinished(() => { vi.useRealTimers() })
    const entered = Promise.withResolvers<undefined>()
    let reads = 0
    const { client, calls } = stubClient((request) => {
      if (request.path.includes('getSelectList')) return IMAGE_CATALOGUE
      if (request.path.includes('getGeneratedImageByAssetId')) return GENERATED_IMAGE
      if (request.method === 'GET' && request.path.includes('/aigc/asset/')) {
        entered.resolve(undefined)
        return { id: 83749, hsAssetStatus: reads++ === 0 ? 'Submitted' : 'Active' }
      }
      return 83749
    })
    const operation = videoMethod(client, ledger, { method: 'image_generate', script_id: 2708,
      asset_name: 'lead', asset_type: 1, prompt: 'ready', idempotency_key: 'defaults' })
    try {
      await entered.promise
      await vi.advanceTimersByTimeAsync(3000)
      expect(await operation).toMatchObject({ asset_status: 'active', waited_ms: 3000 })
      expect(calls.filter(call => call.method === 'POST')).toHaveLength(1)
      expect(vi.getTimerCount()).toBe(0)
    } finally { await vi.runAllTimersAsync(); await Promise.allSettled([operation]); vi.useRealTimers() }
  })

  it.each(['Failed', 'not-ready', 'disconnected', 'no-status'])
  ('reports an accepted asset whose generated-image readback is %s', async (state) => {
    const { client, calls } = stubClient((request) => {
      if (request.path.includes('getSelectList')) return IMAGE_CATALOGUE
      if (request.path.includes('getGeneratedImageByAssetId')) {
        if (state === 'disconnected') throw new Error('image read disconnected')
        return []
      }
      if (request.method === 'GET' && request.path.includes('/aigc/asset/')) {
        return { id: 83749, ...(state === 'no-status' ? {} : { hsAssetStatus: state === 'Failed' ? state : 'Active' }) }
      }
      return 83749
    })
    const result = await videoMethod(client, ledger, { method: 'image_generate', script_id: 2708,
      asset_name: 'lead', asset_type: 1, prompt: 'ready', idempotency_key: `readback-${state}` },
    imageDeps({ timeoutMs: 100, pollMs: 100 }))
    expect(result).toMatchObject({ parent_asset_id: 83749, outcome: 'accepted',
      asset_status: state === 'Failed' ? 'failed' : state === 'disconnected' ? 'unverified' : 'timeout' })
    expect(result.readback_error).toBeTypeOf('string')
    expect(calls.filter(call => call.method === 'POST')).toHaveLength(1)
  })

  it('contains an injected readback scheduler failure after recording the accepted paid write', async () => {
    const { client } = imageProvider(IMAGE_CATALOGUE, ['Submitted'])
    const result = await videoMethod(client, ledger, { method: 'image_generate', script_id: 2708,
      asset_name: 'lead', asset_type: 1, prompt: 'ready', idempotency_key: 'scheduler-error' },
    { image: { now: () => 0, sleep: async () => { throw 'scheduler unavailable' } } })
    expect(result).toMatchObject({ asset_status: 'unverified', parent_asset_id: 83749 })
    expect(result.readback_error).toContain('scheduler unavailable')
    expect((await ledger.find('scheduler-error'))?.outcome).toBe('accepted')
  })

  it.each([{ rows: [] }, { rows: [{ id: 99 }] }, { rows: [{ id: 99, duration: 8 }] },
    { rows: [{ id: 99, resultList: [{ tosVideoUrl: 'https://media.example/source.mp4' }] }] }])
  ('refuses paid media processing with no complete source media %j', async ({ rows }) => {
    const { client, calls } = stubClient(request => request.path.includes('sub/list') ? { rows }
      : { id: 42, scriptId: 2708, episodeId: 1 })
    await expect(videoMethod(client, ledger, { method: 'upscale', task_id: 42, idempotency_key: 'missing-source' }))
      .rejects.toMatchObject({ message: new JubianError('CONTRACT_CHANGED').message })
    expect(calls.map(call => call.method)).toEqual(['GET', 'POST'])
    expect(calls.filter(call => call.path.includes('hdConversion'))).toEqual([])
    expect(await ledger.records()).toEqual([])
  })

  it.each([null, 'not-an-id', 'unknown-envelope'])('preserves uncertainty when the accepted image response is %s', async (state) => {
    const { client, calls } = stubClient(request => request.path.includes('getSelectList') ? IMAGE_CATALOGUE
      : state === 'unknown-envelope' ? new Response(JSON.stringify([83749])) : state)
    const result = await videoMethod(client, ledger, { method: 'image_generate', script_id: 2708,
      asset_name: 'lead', asset_type: 1, prompt: 'ready', idempotency_key: 'uncertain-response' }, imageDeps())
    expect(result).toMatchObject({ asset_status: 'unverified',
      outcome: state === 'unknown-envelope' ? 'unknown' : 'accepted' })
    expect(calls.filter(call => call.method === 'POST')).toHaveLength(1)
    expect(result.next).toContain('确认')
  })

  it('uses the child result and explicit project fallback to name an upscale with no parent task name', async () => {
    const { client, calls } = stubClient((request) => {
      if (request.method === 'GET') return { id: 42, episodeId: 1 }
      if (request.path.includes('sub/list')) return { rows: [{ id: 99, duration: 8,
        resultList: [{ lastTosVideoUrl: 'https://media.example/source.mp4' }] }] }
      return undefined
    })
    expect(await videoMethod(client, ledger, { method: 'upscale', task_id: 42, script_id: 2708,
      episode: '05', package_number: '3', idempotency_key: 'fallback-media' })).toMatchObject({ accepted_task_id: null })
    expect(calls.at(-1)?.body).toMatchObject({ scriptId: 2708, episodeCount: 1, firstResultId: 99,
      parentResultId: 99, taskName: 'EP05-P3-task-42-高清转换', videoUrl: 'https://media.example/source.mp4' })
  })

  it.each([{ asset_type: 4 }, { asset_type: 1.5 }, { asset_type: 1, asset_category: '场景' as const },
    { asset_type: 1, asset_name: ' ' }])('refuses inconsistent local image identity %j before a catalogue read', async (identity) => {
    const { client, calls } = imageProvider()
    await expect(videoMethod(client, ledger, { method: 'image_generate', script_id: 2708,
      asset_name: 'lead', prompt: 'ready', idempotency_key: 'identity-error', ...identity })).rejects.toThrow()
    expect(calls).toEqual([])
  })

  it.each([{ script_id: 0, items: [] }, { script_id: 2708, items: [] }, { script_id: 2708, items: [null] },
    { script_id: 2708, items: [{ idempotency_key: ' padded ', asset_name: 'lead', asset_type: 1, prompt: 'ready' }] },
    { script_id: 2708, items: [{ idempotency_key: 'bad\u0000key', asset_name: 'lead', asset_type: 1, prompt: 'ready' }] },
    { script_id: 2708, items: [{ idempotency_key: '\ud800', asset_name: 'lead', asset_type: 1, prompt: 'ready' }] }])
  ('refuses malformed batch tool JSON before reading the provider %j', async (wire) => {
    const { client, calls } = imageProvider()
    const args = JSON.parse(JSON.stringify({ method: 'image_generate_batch', ...wire })) as MethodArgs
    await expect(videoMethod(client, ledger, args)).rejects.toThrow()
    expect(calls).toEqual([])
  })

  it.each([null, [12]])('refuses malformed reference values decoded from batch tool JSON %j', async (references) => {
    const { client, calls } = imageProvider()
    const decoded = JSON.parse(JSON.stringify({ method: 'image_generate_batch', script_id: 2708,
      items: [{ idempotency_key: 'wire-references', asset_name: 'lead', asset_type: 1, prompt: 'ready', references }] })) as MethodArgs
    await expect(videoMethod(client, ledger, decoded, imageDeps())).rejects.toThrow('invalid image request')
    expect(calls).toEqual([])
    expect(await ledger.records()).toEqual([])
  })
  it('lists tasks and reports unresolved local writes without another provider request', async () => {
    const { client, calls } = stubClient(request => request.path.includes('/list') ? { rows: [] } : { id: 42 })
    await videoMethod(client, ledger, { method: 'task', task_id: 42 })
    await videoMethod(client, ledger, { method: 'tasks', script_id: 2708, page_num: 2 })
    expect(calls[1]?.path).toContain('taskType=1&pageNum=2')
    expect(await videoMethod(client, ledger, { method: 'unresolved', script_id: 2708 }))
      .toMatchObject({ unresolved: [] })
    await ledger.begin({ idempotencyKey: 'pending-native', method: 'storyboard_native_submit',
      requestSha256: 'sha256:pending', scriptId: 2708 })
    const unresolved = await videoMethod(client, ledger, { method: 'unresolved', script_id: 2708 })
    expect(unresolved.unresolved).toEqual([expect.objectContaining({ idempotency_key: 'pending-native', outcome: 'unsettled' })])
    expect(unresolved.next).toContain('同一个 idempotency_key')
    expect(calls).toHaveLength(2)
    await expect(videoMethod(client, ledger, { method: 'models' })).rejects.toThrow()
  })

  it.each([{ taskStatus: 'running', realCost: '0' }, { taskStatus: 'failed', realCost: '1' },
    { taskStatus: 'failed', realCost: '0', childStatus: 'running' },
    { taskStatus: 'failed', realCost: '0', childStatus: 'succeeded' },
    { taskStatus: 'failed', realCost: '0', childStatus: 'failed', url: 'https://media.example/result.mp4' }])
  ('refuses retry when task evidence permits success, activity or a charge %j', async (state) => {
    const { client, calls } = stubClient(request => request.path.includes('sub/list')
      ? { rows: [{ id: 99, taskStatus: state.childStatus ?? 'failed',
        ...(state.url === undefined ? {} : { resultList: [{ tosVideoUrl: state.url }] }) }] }
      : { id: 42, taskStatus: state.taskStatus, realCost: state.realCost })
    await expect(videoMethod(client, ledger, { method: 'retry', task_id: 42, idempotency_key: 'retry-gate' })).rejects.toThrow()
    expect(calls.map(call => call.method)).toEqual(['GET', 'POST'])
    expect(calls.some(call => call.path.includes('/retry/'))).toBe(false)
    expect(await ledger.records()).toEqual([])
  })

  it('retries a terminal failed task with no result or real charge once', async () => {
    const { client, calls } = stubClient(request => request.path.includes('sub/list')
      ? { rows: [{ id: 99, taskStatus: 'failed' }] } : { id: 42, taskStatus: 'failed', realCost: '0.0' })
    const args = { method: 'retry', task_id: 42, idempotency_key: 'retry-once' }
    await expect(videoMethod(client, ledger, args)).resolves.toMatchObject({ outcome: 'accepted' })
    await expect(videoMethod(client, ledger, args)).resolves.toMatchObject({ replayed: true })
    expect(calls.map(call => call.method)).toEqual(['GET', 'POST', 'POST'])
    expect(calls[2]?.path).toContain('/retry/42')
  })
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
    expect(JSON.parse(calls[1]!.body!.modelConfig as string)).toMatchObject({ ratio: '16:9', videoStandardId: 91 })
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

  it('sends an explicit 9:16 specification with references in their original order', async () => {
    const { client, calls } = imageProvider(PORTRAIT_IMAGE_CATALOGUE)
    const result = await videoMethod(client, ledger, { method: 'image_generate', idempotency_key: 'portrait-image',
      script_id: 2708, asset_name: '竖屏候选', asset_type: 2, prompt: '公司大厅',
      image_aspect_ratio: '9:16', references: [
        'https://example.test/character.png', 'https://example.test/twins.png',
      ] }, imageDeps({ selection: { platformId: 'KU_AI' } }))
    expect(result.outcome).toBe('accepted')
    expect(calls.filter(call => call.method === 'POST')).toHaveLength(1)
    const config = JSON.parse(calls.find(call => call.method === 'POST')!.body!.modelConfig as string) as Record<string, unknown>
    expect(config).toMatchObject({ standardId: 66, platformId: 'KU_AI', ratio: '9:16',
      videoStandardId: 93, resolution: '1K', materialList: [
        { materialUrl: 'https://example.test/character.png', materialType: 'image', sortOrder: 1 },
        { materialUrl: 'https://example.test/twins.png', materialType: 'image', sortOrder: 2 },
      ] })
  })

  it.each([undefined, 83749])('refuses missing 9:16 specification before paid POST or PUT (parent %s)',
    async (parentAssetId) => {
      const { client, calls } = imageProvider(IMAGE_CATALOGUE)
      const key = `missing-portrait-${parentAssetId ?? 'new'}`
      await expect(videoMethod(client, ledger, { method: 'image_generate', idempotency_key: key,
        script_id: 2708, asset_name: '竖屏候选', asset_type: 2, prompt: '公司大厅',
        image_aspect_ratio: '9:16',
        ...(parentAssetId === undefined ? {} : { parent_asset_id: parentAssetId }) }, imageDeps()))
        .rejects.toThrow(/9:16/u)
      expect(calls.filter(call => call.method === 'POST' || call.method === 'PUT')).toHaveLength(0)
      expect(await ledger.find(key)).toBeUndefined()
    })

  it('refuses an unsupported image ratio before a paid request or ledger intent', async () => {
    const { client, calls } = imageProvider(PORTRAIT_IMAGE_CATALOGUE)
    await expect(videoMethod(client, ledger, { method: 'image_generate', idempotency_key: 'invalid-portrait',
      script_id: 2708, asset_name: '竖屏候选', asset_type: 2, prompt: '公司大厅',
      image_aspect_ratio: '4:3' as '9:16' }, imageDeps())).rejects.toThrow(/image_aspect_ratio/u)
    expect(calls.filter(call => call.method === 'POST' || call.method === 'PUT')).toHaveLength(0)
    expect(await ledger.find('invalid-portrait')).toBeUndefined()
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
  const createBody = { scriptId: 2708, episodeId: 9, storyboardName: 'P1', sortOrder: 0,
    modelConfig: { prompt: 'ready' } }

  it('refuses absent native previews and unreadable preparation inputs before any paid request', async () => {
    const { client, calls } = stubClient(() => 1)
    await writeFile(join(root, 'project_config.json'), JSON.stringify({ jubian_script_id: 2708 }))
    await expect(storyboardMethod(client, ledger, { method: 'submit_video', project_dir: root,
      storyboard_id: 916953, preview_path: join(root, 'video_tasks', 'missing.prepared.json'),
      idempotency_key: 'missing-preview' })).rejects.toThrow(JubianError)
    await expect(storyboardMethod(client, ledger, { method: 'submit_video_batch', video_previews: [] }))
      .rejects.toThrow('video batch items')
    expect(calls).toEqual([])
    await expect(storyboardMethod(client, ledger, { method: 'prepare_video', project_dir: join(root, 'absent-project'),
      storyboard_id: 916953, content_duration_ms: 7000 })).rejects.toThrow(JubianError)
    expect(calls.map(call => call.method)).toEqual(['GET'])
    expect(await ledger.records()).toEqual([])
  })

  it('uses default edit and deletion limits while refusing an empty deletion target list', async () => {
    await writeFile(join(root, 'project_config.json'), JSON.stringify({ jubian_script_id: 2708 }))
    const { client, calls } = stubClient(() => STORYBOARD)
    const plan = await storyboardMethod(client, ledger, { method: 'edit_preview', project_dir: root,
      script_id: 2708, storyboard_id: 916953, changes: { name: 'Edited card' } })
    expect(plan).toMatchObject({ operation: 'storyboard_edit', targets: [{ storyboard_id: 916953,
      after: { name: 'Edited card' } }] })
    await expect(storyboardMethod(client, ledger, { method: 'delete_preview', project_dir: root,
      script_id: 2708, storyboard_ids: [], delete_reason: 'Remove unused cards', authorization_basis: 'User approved removal' }))
      .rejects.toThrow()
    expect(calls.every(call => call.method === 'GET')).toBe(true)
    expect(await ledger.records()).toEqual([])
  })

  it.each(['null', '[]', '"text"'])('refuses a nonobject frozen batch body %s before creating any card', async (contents) => {
    const bodyPath = join(root, 'invalid-batch-body.json')
    await writeFile(bodyPath, contents)
    const { client, calls } = stubClient(() => 1)
    await expect(storyboardMethod(client, ledger, { method: 'create_batch', script_id: 2708,
      storyboards: [{ idempotency_key: 'bad-batch-file', body_path: bodyPath }] })).rejects.toThrow('Invalid storyboard body')
    expect(calls).toEqual([])
    expect(await ledger.records()).toEqual([])
  })

  it('reports a serialized ledger failure for a creation item without sending its body', async () => {
    const { client, calls } = stubClient(() => 1)
    const read = vi.spyOn(ledger, 'find').mockRejectedValue('ledger service disconnected')
    onTestFinished(() => { read.mockRestore() })
    expect(await storyboardMethod(client, ledger, { method: 'create_batch', script_id: 2708,
      storyboards: [{ idempotency_key: 'unread-ledger', body: createBody }] })).toMatchObject({
      returned: 0, errors: 1, results: [{ status: 'error', outcome: 'reconcile_required', error: 'Storyboard creation failed' }],
    })
    expect(calls).toEqual([])
  })

  it.each([{ scriptId: 2709 }, { storyboardName: '' }, { sortOrder: -1 }, { sortOrder: 0.5 },
    { modelConfig: [] }, { modelConfig: null }, { modelConfig: { prompt: '' } }, { modelConfig: { prompt: 12 } }])
  ('preflights invalid batch creation fields without writing %j', async (overrides) => {
    const { client, calls } = stubClient(() => 1)
    await expect(storyboardMethod(client, ledger, { method: 'create_batch', script_id: 2708,
      storyboards: [{ idempotency_key: 'bad-create', body: { ...createBody, ...overrides } }] })).rejects.toThrow()
    expect(calls).toEqual([])
    expect(await ledger.records()).toEqual([])
  })

  it('refuses duplicate batch keys, episode names and conflicting body sources', async () => {
    const { client, calls } = stubClient(() => 1)
    for (const storyboards of [[],
      [{ idempotency_key: 'same', body: createBody }, { idempotency_key: 'same', body: { ...createBody, storyboardName: 'P2' } }],
      [{ idempotency_key: 'first', body: createBody }, { idempotency_key: 'second', body: createBody }],
      [{ idempotency_key: 'both', body: createBody, body_path: join(root, 'unused') }],
      [{ idempotency_key: 'neither' }]]) {
      await expect(storyboardMethod(client, ledger, { method: 'create_batch', script_id: 2708, storyboards })).rejects.toThrow()
    }
    expect(calls).toEqual([])
  })

  it('prepares batch bodies from files and isolates ledger conflicts per item', async () => {
    const bodyPath = join(root, 'batch-body.json')
    await writeFile(bodyPath, JSON.stringify(createBody))
    await ledger.begin({ idempotencyKey: 'conflict', method: 'asset_register', requestSha256: 'sha256:other' })
    const { client, calls } = stubClient(() => 1)
    const result = await storyboardMethod(client, ledger, { method: 'create_batch', script_id: 2708,
      storyboards: [{ idempotency_key: 'file-create', body_path: bodyPath },
        { idempotency_key: 'conflict', body: { ...createBody, storyboardName: 'P2' } }] })
    expect(result).toMatchObject({ total: 2, returned: 1, errors: 1,
      results: [expect.objectContaining({ status: 'returned' }), expect.objectContaining({ status: 'error', outcome: 'reconcile_required' })] })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.body).toMatchObject({ ...createBody, isGenerate: 0 })
  })

  it.each(['{', 'null', '[]'])('refuses unreadable creation body files %s', async (contents) => {
    const bodyPath = join(root, 'bad-body.json')
    await writeFile(bodyPath, contents)
    const { client, calls } = stubClient(() => 1)
    await expect(storyboardMethod(client, ledger, { method: 'create', idempotency_key: 'bad-file', body_path: bodyPath }))
      .rejects.toThrow()
    expect(calls).toEqual([])
  })

  it('refuses a direct creation with conflicting sources and unsupported methods', async () => {
    const { client, calls } = stubClient(() => null)
    await expect(storyboardMethod(client, ledger, { method: 'create', idempotency_key: 'both', body: createBody,
      body_path: join(root, 'unused') })).rejects.toThrow()
    await expect(storyboardMethod(client, ledger, { method: 'models' })).rejects.toThrow()
    expect(calls).toEqual([])
  })
  it('directs changes to existing identities to editing instead of creating another card', async () => {
    const { calls, client } = stubClient(() => null)
    const body = { id: 916953, scriptId: 2708, episodeId: 9, storyboardName: 'EP01-P1', sortOrder: 1,
      modelConfig: { prompt: '已有镜头的改动', duration: 9 } }
    await expect(storyboardMethod(client, ledger, { method: 'create', body, idempotency_key: 'not-new' }))
      .rejects.toThrow('edit_preview')
    await expect(storyboardMethod(client, ledger, { method: 'create_batch', script_id: 2708,
      storyboards: [{ body, idempotency_key: 'not-new-batch' }] })).rejects.toThrow('edit_preview')
    expect(calls).toEqual([])
    expect(await ledger.records()).toEqual([])
  })
  it('submits prepared storyboard bodies concurrently and keeps replay keys per item', async () => {
    let active = 0
    let peak = 0
    let posted = 0
    let release: (() => void) | undefined
    const { client, calls } = stubClient(async () => {
      active++; peak = Math.max(peak, active)
      if (active === 2) { release?.(); release = undefined }
      else await new Promise<void>((resolve) => { release = resolve })
      active--; return 100 + posted++
    })
    const args: MethodArgs = { method: 'create_batch', script_id: 2708,
      storyboards: Array.from({ length: 4 }, (_, i) => ({ idempotency_key: `board-${i}`,
        body: { scriptId: 2708, episodeId: 9, storyboardName: `EP01-P${i + 1}`, sortOrder: i,
          modelConfig: JSON.stringify({ prompt: '@[主角](lead) 走进房间', duration: 8 }) } })) }
    const deps = { storyboardBatch: { concurrency: 2, maxItems: 10 } }
    const result = await storyboardMethod(client, ledger, args, deps)
    expect(peak).toBe(2)
    expect(result).toMatchObject({ total: 4, returned: 4, errors: 0 })
    expect(calls).toHaveLength(4)
    expect(calls.every(call => call.body?.isGenerate === 0)).toBe(true)
    await storyboardMethod(client, ledger, args, deps)
    expect(calls).toHaveLength(4)
  })

  it('checks every create body before writing any storyboard', async () => {
    const { client, calls } = stubClient(() => 1)
    await expect(storyboardMethod(client, ledger, { method: 'create_batch', script_id: 2708,
      storyboards: [0, 1].map(i => ({ idempotency_key: `bad-${i}`, body: {
        scriptId: 2708, episodeId: 9, storyboardName: `P${i}`, sortOrder: i,
        modelConfig: JSON.stringify(i ? {} : { prompt: 'ready' }) } })) }))
      .rejects.toThrow('modelConfig.prompt')
    expect(calls).toEqual([])
    expect(await ledger.records()).toEqual([])
  })

  it('lists an empty project without model settings, local project files or writes', async () => {
    const { client, calls } = stubClient(() => ({ rows: [], total: 0 }))
    expect(await storyboardMethod(client, ledger, { method: 'list', script_id: 2708 }))
      .toMatchObject({ storyboards: { rows: [], total: 0 }, page_num: 1 })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ method: 'GET' })
    expect(calls[0]!.path).toContain('/aigc/storyboard/list?scriptId=2708&pageNum=1&pageSize=20')
    expect(await ledger.records()).toEqual([])
  })

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

  it('uses an explicit subtitle rectangle and task fallback name for a nameless parent', async () => {
    const { client, calls } = stubClient(request => request.path.includes('sub/list')
      ? { total: 1, rows: [{ id: 99, duration: 8, resultList: [{ tosVideoUrl: 'https://example.test/source.mp4' }] }] }
      : { id: 42, scriptId: 2708, episodeId: 1 })
    expect(await storyboardMethod(client, ledger, { method: 'erase_subtitle', idempotency_key: 'explicit-subtitle-box',
      task_id: 42, model_id: 'quzimuToB', video_width: 1280, video_height: 720,
      subtitle_box: { zimuLeft: 0, zimuTop: 600, zimuWidth: 1279, zimuHeight: 100 } }))
      .toMatchObject({ outcome: 'accepted' })
    expect(calls[2]?.body).toMatchObject({ taskName: 'task-42-去字幕',
      zimuLeft: 0, zimuTop: 600, zimuWidth: 1279, zimuHeight: 100 })
    expect(calls.map(call => call.method)).toEqual(['GET', 'POST', 'POST'])
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
  it.each([{ storyboardBatchConcurrency: 0 }, { storyboardBatchConcurrency: 9 },
    { storyboardBatchConcurrency: 1.5 }, { storyboardBatchMaxItems: 0 }, { storyboardBatchMaxItems: 1001 }])
  ('rejects invalid storyboard batch limits %j', (config) => {
    expect(() => resolveStoryboardBatchOptions(config)).toThrow('storyboardBatchConcurrency')
  })

  it('resolves explicit storyboard batch limits', () => {
    expect(resolveStoryboardBatchOptions({ storyboardBatchConcurrency: 2, storyboardBatchMaxItems: 8 }))
      .toEqual({ concurrency: 2, maxItems: 8 })
  })
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
