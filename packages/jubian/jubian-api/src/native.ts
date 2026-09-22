/**
 * The storyboard-native subject-video contract: one preview, one PUT, then only
 * reconciliation.
 *
 * The provider translates subject identity server-side when a storyboard PUT
 * runs with `isGenerate=1`; a direct task `POST` with the same image URLs does
 * not preserve that identity (production task `335470` lost `assetId` and
 * `materialName` and failed, while `335343` from the storyboard PUT kept all
 * seven and succeeded). Everything in this module exists to make the PUT path
 * exact: the payload is derived from the provider's own live snapshot, its
 * fingerprint is a deterministic function of the submission semantics alone, and
 * the claim that a remote task belongs to that submission is only made when the
 * ordered trusted identity, the model signature and the prompt all agree.
 *
 * Two rules decide the shape of the code. Nothing here guesses ownership: a
 * missing or unreadable identity is `subject_identity_lost`, and more than one
 * exact candidate is a conflict, never a pick. And no result is a retry signal —
 * an ambiguous PUT response leaves reconciliation as the only next step.
 */
import { createHash } from 'node:crypto'
import { JubianError } from '@deepseek-ai/dsh-jubian'

function invalid(): never { throw new JubianError('CONTRACT_CHANGED') }

/** Provider statuses that mean a task finished successfully. */
export const SUCCESS_STATUSES = ['succeeded', 'completed'] as const

/** Provider statuses that mean a task reached a terminal failure. */
export const FAILED_STATUSES = ['failed', 'no_all_failed', 'cancelled', 'expired'] as const

/** The model-field subset that must agree before a remote task is claimed. */
export const NATIVE_MODEL_FIELDS = ['platformId', 'modelId', 'standardId', 'genType',
  'modelGenerationTypeId', 'videoStandardId', 'duration', 'ratio', 'resolution', 'genNum'] as const

/** One ordered trusted subject identity, as the provider records it on a child. */
export interface SubjectIdentityItem {
  /** The trusted multimedia-library identity (`hsAssetId`), not the numeric parent. */
  assetId: string
  /** The material name the provider persisted, and therefore the one it can re-read. */
  materialName: string
  /** The official HTTPS image URL bound to that identity. */
  imageUrl: string
}

/** The selectors for one exact video model and specification, read from the live catalogue. */
export interface SeedanceVideoModel {
  platformId: string
  modelId: string
  standardId: number
  genType: number
  modelGenerationTypeId: number
  videoStandardId: number
  duration: number
  ratio: string
  resolution: string
  genNum: 1
}

/** One ordered asset summary entry of a prepared preview. */
export interface NativeOrderedAsset extends SubjectIdentityItem {
  /** The numeric parent asset the subject-setting row points at. */
  materialAssetId: number
  /** The prompt's own placeholder key for this material. */
  materialKey: string
}

/** The storyboard-native preview one `prepare_video` writes and `submit_video` reads. */
export interface NativeVideoPreview {
  version: 1
  operation: 'prepare_storyboard_native_video'
  status: 'prepared'
  createdAt: string
  scriptId: number
  storyboardId: number
  /** Deterministic sha256 of the submission semantics; the submission's only key. */
  idempotencyKey: string
  estimatedSubmissions: 1
  assetSummary: { count: number; orderedAssets: NativeOrderedAsset[] }
  /** The exact one-PUT body, with `isGenerate=1`. */
  payload: Record<string, unknown>
  nextAction: string
}

/** One hydrated remote task: its detail plus the children matching the storyboard. */
export interface HydratedTask {
  taskId: string
  task: Record<string, unknown>
  children: Record<string, unknown>[]
}

/** The verdict of claiming one remote task for a submission. */
export type NativeClaim =
  | { status: 'matched'; taskId: string; task: Record<string, unknown>; child: Record<string, unknown> }
  | { status: 'subject_identity_lost'
    taskId: string | null
    task: Record<string, unknown> | null
    child: Record<string, unknown> | null }
  | { status: 'reconcile_conflict' }
  | { status: 'none' }

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid()
  return value as Record<string, unknown>
}

function records(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.map(object)
  if (!value || typeof value !== 'object') return []
  const nested = value as Record<string, unknown>
  if ('rows' in nested) return Array.isArray(nested.rows) ? nested.rows.map(object) : invalid()
  return [nested]
}

/**
 * Read one wire scalar as text, never stringifying an object.
 *
 * Provider payloads mix numbers and numeric strings for the same field, so a
 * reader has to normalize them; an object where a scalar belongs is a contract
 * change, and `String({})` would quietly turn it into `"[object Object]"`.
 * @param value - Any provider value.
 * @returns The text form of a string, finite number or boolean, otherwise null.
 */
export function wireText(value: unknown): string | null {
  if (typeof value === 'string') return value
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : null
  if (typeof value === 'boolean') return String(value)
  return null
}

