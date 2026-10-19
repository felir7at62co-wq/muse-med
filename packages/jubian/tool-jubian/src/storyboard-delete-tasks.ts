/** Complete task evidence used only by storyboard deletion inspection. */
import { JubianError } from '@deepseek-ai/dsh-jubian'
import type { JubianClient, JubianResponse } from '@deepseek-ai/dsh-jubian'
import { stableSha256, taskIdOf } from '@deepseek-ai/dsh-jubian-api'
import { positiveInteger } from './native.ts'

type Row = Record<string, unknown>
interface ProjectTask { taskId: string; record: Row }

/** Resolved bounds for a complete project-task inspection before card deletion. */
export interface DeletionTaskScanOptions {
  /** Rows requested in each project-task or independent child page. */
  readonly pageSize: number
  /** Maximum pages per project-task or child snapshot before refusing incomplete evidence. */
  readonly pageLimit: number
}

/**
 * Validate deployment scan bounds before any deletion inspection starts.
 * @param config - Optional page size and maximum pages for project task reads.
 * @returns Explicit, validated task scan limits.
 */
export function resolveDeletionTaskScanOptions(config: {
  storyboardDeleteTaskPageSize?: number
  storyboardDeleteTaskPageLimit?: number
} = {}): DeletionTaskScanOptions {
  const pageSize = config.storyboardDeleteTaskPageSize ?? 100
  const pageLimit = config.storyboardDeleteTaskPageLimit ?? 20
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100
    || !Number.isSafeInteger(pageLimit) || pageLimit < 1 || pageLimit > 100) {
    throw new JubianError('INVALID_ARGUMENT', 'storyboardDeleteTaskPageSize and storyboardDeleteTaskPageLimit must be integers within 1..100')
  }
  return { pageSize, pageLimit }
}

function fail(detail: string): never { throw new JubianError('CONTRACT_CHANGED', detail) }
function row(value: unknown): Row {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('Unreadable linked task record')
  return value as Row
}

function linkedRows(response: JubianResponse): Row[] {
  // The transport unwraps a bare singleton array for singular readers; this endpoint remains a list.
  if (response.envelope_layout === 'array-single') return [row(response.data)]
  const data = response.data
  const envelope = Array.isArray(data) ? null : row(data)
  const list = envelope === null ? data : envelope.rows ?? envelope.list
  if (!Array.isArray(list)) return fail('Unreadable linked tasks; deletion requires a complete inspection')
  if (envelope !== null && (typeof envelope.total !== 'number' || !Number.isSafeInteger(envelope.total)
    || envelope.total !== list.length)) return fail('Incomplete linked tasks; deletion requires a complete inspection')
  return list.map(row)
}

async function projectTasks(client: JubianClient, scriptId: number, options: DeletionTaskScanOptions): Promise<ProjectTask[]> {
  const result: ProjectTask[] = []
  const seen = new Set<string>()
  let total: number | undefined
  for (let page = 1; page <= options.pageLimit; page++) {
    const data = row((await client.request({ method: 'GET',
      path: `/admin/aigc/video/task/list?scriptId=${scriptId}&pageNum=${page}&pageSize=${options.pageSize}`
        + '&orderByColumn=createTime&orderBy=desc' })).data)
    const count = data.total
    const rows = data.rows ?? data.list
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0 || !Array.isArray(rows)
      || (total !== undefined && count !== total)) fail('Incomplete project task snapshot; deletion remains unverified')
    total = count
    for (const raw of rows) {
      const task = row(raw)
      const id = taskIdOf(task)
      if (id === null || !/^[1-9][0-9]*$/.test(id) || seen.has(id)
        || positiveInteger(task.scriptId) !== scriptId) fail('Unverified project task identity; deletion remains unverified')
      seen.add(id)
      result.push({ taskId: id, record: task })
    }
    if (result.length > total) fail('Project task count exceeded its reported total')
    if (result.length === total) return result
    if (rows.length < options.pageSize) fail('Incomplete project task page; deletion remains unverified')
  }
  return fail('Project task scan limit reached; deletion remains unverified')
}

/** Read only a parent field; an embedded partial child list cannot establish sole ownership. */
function storyboardIdentity(task: Row): number | undefined {
  return task.storyboardId === undefined || task.storyboardId === null ? undefined : positiveInteger(task.storyboardId)
}

function embeddedChildren(task: Row): Row[] {
  if (task.subTaskList === undefined || task.subTaskList === null) return []
  if (!Array.isArray(task.subTaskList)) return fail('Unreadable task children; deletion remains unverified')
  return task.subTaskList.map(row)
}

function verifyParentChildren(task: Row, owner: number | undefined): void {
  for (const child of embeddedChildren(task)) {
    const childOwner = storyboardIdentity(child)
    if (owner !== undefined && childOwner !== undefined && childOwner !== owner) {
      fail('Conflicting task storyboard identities; deletion remains unverified')
    }
  }
}

function childId(child: Row): number {
  const id = positiveInteger(child.id ?? child.subTaskId)
  if (child.id !== undefined && child.subTaskId !== undefined && positiveInteger(child.subTaskId) !== id) {
    fail('Conflicting task child identities; deletion remains unverified')
  }
  return id
}

