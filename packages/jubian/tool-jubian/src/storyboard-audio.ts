/** Frozen, free audio-reference updates on existing storyboard cards with verified readback. */
import { join } from 'node:path'
import { open, readFile, unlink } from 'node:fs/promises'
import { JubianError } from '@deepseek-ai/dsh-jubian'
import type { JubianClient, JubianLedger } from '@deepseek-ai/dsh-jubian'
import { normalizedPrompt, referenceAudioUrls, stableJson, stableSha256, storyboardMaterials, validateAudioMaterial } from '@deepseek-ai/dsh-jubian-api'
import { atomicWriteJson, positiveInteger, validateProjectBinding } from './native.ts'
import { readPreparedJson } from './prepared-file.ts'
import { bodyHash, need, requireKey, writeUnderLedger } from './write.ts'
import { getAudioAsset } from './audio-asset-read.ts'
import { assertNoAudioDeletion } from './audio-operation-lock.ts'

type Row = Record<string, unknown>
const BOARD_FIELDS = ['id', 'scriptId', 'episodeId', 'episodeCount', 'scriptName', 'storyboardName', 'sortOrder'] as const
const MATERIAL_FIELDS = ['assetId', 'materialAssetId', 'materialType', 'materialUrl', 'fileName', 'materialName', 'materialKey', 'sortOrder', 'audioDuration'] as const

/** Schema-validated tool arguments for a complete audio-list replacement on one existing card. */
export interface StoryboardAudioArgs {
  /** Preview or apply the reviewed audio replacement. */
  method: string
  /** Existing project directory bound to script_id. */
  project_dir?: string
  /** Existing remote project ID. */
  script_id?: number
  /** Existing remote storyboard ID; no card is created. */
  storyboard_id?: number
  /** Ordered audio rows with optional local asset/character/period verification fields; [] removes all audio. */
  audio_references?: Row[]
  /** Complete updated prompt retaining the original image markers and their order. */
  prompt?: string
  /** Canonical project-bound preview path returned by audio_preview. */
  preview_path?: string
  /** Exact reviewed audio-preview fingerprint. */
  expected_fingerprint?: string
  /** Same preview fingerprint; a claimed key never sends another PUT. */
  idempotency_key?: string
}

interface AudioBinding {
  asset_id: number
  material_key: string
  url: string
  character_id?: string
  voice_period_id?: string
  voice_profile_fingerprint?: string
}
interface AudioPlan {
  version: 1
  operation: 'storyboard_audio'
  script_id: number
  storyboard_id: number
  audio_references: Row[]
  audio_asset_bindings: AudioBinding[]
  prompt: string
  before_snapshot: Row
  after_snapshot: Row
  request_hash: string
  fingerprint: string
}

