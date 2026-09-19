/**
 * The `select_assets` contract: reproduce "选择已有资产" without browser clicks.
 *
 * The workbench saves a subject selection and starts generation with the same
 * `PUT /aigc/storyboard`, distinguished only by `isGenerate`. Selection is
 * therefore always forced to `isGenerate=0`, and the caller's ordered pairs must
 * match the prompt's own `@[name](key)` order — the provider reads the prompt to
 * decide which reference is which, so an order mismatch is a silent identity
 * swap rather than a cosmetic error.
 *
 * Every field this module sends is either the provider's own value or a value
 * re-read from the subject-setting picker in the same call: the picker row's
 * numeric `assetId` is the parent to re-fetch, its `hsAssetId` is the trusted
 * identity a video child must carry, and its `assetUrl`/`assetName` are the
 * official URL and name. Those fields are not interchangeable.
 */
import { JubianError } from '@deepseek-ai/dsh-jubian'
import { normalizedPrompt, stableJson, stableSha256, wireText } from './native.ts'

function invalid(): never { throw new JubianError('CONTRACT_CHANGED') }

/** One ordered selection: the prompt's material key and the numeric parent asset it names. */
export interface SubjectSelectionRequest {
  /** The prompt placeholder key, e.g. `lead` for `@[陆沉舟](lead)`. */
  material_key: string
  /** The numeric parent asset id of one active subject-setting row. */
  asset_id: number
}

/** The comparable selection state of one storyboard: order, identity and prompt hash. */
export interface SelectionState {
  orderedMaterials: { assetId: unknown; materialKey: unknown; assetName: unknown; sortOrder: unknown }[]
  orderedMaterialsSha256: string
  promptSha256: string
}

/** One planned selection, as `select_assets` reports it before and after its single PUT. */
export interface SubjectSelectionPlan {
  operation: 'select_storyboard_assets'
  status: 'ready' | 'already_applied'
  scriptId: number
  storyboardId: number
  before: SelectionState
  after: SelectionState
  /** The exact PUT body, with `isGenerate=0` and the ordered materials. */
  payload: Record<string, unknown>
  nextAction: string | null
  paidRequests: 0
}

/** Server-managed fields that never take part in the selection's own identity. */
const SERVER_MANAGED_FIELDS = ['id', 'storyboardId', 'createBy', 'createTime', 'updateBy', 'updateTime',
  'remark', 'userId', 'companyId', 'mainDeptId', 'secondDeptId', 'assetIdList']

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid()
  return value as Record<string, unknown>
}

function integer(value: unknown): number {
  const candidate = typeof value === 'string' && /^[0-9]+$/.test(value.trim()) ? Number(value.trim()) : value
  if (typeof candidate !== 'number' || !Number.isSafeInteger(candidate) || candidate < 1) invalid()
  return candidate
}

function parseField(value: unknown): { value: unknown; serialized: boolean } {
  if (typeof value !== 'string') return { value, serialized: false }
  try {
    return { value: JSON.parse(value) as unknown, serialized: true }
  } catch { return invalid() }
}

/** Read the one official HTTPS URL a picker row or parent asset states. */
function httpUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.hostname && !url.username && !url.password && !value.includes('\\')
      ? value : null
  } catch { return null }
}

/** Whether a picker row states the one confirmed-use value the wire uses. */
function strictlyUsed(value: unknown): boolean {
  return (typeof value === 'number' && Number.isInteger(value) && value === 1)
    || (typeof value === 'string' && value.trim() === '1')
}

/**
 * Canonicalize a trusted subject identity for duplicate detection.
 * @param value - A picker row's `hsAssetId`, as a string or a number.
 * @returns A key that treats `12` and `"12"` as the same subject and `"asset-1"` as a different one.
 */
export function trustedSubjectKey(value: string | number): string {
  if (typeof value === 'number') return `number:${value}`
  return /^[0-9]+$/.test(value) && Number(value) > 0 ? `number:${Number(value)}` : `string:${value}`
}

