/** Audio-library deletion checks identity, current references and ambiguous replies. */
import { mkdtemp, readFile, rm, writeFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { JubianClient, JubianLedger } from '@deepseek-ai/dsh-jubian'
import { assetMethod } from '../src/methods.ts'
import { audioAssetDeleteMethod, audioDeletionInspectionReason, resolveAudioReferenceScanOptions } from '../src/audio-asset-delete.ts'
import { bodyHash } from '../src/write.ts'

let root: string
let client: JubianClient
let ledger: JubianLedger
let audio: Record<string, unknown> | null
let boards: Record<string, unknown>[]
let deletes: string[]
let lostReply: boolean
let pageTotal: number | undefined
let materialRows: unknown
let boardPages: Map<number, unknown> | undefined
let retainDeletedAsset: boolean
let failReadback: boolean
const url = 'https://jubian-aigc.tos-cn-beijing.volces.com/prod/zhou-voice.wav'
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'jubian-audio-delete-'))
  await writeFile(join(root, 'project_config.json'), JSON.stringify({ jubian_script_id: 2708 }))
  ledger = new JubianLedger({ root: join(root, 'ledger') })
  audio = { id: 7, scriptId: 2708, assetType: 4, assetName: '周海生声线 v1', assetUrl: url, isLocal: 1 }
  boards = []; deletes = []; lostReply = false; pageTotal = undefined
  materialRows = []
  boardPages = undefined; retainDeletedAsset = false; failReadback = false
  client = new JubianClient({ credential: async () => 'mock-token', fetch: async (target, init) => {
    const requestUrl = new URL(target instanceof Request ? target.url : target.toString())
    const path = requestUrl.pathname.replace('/prod-api', '')
    const answer = (data: unknown) => new Response(JSON.stringify({ code: 200, data }))
    if (path === '/aigc/storyboard/list') return answer(boardPages?.get(Number(requestUrl.searchParams.get('pageNum')))
      ?? { rows: boards, total: pageTotal ?? boards.length })
    if (path === '/aigc/material/selectNoPage') return answer(materialRows)
    if (init?.method === 'GET' && path === '/aigc/asset/7') {
      if (failReadback && deletes.length) throw new Error('readback unavailable')
      return answer(audio)
    }
    if (init?.method === 'DELETE') {
      deletes.push(path); if (!retainDeletedAsset) audio = null
      if (lostReply) throw new Error('reply lost after deletion')
      return answer(null)
    }
    throw new Error(`Unexpected request ${String(init?.method)} ${path}`)
  } })
})
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }) })
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

it.each([null, [], 'not an object', {}, { method: 'audio_delete_preview' }])('does not demand an apply inspection for other incoming JSON', (value) => {
  expect(audioDeletionInspectionReason(value)).toBeUndefined()
})

it('refuses an apply whose reviewed identity or preview is missing before reading or deleting', async () => {
  expect(audioDeletionInspectionReason({ method: 'audio_delete_apply' })).toContain('先 audio_delete_preview')
  expect(audioDeletionInspectionReason({ method: 'audio_delete_apply', preview_path: 'plan.json', checked_audio_asset_id: 1.5 }))
    .toContain('checked_audio_asset_id')
  await expect(audioAssetDeleteMethod(client, ledger, { method: 'audio_delete_apply' }, resolveAudioReferenceScanOptions()))
    .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  expect(deletes).toEqual([])
})

it('validates deployment scan bounds independently of provider responses', () => {
  expect(resolveAudioReferenceScanOptions()).toEqual({ pageSize: 1000, pageLimit: 100 })
  expect(resolveAudioReferenceScanOptions({ audioReferencePageSize: 1, audioReferencePageLimit: 1 })).toEqual({ pageSize: 1, pageLimit: 1 })
  for (const config of [{ audioReferencePageSize: 0 }, { audioReferencePageSize: 1001 }, { audioReferencePageSize: 1.5 },
    { audioReferencePageLimit: 0 }, { audioReferencePageLimit: 101 }, { audioReferencePageLimit: 1.5 }]) {
    expect(() => resolveAudioReferenceScanOptions(config)).toThrow('audioReferencePageSize')
  }
})

