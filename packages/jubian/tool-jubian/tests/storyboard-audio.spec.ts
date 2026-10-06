/** Original-card audio edits retain image selection, generation settings and remote identity. */
import { lstat, mkdtemp, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from 'vitest'
import { JubianClient, JubianLedger } from '@deepseek-ai/dsh-jubian'
import { stableSha256 } from '@deepseek-ai/dsh-jubian-api'
import { storyboardAudioMethod } from '../src/storyboard-audio.ts'
import { bodyHash } from '../src/write.ts'
import * as audioOperationLock from '../src/audio-operation-lock.ts'

const storage = vi.hoisted(() => ({ lockFailure: false }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>()
  return { ...fs, open: async (...args: Parameters<typeof fs.open>) => {
    if (storage.lockFailure && String(args[0]).endsWith('.storyboard-audio.lock')) {
      throw Object.assign(new Error('card lock storage unavailable'), { code: 'EACCES' })
    }
    return await fs.open(...args)
  } }
})

type Row = Record<string, unknown>
const image = { id: 42, assetId: 'character-zhou', materialAssetId: 142,
  materialType: 'image', materialUrl: 'https://media.example/zhou.jpg',
  fileName: '周海生', materialKey: 'zhou', sortOrder: 1 }
const voice = { materialType: 'audio', materialUrl: 'https://media.example/zhou.wav',
  fileName: '周海生声音', materialKey: 'zhou-voice', sortOrder: 1, audioDuration: 2 }
const basePrompt = '@[周海生](zhou)走到门口'
const audioPrompt = `${basePrompt}，声音参照@[周海生声音](zhou-voice)`
const model = { platformId: 'YU_DIAN', modelId: 'doubao-seedance-2-5-260628', standardId: 11,
  genType: 3, modelGenerationTypeId: 7, videoStandardId: 91, duration: 29,
  ratio: '9:16', resolution: '480p', genNum: 1, seed: 12, prompt: basePrompt, materialList: [image] }
let root: string
let client: JubianClient
let ledger: JubianLedger
let board: Row
let otherBoard: Row | undefined
let assets: Map<number, Row>
let calls: { method: string; path: string; body?: Row }[]
let onPut: ((body: Row) => void) | undefined
let onRead: ((current: Row) => Promise<void>) | undefined
let readOverride: unknown
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'jubian-storyboard-audio-'))
  await writeFile(join(root, 'project_config.json'), JSON.stringify({ jubian_script_id: 2708 }))
  ledger = new JubianLedger({ root: join(root, 'ledger') })
  board = { id: 1745324, scriptId: 2708, episodeId: 13, episodeCount: 2, scriptName: '原项目',
    storyboardName: 'EP02-P01', sortOrder: 1, isGenerate: 1,
    modelConfig: JSON.stringify(model), storyboardMaterialList: [image], custom: 'preserve' }
  calls = []; onPut = undefined; onRead = undefined; otherBoard = undefined; readOverride = undefined; storage.lockFailure = false
  assets = new Map([[77, { id: 77, scriptId: 2708, assetType: 4, assetName: '周海生声音',
    assetUrl: voice.materialUrl, isLocal: 1 }]])
  client = new JubianClient({ credential: async () => 'token', fetch: async (url, init) => {
    const path = new URL(url instanceof Request ? url.url : url.toString()).pathname.replace('/prod-api', '')
    const method = String(init?.method)
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Row : undefined
    calls.push({ method, path, ...(body ? { body } : {}) })
    if (method === 'GET' && path === '/aigc/storyboard/1745324') {
      const current = structuredClone(board)
      await onRead?.(current)
      return new Response(JSON.stringify({ code: 200, data: readOverride === undefined ? current : readOverride }))
    }
    if (method === 'GET' && path === '/aigc/storyboard/1745325' && otherBoard) {
      const current = structuredClone(otherBoard)
      await onRead?.(current)
      return new Response(JSON.stringify({ code: 200, data: current }))
    }
    if (method === 'GET' && path.startsWith('/aigc/asset/')) {
      return new Response(JSON.stringify({ code: 200, data: assets.get(Number(path.split('/').pop())) ?? null }))
    }
    if (method === 'PUT' && path === '/aigc/storyboard' && body) {
      const current = structuredClone(body)
      if (body.id === 1745325) otherBoard = current
      else board = current
      onPut?.(current)
      return new Response(JSON.stringify({ code: 200, data: null }))
    }
    throw new Error(`Unexpected ${method} ${path}`)
  } })
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })
const preview = (references: Row[], prompt = audioPrompt) => storyboardAudioMethod(client, ledger, {
  method: 'audio_preview', project_dir: root, script_id: 2708, storyboard_id: 1745324,
  ...{ audio_references: references }, prompt,
})
const apply = (plan: Row, extra = {}) => storyboardAudioMethod(client, ledger, {
  method: 'audio_apply', project_dir: root, script_id: 2708, storyboard_id: 1745324,
  preview_path: String(plan.preview_path), expected_fingerprint: String(plan.fingerprint),
  idempotency_key: String(plan.fingerprint), ...extra,
})
const writes = () => calls.filter(call => call.method !== 'GET')