/**
 * Read a trusted subject identity without coercing booleans or floats.
 * @param value - A picker row's `hsAssetId`.
 * @returns The identity as the provider typed it, or null when it is absent.
 */
export function trustedSubjectId(value: unknown): string | number | null {
  if (typeof value === 'string') return value.trim() ? value.trim() : null
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value
  return null
}

/**
 * Reduce one ordered material list to the state that must survive the PUT.
 * @param materials - The storyboard's ordered materials.
 * @param prompt - The already normalized prompt.
 * @returns The ordered identity, a hash of the server-independent material content, and the prompt hash.
 */
export function selectionState(materials: Record<string, unknown>[], prompt: string): SelectionState {
  const canonical = materials.map(material => Object.fromEntries(
    Object.entries(material).filter(([field]) => !SERVER_MANAGED_FIELDS.includes(field))))
  return {
    orderedMaterials: materials.map(material => ({ assetId: material.assetId, materialKey: material.materialKey,
      assetName: material.assetName ?? material.fileName ?? null, sortOrder: material.sortOrder ?? null })),
    orderedMaterialsSha256: stableSha256(canonical),
    promptSha256: stableSha256(prompt),
  }
}

/** Everything one selection plan is built from. */
export interface SubjectSelectionInput {
  /** The live storyboard snapshot read immediately before planning. */
  storyboard: Record<string, unknown>
  /** The caller's ordered `material_key`/parent `asset_id` pairs. */
  selections: SubjectSelectionRequest[]
  /** Every active subject-setting row for the project, from `/aigc/material/list?isUsed=1`. */
  subjectRows: Record<string, unknown>[]
  /** The parent assets fetched for the requested ids, one per id, in first-seen order. */
  parentAssets: Record<string, unknown>[]
}

/**
 * Plan one ordered selection, or report that the storyboard already holds it.
 *
 * The prompt's own key order is the contract: a selection whose order disagrees
 * with the prompt is refused before anything is sent, because the provider would
 * otherwise bind the wrong reference to a named subject and still report success.
 * @param input - Live storyboard, ordered selections, active subject rows and their parent assets.
 * @returns The before/after state and the exact `isGenerate=0` PUT body.
 * @throws {JubianError} `CONTRACT_CHANGED` when any identity, order or status rule fails.
 */
