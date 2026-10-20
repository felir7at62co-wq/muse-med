/**
 * The storyboard-native video flow: selection, free preparation and the one paid PUT.
 *
 * `jubian-api` decides *what* is allowed — the preview's shape, the fingerprint,
 * the claim rules. This module supplies the I/O around those decisions and keeps
 * three of them non-negotiable:
 *
 * - **Preparation never writes remotely.** It reads the live storyboard, the
 *   subject picker and the model catalogue, then writes one preview file into
 *   `<project>/video_tasks/`. No PUT, no task creation, no charge.
 * - **Submission is one PUT at most, ever.** The key is the preview's own
 *   fingerprint, so a preview can only ever cause one request, and a failed or
 *   ambiguous response is reconciled rather than retried.
 * - **Selection is free by construction.** Its body is always `isGenerate=0`,
 *   and the flow re-reads both the task list and the storyboard afterwards to
 *   prove that no task was created and that the saved order is the planned one.
 *
 * The task list is read as a complete, paged snapshot with drift and duplicate
 * detection: a partial list would make "no task appeared" an unsafe conclusion,
 * and that conclusion is what authorizes a paid PUT.
 */
import { readFile, readdir } from 'node:fs/promises'
import { promptRiskReview } from './prompt-risk.ts'
import type { PromptRiskReviewOptions } from './prompt-risk.ts'
import { join, resolve, sep } from 'node:path'
import type { JubianClient, JubianLedger, JubianResponse } from '@deepseek-ai/dsh-jubian'
import { centsOf, checkBudget, JubianError } from '@deepseek-ai/dsh-jubian'
import {
  buildNativeVideoPreview, buildSubjectSelection, childrenOf, classifyExistingNativeMatches,
  classifyNewNativeCandidates, isRelatedTaskCandidate, matchesNativeEpisode, nativeEpisodeScope, nativeResultUrls,
  responseRecords, stableJson, stableSha256, submissionSemantics, storyboardMaterials, taskIdOf, taskSemanticFields, taskStatusOf,
  validateNativeVideoPreview, verifySubjectSelection, wireText,
  referenceAudioUrls,
} from '@deepseek-ai/dsh-jubian-api'
import type { HydratedTask, NativeClaim, NativeClaimExpectation, NativeEpisodeScope, NativeVideoPreview,
  SubjectIdentityItem, SubjectSelectionRequest } from '@deepseek-ai/dsh-jubian-api'
import { acceptedWriteResponse, bodyHash, need, requireKey, writeUnderLedger } from './write.ts'
import { atomicWriteJson } from './json-file.ts'
import { assertSelectionReady, clearReselection } from './reselection.ts'
export { atomicWriteJson } from './json-file.ts'

/** The provider's page cap for task and material listings. */
const MAX_PAGES = 20
/** Rows requested per task-list page. */
const TASK_PAGE_SIZE = 100
/** Rows requested per subject-material page. */
const SUBJECT_PAGE_SIZE = 100
/** Cap on related tasks hydrated from one snapshot, so reconciliation stays bounded. */
const MAX_HYDRATED_TASKS = 100

/** The project binding every prepared preview must satisfy. */
interface ProjectBinding { project_root: string; script_id: number }

/** Refuse one call whose input or provider state does not match the contract. */
function fail(): never { throw new JubianError('CONTRACT_CHANGED') }

/** Keep only SDK-redacted submission failures in the model-visible result. */
function submissionFailure(error: unknown): { code: string; message: string } {
  return error instanceof JubianError ? { code: error.code, message: error.message }
    : { code: 'UNEXPECTED_ERROR', message: 'Video submission failed' }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new JubianError('CONTRACT_CHANGED')
  return value as Record<string, unknown>
}

/**
 * Parse a positive safe integer from a number or a trimmed decimal digit string.
 * @param value - Untrusted input or provider field.
 * @returns The parsed positive integer.
 * @throws JubianError with CONTRACT_CHANGED when the value is not a positive safe integer.
 */
export function positiveInteger(value: unknown): number {
  const candidate = typeof value === 'string' && /^[0-9]+$/.test(value.trim()) ? Number(value.trim()) : value
  if (typeof candidate !== 'number' || !Number.isSafeInteger(candidate) || candidate < 1) {
    throw new JubianError('CONTRACT_CHANGED')
  }
  return candidate
}

/**
 * Route the compatibility generate entry without creating another paid operation.
 * @param ledger - Durable operations whose original methods take precedence over new arguments.
 * @param args - Optional original key and native prepared-preview path.
 * @returns Historical read-only replay, native preparation, or native submission.
 * @throws JubianError when an explicit argument is invalid or its key belongs to another operation.
 */
export async function resolveGenerateMethod(ledger: JubianLedger, args: {
  idempotency_key?: unknown
  preview_path?: unknown
}): Promise<'legacy_replay' | 'prepare_video' | 'submit_video'> {
  if (args.idempotency_key !== undefined) {
    if (typeof args.idempotency_key !== 'string') throw new JubianError('INVALID_ARGUMENT', 'idempotency_key')
    const record = await ledger.find(requireKey(args.idempotency_key))
    if (record?.method === 'storyboard_generate') return 'legacy_replay'
    if (record && record.method !== 'storyboard_native_submit') throw new JubianError('CONTRACT_CHANGED')
    if (args.preview_path !== undefined && (typeof args.preview_path !== 'string' || !args.preview_path.trim())) {
      throw new JubianError('INVALID_ARGUMENT', 'preview_path')
    }
    if (record) return 'submit_video'
  }
  if (args.preview_path === undefined) return 'prepare_video'
  if (typeof args.preview_path !== 'string' || !args.preview_path.trim()) {
    throw new JubianError('INVALID_ARGUMENT', 'preview_path')
  }
  return 'submit_video'
}

/** Read one paged envelope, refusing a page whose rows cannot be listed. */
function pageOf(value: unknown): { rows: Record<string, unknown>[]; total: number | null } {
  if (Array.isArray(value)) return { rows: value.map(object), total: null }
  const record = object(value)
  const total = typeof record.total === 'number' && Number.isSafeInteger(record.total) ? record.total : null
  const rows = record.rows ?? record.list
  if (!Array.isArray(rows)) throw new JubianError('CONTRACT_CHANGED')
  return { rows: rows.map(object), total }
}

/**
 * Read every video task of one project as one complete snapshot.
 *
 * Page totals are cross-checked and duplicate stable ids are refused, because
 * the before/after id sets are the only boundary that can claim a task: an
 * incomplete list would turn "this task is new" into a guess.
 * @param client - Jubian transport.
 * @param scriptId - Project id.
 * @returns Every task record the provider lists, in provider order.
 */
async function listAllVideoTasks(client: JubianClient, scriptId: number): Promise<Record<string, unknown>[]> {
  const collected: Record<string, unknown>[] = []
  const stable = new Set<string>()
  let knownTotal: number | null = null
  for (let pageNum = 1; pageNum <= MAX_PAGES; pageNum += 1) {
    const response = await client.request({ method: 'GET',
      path: `/admin/aigc/video/task/list?scriptId=${scriptId}&pageNum=${pageNum}&pageSize=${TASK_PAGE_SIZE}`
        + '&orderByColumn=createTime&orderBy=desc' })
    const page = pageOf(response.data)
    if (page.total !== null) {
      if (page.total < 0 || (knownTotal !== null && page.total !== knownTotal)) throw new JubianError('CONTRACT_CHANGED')
      knownTotal = page.total
    }
    for (const record of page.rows) {
      const taskId = taskIdOf(record)
      if (taskId === null) throw new JubianError('CONTRACT_CHANGED', 'Video task list contains a row without a stable ID')
      if (stable.has(taskId)) throw new JubianError('CONTRACT_CHANGED')
      stable.add(taskId)
      collected.push(record)
    }
    if (knownTotal !== null) {
      if (collected.length > knownTotal) throw new JubianError('CONTRACT_CHANGED')
      if (collected.length === knownTotal) return collected
      if (page.rows.length < TASK_PAGE_SIZE) throw new JubianError('CONTRACT_CHANGED')
    } else if (page.rows.length < TASK_PAGE_SIZE) {
      return collected
    }
  }
  throw new JubianError('CONTRACT_CHANGED')
}