function integer(value: unknown): number {
  const candidate = typeof value === 'string' && /^[0-9]+$/.test(value.trim()) ? Number(value.trim()) : value
  if (typeof candidate !== 'number' || !Number.isSafeInteger(candidate) || candidate < 1) invalid()
  return candidate
}

function text(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || !value.isWellFormed()) invalid()
  return value
}

function httpUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.hostname && !url.username && !url.password && !value.includes('\\')
      ? value : null
  } catch { return null }
}

/** Parse a storyboard field the provider serializes as JSON on some routes and inline on others. */
function storyboardObject(value: unknown): unknown {
  if (typeof value === 'string') {
    try { return JSON.parse(value) as unknown } catch { invalid() }
  }
  return value
}

/**
 * Canonical JSON of a value: keys sorted, no insignificant whitespace.
 *
 * The preview fingerprint is a hash of this form, so it must depend on the
 * submission's semantics and on nothing else — not on key insertion order and
 * not on the platform's default number formatting.
 * @param value - Any JSON value.
 * @returns The canonical JSON text.
 */
export function stableJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return JSON.stringify(value)
  if (typeof value === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(item => stableJson(item)).join(',')}]`
  const entries = Object.entries(object(value)).sort(([left], [right]) => (left < right ? -1 : 1))
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`
}

/**
 * Hash one value with its canonical JSON form.
 * @param value - Any JSON value.
 * @returns The lower-case hex sha256 of {@link stableJson}.
 */
export function stableSha256(value: unknown): string {
  return createHash('sha256').update(stableJson(value), 'utf8').digest('hex')
}

/** Server-owned audit fields that never take part in a submission's identity. */
const SERVER_AUDIT_FIELDS = new Set(['createBy', 'createTime', 'updateBy', 'updateTime'])

/**
 * Copy a PUT payload while removing only server-owned audit metadata.
 * @param value - The payload about to be fingerprinted.
 * @returns A deep copy without the audit fields, so two equivalent submissions hash alike.
 */
export function submissionSemantics(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(item => submissionSemantics(item))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !SERVER_AUDIT_FIELDS.has(key))
      .map(([key, nested]) => [key, submissionSemantics(nested)]))
  }
  return value
}

/**
 * Normalize a prompt the way the provider's own comparisons do.
 * @param value - The raw prompt.
 * @returns The prompt with every whitespace run collapsed to one space and trimmed.
 * @throws {JubianError} `CONTRACT_CHANGED` when the value is not a string.
 */
export function normalizedPrompt(value: unknown): string {
  if (typeof value !== 'string') invalid()
  return value.replace(/\s+/g, ' ').trim()
}

/**
 * Read one record's stable task identity.
 * @param record - A raw task record.
 * @returns The task id as a string, or null when the record carries none.
 */
export function taskIdOf(record: Record<string, unknown>): string | null {
  for (const field of ['id', 'taskId', 'aigcVideoTaskId']) {
    const value = record[field]
    if (value === undefined || value === null || value === '') continue
    const identity = wireText(value)
    if (identity !== null) return identity
  }
  return null
}

/**
 * Read the storyboard id, prompt and ordered image URLs one task record states.
 * @param record - A raw task record, either a parent task or a child result.
 * @returns The semantic fields a candidate must agree on, with `null` where the record is silent.
 */
export function taskSemanticFields(record: Record<string, unknown>):
{ storyboardId: unknown; prompt: string | null; imageUrls: string[] | null } {
  const subTasks = Array.isArray(record.subTaskList) ? record.subTaskList : []
  const first = subTasks.length && subTasks[0] && typeof subTasks[0] === 'object'
    ? subTasks[0] as Record<string, unknown> : {}
  const storyboardId = record.storyboardId ?? first.storyboardId ?? null
  let prompt: unknown = record.prompt ?? first.prompt ?? null
  if (prompt === null) prompt = parseConfig(record.modelConfig)?.prompt ?? null
  let imageUrls: unknown = record.imageUrls ?? first.imageUrls ?? null
  if (imageUrls === null) {
    const materials = storyboardObject(record.storyboardMaterialList)
    if (Array.isArray(materials)) {
      imageUrls = materials.map(item => (item && typeof item === 'object'
        ? materialUrlOf(item as Record<string, unknown>) : null)).filter((url): url is string => url !== null)
    }
  }
  const urls = Array.isArray(imageUrls)
    ? imageUrls.map(item => wireText(item)).filter((url): url is string => url !== null)
    : null
  return { storyboardId, prompt: typeof prompt === 'string' ? normalizedPrompt(prompt) : null,
    imageUrls: urls }
}

/** Read the image URL one material-shaped record carries, in the provider's own field order. */
function materialUrlOf(material: Record<string, unknown>): string | null {
  for (const field of ['materialUrl', 'assetUrl', 'imageUrl', 'tosVideoUrl', 'url', 'Location']) {
    const value = material[field]
    if (typeof value === 'string' && value) return value
  }
  return null
}