export function buildSubjectSelection(input: SubjectSelectionInput): SubjectSelectionPlan {
  const storyboard = input.storyboard
  const scriptId = integer(storyboard.scriptId)
  const storyboardId = integer(storyboard.id)
  const ordered = input.selections
  if (ordered.length === 0) invalid()
  const keys = ordered.map(item => item.material_key.trim())
  const parentIds = ordered.map(item => String(item.asset_id).trim())
  if (keys.some(key => !key) || parentIds.some(id => !id || !/^[0-9]+$/.test(id))) invalid()
  if (new Set(keys).size !== keys.length || new Set(parentIds).size !== parentIds.length) invalid()

  const materialsField = parseField(storyboard.storyboardMaterialList)
  const configField = parseField(storyboard.modelConfig)
  if (!Array.isArray(materialsField.value)) invalid()
  const materials = materialsField.value.map(object)
  const config = object(configField.value)
  if (typeof config.prompt !== 'string') invalid()
  const prompt = normalizedPrompt(config.prompt)
  const promptKeys = [...prompt.matchAll(/@\[([^\]]+)\]\(([^()\s]+)\)/g)].map(match => match[2] ?? '')
  if (promptKeys.join('\u0000') !== keys.join('\u0000')) invalid()

  const rowsByParent = new Map<string, Record<string, unknown>[]>()
  for (const row of input.subjectRows) {
    const parent = wireText(row.assetId)
    if (parent === null || parent === '') continue
    rowsByParent.set(parent, [...(rowsByParent.get(parent) ?? []), row])
  }
  const assetsById = new Map<string, Record<string, unknown>[]>()
  for (const asset of input.parentAssets) {
    const id = wireText(asset.id)
    if (id === null || id === '') continue
    assetsById.set(id, [...(assetsById.get(id) ?? []), asset])
  }
  const existingByKey = new Map<string, Record<string, unknown>[]>()
  for (const material of materials) {
    const key = wireText(material.materialKey)
    if (key === null || key === '') continue
    existingByKey.set(key, [...(existingByKey.get(key) ?? []), material])
  }

  const selected: Record<string, unknown>[] = []
  const parentByTrusted = new Map<string, string>()
  ordered.forEach((selection, index) => {
    const key = selection.material_key.trim()
    const parentKey = String(selection.asset_id)
    const rows = rowsByParent.get(parentKey) ?? []
    const assets = assetsById.get(parentKey) ?? []
    if (rows.length !== 1 || assets.length !== 1) invalid()
    const row = rows[0] ?? invalid()
    const asset = assets[0] ?? invalid()
    if (integer(row.scriptId) !== scriptId || integer(asset.scriptId) !== scriptId) invalid()
    if (!strictlyUsed(row.isUsed)) invalid()
    if ((wireText(row.hsAssetStatus) ?? '').trim().toLowerCase() !== 'active') invalid()
    const trusted = trustedSubjectId(row.hsAssetId)
    if (trusted === null) invalid()
    const trustedKey = trustedSubjectKey(trusted)
    const existingParent = parentByTrusted.get(trustedKey)
    if (existingParent !== undefined && existingParent !== parentKey) invalid()
    parentByTrusted.set(trustedKey, parentKey)
    const officialUrl = httpUrl(row.assetUrl)
    if (officialUrl === null) invalid()
    if (httpUrl(asset.url ?? asset.assetUrl) !== officialUrl) invalid()
    if (wireText(asset.delFlag) === '1') invalid()
    const existing = existingByKey.get(key) ?? []
    if (existing.length > 1) invalid()
    // The provider's own material fields are preserved: this PUT saves one
    // selection, and dropping a field the provider owns would be a silent edit
    // of everything else the storyboard already carried.
    const material: Record<string, unknown> = { ...(existing[0] ?? {}) }
    material.assetId = trusted
    material.materialAssetId = row.assetId
    material.fileName = row.assetName
    material.materialKey = key
    material.materialType = 'image'
    material.materialUrl = officialUrl
    material.sortOrder = index + 1
    selected.push(material)
  })

  const before = selectionState(materials, prompt)
  const after = selectionState(selected, prompt)
  const payload: Record<string, unknown> = { ...storyboard }
  payload.isGenerate = 0
  payload.storyboardMaterialList = materialsField.serialized
    ? JSON.stringify(selected) : selected.map(material => ({ ...material }))
  // `is_generate` is not part of this test: the provider stores 1 on every storyboard, so requiring 0
  // would make `already_applied` unreachable and turn every call into a PUT.
  const alreadyApplied = stableJson(before) === stableJson(after)
  return {
    operation: 'select_storyboard_assets',
    status: alreadyApplied ? 'already_applied' : 'ready',
    scriptId,
    storyboardId,
    before,
    after,
    payload,
    nextAction: alreadyApplied ? null : '本方法会在 --apply 等价的调用中执行一次 PUT；它固定 isGenerate=0，不创建任务、不收费。',
    paidRequests: 0,
  }
}

/**
 * Re-read one saved storyboard and compare it with the planned state.
 * @param storyboard - The storyboard read back after the PUT.
 * @param expected - The planned `after` state.
 * @returns The read-back state and whether it equals the plan.
 * @throws {JubianError} `CONTRACT_CHANGED` when the snapshot cannot be read at all.
 */
export function verifySubjectSelection(storyboard: Record<string, unknown>, expected: SelectionState):
{ state: SelectionState; matches: boolean; is_generate: number } {
  const materials = parseField(storyboard.storyboardMaterialList).value
  if (!Array.isArray(materials)) invalid()
  const config = object(parseField(storyboard.modelConfig).value)
  if (typeof config.prompt !== 'string') invalid()
  const state = selectionState(materials.map(object), normalizedPrompt(config.prompt))
  return { state, matches: stableJson(state) === stableJson(expected), is_generate: Number(storyboard.isGenerate) }
}