/** Read every child result of one task, in provider order. */
async function listSubtasks(client: JubianClient, taskId: string): Promise<Record<string, unknown>[]> {
  const response = await client.request({ method: 'POST',
    path: '/admin/aigc/video/task/sub/list?pageNum=1&pageSize=100&orderByColumn=createTime&orderBy=desc',
    body: { aigcVideoTaskId: taskId } })
  return responseRecords(response.data)
}

/** Read every active subject-setting row of one project as one complete snapshot. */
async function listAllSubjectMaterials(client: JubianClient, scriptId: number): Promise<Record<string, unknown>[]> {
  const collected: Record<string, unknown>[] = []
  let knownTotal: number | null = null
  for (let pageNumber = 1; pageNumber <= MAX_PAGES; pageNumber += 1) {
    const response = await client.request({ method: 'GET',
      path: `/aigc/material/list?scriptId=${scriptId}&isUsed=1&pageNum=${pageNumber}`
        + `&pageNumber=${pageNumber}&pageSize=${SUBJECT_PAGE_SIZE}` })
    const page = pageOf(response.data)
    if (page.total !== null) {
      if (page.total < 0 || (knownTotal !== null && page.total !== knownTotal)) throw new JubianError('CONTRACT_CHANGED')
      knownTotal = page.total
    }
    collected.push(...page.rows)
    if (knownTotal !== null) {
      if (collected.length > knownTotal) throw new JubianError('CONTRACT_CHANGED')
      if (collected.length === knownTotal) return collected
      if (page.rows.length === 0) throw new JubianError('CONTRACT_CHANGED')
    } else if (page.rows.length < SUBJECT_PAGE_SIZE) {
      return collected
    }
  }
  throw new JubianError('CONTRACT_CHANGED')
}

/** Read one task's detail, refusing an unreadable body. */
async function taskDetail(client: JubianClient, taskId: string): Promise<Record<string, unknown>> {
  const response = await client.request({ method: 'GET', path: `/admin/aigc/video/task/${taskId}` })
  return object(response.data)
}

/** Read one parent asset, refusing a body that does not state the requested id. */
async function parentAsset(client: JubianClient, requested: string): Promise<Record<string, unknown>> {
  const response = await client.request({ method: 'GET', path: `/aigc/asset/${requested}` })
  const asset = object(response.data)
  if (wireText(asset.id) !== requested) throw new JubianError('CONTRACT_CHANGED')
  return asset
}

/** Keep the failed read and its numeric remote code without exposing provider text. */
async function preflightRead<T>(stage: string, read: () => Promise<T>): Promise<T> {
  try { return await read() }
  catch (error) {
    if (!(error instanceof JubianError)) throw error
    const applicationCode = /unmapped envelope code ([0-9]+)/u.exec(error.detail ?? '')?.[1]
    const httpStatus = /^HTTP ([0-9]+)$/u.exec(error.detail ?? '')?.[1]
    throw new JubianError(error.code, `prepare_video stage=${stage}`
      + (applicationCode === undefined ? '' : `; remote_code=${applicationCode}`)
      + (httpStatus === undefined ? '' : `; http_status=${httpStatus}`)
      + '; paid_request_sent=false; inspect the live storyboard and official assets')
  }
}

/** Resolve only a positive numeric parent identity; local subject IDs are never asset paths. */
function numericParentId(value: unknown): string | null {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^[0-9]+$/u.test(value.trim()))) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? String(parsed) : null
}

/** Read the live storyboard snapshot, refusing a body that is not the requested storyboard. */
async function storyboardSnapshot(client: JubianClient, storyboardId: number): Promise<Record<string, unknown>> {
  const storyboard = object((await client.request({ method: 'GET', path: `/aigc/storyboard/${storyboardId}` })).data)
  if (positiveInteger(storyboard.id) !== storyboardId) throw new JubianError('CONTRACT_CHANGED')
  return storyboard
}

/**
 * Load the trusted inputs a native preview is built from.
 *
 * Every image is resolved to exactly one active subject-setting row
 * and one parent asset in the same project, and the asset's official URL must
 * equal the row's: these are the identities the paid PUT will translate, so a
 * field that disagrees is refused while the call is still free. Uploaded audio
 * remains a file reference and has no character-image parent to resolve.
 * @param client - Jubian transport.
 * @param storyboardId - The storyboard to prepare.
 * @returns The live storyboard and its uniquely keyed, enriched parent assets.
 */
async function loadLiveInputs(client: JubianClient, storyboardId: number):
Promise<{ storyboard: Record<string, unknown>; assets: Record<string, unknown>[] }> {
  const storyboard = await preflightRead('storyboard_read', () => storyboardSnapshot(client, storyboardId))
  const scriptId = positiveInteger(storyboard.scriptId)
  const { materials } = storyboardMaterials(storyboard)
  let rows: Record<string, unknown>[] | undefined
  let resolved = false
  const orderedMaterials = materials.map(material => ({ ...material }))
  for (const [index, material] of orderedMaterials.entries()) {
    if (material.materialType === 'audio' || numericParentId(material.materialAssetId) !== null) continue
    rows ??= await preflightRead('subject_list_read', () => listAllSubjectMaterials(client, scriptId))
    const localId = wireText(material.assetId)
    const matches = rows.filter(row => localId !== null && localId.trim() !== ''
      && wireText(row.hsAssetId) === localId && row.assetUrl === material.materialUrl
      && numericParentId(row.assetId) !== null && numericParentId(row.scriptId) === String(scriptId)
      && ((typeof row.isUsed === 'number' && row.isUsed === 1)
        || (typeof row.isUsed === 'string' && row.isUsed.trim() === '1'))
      && (wireText(row.hsAssetStatus) ?? '').trim().toLowerCase() === 'active')
    const [match] = matches
    if (matches.length !== 1 || match === undefined) throw new JubianError('CONTRACT_CHANGED',
      `prepare_video stage=subject_identity; image_index=${index + 1}; materialAssetId has no unique active official mapping; `
      + 'inspect the saved subject selection manually; paid_request_sent=false')
    material.materialAssetId = Number(match.assetId)
    resolved = true
  }
  const byId = new Map<string, Record<string, unknown>>()
  for (const material of orderedMaterials) {
    if (material.materialType === 'audio') continue
    // The resolution pass accepts only positive numeric parents or replaces them from an official row.
    const key = String(Number(material.materialAssetId))
    let asset = byId.get(key)
    if (asset === undefined) {
      asset = await preflightRead('parent_asset_read', () => parentAsset(client, key))
      if (positiveInteger(asset.scriptId) !== scriptId) throw new JubianError('CONTRACT_CHANGED')
      byId.set(key, asset)
    }
  }
  rows ??= await preflightRead('subject_list_read', () => listAllSubjectMaterials(client, scriptId))
  const rowsByParent = new Map<string, Record<string, unknown>[]>()
  for (const row of rows) {
    const parent = wireText(row.assetId)
    if (parent === null || parent === '') continue
    if (!byId.has(parent)) continue
    rowsByParent.set(parent, [...(rowsByParent.get(parent) ?? []), row])
  }
  const trustedParents = new Map<string, string>()
  for (const [parentId, asset] of byId) {
    const matches = rowsByParent.get(parentId) ?? []
    if (matches.length !== 1) fail()
    const row = matches[0] as Record<string, unknown>
    if (positiveInteger(row.scriptId) !== scriptId) throw new JubianError('CONTRACT_CHANGED')
    const isUsed = row.isUsed
    const strictlyUsed = (typeof isUsed === 'number' && isUsed === 1) || (typeof isUsed === 'string' && isUsed.trim() === '1')
    if (!strictlyUsed || (wireText(row.hsAssetStatus) ?? '').trim().toLowerCase() !== 'active') {
      throw new JubianError('CONTRACT_CHANGED')
    }
    const trusted = typeof row.hsAssetId === 'string' ? row.hsAssetId.trim()
      : typeof row.hsAssetId === 'number' && row.hsAssetId > 0 ? row.hsAssetId : null
    const rowUrl = typeof row.assetUrl === 'string' ? row.assetUrl : null
    const parentUrl = typeof asset.url === 'string' ? asset.url
      : typeof asset.assetUrl === 'string' ? asset.assetUrl : null
    if (trusted === null || trusted === '' || rowUrl === null || rowUrl !== parentUrl) {
      throw new JubianError('CONTRACT_CHANGED')
    }
    const trustedKey = `t:${String(trusted)}`
    const existing = trustedParents.get(trustedKey)
    if (existing !== undefined && existing !== parentId) throw new JubianError('CONTRACT_CHANGED')
    trustedParents.set(trustedKey, parentId)
    asset.official = true
    asset.asset_status = 'confirmed'
    asset.asset_confirmation = 'verified'
    asset.hsAssetId = trusted
    asset.hsAssetStatus = row.hsAssetStatus
    asset.isUsed = row.isUsed
    asset.assetUrl = rowUrl
  }
  return { storyboard: resolved ? { ...storyboard, storyboardMaterialList: orderedMaterials } : storyboard,
    assets: [...byId.values()] }
}

