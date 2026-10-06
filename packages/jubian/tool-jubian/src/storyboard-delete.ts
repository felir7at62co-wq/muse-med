/** Inspected, project-bound deletion of exact storyboard identities. */
import { join } from 'node:path'
import { JubianError } from '@deepseek-ai/dsh-jubian'
import type { JubianClient, JubianLedger } from '@deepseek-ai/dsh-jubian'
import { FAILED_STATUSES, SUCCESS_STATUSES, stableSha256, taskStatusOf } from '@deepseek-ai/dsh-jubian-api'
import { atomicWriteJson, positiveInteger, validateProjectBinding } from './native.ts'
import type { ImageBatchOptions, MethodArgs } from './methods.ts'
import { bodyHash, need, requireKey, writeUnderLedger } from './write.ts'
import { readPreparedJson } from './prepared-file.ts'

type Row = Record<string, unknown>
interface Target {
  storyboard_id: number
  snapshot_hash: string
  name: unknown
  episode_id: unknown
  duration: unknown
  prompt: unknown
  material_count: number | null
  tasks: Row[]
  active_generation: boolean
  has_generated_media: boolean
}
interface Plan {
  version: 1
  operation: 'storyboard_delete'
  script_id: number
  delete_reason: string
  authorization_basis: string
  include_generated_media: boolean
  targets: Target[]
  fingerprint: string
}
function invalid(detail: string): never { throw new JubianError('INVALID_ARGUMENT', detail) }
function fail(detail: string): never { throw new JubianError('CONTRACT_CHANGED', detail) }
function row(value: unknown): Row {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('Unreadable storyboard or task record')
  return value as Row
}
function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) return invalid(`${field} must state the user's authorized deletion scope`)
  return value.trim()
}
function ids(value: unknown, maxItems: number): number[] {
  if (!Array.isArray(value) || !value.length || value.length > maxItems) return invalid(`storyboard_ids must contain 1..${maxItems} exact targets`)
  const result = value.map(positiveInteger).sort((a, b) => a - b)
  if (new Set(result).size !== result.length) invalid('Duplicate storyboard_id')
  return result
}
function parsed(value: unknown): unknown {
  if (typeof value !== 'string') return value
  try { return JSON.parse(value) }
  catch (error) { return { unreadable: error instanceof Error ? 'JSON' : 'value', raw: value } }
}
async function readBoard(client: JubianClient, scriptId: number, id: number): Promise<Row | null> {
  const data = (await client.request({ method: 'GET', path: `/aigc/storyboard/${id}` })).data
  if (data === null) return null
  const board = row(data)
  if (positiveInteger(board.id) !== id || positiveInteger(board.scriptId) !== scriptId) fail('Storyboard identity or project mismatch')
  return board
}
async function inspect(client: JubianClient, scriptId: number, id: number): Promise<Target> {
  const board = await readBoard(client, scriptId, id)
  if (board === null) return invalid(`Storyboard ${id} is absent; remove it from the inspection targets`)
  const response = await client.request({ method: 'GET', path: `/aigc/storyboard/byStoryboard/${id}` })
  const data = response.data
  const envelope = Array.isArray(data) ? null : row(data)
  const list = envelope === null ? data : envelope.rows ?? envelope.list
  if (!Array.isArray(list)) return fail('Unreadable linked tasks; deletion requires a complete inspection')
  if (envelope !== null && (typeof envelope.total !== 'number' || !Number.isSafeInteger(envelope.total)
    || envelope.total !== list.length)) return fail('Incomplete linked tasks; deletion requires a complete inspection')
  const tasks = list.map(row)
  const configValue = parsed(board.modelConfig)
  const config = configValue && typeof configValue === 'object' && !Array.isArray(configValue) ? row(configValue) : {}
  const materials = parsed(board.storyboardMaterialList)
  const terminal = [...SUCCESS_STATUSES, ...FAILED_STATUSES] as readonly string[]
  return { storyboard_id: id, snapshot_hash: stableSha256({ board, tasks }),
    name: board.storyboardName ?? null, episode_id: board.episodeId ?? null,
    duration: config.duration ?? null, prompt: config.prompt ?? null,
    material_count: Array.isArray(materials) ? materials.length : materials === null || materials === undefined ? 0 : null,
    tasks, active_generation: tasks.some(task => !terminal.includes(taskStatusOf(task))),
    has_generated_media: tasks.length > 0 || ['resultVideoUrl', 'videoUrl', 'tosVideoUrl'].some(key => Boolean(board[key])) }
}
function destination(root: string, fingerprint: string): string { return join(root, 'video_tasks', `${fingerprint}.storyboard-delete.prepared.json`) }
function digest(plan: Omit<Plan, 'fingerprint'>): string { return stableSha256(plan) }
function removalRequest(scriptId: number, target: Target): Row {
  return { storyboard_id: target.storyboard_id, script_id: scriptId, snapshot_hash: target.snapshot_hash }
}
function verifyClaim(record: { method: string; script_id: number | null; request_sha256: string }, scriptId: number, hash: string): void {
  if (record.method !== 'storyboard_remove' || record.script_id !== scriptId || record.request_sha256 !== hash) {
    fail('Deletion key belongs to another write')
  }
}
function parsePlan(value: unknown, maxItems: number): Plan {
  const valueRow = row(value)
  if (valueRow.version !== 1 || valueRow.operation !== 'storyboard_delete' || typeof valueRow.include_generated_media !== 'boolean') fail('Invalid deletion preview')
  const targets = need(valueRow.targets)
  if (!Array.isArray(targets)) return fail('Invalid deletion targets')
  const targetIds = ids(targets.map(target => row(target).storyboard_id), maxItems)
  if (targets.some((target, index) => row(target).storyboard_id !== targetIds[index])) fail('Deletion targets must be ordered')
  const plan: Omit<Plan, 'fingerprint'> = { version: 1, operation: 'storyboard_delete',
    script_id: positiveInteger(valueRow.script_id), delete_reason: text(valueRow.delete_reason, 'delete_reason'),
    authorization_basis: text(valueRow.authorization_basis, 'authorization_basis'), include_generated_media: valueRow.include_generated_media,
    targets: targets.map((raw) => {
      const target = row(raw)
      if (typeof target.snapshot_hash !== 'string' || !Array.isArray(target.tasks)
        || typeof target.active_generation !== 'boolean' || typeof target.has_generated_media !== 'boolean') fail('Invalid inspected target')
      return { storyboard_id: positiveInteger(target.storyboard_id), snapshot_hash: target.snapshot_hash,
        name: target.name, episode_id: target.episode_id, duration: target.duration, prompt: target.prompt,
        material_count: typeof target.material_count === 'number' ? target.material_count : null,
        tasks: target.tasks.map(row), active_generation: target.active_generation, has_generated_media: target.has_generated_media }
    }) }
  const fingerprint = digest(plan)
  if (valueRow.fingerprint !== fingerprint) fail('Deletion preview fingerprint mismatch')
  return { ...plan, fingerprint }
}

