/** Production publication uses the real free write methods and verifies the provider's final audio readback. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { JubianClient, JubianLedger } from '@deepseek-ai/dsh-jubian'
import { publishProductionCard, type ProductionCardInput } from '../src/production.ts'
import { encodeVoiceSlot } from '../src/voice-slot.ts'

type Row = Record<string, unknown>
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function fixture(missing: 'omitted' | 'null') {
  const root = await mkdtemp(join(tmpdir(), 'muse-production-audio-')); roots.push(root)
  const voice = { asset_id: 401, kind: 'voice' as const, name: '苏晚', url: 'https://cdn.example.test/voice.wav',
    material_id: null, usable: true, duration_seconds: 2, character_id: 'su-wan', voice_period_id: 'adult' }
  await writeFile(join(root, 'project_config.json'), JSON.stringify({ jubian_script_id: 4908, project_bible: {
    characters: [{ character_id: voice.character_id, voice_profiles: [{ voice_period_id: voice.voice_period_id,
      reference_audio_asset_id: voice.asset_id, reference_audio: voice.url }] }],
  } }))
  const model = { prompt: '正文', modelId: 'model', platformId: 'channel', standardId: 1,
    modelGenerationTypeId: 2, videoStandardId: 3, genType: 3, ratio: '16:9', resolution: '480p', duration: 5, genNum: 1,
    materialList: [] }
  const input: ProductionCardInput = { project_dir: root, script_id: 4908, episode_id: 102505,
    script_name: '声线回读', episode: 1, name: 'EP01-P1', index: 1, prompt: model.prompt, model,
    storyboard_id: null, expected_snapshot_sha256: null, images: [], voices: [voice], key: 'original', page_size: 100, page_limit: 5 }
  const state = { card: {} as Row, audioReads: 0, finalRead: (card: Row) => card }
  const writes: { method: string; path: string; body: Row }[] = []
  const client = new JubianClient({ baseUrl: 'https://publish.invalid', credential: async () => 'offline', fetch: async (request, init) => {
    const path = new URL(request instanceof Request ? request.url : request.toString()).pathname
    const method = String(init?.method)
    const answer = (data: unknown) => new Response(JSON.stringify({ code: 200, data }))
    if (method === 'GET' && ['/aigc/storyboard/list', '/aigc/material/list'].includes(path)) return answer({ rows: [], total: 0 })
    if (method === 'GET' && path === '/aigc/asset/401') return answer({ id: 401, scriptId: 4908, assetType: 4,
      assetName: `${voice.name} ${encodeVoiceSlot(4908, voice.character_id, voice.voice_period_id)}`,
      assetUrl: voice.url, delFlag: '0', isLocal: 1 })
    if (method === 'GET' && path === '/aigc/storyboard/11') {
      const card = structuredClone(state.card)
      const audio = card.storyboardMaterialList as Row[]
      if (audio.length && ++state.audioReads === 2) return answer(state.finalRead(card))
      return answer(card)
    }
    if (['POST', 'PUT'].includes(method) && path === '/aigc/storyboard') {
      if (typeof init?.body !== 'string') throw new Error('Expected a JSON request body')
      const body = JSON.parse(init.body) as Row
      writes.push({ method, path, body: structuredClone(body) })
      state.card = { ...body, id: 11, storyboardMaterialList: body.storyboardMaterialList ?? [] }
      for (const row of state.card.storyboardMaterialList as Row[]) {
        if (missing === 'null') { row.materialName = null; row.audioDuration = null }
        else { delete row.materialName; delete row.audioDuration }
      }
      return answer(method === 'POST' ? { id: 11 } : null)
    }
    throw new Error(`Unexpected ${method} ${path}`)
  } })
  const ledger = new JubianLedger({ root: join(root, 'ledger') })
  const publish = () => publishProductionCard(client, ledger, input, new AbortController().signal)
  return { input, state, writes, publish }
}

it.each(['omitted', 'null'] as const)('saves a new phased voice when relation metadata is %s and the model retains its duration', async (missing) => {
  const f = await fixture(missing)
  expect(await f.publish()).toMatchObject({ status: 'saved', storyboard_id: 11, paid_requests: 0, unbound_voice_ids: [] })
  expect(f.state.audioReads).toBe(2)
  expect(f.writes.map(write => [write.method, write.body.isGenerate])).toEqual([['POST', 0], ['PUT', 0]])
  const config = JSON.parse(String(f.state.card.modelConfig)) as Row
  expect(config.materialList).toEqual([{ materialType: 'audio', materialKey: 'voice_401', materialUrl: f.input.voices[0]!.url,
    fileName: '苏晚', sortOrder: 1, audioDuration: 2 }])
  expect((f.state.card.storyboardMaterialList as Row[])[0]?.audioDuration).toBe(missing === 'null' ? null : undefined)
})

it.each(['duration conflict', 'missing model duration', 'duplicate model key', 'duplicate relation key',
  'model URL', 'relation URL', 'relation key', 'file name'])(
  'refuses final production readback with %s after verified audio apply', async (fault) => {
    const f = await fixture('omitted')
    f.state.finalRead = (card) => {
      const relation = (card.storyboardMaterialList as Row[])[0]!
      const config = JSON.parse(String(card.modelConfig)) as Row
      const modelRows = config.materialList as Row[]
      const model = modelRows[0]!
      if (fault === 'duration conflict') relation.audioDuration = 7
      if (fault === 'missing model duration') delete model.audioDuration
      if (fault === 'duplicate model key') modelRows.push({ ...model })
      if (fault === 'duplicate relation key') (card.storyboardMaterialList as Row[]).push({ ...relation })
      if (fault === 'model URL') model.materialUrl = 'https://cdn.example.test/wrong.wav'
      if (fault === 'relation URL') relation.materialUrl = 'https://cdn.example.test/wrong.wav'
      if (fault === 'relation key') relation.materialKey = 'wrong-voice'
      if (fault === 'file name') relation.fileName = '另一角色'
      card.modelConfig = JSON.stringify(config)
      return card
    }
    expect(await f.publish()).toMatchObject({ status: 'readback_mismatch', storyboard_id: 11, paid_requests: 0 })
    expect(f.state.audioReads).toBe(2)
    expect(f.writes.map(write => [write.method, write.body.isGenerate])).toEqual([['POST', 0], ['PUT', 0]])
  },
)

it('still refuses a phased voice whose requested period differs from its adopted project profile before audio save', async () => {
  const f = await fixture('omitted')
  f.input.voices[0]!.voice_period_id = 'child'
  await expect(f.publish()).rejects.toThrow('Voice period is missing or ambiguous')
  expect(f.writes.map(write => [write.method, write.body.isGenerate])).toEqual([['POST', 0]])
})