function refuse(detail: string): never { throw new JubianError('CONTRACT_CHANGED', detail) }
function invalid(detail: string): never { throw new JubianError('INVALID_ARGUMENT', detail) }
function object(value: unknown): Row {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return refuse('Expected a JSON object')
  return value as Row
}
function configOf(board: Row): Row {
  if (typeof board.modelConfig !== 'string') return object(board.modelConfig)
  try { return object(JSON.parse(board.modelConfig)) }
  catch (error) { return refuse(error instanceof JubianError ? error.message : 'Invalid modelConfig JSON') }
}
function materials(value: unknown): Row[] {
  let parsed = value
  if (typeof value === 'string') {
    try { parsed = JSON.parse(value) }
    catch (_error) { return refuse('Invalid material-list JSON') }
  }
  if (!Array.isArray(parsed)) return refuse('Expected a material list')
  return parsed.map(object)
}
function markers(prompt: string): { name: string; key: string }[] {
  const seen = new Set<string>()
  return [...normalizedPrompt(prompt).matchAll(/@\[([^\]]+)\]\(([^()\s]+)\)/g)]
    .map(match => ({ name: String(match[1]), key: String(match[2]) }))
    .filter(marker => !seen.has(marker.key) && Boolean(seen.add(marker.key)))
}
function materialSnapshot(rows: Row[], expected?: Row[]): Row[] {
  return rows.map((row, index) => Object.fromEntries(MATERIAL_FIELDS
    .filter(field => Object.hasOwn(expected?.[index] ?? row, field))
    .map(field => [field, row[field] ?? null])))
}
async function verifyBindings(client: JubianClient, scriptId: number, bindings: AudioBinding[]): Promise<void> {
  for (const binding of bindings) {
    const asset = await getAudioAsset(client, scriptId, binding.asset_id)
    if (asset === null || asset.url !== binding.url) refuse('Audio asset is missing or its URL differs from the reviewed reference')
    if (asset.liveness === 'deleted' || (binding.voice_period_id !== undefined && asset.liveness !== 'active')) {
      refuse('Only this storyboard audio binding is pending: deleted asset or unconfirmed phased voice; continue independent work without saving this card')
    }
    if (binding.character_id !== undefined && asset.character_id !== undefined
      && (asset.character_id !== binding.character_id || asset.voice_period_id !== binding.voice_period_id)) {
      refuse('Remote voice slot differs from the requested character or life period')
    }
  }
}
function identityText(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) invalid(`${field} must be a nonempty stable ID`)
  return value
}
async function voiceFingerprint(root: string, scriptId: number, binding: AudioBinding): Promise<string> {
  let value: unknown
  try { value = JSON.parse((await readFile(join(root, 'project_config.json'), 'utf8')).replace(/^\uFEFF/, '')) }
  catch (_error) { return refuse('Cannot read current project voice identities') }
  const config = object(value)
  if (positiveInteger(config.jubian_script_id) !== scriptId) refuse('Project voice identity belongs to another project')
  const bible = object(config.project_bible)
  if (!Array.isArray(bible.characters)) refuse('Project voice identities are not configured')
  const characters = bible.characters.map(object).filter(row => row.character_id === binding.character_id)
  if (characters.length !== 1) refuse('Voice reference requires one exact stable character identity')
  const character = object(characters[0])
  const periods = character.voice_profiles === undefined ? [] : materials(character.voice_profiles)
  let profile: Row
  if (periods.length) {
    if (binding.voice_period_id === undefined) refuse('Phased character voice requires voice_period_id; no default voice fallback')
    const selected = periods.filter(row => row.voice_period_id === binding.voice_period_id)
    if (selected.length !== 1) refuse('Voice period is missing or ambiguous; no child/adult voice fallback')
    profile = object(selected[0])
  } else {
    if (binding.voice_period_id !== undefined) refuse('Voice period is not configured; no legacy voice fallback')
    profile = object(character.voice_profile)
  }
  if (profile.reference_audio_asset_id !== binding.asset_id || profile.reference_audio !== binding.url) {
    refuse('Audio asset ID and URL differ from the current character voice period')
  }
  return stableSha256(profile)
}
async function verifyVoiceIdentities(root: string, scriptId: number, bindings: AudioBinding[]): Promise<void> {
  for (const binding of bindings) {
    if (binding.character_id !== undefined
      && await voiceFingerprint(root, scriptId, binding) !== binding.voice_profile_fingerprint) {
      refuse('Character voice period changed since audio preview; preview again')
    }
  }
}
async function audioReferences(client: JubianClient, root: string, scriptId: number, input: Row[]): Promise<{
  audio: Row[]
  bindings: AudioBinding[]
}> {
  for (const row of input) validateAudioMaterial(row)
  referenceAudioUrls(input)
  const bindings: AudioBinding[] = []
  const audio = input.map((row) => {
    const { audio_asset_id: assetId, character_id: characterId, voice_period_id: periodId, ...material } = row
    if (characterId !== undefined || periodId !== undefined) {
      identityText(characterId, 'character_id')
      if (assetId === undefined) invalid('Character voice references require audio_asset_id')
    }
    if (assetId !== undefined) bindings.push({ asset_id: positiveInteger(assetId),
      material_key: String(material.materialKey), url: String(material.materialUrl),
      ...(characterId === undefined ? {} : { character_id: identityText(characterId, 'character_id') }),
      ...(periodId === undefined ? {} : { voice_period_id: identityText(periodId, 'voice_period_id') }) })
    return material
  })
  for (const binding of bindings) {
    if (binding.character_id !== undefined) binding.voice_profile_fingerprint = await voiceFingerprint(root, scriptId, binding)
  }
  await verifyBindings(client, scriptId, bindings)
  await verifyVoiceIdentities(root, scriptId, bindings)
  return { audio, bindings }
}
function snapshot(board: Row, expected?: Row): Row {
  const config = configOf(board)
  const expectedConfig = expected === undefined ? undefined : object(expected.modelConfig)
  const keys = expectedConfig === undefined ? Object.keys(config) : Object.keys(expectedConfig)
  const selected = Object.fromEntries(keys.map(key => [key, key === 'materialList'
    ? materialSnapshot(materials(config[key]), expectedConfig === undefined ? undefined : materials(expectedConfig[key]))
    : config[key] ?? null]))
  return { ...Object.fromEntries(BOARD_FIELDS.filter(field => Object.hasOwn(expected ?? board, field))
    .map(field => [field, board[field] ?? null])), modelConfig: selected,
  storyboardMaterialList: materialSnapshot(storyboardMaterials(board).materials,
    expected === undefined ? undefined : materials(expected.storyboardMaterialList)) }
}
async function readBoard(client: JubianClient, scriptId: number, storyboardId: number): Promise<Row> {
  const board = object((await client.request({ method: 'GET', path: `/aigc/storyboard/${storyboardId}` })).data)
  if (positiveInteger(board.id) !== storyboardId || positiveInteger(board.scriptId) !== scriptId) refuse('Storyboard identity mismatch')
  return board
}
function payload(board: Row, audio: Row[], prompt: string): Row {
  referenceAudioUrls(audio)
  const current = storyboardMaterials(board)
  const oldAudioKeys = current.materials.filter(row => row.materialType === 'audio').map(row => row.materialKey)
  const keys = audio.map(row => row.materialKey)
  const imageKeys = current.materials.filter(row => row.materialType !== 'audio').map(row => row.materialKey)
  if (new Set(keys).size !== keys.length || keys.some(key => imageKeys.includes(key))) invalid('Audio material keys must be unique and separate from image keys')
  const config = configOf(board)
  if (typeof config.prompt !== 'string' || !prompt.trim()) invalid('A complete audio-edit prompt is required')
  const oldImages = markers(config.prompt).filter(marker => !oldAudioKeys.includes(marker.key))
  const newMarkers = markers(prompt)
  const newImages = newMarkers.filter(marker => !keys.includes(marker.key))
  if (stableJson(oldImages) !== stableJson(newImages)) invalid('Audio edits must preserve image marker names, keys and order')
  if (stableJson(newMarkers.filter(marker => keys.includes(marker.key)).map(marker => marker.key)) !== stableJson(keys)) {
    invalid('Audio prompt markers must match the final audio keys in order')
  }
  const selected = [...current.materials.filter(row => row.materialType !== 'audio'), ...audio]
  const modelImages = config.materialList === undefined ? current.materials.filter(row => row.materialType !== 'audio')
    : materials(config.materialList).filter(row => row.materialType !== 'audio')
  const nextConfig = { ...config, prompt, materialList: [...modelImages, ...audio] }
  return { ...board, isGenerate: 0,
    modelConfig: typeof board.modelConfig === 'string' ? JSON.stringify(nextConfig) : nextConfig,
    storyboardMaterialList: current.serialized ? JSON.stringify(selected) : selected }
}
function planOf(board: Row, audio: Row[], bindings: AudioBinding[], prompt: string): AudioPlan {
  const body = payload(board, audio, prompt)
  const plan = { version: 1, operation: 'storyboard_audio', script_id: positiveInteger(board.scriptId),
    storyboard_id: positiveInteger(board.id), audio_references: audio, audio_asset_bindings: bindings, prompt,
    before_snapshot: snapshot(board), after_snapshot: snapshot(body), request_hash: bodyHash(body) } as const
  return { ...plan, fingerprint: stableSha256(plan) }
}
function parsePlan(value: unknown): AudioPlan {
  const raw = object(value)
  if (raw.version !== 1 || raw.operation !== 'storyboard_audio' || typeof raw.prompt !== 'string'
    || typeof raw.request_hash !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(raw.request_hash)) refuse('Invalid storyboard audio preview')
  const audio = materials(raw.audio_references)
  for (const row of audio) {
    if (['audio_asset_id', 'character_id', 'voice_period_id'].some(field => Object.hasOwn(row, field))) {
      refuse('Frozen provider audio rows must omit local identity fields')
    }
    validateAudioMaterial(row)
  }
  referenceAudioUrls(audio)
  if (!Array.isArray(raw.audio_asset_bindings)) refuse('Invalid audio asset bindings')
  const bindings = raw.audio_asset_bindings.map((value): AudioBinding => {
    const binding = object(value)
    if (typeof binding.material_key !== 'string' || typeof binding.url !== 'string'
      || !audio.some(row => row.materialKey === binding.material_key && row.materialUrl === binding.url)) {
      refuse('Audio asset binding differs from the reviewed audio row')
    }
    if ((binding.character_id === undefined && (binding.voice_period_id !== undefined || binding.voice_profile_fingerprint !== undefined))
      || (binding.character_id !== undefined && (typeof binding.voice_profile_fingerprint !== 'string'
        || !/^[a-f0-9]{64}$/.test(binding.voice_profile_fingerprint)))) refuse('Invalid frozen voice identity')
    const identity = binding.character_id === undefined ? {} : {
      character_id: identityText(binding.character_id, 'character_id'),
      ...(binding.voice_period_id === undefined ? {} : { voice_period_id: identityText(binding.voice_period_id, 'voice_period_id') }),
      voice_profile_fingerprint: String(binding.voice_profile_fingerprint),
    }
    return { asset_id: positiveInteger(binding.asset_id), material_key: binding.material_key, url: binding.url, ...identity }
  })
  if (new Set(bindings.map(binding => binding.material_key)).size !== bindings.length) refuse('Duplicate audio asset binding')
  const plan = { version: 1, operation: 'storyboard_audio', script_id: positiveInteger(raw.script_id),
    storyboard_id: positiveInteger(raw.storyboard_id), audio_references: audio, audio_asset_bindings: bindings, prompt: raw.prompt,
    before_snapshot: object(raw.before_snapshot), after_snapshot: object(raw.after_snapshot), request_hash: raw.request_hash } as const
  const result = { ...plan, fingerprint: stableSha256(plan) }
  if (raw.fingerprint !== result.fingerprint || stableJson(raw) !== stableJson(result)) refuse('Audio preview fingerprint mismatch')
  return result
}
async function readback(client: JubianClient, plan: AudioPlan, replayed: boolean, outcome: string): Promise<Row> {
  try {
    const live = await readBoard(client, plan.script_id, plan.storyboard_id)
    const verified = stableSha256(snapshot(live, plan.after_snapshot)) === stableSha256(plan.after_snapshot)
    return { status: verified ? 'applied' : 'readback_mismatch', replayed, outcome,
      storyboard_id: plan.storyboard_id, verified_readback: verified, paid_requests: 0 }
  } catch (error) {
    return { status: 'unknown', replayed, outcome, storyboard_id: plan.storyboard_id,
      verified_readback: false, paid_requests: 0, error: error instanceof JubianError ? error.code : 'READBACK_FAILED' }
  }
}

