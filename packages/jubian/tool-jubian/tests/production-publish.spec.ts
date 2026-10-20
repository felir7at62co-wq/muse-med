/** Publication recovery keeps exact card versions and original keys across partial provider responses. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { JubianClient, JubianLedger } from '@deepseek-ai/dsh-jubian'
import { productionCard, publishProductionCard, type ProductionCardInput } from '../src/production.ts'
import type { storyboardMethod } from '../src/methods.ts'

const commands = vi.hoisted(() => ({ run: vi.fn<typeof storyboardMethod>() }))
vi.mock('../src/methods.ts', () => ({ storyboardMethod: commands.run }))
const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  commands.run.mockReset()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'muse-production-publish-')); roots.push(root)
  const model = { prompt: '正文', modelId: 'model', platformId: 'channel', standardId: 1,
    modelGenerationTypeId: 2, videoStandardId: 3, genType: 3, ratio: '16:9', resolution: '480p', duration: 5, genNum: 1 }
  const input: ProductionCardInput = { project_dir: root, script_id: 4908, episode_id: 102505,
    script_name: '恢复测试', episode: 1, name: 'EP01-P1', index: 1, prompt: model.prompt, model,
    storyboard_id: 11, expected_snapshot_sha256: null, images: [], voices: [], key: 'original', page_size: 100, page_limit: 5 }
  const state = { card: { id: 11, scriptId: 4908, episodeId: 102505, isGenerate: 0, storyboardName: input.name,
    modelConfig: JSON.stringify(model), storyboardMaterialList: [] as Record<string, unknown>[] },
  listed: [] as Record<string, unknown>[] }
  const client = new JubianClient({ baseUrl: 'https://publish.invalid', credential: async () => 'offline', fetch: async (request) => {
    const path = new URL(request instanceof Request ? request.url : request.toString()).pathname
    const data = path.endsWith('/list') ? { total: state.listed.length, rows: state.listed } : state.card
    return new Response(JSON.stringify({ code: 200, data }))
  } })
  const ledger = new JubianLedger({ root: join(root, 'ledger') })
  commands.run.mockImplementation(async (_client, _ledger, args) => {
    if (args.method === 'create') return { data: { id: 11 } }
    if (args.method === 'edit_preview' || args.method === 'audio_preview') {
      const prompt = args.method === 'audio_preview' ? args.prompt : args.changes?.prompt
      state.card.modelConfig = JSON.stringify({ ...model, prompt })
      return { preview_path: 'frozen-preview', fingerprint: 'frozen-fingerprint' }
    }
    return { status: 'applied', verified_readback: true }
  })
  input.expected_snapshot_sha256 = (await productionCard(client, 11)).sha256
  const publish = () => publishProductionCard(client, ledger, input, new AbortController().signal)
  return { input, state, client, ledger, publish }
}

it('does not create after a same-name card appears or when the original create receipt remains ambiguous', async () => {
  const f = await fixture(); f.input.storyboard_id = null
  f.state.listed = [{ id: 11, scriptId: 4908, episodeId: 102505, storyboardName: f.input.name }]
  expect(await f.publish()).toMatchObject({ status: 'current_card_changed' })
  expect(commands.run).not.toHaveBeenCalled()
  f.state.listed = []
  commands.run.mockResolvedValue({ data: null })
  expect(await f.publish()).toMatchObject({ status: 'reconcile_required', original_key: 'original-create' })
})

it.each([true, false])('reconciles an original create receipt only when the current prompt agrees: %s', async (agrees) => {
  const f = await fixture(); f.input.storyboard_id = null
  await f.ledger.begin({ idempotencyKey: 'original-create', method: 'storyboard_create', scriptId: 4908,
    requestSha256: 'a'.repeat(64) })
  f.state.listed = [{ id: 11, scriptId: 4908, episodeId: 102505, storyboardName: f.input.name }]
  commands.run.mockImplementation(async (_client, _ledger, args) => args.method === 'create'
    ? { data: [] } : { status: 'applied', verified_readback: true })
  if (!agrees) f.state.card.modelConfig = JSON.stringify({ ...f.input.model, prompt: '用户新稿' })
  expect(await f.publish()).toMatchObject({ status: agrees ? 'saved' : 'reconcile_required' })
  expect(commands.run.mock.calls.filter(call => call[2].method === 'create')).toHaveLength(1)
})

it('accepts a numeric creation ID and refuses mismatched project or prompt readback', async () => {
  const f = await fixture(); f.input.storyboard_id = null
  commands.run.mockResolvedValue({ data: 11, status: 'applied' })
  f.state.card.scriptId = 999
  expect(await f.publish()).toMatchObject({ status: 'readback_mismatch' })
  expect(commands.run).toHaveBeenCalledTimes(1)
})

it('retains the current card on stale expected snapshots', async () => {
  const f = await fixture(); f.state.card.storyboardName = '用户编辑'
  expect(await f.publish()).toMatchObject({ status: 'current_card_changed' })
  expect(commands.run).not.toHaveBeenCalled()
})

it.each(['edit_apply', 'select_assets', 'audio_apply'] as const)('returns an incomplete %s result without claiming the package saved', async (method) => {
  const f = await fixture()
  if (method === 'audio_apply') f.input.voices = [{ asset_id: 401, kind: 'voice', name: '苏晚', url: 'https://cdn.example.test/voice.wav',
    material_id: null, usable: true, duration_seconds: 2 }]
  commands.run.mockImplementation(async (_client, _ledger, args) => {
    if (args.method === method) return { status: 'readback_mismatch', verified_readback: false }
    if (args.method.endsWith('_preview')) return { preview_path: 'plan', fingerprint: 'hash' }
    return { status: 'applied' }
  })
  expect(await f.publish()).toMatchObject({ status: 'readback_mismatch' })
})

it('requires verified audio readback even when the audio operation reports applied', async () => {
  const f = await fixture()
  f.input.voices = [{ asset_id: 401, kind: 'voice', name: '苏晚', url: 'https://cdn.example.test/v.wav',
    material_id: null, usable: true, duration_seconds: 2 }]
  commands.run.mockResolvedValue({ status: 'applied', verified_readback: false })
  const result = await f.publish()
  expect(result.status).toBe('applied')
  expect(result.verified_readback).toBe(false)
})

it('returns unresolved voice IDs and refuses final selector or image identity mismatches', async () => {
  const f = await fixture()
  f.input.voices = [{ asset_id: 401, kind: 'voice', name: '未核样本', url: null, material_id: null, usable: false }]
  expect(await f.publish()).toMatchObject({ status: 'saved', unbound_voice_ids: [401] })
  f.input.images = [{ asset_id: 101, material_key: 'lead' }]
  expect(await f.publish()).toMatchObject({ status: 'readback_mismatch' })
  f.input.images = []
  f.input.model = { ...f.input.model, resolution: '720p' }
  expect(await f.publish()).toMatchObject({ status: 'readback_mismatch' })
})

it('preserves existing audio markers during text editing and explicitly removes unselected audio afterward', async () => {
  const f = await fixture()
  const audio = { materialType: 'audio', materialKey: 'old_voice', materialUrl: 'https://cdn.example.test/v.wav', materialName: '旧声音' }
  f.state.card.storyboardMaterialList = [audio]
  f.input.expected_snapshot_sha256 = (await productionCard(f.client, 11)).sha256
  expect(await f.publish()).toMatchObject({ status: 'saved' })
  const edit = commands.run.mock.calls.find(call => call[2].method === 'edit_preview')?.[2]
  expect(edit?.changes).toMatchObject({ prompt: '正文\n声音参考：@[旧声音](old_voice)' })
  const replacement = commands.run.mock.calls.find(call => call[2].method === 'audio_preview')?.[2]
  expect(replacement?.audio_references).toEqual([])
})

it('hashes a readable legacy card with an absent episode field without inventing its identity', async () => {
  const f = await fixture()
  const response = await f.client.request({ method: 'GET', path: '/aigc/storyboard/11' })
  const read = vi.spyOn(f.client, 'request').mockResolvedValue({ ...response, data: { ...f.state.card, episodeId: undefined } })
  // Transport JSON omits absent fields; the parser still reports the same actual card.
  await expect(productionCard(f.client, 11)).resolves.toMatchObject({ card: { storyboard_id: 11 } })
  read.mockRestore()
})