it('refuses absent assets and blank deletion authorization before publishing a plan', async () => {
  for (const fields of [{ delete_reason: ' ' }, { authorization_basis: ' ' }]) {
    await expect(assetMethod(client, ledger, { method: 'audio_delete_preview', script_id: 2708, project_dir: root,
      asset_id: 7, delete_reason: 'delete obsolete audio', authorization_basis: 'user asked to delete asset7', ...fields }))
      .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  }
  audio = null
  await expect(preview()).rejects.toThrow('absent')
  expect(deletes).toEqual([])
})

it('requires at least one media URL before reference absence can be established', async () => {
  audio = { ...audio, assetUrl: null }
  await expect(preview()).rejects.toThrow('no readable media URLs')
})

it.each([
  { project_bible: null }, { project_bible: [] }, { project_bible: { characters: {} } },
  { project_bible: { characters: [null] } }, { project_bible: { characters: [{ voice_profile: null }] } },
])('refuses unreadable persisted character references without deleting', async (fields) => {
  await writeFile(join(root, 'project_config.json'), JSON.stringify({ jubian_script_id: 2708, ...fields }))
  await expect(preview()).rejects.toThrow('Unreadable')
  expect(deletes).toEqual([])
})

it('finds URL-only voice references, ignores unrelated voices, and retains omitted names as null', async () => {
  await writeFile(join(root, 'project_config.json'), '\uFEFF' + JSON.stringify({ jubian_script_id: 2708, project_bible: {
    characters: [{ character_id: 'no-voice' }, { character_id: 'url-only', voice_profile: { reference_audio: url } },
      { character_id: 'unrelated', voice_profile: { reference_audio_asset_id: 8, reference_audio: 'https://other.invalid/voice.wav' } }],
  } }))
  const plan = await preview()
  expect(plan).toMatchObject({ references: { characters: [{ character_id: 'url-only', name: null }] } })
  await expect(apply(plan)).rejects.toThrow('引用')
  expect(deletes).toEqual([])
})

it.each([
  { modelConfig: '{' }, { modelConfig: 'false' }, { storyboardMaterialList: '{}' },
  { storyboardMaterialList: [null] }, { storyboardMaterialList: [{ materialType: 'audio', materialUrl: ' ' }] },
])('refuses unreadable provider card JSON or material rows', async (fields) => {
  boards = [{ id: 31, scriptId: 2708, ...fields }]
  await expect(preview()).rejects.toThrow('Unreadable')
  expect(deletes).toEqual([])
})

it('accepts explicit empty material arrays and inspects both card locations before claiming absence', async () => {
  boards = [{ id: 31, scriptId: 2708, storyboardMaterialList: JSON.stringify([{ materialType: 'image', materialUrl: url }]),
    modelConfig: JSON.stringify({ materialList: null }) }, { id: 32, scriptId: 2708, storyboardMaterialList: [], modelConfig: null }]
  expect(await preview()).toMatchObject({ references: { storyboards: [], complete: true } })
  boards[0] = { id: 31, scriptId: 2708, storyboardMaterialList: [], modelConfig: { materialList: [{ materialType: 'audio', materialUrl: url }] } }
  expect(await preview()).toMatchObject({ references: { storyboards: [{ storyboard_id: 31, name: null }] } })
})

it.each([
  { rows: null, total: 0 }, { rows: [], total: '0' }, { rows: [], total: -1 }, { rows: [], total: 0.5 },
  { rows: [null], total: 1 },
])('refuses incomplete provider scan metadata or card records', async (page) => {
  boardPages = new Map([[1, page]])
  await expect(preview()).rejects.toThrow(/Incomplete|Unreadable/)
  expect(deletes).toEqual([])
})

it.each(['duplicate', 'foreign-project', 'changed-total', 'oversized-page', 'overstated-count', 'page-limit'] as const)(
  'refuses a %s reference scan before any DELETE', async (kind) => {
    const first = { id: 31, scriptId: 2708, storyboardMaterialList: [] }, second = { id: 32, scriptId: 2708, storyboardMaterialList: [] }
    const size = kind === 'oversized-page' ? 1 : 2
    boardPages = new Map([[1, { rows: [first], total: 2 }], [2, { rows: [second], total: 2 }]])
    if (kind === 'duplicate') boardPages.set(2, { rows: [first], total: 2 })
    if (kind === 'foreign-project') boardPages.set(1, { rows: [{ ...first, scriptId: 999 }], total: 2 })
    if (kind === 'changed-total') boardPages.set(2, { rows: [second], total: 3 })
    if (kind === 'oversized-page') boardPages.set(1, { rows: [first, second], total: 2 })
    if (kind === 'overstated-count') boardPages.set(1, { rows: [first, second], total: 1 })
    await expect(assetMethod(client, ledger, { method: 'audio_delete_preview', script_id: 2708, asset_id: 7,
      project_dir: root, delete_reason: 'obsolete audio', authorization_basis: 'user asked to delete asset7' },
    { audioReferenceScan: { pageSize: size, pageLimit: kind === 'page-limit' ? 1 : 3 } })).rejects.toThrow(/Incomplete/)
    expect(deletes).toEqual([])
  })

