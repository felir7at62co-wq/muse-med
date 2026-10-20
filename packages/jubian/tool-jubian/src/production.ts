/** Free production-plan publication through the existing storyboard write ledger. */
import type { JubianClient } from '@deepseek-ai/dsh-jubian'
import { JubianLedger } from '@deepseek-ai/dsh-jubian'
import { readAssetList, readEpisodes, readMaterialList, readStoryboard, readStoryboardPage, readVoiceSlot,
  stableSha256, storyboardMaterials, trustedSubjectId } from '@deepseek-ai/dsh-jubian-api'
import { storyboardMethod } from './methods.ts'

type Row = Record<string, unknown>

/** Complete live inventory, bounded by provider pagination rather than output truncation. */
export interface ProductionLibraryEntry {
  asset_id: number
  name: string
  kind: 'character' | 'scene' | 'prop' | 'voice'
  url: string | null
  material_id: string | null
  usable: boolean
  character_id?: string | undefined
  voice_period_id?: string | undefined
  duration_seconds?: number | undefined
}

function object(value: unknown): Row {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid project inventory response')
  return value as Row
}
function url(value: unknown): string | null {
  if (typeof value !== 'string') return null
  try { const parsed = new URL(value); return parsed.protocol === 'https:' && !parsed.username && !parsed.password ? value : null }
  catch (_error) { return null }
}

/** Read all asset or subject pages, refusing duplicate or incomplete inventory evidence.
 * @param client - Authenticated transport.
 * @param scriptId - Bound remote project.
 * @param kind - Provider inventory being read.
 * @param pageSize - Configured page size.
 * @param pageLimit - Maximum pages to acquire.
 * @param signal - Cancellation checked before every page.
 * @returns Original validated inventory rows.
 */
export async function productionRows(client: JubianClient, scriptId: number, kind: 'asset' | 'material' | 'storyboard' | 'episode',
  pageSize: number, pageLimit: number, signal: AbortSignal): Promise<Row[]> {
  const result: Row[] = [], seen = new Set<number>()
  let total: number | null = null
  for (let page = 1; page <= pageLimit; page++) {
    signal.throwIfAborted()
    const { data } = await client.request({ method: 'GET',
      path: `/aigc/${kind}/list?scriptId=${scriptId}&pageNum=${page}&pageSize=${pageSize}` })
    const payload = object(data)
    const parsed = kind === 'asset' ? readAssetList(data) : kind === 'material' ? readMaterialList(data)
      : kind === 'episode' ? readEpisodes(data) : readStoryboardPage(data, scriptId)
    if (!Array.isArray(payload.rows) || typeof payload.total !== 'number' || !Number.isSafeInteger(payload.total)
      || payload.total < 0 || typeof parsed.total !== 'number' || total !== null && total !== parsed.total) {
      throw new Error('Project inventory pagination is incomplete or changed; read the inventory again')
    }
    if (payload.rows.length > pageSize) throw new Error('Provider inventory page exceeds the configured acquisition bound')
    total = parsed.total
    for (const value of payload.rows) {
      const row = object(value), id = Number(row.id)
      if (!Number.isSafeInteger(id) || id < 1 || seen.has(id)) throw new Error('Duplicate or invalid project inventory identity')
      if (row.scriptId !== undefined && Number(row.scriptId) !== scriptId) throw new Error('Project inventory contains a foreign asset')
      seen.add(id); result.push(row)
    }
    if (result.length === total) return result
    if (!payload.rows.length || result.length > total) break
  }
  throw new Error('Project inventory exceeds the configured page limit or is incomplete; no complete-inventory claim is available')
}

/** Read project image and voice candidates without generating or registering assets.
 * @param client - Authenticated transport.
 * @param scriptId - Bound remote project.
 * @param pageSize - Configured provider page size.
 * @param pageLimit - Configured maximum pages per inventory.
 * @param signal - Foreground cancellation.
 * @returns Live asset names, usable image references, and explicitly registered voice identities.
 */
export async function readProductionLibrary(client: JubianClient, scriptId: number, pageSize: number,
  pageLimit: number, signal: AbortSignal): Promise<ProductionLibraryEntry[]> {
  const assets = await productionRows(client, scriptId, 'asset', pageSize, pageLimit, signal)
  const materials = await productionRows(client, scriptId, 'material', pageSize, pageLimit, signal)
  return assets.flatMap((row): ProductionLibraryEntry[] => {
    const kind = Number(row.assetType) === 1 ? 'character' : Number(row.assetType) === 2 ? 'scene' : Number(row.assetType) === 3 ? 'prop'
      : Number(row.assetType) === 4 ? 'voice' : null
    if (kind === null || typeof row.assetName !== 'string') return []
    const active = String(row.delFlag) === '0'
    const selected = materials.filter(item => Number(item.assetId) === Number(row.id) && Number(item.isUsed) === 1
      && String(item.hsAssetStatus).trim().toLowerCase() === 'active')
    const material = selected.length === 1 ? selected[0] : undefined
    const address = url(kind === 'voice' ? row.assetUrl : material?.assetUrl)
    const subjectId = material === undefined ? null : trustedSubjectId(material.hsAssetId)
    const materialId = subjectId === null ? null : String(subjectId)
    const voice = kind === 'voice' ? readVoiceSlot(row.assetName, scriptId) : undefined
    return [{ asset_id: Number(row.id), name: row.assetName, kind, url: address, material_id: materialId,
      usable: active && address !== null && (kind === 'voice' || materialId !== null),
      ...(voice === undefined ? {} : { character_id: voice.character_id, voice_period_id: voice.voice_period_id }),
    }]
  })
}