/**
 * Parse a `modelConfig` field the provider sometimes serializes, tolerantly.
 * @param value - A raw `modelConfig`, inline object or JSON text.
 * @returns The config object, or null when it is absent, unparseable or not an object.
 */
function parseConfig(value: unknown): Record<string, unknown> | null {
  let parsed: unknown = value
  if (typeof value === 'string') {
    try { parsed = JSON.parse(value) as unknown } catch { return null }
  }
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as Record<string, unknown> : null
}

/**
 * Decide whether one remote task could belong to this storyboard at all.
 * @param record - A raw task record.
 * @param scriptId - The live storyboard's project id.
 * @param storyboardId - The live storyboard id.
 * @returns True only when every field the record does state agrees.
 */
export function isRelatedTaskCandidate(record: Record<string, unknown>, scriptId: number, storyboardId: number): boolean {
  const taskType = wireText(record.taskType)
  if (taskType !== null && taskType !== '1') return false
  const remoteScriptId = wireText(record.scriptId)
  if (remoteScriptId !== null && remoteScriptId !== String(scriptId)) return false
  const semantic = taskSemanticFields(record)
  const remoteStoryboardId = wireText(semantic.storyboardId)
  if (remoteStoryboardId !== null && remoteStoryboardId !== String(storyboardId)) return false
  return true
}

/**
 * Read the ordered trusted subject identity out of a child result.
 *
 * A child that states an asset id without a name or a URL has lost the identity
 * the storyboard PUT was supposed to translate, which is a terminal condition
 * rather than a partial match.
 * @param materials - The child's `imageMaterials` or `storyboardMaterialList`.
 * @returns One identity item per ordered material.
 * @throws {JubianError} `CONTRACT_CHANGED` when any item is missing a field or the list is empty.
 */
export function subjectIdentitySignature(materials: unknown): SubjectIdentityItem[] {
  const list = storyboardObject(materials)
  if (!Array.isArray(list) || list.length === 0) invalid()
  return list.map((entry) => {
    const material = object(entry)
    const assetId = wireText(material.assetId)
    const name = wireText(material.materialName ?? material.fileName ?? material.assetName)
    const imageUrl = httpUrl(material.imageUrl ?? material.materialUrl)
    if (assetId === null || !assetId.trim()) invalid()
    if (name === null || !name.trim()) invalid()
    if (imageUrl === null) invalid()
    return { assetId, materialName: name, imageUrl }
  })
}

/**
 * Read the model evidence a child result carries.
 * @param configValue - A child's `modelConfig`, either inline or JSON-serialized.
 * @returns One `[field, value]` pair per required model field, in a fixed order.
 * @throws {JubianError} `CONTRACT_CHANGED` when any required field is absent.
 */
export function nativeModelSignature(configValue: unknown): [string, string][] {
  const config = parseConfig(configValue) ?? invalid()
  return NATIVE_MODEL_FIELDS.map((field) => {
    let candidate = config[field]
    if (field === 'videoStandardId' && (candidate === undefined || candidate === null || candidate === '')) {
      candidate = config.modelVideoStandardId
    }
    const value = candidate === undefined || candidate === null || candidate === '' ? null : wireText(candidate)
    if (value === null) invalid()
    return [field, value]
  })
}

/**
 * Read the prompt a child result carries, in its normalized comparable form.
 * @param configValue - A child's `modelConfig`, either inline or JSON-serialized.
 * @returns The fully normalized prompt.
 * @throws {JubianError} `CONTRACT_CHANGED` when no prompt is present.
 */
export function nativeObservablePrompt(configValue: unknown): string {
  const config = parseConfig(configValue) ?? invalid()
  let prompt = config.prompt
  if (prompt === undefined || prompt === null || prompt === '') {
    const nested = config.modelConfig
    if (nested !== undefined && nested !== null && (typeof nested === 'object' || typeof nested === 'string')) {
      prompt = parseConfig(nested)?.prompt
    }
  }
  if (typeof prompt !== 'string' || !prompt) invalid()
  const normalized = normalizedPrompt(prompt)
  if (!normalized) invalid()
  return normalized
}

/**
 * Collect every finished-video URL a task or child record exposes.
 * @param value - A raw task, child result or list of either.
 * @returns The distinct HTTPS URLs, in provider order.
 */