it('propagates a card-lock storage failure without fetching the current card or saving', async () => {
  const plan = await preview([voice]), start = calls.length
  storage.lockFailure = true
  await expect(apply(plan)).rejects.toMatchObject({ code: 'EACCES' })
  expect(calls.slice(start)).toEqual([])
})

it('reports fields removed from saved model and board data as a readback mismatch', async () => {
  const plan = await preview([voice])
  onPut = (body) => {
    const config = JSON.parse(String(body.modelConfig)) as Row
    delete config.seed
    body.modelConfig = config
    delete body.storyboardName
  }
  expect(await apply(plan)).toMatchObject({ status: 'readback_mismatch', verified_readback: false })
})

async function revisedPlan(plan: Row, change: (prepared: Row) => void, retainPath = false): Promise<Row> {
  const prepared = JSON.parse(await readFile(String(plan.preview_path), 'utf8')) as Row
  change(prepared)
  delete prepared.fingerprint
  const fingerprint = stableSha256(prepared)
  prepared.fingerprint = fingerprint
  const path = retainPath ? String(plan.preview_path) : join(root, 'video_tasks', `${fingerprint}.storyboard-audio.prepared.json`)
  await writeFile(path, JSON.stringify(prepared))
  return { fingerprint: retainPath ? plan.fingerprint : fingerprint, preview_path: path }
}

it.each([{ value: null }, { value: [] }, { value: 'not a card' }])('rejects nonobject provider card JSON %j', async ({ value }) => {
  readOverride = value
  await expect(preview([voice])).rejects.toMatchObject({ code: 'CONTRACT_CHANGED' })
  expect(writes()).toEqual([])
})

it.each(['broken', '[]', 'null'])('rejects malformed saved modelConfig %s', async (value) => {
  board.modelConfig = value
  await expect(preview([voice])).rejects.toMatchObject({ code: 'CONTRACT_CHANGED' })
  expect(writes()).toEqual([])
})

it.each(['broken', 'null', '[null]'])('rejects malformed model material-list JSON %s', async (value) => {
  board.modelConfig = JSON.stringify({ ...model, materialList: value })
  await expect(preview([voice])).rejects.toMatchObject({ code: 'CONTRACT_CHANGED' })
  expect(writes()).toEqual([])
})

it('reads a serialized model material list and retains the original prompt when removing all audio', async () => {
  board.modelConfig = JSON.stringify({ ...model, materialList: JSON.stringify([image]) })
  expect(await storyboardAudioMethod(client, ledger, { method: 'audio_preview', project_dir: root,
    script_id: 2708, storyboard_id: 1745324, audio_references: [] })).toMatchObject({ prompt: basePrompt })
  board.modelConfig = { ...model, prompt: null }
  await expect(storyboardAudioMethod(client, ledger, { method: 'audio_preview', project_dir: root,
    script_id: 2708, storyboard_id: 1745324, audio_references: [] })).rejects.toThrow('Missing storyboard prompt')
})