/** One free card write; the caller supplies a complete reviewed package. */
export interface ProductionCardInput {
  project_dir: string
  script_id: number
  episode_id: number
  script_name: string
  episode: number
  name: string
  index: number
  prompt: string
  model: Row
  storyboard_id: number | null
  expected_snapshot_sha256: string | null
  images: { asset_id: number; material_key: string }[]
  voices: ProductionLibraryEntry[]
  key: string
  page_size: number
  page_limit: number
}

/** Read a full current card and an exact snapshot digest.
 * @param client - Authenticated transport.
 * @param storyboardId - Actual remote card ID.
 * @returns Parsed card and digest of editable content, selectors and bindings; audit and task fields do not change it.
 */
export async function productionCard(client: JubianClient, storyboardId: number): Promise<{
  card: ReturnType<typeof readStoryboard>
  sha256: string
}> {
  const { data } = await client.request({ method: 'GET', path: `/aigc/storyboard/${storyboardId}` })
  const card = readStoryboard(data, storyboardId)
  const materialFields = ['materialAssetId', 'assetId', 'materialKey', 'materialType', 'materialUrl', 'fileName', 'sortOrder', 'audioDuration']
  const materials = storyboardMaterials(card.snapshot).materials.map(item => Object.fromEntries(materialFields
    .filter(key => item[key] !== undefined).map(key => [key, item[key]])))
  const config = { ...card.model_config }
  delete config.materialList
  return { card, sha256: stableSha256({ script_id: card.script_id, episode_id: card.snapshot.episodeId ?? null,
    episode_count: card.snapshot.episodeCount ?? null, name: card.name, sort_order: card.snapshot.sortOrder ?? null,
    model: config, materials }) }
}

/** Save one production package without calling any paid generation method.
 * @param client - Authenticated transport.
 * @param ledger - Existing account-local storyboard ledger.
 * @param input - Frozen package and original expected card version.
 * @param signal - Checked before each possible remote mutation.
 * @returns Actual card identity and readback; unknown creation never retries with another key.
 */
