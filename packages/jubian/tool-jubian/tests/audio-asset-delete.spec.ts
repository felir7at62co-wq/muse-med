/** Audio-library deletion checks identity, current references and ambiguous replies. */
import { mkdtemp, readFile, rm, writeFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { JubianClient, JubianLedger } from '@deepseek-ai/dsh-jubian'
import { assetMethod } from '../src/methods.ts'

let root: string
let client: JubianClient
let ledger: JubianLedger
let audio: Record<string, unknown> | null
let boards: Record<string, unknown>[]
let deletes: string[]
let lostReply: boolean
let pageTotal: number | undefined
let materialRows: unknown
const url = 'https://jubian-aigc.tos-cn-beijing.volces.com/prod/zhou-voice.wav'
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'jubian-audio-delete-'))
  await writeFile(join(root, 'project_config.json'), JSON.stringify({ jubian_script_id: 2708 }))
  ledger = new JubianLedger({ root: join(root, 'ledger') })
  audio = { id: 7, scriptId: 2708, assetType: 4, assetName: '周海生声线 v1', assetUrl: url, isLocal: 1 }
  boards = []; deletes = []; lostReply = false; pageTotal = undefined
  materialRows = []
  client = new JubianClient({ credential: async () => 'mock-token', fetch: async (target, init) => {
    const path = new URL(target instanceof Request ? target.url : target.toString()).pathname.replace('/prod-api', '')
    const answer = (data: unknown) => new Response(JSON.stringify({ code: 200, data }))
    if (path === '/aigc/storyboard/list') return answer({ rows: boards, total: pageTotal ?? boards.length })
    if (path === '/aigc/material/selectNoPage') return answer(materialRows)
    if (init?.method === 'GET' && path === '/aigc/asset/7') return answer(audio)
    if (init?.method === 'DELETE') {
      deletes.push(path); audio = null
      if (lostReply) throw new Error('reply lost after deletion')
      return answer(null)
    }
    throw new Error(`Unexpected request ${String(init?.method)} ${path}`)
  } })
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })
const preview = () => assetMethod(client, ledger, {
  method: 'audio_delete_preview', script_id: 2708, project_dir: root, asset_id: 7,
  delete_reason: '删除不再使用的声线 v1', authorization_basis: '用户要求删除音频资产7',
})
const apply = (plan: Record<string, unknown>, checked = 7) => {
  const args = { method: 'audio_delete_apply', script_id: 2708, project_dir: root, asset_id: 7,
    preview_path: String(plan.preview_path), idempotency_key: String(plan.fingerprint), checked_audio_asset_id: checked }
  return assetMethod(client, ledger, args)
}

it('refuses the generic remove path for an audio asset', async () => {
  await expect(assetMethod(client, ledger, { method: 'remove', script_id: 2708, asset_id: 7,
    idempotency_key: 'bypass' })).rejects.toThrow(/audio_delete_preview/)
  expect(deletes).toEqual([])
  expect(await ledger.find('bypass')).toBeUndefined()
})

it('rejects invalid audio list pagination before making a request', async () => {
  await expect(assetMethod(client, ledger, { method: 'audio_list', script_id: 2708, page_num: 0 }))
    .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  await expect(assetMethod(client, ledger, { method: 'audio_list', script_id: 2708, page_size: 1001 }))
    .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
})

it('previews and deletes only the inspected audio asset with verified readback', async () => {
  const plan = await preview()
  expect(plan).toMatchObject({ status: 'inspection_required', asset: { asset_id: 7, asset_type: 4, url },
    references: { characters: [], storyboards: [], complete: true } })
  expect(deletes).toEqual([])
  expect(await apply(plan)).toMatchObject({ status: 'deleted', verified_readback: true, paid_requests: 0 })
  expect(deletes).toEqual(['/aigc/asset/removeAsset/7'])
  expect(await apply(plan)).toMatchObject({ replayed: true, status: 'deleted' })
  expect(deletes).toHaveLength(1)
})

it('reports character and card references and refuses deletion until they are removed', async () => {
  await writeFile(join(root, 'project_config.json'), JSON.stringify({ jubian_script_id: 2708,
    project_bible: { characters: [{ character_id: 'zhou', name: '周海生',
      voice_profile: { reference_audio: url, reference_audio_asset_id: 7 } }] } }))
  boards = [{ id: 31, scriptId: 2708, storyboardName: 'EP02-P1',
    modelConfig: JSON.stringify({ materialList: [{ materialType: 'audio', materialUrl: url }] }) }]
  const plan = await preview()
  expect(plan).toMatchObject({ references: { characters: [{ character_id: 'zhou' }], storyboards: [{ storyboard_id: 31 }] } })
  await expect(apply(plan)).rejects.toThrow(/引用|reference/)
  expect(deletes).toEqual([])
})