it('retains image materials when modelConfig has no materialList and rejects missing or empty prompt text', async () => {
  const config: Row = { ...model }
  delete config.materialList
  board.modelConfig = JSON.stringify(config)
  const plan = await preview([voice])
  expect(await apply(plan)).toMatchObject({ status: 'applied' })
  expect(JSON.parse(String(board.modelConfig))).toMatchObject({ materialList: [image, voice] })
  board.modelConfig = JSON.stringify({ ...model, prompt: 12 })
  await expect(preview([voice])).rejects.toThrow('complete audio-edit prompt')
  board.modelConfig = JSON.stringify(model)
  await expect(preview([voice], ' ')).rejects.toThrow('complete audio-edit prompt')
})

it('refuses a provider card with a different identity', async () => {
  board.id = 1745325
  await expect(preview([voice])).rejects.toThrow('identity mismatch')
  expect(writes()).toEqual([])
})

it('rejects an unknown audio operation without fetching or saving a card', async () => {
  await expect(storyboardAudioMethod(client, ledger, { method: 'other', project_dir: root,
    script_id: 2708, storyboard_id: 1745324 })).rejects.toThrow('Unknown storyboard audio method')
  expect(calls).toEqual([])
})

it.each([
  { version: 2 }, { operation: 'other' }, { prompt: null }, { request_hash: 12 }, { request_hash: 'sha256:broken' },
  { audio_references: {} }, { audio_references: 'broken' }, { audio_asset_bindings: {} },
  { audio_asset_bindings: [{ asset_id: 77, material_key: null, url: voice.materialUrl }] },
  { audio_asset_bindings: [{ asset_id: 77, material_key: voice.materialKey, url: null }] },
  { audio_asset_bindings: [{ asset_id: 77, material_key: 'other', url: voice.materialUrl }] },
  { audio_asset_bindings: [{ asset_id: 77, material_key: voice.materialKey, url: 'https://media.example/other.wav' }] },
  { before_snapshot: null }, { after_snapshot: [] },
])('rejects malformed frozen audio plan fields %j before saving', async (fields) => {
  const plan = await preview([voice]), changed = await revisedPlan(plan, (prepared) => { Object.assign(prepared, fields) })
  await expect(apply(changed)).rejects.toMatchObject({ code: 'CONTRACT_CHANGED' })
  expect(writes()).toEqual([])
})

it('rejects duplicate audio bindings and edited fingerprints before writing', async () => {
  const plan = await preview([{ ...voice, audio_asset_id: 77 }])
  const duplicate = await revisedPlan(plan, (prepared) => {
    const bindings = prepared.audio_asset_bindings as Row[]
    prepared.audio_asset_bindings = [...bindings, ...bindings]
  })
  await expect(apply(duplicate)).rejects.toThrow('Duplicate audio asset binding')
  const prepared = JSON.parse(await readFile(String(plan.preview_path), 'utf8')) as Row
  prepared.extra = 'unreviewed'
  await writeFile(String(plan.preview_path), JSON.stringify(prepared))
  await expect(apply(plan)).rejects.toThrow('fingerprint mismatch')
  expect(writes()).toEqual([])
})

it.each(['project', 'card', 'key'])('rejects a self-consistent audio plan for a different %s', async (kind) => {
  const plan = await preview([voice])
  const changed = await revisedPlan(plan, (prepared) => {
    if (kind === 'project') prepared.script_id = 2709
    else if (kind === 'card') prepared.storyboard_id = 1745325
    else prepared.prompt = `${audioPrompt}，新增文字`
  }, kind === 'key')
  await expect(apply(changed)).rejects.toThrow('project/card/key mismatch')
  expect(writes()).toEqual([])
})