/** The live catalogue of video-generation models. */
async function videoCatalogue(client: JubianClient): Promise<unknown> {
  return (await client.request({ method: 'GET', path: '/model/charge/getSelectList?taskType=1' })).data
}

/** Build the exact preview from live provider state, without writing anything. */
async function livePreview(client: JubianClient, storyboardId: number, createdAt: string):
Promise<NativeVideoPreview> {
  let inputs: Awaited<ReturnType<typeof loadLiveInputs>>
  try { inputs = await loadLiveInputs(client, storyboardId) }
  catch (error) {
    if (!(error instanceof JubianError) || error.detail?.includes('stage=')) throw error
    throw new JubianError(error.code, 'prepare_video stage=subject_validation; paid_request_sent=false; '
      + 'check subject identity, project, active status and official image URL')
  }
  const { storyboard, assets } = inputs
  const models = await preflightRead('model_catalogue_read', () => videoCatalogue(client))
  try { return buildNativeVideoPreview({ storyboard, assets, models, createdAt }) }
  catch (error) {
    if (!(error instanceof JubianError) || error.code === 'INVALID_ARGUMENT') throw error
    throw new JubianError(error.code, 'prepare_video stage=preview_validation; paid_request_sent=false; '
      + 'check official materials and the saved ratio, model and duration')
  }
}

/** Whether one task record names this storyboard in its own `storyboardId` field. */
function statesStoryboard(record: Record<string, unknown>, storyboardId: number): boolean {
  return wireText(taskSemanticFields(record).storyboardId) === String(storyboardId)
}

/**
 * Hydrate every task of one snapshot that is provably this storyboard's.
 *
 * A project holds the tasks of every storyboard it ever submitted, and most task rows
 * state no `storyboardId`. Such a row is this storyboard's only when its detail or one
 * child result names this storyboard; a row that proves neither belongs to another
 * storyboard, and its empty child list says nothing about this submission.
 * @param client - Jubian transport.
 * @param records - A complete task snapshot.
 * @param scriptId - Project id.
 * @param storyboardId - Storyboard id.
 * @param episode - Frozen episode ID and number; only explicit differences exclude tasks before the cap.
 * @returns One hydrated entry per provably related task, each with its storyboard-matching children.
 */
async function hydrateRelated(client: JubianClient, records: Record<string, unknown>[],
  scriptId: number, storyboardId: number, episode: NativeEpisodeScope): Promise<HydratedTask[]> {
  const related = records.filter((record) => {
    if (!isRelatedTaskCandidate(record, scriptId, storyboardId)) return false
    return matchesNativeEpisode(record, episode)
  })
  if (related.length > MAX_HYDRATED_TASKS) throw new JubianError('VIDEO_TASK_EVIDENCE_INVALID',
    `VIDEO_TASK_SCAN_LIMIT: storyboard ${storyboardId} has ${related.length} candidate tasks after episode filtering (limit ${MAX_HYDRATED_TASKS}; episodeId=${episode.episodeId}, episodeCount=${episode.episodeCount ?? null}). Reconcile task ownership or repair missing episode fields before submitting. This check is read-only; keep the original preview and key.`)
  const hydrated: HydratedTask[] = []
  for (const record of related) {
    const taskId = taskIdOf(record) as string
    const task = await taskDetail(client, taskId)
    const children = childrenOf(await listSubtasks(client, taskId), storyboardId)
    if (children.length === 0 && !statesStoryboard(record, storyboardId)
      && !statesStoryboard(task, storyboardId)) continue
    hydrated.push({ taskId, task, children })
  }
  return hydrated
}

/** Read the ordered trusted identity a preview claims. */
function expectedIdentity(preview: NativeVideoPreview): SubjectIdentityItem[] {
  return preview.assetSummary.orderedAssets.map(asset => ({ assetId: asset.assetId,
    materialName: asset.materialName, imageUrl: asset.imageUrl }))
}

/** Read the validated preview's serialized model selectors and required prompt. */
function expectationOf(preview: NativeVideoPreview, beforeTaskIds: string[]): NativeClaimExpectation {
  const modelConfig = preview.payload.modelConfig
  if (typeof modelConfig !== 'string') throw new JubianError('CONTRACT_CHANGED')
  const config = JSON.parse(modelConfig) as Record<string, unknown>
  const fields = ['platformId', 'modelId', 'standardId', 'genType', 'modelGenerationTypeId', 'videoStandardId',
    'duration', 'ratio', 'resolution', 'genNum'] as const
  const expectedModel = fields.map((field): [string, string] => [field, String(config[field])])
  const prompt = config.prompt
  if (typeof prompt !== 'string' || !prompt) throw new JubianError('CONTRACT_CHANGED')
  return { scriptId: preview.scriptId, storyboardId: preview.storyboardId,
    ...nativeEpisodeScope(preview.payload),
    expectedIdentity: expectedIdentity(preview), expectedModel, expectedPrompt: prompt,
    expectedAudioUrls: referenceAudioUrls(storyboardMaterials(preview.payload).materials),
    beforeTaskIds }
}