/**
 * Explain the model's inspection required before an irreversible deletion.
 * @param value - Tool arguments observed by the pre-execute hook and the method.
 * @returns A denial reason for an unreviewed delete_apply, or undefined for other calls.
 */
export function deletionInspectionReason(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const args = value as Row
  if (args.method !== 'delete_apply') return undefined
  if (typeof args.preview_path !== 'string' || !Array.isArray(args.checked_storyboard_ids) || !args.checked_storyboard_ids.length) {
    return '删除检查：先调用 delete_preview，核对每张卡的项目、分集、内容、素材和关联生成记录。'
      + '确认它们都在用户授权范围后，把完整 ID 列表传入 checked_storyboard_ids，再 delete_apply。'
  }
  return undefined
}

/**
 * Preview exact card deletion or apply a reviewed preview once, with live readback.
 * @param client - Transport for live card/task inspection and the provider's DELETE endpoint.
 * @param ledger - Records the plan and each deletion; replay performs readback only.
 * @param args - Project, exact target IDs, authorization and reviewed preview location.
 * @param limits - Deployment bounds shared with storyboard batches.
 * @returns Per-card inspection or removal results, including ambiguous response diagnostics.
 */
export async function storyboardDeleteMethod(client: JubianClient, ledger: JubianLedger, args: MethodArgs,
  limits: ImageBatchOptions): Promise<Row> {
  const reason = deletionInspectionReason(args)
  if (reason) invalid(reason)
  const scriptId = positiveInteger(need(args.script_id, 'script_id'))
  const binding = await validateProjectBinding(need(args.project_dir, 'project_dir'), scriptId)
  if (args.method === 'delete_preview') {
    const idsToInspect = ids(args.storyboard_ids, limits.maxItems)
    if (args.include_generated_media !== undefined && typeof args.include_generated_media !== 'boolean') invalid('include_generated_media must be boolean')
    const unsigned: Omit<Plan, 'fingerprint'> = { version: 1, operation: 'storyboard_delete', script_id: scriptId,
      delete_reason: text(args.delete_reason, 'delete_reason'), authorization_basis: text(args.authorization_basis, 'authorization_basis'),
      include_generated_media: args.include_generated_media === true, targets: [] }
    for (const id of idsToInspect) unsigned.targets.push(await inspect(client, scriptId, id))
    const plan = { ...unsigned, fingerprint: digest(unsigned) }
    const path = destination(binding.project_root, plan.fingerprint)
    await atomicWriteJson(path, plan)
    return { ...plan, preview_path: path, paid_requests: 0, status: 'inspection_required',
      requires_generated_authorization: plan.targets.some(target => target.has_generated_media) && !plan.include_generated_media,
      next: '检查身份与完整内容是否就是用户要求删除的卡。关联生成媒体的删除需要用户授权该范围；运行中的任务不能删除。'
        + '核对后用 delete_apply，checked_storyboard_ids=全部目标 ID，idempotency_key=fingerprint。' }
  }
  if (args.method !== 'delete_apply') invalid('Unknown storyboard deletion method')
  const key = requireKey(args.idempotency_key)
  const raw = await readPreparedJson(binding.project_root, key, need(args.preview_path, 'preview_path'), 'storyboard-delete')
  const plan = parsePlan(raw, limits.maxItems)
  if (plan.script_id !== scriptId || plan.fingerprint !== key) fail('Deletion project/path/key mismatch')
  if (stableSha256(ids(args.checked_storyboard_ids, limits.maxItems)) !== stableSha256(plan.targets.map(target => target.storyboard_id))) {
    invalid('删除检查：checked_storyboard_ids 必须包含已逐张 inspect 检查过的全部目标')
  }
  const items: Row[] = []
  const prior = await ledger.find(key)
  if (prior !== undefined) {
    verifyClaim(prior, scriptId, `sha256:${key}`)
    for (const target of plan.targets) {
      const recorded = await ledger.find(`${key}:${target.storyboard_id}`)
      if (recorded === undefined) { items.push({ storyboard_id: target.storyboard_id, status: 'not_attempted', verified_readback: false }); continue }
      verifyClaim(recorded, scriptId, bodyHash(removalRequest(scriptId, target)))
      let status = 'unknown'
      try { status = await readBoard(client, scriptId, target.storyboard_id) === null ? 'deleted' : 'still_present' }
      catch (error) { status = 'unknown'; items.push({ storyboard_id: target.storyboard_id, status,
        response_status: recorded.outcome ?? 'unknown', verified_readback: false,
        error: error instanceof JubianError ? error.code : 'READBACK_FAILED' }); continue }
      items.push({ storyboard_id: target.storyboard_id, status, response_status: recorded.outcome ?? 'unknown',
        verified_readback: status === 'deleted' })
    }
    return { status: 'replayed', replayed: true, paid_requests: 0, items, next: '只做回读，没有再次删除。未尝试的卡需重新预览剩余精确范围。' }
  }
  for (const target of plan.targets) {
    const live = await inspect(client, scriptId, target.storyboard_id)
    if (stableSha256(live) !== stableSha256(target)) fail(`Stale deletion preview: card ${target.storyboard_id} changed; inspect again`)
    if (live.active_generation) invalid(`Card ${target.storyboard_id} has active generation; wait for completion and inspect again`)
    if (live.has_generated_media && !plan.include_generated_media) invalid('关联生成媒体未获得删除授权：preview 必须明确 include_generated_media 后重新检查')
  }
  const claim = await ledger.begin({ idempotencyKey: key, method: 'storyboard_remove', scriptId, requestSha256: `sha256:${key}` })
  if (claim.replayed) return storyboardDeleteMethod(client, ledger, args, limits)
  let stopped = false
  for (const target of plan.targets) {
    if (stopped) { items.push({ storyboard_id: target.storyboard_id, status: 'not_attempted', verified_readback: false }); continue }
    const item: Row = { storyboard_id: target.storyboard_id, status: 'unknown', verified_readback: false }
    try {
      if (stableSha256(await inspect(client, scriptId, target.storyboard_id)) !== stableSha256(target)) {
        item.status = 'stale'; stopped = true
      } else {
        const result = await writeUnderLedger(ledger, `${key}:${target.storyboard_id}`, 'storyboard_remove',
          () => removalRequest(scriptId, target),
          () => client.request({ method: 'DELETE', path: `/aigc/storyboard/${target.storyboard_id}` }), undefined,
          { scriptId, verifyReplayBody: true })
        item.response_status = result.outcome
        if (result.outcome !== 'accepted' || result.replayed) stopped = true
      }
    } catch (error) {
      item.response_status = 'unknown'; item.error = error instanceof JubianError ? error.code : 'REQUEST_OR_READBACK_FAILED'; stopped = true
    }
    if (item.status !== 'stale') {
      try { item.status = await readBoard(client, scriptId, target.storyboard_id) === null ? 'deleted' : 'still_present' }
      catch (error) { item.status = 'unknown'; item.error = error instanceof JubianError ? error.code : 'READBACK_FAILED' }
      item.verified_readback = item.status === 'deleted'
      if (item.status !== 'deleted') stopped = true
    }
    items.push(item)
  }
  return { status: items.every(item => item.status === 'deleted') ? 'deleted' : 'partial',
    replayed: false, paid_requests: 0, items, next: '删除以回读为准。unknown 保留原 key 回读对账，不能换 key 重删；未尝试的卡重新检查后另建计划。' }
}