it.each(['method', 'project', 'body'])('refuses a claimed key for another audio %s', async (kind) => {
  const plan = await preview([voice])
  await ledger.begin({ idempotencyKey: String(plan.fingerprint),
    method: kind === 'method' ? 'asset_remove' : 'storyboard_save',
    scriptId: kind === 'project' ? 2709 : 2708, requestSha256: kind === 'body' ? 'sha256:other' : String(plan.request_hash) })
  await expect(apply(plan)).rejects.toThrow('different audio edit')
  expect(writes()).toEqual([])
})

it('detects changes to provider fields excluded from the reviewed snapshot before sending', async () => {
  const plan = await preview([voice])
  board.custom = 'changed outside reviewed fields'
  await expect(apply(plan)).rejects.toThrow('request changed since audio preview')
  expect(writes()).toEqual([])
})

it.each(['provider', 'local'])('reports %s readback failure and replays an unsettled key without PUT', async (kind) => {
  const plan = await preview([voice])
  await ledger.begin({ idempotencyKey: String(plan.fingerprint), method: 'storyboard_save',
    scriptId: 2708, requestSha256: String(plan.request_hash) })
  if (kind === 'provider') onRead = async () => { throw new Error('provider disconnected') }
  else {
    const request = vi.spyOn(client, 'request').mockRejectedValueOnce(new Error('local reader unavailable'))
    onTestFinished(() => { request.mockRestore() })
  }
  expect(await apply(plan)).toMatchObject({ status: 'unknown', replayed: true, outcome: 'unknown',
    error: kind === 'provider' ? 'NETWORK_ERROR' : 'READBACK_FAILED' })
  expect(writes()).toEqual([])
})

it('propagates failure to record a fresh intent and releases the card lock without sending', async () => {
  const plan = await preview([voice])
  const claim = vi.spyOn(ledger, 'beginChecked').mockRejectedValueOnce(new Error('intent storage unavailable'))
  onTestFinished(() => { claim.mockRestore() })
  await expect(apply(plan)).rejects.toThrow('intent storage unavailable')
  expect(writes()).toEqual([])
  expect((await readdir(join(root, 'video_tasks'))).filter(name => name.endsWith('.storyboard-audio.lock'))).toEqual([])
})

it('previews adding a voice to the original card without changing images or generation settings', async () => {
  await expect(preview([voice])).resolves.toMatchObject({ status: 'ready', operation: 'storyboard_audio',
    before: [], after: [voice], paid_requests: 0 })
  expect(writes()).toEqual([])
})

it('adds the voice with one free PUT and verifies both material lists on the same card', async () => {
  const original = structuredClone(board)
  const plan = await preview([voice])
  expect(await apply(plan)).toMatchObject({ status: 'applied', verified_readback: true, paid_requests: 0 })
  expect(writes()).toHaveLength(1)
  expect(writes()[0]?.body).toEqual({ ...original, isGenerate: 0,
    modelConfig: JSON.stringify({ ...model, prompt: audioPrompt, materialList: [image, voice] }),
    storyboardMaterialList: [image, voice] })
  expect(calls.at(-1)).toMatchObject({ method: 'GET', path: '/aigc/storyboard/1745324' })
})

it('updates an existing voice URL without creating another card or losing image selections', async () => {
  board.modelConfig = JSON.stringify({ ...model, prompt: audioPrompt, materialList: [image, voice] })
  board.storyboardMaterialList = JSON.stringify([image, voice])
  const changed = { ...voice, materialUrl: 'https://media.example/revised.wav', audioDuration: 3 }
  const plan = await preview([changed])
  expect(await apply(plan)).toMatchObject({ status: 'applied', verified_readback: true })
  expect(JSON.parse(String(writes()[0]?.body?.storyboardMaterialList))).toEqual([image, changed])
  expect(writes()[0]?.body).toMatchObject({ id: 1745324, scriptId: 2708, episodeId: 13, episodeCount: 2 })
})

it('removes audio explicitly while retaining every original image and generation setting', async () => {
  board.modelConfig = { ...model, prompt: audioPrompt, materialList: [image, voice] }
  board.storyboardMaterialList = [image, voice]
  const plan = await preview([], basePrompt)
  expect(await apply(plan)).toMatchObject({ status: 'applied', verified_readback: true })
  expect(writes()[0]?.body?.modelConfig).toEqual(model)
  expect(writes()[0]?.body?.storyboardMaterialList).toEqual([image])
})