export function nativeResultUrls(value: unknown): string[] {
  const urls: string[] = []
  const visit = (current: unknown): void => {
    if (Array.isArray(current)) { current.forEach(visit); return }
    if (!current || typeof current !== 'object') return
    const record = current as Record<string, unknown>
    for (const field of ['tosVideoUrl', 'resultVideoUrl', 'originalVideoUrl', 'resultUrl']) {
      const raw = record[field]
      for (const item of Array.isArray(raw) ? raw : [raw]) {
        for (const part of (wireText(item) ?? '').split(',')) {
          const url = httpUrl(part.trim())
          if (url !== null && !urls.includes(url)) urls.push(url)
        }
      }
    }
    for (const field of ['data', 'rows', 'list', 'resultList', 'subTaskList']) {
      const nested = record[field]
      if (nested && typeof nested === 'object') visit(nested)
    }
  }
  visit(value)
  return urls
}

/**
 * Read the task status one task/child pair states.
 * @param records - The parent task and its claimed child, either may be silent.
 * @returns The lower-cased status, or an empty string when neither states one.
 */
export function taskStatusOf(...records: Record<string, unknown>[]): string {
  for (const record of records) {
    const status = record.taskStatus ?? record.status
    if (typeof status === 'string' && status.trim()) return status.trim().toLowerCase()
  }
  return ''
}

/**
 * Resolve exact live intent without substituting a model, platform or specification.
 * Stale selector ids are ignored; ratio and resolution match case-insensitively.
 * Matching child rows that name a model must name the same model as their parent.
 * @param catalogue - Envelope `data` from `/model/charge/getSelectList?taskType=1`.
 * @param intent - Live modelConfig with modelId, ratio, resolution, genType, duration and genNum;
 * platformId may be omitted only when the catalogue match is unambiguous.
 * @returns Fresh catalogue selectors with the requested duration and one generation.
 * @throws {JubianError} `CONTRACT_CHANGED` for unsupported, ambiguous or malformed settings.
 */
export function resolveVideoModel(catalogue: unknown, intent: unknown): SeedanceVideoModel {
  const config = object(intent)
  const modelId = text(config.modelId)
  const platformId = config.platformId === undefined ? undefined : text(config.platformId)
  const ratio = text(config.ratio).toLowerCase()
  const resolution = text(config.resolution).toLowerCase()
  const genType = integer(config.genType)
  if (integer(config.genNum) !== 1) invalid()
  const duration = validateVideoDuration(modelId, config.duration)
  const rows = Array.isArray(catalogue) ? catalogue.map(object) : invalid()
  const matches: SeedanceVideoModel[] = []
  for (const selected of rows) {
    if (selected.modelId !== modelId || (platformId !== undefined && selected.platformId !== platformId)) continue
    const genTypes = Array.isArray(selected.genTypes) ? selected.genTypes.map(object) : invalid()
    const standards = Array.isArray(selected.videoStandards) ? selected.videoStandards.map(object) : invalid()
    for (const generation of genTypes.filter(item => integer(item.type) === genType)) {
      for (const standard of standards.filter(item => text(item.ratio).toLowerCase() === ratio
        && text(item.resolution).toLowerCase() === resolution
        && integer(item.genNum ?? selected.genNum ?? 1) === 1)) {
        if ((generation.modelId !== undefined && generation.modelId !== modelId)
          || (standard.modelId !== undefined && standard.modelId !== modelId)) invalid()
        matches.push({ platformId: text(selected.platformId), modelId,
          standardId: integer(selected.id ?? selected.standardId), genType,
          modelGenerationTypeId: integer(generation.id), videoStandardId: integer(standard.id),
          duration, ratio: text(standard.ratio), resolution: text(standard.resolution), genNum: 1 })
      }
    }
  }
  if (matches.length === 0) throw new JubianError('CONTRACT_CHANGED', 'No catalogue row matches video settings')
  if (matches.length !== 1) {
    throw new JubianError('CONTRACT_CHANGED', 'Video settings match multiple catalogue selectors; specify one platform and specification')
  }
  return matches[0] ?? invalid()
}

/**
 * Read the ordered storyboard materials, whatever form the provider used.
 * @param storyboard - A raw storyboard snapshot.
 * @returns The material list and whether the provider had serialized it as JSON.
 * @throws {JubianError} `CONTRACT_CHANGED` when the field is not a list of objects.
 */
export function storyboardMaterials(storyboard: Record<string, unknown>):
{ materials: Record<string, unknown>[]; serialized: boolean } {
  const parsed = storyboardObject(storyboard.storyboardMaterialList)
  if (!Array.isArray(parsed)) invalid()
  return { materials: parsed.map(object), serialized: typeof storyboard.storyboardMaterialList === 'string' }
}

/**
 * Read and check the ordered materials one live storyboard already carries.
 *
 * This is the read-only half of preparation: every material must already name a
 * trusted identity, an ordered parent and an official URL, because the submit
 * that follows re-reads exactly these fields and a missing one would be
 * discovered only after the paid PUT.
 * @param storyboard - The live storyboard snapshot.
 * @param assets - The parent assets in storyboard material order, one per material.
 * @returns The enriched ordered materials, the normalized prompt and the model config.
 * @throws {JubianError} `CONTRACT_CHANGED` when any identity, order or prompt reference disagrees.
 */
