import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { storyboardEditMethod } from '../src/storyboard-edit.ts'
import { JubianClient, JubianLedger } from '@deepseek-ai/dsh-jubian'
import { stableSha256, submissionSemantics } from '@deepseek-ai/dsh-jubian-api'
import type { NativeVideoPreview } from '@deepseek-ai/dsh-jubian-api'
import { bodyHash } from '../src/write.ts'
import { positiveInteger, prepareVideoMethod, resolveVideoBatchOptions, selectAssetsMethod,
  submitVideoBatchMethod, submitVideoMethod, validateProjectBinding } from '../src/native.ts'

const URL_LEAD = 'https://jubian-aigc.tos-cn-beijing.volces.com/prod/lead.jpg'
const URL_GUEST = 'https://jubian-aigc.tos-cn-beijing.volces.com/prod/guest.jpg'
const PROMPT = '雨夜街头 @[陆沉舟](lead) 与 @[苏晚](guest)'

const MODEL_CONFIG = { platformId: 'YU_DIAN', modelId: 'doubao-seedance-2-0-260128', standardId: 11, genType: 3,
  modelGenerationTypeId: 7, videoStandardId: 91, duration: 8, ratio: '9:16', resolution: '720p', genNum: 1,
  materialList: [], backupModelList: [], prompt: PROMPT }

const MATERIALS = [
  { assetId: 'asset-lead', materialAssetId: 81285, fileName: '陆沉舟｜西装', materialKey: 'lead',
    materialType: 'image', materialUrl: URL_LEAD, sortOrder: 1 },
  { assetId: 'asset-guest', materialAssetId: 83670, fileName: '苏晚｜风衣', materialKey: 'guest',
    materialType: 'image', materialUrl: URL_GUEST, sortOrder: 2 },
]

const STORYBOARD = { id: 916953, scriptId: 2708, isGenerate: 1, storyboardName: '第1集-分镜1',
  modelConfig: JSON.stringify(MODEL_CONFIG), storyboardMaterialList: MATERIALS }

const ASSETS: Record<string, Record<string, unknown>> = {
  81285: { id: 81285, scriptId: 2708, assetUrl: URL_LEAD, name: '陆沉舟｜西装' },
  83670: { id: 83670, scriptId: 2708, assetUrl: URL_GUEST, name: '苏晚｜风衣' },
}

const SUBJECT_ROWS = [
  { id: 1, assetId: 81285, scriptId: 2708, hsAssetId: 'asset-lead', assetUrl: URL_LEAD,
    assetName: '陆沉舟｜西装', hsAssetStatus: 'Active', isUsed: 1 },
  { id: 2, assetId: 83670, scriptId: 2708, hsAssetId: 'asset-guest', assetUrl: URL_GUEST,
    assetName: '苏晚｜风衣', hsAssetStatus: 'Active', isUsed: 1 },
]

const CATALOGUE = [{ id: 11, standardId: 11, modelId: 'doubao-seedance-2-0-260128', platformId: 'YU_DIAN',
  duration: 8, genNum: 1, genTypes: [{ id: 7, type: 3 }],
  videoStandards: [{ id: 91, ratio: '9:16', resolution: '720p', genNum: 1 }] }]

/** The child a real storyboard PUT produces: the payload's own materials, translated by the server. */
function childOf(payload: Record<string, unknown>, overrides: Record<string, unknown> = {}):
Record<string, unknown> {
  return { id: 972949, aigcVideoTaskId: 335343, storyboardId: 916953, taskStatus: 'submit',
    imageMaterials: payload.storyboardMaterialList, modelConfig: payload.modelConfig, ...overrides }
}

/** The child the provider would hold for the last saved storyboard, as a replay finds it. */
function savedChild(provider: { storyboard: Record<string, unknown> }): Record<string, unknown> {
  return childOf({ storyboardMaterialList: provider.storyboard.storyboardMaterialList,
    modelConfig: provider.storyboard.modelConfig })
}

interface FakeProvider {
  calls: { method: string; path: string; body?: Record<string, unknown> }[]
  storyboard: Record<string, unknown>
  storyboards?: Record<string, Record<string, unknown>>
  tasks: Record<string, unknown>[]
  subtasks: Record<string, Record<string, unknown>[]>
  /** What the single PUT does besides answering: create a task, fail, or nothing. */
  onPut?: (payload: Record<string, unknown>) => void | Promise<void>
  putResponse?: (payload: Record<string, unknown>) => Response
  onTaskList?: () => void | Promise<void>
  onTaskRead?: (path: string) => void | Promise<void>
  taskPage?: (page: number) => unknown
  subjectPage?: (page: number) => unknown
  assets?: Record<string, unknown>
}

/** A client whose transport serves one in-memory project and records every call. */
function clientFor(provider: FakeProvider): JubianClient {
  return new JubianClient({ credential: async () => 'token',
    fetch: async (url: string | URL | Request, init?: RequestInit) => {
      const path = (url as URL).toString().replace('https://web.jubianai.net/prod-api', '')
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : undefined
      const method = String(init?.method)
      provider.calls.push({ method, path, ...(body === undefined ? {} : { body }) })
      const answer = (data: unknown): Response => new Response(JSON.stringify({ code: 200, data }), { status: 200 })
      if (path.startsWith('/aigc/storyboard/') && method === 'GET') {
        return answer(provider.storyboards?.[path.split('/').pop() ?? ''] ?? provider.storyboard)
      }
      if (path === '/aigc/storyboard' && method === 'PUT') {
        const payload = body ?? {}
        // The provider stores 1 on every storyboard it holds, whatever the PUT body carried.
        const saved = { ...(provider.storyboards?.[String(payload.id)] ?? provider.storyboard),
          ...payload, isGenerate: 1 }
        provider.storyboard = saved
        if (provider.storyboards) provider.storyboards[String(payload.id)] = saved
        await provider.onPut?.(payload)
        return provider.putResponse?.(payload) ?? answer(null)
      }
      if (path.startsWith('/aigc/asset/') && method === 'GET') {
        return answer((provider.assets ?? ASSETS)[path.split('/').pop() ?? ''] ?? null)
      }
      if (path.startsWith('/aigc/material/list')) {
        if (provider.subjectPage) return answer(provider.subjectPage(Number(new URL(`https://example.test${path}`).searchParams.get('pageNum'))))
        return answer({ total: SUBJECT_ROWS.length, rows: SUBJECT_ROWS })
      }
      if (path.startsWith('/model/charge/getSelectList')) return answer(CATALOGUE)
      if (path.startsWith('/admin/aigc/video/task/list')) {
        await provider.onTaskList?.()
        await provider.onTaskRead?.(path)
        const query = new URL(`https://example.test${path}`).searchParams
        const page = Number(query.get('pageNum') ?? 1)
        const size = Number(query.get('pageSize') ?? 100)
        if (provider.taskPage) return answer(provider.taskPage(page))
        return answer({ total: provider.tasks.length, rows: provider.tasks.slice((page - 1) * size, page * size) })
      }
      if (path.startsWith('/admin/aigc/video/task/sub/list')) {
        await provider.onTaskRead?.(path)
        return answer({ total: 1, rows: provider.subtasks[String(body?.aigcVideoTaskId)] ?? [] })
      }
      if (path.startsWith('/admin/aigc/video/task/') && method === 'GET') {
        await provider.onTaskRead?.(path)
        const id = path.split('/').pop()
        return answer(provider.tasks.find(task => String(task.id) === id) ?? null)
      }
      return new Response(JSON.stringify({ code: 404, msg: 'unknown' }), { status: 404 })
    } })
}

let root: string
let ledger: JubianLedger
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'jubian-native-'))
  const ledgerRoot = join(root, 'ledger')
  await mkdir(ledgerRoot)
  await writeFile(join(ledgerRoot, 'authorization.json'), JSON.stringify({ version: 1, projects: {
    '2708': { limit: '1000', unit: 'CNY', estimates: { storyboard_native_submit: '1' } },
  } }))
  ledger = new JubianLedger({ root: ledgerRoot })
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/** Create one project directory the flows accept as a bound project. */
async function project(scriptId = 2708, name = 'project'): Promise<string> {
  const directory = join(root, name)
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'project_config.json'), JSON.stringify({ jubian_script_id: scriptId }), 'utf8')
  return directory
}

const putCalls = (provider: FakeProvider): typeof provider.calls =>
  provider.calls.filter(call => call.method === 'PUT')

describe('selection-only save', () => {
  const selections = [{ material_key: 'lead', asset_id: 81285 }, { material_key: 'guest', asset_id: 83670 }]
  it('refuses an empty serialized selection before any PUT', async () => {
    const provider: FakeProvider = { calls: [], storyboard: STORYBOARD, tasks: [], subtasks: {} }
    await expect(selectAssetsMethod(clientFor(provider), ledger,
      { storyboard_id: 916953, idempotency_key: 'empty', selections: [] })).rejects.toThrow()
    expect(putCalls(provider)).toEqual([])
  })

  it('audits preexisting related tasks and reports a newly created task as a billing violation', async () => {
    const provider: FakeProvider = { calls: [], tasks: [{ id: 1, scriptId: 2708, storyboardId: 999999 },
      { id: 2, scriptId: 2708, storyboardId: 916953 }], subtasks: {},
    storyboard: { ...STORYBOARD, storyboardMaterialList: [...MATERIALS].reverse() } }
    provider.onPut = () => { provider.tasks.push({ id: 3, scriptId: 2708, storyboardId: 916953 }) }
    expect(await selectAssetsMethod(clientFor(provider), ledger,
      { storyboard_id: 916953, idempotency_key: 'free-selection', selections }))
      .toMatchObject({ status: 'billing_safety_violation', applied: true, paid_requests: 0 })
    expect(putCalls(provider)).toHaveLength(1)
    expect(putCalls(provider)[0]!.body).toMatchObject({ isGenerate: 0 })
  })

  it('checks the saved material order and reads inline model config after selection', async () => {
    const provider: FakeProvider = { calls: [], tasks: [], subtasks: {},
      storyboard: { ...STORYBOARD, modelConfig: MODEL_CONFIG, storyboardMaterialList: [...MATERIALS].reverse() } }
    provider.onPut = () => {
      if (typeof provider.storyboard.modelConfig === 'string') {
        provider.storyboard.modelConfig = JSON.parse(provider.storyboard.modelConfig)
      }
    }
    expect(await selectAssetsMethod(clientFor(provider), ledger,
      { storyboard_id: 916953, idempotency_key: 'inline-selection', selections })).toMatchObject({ status: 'applied' })
    expect(await selectAssetsMethod(clientFor(provider), ledger,
      { storyboard_id: 916953, idempotency_key: 'already-selection', selections }))
      .toMatchObject({ status: 'already_applied', applied: false })
    expect(putCalls(provider)).toHaveLength(1)
    provider.storyboard = { ...STORYBOARD, storyboardMaterialList: [...MATERIALS].reverse() }
    provider.onPut = () => { provider.storyboard.storyboardMaterialList = [...MATERIALS].reverse() }
    await expect(selectAssetsMethod(clientFor(provider), ledger,
      { storyboard_id: 916953, idempotency_key: 'broken-selection-readback', selections })).rejects.toThrow('POST_PUT_VERIFY_MISMATCH')
  })
})