/** Turn one claim into the model-facing status plus the reconciliation guidance it earns. */
function claimReport(claim: NativeClaim):
Record<string, unknown> {
  if (claim.status === 'matched') {
    const urls = nativeResultUrls([claim.task, claim.child])
    return { status: 'submitted', task_id: claim.taskId, task_status: taskStatusOf(claim.task, claim.child) || null,
      result_urls: urls,
      next: '任务已由这一次 storyboard PUT 创建，子项身份完整。生成是异步的，不要在这里等待——'
        + '稍后用 jubian_video subtasks 回读该任务（可带 delivery_resolution）。' }
  }
  if (claim.status === 'subject_identity_lost') {
    return { status: 'subject_identity_lost', task_id: claim.taskId,
      next: '子项缺少 assetId/materialName/imageUrl：终态，不要重放提交、不要改用 direct POST。人工核对。' }
  }
  if (claim.status === 'reconcile_conflict') {
    return { status: 'reconcile_conflict', task_id: null,
      next: '出现多个候选或证据不完整：只做对账。不要再次提交同一个 preview。' }
  }
  return { status: 'reconcile_required', task_id: null,
    next: '本次 PUT 之后还没有看到唯一的新任务。用同一个 preview 和同一个 idempotency_key 再调一次 submit_video'
      + '（只会重新对账，绝不会再发 PUT），或用 jubian_video tasks/subtasks 回读。' }
}

/**
 * Read `project_config.json` and bind it to the live project id.
 * @param projectDir - The project directory the preview will be written into.
 * @param scriptId - The live storyboard's project id.
 * @returns The resolved project root and the configured project id.
 * @throws {JubianError} `CONTRACT_CHANGED` when the file is missing, invalid or bound to another project.
 */
export async function validateProjectBinding(projectDir: string, scriptId: unknown): Promise<ProjectBinding> {
  const projectRoot = resolve(projectDir)
  let text: string
  try {
    text = await readFile(join(projectRoot, 'project_config.json'), 'utf8')
  } catch { throw new JubianError('CONTRACT_CHANGED') }
  let parsed: unknown
  try { parsed = JSON.parse(text.replace(/^\uFEFF/, '')) } catch { throw new JubianError('CONTRACT_CHANGED') }
  const configured = positiveInteger(object(parsed).jubian_script_id)
  if (configured !== positiveInteger(scriptId)) throw new JubianError('CONTRACT_CHANGED')
  return { project_root: projectRoot, script_id: configured }
}

/** Resolve the project root that owns one prepared preview. */
function projectRootOfPreview(previewPath: string): string {
  const segments = resolve(previewPath).split(sep)
  for (let index = segments.length - 2; index >= 0; index -= 1) {
    if (segments[index] === 'video_tasks') return segments.slice(0, index).join(sep)
  }
  throw new JubianError('CONTRACT_CHANGED')
}

/**
 * Prepare one storyboard-native video package without any remote write.
 * @param client - Jubian transport.
 * @param ledger - Account-local selection requirements from in-place edits.
 * @param args - `storyboard_id`, `project_dir` and an optional `content_duration_ms` cross-check.
 * @param review - Resolved optional literal-term review settings.
 * @returns The persisted preview, its path, advisory prompt findings and the next step.
 * @throws {JubianError} `CONTRACT_CHANGED` when any live identity or setting fails.
 */
export async function prepareVideoMethod(client: JubianClient, ledger: JubianLedger, args: {
  storyboard_id?: number | undefined
  project_dir?: string | undefined
  content_duration_ms?: number | undefined
}, review?: PromptRiskReviewOptions): Promise<Record<string, unknown>> {
  const storyboardId = positiveInteger(need(args.storyboard_id))
  const preview = await livePreview(client, storyboardId, new Date().toISOString())
  const binding = await validateProjectBinding(need(args.project_dir), preview.scriptId)
  const modelConfig = JSON.parse(String(preview.payload.modelConfig)) as Record<string, unknown>
  await assertSelectionReady(ledger, preview.scriptId, storyboardId, modelConfig.prompt)
  const duration = positiveInteger(modelConfig.duration)
  const contentDurationMs = (duration - 1) * 1000
  if (args.content_duration_ms !== undefined && args.content_duration_ms !== contentDurationMs) {
    throw new JubianError('CONTRACT_CHANGED')
  }
  const root = resolve(binding.project_root, 'video_tasks')
  const destination = resolve(root, `storyboard-${storyboardId}-${preview.idempotencyKey.slice(0, 12)}`
    + '.storyboard-native.prepared.json')
  await atomicWriteJson(destination, preview)
  const audio = storyboardMaterials(preview.payload).materials.filter(material => material.materialType === 'audio')
  return { ...preview, preview_path: destination, content_duration_ms: contentDurationMs,
    storyboard_duration_seconds: duration,
    ...promptRiskReview([{ storyboard_id: storyboardId,
      card_name: typeof preview.payload.storyboardName === 'string' ? preview.payload.storyboardName : null,
      prompt: String(modelConfig.prompt) }], review),
    audio_references: audio.map(material => ({ material_key: material.materialKey, material_url: material.materialUrl,
      duration_seconds: material.audioDuration ?? null,
      duration_basis: material.audioDuration === undefined || material.audioDuration === null
        ? 'unavailable' : 'saved_metadata', duration_verified: false })),
    next: '生成前请按系统提示词中的固定自检清单自主核对本次提交。'
      + 'prepare 只写 preview：不 PUT、不创建任务、不收费。自主检查后调用 submit_video 或 submit_video_batch，'
      + `并把它自己的 idempotency_key（${preview.idempotencyKey}）原样传入。` }
}

/**
 * Select the storyboard's subject assets and save them with generation disabled.
 * @param client - Jubian transport.
 * @param ledger - Write-path ledger.
 * @param args - `storyboard_id`, ordered `selections` and the caller's `idempotency_key`.
 * @returns The before/after state, the read-back verification and the task audit.
 * @throws {JubianError} `CONTRACT_CHANGED` when any identity, order or read-back rule fails.
 */