it('refuses stale generation settings before any PUT', async () => {
  const plan = await preview([voice])
  board.modelConfig = JSON.stringify({ ...model, duration: 28 })
  await expect(apply(plan)).rejects.toMatchObject({ code: 'CONTRACT_CHANGED' })
  expect(writes()).toEqual([])
  board.modelConfig = JSON.stringify(model)
  expect(await apply(plan)).toMatchObject({ status: 'applied', verified_readback: true })
})

it('refuses a new binding while an audio-asset deletion flag exists', async () => {
  const plan = await preview([{ ...voice, audio_asset_id: 77 }])
  const flag = join(root, '.audio-asset-delete.lock')
  await writeFile(flag, '', { flag: 'wx', mode: 0o600 })
  const start = calls.length
  await expect(apply(plan)).rejects.toMatchObject({ code: 'CONTRACT_CHANGED' })
  expect(calls.slice(start)).toEqual([])
  expect(writes()).toEqual([])
  await unlink(flag)
  expect(await apply(plan)).toMatchObject({ status: 'applied', verified_readback: true })
})

it('refuses deletion starting after the card lock is created and releases that card lock', async () => {
  const plan = await preview([{ ...voice, audio_asset_id: 77 }])
  const flag = join(root, '.audio-asset-delete.lock')
  const cardLock = join(root, 'video_tasks', '2708.1745324.storyboard-audio.lock')
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  const originalCheck = audioOperationLock.assertNoAudioDeletion
  const check = vi.spyOn(audioOperationLock, 'assertNoAudioDeletion')
  onTestFinished(() => { check.mockRestore() })
  let checks = 0
  check.mockImplementation(async (projectRoot) => {
    if (projectRoot === root && ++checks === 2) {
      expect((await lstat(cardLock)).isFile()).toBe(true)
      entered.resolve(undefined)
      await release.promise
    }
    await originalCheck(projectRoot)
  })
  const start = calls.length
  const operation = apply(plan)
  try {
    await Promise.race([entered.promise, operation.then(() => { throw new Error('Save finished before the second deletion check') })])
    await writeFile(flag, '', { flag: 'wx', mode: 0o600 })
    release.resolve(undefined)
    await expect(operation).rejects.toMatchObject({ code: 'CONTRACT_CHANGED' })
  } finally {
    release.resolve(undefined)
    await Promise.allSettled([operation])
    check.mockRestore()
  }
  expect(calls.slice(start)).toEqual([])
  expect(writes()).toEqual([])
  expect((await readdir(join(root, 'video_tasks'))).filter(name => name.endsWith('.storyboard-audio.lock'))).toEqual([])
  await unlink(flag)
  expect(await apply(plan)).toMatchObject({ status: 'applied', verified_readback: true })
})

it('refuses replay during deletion and only reads the original card after the flag is released', async () => {
  const plan = await preview([{ ...voice, audio_asset_id: 77 }])
  expect(await apply(plan)).toMatchObject({ status: 'applied', verified_readback: true })
  const flag = join(root, '.audio-asset-delete.lock')
  await writeFile(flag, '', { flag: 'wx', mode: 0o600 })
  const busyStart = calls.length
  await expect(apply(plan)).rejects.toMatchObject({ code: 'CONTRACT_CHANGED' })
  expect(calls.slice(busyStart)).toEqual([])
  await unlink(flag)
  assets.delete(77)
  const replayStart = calls.length
  expect(await apply(plan)).toMatchObject({ status: 'applied', replayed: true, verified_readback: true })
  expect(calls.slice(replayStart)).toEqual([{ method: 'GET', path: '/aigc/storyboard/1745324' }])
  expect(writes()).toHaveLength(1)
})