async function taskChildren(client: JubianClient, scriptId: number, taskId: string,
  options: DeletionTaskScanOptions): Promise<Row[]> {
  const children: Row[] = []
  const seen = new Set<number>()
  let total: number | undefined
  for (let page = 1; page <= options.pageLimit; page++) {
    const data = row((await client.request({ method: 'POST',
      path: `/admin/aigc/video/task/sub/list?pageNum=${page}&pageSize=${options.pageSize}`
        + '&orderByColumn=createTime&orderBy=desc', body: { aigcVideoTaskId: taskId } })).data)
    const count = data.total
    const list = data.rows ?? data.list
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0 || !Array.isArray(list)
      || (total !== undefined && total !== count)) fail('Incomplete task child snapshot; deletion remains unverified')
    total = count
    for (const raw of list) {
      const child = row(raw), id = childId(child)
      if (seen.has(id) || String(positiveInteger(child.aigcVideoTaskId)) !== taskId
        || positiveInteger(child.scriptId) !== scriptId || storyboardIdentity(child) === undefined) {
        fail('Unverified task child identity or ownership; deletion remains unverified')
      }
      seen.add(id)
      children.push(child)
    }
    if (children.length > total) fail('Task child count exceeded its reported total')
    if (children.length === total) return children
    if (list.length < options.pageSize) fail('Incomplete task child page; deletion remains unverified')
  }
  return fail('Task child scan limit reached; deletion remains unverified')
}

function verifyEmbeddedChildren(task: Row, children: Row[], scriptId: number, taskId: string): void {
  const owners = new Set(children.map(storyboardIdentity))
  const indexed = new Map(children.map(child => [childId(child), child]))
  for (const embedded of embeddedChildren(task)) {
    if ((embedded.scriptId !== undefined && embedded.scriptId !== null && positiveInteger(embedded.scriptId) !== scriptId)
      || (embedded.aigcVideoTaskId !== undefined && embedded.aigcVideoTaskId !== null
        && String(positiveInteger(embedded.aigcVideoTaskId)) !== taskId)) {
      fail('Embedded task child identity changed; deletion remains unverified')
    }
    const owner = storyboardIdentity(embedded)
    if (owner !== undefined && !owners.has(owner)) fail('Task child ownership changed; deletion remains unverified')
    if (embedded.id !== undefined || embedded.subTaskId !== undefined) {
      const full = indexed.get(childId(embedded))
      if (full === undefined || (owner !== undefined && owner !== storyboardIdentity(full))) {
        fail('Embedded task child differs from the complete snapshot; deletion remains unverified')
      }
    }
  }
}

async function verifiedProjectTasks(client: JubianClient, scriptId: number, storyboardId: number,
  options: DeletionTaskScanOptions): Promise<Row[]> {
  const before = await projectTasks(client, scriptId, options)
  const linked: Row[] = []
  const childSnapshots = new Map<string, Row[]>()
  for (const { taskId, record: task } of before) {
    if (String(task.taskType) === '2') continue
    const listedId = storyboardIdentity(task)
    verifyParentChildren(task, listedId)
    if (listedId !== undefined && listedId !== storyboardId) continue
    const detail = row((await client.request({ method: 'GET', path: `/admin/aigc/video/task/${taskId}` })).data)
    if (taskIdOf(detail) !== taskId || positiveInteger(detail.scriptId) !== scriptId) {
      fail(`Task ${taskId} identity mismatch; deletion remains unverified`)
    }
    const detailId = storyboardIdentity(detail)
    verifyParentChildren(detail, detailId)
    if (listedId !== undefined && detailId !== undefined && listedId !== detailId) {
      fail(`Task ${taskId} storyboard changed; deletion remains unverified`)
    }
    const owner = detailId ?? listedId
    if (owner !== undefined) {
      verifyParentChildren(task, owner)
      verifyParentChildren(detail, owner)
      if (owner === storyboardId) linked.push({ ...task, ...detail })
      continue
    }
    const children = await taskChildren(client, scriptId, taskId, options)
    if (!children.length) fail(`Task ${taskId} has no verified storyboard identity in the complete ${before.length}-task project snapshot; deletion remains unverified`)
    verifyEmbeddedChildren(task, children, scriptId, taskId)
    verifyEmbeddedChildren(detail, children, scriptId, taskId)
    childSnapshots.set(taskId, children)
    if (children.some(child => storyboardIdentity(child) === storyboardId)) {
      linked.push({ ...task, ...detail, subTaskList: children })
    }
  }
  for (const [taskId, children] of childSnapshots) {
    if (stableSha256(children) !== stableSha256(await taskChildren(client, scriptId, taskId, options))) {
      fail('Task children changed during deletion inspection; inspect again')
    }
  }
  if (stableSha256(before) !== stableSha256(await projectTasks(client, scriptId, options))) {
    fail('Project tasks changed during deletion inspection; inspect again')
  }
  return linked
}

/**
 * Read the card's complete generation history, verifying project tasks when its response is unreadable.
 * @param client - Jubian read transport; this reader never mutates remote state.
 * @param scriptId - The project identity already verified against the card.
 * @param storyboardId - The exact card being inspected.
 * @param options - Validated bounds for complete project task scans.
 * @returns All associated tasks, or an error when complete ownership cannot be established.
 */
export async function deletionTasks(client: JubianClient, scriptId: number, storyboardId: number,
  options: DeletionTaskScanOptions): Promise<Row[]> {
  let response: JubianResponse
  try { response = await client.request({ method: 'GET', path: `/aigc/storyboard/byStoryboard/${storyboardId}` }) }
  catch (error) {
    if (!(error instanceof JubianError) || error.code !== 'CONTRACT_CHANGED') throw error
    try { return await verifiedProjectTasks(client, scriptId, storyboardId, options) }
    catch (inspectionError) {
      if (!(inspectionError instanceof JubianError)) throw inspectionError
      throw new JubianError(inspectionError.code, `Card ${storyboardId} generation history was unreadable;`
        + ` complete project-task verification failed: ${inspectionError.detail ?? inspectionError.message}. No deletion was requested.`)
    }
  }
  return linkedRows(response)
}