export async function selectAssetsMethod(client: JubianClient, ledger: JubianLedger, args: {
  storyboard_id?: number | undefined
  selections?: SubjectSelectionRequest[] | undefined
  idempotency_key?: string | undefined
}): Promise<Record<string, unknown>> {
  const key = requireKey(args.idempotency_key)
  const storyboardId = positiveInteger(need(args.storyboard_id))
  const storyboard = await storyboardSnapshot(client, storyboardId)
  const scriptId = positiveInteger(storyboard.scriptId)
  const selections = need(args.selections)
  if (!Array.isArray(selections)) throw new JubianError('CONTRACT_CHANGED')
  const subjectRows = await listAllSubjectMaterials(client, scriptId)
  const parents: Record<string, unknown>[] = []
  for (const assetId of [...new Set(selections.map(selection => String(selection.asset_id)))]) {
    parents.push(await parentAsset(client, assetId))
  }
  const plan = buildSubjectSelection({ storyboard, selections, subjectRows, parentAssets: parents })
  if (plan.status === 'already_applied') {
    await clearReselection(ledger, scriptId, storyboardId, (typeof storyboard.modelConfig === 'string'
      ? JSON.parse(storyboard.modelConfig) as Record<string, unknown> : object(storyboard.modelConfig)).prompt)
    return { operation: plan.operation, status: 'already_applied', applied: false,
      scriptId: plan.scriptId, storyboardId: plan.storyboardId, before: plan.before, after: plan.after,
      verified_readback: verifySubjectSelection(storyboard, plan.after).verified_readback,
      next: '分镜已经保存的就是这个选择：没有发送 PUT，也没有收费。' }
  }
  const beforeRecords = await listAllVideoTasks(client, scriptId)
  const beforeIds = new Set<string>()
  for (const record of beforeRecords) {
    if (!isRelatedTaskCandidate(record, scriptId, storyboardId)) continue
    const taskId = taskIdOf(record) as string
    beforeIds.add(taskId)
  }
  const result = await writeUnderLedger(ledger, key, 'storyboard_select_assets',
    () => plan.payload,
    payload => client.request({ method: 'PUT', path: '/aigc/storyboard', body: payload as Record<string, unknown> }))
  const afterRecords = await listAllVideoTasks(client, scriptId)
  const newRelated: string[] = []
  for (const record of afterRecords) {
    if (!isRelatedTaskCandidate(record, scriptId, storyboardId)) continue
    const taskId = taskIdOf(record) as string
    if (!beforeIds.has(taskId)) newRelated.push(taskId)
  }
  const verified = await storyboardSnapshot(client, storyboardId)
  // No `is_generate` check here: the provider stores 1 on every storyboard, so it proves nothing. The
  // billing-safe signal is `newRelated` above — a selection-only save must not create a task.
  const verification = verifySubjectSelection(verified, plan.after)
  if (!verification.matches) throw new JubianError('CONTRACT_CHANGED',
    `POST_PUT_VERIFY_MISMATCH: selection PUT accepted; expected=${JSON.stringify(plan.after.orderedMaterials)}, actual=${JSON.stringify(verification.verified_readback)}; materialHashChanged=${plan.after.orderedMaterialsSha256 !== verification.state.orderedMaterialsSha256}; promptChanged=${plan.after.promptSha256 !== verification.state.promptSha256}. Read the storyboard to reconcile; do not submit video or assume the write failed.`)
  if (newRelated.length === 0) await clearReselection(ledger, scriptId, storyboardId, (typeof verified.modelConfig === 'string'
    ? JSON.parse(verified.modelConfig) as Record<string, unknown> : object(verified.modelConfig)).prompt)
  return { ...result, operation: plan.operation, scriptId, storyboardId,
    before: plan.before, after: plan.after, verification, verified_readback: verification.verified_readback,
    status: newRelated.length > 0 ? 'billing_safety_violation' : 'applied',
    applied: true, paid_requests: 0,
    next: newRelated.length > 0
      ? `选择保存（isGenerate=0）不应创建任务，但出现了新任务 ${newRelated.join(', ')}：立即停机人工核对，`
        + '不要再调用 prepare_video/submit_video。'
      : '选择已保存并回读一致（isGenerate=0，未收费）。下一步是 prepare_video。' }
}

/** Resolve the preview file a submission must use, refusing ambiguity. */
async function resolvePreviewPath(args: {
  preview_path?: string | undefined
  project_dir?: string | undefined
  storyboard_id?: number | undefined
}): Promise<string> {
  if (args.preview_path !== undefined) return resolve(args.preview_path)
  const storyboardId = positiveInteger(need(args.storyboard_id))
  const root = resolve(need(args.project_dir), 'video_tasks')
  let names: string[]
  try {
    names = await readdir(root)
  } catch { return fail() }
  const matches = names.filter(name => name.startsWith(`storyboard-${storyboardId}-`)
    && name.endsWith('.storyboard-native.prepared.json'))
  if (matches.length !== 1) fail()
  return resolve(root, matches[0] as string)
}

/**
 * Submit one prepared, approved storyboard-native video package.
 *
 * The key must be the preview's own fingerprint, which makes one preview equal to
 * one PUT for all time. Before that PUT the flow takes a complete task snapshot
 * twice and refuses to continue if it drifted; after it, a second snapshot is the
 * only evidence that may claim a task. A PUT that fails for any reason — timeout,
 * 5xx, connection loss — is treated as ambiguous: the submission records
 * `unknown` and returns reconciliation guidance instead of resending.
 * @param client - Jubian transport.
 * @param ledger - Write-path ledger.
 * @param args - `preview_path` (or `project_dir` plus `storyboard_id`) and `idempotency_key`.
 * @returns The submission verdict, the claimed task when there is one, and the next step.
 * @throws {JubianError} `CONTRACT_CHANGED` when the preview is stale, mismatched or not this plugin's own.
 */
/**
 * What the classifier actually read for each candidate it could not decide.
 *
 * A bare `reconcile_conflict` is not actionable: one verdict covers an unreadable
 * storyboard id, a task whose child lost its identity, and a task that is simply
 * not this submission. This reports the fields `isRelatedTaskCandidate` and
 * `taskSemanticFields` read, so the next conflict names its own cause. Read-only:
 * it re-derives nothing the classifier did not already consult.
 * @param candidates - The hydrated tasks the conflict was decided over.
 * @param expectation - The submission identity the classifier compared against.
 * @returns One row per related candidate, with `storyboard_id_read` null when unreadable.
 */
function conflictEvidence(candidates: HydratedTask[], expectation: NativeClaimExpectation):
Record<string, unknown>[] {
  return candidates
    .filter(candidate => isRelatedTaskCandidate(candidate.task, expectation.scriptId, expectation.storyboardId))
    .map((candidate) => {
      const semantic = taskSemanticFields(candidate.task)
      return {
        task_id: candidate.taskId,
        task_name: candidate.task.taskName ?? candidate.task.task_name ?? null,
        // Read exactly the way the classifier reads it, so a null here is the same
        // "unreadable" that made this candidate related in the first place.
        storyboard_id_read: wireText(semantic.storyboardId),
        episode_id: nativeEpisodeScope(candidate.task).episodeId,
        children: candidate.children.length,
      }
    })
}

/** Agent-calculated reservation for one package, independent of the project spending limit. */
interface VideoEstimate {
  /** CNY amount calculated from current pricing and this package's content. */
  estimated_cost_cny?: string | undefined
  /** Rate, usage assumptions, or comparable completed task used for the estimate. */
  estimate_basis?: string | undefined
}

/** Validate an optional model-supplied estimate before reserving money. */
function estimatedVideoQuote(input: VideoEstimate): { amount: string; unit: string } | undefined {
  if (input.estimated_cost_cny === undefined && input.estimate_basis === undefined) return undefined
  const amount = centsOf(input.estimated_cost_cny)
  if (amount === null || amount <= 0 || !input.estimate_basis?.trim()) {
    throw new JubianError('INVALID_ARGUMENT', 'estimated_cost_cny requires a positive CNY amount and estimate_basis from current pricing or comparable actual cost')
  }
  return { amount: (amount / 100).toFixed(2), unit: 'CNY' }
}

/** A recorded images-then-audio serializer key prevents a normalized preview from charging again. */
async function recordedGroupedKey(ledger: JubianLedger, preview: NativeVideoPreview):
Promise<{ key: string; outcome: string } | null> {
  const { materials } = storyboardMaterials(preview.payload)
  const grouped = [...materials.filter(row => row.materialType === 'image'),
    ...materials.filter(row => row.materialType === 'audio')]
  if (stableJson(grouped) === stableJson(materials)) return null
  const config = object(JSON.parse(String(preview.payload.modelConfig)))
  const payload = { ...preview.payload, storyboardMaterialList: grouped,
    modelConfig: JSON.stringify({ ...config, materialList: grouped }) }
  const key = stableSha256(submissionSemantics(payload))
  const record = await ledger.find(key)
  if (record === undefined || record.method !== 'storyboard_native_submit' || record.script_id !== preview.scriptId) return null
  return { key, outcome: record.outcome ?? 'unknown' }
}

/**
 * Reconcile a frozen native-video preview and submit at most one charged storyboard PUT for its key.
 * @param client - Authenticated transport for live reads and the optional submission.
 * @param ledger - Write ledger used to reserve the charge and prevent a repeated PUT.
 * @param args - Preview locator, optional project/storyboard identity, and matching idempotency key.
 * @param assertModel - Optional synchronous conversation choice check before reserving a new paid request.
 * @returns Submission or reconciliation evidence, including unresolved outcomes without automatic resubmission.
 */