it('refuses a competing key while the original card is being checked and saved', async () => {
  const firstPlan = await preview([voice])
  const secondPlan = await preview([{ ...voice, materialUrl: 'https://media.example/revised.wav' }])
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  let firstRead = true
  onRead = async () => {
    if (firstRead) { firstRead = false; entered.resolve(undefined); await release.promise }
  }
  const first = apply(firstPlan)
  try {
    await Promise.race([entered.promise, first.then(() => { throw new Error('Save finished before the held card read') })])
    await expect(apply(secondPlan)).rejects.toMatchObject({ code: 'CONTRACT_CHANGED' })
    expect(writes()).toEqual([])
  } finally { release.resolve(undefined); await first }
  expect(writes()).toHaveLength(1)
  expect((await readdir(join(root, 'video_tasks'))).filter(name => name.endsWith('.storyboard-audio.lock'))).toEqual([])
})

it('allows another card to save while the first card is being checked', async () => {
  otherBoard = { ...structuredClone(board), id: 1745325 }
  const firstPlan = await preview([voice])
  const otherPlan = await storyboardAudioMethod(client, ledger, {
    method: 'audio_preview', project_dir: root, script_id: 2708, storyboard_id: 1745325,
    audio_references: [voice], prompt: audioPrompt,
  })
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  let firstRead = true
  onRead = async (current) => {
    if (current.id === 1745324 && firstRead) { firstRead = false; entered.resolve(undefined); await release.promise }
  }
  const first = apply(firstPlan)
  try {
    await Promise.race([entered.promise, first.then(() => { throw new Error('Save finished before the held card read') })])
    expect(await apply(otherPlan, { storyboard_id: 1745325 })).toMatchObject({ status: 'applied', verified_readback: true })
    expect(writes()[0]?.body?.id).toBe(1745325)
  } finally { release.resolve(undefined); await first }
  expect(writes()).toHaveLength(2)
})

it('holds the card lock until the saved state readback finishes', async () => {
  const firstPlan = await preview([voice])
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  let saved = false, paused = false
  onPut = () => { saved = true }
  onRead = async () => {
    if (saved && !paused) { paused = true; entered.resolve(undefined); await release.promise }
  }
  const first = apply(firstPlan)
  let nextPlan: Row
  try {
    await Promise.race([entered.promise, first.then(() => { throw new Error('Save finished before the held readback') })])
    nextPlan = await preview([{ ...voice, materialUrl: 'https://media.example/revised.wav' }])
    await expect(apply(nextPlan)).rejects.toMatchObject({ code: 'CONTRACT_CHANGED' })
    expect(writes()).toHaveLength(1)
  } finally { release.resolve(undefined); await first }
  expect(await apply(nextPlan)).toMatchObject({ status: 'applied', verified_readback: true })
  expect(writes()).toHaveLength(2)
})

it('requires the reviewed fingerprint and its matching idempotency key', async () => {
  const plan = await preview([voice])
  await expect(apply(plan, { expected_fingerprint: 'a'.repeat(64) })).rejects.toMatchObject({ code: 'CONTRACT_CHANGED' })
  await expect(apply(plan, { idempotency_key: 'other-key' })).rejects.toMatchObject({ code: 'CONTRACT_CHANGED' })
  expect(writes()).toEqual([])
})

it('rejects changing an image marker while adding a voice', async () => {
  await expect(preview([voice], '@[另一角色](zhou)声音参照@[周海生声音](zhou-voice)'))
    .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  expect(writes()).toEqual([])
})