export function validatedVideoMaterials(storyboard: Record<string, unknown>, assets: Record<string, unknown>[]):
{ materials: Record<string, unknown>[]; prompt: string; config: Record<string, unknown> } {
  const { materials } = storyboardMaterials(storyboard)
  const config = parseConfig(storyboard.modelConfig) ?? invalid()
  if (typeof config.prompt !== 'string') invalid()
  const prompt = normalizedPrompt(config.prompt)
  const scriptId = integer(storyboard.scriptId)
  if (assets.length !== materials.length) invalid()

  const keys: string[] = []
  const enriched = materials.map((material, index) => {
    if (index >= assets.length) invalid()
    const asset = assets[index] ?? invalid()
    const assetId = asset.id ?? asset.assetId
    const parentId = material.materialAssetId ?? material.assetId
    if (integer(asset.scriptId) !== scriptId) invalid()
    const hsStatus = wireText(asset.hsAssetStatus)
    if (hsStatus !== null && !['active', ...SUCCESS_STATUSES].includes(hsStatus.trim().toLowerCase())) invalid()
    for (const field of ['deleted', 'delFlag']) {
      const flag = asset[field]
      if (flag !== undefined && flag !== null && Number(flag) === 1) invalid()
    }
    for (const field of ['resultStatus', 'taskStatus', 'assetStatus']) {
      const status = wireText(asset[field])
      if (status === null || !status) continue
      const normalized = status.trim().toLowerCase()
      if ([...FAILED_STATUSES, '-1', '0', 'deleted', 'disabled', 'inactive', 'rejected', 'unverified']
        .includes(normalized)) invalid()
    }
    if (asset.official === false) invalid()
    if (asset.isUsed !== undefined && asset.isUsed !== null && Number(asset.isUsed) !== 1) invalid()
    const officialUrl = httpUrl(asset.assetUrl ?? asset.url)
    if (officialUrl === null) invalid()
    if (assetId === undefined || assetId === null || wireText(parentId) !== wireText(assetId)) invalid()
    if (material.materialUrl !== officialUrl) invalid()
    const materialType = wireText(material.materialType)
    if (materialType === null || materialType.trim().toLowerCase() !== 'image') invalid()
    const materialKey = material.materialKey
    if (typeof materialKey !== 'string' || !materialKey) invalid()
    keys.push(materialKey)
    const verified: Record<string, unknown> = {}
    for (const field of ['assetId', 'materialAssetId', 'assetName', 'fileName', 'materialKey',
      'materialType', 'materialUrl', 'sortOrder']) {
      if (field in material) verified[field] = material[field]
    }
    verified.materialUrl = officialUrl
    verified.official = true
    verified.asset_status = 'confirmed'
    const trusted = wireText(asset.hsAssetId)
    if (trusted !== null && trusted.trim() !== '') verified.assetId = trusted
    else if (Number(asset.isLocal) === 1) invalid()
    return verified
  })

  if (new Set(keys).size !== keys.length) invalid()
  if (promptKeys(prompt).join('\u0000') !== keys.join('\u0000')) invalid()
  return { materials: enriched, prompt, config }
}

/** Read the prompt's ordered `@[name](key)` placeholder keys. */
function promptKeys(prompt: string): string[] {
  return [...prompt.matchAll(/@\[([^\]]+)\]\(([^()\s]+)\)/g)].map(match => match[2] ?? '')
}

/** Everything one preview is built from. */
export interface NativePreviewInput {
  /** The live storyboard snapshot the PUT will echo. */
  storyboard: Record<string, unknown>
  /** The parent assets in storyboard material order. */
  assets: Record<string, unknown>[]
  /** The live `taskType=1` catalogue. */
  models: unknown
  /** Creation timestamp recorded in the preview. */
  createdAt: string
}

/**
 * Build the exact, deterministic storyboard PUT preview without any I/O.
 * @param input - Live storyboard, ordered parent assets, live catalogue and a timestamp.
 * @returns The preview, including the one-PUT payload and its semantic fingerprint.
 * @throws {JubianError} `CONTRACT_CHANGED` when any identity, setting or model rule fails.
 */