/**
 * Preview or replace one existing card's audio references without creating a card or generating media.
 * Image rows, model selectors, duration and episode identity are retained. Apply requires the exact
 * preview fingerprint and key; claimed or unknown writes only reconcile through a fresh GET.
 * Readback compares requested fields and excludes provider-added fields and material row IDs.
 * Preview input and frozen files require audio-only rows in consecutive group order.
 * An exclusive project-local card lock covers apply's live checks, PUT and readback; a competing
 * audio apply refuses while that lock exists. This lock does not serialize provider UI edits.
 * Apply checks the project's deletion flag before and after acquiring the card lock; both new
 * writes and claimed-key readback refuse while a local project audio deletion is active.
 * Optional audio_asset_id associations are independently verified on preview and before a new PUT,
 * then omitted from provider material rows. Optional character_id and voice_period_id require the
 * exact current character's reference ID and URL, retain the selected profile fingerprint in the
 * preview and recheck it before a new PUT. Phased voices never fall back to a legacy default or
 * another period. Deleted assets are rejected; phased references require explicit active evidence.
 * Legacy unphased references retain compatibility when deletion evidence is absent. Refusal affects
 * this card's audio edit only; it sends no PUT and does not block independent work.
 * Local identity fields are omitted from provider material rows.
 * A claimed key only reads the original card, even if its
 * audio-library asset has changed. URL-only references remain supported without a fabricated asset ID.
 * @param client - Current-card reads and the single free isGenerate=0 PUT transport.
 * @param ledger - Durable write claims preventing repeated saves under one reviewed key.
 * @param args - Bound card, final audio list and prompt for preview, or frozen preview fields for apply.
 * @returns Preview before/after audio and declared changes, or independently reported save/readback outcomes.
 * @throws {JubianError} For an unbound project, invalid audio/markers, stale card or mismatched preview.
 */