it('checks historical audio version URLs even when the parent URL changed or is absent', async () => {
  for (const parentUrl of ['https://media.example/new.wav', null]) {
    audio = { ...audio, assetUrl: parentUrl }
    materialRows = [{ assetId: 7, scriptId: 2708, assetUrl: url }]
    boards = [{ id: 31, scriptId: 2708, storyboardMaterialList: [{ materialType: 'audio', materialUrl: url }] }]
    const plan = await preview()
    expect(plan).toMatchObject({ references: { storyboards: [{ storyboard_id: 31 }] } })
    await expect(apply(plan)).rejects.toThrow(/引用|reference/)
  }
  expect(deletes).toEqual([])
})

it('refuses an unreadable or changed audio version inventory', async () => {
  materialRows = null
  await expect(preview()).rejects.toThrow(/array|material|完整/)
  materialRows = []
  const plan = await preview()
  materialRows = [{ assetUrl: 'https://media.example/new-version.wav' }]
  await expect(apply(plan)).rejects.toThrow(/Stale|changed/)
  expect(deletes).toEqual([])
})

it.each([
  'not-an-audio-url',
  'http://media.example/voice.wav',
  'https://user:password@media.example/voice.wav',
  'https://media.example/voice.wav#clip',
  'https://media.example\\voice.wav',
])('refuses deletion when the parent audio URL is unreadable: %s', async (parentUrl) => {
  audio = { ...audio, assetUrl: parentUrl }
  await expect(preview()).rejects.toThrow(/URL|HTTPS|unreadable/)
  expect(deletes).toEqual([])
})

it('refuses cards without an explicit readable material array or audio URL', async () => {
  for (const materials of [undefined, null, [{ materialType: 'audio' }]]) {
    boards = [{ id: 31, scriptId: 2708, storyboardMaterialList: materials }]
    await expect(preview()).rejects.toThrow(/Incomplete|Unreadable|URL/)
  }
  expect(deletes).toEqual([])
})

it('refuses deletion while a project bible or original-card audio writer holds its lock', async () => {
  const plan = await preview()
  for (const path of [join(root, '.project-bible.lock'), join(root, 'video_tasks', '2708.31.storyboard-audio.lock')]) {
    await writeFile(path, '')
    await expect(apply(plan)).rejects.toThrow(/lock|writer/)
    await expect(access(join(root, '.audio-asset-delete.lock'))).rejects.toMatchObject({ code: 'ENOENT' })
    await rm(path)
  }
  expect(deletes).toEqual([])
  expect(await apply(plan)).toMatchObject({ status: 'deleted' })
})

it('rejects an unreviewed ID and stale asset content before deleting', async () => {
  const plan = await preview()
  await expect(apply(plan, 8)).rejects.toThrow(/检查|inspect/)
  audio = { ...audio, assetUrl: 'https://jubian-aigc.tos-cn-beijing.volces.com/prod/replacement.wav' }
  await expect(apply(plan)).rejects.toThrow(/Stale|变更/)
  expect(deletes).toEqual([])
})

it('refuses other categories, projects and incomplete reference scans', async () => {
  audio = { ...audio, assetType: 1 }
  await expect(preview()).rejects.toThrow()
  audio = { ...audio, assetType: 4, scriptId: 999 }
  await expect(preview()).rejects.toThrow()
  audio = { ...audio, scriptId: 2708 }
  pageTotal = 2
  await expect(preview()).rejects.toThrow(/complete|完整/)
  expect(deletes).toEqual([])
})

it('reconciles a lost delete response without issuing another deletion', async () => {
  const plan = await preview()
  lostReply = true
  expect(await apply(plan)).toMatchObject({ status: 'deleted', response_status: 'unknown', verified_readback: true })
  expect(await apply(plan)).toMatchObject({ replayed: true, status: 'deleted' })
  expect(deletes).toHaveLength(1)
})

it('refuses a modified prepared file instead of trusting its reference summary', async () => {
  const plan = await preview()
  const path = String(plan.preview_path)
  const saved = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
  await writeFile(path, JSON.stringify({ ...saved, delete_reason: 'different operation' }))
  await expect(apply(plan)).rejects.toThrow(/fingerprint|指纹/)
  expect(deletes).toEqual([])
})