it('inspects every configured page before producing a complete reference result', async () => {
  boardPages = new Map([[1, { rows: [{ id: 31, scriptId: 2708, storyboardMaterialList: [] }], total: 2 }],
    [2, { rows: [{ id: 32, scriptId: 2708, storyboardMaterialList: [] }], total: 2 }]])
  expect(await assetMethod(client, ledger, { method: 'audio_delete_preview', script_id: 2708, asset_id: 7,
    project_dir: root, delete_reason: 'obsolete audio', authorization_basis: 'user asked to delete asset7' },
  { audioReferenceScan: { pageSize: 1, pageLimit: 2 } })).toMatchObject({ references: { complete: true, storyboards: [] } })
})

it('rejects a deletion executor method outside preview/apply', async () => {
  await expect(audioAssetDeleteMethod(client, ledger, { method: 'unknown', script_id: 2708, asset_id: 7, project_dir: root },
    resolveAudioReferenceScanOptions())).rejects.toThrow('Unknown audio deletion method')
})

it('preserves the original operation when the ledger key already belongs to another request', async () => {
  const plan = await preview()
  for (const fields of [{ method: 'asset_rename' as const, scriptId: 2708, requestSha256: 'another-request' },
    { method: 'asset_remove' as const, scriptId: 999, requestSha256: 'another-request' },
    { method: 'asset_remove' as const, scriptId: 2708, requestSha256: 'another-request' }]) {
    const conflicting = new JubianLedger({ root: join(root, `ledger-${fields.method}-${fields.scriptId}`) })
    await conflicting.begin({ idempotencyKey: String(plan.fingerprint), ...fields })
    await expect(audioAssetDeleteMethod(client, conflicting, { method: 'audio_delete_apply', script_id: 2708, asset_id: 7,
      project_dir: root, checked_audio_asset_id: 7, preview_path: String(plan.preview_path), idempotency_key: String(plan.fingerprint) },
    resolveAudioReferenceScanOptions())).rejects.toThrow('another operation')
  }
  expect(deletes).toEqual([])
})

it('reconciles a pending original ledger intent without another DELETE', async () => {
  const plan = await preview(), key = String(plan.fingerprint)
  await ledger.begin({ idempotencyKey: key, method: 'asset_remove', scriptId: 2708,
    requestSha256: bodyHash({ script_id: 2708, asset_id: 7, fingerprint: key }) })
  expect(await apply(plan)).toMatchObject({ replayed: true, response_status: 'unknown', status: 'still_present', verified_readback: false })
  expect(deletes).toEqual([])
})

it('propagates a ledger failure before a deletion can leave the process', async () => {
  const plan = await preview()
  vi.spyOn(ledger, 'beginChecked').mockRejectedValueOnce(new Error('ledger unavailable'))
  await expect(apply(plan)).rejects.toThrow('ledger unavailable')
  expect(deletes).toEqual([])
})

it('reports retained assets and unavailable readback without claiming a verified deletion', async () => {
  const plan = await preview()
  retainDeletedAsset = true
  expect(await apply(plan)).toMatchObject({ status: 'still_present', verified_readback: false, response_status: 'accepted' })
  failReadback = true
  expect(await apply(plan)).toMatchObject({ status: 'unknown', verified_readback: false, replayed: true })
  expect(deletes).toHaveLength(1)
})

it('requires a fresh preview after removing the references that its original plan reported', async () => {
  boards = [{ id: 31, scriptId: 2708, storyboardMaterialList: [{ materialType: 'audio', materialUrl: url }] }]
  const plan = await preview()
  boards = []
  await expect(apply(plan)).rejects.toThrow('references changed')
  expect(deletes).toEqual([])
})