export function buildNativeVideoPreview(input: NativePreviewInput): NativeVideoPreview {
  for (const asset of input.assets) {
    if (asset.official !== true) invalid()
    if (asset.asset_status !== 'confirmed') invalid()
    if (Number(asset.isUsed) !== 1) invalid()
  }
  const { materials, prompt, config } = validatedVideoMaterials(input.storyboard, input.assets)
  const model = resolveVideoModel(input.models, config)
  const payload: Record<string, unknown> = { ...input.storyboard }
  payload.storyboardMaterialList = materials.map(material => ({ ...material }))
  payload.isGenerate = 1
  const modelConfig: Record<string, unknown> = { ...config }
  for (const field of ['platformId', 'modelId', 'standardId', 'genType', 'modelGenerationTypeId',
    'videoStandardId', 'duration', 'ratio', 'resolution', 'genNum'] as const) {
    modelConfig[field] = model[field]
  }
  modelConfig.prompt = prompt
  modelConfig.materialList = materials.map(material => ({ ...material }))
  payload.modelConfig = JSON.stringify(modelConfig)

  const storyboardId = integer(payload.id ?? payload.storyboardId)
  const orderedAssets: NativeOrderedAsset[] = materials.map((material) => {
    const assetId = wireText(material.assetId)
    const materialAssetId = material.materialAssetId
    const materialName = wireText(material.fileName ?? material.assetName)
    const imageUrl = httpUrl(material.materialUrl)
    if (assetId === null || !assetId.trim()) invalid()
    if (materialAssetId === undefined || materialAssetId === null || materialAssetId === '') invalid()
    if (materialName === null || !materialName.trim()) invalid()
    if (imageUrl === null) invalid()
    if (typeof material.materialKey !== 'string' || !material.materialKey) invalid()
    return { assetId, materialAssetId: integer(materialAssetId),
      materialKey: material.materialKey, materialName, imageUrl }
  })
  return {
    version: 1,
    operation: 'prepare_storyboard_native_video',
    status: 'prepared',
    createdAt: input.createdAt,
    scriptId: integer(input.storyboard.scriptId),
    storyboardId,
    idempotencyKey: stableSha256(submissionSemantics(payload)),
    estimatedSubmissions: 1,
    assetSummary: { count: orderedAssets.length, orderedAssets },
    payload,
    nextAction: '核对 preview 的项目、主体、配置、预计费用与已有任务；在用户已授权范围内调用 submit_video，超出范围先取得授权。prepare 本身不 PUT、不创建任务、不收费。',
  }
}

/**
 * Validate whole-second duration against an exact model's recorded capability.
 * The catalogue does not expose duration bounds. Seedance 2.0 retains its 2–15-second
 * limit; the user-confirmed 2.5 capability permits 2–30 seconds for this exact id.
 * Unknown model revisions fail closed rather than inheriting another model's limit.
 * @param modelId - Exact catalogue model id.
 * @param duration - Requested numeric duration in seconds.
 * @returns The validated integer duration.
 * @throws {JubianError} `CONTRACT_CHANGED` for absent evidence or out-of-range duration.
 */
export function validateVideoDuration(modelId: string, duration: unknown): number {
  const maximum = modelId === 'doubao-seedance-2-0-260128' ? 15
    : modelId === 'doubao-seedance-2-5-260628' ? 30 : null
  if (maximum === null) throw new JubianError('CONTRACT_CHANGED', 'No verified duration capability for the exact model id')
  if (typeof duration !== 'number' || !Number.isSafeInteger(duration) || duration < 2 || duration > maximum) {
    throw new JubianError('CONTRACT_CHANGED', `Duration must be an integer from 2 to ${maximum} seconds`)
  }
  return duration
}

/**
 * Re-validate a preview file before it is allowed to cause a paid PUT.
 *
 * A preview is the only artifact that authorizes spending, so it is checked in
 * full — operation, project binding, fingerprint, absence of any secret field,
 * and the ordered identity it claims — rather than trusted because it parsed.
 * @param value - The parsed preview file.
 * @returns The preview, once every invariant holds.
 * @throws {JubianError} `CONTRACT_CHANGED` when the artifact is not exactly this plugin's own preview.
 */
export function validateNativeVideoPreview(value: unknown): NativeVideoPreview {
  const preview = object(value)
  if (preview.operation !== 'prepare_storyboard_native_video') invalid()
  if (preview.status !== 'prepared') invalid()
  const payload = object(preview.payload)
  if (Number(payload.isGenerate) !== 1) invalid()
  const config = parseConfig(payload.modelConfig) ?? invalid()
  validateVideoDuration(text(config.modelId), config.duration)
  if (integer(config.genNum) !== 1) invalid()
  for (const field of ['standardId', 'genType', 'modelGenerationTypeId', 'videoStandardId']) integer(config[field])
  for (const field of ['platformId', 'ratio', 'resolution']) text(config[field])
  const storyboardId = integer(preview.storyboardId)
  if (integer(payload.id) !== storyboardId) invalid()
  const scriptId = integer(preview.scriptId)
  if (integer(payload.scriptId) !== scriptId) invalid()
  const key = preview.idempotencyKey
  if (typeof key !== 'string' || !/^[0-9a-f]{64}$/.test(key)) invalid()
  if (key !== stableSha256(submissionSemantics(payload))) invalid()
  if (hasSecretField(preview)) invalid()
  const summary = object(preview.assetSummary)
  const ordered = Array.isArray(summary.orderedAssets) ? summary.orderedAssets.map(object) : invalid()
  const expected = subjectIdentitySignature(ordered)
  if (Number(summary.count) !== expected.length) invalid()
  const { materials } = storyboardMaterials(payload)
  const actual = subjectIdentitySignature(materials)
  if (stableJson(actual) !== stableJson(expected)) invalid()
  return preview as unknown as NativeVideoPreview
}