export async function storyboardAudioMethod(client: JubianClient, ledger: JubianLedger, args: StoryboardAudioArgs): Promise<Row> {
  const scriptId = positiveInteger(need(args.script_id, 'script_id'))
  const storyboardId = positiveInteger(need(args.storyboard_id, 'storyboard_id'))
  const binding = await validateProjectBinding(need(args.project_dir, 'project_dir'), scriptId)
  if (args.method === 'audio_preview') {
    const board = await readBoard(client, scriptId, storyboardId)
    const { audio, bindings } = await audioReferences(client, binding.project_root, scriptId,
      structuredClone(need(args.audio_references, 'audio_references')))
    const config = configOf(board)
    const prompt = args.prompt ?? (typeof config.prompt === 'string' ? config.prompt : invalid('Missing storyboard prompt'))
    const plan = planOf(board, audio, bindings, prompt)
    const path = join(binding.project_root, 'video_tasks', `${plan.fingerprint}.storyboard-audio.prepared.json`)
    await atomicWriteJson(path, plan)
    return { ...plan, status: 'ready', before: storyboardMaterials(board).materials.filter(row => row.materialType === 'audio'),
      after: audio, changed_fields: ['storyboardMaterialList.audio', 'modelConfig.materialList.audio', 'modelConfig.prompt'],
      preserved_fields: ['image_materials', 'model_selectors', 'duration', 'episode_binding', 'storyboard_identity'],
      preview_path: path, paid_requests: 0 }
  }
  if (args.method !== 'audio_apply') invalid('Unknown storyboard audio method')
  const key = requireKey(args.idempotency_key)
  if (need(args.expected_fingerprint, 'expected_fingerprint') !== key) refuse('Reviewed audio fingerprint/key mismatch')
  const plan = parsePlan(await readPreparedJson(binding.project_root, key, need(args.preview_path, 'preview_path'), 'storyboard-audio'))
  if (plan.fingerprint !== key || plan.script_id !== scriptId || plan.storyboard_id !== storyboardId) refuse('Audio preview project/card/key mismatch')
  await assertNoAudioDeletion(binding.project_root)
  const lockPath = join(binding.project_root, 'video_tasks', `${scriptId}.${storyboardId}.storyboard-audio.lock`)
  const lock = await open(lockPath, 'wx', 0o600).catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
      refuse('Another audio edit holds this storyboard lock; inspect that writer before removing an abandoned lock')
    }
    throw error
  })
  try {
    await assertNoAudioDeletion(binding.project_root)
    const prior = await ledger.find(key)
    if (prior !== undefined) {
      if (prior.method !== 'storyboard_save' || prior.script_id !== scriptId || prior.request_sha256 !== plan.request_hash) refuse('Idempotency key belongs to a different audio edit')
      return await readback(client, plan, true, prior.outcome ?? 'unknown')
    }
    await verifyBindings(client, scriptId, plan.audio_asset_bindings)
    const board = await readBoard(client, scriptId, storyboardId)
    if (stableSha256(snapshot(board, plan.before_snapshot)) !== stableSha256(plan.before_snapshot)) refuse('Stale storyboard audio preview; preview again')
    const body = payload(board, plan.audio_references, plan.prompt)
    if (bodyHash(body) !== plan.request_hash) refuse('Storyboard request changed since audio preview; preview again')
    await verifyVoiceIdentities(binding.project_root, scriptId, plan.audio_asset_bindings)
    const send = { started: false }
    let replayed = false
    let outcome = 'unknown'
    try {
      const result = await writeUnderLedger(ledger, key, 'storyboard_save', () => body, (payload) => {
        send.started = true
        return client.request({ method: 'PUT', path: '/aigc/storyboard', body: need(payload) })
      }, undefined, { scriptId })
      replayed = result.replayed
      outcome = result.outcome
    } catch (error) {
      if (!send.started) throw error
    }
    return await readback(client, plan, replayed, outcome)
  } finally {
    try { await lock.close() } finally { await unlink(lockPath) }
  }
}