export async function submitVideoMethod(client: JubianClient, ledger: JubianLedger, args: VideoEstimate & {
  preview_path?: string | undefined
  project_dir?: string | undefined
  storyboard_id?: number | undefined
  idempotency_key?: string | undefined
}, assertModel?: (model: Record<string, unknown>) => void): Promise<Record<string, unknown>> {
  const key = need(args.idempotency_key)
  if (!key.trim()) throw new JubianError('CONTRACT_CHANGED')
  const previewPath = await resolvePreviewPath(args)
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(previewPath, 'utf8'))
  } catch { throw new JubianError('CONTRACT_CHANGED') }
  const preview = validateNativeVideoPreview(parsed)
  await validateProjectBinding(projectRootOfPreview(previewPath), preview.scriptId)
  if (key !== preview.idempotencyKey) throw new JubianError('CONTRACT_CHANGED')

  // The record is consulted before the live rebuild on purpose: a key that
  // already caused a PUT may only ever be reconciled, and reconciliation must
  // still work after the operator has moved the storyboard on.
  const recorded = await ledger.find(key)
  if (recorded !== undefined) {
    if (recorded.method !== 'storyboard_native_submit' || recorded.script_id !== preview.scriptId
      || recorded.request_sha256 !== bodyHash(preview.payload)) {
      throw new JubianError('CONTRACT_CHANGED', 'Recorded key belongs to a different video submission')
    }
    const records = await listAllVideoTasks(client, preview.scriptId)
    const hydrated = await hydrateRelated(client, records, preview.scriptId, preview.storyboardId, nativeEpisodeScope(preview.payload))
    const claim = classifyExistingNativeMatches(hydrated, expectationOf(preview, []))
    return { replayed: true, outcome: recorded.outcome ?? 'unknown', response_sha256: recorded.response_sha256,
      preview_path: previewPath, idempotency_key: key, ...claimReport(claim),
      next: `同一个 idempotency_key 已有一条记录（outcome=${recorded.outcome ?? 'unknown'}），`
        + '因此不会再发送任何 PUT。上面是对账结果：submitted 表示这次提交确实已经创建了任务；'
        + 'reconcile_required 表示暂时看不到新任务，继续用同一个 key 对账即可。' }
  }

  const live = await livePreview(client, preview.storyboardId, preview.createdAt)
  await assertSelectionReady(ledger, live.scriptId, live.storyboardId, object(JSON.parse(String(live.payload.modelConfig))).prompt)
  if (live.idempotencyKey !== preview.idempotencyKey) throw new JubianError('CONTRACT_CHANGED')

  const preflightRecords = await listAllVideoTasks(client, preview.scriptId)
  const preflight = await hydrateRelated(client, preflightRecords, preview.scriptId,
    preview.storyboardId, nativeEpisodeScope(preview.payload))
  const expectation = expectationOf(preview, [])
  const existing = classifyExistingNativeMatches(preflight, expectation)
  if (existing.status === 'reconcile_conflict') {
    return { replayed: false, outcome: 'unknown', status: 'reconcile_conflict', task_id: null,
      preview_path: previewPath,
      candidates: conflictEvidence(preflight, expectation),
      next: '提交前对账发现多个候选或证据不完整：没有发送 PUT。人工核对远端任务后再说。'
        + '上面的 candidates 是判定时实际读到的字段；storyboard_id_read 为 null 表示那条任务的归属读不出来，'
        + '它因此被当成可能属于本分镜。' }
  }
  if (existing.status === 'matched') {
    return { replayed: false, outcome: 'unknown', status: 'already_submitted', task_id: existing.taskId,
      preview_path: previewPath,
      next: '提交前对账发现这次提交在远端已经存在完全一致的任务：没有发送 PUT。'
        + '后续用 jubian_video subtasks 回读该任务即可。' }
  }

  const groupedRecord = await recordedGroupedKey(ledger, preview)
  if (groupedRecord !== null) {
    return { replayed: false, outcome: groupedRecord.outcome, status: 'reconcile_conflict', put_sent: false,
      task_id: null, preview_path: previewPath, idempotency_key: key, original_idempotency_key: groupedRecord.key,
      next: '相同提交的旧图片/音频分组 key 已有记录；本次未发送 PUT，也未新增预约。'
        + '保留原 preview，并用 original_idempotency_key 只读对账；旧文件缺失或远端任务暂未出现不允许换新 key 再付费。' }
  }

  const beforeRecords = await listAllVideoTasks(client, preview.scriptId)
  const firstIds = preflightRecords.map(taskIdOf).filter((value): value is string => value !== null).sort()
  const secondIds = beforeRecords.map(taskIdOf).filter((value): value is string => value !== null).sort()
  if (beforeRecords.length !== preflightRecords.length || stableJson(firstIds) !== stableJson(secondIds)) {
    return { replayed: false, outcome: 'unknown', status: 'reconcile_required', task_id: null,
      preview_path: previewPath,
      next: '两次全量任务快照不一致（列表在漂移）：没有发送 PUT。稍后重新 prepare 并在稳定时再提交。' }
  }
  const beforeTaskIds = beforeRecords.filter(record => isRelatedTaskCandidate(record, preview.scriptId,
    preview.storyboardId)).map(taskIdOf).filter((value): value is string => value !== null)
  // The two sets answer different questions and must not be swapped: claiming this
  // storyboard's task asks which tasks were already related to it, while naming what
  // appeared asks which tasks the project did not have before the PUT. Diffing the
  // after-list against the related set reported every unrelated task as new.
  const beforeAllTaskIds = new Set(secondIds)

  const state = { putFailed: false, putError: null as { code: string; message: string } | null,
    reconciliationFailed: false, sent: false, appearedIds: [] as string[],
    claim: { status: 'none' } as NativeClaim }
  const result = await writeUnderLedger(ledger, key, 'storyboard_native_submit', () => preview.payload,
    async (payload): Promise<JubianResponse> => {
      let response: JubianResponse
      state.sent = true
      try {
        response = await client.request({ method: 'PUT', path: '/aigc/storyboard',
          body: payload as Record<string, unknown> })
      } catch (error) {
      // Every failed PUT is ambiguous: the provider may have applied it, and a
      // second request is exactly what must never happen. The ledger settle
      // below records `unknown`, which is the honest verdict.
        state.putFailed = true
        state.putError = submissionFailure(error)
        return { transport: { http_status: null, application_code: null }, response_sha256: null,
          envelope_layout: 'unparsed', data: null }
      }
      try {
        const afterRecords = await listAllVideoTasks(client, preview.scriptId)
        // The tasks that appeared across the PUT, whether or not any of them could be
        // claimed. An accepted PUT that claims nothing still created a task and may
        // already have billed it, so these ids are the caller's only handle on it.
        // "Appeared while we were submitting" is not "created by this request": the
        // claim below is what decides attribution, and these ids only say where to look.
        state.appearedIds = afterRecords.map(taskIdOf)
          .filter((value): value is string => value !== null)
          .filter(id => !beforeAllTaskIds.has(id))
        const hydrated = await hydrateRelated(client, afterRecords, preview.scriptId,
          preview.storyboardId, nativeEpisodeScope(preview.payload))
        state.claim = classifyNewNativeCandidates(hydrated, expectationOf(preview, beforeTaskIds))
      } catch {
        state.reconciliationFailed = true
      }
      return response
    }, () => estimatedVideoQuote(args), { scriptId: preview.scriptId,
      ...(assertModel ? { beforeReserve: () => { assertModel(object(JSON.parse(String(preview.payload.modelConfig)))) } } : {}) })
  const putSent = state.sent || result.replayed
  const putOutcome = result.outcome
  // An accepted PUT whose task no candidate could claim is not "nothing happened": the
  // task exists and may already be billed. That case gets the verdict which states the PUT
  // happened, and keeps the ambiguous claim in its own field so the caller still knows not
  // to resubmit this preview.
  const acceptedUnclaimed = putOutcome === 'accepted' && state.claim.status === 'reconcile_conflict'
  const report = state.reconciliationFailed
    ? { status: 'reconcile_required', task_id: null, result_urls: [] as string[],
      next: 'PUT 已发出但第二次快照或认领失败：只做对账。用同一个 preview 和同一个 key 再调一次 submit_video。' }
    : claimReport(state.claim)
  return { ...result, preview_path: previewPath, idempotency_key: key,
    ...report,
    status: state.putFailed || acceptedUnclaimed ? 'reconcile_required' : report.status,
    put_sent: putSent,
    put_outcome: putOutcome,
    ...(acceptedUnclaimed ? { claim_status: 'reconcile_conflict' } : {}),
    ...(state.appearedIds.length > 0 ? { new_task_ids: state.appearedIds } : {}),
    put_ambiguous: state.putFailed, before_task_ids: beforeTaskIds,
    put_error: state.putError,
    next: state.putFailed
      ? 'PUT 已尝试提交，put_error 保留了提供方拒绝或连接失败的原因；任务及计费仍需对账。'
        + '这个 key 不会再次发送 PUT：submitted 表示已找到任务，否则只用同一个 key 对账并处理报告的错误。'
      : acceptedUnclaimed
        ? 'PUT 已被提供方受理（很可能已计费），但没有一条候选能被完整认领：不要重新提交这个 preview。'
          + '按 new_task_ids 回读那些新任务（jubian_video subtasks），或人工核对归属。'
        : report.next }
}