/** Whether any key at any depth looks like a credential field a preview must never carry. */
function hasSecretField(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(item => hasSecretField(item))
  if (!value || typeof value !== 'object') return false
  return Object.entries(value as Record<string, unknown>).some(([key, nested]) => {
    const normalized = key.toLowerCase().replace(/[^a-z]/g, '')
    return ['secret', 'token', 'password', 'authorization'].some(word => normalized.includes(word))
      || ['apikey', 'accesskey', 'privatekey'].includes(normalized)
      || hasSecretField(nested)
  })
}

/** What one claim attempt is checked against. */
export interface NativeClaimExpectation {
  scriptId: number
  storyboardId: number
  episodeId: number
  /** Ordered trusted identity the submission claimed. */
  expectedIdentity: SubjectIdentityItem[]
  /** Model evidence the child must repeat. */
  expectedModel: [string, string][]
  /** Prompt the child must repeat, already normalized. */
  expectedPrompt: string
  /** Task ids that already existed before the PUT. */
  beforeTaskIds: string[]
}

function childIdentity(child: Record<string, unknown>): SubjectIdentityItem[] | null {
  const materials = child.imageMaterials ?? child.storyboardMaterialList
  try { return subjectIdentitySignature(materials) } catch { return null }
}

function childModel(child: Record<string, unknown>): [string, string][] | null {
  try { return nativeModelSignature(child.modelConfig) } catch { return null }
}

function childPrompt(child: Record<string, unknown>): string | null {
  try { return nativeObservablePrompt(child.modelConfig) } catch { return null }
}

/** Whether one hydrated candidate names this storyboard, using the detail's own fields first. */
function candidateBelongsTo(candidate: HydratedTask, expectation: NativeClaimExpectation): boolean {
  if (!isRelatedTaskCandidate(candidate.task, expectation.scriptId, expectation.storyboardId)) return false
  const remoteEpisode = wireText(candidate.task.episodeId ?? candidate.task.episode_id)
  if (remoteEpisode !== null && remoteEpisode !== String(expectation.episodeId)) return false
  const semantic = taskSemanticFields(candidate.task)
  const remoteStoryboard = wireText(semantic.storyboardId ?? candidate.task.storyboardId)
  if (remoteStoryboard === null) return true
  return remoteStoryboard === String(expectation.storyboardId)
}

/**
 * Claim one new task created by the single PUT, using only complete evidence.
 *
 * The before/after task-id set is the reconciliation boundary. A task that lost
 * its child identity is `subject_identity_lost` — terminal, because the provider
 * cannot be asked to re-translate it and a second PUT is not allowed. Anything
 * that cannot be decided from complete evidence is a conflict.
 * @param candidates - Every task that appeared after the PUT, already hydrated with its children.
 * @param expectation - The submission's ordered identity, model, prompt and before-set.
 * @returns The claim verdict, with the matched task and child when it is `matched`.
 */
export function classifyNewNativeCandidates(candidates: HydratedTask[],
  expectation: NativeClaimExpectation): NativeClaim {
  const exact: HydratedTask[] = []
  const identityLost: HydratedTask[] = []
  const mismatched: HydratedTask[] = []
  const terminalMismatched: HydratedTask[] = []
  const pending: HydratedTask[] = []
  const seen = new Set<string>()
  for (const candidate of candidates) {
    if (expectation.beforeTaskIds.includes(candidate.taskId) || seen.has(candidate.taskId)) continue
    seen.add(candidate.taskId)
    if (!candidateBelongsTo(candidate, expectation)) continue
    if (candidate.children.length === 0) { pending.push(candidate); continue }
    if (candidate.children.length !== 1) { mismatched.push(candidate); continue }
    const child = candidate.children[0] ?? invalid()
    const identity = childIdentity(child)
    if (identity === null) { identityLost.push(candidate); continue }
    if (stableJson(identity) !== stableJson(expectation.expectedIdentity)) {
      // A settled task that carries a different identity is as much a conflict as
      // an unsettled one; only the unresolved case may still converge by itself.
      const status = taskStatusOf(candidate.task, child)
      if (terminalOutcome(status) === 'pending') mismatched.push(candidate)
      else terminalMismatched.push(candidate)
      continue
    }
    const model = childModel(child)
    const prompt = childPrompt(child)
    if (model === null || prompt === null) { mismatched.push(candidate); continue }
    if (stableJson(model) === stableJson(expectation.expectedModel) && prompt === expectation.expectedPrompt) {
      exact.push({ ...candidate, children: [child] })
    } else {
      mismatched.push(candidate)
    }
  }
  if (exact.length > 1 || (exact.length > 0 && mismatched.length > 0)) return { status: 'reconcile_conflict' }
  if (exact.length > 0 && pending.length > 0) return { status: 'none' }
  if (exact.length === 1) {
    const matched = exact[0] ?? invalid()
    return { status: 'matched', taskId: matched.taskId, task: matched.task,
      child: matched.children[0] ?? invalid() }
  }
  if (pending.length > 0) return { status: 'none' }
  if (identityLost.length > 0) {
    if (identityLost.length === 1 && mismatched.length === 0) {
      const lost = identityLost[0] ?? invalid()
      return { status: 'subject_identity_lost', taskId: lost.taskId, task: lost.task,
        child: lost.children[0] ?? null }
    }
    return { status: 'reconcile_conflict' }
  }
  if (mismatched.length > 0 || terminalMismatched.length > 0) return { status: 'reconcile_conflict' }
  return { status: 'none' }
}

