import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { JubianClient, JubianLedger } from '@deepseek-ai/dsh-jubian'
import type { JubianLedgerMethod } from '@deepseek-ai/dsh-jubian'
import { storyboardMethod } from '../src/methods.ts'
import { resolveGenerateMethod } from '../src/native.ts'
import { requireArguments } from '../src/write.ts'

let directory: string
let ledger: JubianLedger
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'jubian-generate-'))
  ledger = new JubianLedger({ root: join(directory, 'ledger') })
})
afterEach(async () => { await rm(directory, { recursive: true, force: true }) })

/** Seed one durable intent without dispatching a provider operation. */
async function intent(method: JubianLedgerMethod, key = 'original'): Promise<void> {
  await ledger.begin({ idempotencyKey: key, method, scriptId: 2708, requestSha256: 'sha256:original' })
}

describe('generate method routing', () => {
  it.each([{}, { idempotency_key: 'unused' }])('prepares a fresh call without a preview %j', async (args) => {
    expect(await resolveGenerateMethod(ledger, args)).toBe('prepare_video')
    expect(await ledger.records()).toEqual([])
  })

  it.each([{}, { idempotency_key: 'unused' }])('submits a fresh call carrying a preview %j', async (args) => {
    expect(await resolveGenerateMethod(ledger, { ...args, preview_path: 'preview.json' })).toBe('submit_video')
  })

  it('preserves an original native operation even without an explicit preview path', async () => {
    await intent('storyboard_native_submit')
    expect(await resolveGenerateMethod(ledger, { idempotency_key: 'original' })).toBe('submit_video')
    expect(await resolveGenerateMethod(ledger, { idempotency_key: 'original', preview_path: 'preview.json' }))
      .toBe('submit_video')
  })

  it('does not reuse another operation key', async () => {
    await intent('image_generate')
    await expect(resolveGenerateMethod(ledger, { idempotency_key: 'original', preview_path: 'preview.json' }))
      .rejects.toMatchObject({ code: 'CONTRACT_CHANGED' })
  })

  it.each([null, 0, {}, '', '  '])('rejects an explicitly invalid key %j', async (idempotency_key) => {
    await expect(resolveGenerateMethod(ledger, { idempotency_key }))
      .rejects.toMatchObject({ code: 'INVALID_ARGUMENT', detail: 'idempotency_key' })
  })

  it.each([false, true])('rejects an invalid preview with existing native key=%s', async (existing) => {
    if (existing) await intent('storyboard_native_submit')
    for (const preview_path of [null, 0, {}, '', '  ']) {
      await expect(resolveGenerateMethod(ledger, { idempotency_key: 'original', preview_path }))
        .rejects.toMatchObject({ code: 'INVALID_ARGUMENT', detail: 'preview_path' })
    }
  })

  it('rejects an invalid preview without a key', async () => {
    await expect(resolveGenerateMethod(ledger, { preview_path: '' }))
      .rejects.toMatchObject({ code: 'INVALID_ARGUMENT', detail: 'preview_path' })
  })

  it.each(['intent', 'unknown', 'accepted'] as const)('replays only the original legacy %s outcome', async (state) => {
    await intent('storyboard_generate')
    if (state !== 'intent') await ledger.settle('original', { httpStatus: state === 'accepted' ? 200 : null,
      applicationCode: state === 'accepted' ? 200 : null, responseSha256: 'sha256:response', outcome: state })
    const before = await ledger.records()
    const fetch = vi.fn<typeof globalThis.fetch>()
    const client = new JubianClient({ credential: async () => 'unused', fetch })
    const modelCheck = vi.fn()
    expect(() => { requireArguments('jubian_storyboard', { method: 'generate', idempotency_key: 'original' }) }).not.toThrow()
    expect(await resolveGenerateMethod(ledger, { idempotency_key: 'original', preview_path: null })).toBe('legacy_replay')
    const result = await storyboardMethod(client, ledger, { method: 'generate', idempotency_key: 'original' },
      { assertVideoModel: modelCheck })
    expect(result).toMatchObject({ canonical_method: 'legacy_generate_replay', replayed: true,
      outcome: state === 'intent' ? 'unknown' : state, response_sha256: state === 'intent' ? null : 'sha256:response',
      data: null })
    expect(result.next).toContain('未完成对账前不要重新准备并提交同一包')
    expect(fetch).not.toHaveBeenCalled()
    expect(modelCheck).not.toHaveBeenCalled()
    expect(await ledger.records()).toEqual(before)
  })

  it('refuses a legacy record that disappears between route resolution and replay', async () => {
    await intent('storyboard_generate')
    const original = await ledger.find('original')
    vi.spyOn(ledger, 'find').mockResolvedValueOnce(original).mockResolvedValueOnce(undefined)
    const fetch = vi.fn<typeof globalThis.fetch>()
    const client = new JubianClient({ credential: async () => 'unused', fetch })
    await expect(storyboardMethod(client, ledger, { method: 'generate', idempotency_key: 'original' }))
      .rejects.toMatchObject({ code: 'CONTRACT_CHANGED' })
    expect(fetch).not.toHaveBeenCalled()
  })
})