/** One independently keyed preview within an approved video batch. */
export interface VideoBatchItem extends VideoEstimate { preview_path: string; idempotency_key: string }

/** Deployment limits for one batch of storyboard-native submissions. */
export interface VideoBatchOptions { concurrency: number; maxItems: number }

/**
 * Resolve bounded video submission settings at plugin mount.
 * @param config - Deployment limits.
 * @returns Validated concurrency and item limit.
 */
export function resolveVideoBatchOptions(config: { videoBatchConcurrency?: number; videoBatchMaxItems?: number } = {}):
VideoBatchOptions {
  const concurrency = config.videoBatchConcurrency ?? 3
  const maxItems = config.videoBatchMaxItems ?? 100
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 8
    || !Number.isSafeInteger(maxItems) || maxItems < 1 || maxItems > 100) {
    throw new JubianError('INVALID_ARGUMENT', 'videoBatchConcurrency must be 1..8 and videoBatchMaxItems must be 1..100')
  }
  return { concurrency, maxItems }
}

interface FrozenBatchItem extends VideoBatchItem { preview: NativeVideoPreview; beforeTaskIds: string[] }

async function batchPreview(item: VideoBatchItem): Promise<FrozenBatchItem> {
  const key = requireKey(item.idempotency_key)
  const previewPath = resolve(item.preview_path)
  let parsed: unknown
  try { parsed = JSON.parse(await readFile(previewPath, 'utf8')) }
  catch (error) { throw new JubianError('CONTRACT_CHANGED', `Unreadable video preview: ${(error as Error).name}`) }
  const preview = validateNativeVideoPreview(parsed)
  await validateProjectBinding(projectRootOfPreview(previewPath), preview.scriptId)
  if (key !== preview.idempotencyKey) throw new JubianError('CONTRACT_CHANGED', 'Video preview key differs from its fingerprint')
  return { ...item, preview_path: previewPath, idempotency_key: key, preview, beforeTaskIds: [] }
}

async function batchReadback(client: JubianClient, item: FrozenBatchItem): Promise<NativeClaim | null> {
  try {
    const records = await listAllVideoTasks(client, item.preview.scriptId)
    const hydrated = await hydrateRelated(client, records, item.preview.scriptId,
      item.preview.storyboardId, nativeEpisodeScope(item.preview.payload))
    return classifyNewNativeCandidates(hydrated, expectationOf(item.preview, item.beforeTaskIds))
  } catch (error) {
    // An accepted write still needs reconciliation when a transient read fails.
    void error
    return null
  }
}

/** Keep provider reconciliation reads bounded without occupying the paid PUT worker slots. */
function readLimiter(concurrency: number): <T>(operation: () => Promise<T>) => Promise<T> {
  let active = 0
  const waiting: (() => void)[] = []
  return async <T>(operation: () => Promise<T>): Promise<T> => {
    if (active < concurrency) active += 1
    else await new Promise<void>((resolve) => { waiting.push(resolve) })
    try { return await operation() }
    finally {
      const next = waiting.shift()
      if (next === undefined) active -= 1
      else next()
    }
  }
}

async function submitReservedVideo(client: JubianClient, ledger: JubianLedger, item: FrozenBatchItem):
Promise<{ response_sha256: string | null
  outcome: 'accepted' | 'unknown'
  put_ambiguous: boolean
  put_error: { code: string; message: string } | null }> {
  let response: JubianResponse | undefined
  let errorDetail: { code: string; message: string } | null = null
  try { response = await client.request({ method: 'PUT', path: '/aigc/storyboard', body: item.preview.payload }) }
  catch (error) { errorDetail = submissionFailure(error) }
  const outcome = response !== undefined && acceptedWriteResponse(response.transport) ? 'accepted' : 'unknown'
  try {
    await ledger.settle(item.idempotency_key, { httpStatus: response?.transport.http_status ?? null,
      applicationCode: response?.transport.application_code ?? null,
      responseSha256: response?.response_sha256 ?? null, outcome })
  } catch (error) {
    // The persisted intent is enough to prohibit another send; report the failed settlement.
    void error
  }
  return { response_sha256: response?.response_sha256 ?? null, outcome,
    put_ambiguous: outcome === 'unknown', put_error: errorDetail }
}

/**
 * Preflight every approved preview and the aggregate project budget, then submit distinct storyboards concurrently.
 * Any failed preflight or budget check sends zero PUTs. Every accepted item keeps its own original key;
 * ambiguous writes require read-only reconciliation and never cause a batch resend.
 * @param client - Authenticated provider transport.
 * @param ledger - Persistent write and budget ledger.
 * @param args - Ordered preview/key pairs for one project.
 * @param options - Bounded deployment concurrency and batch size.
 * @param assertModel - Optional conversation choice check before reserving the complete batch.
 * @returns Ordered per-item claims and aggregate status.
 */
export async function submitVideoBatchMethod(client: JubianClient, ledger: JubianLedger,
  args: { items?: VideoBatchItem[] | undefined }, options = resolveVideoBatchOptions(),
  assertModel?: (model: Record<string, unknown>) => void):
