import { mkdtemp, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { JubianClient, JubianLedger } from '@deepseek-ai/dsh-jubian'
import { storyboardMethod } from '../src/methods.ts'

const modelId = 'doubao-seedance-2-0-260128'
const config = { platformId: 'YU_DIAN', modelId, standardId: 11, genType: 3,
  modelGenerationTypeId: 7, videoStandardId: 91, duration: 8, ratio: '9:16', resolution: '720p',
  genNum: 1, prompt: '@[阿舟](lead)走进房间', seed: 123 }
const catalogue = [{ id: 11, modelId, platformId: 'YU_DIAN', genTypes: [{ id: 7, type: 3 }],
  videoStandards: [{ id: 91, ratio: '9:16', resolution: '720p', genNum: 1 },
    { id: 92, ratio: '9:16', resolution: '1080p', genNum: 1 }] }]
let root: string
let ledger: JubianLedger
let boards: Record<string, unknown>[]
let calls: { method: string; path: string; body?: Record<string, unknown> }[]
let onPut: ((body: Record<string, unknown>) => Promise<void> | void) | undefined
let client: JubianClient
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'jubian-edit-'))
  await writeFile(join(root, 'project_config.json'), JSON.stringify({ jubian_script_id: 2708 }))
  ledger = new JubianLedger({ root: join(root, 'ledger') })
  boards = [1, 2, 3].map(id => ({ id, scriptId: 2708, episodeId: 11, isGenerate: 1,
    storyboardName: `board ${id}`, sortOrder: id, modelConfig: JSON.stringify(config),
    storyboardMaterialList: [{ id: 42, assetId: 'official-a', materialAssetId: 77,
      materialKey: 'lead', fileName: '阿舟', sortOrder: 1 }], other: 'keep' }))
  calls = []; onPut = undefined
  client = new JubianClient({ credential: async () => 'token', fetch: async (url, init) => {
    const path = (url instanceof Request ? url.url : url.toString()).replace('https://web.jubianai.net/prod-api', '')
    const method = String(init?.method)
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : undefined
    calls.push({ method, path, ...(body ? { body } : {}) })
    const answer = (data: unknown) => new Response(JSON.stringify({ code: 200, data }))
    if (path.startsWith('/model/charge/')) return answer(catalogue)
    if (path.startsWith('/aigc/episode/list?')) return answer({ rows: [
      { id: 11, scriptId: 2708, episodeCount: 1 }, { id: 12, scriptId: 2708, episodeCount: 2 },
    ], total: 2 })
    if (method === 'GET' && path.startsWith('/aigc/storyboard/')) {
      return answer(boards.find(board => board.id === Number(path.split('/').pop())))
    }
    if (method === 'PUT' && path === '/aigc/storyboard' && body) {
      await onPut?.(body)
      boards = boards.map(board => board.id === body.id ? { ...body, isGenerate: 1 } : board)
      return answer(null)
    }
    throw new Error(`unexpected ${method} ${path}`)
  } })
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })
const preview = (changes: Record<string, unknown>, extra = {}) => storyboardMethod(client, ledger, {
  method: 'edit_preview', project_dir: root, script_id: 2708, storyboard_id: 1, changes, ...extra,
})
const apply = (plan: Record<string, unknown>, extra = {}) => storyboardMethod(client, ledger, {
  method: 'edit_apply', project_dir: root, script_id: 2708, preview_path: String(plan.preview_path),
  idempotency_key: String(plan.fingerprint), ...extra,
})
const writes = () => calls.filter(call => call.method !== 'GET')