const IMAGE = 'https://jubian-aigc.tos-cn-beijing.volces.com/prod/lead.jpg'
const MODEL = { platformId: 'FANG_ZHOU', modelId: 'doubao-seedance-2-5-260628', standardId: 61, genType: 3,
  modelGenerationTypeId: 71, videoStandardId: 337, duration: 30, ratio: '16:9', resolution: '480p', genNum: 1,
  materialList: [], backupModelList: [], prompt: '@[陆沉舟](lead) 在雨夜回头' }
const MATERIALS = [{ assetId: 'asset-lead', materialAssetId: 81285, fileName: '陆沉舟｜西装', materialKey: 'lead',
  materialType: 'image', materialUrl: IMAGE, sortOrder: 1 }]

/** Keep the compatibility entry on the same real native compiler and transport as explicit submission. */
async function nativeFixture(model = MODEL) {
  const project = join(directory, 'project')
  await mkdir(project)
  await writeFile(join(project, 'project_config.json'), JSON.stringify({ jubian_script_id: 2708 }))
  await mkdir(ledger.root)
  await writeFile(join(ledger.root, 'authorization.json'), JSON.stringify({ version: 1, projects: {
    2708: { limit: '10', unit: 'CNY', estimates: { storyboard_native_submit: '1' } },
  } }))
  const state = {
    storyboard: { id: 916953, scriptId: 2708, episodeId: 9, isGenerate: 1, storyboardName: 'EP01-P1',
      modelConfig: JSON.stringify(model), storyboardMaterialList: MATERIALS },
    tasks: [] as Record<string, unknown>[], children: [] as Record<string, unknown>[],
    calls: [] as { method: string; path: string; body?: Record<string, unknown> }[],
  }
  const client = new JubianClient({ credential: async () => 'offline-test', fetch: async (url, init) => {
    const path = new URL(url instanceof Request ? url.url : url).pathname.replace('/prod-api', '')
    const method = String(init?.method)
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : undefined
    state.calls.push({ method, path, ...(body ? { body } : {}) })
    const answer = (data: unknown): Response => new Response(JSON.stringify({ code: 200, data }), { status: 200 })
    if (path === '/aigc/storyboard/916953') return answer(state.storyboard)
    if (path === '/aigc/asset/81285') return answer({ id: 81285, scriptId: 2708, assetUrl: IMAGE, name: '陆沉舟｜西装' })
    if (path === '/aigc/material/list') return answer({ total: 1, rows: [
      { id: 1, assetId: 81285, scriptId: 2708, hsAssetId: 'asset-lead', assetUrl: IMAGE,
        assetName: '陆沉舟｜西装', hsAssetStatus: 'Active', isUsed: 1 },
    ] })
    if (path === '/model/charge/getSelectList') return answer([{ id: 61, standardId: 61,
      modelId: model.modelId, platformId: model.platformId, genTypes: [{ id: 71, type: 3 }],
      videoStandards: [{ id: 337, ratio: '16:9', resolution: '480p', genNum: 1 }] }])
    if (path === '/admin/aigc/video/task/list') return answer({ total: state.tasks.length, rows: state.tasks })
    if (path === '/admin/aigc/video/task/335343') return answer(state.tasks[0])
    if (path === '/admin/aigc/video/task/sub/list') return answer({ total: state.children.length, rows: state.children })
    if (path === '/aigc/storyboard' && method === 'PUT' && body) {
      state.tasks.push({ id: 335343, scriptId: 2708, storyboardId: 916953, episodeId: 9, taskType: 1, taskStatus: 'submit' })
      state.children.push({ id: 972949, aigcVideoTaskId: 335343, storyboardId: 916953,
        taskStatus: 'submit', imageMaterials: body.storyboardMaterialList, modelConfig: body.modelConfig })
      return answer(null)
    }
    throw new Error(`Unexpected offline request: ${method} ${path}`)
  } })
  return { client, project, state }
}