/**
 * Find an already-existing exact submission for this preview, if there is one.
 *
 * This answers the only safe question after an ambiguous PUT response: did this
 * exact submission already reach the provider? Unreadable evidence is a conflict
 * rather than a miss, so an unresolvable state can never be read as "nothing was
 * submitted" and become a second charge.
 * @param candidates - Every related task, already hydrated with its children.
 * @param expectation - The submission's ordered identity, model and prompt.
 * @returns The claim verdict, restricted to `matched`, `none` and `reconcile_conflict`.
 */
export function classifyExistingNativeMatches(candidates: HydratedTask[],
  expectation: NativeClaimExpectation): NativeClaim {
  const matches: HydratedTask[] = []
  let unsafe = false
  for (const candidate of candidates) {
    if (!candidateBelongsTo(candidate, expectation)) continue
    if (candidate.children.length !== 1) { unsafe = true; continue }
    const child = candidate.children[0] ?? invalid()
    const identity = childIdentity(child)
    if (identity === null) { unsafe = true; continue }
    if (stableJson(identity) !== stableJson(expectation.expectedIdentity)) continue
    const model = childModel(child)
    const prompt = childPrompt(child)
    if (model === null || prompt === null) { unsafe = true; continue }
    if (stableJson(model) !== stableJson(expectation.expectedModel) || prompt !== expectation.expectedPrompt) continue
    matches.push({ ...candidate, children: [child] })
  }
  if (matches.length > 1 || unsafe) return { status: 'reconcile_conflict' }
  if (matches.length === 1) {
    const matched = matches[0] ?? invalid()
    return { status: 'matched', taskId: matched.taskId, task: matched.task,
      child: matched.children[0] ?? invalid() }
  }
  return { status: 'none' }
}

/**
 * Read whether one claimed child still carries the whole ordered identity.
 * @param child - The child result read back after submission.
 * @param expected - The ordered identity the preview claimed.
 * @returns `ok` when every field is present and ordered identically, otherwise the first failure.
 */
export function readBackIdentity(child: Record<string, unknown>, expected: SubjectIdentityItem[]):
{ status: 'ok' } | { status: 'subject_identity_lost'; reason: string } {
  const identity = childIdentity(child)
  if (identity === null) {
    return { status: 'subject_identity_lost', reason: '子项缺少 assetId/materialName/imageUrl 中的至少一项' }
  }
  if (stableJson(identity) !== stableJson(expected)) {
    return { status: 'subject_identity_lost', reason: '子项身份与提交顺序或取值不一致' }
  }
  return { status: 'ok' }
}

/**
 * Read the ordered child results of one task that belong to this storyboard.
 * @param children - Every child row of the task.
 * @param storyboardId - The storyboard the child must name.
 * @returns The children whose `storyboardId` matches, in provider order.
 */
export function childrenOf(children: Record<string, unknown>[], storyboardId: number): Record<string, unknown>[] {
  return children.filter(child => wireText(child.storyboardId) === String(storyboardId))
}

/**
 * Read one response's records, accepting the list and envelope shapes this provider uses.
 * @param value - Envelope `data` from a task, subtask or material endpoint.
 * @returns The records the body carries, in provider order.
 */
export function responseRecords(value: unknown): Record<string, unknown>[] {
  return records(value)
}

/**
 * Read whether a task has reached a terminal state.
 * @param status - A status read from {@link taskStatusOf}.
 * @returns `succeeded`, `failed` or `pending`, so a caller never invents a fourth state.
 */
export function terminalOutcome(status: string): 'succeeded' | 'failed' | 'pending' {
  if ((SUCCESS_STATUSES as readonly string[]).includes(status)) return 'succeeded'
  if ((FAILED_STATUSES as readonly string[]).includes(status)) return 'failed'
  return 'pending'
}