it.each([0, -1, 1.5, NaN, Infinity, '', 'x', null, false, {}, [], '9007199254740992'])
('refuses an invalid serialized project or storyboard identity %j', (value) => {
  expect(() => positiveInteger(value)).toThrow(expect.objectContaining({ code: 'CONTRACT_CHANGED' }))
})

it('accepts trimmed decimal identities and a BOM-prefixed project binding', async () => {
  expect(positiveInteger(' 2708 ')).toBe(2708)
  const directory = await project()
  await writeFile(join(directory, 'project_config.json'), '\uFEFF{"jubian_script_id":"2708"}')
  expect(await validateProjectBinding(directory, ' 2708 ')).toEqual({ project_root: directory, script_id: 2708 })
  await writeFile(join(directory, 'project_config.json'), '{broken')
  await expect(validateProjectBinding(directory, 2708)).rejects.toMatchObject({ code: 'CONTRACT_CHANGED' })
})

it.each([
  { label: 'wrong storyboard', board: { ...STORYBOARD, id: 1 }, rows: SUBJECT_ROWS, assets: ASSETS },
  { label: 'wrong parent identity', board: STORYBOARD, rows: SUBJECT_ROWS, assets: { ...ASSETS, '81285': { ...ASSETS['81285'], id: 1 } } },
  { label: 'foreign parent project', board: STORYBOARD, rows: SUBJECT_ROWS, assets: { ...ASSETS, '81285': { ...ASSETS['81285'], scriptId: 1 } } },
  { label: 'missing subject row', board: STORYBOARD, rows: SUBJECT_ROWS.slice(1), assets: ASSETS },
  { label: 'duplicate subject row', board: STORYBOARD, rows: [...SUBJECT_ROWS, SUBJECT_ROWS[0]], assets: ASSETS },
  { label: 'foreign subject project', board: STORYBOARD, rows: [{ ...SUBJECT_ROWS[0], scriptId: 1 }, SUBJECT_ROWS[1]], assets: ASSETS },
  { label: 'unused subject', board: STORYBOARD, rows: [{ ...SUBJECT_ROWS[0], isUsed: 0 }, SUBJECT_ROWS[1]], assets: ASSETS },
  { label: 'inactive subject', board: STORYBOARD, rows: [{ ...SUBJECT_ROWS[0], hsAssetStatus: 'pending' }, SUBJECT_ROWS[1]], assets: ASSETS },
  { label: 'absent subject status', board: STORYBOARD, rows: [{ ...SUBJECT_ROWS[0], hsAssetStatus: null }, SUBJECT_ROWS[1]], assets: ASSETS },
  { label: 'missing official identity', board: STORYBOARD, rows: [{ ...SUBJECT_ROWS[0], hsAssetId: null }, SUBJECT_ROWS[1]], assets: ASSETS },
  { label: 'mismatched official URL', board: STORYBOARD, rows: [{ ...SUBJECT_ROWS[0], assetUrl: URL_GUEST }, SUBJECT_ROWS[1]], assets: ASSETS },
  { label: 'missing parent URL', board: STORYBOARD, rows: SUBJECT_ROWS, assets: { ...ASSETS, '81285': { id: 81285, scriptId: 2708 } } },
  { label: 'missing material parent', board: { ...STORYBOARD,
    storyboardMaterialList: [{ ...MATERIALS[0], assetId: null, materialAssetId: null }, MATERIALS[1]] },
  rows: SUBJECT_ROWS, assets: ASSETS },
  { label: 'empty official identity', board: STORYBOARD,
    rows: [{ ...SUBJECT_ROWS[0], hsAssetId: ' ' }, SUBJECT_ROWS[1]], assets: ASSETS },
  { label: 'missing official URL', board: STORYBOARD,
    rows: [{ ...SUBJECT_ROWS[0], assetUrl: null }, SUBJECT_ROWS[1]], assets: ASSETS },
  { label: 'reused official identity', board: STORYBOARD, rows: [SUBJECT_ROWS[0], { ...SUBJECT_ROWS[1], hsAssetId: 'asset-lead' }], assets: ASSETS },
])('refuses $label while preparation is still free', async ({ board, rows, assets }) => {
  const provider: FakeProvider = { calls: [], storyboard: board, tasks: [], subtasks: {}, assets,
    subjectPage: () => ({ total: rows.length, rows }) }
  await expect(prepareVideoMethod(clientFor(provider), ledger,
    { storyboard_id: 916953, project_dir: await project() })).rejects.toMatchObject({ code: 'CONTRACT_CHANGED' })
  expect(putCalls(provider)).toEqual([])
  expect(await ledger.records()).toEqual([])
})

it('preserves numeric official identity and a string use flag while ignoring unrelated subject rows', async () => {
  const storyboard = { ...STORYBOARD, storyboardMaterialList: [{ ...MATERIALS[0], assetId: 11 }, MATERIALS[1]] }
  const provider: FakeProvider = { calls: [], storyboard, tasks: [], subtasks: {},
    assets: { ...ASSETS, '81285': { ...ASSETS['81285'], url: URL_LEAD } },
    subjectPage: () => ({ rows: [{}, { assetId: '' }, { assetId: 999999 },
      { ...SUBJECT_ROWS[0], hsAssetId: 11, isUsed: ' 1 ' }, SUBJECT_ROWS[1]] }) }
  expect(await prepareVideoMethod(clientFor(provider), ledger, { storyboard_id: 916953, project_dir: await project() }))
    .toMatchObject({ status: 'prepared' })
  expect(putCalls(provider)).toEqual([])
})

describe('uploaded voice references', () => {
  it.each([undefined, null])('reports unavailable saved audio duration %s without inventing measurement', async (audioDuration) => {
    const audio = { materialType: 'audio', materialUrl: 'https://media.example/voice.wav',
      materialKey: 'voice-lead', fileName: '陆沉舟声线', sortOrder: 1, audioDuration }
    const provider: FakeProvider = { calls: [], tasks: [], subtasks: {}, storyboard: { ...STORYBOARD,
      storyboardMaterialList: [...MATERIALS, audio], modelConfig: JSON.stringify({ ...MODEL_CONFIG,
        prompt: `${PROMPT} 声音 @[陆沉舟声线](voice-lead)` }) } }
    expect(await prepareVideoMethod(clientFor(provider), ledger,
      { storyboard_id: 916953, project_dir: await project() }))
      .toMatchObject({ audio_references: [{ duration_seconds: null, duration_basis: 'unavailable', duration_verified: false }] })
  })
  it('prepares existing audio without a numeric parent lookup or a remote write', async () => {
    const audio = { materialType: 'audio', materialUrl: 'https://jubian-aigc.tos-cn-beijing.volces.com/prod/voice.wav',
      materialKey: 'voice-lead', fileName: '陆沉舟声线', sortOrder: 1, audioDuration: 2 }
    const provider: FakeProvider = { calls: [], tasks: [], subtasks: {}, storyboard: { ...STORYBOARD,
      storyboardMaterialList: [...MATERIALS, audio], modelConfig: JSON.stringify({ ...MODEL_CONFIG,
        prompt: `${PROMPT} 声音 @[陆沉舟声线](voice-lead)` }) } }
    const result = await prepareVideoMethod(clientFor(provider), ledger, { storyboard_id: 916953,
      project_dir: await project() })
    expect(result.status).toBe('prepared')
    expect(putCalls(provider)).toHaveLength(0)
    expect(provider.calls.filter(call => call.path.startsWith('/aigc/asset/'))).toHaveLength(2)
  })
})

/** A manually released barrier for provider requests in concurrency tests. */
function barrier(): { promise: Promise<void>; release: () => void } {
  let release = () => {}
  const promise = new Promise<void>((resolve) => { release = resolve })
  return { promise, release }
}

/** Fail a missing readiness signal while leaving the test enough time to release its barriers. */
async function ready(promise: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([promise, new Promise<void>((_, reject) => {
      timer = setTimeout(() => { reject(new Error('provider barrier did not become ready')) }, 2000)
    })])
  } finally { if (timer !== undefined) clearTimeout(timer) }
}