describe('generate native compatibility', () => {
  it.each([undefined, 'unused-caller-key'])('prepares a 30-second package without submitting, caller key=%s', async (key) => {
    const { client, project, state } = await nativeFixture()
    const result = await storyboardMethod(client, ledger, { method: 'generate', storyboard_id: 916953,
      project_dir: project, ...(key === undefined ? {} : { idempotency_key: key }) })
    expect(result).toMatchObject({ canonical_method: 'prepare_video', status: 'prepared',
      storyboard_duration_seconds: 30, content_duration_ms: 29000 })
    expect(result.idempotencyKey).not.toBe(key)
    expect(typeof result.preview_path).toBe('string')
    expect(JSON.parse(await readFile(String(result.preview_path), 'utf8'))).toMatchObject({
      idempotencyKey: result.idempotencyKey, payload: { isGenerate: 1 },
    })
    expect(state.calls.every(call => call.method === 'GET')).toBe(true)
    expect(await ledger.records()).toEqual([])
  })

  it('prepares an available mini model whose local duration ceiling is unknown', async () => {
    const model = { ...MODEL, modelId: 'doubao-seedance-2-0-mini-260615', duration: 8 }
    const { client, project, state } = await nativeFixture(model)
    const prepared = await storyboardMethod(client, ledger, { method: 'generate', storyboard_id: 916953, project_dir: project })
    expect(prepared).toMatchObject({ canonical_method: 'prepare_video', status: 'prepared', storyboard_duration_seconds: 8 })
    expect(JSON.parse(String((prepared.payload as Record<string, unknown>).modelConfig)))
      .toMatchObject({ modelId: model.modelId, duration: 8 })
    expect(state.calls.every(call => call.method === 'GET')).toBe(true)
    expect(await ledger.records()).toEqual([])
  })

  it('retains native duration validation before a paid request', async () => {
    const { client, project, state } = await nativeFixture()
    await expect(storyboardMethod(client, ledger, { method: 'generate', storyboard_id: 916953,
      project_dir: project, content_duration_ms: 14000 })).rejects.toMatchObject({ code: 'CONTRACT_CHANGED' })
    expect(state.calls.every(call => call.method === 'GET')).toBe(true)
    expect(await ledger.records()).toEqual([])
  })

  it('submits a prepared fingerprint once and later reconciles the original native key', async () => {
    const { client, project, state } = await nativeFixture()
    const prepared = await storyboardMethod(client, ledger, { method: 'generate', storyboard_id: 916953, project_dir: project })
    const check = vi.fn()
    const args = { method: 'generate', idempotency_key: String(prepared.idempotencyKey), preview_path: String(prepared.preview_path) }
    expect(await storyboardMethod(client, ledger, args, { assertVideoModel: check }))
      .toMatchObject({ canonical_method: 'submit_video', status: 'submitted', put_sent: true })
    expect(check).toHaveBeenCalledOnce()
    expect(check).toHaveBeenCalledWith(expect.objectContaining({ modelId: MODEL.modelId, resolution: '480p' }))
    state.storyboard.modelConfig = JSON.stringify({ ...MODEL, prompt: 'changed after original submission' })
    expect(await storyboardMethod(client, ledger, { method: 'generate', idempotency_key: args.idempotency_key,
      project_dir: project, storyboard_id: 916953 }, { assertVideoModel: check }))
      .toMatchObject({ canonical_method: 'submit_video', status: 'submitted', replayed: true })
    expect(state.calls.filter(call => call.method === 'PUT')).toHaveLength(1)
    expect(await ledger.records()).toEqual([expect.objectContaining({ method: 'storyboard_native_submit', outcome: 'accepted' })])
  })

  it('rejects a caller key that differs from the prepared fingerprint without a provider write', async () => {
    const { client, project, state } = await nativeFixture()
    const prepared = await storyboardMethod(client, ledger, { method: 'generate', storyboard_id: 916953, project_dir: project })
    await expect(storyboardMethod(client, ledger, { method: 'generate', idempotency_key: 'arbitrary-new-key',
      preview_path: String(prepared.preview_path) })).rejects.toMatchObject({ code: 'CONTRACT_CHANGED' })
    expect(state.calls.every(call => call.method === 'GET')).toBe(true)
    expect(await ledger.records()).toEqual([])
  })

  it.each(['authorization', 'budget', 'stale', 'model'] as const)
  ('retains native %s checks on submission through generate', async (failure) => {
    const { client, project, state } = await nativeFixture()
    const prepared = await storyboardMethod(client, ledger, { method: 'generate', storyboard_id: 916953, project_dir: project })
    if (failure === 'authorization') await rm(join(ledger.root, 'authorization.json'))
    if (failure === 'stale') state.storyboard.modelConfig = JSON.stringify({ ...MODEL, prompt: 'changed before submission' })
    const check = vi.fn(() => { if (failure === 'model') throw new Error('session model changed') })
    await expect(storyboardMethod(client, ledger, { method: 'generate',
      idempotency_key: String(prepared.idempotencyKey), preview_path: String(prepared.preview_path),
      ...(failure === 'budget' ? { estimated_cost_cny: '20', estimate_basis: 'operator quote' } : {}),
    }, { assertVideoModel: check })).rejects.toThrow()
    expect(state.calls.filter(call => call.method === 'PUT')).toEqual([])
    expect(await ledger.records()).toEqual([])
    if (failure === 'model') expect(check).toHaveBeenCalledOnce()
  })

  it('requires the prepared key before submission through generate', async () => {
    const { client, state } = await nativeFixture()
    await expect(storyboardMethod(client, ledger, { method: 'generate', preview_path: 'preview.json' }))
      .rejects.toMatchObject({ code: 'INVALID_ARGUMENT', detail: 'idempotency_key' })
    expect(state.calls).toEqual([])
  })
})
