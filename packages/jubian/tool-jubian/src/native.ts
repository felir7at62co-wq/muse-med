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
import { randomBytes } from 'node:crypto'
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import type { JubianClient, JubianLedger, JubianResponse } from '@deepseek-ai/dsh-jubian'
import { JubianError } from '@deepseek-ai/dsh-jubian'
import {
  buildNativeVideoPreview, buildSubjectSelection, childrenOf, classifyExistingNativeMatches,
  classifyNewNativeCandidates, isRelatedTaskCandidate, nativeResultUrls, readBackIdentity,
  responseRecords, stableJson, storyboardMaterials, taskIdOf, taskSemanticFields, taskStatusOf,
  validateNativeVideoPreview, verifySubjectSelection, wireText,
} from '@deepseek-ai/dsh-jubian-api'
import type { HydratedTask, NativeClaim, NativeClaimExpectation, NativeVideoPreview,
  SubjectIdentityItem, SubjectSelectionRequest } from '@deepseek-ai/dsh-jubian-api'
import { need, requireKey, writeUnderLedger } from './write.ts'

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

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new JubianError('CONTRACT_CHANGED')
  return value as Record<string, unknown>
}

export function positiveInteger(value: unknown): number {
  const candidate = typeof value === 'string' && /^[0-9]+$/.test(value.trim()) ? Number(value.trim()) : value
  if (typeof candidate !== 'number' || !Number.isSafeInteger(candidate) || candidate < 1) {
    throw new JubianError('CONTRACT_CHANGED')
  }
  return candidate
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
      if (taskId === null) continue
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
async function parentAsset(client: JubianClient, assetId: unknown): Promise<Record<string, unknown>> {
  const requested = wireText(assetId)
  if (requested === null) fail()
  const response = await client.request({ method: 'GET', path: `/aigc/asset/${requested}` })
  const asset = object(response.data)
  if (wireText(asset.id) !== requested) throw new JubianError('CONTRACT_CHANGED')
  return asset
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
 * Every ordered material is resolved to exactly one active subject-setting row
 * and one parent asset in the same project, and the asset's official URL must
 * equal the row's: these are the identities the paid PUT will translate, so a
 * field that disagrees is refused while the call is still free.
 * @param client - Jubian transport.
 * @param storyboardId - The storyboard to prepare.
 * @returns The live storyboard and its ordered, enriched parent assets.
 */
async function loadLiveInputs(client: JubianClient, storyboardId: number):
Promise<{ storyboard: Record<string, unknown>; assets: Record<string, unknown>[] }> {
  const storyboard = await storyboardSnapshot(client, storyboardId)
  const scriptId = positiveInteger(storyboard.scriptId)
  const { materials } = storyboardMaterials(storyboard)
  const byId = new Map<string, Record<string, unknown>>()
  const ordered: Record<string, unknown>[] = []
  for (const material of materials) {
    const parentId = wireText(material.materialAssetId ?? material.assetId)
    if (parentId === null || parentId === '') throw new JubianError('CONTRACT_CHANGED')
    const key = parentId
    let asset = byId.get(key)
    if (asset === undefined) {
      asset = await parentAsset(client, parentId)
      if (positiveInteger(asset.scriptId) !== scriptId) throw new JubianError('CONTRACT_CHANGED')
      byId.set(key, asset)
    }
    ordered.push(asset)
  }
  const rows = await listAllSubjectMaterials(client, scriptId)
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
    const row = matches[0] ?? fail()
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
    const trustedKey = `t:${wireText(trusted) ?? ''}`
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
  return { storyboard, assets: ordered }
}

/** The live catalogue of video-generation models. */
async function videoCatalogue(client: JubianClient): Promise<unknown> {
  return (await client.request({ method: 'GET', path: '/model/charge/getSelectList?taskType=1' })).data
}

/** Build the exact preview from live provider state, without writing anything. */
async function livePreview(client: JubianClient, storyboardId: number, createdAt: string):
Promise<NativeVideoPreview> {
  const { storyboard, assets } = await loadLiveInputs(client, storyboardId)
  return buildNativeVideoPreview({ storyboard, assets, models: await videoCatalogue(client), createdAt })
}

/** Read a positive episode id; missing or malformed values cannot exclude a candidate. */
function episodeIdOf(value: unknown): number | null {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^[0-9]+$/.test(value.trim()))) return null
  const id = Number(value)
  return Number.isSafeInteger(id) && id > 0 ? id : null
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
 * @param episodeId - Live preview episode; only explicit valid differences exclude tasks before the cap.
 * @returns One hydrated entry per provably related task, each with its storyboard-matching children.
 */
async function hydrateRelated(client: JubianClient, records: Record<string, unknown>[],
  scriptId: number, storyboardId: number, episodeId: unknown): Promise<HydratedTask[]> {
  const expectedEpisode = episodeIdOf(episodeId)
  const related = records.filter((record) => {
    if (!isRelatedTaskCandidate(record, scriptId, storyboardId)) return false
    const episode = episodeIdOf(record.episodeId ?? record.episode_id)
    return expectedEpisode === null || episode === null || episode === expectedEpisode
  })
  if (related.length > MAX_HYDRATED_TASKS) throw new JubianError('CONTRACT_CHANGED')
  const hydrated: HydratedTask[] = []
  for (const record of related) {
    const taskId = taskIdOf(record)
    if (taskId === null) throw new JubianError('CONTRACT_CHANGED')
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

/** Build the expectation one claim is checked against. */
function expectationOf(preview: NativeVideoPreview, beforeTaskIds: string[]): NativeClaimExpectation {
  const modelConfig = typeof preview.payload.modelConfig === 'string' ? preview.payload.modelConfig : '{}'
  const entries = Object.entries(JSON.parse(modelConfig) as Record<string, unknown>)
  const fields = ['platformId', 'modelId', 'standardId', 'genType', 'modelGenerationTypeId', 'videoStandardId',
    'duration', 'ratio', 'resolution', 'genNum'] as const
  const expectedModel = fields.map((field) => {
    const value = entries.find(([key]) => key === field)?.[1]
    const rendered = value === undefined || value === null || value === '' ? null : wireText(value)
    if (rendered === null) throw new JubianError('CONTRACT_CHANGED')
    return [field, rendered] as [string, string]
  })
  const prompt = entries.find(([key]) => key === 'prompt')?.[1]
  if (typeof prompt !== 'string' || !prompt) throw new JubianError('CONTRACT_CHANGED')
  return { scriptId: preview.scriptId, storyboardId: preview.storyboardId,
    episodeId: Number(preview.payload.episodeId),
    expectedIdentity: expectedIdentity(preview), expectedModel, expectedPrompt: prompt,
    beforeTaskIds }
}

/** Turn one claim into the model-facing status plus the reconciliation guidance it earns. */
function claimReport(claim: NativeClaim, preview: NativeVideoPreview):
Record<string, unknown> {
  if (claim.status === 'matched') {
    const identity = readBackIdentity(claim.child, expectedIdentity(preview))
    const urls = nativeResultUrls([claim.task, claim.child])
    if (identity.status === 'subject_identity_lost') {
      return { status: 'subject_identity_lost', task_id: claim.taskId, reason: identity.reason,
        next: '身份缺失是终态：不要再提交、不要重建 preview。人工核对该任务的子项身份后再决定。' }
    }
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
 * Write one JSON file atomically inside its destination directory.
 * @param path - Destination path.
 * @param value - Owned JSON value to persist.
 */
export async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${randomBytes(6).toString('hex')}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(temporary, path)
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
  try { parsed = JSON.parse(text.replace(/^\uFEFF/, '')) as unknown } catch { throw new JubianError('CONTRACT_CHANGED') }
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
 * @param args - `storyboard_id`, `project_dir` and an optional `content_duration_ms` cross-check.
 * @returns The persisted preview, its path and the exact next step.
 * @throws {JubianError} `CONTRACT_CHANGED` when any live identity or setting fails.
 */
export async function prepareVideoMethod(client: JubianClient, args: {
  storyboard_id?: number | undefined
  project_dir?: string | undefined
  content_duration_ms?: number | undefined
}): Promise<Record<string, unknown>> {
  const storyboardId = positiveInteger(need(args.storyboard_id))
  const preview = await livePreview(client, storyboardId, new Date().toISOString())
  const binding = await validateProjectBinding(need(args.project_dir), preview.scriptId)
  const modelConfig = JSON.parse(String(preview.payload.modelConfig)) as Record<string, unknown>
  const duration = positiveInteger(modelConfig.duration)
  const contentDurationMs = (duration - 1) * 1000
  if (args.content_duration_ms !== undefined && args.content_duration_ms !== contentDurationMs) {
    throw new JubianError('CONTRACT_CHANGED')
  }
  const root = resolve(binding.project_root, 'video_tasks')
  const destination = resolve(root, `storyboard-${storyboardId}-${preview.idempotencyKey.slice(0, 12)}`
    + '.storyboard-native.prepared.json')
  if (!destination.startsWith(`${root}${sep}`)) throw new JubianError('CONTRACT_CHANGED')
  await atomicWriteJson(destination, preview)
  return { ...preview, preview_path: destination, content_duration_ms: contentDurationMs,
    storyboard_duration_seconds: duration,
    next: 'prepare 只写 preview：不 PUT、不创建任务、不收费。逐字段审阅后调用 submit_video，'
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
  if (!Array.isArray(selections) || selections.length === 0) throw new JubianError('CONTRACT_CHANGED')
  const subjectRows = await listAllSubjectMaterials(client, scriptId)
  const parents: Record<string, unknown>[] = []
  for (const assetId of [...new Set(selections.map(selection => String(selection.asset_id)))]) {
    parents.push(await parentAsset(client, assetId))
  }
  const plan = buildSubjectSelection({ storyboard, selections, subjectRows, parentAssets: parents })
  if (plan.status === 'already_applied') {
    return { operation: plan.operation, status: 'already_applied', applied: false,
      scriptId: plan.scriptId, storyboardId: plan.storyboardId, before: plan.before, after: plan.after,
      next: '分镜已经保存的就是这个选择：没有发送 PUT，也没有收费。' }
  }
  const beforeRecords = await listAllVideoTasks(client, scriptId)
  const beforeIds = new Set<string>()
  for (const record of beforeRecords) {
    if (!isRelatedTaskCandidate(record, scriptId, storyboardId)) continue
    const taskId = taskIdOf(record)
    if (taskId === null) throw new JubianError('CONTRACT_CHANGED')
    beforeIds.add(taskId)
  }
  const result = await writeUnderLedger(ledger, key, 'storyboard_select_assets',
    () => plan.payload,
    payload => client.request({ method: 'PUT', path: '/aigc/storyboard', body: payload ?? fail() }))
  const afterRecords = await listAllVideoTasks(client, scriptId)
  const newRelated: string[] = []
  for (const record of afterRecords) {
    if (!isRelatedTaskCandidate(record, scriptId, storyboardId)) continue
    const taskId = taskIdOf(record)
    if (taskId === null) throw new JubianError('CONTRACT_CHANGED')
    if (!beforeIds.has(taskId)) newRelated.push(taskId)
  }
  const verified = await storyboardSnapshot(client, storyboardId)
  // No `is_generate` check here: the provider stores 1 on every storyboard, so it proves nothing. The
  // billing-safe signal is `newRelated` above — a selection-only save must not create a task.
  const verification = verifySubjectSelection(verified, plan.after)
  if (!verification.matches) throw new JubianError('CONTRACT_CHANGED')
  return { ...result, operation: plan.operation, scriptId, storyboardId,
    before: plan.before, after: plan.after, verification,
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
  return resolve(root, matches[0] ?? fail())
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
        episode_id: episodeIdOf(candidate.task.episodeId ?? candidate.task.episode_id),
        children: candidate.children.length,
      }
    })
}

export async function submitVideoMethod(client: JubianClient, ledger: JubianLedger, args: {
  preview_path?: string | undefined
  project_dir?: string | undefined
  storyboard_id?: number | undefined
  idempotency_key?: string | undefined
}): Promise<Record<string, unknown>> {
  const key = need(args.idempotency_key)
  if (!key.trim()) throw new JubianError('CONTRACT_CHANGED')
  const previewPath = await resolvePreviewPath(args)
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(previewPath, 'utf8')) as unknown
  } catch { throw new JubianError('CONTRACT_CHANGED') }
  const preview = validateNativeVideoPreview(parsed)
  const binding = await validateProjectBinding(projectRootOfPreview(previewPath), preview.scriptId)
  if (binding.script_id !== preview.scriptId) throw new JubianError('CONTRACT_CHANGED')
  if (key !== preview.idempotencyKey) throw new JubianError('CONTRACT_CHANGED')

  // The record is consulted before the live rebuild on purpose: a key that
  // already caused a PUT may only ever be reconciled, and reconciliation must
  // still work after the operator has moved the storyboard on.
  const recorded = await ledger.find(key)
  if (recorded !== undefined) {
    const records = await listAllVideoTasks(client, preview.scriptId)
    const hydrated = await hydrateRelated(client, records, preview.scriptId, preview.storyboardId, preview.payload.episodeId)
    const claim = classifyExistingNativeMatches(hydrated, expectationOf(preview, []))
    return { replayed: true, outcome: recorded.outcome ?? 'unknown', response_sha256: recorded.response_sha256,
      preview_path: previewPath, idempotency_key: key, ...claimReport(claim, preview),
      next: `同一个 idempotency_key 已有一条记录（outcome=${recorded.outcome ?? 'unknown'}），`
        + '因此不会再发送任何 PUT。上面是对账结果：submitted 表示这次提交确实已经创建了任务；'
        + 'reconcile_required 表示暂时看不到新任务，继续用同一个 key 对账即可。' }
  }

  const live = await livePreview(client, preview.storyboardId, preview.createdAt)
  if (live.idempotencyKey !== preview.idempotencyKey) throw new JubianError('CONTRACT_CHANGED')

  const preflightRecords = await listAllVideoTasks(client, preview.scriptId)
  const preflight = await hydrateRelated(client, preflightRecords, preview.scriptId, preview.storyboardId, preview.payload.episodeId)
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

  const state = { putFailed: false, reconciliationFailed: false, sent: false, appearedIds: [] as string[],
    claim: { status: 'none' } as NativeClaim }
  const result = await writeUnderLedger(ledger, key, 'storyboard_native_submit', () => preview.payload,
    async (payload): Promise<JubianResponse> => {
      let response: JubianResponse
      try {
        response = await client.request({ method: 'PUT', path: '/aigc/storyboard',
          body: payload ?? fail() })
      } catch {
        // Every failed PUT is ambiguous: the provider may have applied it, and a
        // second request is exactly what must never happen. The ledger settle
        // below records `unknown`, which is the honest verdict.
        state.putFailed = true
        return { transport: { http_status: null, application_code: null }, response_sha256: null, data: null }
      }
      state.sent = true
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
        const hydrated = await hydrateRelated(client, afterRecords, preview.scriptId, preview.storyboardId, preview.payload.episodeId)
        state.claim = classifyNewNativeCandidates(hydrated, expectationOf(preview, beforeTaskIds))
      } catch {
        state.reconciliationFailed = true
      }
      return response
    }, undefined, { scriptId: preview.scriptId })
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
    : claimReport(state.claim, preview)
  return { ...result, preview_path: previewPath, idempotency_key: key,
    ...report,
    status: state.putFailed || acceptedUnclaimed ? 'reconcile_required' : report.status,
    put_sent: putSent,
    put_outcome: putOutcome,
    ...(acceptedUnclaimed ? { claim_status: 'reconcile_conflict' } : {}),
    ...(state.appearedIds.length > 0 ? { new_task_ids: state.appearedIds } : {}),
    put_ambiguous: state.putFailed, before_task_ids: beforeTaskIds,
    next: state.putFailed
      ? 'PUT 的结果不明确（超时/5xx/连接中断）：没有任何自动重试，这个 key 也不会再发 PUT。'
        + '按上面的对账结果处理：submitted 就是已创建，否则继续用同一个 key 对账。'
      : acceptedUnclaimed
        ? 'PUT 已被提供方受理（很可能已计费），但没有一条候选能被完整认领：不要重新提交这个 preview。'
          + '按 new_task_ids 回读那些新任务（jubian_video subtasks），或人工核对归属。'
        : report.next }
}