Promise<{ total: number; submitted: number; reconcile_required: number; results: Record<string, unknown>[] }> {
  const raw = args.items
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > options.maxItems) {
    throw new JubianError('INVALID_ARGUMENT', 'video batch items must fit the configured item limit')
  }
  const items = await Promise.all(raw.map(batchPreview))
  const keys = items.map(item => item.idempotency_key)
  const boards = items.map(item => item.preview.storyboardId)
  const first = items[0] as FrozenBatchItem
  const root = projectRootOfPreview(first.preview_path)
  if (new Set(keys).size !== items.length || new Set(boards).size !== items.length
    || items.some(item => item.preview.scriptId !== first.preview.scriptId
      || projectRootOfPreview(item.preview_path) !== root)) {
    throw new JubianError('INVALID_ARGUMENT', 'video batch needs distinct keys and storyboards in one project')
  }
  const limitedRead = readLimiter(options.concurrency)
  const recorded = await Promise.all(keys.map(key => ledger.find(key)))
  recorded.forEach((entry, index) => {
    if (entry === undefined) return
    const item = items[index] as FrozenBatchItem
    if (entry.method !== 'storyboard_native_submit' || entry.script_id !== item.preview.scriptId
      || entry.request_sha256 !== bodyHash(item.preview.payload)) {
      throw new JubianError('CONTRACT_CHANGED', 'Recorded key belongs to a different video submission')
    }
  })
  if (recorded.some(entry => entry !== undefined)) {
    if (recorded.some(entry => entry === undefined)) {
      throw new JubianError('CONTRACT_CHANGED', 'A partially recorded batch needs read-only per-key reconciliation')
    }
    const results = await Promise.all(items.map(item => limitedRead(async () => {
      const result = await submitVideoMethod(client, ledger, item)
      return result.status === 'submitted' ? result : { ...result, status: 'reconcile_required',
        next: '批量提交已有原 key 记录，但当前回读不能完整确认归属；只读核对，不要重发 PUT。' }
    })))
    return { total: results.length, submitted: results.filter(result => result.status === 'submitted').length,
      reconcile_required: results.filter(result => result.status !== 'submitted').length, results }
  }

  await Promise.all(items.map(item => limitedRead(async () => {
    const live = await livePreview(client, item.preview.storyboardId, item.preview.createdAt)
    await assertSelectionReady(ledger, live.scriptId, live.storyboardId, object(JSON.parse(String(live.payload.modelConfig))).prompt)
    if (live.idempotencyKey !== item.preview.idempotencyKey) {
      throw new JubianError('CONTRACT_CHANGED', 'A video preview is stale')
    }
  })))
  const firstRecords = await listAllVideoTasks(client, first.preview.scriptId)
  await Promise.all(items.map(item => limitedRead(async () => {
    const related = await hydrateRelated(client, firstRecords, item.preview.scriptId,
      item.preview.storyboardId, nativeEpisodeScope(item.preview.payload))
    const existing = classifyExistingNativeMatches(related, expectationOf(item.preview, []))
    if (existing.status !== 'none') {
      throw new JubianError('CONTRACT_CHANGED', `Storyboard ${item.preview.storyboardId} has a prior or ambiguous task`)
    }
    const groupedRecord = await recordedGroupedKey(ledger, item.preview)
    if (groupedRecord !== null) throw new JubianError('CONTRACT_CHANGED',
      `Storyboard ${item.preview.storyboardId} has recorded original key ${groupedRecord.key}; keep its original preview for read-only reconciliation; no new reservation or PUT sent`)
  })))
  const secondRecords = await listAllVideoTasks(client, first.preview.scriptId)
  const firstIds = firstRecords.map(taskIdOf).sort()
  const secondIds = secondRecords.map(taskIdOf).sort()
  if (stableJson(firstIds) !== stableJson(secondIds)) {
    throw new JubianError('CONTRACT_CHANGED', 'Project video tasks changed during batch preflight')
  }
  const beforeAll = new Set(secondIds)
  for (const item of items) {
    item.beforeTaskIds = secondRecords.filter(record => isRelatedTaskCandidate(record, item.preview.scriptId,
      item.preview.storyboardId)).map(taskIdOf).filter((id): id is string => id !== null)
  }
  await ledger.beginManyChecked(keys, async () => {
    const decisions = await Promise.all(items.map(item => checkBudget({ ledger,
      method: 'storyboard_native_submit', scriptId: item.preview.scriptId, quote: estimatedVideoQuote(item) })))
    const budgets = decisions.map((budget) => {
      if (budget.status === 'refused' || budget.chargedAmount === undefined || budget.chargedUnit === undefined) {
        throw new JubianError('BUDGET_EXCEEDED', budget.reason)
      }
      return { amount: budget.chargedAmount, unit: budget.chargedUnit }
    })
    const total = budgets.reduce((sum, budget) => sum + (centsOf(budget.amount) as number), 0)
    if (!Number.isSafeInteger(total)) throw new JubianError('INVALID_ARGUMENT', 'Batch cost exceeds numeric range')
    const firstBudget = budgets[0] as { amount: string; unit: string }
    const aggregate = await checkBudget({ ledger, method: 'storyboard_native_submit',
      scriptId: first.preview.scriptId, quote: { amount: (total / 100).toFixed(2), unit: firstBudget.unit } })
    if (aggregate.status === 'refused') throw new JubianError('BUDGET_EXCEEDED', aggregate.reason)
    for (const item of items) assertModel?.(object(JSON.parse(String(item.preview.payload.modelConfig))))
    return items.map((item, index) => {
      const budget = budgets[index] as { amount: string; unit: string }
      return { idempotencyKey: item.idempotency_key,
        method: 'storyboard_native_submit' as const, scriptId: item.preview.scriptId,
        requestSha256: bodyHash(item.preview.payload), quotedAmount: budget.amount, quoteUnit: budget.unit }
    })
  })
  let nextIndex = 0
  const sent: Awaited<ReturnType<typeof submitReservedVideo>>[] = []
  const earlyReads: Promise<NativeClaim | null>[] = []
  await Promise.all(Array.from({ length: Math.min(options.concurrency, items.length) }, async () => {
    for (;;) {
      const index = nextIndex++
      const item = items[index]
      if (item === undefined) break
      sent[index] = await submitReservedVideo(client, ledger, item)
      earlyReads[index] = limitedRead(() => batchReadback(client, item))
    }
  }))
  const earlyClaims = await Promise.all(earlyReads)
  let finalRecords: Record<string, unknown>[] | null = null
  try { finalRecords = await listAllVideoTasks(client, first.preview.scriptId) }
  catch (error) { void error /* Per-item results remain unresolved when the final snapshot fails. */ }
  const appeared = finalRecords?.map(taskIdOf).filter((id): id is string => id !== null)
    .filter(id => !beforeAll.has(id)) ?? []
  const results = await Promise.all(items.map((item, index): Promise<Record<string, unknown>> => limitedRead(async () => {
    const write = sent[index] as (typeof sent)[number]
    let claim: NativeClaim | null = null
    if (finalRecords !== null) {
      try {
        const related = await hydrateRelated(client, finalRecords, item.preview.scriptId,
          item.preview.storyboardId, nativeEpisodeScope(item.preview.payload))
        claim = classifyNewNativeCandidates(related, expectationOf(item.preview, item.beforeTaskIds))
      } catch (error) { void error /* Do not turn missing readback into an identity-loss verdict. */ }
    }
    const report = write.outcome === 'accepted' && claim !== null && claim.status === 'matched'
      ? claimReport(claim) : null
    const submitted = report?.status === 'submitted'
    return { preview_path: item.preview_path, idempotency_key: item.idempotency_key,
      storyboard_id: item.preview.storyboardId, replayed: false, put_sent: true,
      outcome: write.outcome, response_sha256: write.response_sha256,
      status: submitted ? 'submitted' : 'reconcile_required',
      task_id: submitted ? report.task_id : null, put_ambiguous: write.put_ambiguous,
      put_error: write.put_error,
      early_task_id: earlyClaims[index]?.status === 'matched' ? earlyClaims[index].taskId : null,
      project_new_task_ids: appeared,
      next: submitted ? report.next : '该预览已有写入意图，但最终身份未完整确认；按原 key 只读对账，不要重发 PUT。' }
  })))
  return { total: items.length, submitted: results.filter(item => item.status === 'submitted').length,
    reconcile_required: results.filter(item => item.status !== 'submitted').length, results }
}