describe('prepare_video', () => {
  it('refuses empty subjects without creating a preview or reserving a write', async () => {
    const provider: FakeProvider = { calls: [], tasks: [], subtasks: {}, storyboard: { ...STORYBOARD,
      storyboardMaterialList: [], modelConfig: JSON.stringify({ ...MODEL_CONFIG, prompt: 'A quiet street' }) } }
    const directory = await project()
    await expect(prepareVideoMethod(clientFor(provider), ledger, { storyboard_id: 916953, project_dir: directory }))
      .rejects.toMatchObject({ code: 'INVALID_ARGUMENT',
        detail: '缺少视频主体素材：当前主体视频模式至少需要一张已绑定的图片主体。本次调用尚未进入账本，尚未发出远端付费请求。' })
    expect(await readdir(directory)).toEqual(['project_config.json'])
    expect(await ledger.records()).toEqual([])
    expect(provider.calls.every(call => call.method === 'GET')).toBe(true)
  })

  it('reads a repeated parent once and refuses conflicting material identity before writing a preview', async () => {
    const provider: FakeProvider = { calls: [], tasks: [], subtasks: {}, storyboard: { ...STORYBOARD,
      storyboardMaterialList: [MATERIALS[0], { ...MATERIALS[1], materialAssetId: 81285 }] } }
    await expect(prepareVideoMethod(clientFor(provider), ledger,
      { storyboard_id: 916953, project_dir: await project() })).rejects.toMatchObject({ code: 'CONTRACT_CHANGED' })
    expect(provider.calls.filter(call => call.path.startsWith('/aigc/asset/'))).toHaveLength(1)
    expect(putCalls(provider)).toEqual([])
  })
  it.each([
    { label: 'unreadable page', page: () => ({ total: 1, rows: null }) },
    { label: 'nonobject row', page: () => [null] },
    { label: 'negative total', page: () => ({ total: -1, rows: [] }) },
    { label: 'overflowing total', page: () => ({ total: 1, rows: SUBJECT_ROWS }) },
    { label: 'empty incomplete page', page: () => ({ total: 3, rows: [] }) },
    { label: 'changing total', page: (page: number) => ({ total: page === 1 ? 3 : 4, rows: SUBJECT_ROWS }) },
    { label: 'page limit', page: () => Array.from({ length: 100 }, (_, id) => ({ id, assetId: 999999 })) },
  ])('refuses a subject inventory with $label before writing a preview', async ({ page }) => {
    const provider: FakeProvider = { calls: [], storyboard: STORYBOARD, tasks: [], subtasks: {}, subjectPage: page }
    const directory = await project()
    await expect(prepareVideoMethod(clientFor(provider), ledger, { storyboard_id: 916953, project_dir: directory }))
      .rejects.toMatchObject({ code: 'CONTRACT_CHANGED' })
    await expect(readFile(join(directory, 'video_tasks', 'preview'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(putCalls(provider)).toEqual([])
  })

  it('accepts a list alias containing a complete subject inventory', async () => {
    const provider: FakeProvider = { calls: [], storyboard: STORYBOARD, tasks: [], subtasks: {},
      subjectPage: () => ({ total: 2, list: SUBJECT_ROWS }) }
    expect(await prepareVideoMethod(clientFor(provider), ledger,
      { storyboard_id: 916953, project_dir: await project() })).toMatchObject({ status: 'prepared' })
  })
  it('requires explicit reselection after marker labels change even when their keys stay the same', async () => {
    const provider: FakeProvider = { calls: [], storyboard: structuredClone(STORYBOARD), tasks: [], subtasks: {} }
    const directory = await project()
    const oldConfig = JSON.parse(String(provider.storyboard.modelConfig)) as Record<string, unknown>
    const prompt = String(oldConfig.prompt).replace(/@\[([^\]]+)\]\(lead\)/, '@[另一称呼](lead)')
    const plan = await storyboardEditMethod(clientFor(provider), ledger, { method: 'edit_preview',
      project_dir: directory, script_id: 2708, storyboard_id: 916953, changes: { prompt } }, { concurrency: 2, maxItems: 10 })
    expect(await storyboardEditMethod(clientFor(provider), ledger, { method: 'edit_apply',
      project_dir: directory, script_id: 2708, preview_path: String(plan.preview_path),
      idempotency_key: String(plan.fingerprint) }, { concurrency: 2, maxItems: 10 })).toMatchObject({ status: 'needs_reselect' })
    await expect(prepareVideoMethod(clientFor(provider), ledger, { storyboard_id: 916953, project_dir: directory }))
      .rejects.toThrow('select_assets')
    provider.storyboard = { ...provider.storyboard, modelConfig: JSON.stringify({ ...oldConfig,
      prompt: `${prompt}；改动动作但保留标记` }) }
    await expect(prepareVideoMethod(clientFor(provider), ledger, { storyboard_id: 916953, project_dir: directory }))
      .rejects.toThrow('select_assets')
    await selectAssetsMethod(clientFor(provider), ledger, { storyboard_id: 916953, idempotency_key: 'reselect-label',
      selections: [{ material_key: 'lead', asset_id: 81285 }, { material_key: 'guest', asset_id: 83670 }] })
    expect(typeof (await prepareVideoMethod(clientFor(provider), ledger, { storyboard_id: 916953, project_dir: directory })).preview_path)
      .toBe('string')
  })
  it('writes one atomic preview under video_tasks and sends no PUT', async () => {
    const provider: FakeProvider = { calls: [], storyboard: STORYBOARD, tasks: [], subtasks: {} }
    const directory = await project()
    const result = await prepareVideoMethod(clientFor(provider), ledger, { storyboard_id: 916953,
      project_dir: directory })
    expect(putCalls(provider)).toHaveLength(0)
    expect(result.preview_path).toBe(join(directory, 'video_tasks',
      `storyboard-916953-${String(result.idempotencyKey).slice(0, 12)}.storyboard-native.prepared.json`))
    expect(result.content_duration_ms).toBe(7000)
    const written = JSON.parse(await readFile(String(result.preview_path), 'utf8')) as Record<string, unknown>
    expect(written.operation).toBe('prepare_storyboard_native_video')
    expect((written.payload as Record<string, unknown>).isGenerate).toBe(1)
    expect(provider.calls.every(call => call.method === 'GET')).toBe(true)
  })

  it('prepares repeated Prompt references without adding duplicate bound assets or sending PUT', async () => {
    const prompt = `${PROMPT}；再次出现 @[陆沉舟](lead) 和 @[苏晚](guest)`
    const provider: FakeProvider = { calls: [], storyboard: { ...STORYBOARD,
      modelConfig: JSON.stringify({ ...MODEL_CONFIG, prompt }) }, tasks: [], subtasks: {} }
    const result = await prepareVideoMethod(clientFor(provider), ledger, { storyboard_id: 916953,
      project_dir: await project() })
    const preview = JSON.parse(await readFile(String(result.preview_path), 'utf8')) as NativeVideoPreview
    expect(result.status).toBe('prepared')
    expect(preview.assetSummary.orderedAssets.map(asset => asset.materialKey)).toEqual(['lead', 'guest'])
    expect((JSON.parse(String(preview.payload.modelConfig)) as { prompt: string }).prompt).toBe(prompt)
    expect(putCalls(provider)).toEqual([])
    expect(await ledger.records()).toEqual([])
  })

  it.each([
    { label: 'wrong first-seen order', prompt: '@[苏晚](guest) @[陆沉舟](lead) @[苏晚](guest)' },
    { label: 'unknown marker', prompt: '@[陆沉舟](lead) @[未知](unknown) @[苏晚](guest)' },
  ])('rejects $label locally before writing a preview or sending PUT', async ({ prompt }) => {
    const provider: FakeProvider = { calls: [], storyboard: { ...STORYBOARD,
      modelConfig: JSON.stringify({ ...MODEL_CONFIG, prompt }) }, tasks: [], subtasks: {} }
    const directory = await project()
    const preparation = prepareVideoMethod(clientFor(provider), ledger, { storyboard_id: 916953,
      project_dir: directory })
    await expect(preparation).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    await expect(preparation).rejects.toThrow('PREPARE_VIDEO_IMAGE_MARKER_MISMATCH')
    expect(await readdir(directory)).toEqual(['project_config.json'])
    expect(await ledger.records()).toEqual([])
    expect(putCalls(provider)).toEqual([])
  })

  it('refuses a project bound to another scriptId and writes nothing', async () => {
    const provider: FakeProvider = { calls: [], storyboard: STORYBOARD, tasks: [], subtasks: {} }
    const directory = await project(1, 'foreign')
    await expect(prepareVideoMethod(clientFor(provider), ledger, { storyboard_id: 916953,
      project_dir: directory })).rejects.toThrow()
    await expect(readFile(join(directory, 'video_tasks', 'x'), 'utf8')).rejects.toThrow()
  })

  it('refuses a project directory without project_config.json', async () => {
    const provider: FakeProvider = { calls: [], storyboard: STORYBOARD, tasks: [], subtasks: {} }
    const directory = join(root, 'bare')
    await mkdir(directory, { recursive: true })
    await expect(prepareVideoMethod(clientFor(provider), ledger, { storyboard_id: 916953,
      project_dir: directory })).rejects.toThrow()
  })

  it('refuses a caller-supplied duration that disagrees with the live snapshot', async () => {
    const provider: FakeProvider = { calls: [], storyboard: STORYBOARD, tasks: [], subtasks: {} }
    const directory = await project()
    await expect(prepareVideoMethod(clientFor(provider), ledger, { storyboard_id: 916953, project_dir: directory,
      content_duration_ms: 12000 })).rejects.toThrow()
  })
})

describe('submit_video', () => {
  it('rejects a historical empty preview without ledger writes or any HTTP request', async () => {
    const provider: FakeProvider = { calls: [], storyboard: STORYBOARD, tasks: [], subtasks: {} }
    const { previewPath } = await prepared(provider)
    const preview = JSON.parse(await readFile(previewPath, 'utf8')) as NativeVideoPreview
    preview.payload.storyboardMaterialList = []
    preview.payload.modelConfig = JSON.stringify({ ...MODEL_CONFIG, prompt: 'A quiet street', materialList: [] })
    preview.assetSummary = { count: 0, orderedAssets: [] }
    preview.idempotencyKey = stableSha256(submissionSemantics(preview.payload))
    const serialized = JSON.stringify(preview)
    await writeFile(previewPath, serialized)
    await expect(submitVideoMethod(clientFor(provider), ledger, { preview_path: previewPath,
      idempotency_key: preview.idempotencyKey })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT',
      detail: '缺少视频主体素材：当前主体视频模式至少需要一张已绑定的图片主体。本次调用尚未进入账本，尚未发出远端付费请求。' })
    expect(provider.calls).toEqual([])
    expect(await ledger.records()).toEqual([])
    expect(await readFile(previewPath, 'utf8')).toBe(serialized)
  })

  /** One prepared project, ready to be submitted against. */
  interface Prepared {
    directory: string
    previewPath: string
    idempotencyKey: string
  }

  /** Prepare a project and then submit against it, recording what the provider saw. */
  async function prepared(provider: FakeProvider): Promise<Prepared> {
    const directory = await project()
    const preview = await prepareVideoMethod(clientFor(provider), ledger, { storyboard_id: 916953,
      project_dir: directory })
    provider.calls.length = 0
    return { directory, previewPath: String(preview.preview_path),
      idempotencyKey: String(preview.idempotencyKey) }
  }

  it.each(['inline', 'empty-prompt', 'nontext-prompt'])('refuses malformed stored replay evidence %s without sending', async (kind) => {
    const provider: FakeProvider = { calls: [], storyboard: STORYBOARD, tasks: [], subtasks: {} }
    const preparedFile = await prepared(provider)
    const preview = JSON.parse(await readFile(preparedFile.previewPath, 'utf8')) as {
      payload: Record<string, unknown>
      idempotencyKey: string
    }
    const config = JSON.parse(String(preview.payload.modelConfig)) as Record<string, unknown>
    if (kind !== 'inline') config.prompt = kind === 'empty-prompt' ? '' : 12
    preview.payload.modelConfig = kind === 'inline' ? config : JSON.stringify(config)
    preview.idempotencyKey = stableSha256(submissionSemantics(preview.payload))
    await writeFile(preparedFile.previewPath, JSON.stringify(preview))
    await ledger.begin({ idempotencyKey: preview.idempotencyKey, method: 'storyboard_native_submit',
      scriptId: 2708, requestSha256: bodyHash(preview.payload), quotedAmount: '1.00', quoteUnit: 'CNY' })
    await expect(submitVideoMethod(clientFor(provider), ledger,
      { preview_path: preparedFile.previewPath, idempotency_key: preview.idempotencyKey }))
      .rejects.toMatchObject({ code: 'CONTRACT_CHANGED' })
    expect(putCalls(provider)).toEqual([])
  })

  it('claims matching child identity even when the provider has not supplied a task status', async () => {
    const provider: FakeProvider = { calls: [], storyboard: STORYBOARD, tasks: [], subtasks: {} }
    const preview = await prepared(provider)
    provider.onPut = (payload) => {
      provider.tasks = [{ id: 335343, scriptId: 2708, storyboardId: 916953, taskType: 1 }]
      provider.subtasks['335343'] = [childOf(payload, { taskStatus: '' })]
    }
    expect(await submitVideoMethod(clientFor(provider), ledger,
      { preview_path: preview.previewPath, idempotency_key: preview.idempotencyKey }))
      .toMatchObject({ status: 'submitted', task_status: null })
  })

  it.each([
    { label: 'negative total', page: () => ({ total: -1, rows: [] }) },
    { label: 'duplicate IDs', page: () => ({ total: 2, rows: [{ id: 1 }, { id: 1 }] }) },
    { label: 'more rows than total', page: () => ({ total: 1, rows: [{ id: 1 }, { id: 2 }] }) },
    { label: 'short incomplete page', page: () => ({ total: 2, rows: [{ id: 1 }] }) },
    { label: 'changing total', page: (page: number) => ({ total: page === 1 ? 200 : 201,
      rows: Array.from({ length: 100 }, (_, index) => ({ id: page * 100 + index, storyboardId: 999999 })) }) },
    { label: 'page limit', page: (page: number) => Array.from({ length: 100 }, (_, index) =>
      ({ id: page * 100 + index, storyboardId: 999999 })) },
  ])('refuses a task inventory with $label before reserving or sending', async ({ page }) => {
    const provider: FakeProvider = { calls: [], storyboard: STORYBOARD, tasks: [], subtasks: {} }
    const preview = await prepared(provider)
    provider.taskPage = page
    await expect(submitVideoMethod(clientFor(provider), ledger,
      { preview_path: preview.previewPath, idempotency_key: preview.idempotencyKey })).rejects.toMatchObject({ code: 'CONTRACT_CHANGED' })
    expect(putCalls(provider)).toEqual([])
    expect(await ledger.records()).toEqual([])
  })

  it('accepts a short bare task page and rejects excess hydration of possibly related tasks', async () => {
    const provider: FakeProvider = { calls: [], storyboard: STORYBOARD, tasks: [], subtasks: {} }
    const preview = await prepared(provider)
    provider.taskPage = () => []
    expect(await submitVideoMethod(clientFor(provider), ledger,
      { preview_path: preview.previewPath, idempotency_key: preview.idempotencyKey }))
      .toMatchObject({ outcome: 'accepted', status: 'reconcile_required' })
    expect(putCalls(provider)).toHaveLength(1)
    provider.taskPage = page => ({ total: 101, rows: Array.from({ length: page === 1 ? 100 : 1 },
      (_, index) => ({ id: page * 100 + index, scriptId: 2708, taskType: 1 })) })
    await expect(submitVideoMethod(clientFor(provider), ledger,
      { preview_path: preview.previewPath, idempotency_key: preview.idempotencyKey })).rejects.toMatchObject({ code: 'CONTRACT_CHANGED' })
    expect(putCalls(provider)).toHaveLength(1)
  })

  it('refuses missing, corrupt, ambiguous and misplaced preview files before provider requests', async () => {
    const provider: FakeProvider = { calls: [], storyboard: STORYBOARD, tasks: [], subtasks: {} }
    const preview = await prepared(provider)
    await expect(submitVideoMethod(clientFor(provider), ledger, { project_dir: root,
      storyboard_id: 916953, idempotency_key: preview.idempotencyKey })).rejects.toThrow()
    await writeFile(join(preview.directory, 'video_tasks', 'storyboard-916953-second.storyboard-native.prepared.json'), '{}')
    await expect(submitVideoMethod(clientFor(provider), ledger, { project_dir: preview.directory,
      storyboard_id: 916953, idempotency_key: preview.idempotencyKey })).rejects.toThrow()
    const outside = join(root, 'outside.prepared.json')
    await writeFile(outside, await readFile(preview.previewPath))
    await expect(submitVideoMethod(clientFor(provider), ledger,
      { preview_path: outside, idempotency_key: preview.idempotencyKey })).rejects.toThrow()
    await writeFile(preview.previewPath, '{broken')
    await expect(submitVideoMethod(clientFor(provider), ledger,
      { preview_path: preview.previewPath, idempotency_key: preview.idempotencyKey })).rejects.toThrow()
    await expect(submitVideoMethod(clientFor(provider), ledger,
      { preview_path: preview.previewPath, idempotency_key: ' ' })).rejects.toThrow()
    expect(provider.calls).toEqual([])
  })

  it('reports reconciliation when an accepted PUT loses its post-submit snapshot', async () => {
    const provider: FakeProvider = { calls: [], storyboard: STORYBOARD, tasks: [], subtasks: {} }
    const preview = await prepared(provider)
    provider.onPut = () => { provider.onTaskRead = async () => { throw new Error('readback disconnected') } }
    expect(await submitVideoMethod(clientFor(provider), ledger,
      { preview_path: preview.previewPath, idempotency_key: preview.idempotencyKey }))
      .toMatchObject({ put_sent: true, outcome: 'accepted', status: 'reconcile_required', result_urls: [] })
    expect(putCalls(provider)).toHaveLength(1)
    expect(await ledger.find(preview.idempotencyKey)).toMatchObject({ outcome: 'accepted' })
  })

  it('reports what it read for every candidate when the preflight conflicts', async () => {
    const provider: FakeProvider = { calls: [], storyboard: STORYBOARD, tasks: [], subtasks: {} }
    const { previewPath, idempotencyKey } = await prepared(provider)
    // Two shapes of historical task whose only child lost its model evidence. The second
    // is the production one: the task row itself states no storyboard id, so the classifier
    // reads it as null and cannot exclude the task from this submission's candidates.
    provider.tasks = [
      { id: 400003, scriptId: 2708, storyboardId: 916953, taskType: 1, taskStatus: 'submit' },
      { id: 400004, scriptId: 2708, taskType: 1, taskStatus: 'submit' },
    ]
    const childWithoutModel = (taskId: number, childId: number) => ({ id: childId, aigcVideoTaskId: taskId,
      storyboardId: 916953, taskStatus: 'submit', imageMaterials: MATERIALS })
    provider.subtasks['400003'] = [childWithoutModel(400003, 1)]
    provider.subtasks['400004'] = [childWithoutModel(400004, 2)]
    const result = await submitVideoMethod(clientFor(provider), ledger, { preview_path: previewPath,
      idempotency_key: idempotencyKey })
    expect(putCalls(provider)).toHaveLength(0)
    expect(result).toMatchObject({ status: 'reconcile_conflict' })
    const candidates = result.candidates as Record<string, unknown>[]
    expect(candidates.find(candidate => candidate.task_id === '400003'))
      .toMatchObject({ storyboard_id_read: '916953', children: 1 })
    expect(candidates.find(candidate => candidate.task_id === '400004'))
      .toMatchObject({ storyboard_id_read: null, children: 1 })
  })

  it('names only the tasks the project did not have before the PUT', async () => {
    const provider: FakeProvider = { calls: [], storyboard: STORYBOARD, tasks: [], subtasks: {} }
    const { previewPath, idempotencyKey } = await prepared(provider)
    // Another storyboard's task already exists under this project. It appears in both
    // snapshots, so it was not created by this request and must not be named as new.
    const unrelated = { id: 400009, scriptId: 2708, storyboardId: 999999, taskType: 1, taskStatus: 'submit' }
    provider.tasks = [unrelated]
    provider.onPut = (payload) => {
      provider.tasks = [unrelated,
        { id: 335500, scriptId: 2708, storyboardId: 916953, taskType: 1, taskStatus: 'submit' }]
      provider.subtasks['335500'] = [childOf(payload, { aigcVideoTaskId: 335500,
        imageMaterials: MATERIALS.map(material => ({ ...material, materialName: 'other' })) })]
    }
    const result = await submitVideoMethod(clientFor(provider), ledger, { preview_path: previewPath,
      idempotency_key: idempotencyKey })
    expect(putCalls(provider)).toHaveLength(1)
    expect(result.new_task_ids).toEqual(['335500'])
    expect(result.before_task_ids).toEqual([])
  })

  it('reports an accepted PUT it could not claim as reconcile_required, naming the task it created', async () => {
    const provider: FakeProvider = { calls: [], storyboard: STORYBOARD, tasks: [], subtasks: {} }
    const { previewPath, idempotencyKey } = await prepared(provider)
    provider.onPut = (payload) => {
      provider.tasks = [{ id: 335500, scriptId: 2708, storyboardId: 916953, taskType: 1, taskStatus: 'submit' }]
      // The task exists and may already be billed, but its settled child repeats a
      // different identity: the claim conflicts even though the PUT was accepted.
      provider.subtasks['335500'] = [childOf(payload, { aigcVideoTaskId: 335500,
        imageMaterials: MATERIALS.map(material => ({ ...material, materialName: 'other' })) })]
    }
    const result = await submitVideoMethod(clientFor(provider), ledger, { preview_path: previewPath,
      idempotency_key: idempotencyKey })
    expect(putCalls(provider)).toHaveLength(1)
    expect(result).toMatchObject({ replayed: false, outcome: 'accepted', put_sent: true, put_outcome: 'accepted',
      status: 'reconcile_required', task_id: null, claim_status: 'reconcile_conflict', new_task_ids: ['335500'] })
    expect(String(result.next)).toContain('已被提供方受理')
  })

  it('submits exactly one PUT and claims the task it created', async () => {
    const provider: FakeProvider = { calls: [], storyboard: STORYBOARD, tasks: [], subtasks: {} }
    const { previewPath, idempotencyKey } = await prepared(provider)
    provider.onPut = (payload) => {
      provider.tasks = [{ id: 335343, scriptId: 2708, storyboardId: 916953, taskType: 1, taskStatus: 'submit' }]
      provider.subtasks['335343'] = [childOf(payload)]
    }
    const result = await submitVideoMethod(clientFor(provider), ledger, { preview_path: previewPath,
      idempotency_key: idempotencyKey })
    expect(putCalls(provider)).toHaveLength(1)
    expect(putCalls(provider)[0]?.body?.isGenerate).toBe(1)
    expect(result).toMatchObject({ replayed: false, outcome: 'accepted', status: 'submitted', task_id: '335343' })
    expect((await ledger.find(idempotencyKey))?.method).toBe('storyboard_native_submit')
  })

  it('submits preserved audio once and reconciles when the child loses its voice reference', async () => {
    const audio = { materialType: 'audio', materialUrl: 'https://jubian-aigc.tos-cn-beijing.volces.com/prod/voice.wav',
      materialKey: 'voice-lead', fileName: '陆沉舟声线', sortOrder: 1, audioDuration: 2 }
    const provider: FakeProvider = { calls: [], tasks: [], subtasks: {}, storyboard: { ...STORYBOARD,
      storyboardMaterialList: [...MATERIALS, audio], modelConfig: JSON.stringify({ ...MODEL_CONFIG,
        prompt: `${PROMPT} 陆沉舟声音 @[陆沉舟声线](voice-lead)` }) } }
    const { previewPath, idempotencyKey } = await prepared(provider)
    provider.onPut = (payload) => {
      provider.tasks = [{ id: 335343, scriptId: 2708, storyboardId: 916953, taskType: 1, taskStatus: 'submit' }]
      provider.subtasks['335343'] = [childOf(payload, { imageMaterials: MATERIALS,
        audioMaterials: [{ audioUrl: audio.materialUrl }] })]
    }
    const args = { preview_path: previewPath, idempotency_key: idempotencyKey }
    expect(await submitVideoMethod(clientFor(provider), ledger, args)).toMatchObject({ status: 'submitted' })
    expect(putCalls(provider)[0]?.body?.storyboardMaterialList).toEqual(expect.arrayContaining([audio]))
    const child = provider.subtasks['335343']?.[0]
    if (!child) throw new Error('Missing generated child')
    child.audioMaterials = []
    expect(await submitVideoMethod(clientFor(provider), ledger, args)).toMatchObject({
      replayed: true, status: 'reconcile_conflict',
    })
    expect(putCalls(provider)).toHaveLength(1)
  })

  it('never sends a second PUT for a key it already recorded, and reconciles instead', async () => {
    const provider: FakeProvider = { calls: [], storyboard: STORYBOARD, tasks: [], subtasks: {} }
    const { previewPath, idempotencyKey } = await prepared(provider)
    provider.onPut = (payload) => {
      provider.tasks = [{ id: 335343, scriptId: 2708, storyboardId: 916953, taskType: 1, taskStatus: 'submit' }]
      provider.subtasks['335343'] = [childOf(payload)]
    }
    await submitVideoMethod(clientFor(provider), ledger, { preview_path: previewPath,
      idempotency_key: idempotencyKey })
    const second: FakeProvider = { ...provider, calls: [],
      tasks: [{ id: 335343, scriptId: 2708, storyboardId: 916953, taskType: 1 }],
      subtasks: { 335343: [savedChild(provider)] } }
    const replayed = await submitVideoMethod(clientFor(second), ledger, { preview_path: previewPath,
      idempotency_key: idempotencyKey })
    expect(putCalls(second)).toHaveLength(0)
    expect(replayed).toMatchObject({ replayed: true, status: 'submitted', task_id: '335343' })
    expect(String(replayed.next)).toContain('不会再发送任何 PUT')
  })

  it('rejects a replay key recorded for a different method before any provider request', async () => {
    const provider: FakeProvider = { calls: [], storyboard: STORYBOARD, tasks: [], subtasks: {} }
    const { previewPath, idempotencyKey } = await prepared(provider)
    await ledger.begin({ idempotencyKey, method: 'image_generate', scriptId: 2708,
      requestSha256: 'sha256:unrelated' })
    await expect(submitVideoMethod(clientFor(provider), ledger, { preview_path: previewPath,
      idempotency_key: idempotencyKey })).rejects.toThrow('different video submission')
    expect(provider.calls).toEqual([])
  })

  it('treats a failed PUT as ambiguous, records unknown and still never resends', async () => {
    const provider: FakeProvider = { calls: [], storyboard: STORYBOARD, tasks: [], subtasks: {} }
    const { previewPath, idempotencyKey } = await prepared(provider)
    provider.onPut = () => { throw new Error('connection reset') }
    const result = await submitVideoMethod(clientFor(provider), ledger, { preview_path: previewPath,
      idempotency_key: idempotencyKey })
    expect(result).toMatchObject({ replayed: false, outcome: 'unknown', put_ambiguous: true })
    expect((await ledger.find(idempotencyKey))?.outcome).toBe('unknown')
    // The replay reads the storyboard the failed PUT already stored, and has no
    // PUT hook at all: an optional member is absent, never an explicit `undefined`.
    const second: FakeProvider = { calls: [], storyboard: provider.storyboard,
      tasks: [{ id: 335343, scriptId: 2708, storyboardId: 916953, taskType: 1 }],
      subtasks: { 335343: [savedChild(provider)] } }
    const replayed = await submitVideoMethod(clientFor(second), ledger, { preview_path: previewPath,
      idempotency_key: idempotencyKey })
    expect(putCalls(second)).toHaveLength(0)
    expect(replayed).toMatchObject({ replayed: true, status: 'submitted', task_id: '335343' })
  })

  it('reports a lost child identity as terminal instead of retrying', async () => {
    const provider: FakeProvider = { calls: [], storyboard: STORYBOARD, tasks: [], subtasks: {} }
    const { previewPath, idempotencyKey } = await prepared(provider)
    provider.onPut = (payload) => {
      provider.tasks = [{ id: 335470, scriptId: 2708, storyboardId: 916953, taskType: 1, taskStatus: 'failed' }]
      // Task 335470's failure mode: the child kept the URLs but lost the identity.
      provider.subtasks['335470'] = [childOf(payload, { imageMaterials: MATERIALS.map(material =>
        ({ materialUrl: material.materialUrl, materialType: 'image', sortOrder: material.sortOrder })) })]
    }
    const result = await submitVideoMethod(clientFor(provider), ledger, { preview_path: previewPath,
      idempotency_key: idempotencyKey })
    expect(putCalls(provider)).toHaveLength(1)
    expect(result.status).toBe('subject_identity_lost')
    expect(String(result.next)).toContain('终态')
  })

  it('reconciles a recorded key even after the storyboard has moved on', async () => {
    const provider: FakeProvider = { calls: [], storyboard: STORYBOARD, tasks: [], subtasks: {} }
    const { previewPath, idempotencyKey } = await prepared(provider)
    provider.onPut = (payload) => {
      provider.tasks = [{ id: 335343, scriptId: 2708, storyboardId: 916953, taskType: 1, taskStatus: 'submit' }]
      provider.subtasks['335343'] = [childOf(payload)]
    }
    await submitVideoMethod(clientFor(provider), ledger, { preview_path: previewPath,
      idempotency_key: idempotencyKey })
    // The operator edits the storyboard after the submission: reconciliation must
    // still answer, because it sends nothing.
    provider.storyboard = { ...provider.storyboard,
      modelConfig: JSON.stringify({ ...MODEL_CONFIG, prompt: '被改过的提示词' }) }
    const callsBefore = provider.calls.length
    const replayed = await submitVideoMethod(clientFor(provider), ledger, { preview_path: previewPath,
      idempotency_key: idempotencyKey })
    expect(putCalls(provider).length).toBe(1)
    expect(provider.calls.length).toBeGreaterThan(callsBefore)
    expect(replayed).toMatchObject({ replayed: true, status: 'submitted', task_id: '335343' })
  })

  it('refuses a stale preview whose live submission semantics changed', async () => {
    const provider: FakeProvider = { calls: [], storyboard: STORYBOARD, tasks: [], subtasks: {} }
    const { previewPath, idempotencyKey } = await prepared(provider)
    provider.storyboard = { ...provider.storyboard,
      modelConfig: JSON.stringify({ ...MODEL_CONFIG, prompt: `${PROMPT} 另外一位` }) }
    await expect(submitVideoMethod(clientFor(provider), ledger, { preview_path: previewPath,
      idempotency_key: idempotencyKey })).rejects.toThrow()
    expect(putCalls(provider)).toHaveLength(0)
    expect(await ledger.find(idempotencyKey)).toBeUndefined()
  })

  it('refuses a key that is not the preview fingerprint and sends nothing', async () => {
    const provider: FakeProvider = { calls: [], storyboard: STORYBOARD, tasks: [], subtasks: {} }
    const { previewPath } = await prepared(provider)
    await expect(submitVideoMethod(clientFor(provider), ledger, { preview_path: previewPath,
      idempotency_key: 'f'.repeat(64) })).rejects.toThrow()
    expect(provider.calls).toHaveLength(0)
  })

  it('refuses a submission with no idempotency key at all', async () => {
    const provider: FakeProvider = { calls: [], storyboard: STORYBOARD, tasks: [], subtasks: {} }
    const { previewPath } = await prepared(provider)
    await expect(submitVideoMethod(clientFor(provider), ledger, { preview_path: previewPath })).rejects.toThrow()
    expect(provider.calls).toHaveLength(0)
  })

  it('refuses to PUT when the pre-submit snapshot drifts between the two reads', async () => {
    const provider: FakeProvider = { calls: [], storyboard: STORYBOARD, tasks: [], subtasks: {} }
    const { previewPath, idempotencyKey } = await prepared(provider)
    let listCalls = 0
    const inner = clientFor(provider)
    const drifting = new JubianClient({ credential: async () => 'token',
      fetch: async (url: string | URL | Request, init?: RequestInit) => {
        const path = (url as URL).toString().replace('https://web.jubianai.net/prod-api', '')
        if (path.startsWith('/admin/aigc/video/task/list')) {
          listCalls += 1
          if (listCalls === 2) {
            provider.calls.push({ method: 'GET', path })
            return new Response(JSON.stringify({ code: 200, data: { total: 1,
              rows: [{ id: 999999, scriptId: 2708, storyboardId: 916953 }] } }), { status: 200 })
          }
        }
        const response = await inner.request({ method: (init?.method ?? 'GET') as 'GET', path,
          ...(typeof init?.body === 'string' ? { body: JSON.parse(init.body) as Record<string, unknown> } : {}) })
        return new Response(JSON.stringify({ code: 200, data: response.data }), { status: 200 })
      } })
    const result = await submitVideoMethod(drifting, ledger, { preview_path: previewPath,
      idempotency_key: idempotencyKey })
    expect(result).toMatchObject({ status: 'reconcile_required', outcome: 'unknown' })
    expect(putCalls(provider)).toHaveLength(0)
  })

  it('finds the only prepared preview when the caller names the project instead of the file', async () => {
    const provider: FakeProvider = { calls: [], storyboard: STORYBOARD, tasks: [], subtasks: {} }
    const { directory, idempotencyKey } = await prepared(provider)
    provider.onPut = (payload) => {
      provider.tasks = [{ id: 335343, scriptId: 2708, storyboardId: 916953, taskType: 1 }]
      provider.subtasks['335343'] = [childOf(payload)]
    }
    const result = await submitVideoMethod(clientFor(provider), ledger, { project_dir: directory,
      storyboard_id: 916953, idempotency_key: idempotencyKey })
    expect(result.status).toBe('submitted')
  })

  /**
   * Project 2708's real preflight shape: 50 video tasks that state no `storyboardId`,
   * each owning one child result that names another storyboard.
   */
  function otherStoryboards(count = 50): Pick<FakeProvider, 'tasks' | 'subtasks'> {
    const tasks = Array.from({ length: count }, (_, index) => ({ id: 324493 + index, scriptId: 2708,
      taskType: 1, taskStatus: 'succeeded' }))
    const subtasks = Object.fromEntries(tasks.map((task, index) => [String(task.id),
      [{ id: 900000 + index, aigcVideoTaskId: task.id, storyboardId: 1033895 + index,
        taskStatus: 'succeeded' }]]))
    return { tasks, subtasks }
  }

  /** The submitted child one task holds when it is this storyboard's own task. */
  async function ownChild(previewPath: string): Promise<Record<string, unknown>> {
    const preview = JSON.parse(await readFile(previewPath, 'utf8')) as { payload: Record<string, unknown> }
    return childOf(preview.payload)
  }

  it('excludes explicitly different episodes before the hydration cap on submit and replay', async () => {
    const provider: FakeProvider = { calls: [], storyboard: { ...STORYBOARD, episodeId: 46744 },
      ...otherStoryboards(101) }
    provider.tasks = provider.tasks.map(task => ({ ...task, episodeId: '46734' }))
    const { previewPath, idempotencyKey } = await prepared(provider)
    provider.onPut = (payload) => {
      provider.tasks.push({ id: 335343, scriptId: 2708, episodeId: 46744, taskType: 1 })
      provider.subtasks['335343'] = [childOf(payload)]
    }
    const args = { preview_path: previewPath, idempotency_key: idempotencyKey }
    expect(await submitVideoMethod(clientFor(provider), ledger, args)).toMatchObject({ status: 'submitted' })
    expect(await submitVideoMethod(clientFor(provider), ledger, args)).toMatchObject({ replayed: true, status: 'submitted' })
    expect(putCalls(provider)).toHaveLength(1)
    expect(provider.calls.filter(call => call.path.startsWith('/admin/aigc/video/task/sub/list'))
      .every(call => String(call.body?.aigcVideoTaskId) === '335343')).toBe(true)
  })

  it.each([undefined, null, '', 'unknown', false, {}, 0, -1, 1.5, '0', '9007199254740992', 46744, '46744'])
  ('retains the hydration cap for an unresolved or matching episode %j', async (episodeId) => {
    const provider: FakeProvider = { calls: [], storyboard: { ...STORYBOARD, episodeId: 46744 },
      ...otherStoryboards(101) }
    provider.tasks = provider.tasks.map(task => ({ ...task, episodeId }))
    const { previewPath, idempotencyKey } = await prepared(provider)
    await expect(submitVideoMethod(clientFor(provider), ledger, { preview_path: previewPath,
      idempotency_key: idempotencyKey })).rejects.toThrow()
    expect(putCalls(provider)).toHaveLength(0)
    expect(await ledger.find(idempotencyKey)).toBeUndefined()
  })

  it('never calls another storyboard\'s tasks unsafe candidates', async () => {
    const provider: FakeProvider = { calls: [], storyboard: STORYBOARD, ...otherStoryboards() }
    const { previewPath, idempotencyKey } = await prepared(provider)
    const result = await submitVideoMethod(clientFor(provider), ledger, { preview_path: previewPath,
      idempotency_key: idempotencyKey })
    // Every related row is still judged from its own detail and child results...
    const inspected = new Set(provider.calls.filter(call => call.path.startsWith('/admin/aigc/video/task/sub/list'))
      .map(call => String(call.body?.aigcVideoTaskId)))
    expect(inspected.size).toBe(50)
    // ...and none of them proves this storyboard, so the preflight is not a conflict.
    expect(result).toMatchObject({ replayed: false, outcome: 'accepted', status: 'reconcile_required' })
    expect(putCalls(provider)).toHaveLength(1)
  })

  it('reconciles to the one task whose child result names this storyboard', async () => {
    const provider: FakeProvider = { calls: [], storyboard: STORYBOARD, ...otherStoryboards() }
    const { previewPath, idempotencyKey } = await prepared(provider)
    provider.subtasks['324493'] = [await ownChild(previewPath)]
    const result = await submitVideoMethod(clientFor(provider), ledger, { preview_path: previewPath,
      idempotency_key: idempotencyKey })
    expect(putCalls(provider)).toHaveLength(0)
    expect(result).toMatchObject({ status: 'already_submitted', task_id: '324493' })
  })

  it('still calls two tasks of this storyboard a conflict', async () => {
    const provider: FakeProvider = { calls: [], storyboard: STORYBOARD, ...otherStoryboards() }
    const { previewPath, idempotencyKey } = await prepared(provider)
    const child = await ownChild(previewPath)
    provider.subtasks['324493'] = [child]
    provider.subtasks['324494'] = [child]
    const result = await submitVideoMethod(clientFor(provider), ledger, { preview_path: previewPath,
      idempotency_key: idempotencyKey })
    expect(putCalls(provider)).toHaveLength(0)
    expect(result).toMatchObject({ status: 'reconcile_conflict', task_id: null })
  })
})

describe('submit_video_batch', () => {
  const second = { ...STORYBOARD, id: 916954, storyboardName: '第1集-分镜2' }

  it('accepts up to 100 listed previews by default and bounds provider PUT concurrency', () => {
    expect(resolveVideoBatchOptions()).toEqual({ concurrency: 3, maxItems: 100 })
  })

  async function batch(count = 2): Promise<{ provider: FakeProvider
    items: { preview_path: string
      idempotency_key: string }[] }> {
    const ids = Array.from({ length: count }, (_, index) => 916953 + index)
    const storyboards = Object.fromEntries(ids.map(id => [String(id),
      { ...STORYBOARD, id, storyboardName: `第1集-分镜${id - 916952}` }]))
    const provider: FakeProvider = { calls: [], storyboard: STORYBOARD,
      storyboards, tasks: [], subtasks: {} }
    const directory = await project()
    const previews = await Promise.all(ids.map(storyboard_id =>
      prepareVideoMethod(clientFor(provider), ledger, { storyboard_id, project_dir: directory })))
    provider.calls.length = 0
    return { provider, items: previews.map(preview => ({ preview_path: String(preview.preview_path),
      idempotency_key: String(preview.idempotencyKey) })) }
  }

  it.each([{ videoBatchConcurrency: 0 }, { videoBatchConcurrency: 9 }, { videoBatchConcurrency: 1.5 },
    { videoBatchMaxItems: 0 }, { videoBatchMaxItems: 101 }, { videoBatchMaxItems: 1.5 }])
  ('rejects invalid configured batch bounds %j', (config) => {
    expect(() => resolveVideoBatchOptions(config)).toThrow('videoBatchConcurrency')
  })

  it('rejects missing, empty and oversized batches before reading previews', async () => {
    const { provider, items } = await batch()
    for (const args of [{}, { items: [] }, { items }]) {
      await expect(submitVideoBatchMethod(clientFor(provider), ledger, args, { concurrency: 1, maxItems: 1 }))
        .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    }
    await expect(submitVideoBatchMethod(clientFor(provider), ledger,
      { items: [{ ...items[0]!, preview_path: join(root, 'missing-preview') }] })).rejects.toThrow('Unreadable video preview')
    expect(provider.calls).toEqual([])
  })

  it('rejects a batch spanning different project directories', async () => {
    const { provider, items } = await batch()
    const other = await project(2708, 'other-project'), directory = join(other, 'video_tasks')
    await mkdir(directory)
    const copied = join(directory, 'copied.storyboard-native.prepared.json')
    await writeFile(copied, await readFile(items[1]!.preview_path))
    await expect(submitVideoBatchMethod(clientFor(provider), ledger,
      { items: [items[0]!, { ...items[1]!, preview_path: copied }] })).rejects.toThrow('one project')
    expect(provider.calls).toEqual([])
  })

  it.each(['method', 'project', 'request'] as const)('refuses a recorded %s conflict before live reads', async (conflict) => {
    const { provider, items } = await batch()
    const preview = JSON.parse(await readFile(items[0]!.preview_path, 'utf8')) as { payload: Record<string, unknown> }
    const { bodyHash } = await import('../src/write.ts')
    await ledger.begin({ idempotencyKey: items[0]!.idempotency_key,
      method: conflict === 'method' ? 'asset_register' : 'storyboard_native_submit',
      scriptId: conflict === 'project' ? 1 : 2708,
      requestSha256: conflict === 'request' ? 'sha256:different' : bodyHash(preview.payload) })
    await expect(submitVideoBatchMethod(clientFor(provider), ledger, { items })).rejects.toThrow('different video submission')
    expect(provider.calls).toEqual([])
  })

  it('refuses a partly recorded batch and reconciles all recorded intents without new PUTs', async () => {
    const { provider, items } = await batch()
    const { bodyHash } = await import('../src/write.ts')
    for (const [index, item] of items.entries()) {
      const preview = JSON.parse(await readFile(item.preview_path, 'utf8')) as { payload: Record<string, unknown> }
      await ledger.begin({ idempotencyKey: item.idempotency_key, method: 'storyboard_native_submit',
        scriptId: 2708, requestSha256: bodyHash(preview.payload), quotedAmount: '1.00', quoteUnit: 'CNY' })
      if (index === 0) await expect(submitVideoBatchMethod(clientFor(provider), ledger, { items })).rejects.toThrow('partially recorded')
    }
    const result = await submitVideoBatchMethod(clientFor(provider), ledger, { items })
    expect(result).toMatchObject({ submitted: 0, reconcile_required: 2 })
    expect(result.results.map(row => row.outcome)).toEqual(['unknown', 'unknown'])
    expect(putCalls(provider)).toEqual([])
  })

  it('refuses a prior remote task and a missing per-item price without reserving', async () => {
    const { provider, items } = await batch()
    provider.tasks = [{ id: 123, scriptId: 2708, storyboardId: 916953, taskType: 1 }]
    await expect(submitVideoBatchMethod(clientFor(provider), ledger, { items })).rejects.toThrow('prior or ambiguous')
    provider.tasks = []
    await writeFile(join(ledger.root, 'authorization.json'), JSON.stringify({ version: 1,
      projects: { '2708': { limit: '1000', unit: 'CNY' } } }))
    await expect(submitVideoBatchMethod(clientFor(provider), ledger, { items })).rejects.toMatchObject({ code: 'BUDGET_EXCEEDED' })
    expect(putCalls(provider)).toEqual([])
    expect(await ledger.records()).toEqual([])
  })

  it('keeps accepted writes unresolved when early and final task reads disconnect', async () => {
    const { provider, items } = await batch()
    provider.onPut = () => { provider.onTaskRead = async () => { throw new Error('task reads disconnected') } }
    expect(await submitVideoBatchMethod(clientFor(provider), ledger, { items }))
      .toMatchObject({ submitted: 0, reconcile_required: 2 })
    expect(putCalls(provider)).toHaveLength(2)
    expect((await ledger.records()).map(row => row.outcome)).toEqual(['accepted', 'accepted'])
  })

  it('preserves intents when settlement storage fails after an accepted batch PUT', async () => {
    const { provider, items } = await batch()
    class FailingSettlement extends JubianLedger {
      override async settle(): Promise<void> { throw new Error('storage unavailable') }
    }
    const broken = new FailingSettlement({ root: ledger.root })
    expect(await submitVideoBatchMethod(clientFor(provider), broken, { items }))
      .toMatchObject({ submitted: 0, reconcile_required: 2 })
    expect((await ledger.records()).map(row => row.outcome)).toEqual([null, null])
    await submitVideoBatchMethod(clientFor(provider), broken, { items })
    expect(putCalls(provider)).toHaveLength(2)
  })

  it('does not claim an unrelated historical task with no storyboard identity', async () => {
    const { provider, items } = await batch()
    provider.tasks = [{ id: 123, scriptId: 2708, taskType: 1 }]
    expect(await submitVideoBatchMethod(clientFor(provider), ledger, { items }))
      .toMatchObject({ submitted: 0, reconcile_required: 2 })
    expect(putCalls(provider)).toHaveLength(2)
  })

  it('retains reconciliation when the final list works but related task details fail', async () => {
    const { provider, items } = await batch()
    provider.onPut = (payload) => {
      provider.tasks.push({ id: Number(payload.id) + 100000, scriptId: 2708, taskType: 1 })
      provider.onTaskRead = async (path) => {
        if (!path.includes('/task/list')) throw new Error('task detail disconnected')
      }
    }
    expect(await submitVideoBatchMethod(clientFor(provider), ledger, { items }))
      .toMatchObject({ submitted: 0, reconcile_required: 2 })
    expect(putCalls(provider)).toHaveLength(2)
  })

  it('refuses a batch total outside safe numeric range even if each reservation is individually valid', async () => {
    const { provider, items } = await batch()
    await writeFile(join(ledger.root, 'authorization.json'), JSON.stringify({ version: 1,
      projects: { '2708': { limit: '90071992547409.90', unit: 'CNY', estimates: { storyboard_native_submit: '60000000000000' } } } }))
    await expect(submitVideoBatchMethod(clientFor(provider), ledger, { items })).rejects.toThrow('numeric range')
    expect(putCalls(provider)).toEqual([])
    expect(await ledger.records()).toEqual([])
  })

  it('rejects a stale preview and duplicate storyboard before any PUT or reservation', async () => {
    const { provider, items } = await batch()
    provider.storyboards!['916954'] = { ...second, modelConfig: JSON.stringify({ ...MODEL_CONFIG,
      prompt: `${PROMPT} changed` }) }
    await expect(submitVideoBatchMethod(clientFor(provider), ledger, { items })).rejects.toThrow()
    expect(putCalls(provider)).toHaveLength(0)
    expect(await ledger.records()).toEqual([])
    provider.storyboards!['916954'] = second
    await expect(submitVideoBatchMethod(clientFor(provider), ledger, { items: [items[0]!, items[0]!] }))
      .rejects.toThrow()
    expect(putCalls(provider)).toHaveLength(0)
    await expect(submitVideoBatchMethod(clientFor(provider), ledger, { items: [items[0]!,
      { ...items[1]!, idempotency_key: items[0]!.idempotency_key }] })).rejects.toThrow()
    expect(await ledger.records()).toEqual([])
  })

  it('refuses the entire batch when its combined estimate exceeds the budget', async () => {
    const { provider, items } = await batch()
    await writeFile(join(ledger.root, 'authorization.json'), JSON.stringify({ version: 1, projects: {
      '2708': { limit: '1', unit: 'CNY', estimates: { storyboard_native_submit: '1' } },
    } }))
    await expect(submitVideoBatchMethod(clientFor(provider), ledger, { items }))
      .rejects.toThrow()
    expect(putCalls(provider)).toHaveLength(0)
    expect(await ledger.records()).toEqual([])
  })

  it('reserves different agent estimates and rejects an over-budget batch before any PUT', async () => {
    const { provider, items } = await batch()
    const auto = new JubianLedger({ root: join(root, 'automatic-batch'), defaultLimitCents: () => 400000 })
    const estimates = items.map((item, index) => ({ ...item,
      estimated_cost_cny: index === 0 ? '2000.00' : '2000.01', estimate_basis: 'Catalogue rate and package usage' }))
    await expect(submitVideoBatchMethod(clientFor(provider), auto, { items: estimates })).rejects.toThrow()
    expect(putCalls(provider)).toHaveLength(0)
    expect(await auto.records()).toEqual([])
    estimates[0]!.estimated_cost_cny = '8.00'
    estimates[1]!.estimated_cost_cny = '9.00'
    provider.onPut = (payload) => {
      const id = Number(payload.id)
      const taskId = id + 100000
      provider.tasks.push({ id: taskId, scriptId: 2708, taskType: 1 })
      provider.subtasks[String(taskId)] = [childOf(payload, { aigcVideoTaskId: taskId, storyboardId: id })]
    }
    await submitVideoBatchMethod(clientFor(provider), auto, { items: estimates })
    expect(putCalls(provider)).toHaveLength(2)
    expect((await auto.find(items[0]!.idempotency_key))?.quoted_amount).toBe('8.00')
    expect((await auto.find(items[1]!.idempotency_key))?.quoted_amount).toBe('9.00')
  })

  it('refuses a drifting full task snapshot before the first PUT', async () => {
    const { provider, items } = await batch()
    let lists = 0
    provider.onTaskList = () => {
      lists += 1
      if (lists === 2) provider.tasks.push({ id: 123456, scriptId: 2708, storyboardId: 999999 })
    }
    await expect(submitVideoBatchMethod(clientFor(provider), ledger, { items })).rejects.toThrow()
    expect(putCalls(provider)).toHaveLength(0)
    expect(await ledger.records()).toEqual([])
  })

  it('refuses a task row without a stable ID before the first PUT', async () => {
    const { provider, items } = await batch()
    provider.tasks.push({ scriptId: 2708, storyboardId: 999999 })
    await expect(submitVideoBatchMethod(clientFor(provider), ledger, { items })).rejects.toThrow()
    expect(putCalls(provider)).toHaveLength(0)
    expect(await ledger.records()).toEqual([])
  })

  it('overlaps independent PUTs, returns input order and replays both keys read-only', async () => {
    const { provider, items } = await batch()
    let active = 0
    let peak = 0
    const twoPutCalls = barrier()
    const releasePuts = barrier()
    provider.onPut = async (payload) => {
      active += 1
      peak = Math.max(peak, active)
      if (active === 2) twoPutCalls.release()
      await releasePuts.promise
      const id = Number(payload.id)
      const taskId = id + 100000
      provider.tasks.push({ id: taskId, scriptId: 2708, taskType: 1 })
      provider.subtasks[String(taskId)] = [childOf(payload, { id: taskId + 200000,
        aigcVideoTaskId: taskId, storyboardId: id })]
      active -= 1
    }
    const pending = submitVideoBatchMethod(clientFor(provider), ledger, { items })
    try {
      await ready(twoPutCalls.promise)
      expect(active).toBe(2)
    } finally {
      releasePuts.release()
      await pending.catch(() => undefined)
    }
    const result = await pending
    expect(peak).toBe(2)
    expect(putCalls(provider)).toHaveLength(2)
    expect(result.results.map(item => item.idempotency_key)).toEqual(items.map(item => item.idempotency_key))
    expect(result.results.map(item => item.status)).toEqual(['submitted', 'submitted'])
    expect((await ledger.records()).map(record => record.outcome)).toEqual(['accepted', 'accepted'])
    provider.calls.length = 0
    const replay = await submitVideoBatchMethod(clientFor(provider), ledger, { items })
    expect(putCalls(provider)).toHaveLength(0)
    expect(replay.results.map(item => item.replayed)).toEqual([true, true])
  })

  it('keeps one unknown result on its original key and never resends the batch', async () => {
    const { provider, items } = await batch()
    provider.onPut = (payload) => {
      if (payload.id === 916954) throw new Error('lost connection')
      provider.tasks.push({ id: 335343, scriptId: 2708, storyboardId: 916953, taskType: 1 })
      provider.subtasks['335343'] = [childOf(payload)]
    }
    const result = await submitVideoBatchMethod(clientFor(provider), ledger, { items })
    expect(putCalls(provider)).toHaveLength(2)
    expect(result.results.map(item => item.status)).toEqual(['submitted', 'reconcile_required'])
    expect((await ledger.find(items[1]!.idempotency_key))?.outcome).toBe('unknown')
    provider.calls.length = 0
    await submitVideoBatchMethod(clientFor(provider), ledger, { items })
    expect(putCalls(provider)).toHaveLength(0)
  })

  it('records a parsed response without a success application code as unknown', async () => {
    const { provider, items } = await batch()
    provider.onPut = (payload) => {
      const id = Number(payload.id)
      const taskId = id + 100000
      provider.tasks.push({ id: taskId, scriptId: 2708, storyboardId: id, taskType: 1 })
      provider.subtasks[String(taskId)] = [childOf(payload, { aigcVideoTaskId: taskId, storyboardId: id })]
    }
    provider.putResponse = payload => payload.id === 916954
      ? new Response(JSON.stringify([{ receipt: 1 }, { receipt: 2 }]), { status: 200 })
      : new Response(JSON.stringify({ code: 200, data: null }), { status: 200 })
    const result = await submitVideoBatchMethod(clientFor(provider), ledger, { items })
    expect(result.results.map(item => item.status)).toEqual(['submitted', 'reconcile_required'])
    expect(result.results[1]).toMatchObject({ outcome: 'unknown', put_ambiguous: true })
    expect((await ledger.find(items[1]!.idempotency_key))?.outcome).toBe('unknown')
  })

  it('bounds task readback without holding the paid PUT submission slots', async () => {
    const { provider, items } = await batch(4)
    const twoEarlyReads = barrier()
    const releaseEarly = barrier()
    const fourPuts = barrier()
    const twoFinalDetails = barrier()
    const releaseFinal = barrier()
    let lists = 0
    let activeEarly = 0
    let peakEarly = 0
    let finalDetails = 0
    let peakFinal = 0
    let activeFinal = 0
    let puts = 0
    provider.onTaskList = async () => {
      lists += 1
      if (lists <= 2) return
      activeEarly += 1
      peakEarly = Math.max(peakEarly, activeEarly)
      if (activeEarly === 2) twoEarlyReads.release()
      if (lists <= 4) await releaseEarly.promise
      activeEarly -= 1
    }
    provider.onTaskRead = async (path) => {
      if (lists < 7 || !path.startsWith('/admin/aigc/video/task/')
        || path.startsWith('/admin/aigc/video/task/list')
        || path.startsWith('/admin/aigc/video/task/sub/list')) return
      finalDetails += 1
      activeFinal += 1
      peakFinal = Math.max(peakFinal, activeFinal)
      if (activeFinal === 2) twoFinalDetails.release()
      if (finalDetails <= 2) await releaseFinal.promise
      activeFinal -= 1
    }
    provider.onPut = (payload) => {
      puts += 1
      if (puts === 4) fourPuts.release()
      const id = Number(payload.id)
      const taskId = id + 100000
      provider.tasks.push({ id: taskId, scriptId: 2708, storyboardId: id, taskType: 1 })
      provider.subtasks[String(taskId)] = [childOf(payload, { aigcVideoTaskId: taskId, storyboardId: id })]
    }
    const pending = submitVideoBatchMethod(clientFor(provider), ledger, { items },
      { concurrency: 2, maxItems: 4 })
    try {
      await ready(twoEarlyReads.promise)
      await ready(fourPuts.promise)
      expect(lists).toBe(4)
      expect(activeEarly).toBe(2)
      releaseEarly.release()
      await ready(twoFinalDetails.promise)
      expect(finalDetails).toBe(2)
    } finally {
      releaseEarly.release()
      releaseFinal.release()
      await pending.catch(() => undefined)
    }
    const result = await pending
    expect(putCalls(provider)).toHaveLength(4)
    expect(peakEarly).toBe(2)
    expect(peakFinal).toBe(2)
    expect(result.results.map(item => item.status)).toEqual(['submitted', 'submitted', 'submitted', 'submitted'])
  })

  it('leaves a batch task unresolved when later provider readback has stripped its identity', async () => {
    const { provider, items } = await batch()
    let lists = 0
    provider.onTaskList = () => {
      lists += 1
      if (lists === 5) provider.subtasks['1016953'] = [{ id: 1216953,
        aigcVideoTaskId: 1016953, storyboardId: 916953, taskStatus: 'submit' }]
    }
    provider.onPut = (payload) => {
      const id = Number(payload.id)
      const taskId = id + 100000
      provider.tasks.push({ id: taskId, scriptId: 2708, taskType: 1 })
      provider.subtasks[String(taskId)] = [childOf(payload, { aigcVideoTaskId: taskId, storyboardId: id })]
    }
    const result = await submitVideoBatchMethod(clientFor(provider), ledger, { items })
    expect(putCalls(provider)).toHaveLength(2)
    expect(result.results[0]).toMatchObject({ status: 'reconcile_required' })
    expect(result.results[0]?.status).not.toBe('subject_identity_lost')
  })
})

describe('select_assets', () => {
  const selections = [{ material_key: 'lead', asset_id: 81285 }, { material_key: 'guest', asset_id: 83670 }]
  const emptyStoryboard = { ...STORYBOARD, storyboardMaterialList: [] }

  it('saves with isGenerate=0, reads the order back and proves no task appeared', async () => {
    const provider: FakeProvider = { calls: [], storyboard: emptyStoryboard, tasks: [], subtasks: {} }
    const result = await selectAssetsMethod(clientFor(provider), ledger, { storyboard_id: 916953,
      selections, idempotency_key: 'select-1' })
    expect(putCalls(provider)).toHaveLength(1)
    expect(putCalls(provider)[0]?.body?.isGenerate).toBe(0)
    expect(result).toMatchObject({ status: 'applied', applied: true, paid_requests: 0,
      verified_readback: [{ materialKey: 'lead', materialAssetId: '81285' }, { materialKey: 'guest', materialAssetId: '83670' }] })
    expect((await ledger.find('select-1'))?.method).toBe('storyboard_select_assets')
  })

  it('shouts when a selection-only save created a task', async () => {
    const provider: FakeProvider = { calls: [], storyboard: emptyStoryboard, tasks: [], subtasks: {} }
    provider.onPut = () => {
      provider.tasks = [{ id: 1, scriptId: 2708, storyboardId: 916953, taskType: 1 }]
    }
    const result = await selectAssetsMethod(clientFor(provider), ledger, { storyboard_id: 916953,
      selections, idempotency_key: 'select-2' })
    expect(result.status).toBe('billing_safety_violation')
    expect(String(result.next)).toContain('立即停机')
  })

  it('does not PUT at all when the storyboard already holds the selection', async () => {
    const provider: FakeProvider = { calls: [], storyboard: STORYBOARD, tasks: [], subtasks: {} }
    const result = await selectAssetsMethod(clientFor(provider), ledger, { storyboard_id: 916953,
      selections, idempotency_key: 'select-3' })
    expect(putCalls(provider)).toHaveLength(0)
    expect(result).toMatchObject({ status: 'already_applied', applied: false })
    expect(await ledger.find('select-3')).toBeUndefined()
  })

  it('refuses a selection with no key before it reads anything', async () => {
    const provider: FakeProvider = { calls: [], storyboard: STORYBOARD, tasks: [], subtasks: {} }
    await expect(selectAssetsMethod(clientFor(provider), ledger, { storyboard_id: 916953,
      selections })).rejects.toThrow()
    expect(provider.calls).toHaveLength(0)
  })

  it('refuses a storyboard whose saved order no longer matches the plan', async () => {
    const provider: FakeProvider = { calls: [], storyboard: emptyStoryboard, tasks: [], subtasks: {} }
    provider.onPut = (payload) => {
      // Simulate a provider that silently reorders: the read-back must catch it.
      const materials = payload.storyboardMaterialList as Record<string, unknown>[]
      provider.storyboard = { ...provider.storyboard, storyboardMaterialList: [...materials].reverse() }
    }
    await expect(selectAssetsMethod(clientFor(provider), ledger, { storyboard_id: 916953,
      selections, idempotency_key: 'select-4' })).rejects.toThrow()
    expect((await ledger.find('select-4'))?.outcome).toBe('accepted')
  })
})


it('submits with an agent estimate under the default project budget without an authorization file', async () => {
  const auto = new JubianLedger({ root: join(root, 'automatic-ledger'), defaultLimitCents: () => 400000 })
  const provider: FakeProvider = { calls: [], storyboard: STORYBOARD, tasks: [], subtasks: {} }
  const preview = await prepareVideoMethod(clientFor(provider), ledger, { storyboard_id: 916953, project_dir: await project() })
  const previewPath = String(preview.preview_path)
  const idempotencyKey = String(preview.idempotencyKey)
  provider.onPut = (payload) => {
    provider.tasks = [{ id: 335343, scriptId: 2708, storyboardId: 916953, taskType: 1 }]
    provider.subtasks['335343'] = [childOf(payload)]
  }
  const args = { preview_path: previewPath, idempotency_key: idempotencyKey,
    estimated_cost_cny: '8.00', estimate_basis: 'Current catalogue rate and this package duration' }
  expect(await submitVideoMethod(clientFor(provider), auto, args)).toMatchObject({ status: 'submitted' })
  expect((await auto.find(idempotencyKey))?.quoted_amount).toBe('8.00')
  expect(provider.calls.filter(call => call.method === 'PUT')).toHaveLength(1)
})


it.each([
  { estimated_cost_cny: '0', estimate_basis: 'rate' },
  { estimated_cost_cny: '-1', estimate_basis: 'rate' },
  { estimated_cost_cny: '8.00' },
  { estimate_basis: 'rate' },
])('rejects an unusable agent estimate before a paid PUT: %j', async (estimate) => {
  const provider: FakeProvider = { calls: [], storyboard: STORYBOARD, tasks: [], subtasks: {} }
  const preview = await prepareVideoMethod(clientFor(provider), ledger, { storyboard_id: 916953, project_dir: await project() })
  await expect(submitVideoMethod(clientFor(provider), ledger, { ...estimate,
    preview_path: String(preview.preview_path), idempotency_key: String(preview.idempotencyKey),
  })).rejects.toThrow('estimated_cost_cny')
  expect(putCalls(provider)).toHaveLength(0)
  expect(await ledger.records()).toEqual([])
})