export async function publishProductionCard(client: JubianClient, ledger: JubianLedger, input: ProductionCardInput,
  signal: AbortSignal): Promise<Row> {
  let id = input.storyboard_id
  let prompt = input.prompt
  let oldAudio: Row[] = []
  const run = (args: Parameters<typeof storyboardMethod>[2]) => {
    signal.throwIfAborted()
    return storyboardMethod(client, ledger, args)
  }
  if (id === null) {
    const recorded = await ledger.find(`${input.key}-create`)
    const boards = await productionRows(client, input.script_id, 'storyboard', input.page_size, input.page_limit, signal)
    const existing = boards.filter(row => Number(row.episodeId) === input.episode_id && row.storyboardName === input.name)
    if (!recorded && existing.length) return { status: 'current_card_changed', paid_requests: 0,
      next: '预览后出现了同集同名卡；update回读实际原卡，不重复创建。' }
    const result = await run({ method: 'create', idempotency_key: `${input.key}-create`, body: {
      scriptId: input.script_id, episodeId: input.episode_id, episodeCount: input.episode,
      scriptName: input.script_name, storyboardName: input.name, sortOrder: input.index - 1,
      isGenerate: 0, modelConfig: JSON.stringify(input.model),
    } })
    const data = result.data
    const candidate = typeof data === 'number' ? data : data && typeof data === 'object' && !Array.isArray(data)
      ? Number((data as Row).id) : NaN
    if (Number.isSafeInteger(candidate) && candidate > 0) id = candidate
    const existingCard = existing[0]
    if (id === null && recorded && existing.length === 1 && existingCard !== undefined) {
      const current = await productionCard(client, Number(existingCard.id))
      if (current.card.model_config.prompt === input.prompt) id = current.card.storyboard_id
    }
    if (id === null) return { status: 'reconcile_required', name: input.name, original_key: `${input.key}-create`,
      paid_requests: 0, next: '创建回执没有唯一卡ID；只查询同项目、同集、同名卡核对，不换key重建。' }
  } else {
    const current = await productionCard(client, id)
    if (input.expected_snapshot_sha256 !== current.sha256) return { status: 'current_card_changed', storyboard_id: id,
      paid_requests: 0, current: current.card, next: '原卡在预览后发生变化；保留用户和协作者当前版本，重新预览差异后再修改。' }
    oldAudio = storyboardMaterials(current.card.snapshot).materials.filter(item => item.materialType === 'audio')
    if (oldAudio.length) prompt += '\n声音参考：' + oldAudio.map(item => `@[${String(item.fileName ?? item.materialName)}](${String(item.materialKey)})`).join('、')
    const preview = await run({ method: 'edit_preview', script_id: input.script_id, project_dir: input.project_dir,
      storyboard_id: id, changes: { prompt, duration: Number(input.model.duration), name: input.name, episode_id: input.episode_id,
        modelId: String(input.model.modelId), platformId: String(input.model.platformId),
        ratio: String(input.model.ratio), resolution: String(input.model.resolution), genType: Number(input.model.genType) } })
    const applied = await run({ method: 'edit_apply', script_id: input.script_id, project_dir: input.project_dir,
      preview_path: String(preview.preview_path), idempotency_key: String(preview.fingerprint) })
    if (!['applied', 'needs_reselect', 'replayed'].includes(String(applied.status))) return { ...applied, storyboard_id: id }
  }
  const saved = await productionCard(client, id)
  if (saved.card.script_id !== input.script_id || saved.card.snapshot.episodeId !== input.episode_id
    || saved.card.model_config.prompt !== prompt) return { status: 'readback_mismatch', storyboard_id: id, paid_requests: 0 }
  const selection = await run({ method: 'select_assets', storyboard_id: id, selections: input.images,
    idempotency_key: `${input.key}-images` })
  if (!['applied', 'already_applied'].includes(String(selection.status))) return { ...selection, storyboard_id: id }
  const measured = input.voices.flatMap(voice => voice.usable && voice.url && voice.duration_seconds !== undefined
    ? [{ ...voice, url: voice.url, duration_seconds: voice.duration_seconds }] : [])
  if (measured.length || oldAudio.length) {
    const prompt = input.prompt + (measured.length ? '\n本包声音参考：' + measured.map(voice => `@[${voice.name}](voice_${voice.asset_id})`).join('、') : '')
    const preview = await run({ method: 'audio_preview', script_id: input.script_id, project_dir: input.project_dir,
      storyboard_id: id, prompt, audio_references: measured.map((voice, index) => ({ materialType: 'audio',
        materialKey: `voice_${voice.asset_id}`, materialUrl: voice.url, fileName: voice.name,
        sortOrder: index + 1, audioDuration: voice.duration_seconds, audio_asset_id: voice.asset_id })) })
    const applied = await run({ method: 'audio_apply', script_id: input.script_id, project_dir: input.project_dir,
      storyboard_id: id, preview_path: String(preview.preview_path), expected_fingerprint: String(preview.fingerprint),
      idempotency_key: String(preview.fingerprint) })
    if (applied.status !== 'applied' || applied.verified_readback !== true) return { ...applied, storyboard_id: id }
  }
  const after = await productionCard(client, id)
  const expectedPrompt = input.prompt + (measured.length ? '\n本包声音参考：'
    + measured.map(voice => `@[${voice.name}](voice_${voice.asset_id})`).join('、') : '')
  const config = after.card.model_config
  const modelFields = ['modelId', 'platformId', 'standardId', 'modelGenerationTypeId', 'videoStandardId',
    'genType', 'ratio', 'resolution', 'duration', 'genNum']
  const images = storyboardMaterials(after.card.snapshot).materials.filter(item => item.materialType === 'image')
  const imageIdentity = images.map(item => [Number(item.materialAssetId), String(item.materialKey)])
  if (config.prompt !== expectedPrompt || modelFields.some(field => String(config[field]) !== String(input.model[field]))
    || JSON.stringify(imageIdentity) !== JSON.stringify(input.images.map(item => [item.asset_id, item.material_key]))) {
    return { status: 'readback_mismatch', storyboard_id: id, paid_requests: 0, verified_readback: after.card,
      next: '最终原卡与本次模型、提示词或选材不一致；保留原回执核对，不宣称保存通过。' }
  }
  return { status: 'saved', storyboard_id: id, verified_readback: after.card, snapshot_sha256: after.sha256,
    paid_requests: 0, unbound_voice_ids: input.voices.filter(voice => !measured.some(item => item.asset_id === voice.asset_id))
      .map(voice => voice.asset_id),
    next: '卡片已保存并真实回读；这只证明写入结果。Muse对照本镜需求和实际图片／音频复检，再按任务授权prepare_video；未生成。' }
}