it('rejects audio without matching prompt markers and duplicate material keys', async () => {
  await expect(preview([voice], basePrompt)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  await expect(preview([voice, { ...voice, sortOrder: 2 }])).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  expect(writes()).toEqual([])
})

it('rejects invalid audio URL and duration before saving the card', async () => {
  await expect(preview([{ ...voice, materialUrl: 'http://media.example/voice.wav' }]))
    .rejects.toMatchObject({ code: 'CONTRACT_CHANGED' })
  await expect(preview([{ ...voice, audioDuration: 16 }])).rejects.toMatchObject({ code: 'CONTRACT_CHANGED' })
  expect(writes()).toEqual([])
})

it('accepts provider audit churn and added fields while verifying requested audio and model fields', async () => {
  const plan = await preview([voice])
  onPut = (body) => {
    body.isGenerate = 1
    body.updateTime = 'new audit time'
    body.providerAdded = 'readback metadata'
    body.storyboardMaterialList = (body.storyboardMaterialList as Row[])
      .map(item => ({ ...item, id: 900, updateTime: 'changed', serverFlag: 1 }))
    const config = JSON.parse(String(body.modelConfig)) as Row
    config.providerExtra = true
    body.modelConfig = config
  }
  expect(await apply(plan)).toMatchObject({ status: 'applied', verified_readback: true })
})

it('reports a readback mismatch when the provider drops an image', async () => {
  const plan = await preview([voice])
  onPut = (body) => { body.storyboardMaterialList = [voice] }
  expect(await apply(plan)).toMatchObject({ status: 'readback_mismatch', verified_readback: false })
})

it('accepts provider-filled audio identifiers absent from the reviewed request', async () => {
  const plan = await preview([voice])
  onPut = (body) => {
    const enrich = (item: Row) => item.materialType === 'audio'
      ? { ...item, assetId: 901, materialAssetId: 902 } : item
    body.storyboardMaterialList = (body.storyboardMaterialList as Row[]).map(enrich)
    const config = JSON.parse(String(body.modelConfig)) as Row
    config.materialList = (config.materialList as Row[]).map(enrich)
    body.modelConfig = config
  }
  expect(await apply(plan)).toMatchObject({ status: 'applied', verified_readback: true })
})

it('reports a readback mismatch when the saved audio URL differs from the reviewed reference', async () => {
  const plan = await preview([voice])
  onPut = (body) => {
    body.storyboardMaterialList = [image, { ...voice, materialUrl: 'https://media.example/different.wav' }]
  }
  expect(await apply(plan)).toMatchObject({ status: 'readback_mismatch', verified_readback: false })
})

it.each([
  ['storyboardMaterialList', 'rename'], ['storyboardMaterialList', 'drop'],
  ['modelConfig', 'rename'], ['modelConfig', 'drop'],
])('reports a readback mismatch when %s materials %s the requested materialName', async (list, change) => {
  const named = { ...voice, materialName: 'reviewed voice name' }
  const plan = await preview([named])
  onPut = (body) => {
    const revised: Row = { ...named }
    if (change === 'drop') delete revised.materialName
    else revised.materialName = 'different voice name'
    if (list === 'storyboardMaterialList') body.storyboardMaterialList = [image, revised]
    else body.modelConfig = { ...model, prompt: audioPrompt, materialList: [image, revised] }
  }
  expect(await apply(plan)).toMatchObject({ status: 'readback_mismatch', verified_readback: false })
})

it('does not resend an unknown save and reconciles the applied card under the original key', async () => {
  const plan = await preview([voice])
  onPut = () => { throw new Error('connection interrupted after provider save') }
  expect(await apply(plan)).toMatchObject({ status: 'applied', outcome: 'unknown', verified_readback: true })
  expect(await apply(plan)).toMatchObject({ replayed: true, status: 'applied', verified_readback: true })
  expect(writes()).toHaveLength(1)
})

it.each([
  ['accepted', 'delete'], ['accepted', 'change URL'],
  ['unknown', 'delete'], ['unknown', 'change URL'],
])('reconciles an %s save after the audio library asset undergoes %s', async (outcome, change) => {
  const plan = await preview([{ ...voice, audio_asset_id: 77 }])
  if (outcome === 'unknown') onPut = () => { throw new Error('connection interrupted after provider save') }
  expect(await apply(plan)).toMatchObject({ status: 'applied', outcome, verified_readback: true })
  if (change === 'delete') assets.delete(77)
  else assets.set(77, { id: 77, scriptId: 2708, assetType: 4, assetUrl: 'https://media.example/replaced.wav' })
  const start = calls.length
  expect(await apply(plan)).toMatchObject({ status: 'applied', replayed: true, outcome, verified_readback: true })
  expect(calls.slice(start)).toEqual([{ method: 'GET', path: '/aigc/storyboard/1745324' }])
  expect(writes()).toHaveLength(1)
})

it.each(['image', 'video'])('rejects a direct audio preview containing a %s row', async (type) => {
  await expect(preview([{ ...voice, materialType: type }])).rejects.toMatchObject({ code: 'CONTRACT_CHANGED' })
  expect(writes()).toEqual([])
})

it('rejects a non-audio row from a self-consistent prepared file before saving', async () => {
  const plan = await preview([voice])
  const prepared = JSON.parse(await readFile(String(plan.preview_path), 'utf8')) as Row
  const nonAudio = { ...voice, materialType: 'image' }
  prepared.audio_references = [nonAudio]
  const after = prepared.after_snapshot as Row
  for (const row of after.storyboardMaterialList as Row[]) {
    if (row.materialKey === voice.materialKey) row.materialType = 'image'
  }
  for (const row of (after.modelConfig as Row).materialList as Row[]) {
    if (row.materialKey === voice.materialKey) row.materialType = 'image'
  }
  prepared.request_hash = bodyHash({ ...board, isGenerate: 0,
    modelConfig: JSON.stringify({ ...model, prompt: audioPrompt, materialList: [image, nonAudio] }),
    storyboardMaterialList: [image, nonAudio] })
  delete prepared.fingerprint
  const fingerprint = stableSha256(prepared)
  prepared.fingerprint = fingerprint
  const path = join(root, 'video_tasks', `${fingerprint}.storyboard-audio.prepared.json`)
  await writeFile(path, JSON.stringify(prepared))
  await expect(apply({ fingerprint, preview_path: path })).rejects.toMatchObject({ code: 'CONTRACT_CHANGED' })
  expect(writes()).toEqual([])
})

it('refuses a project mismatch and a noncanonical prepared path', async () => {
  await writeFile(join(root, 'project_config.json'), JSON.stringify({ jubian_script_id: 2709 }))
  await expect(preview([voice])).rejects.toMatchObject({ code: 'CONTRACT_CHANGED' })
  await writeFile(join(root, 'project_config.json'), JSON.stringify({ jubian_script_id: 2708 }))
  const plan = await preview([voice])
  await expect(apply(plan, { preview_path: join(root, 'unreviewed.json') })).rejects.toMatchObject({ code: 'CONTRACT_CHANGED' })
  expect(writes()).toEqual([])
})

it('freezes a verified audio-asset association without writing its local binding field to provider rows', async () => {
  const plan = await preview([{ ...voice, audio_asset_id: 77 }])
  expect(plan).toMatchObject({ audio_asset_bindings: [{ asset_id: 77, material_key: 'zhou-voice', url: voice.materialUrl }] })
  expect(await apply(plan)).toMatchObject({ status: 'applied', verified_readback: true })
  expect(writes()[0]?.body?.storyboardMaterialList).toEqual([image, voice])
  expect(JSON.parse(String(writes()[0]?.body?.modelConfig))).toMatchObject({ materialList: [image, voice] })
})

it('refuses binding an audio row to a different asset URL', async () => {
  await expect(preview([{ ...voice, audio_asset_id: 77, materialUrl: 'https://media.example/unrelated.wav' }]))
    .rejects.toMatchObject({ code: 'CONTRACT_CHANGED' })
  expect(writes()).toEqual([])
})

it('refuses an audio-asset deletion or URL change after preview before saving the card', async () => {
  const plan = await preview([{ ...voice, audio_asset_id: 77 }])
  assets.delete(77)
  await expect(apply(plan)).rejects.toMatchObject({ code: 'CONTRACT_CHANGED' })
  assets.set(77, { id: 77, scriptId: 2708, assetType: 4, assetUrl: 'https://media.example/replaced.wav', isLocal: 1 })
  await expect(apply(plan)).rejects.toMatchObject({ code: 'CONTRACT_CHANGED' })
  expect(writes()).toEqual([])
})