describe('storyboard editing in place', () => {
  it('rejects an outside preview path before reading or parsing it', async () => {
    const plan = await preview({ name: 'edited' })
    const outside = join(root, 'outside-preview.json')
    await writeFile(outside, 'private-data-is-not-an-edit-preview')
    await expect(apply(plan, { preview_path: outside })).rejects.toThrow(/path\/key mismatch/)
    expect(writes()).toEqual([])
  })

  it('refuses an edit preview reached through a directory junction', async () => {
    const plan = await preview({ name: 'edited' })
    const directory = join(root, 'video_tasks')
    const archive = join(root, 'preview-archive')
    await rename(directory, archive)
    await symlink(archive, directory, 'junction')
    try {
      await expect(apply(plan)).rejects.toMatchObject({ code: 'CONTRACT_CHANGED' })
      expect(writes()).toEqual([])
    } finally { await unlink(directory) }
  })

  it('previews changed content and saves the existing identity without generating', async () => {
    const original = structuredClone(boards[0])
    const plan = await preview({ prompt: '@[阿舟](lead)停在门口', name: 'EP01-P1', duration: 9 })
    expect(writes()).toEqual([])
    expect(plan).toMatchObject({ operation: 'storyboard_edit', targets: [
      { storyboard_id: 1, before: { name: 'board 1', duration: 8 }, after: { name: 'EP01-P1', duration: 9 } },
    ] })
    expect(await apply(plan)).toMatchObject({ status: 'applied', paid_requests: 0,
      items: [{ storyboard_id: 1, status: 'applied', verified_readback: true }] })
    expect(writes()).toHaveLength(1)
    expect(writes()[0]?.body).toEqual({ ...original, storyboardName: 'EP01-P1', isGenerate: 0,
      modelConfig: JSON.stringify({ ...config, prompt: '@[阿舟](lead)停在门口', duration: 9 }) })
    expect(JSON.parse(String(writes()[0]?.body?.modelConfig))).toEqual({ ...config,
      prompt: '@[阿舟](lead)停在门口', duration: 9 })
  })

  it('repairs the explicit episode binding and malformed duration without inferring from episodeCount', async () => {
    boards[0] = { ...boards[0], episodeId: null, episodeCount: 2,
      modelConfig: JSON.stringify({ ...config, duration: 8.7 }) }
    const plan = await preview({ episode_id: 12, duration: 9 })
    expect(await apply(plan)).toMatchObject({ status: 'applied' })
    expect(writes()[0]?.body).toMatchObject({ id: 1, scriptId: 2708, episodeId: 12, episodeCount: 2, isGenerate: 0 })
    expect(JSON.parse(String(writes()[0]?.body?.modelConfig))).toMatchObject({ duration: 9 })
  })

  it('requires reselection when content changes named marker identity', async () => {
    const plan = await preview({ prompt: '@[青衣](other)走进房间' })
    expect(plan).toMatchObject({ targets: [{ selection_status: 'needs_reselect' }] })
    const result = await apply(plan)
    expect(result).toMatchObject({ status: 'needs_reselect', items: [
      { storyboard_id: 1, status: 'needs_reselect', verified_readback: true },
    ] })
    expect(writes()[0]?.body?.storyboardMaterialList).toEqual(boards[0]?.storyboardMaterialList)
  })

  it('requires reselection when a marker keeps its key but names another subject', async () => {
    const plan = await preview({ prompt: '@[青衣](lead)走进房间' })
    expect(plan).toMatchObject({ targets: [{ selection_status: 'needs_reselect', prompt_keys: ['lead'], selected_keys: ['lead'] }] })
    expect(await apply(plan)).toMatchObject({ status: 'needs_reselect', items: [{ verified_readback: true }] })
  })

  it('rejects stale card data before any PUT', async () => {
    const plan = await preview({ name: 'edited' })
    boards[0] = { ...boards[0], other: 'concurrent edit' }
    await expect(apply(plan)).rejects.toThrow(/Stale/)
    expect(writes()).toEqual([])
  })

  it('never sends a claimed edit again after unknown transport result', async () => {
    const plan = await preview({ name: 'edited' })
    onPut = () => { throw new Error('timeout') }
    expect(await apply(plan)).toMatchObject({ status: 'partial', items: [{ status: 'unknown' }] })
    expect(await apply(plan)).toMatchObject({ replayed: true })
    expect(writes()).toHaveLength(1)
  })

  it('reports a readback mismatch when the provider drops selected materials', async () => {
    const plan = await preview({ name: 'edited' })
    onPut = (body) => { body.storyboardMaterialList = [] }
    expect(await apply(plan)).toMatchObject({ status: 'partial', items: [
      { status: 'readback_mismatch', verified_readback: false },
    ] })
  })

  it('accepts audit churn while verifying selected material identity and order', async () => {
    const plan = await preview({ name: 'edited' })
    onPut = (body) => {
      body.updateTime = 'today'
      const materials = body.storyboardMaterialList as Record<string, unknown>[]
      body.storyboardMaterialList = materials.map(row => ({ ...row, id: 999, updateTime: 'today' }))
    }
    expect(await apply(plan)).toMatchObject({ status: 'applied', items: [{ verified_readback: true }] })
  })

  it('validates a whole batch and uses configured bounded PUT concurrency', async () => {
    const plan = await storyboardMethod(client, ledger, { method: 'edit_batch_preview', project_dir: root,
      script_id: 2708, edits: [1, 2, 3].map(storyboard_id => ({ storyboard_id, changes: { name: `edited ${storyboard_id}` } })),
    }, { storyboardBatch: { concurrency: 2, maxItems: 3 } })
    let active = 0; let maximum = 0
    onPut = async () => {
      active++; maximum = Math.max(maximum, active)
      await new Promise(resolve => setTimeout(resolve, 15))
      active--
    }
    expect(await storyboardMethod(client, ledger, { method: 'edit_apply', project_dir: root, script_id: 2708,
      preview_path: String(plan.preview_path), idempotency_key: String(plan.fingerprint),
    }, { storyboardBatch: { concurrency: 2, maxItems: 3 } })).toMatchObject({ status: 'applied' })
    expect(maximum).toBe(2)
    expect(writes()).toHaveLength(3)
  })

  it.each([{ id: 2 }, { isGenerate: 1 }, { storyboardMaterialList: [] }, { prompt: '' }, { duration: 8.5 }])(
    'rejects unsupported or malformed edits before network reads: %j', async (changes) => {
      await expect(preview(changes)).rejects.toThrow()
      expect(calls).toEqual([])
    },
  )
})
