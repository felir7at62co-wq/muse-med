/** Read-only, card-bound video history for extraction and reuse across generation settings. */
import { JubianError } from '@deepseek-ai/dsh-jubian'
import type { JubianClient, JubianRequest, JubianResponse } from '@deepseek-ai/dsh-jubian'
import { FAILED_STATUSES, SUCCESS_STATUSES, readSubtaskPage, taskIdOf, taskStatusOf } from '@deepseek-ai/dsh-jubian-api'

type Row = Record<string, unknown>

/** Deployment limits for source discovery; reaching a limit leaves coverage incomplete. */
export interface VideoSourceOptions {
  pageSize: number
  pageLimit: number
  taskLimit: number
  resultLimit: number
  /** Maximum UTF-16 code units in the complete JSON result; whole rows are omitted when necessary. */
  maxResultChars: number
}

/** One successfully generated, independently verified source; speaker identity remains unverified. */
export interface VideoSource {
  task_id: number
  subtask_id: number
  first_result_id: number | null
  video_url: string
  base_video_url: string | null
  model_id: string | null
  resolution: string | null
  status: string
}

/** Advisory source evidence, never authorization to submit or repeat a generation. */
export interface VideoSourceResult {
  script_id: number
  storyboard_id: number
  queried_at: string
  status: 'available' | 'pending' | 'none_found' | 'unknown'
  complete: boolean
  coverage: { history: 'card' | 'project'; pages_read: number; tasks_found: number; tasks_checked: number; results_found: number }
  sources: VideoSource[]
  tasks: { task_id: number; status: string }[]
  issues: string[]
  next: string
}

/**
 * Resolve bounds for advisory video-history reads.
 * @param config - Optional deployment-owned page, hydration and result bounds.
 * @returns Explicit limits shared by source reads and prepare advice.
 */
export function resolveVideoSourceOptions(config: {
  videoSourcePageSize?: number
  videoSourcePageLimit?: number
  videoSourceTaskLimit?: number
  videoSourceResultLimit?: number
  videoSourceMaxResultChars?: number
} = {}): VideoSourceOptions {
  const result = { pageSize: config.videoSourcePageSize ?? 100, pageLimit: config.videoSourcePageLimit ?? 20,
    taskLimit: config.videoSourceTaskLimit ?? 50, resultLimit: config.videoSourceResultLimit ?? 20 }
  for (const [key, value] of Object.entries(result)) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 100) {
      throw new JubianError('INVALID_ARGUMENT', `videoSource ${key} must be an integer within its supported range`)
    }
  }
  const maxResultChars = config.videoSourceMaxResultChars ?? 12000
  if (!Number.isSafeInteger(maxResultChars) || maxResultChars < 2048 || maxResultChars > 1000000) {
    throw new JubianError('INVALID_ARGUMENT', 'videoSourceMaxResultChars must be an integer within 2048..1000000')
  }
  return { ...result, maxResultChars }
}

function record(value: unknown): Row {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new JubianError('CONTRACT_CHANGED')
  return value as Row
}
function identity(value: unknown): number | null {
  const candidate = typeof value === 'string' && /^[1-9][0-9]*$/.test(value) ? Number(value) : value
  return typeof candidate === 'number' && Number.isSafeInteger(candidate) && candidate > 0 ? candidate : null
}
function owned(row: Row, scriptId: number, storyboardId?: number): boolean {
  return identity(row.scriptId) === scriptId
    && (storyboardId === undefined || identity(row.storyboardId) === storyboardId)
}
function list(response: JubianResponse, allowUnpaged: boolean): { rows: Row[]; total: number | null; unpaged: boolean } {
  if (Array.isArray(response.data)) return { rows: response.data.map(record),
    total: allowUnpaged ? response.data.length : null, unpaged: allowUnpaged }
  const data = record(response.data)
  if (response.envelope_layout === 'array-single' && !Object.hasOwn(data, 'rows') && !Object.hasOwn(data, 'list')) {
    return { rows: [data], total: allowUnpaged ? 1 : null, unpaged: allowUnpaged }
  }
  const rows = data.rows ?? data.list
  if (!Array.isArray(rows)) throw new JubianError('CONTRACT_CHANGED')
  const total = typeof data.total === 'number' && Number.isSafeInteger(data.total) && data.total >= 0 ? data.total : null
  return { rows: rows.map(record), total, unpaged: false }
}

/**
 * Find verified existing videos on an exact project/card, independent of today's model choice.
 * Every network operation is a read, including the child-list POST. Partial reads retain verified
 * sources and report unknown coverage; a read failure never requires new generation.
 * @param client - Authenticated read transport.
 * @param args - Exact project and original card identities.
 * @param options - Explicit bounds for pagination, task hydration and output.
 * @param signal - Foreground cancellation, propagated without converting it into a finding.
 * @returns Bounded source evidence and coverage; successful media still needs speaker/content inspection.
 */
export async function readVideoSources(client: JubianClient, args: { script_id: number; storyboard_id: number },
  options: VideoSourceOptions, signal?: AbortSignal): Promise<VideoSourceResult> {
  if (identity(args.script_id) === null || identity(args.storyboard_id) === null) {
    throw new JubianError('INVALID_ARGUMENT', 'script_id and storyboard_id must be positive integers')
  }
  const result: VideoSourceResult = { ...args, queried_at: new Date().toISOString(), status: 'unknown', complete: true,
    coverage: { history: 'card', pages_read: 0, tasks_found: 0, tasks_checked: 0, results_found: 0 },
    sources: [], tasks: [], issues: [], next: '' }
  let pendingChild = false
  const issue = (code: string) => { result.complete = false; if (!result.issues.includes(code)) result.issues.push(code) }
  const read = async (request: JubianRequest): Promise<JubianResponse | null> => {
    signal?.throwIfAborted()
    try { return await client.request({ ...request, ...(signal === undefined ? {} : { signal }) }) }
    catch (error) {
      signal?.throwIfAborted()
      if (error instanceof Error && error.name === 'AbortError') throw error
      issue(error instanceof JubianError ? error.code : 'READ_FAILED')
      return null
    }
  }
  const page = (response: JubianResponse, allowUnpaged = false): ReturnType<typeof list> | null => {
    try { return list(response, allowUnpaged) }
    catch (_error) { issue('UNREADABLE_HISTORY'); return null }
  }
  const describe = (): void => {
    result.status = result.sources.length ? 'available' : !result.complete ? 'unknown'
      : pendingChild || result.tasks.some(task => task.status !== '' && !(FAILED_STATUSES as readonly string[]).includes(task.status)
        && !(SUCCESS_STATUSES as readonly string[]).includes(task.status)) ? 'pending' : 'none_found'
    result.next = result.sources.length
      ? '已有成功视频可供提取：用 sources 中的原 task_id、subtask_id 和 video_url 下载并核对实际说话人；旧模型或分辨率不同不妨碍作为取样来源。'
      : result.status === 'pending' ? '已有任务尚未完成，继续查询原 task_id；提取声线不等于授权重新生成。'
        : result.status === 'none_found' ? '本次完整查询未找到此原卡的成功视频；这不是新生成授权，可继续查其他已知来源或报告缺少来源。'
          : '来源查询尚未完整核实，不能认定此卡从未生成；保留已有证据，继续只读核对，不因查询缺口重新生成。'
    if (!result.complete && result.sources.length) result.next += ' 查询覆盖不完整，其他历史结果仍未知。'
  }
  const finish = (): VideoSourceResult => {
    describe()
    while (JSON.stringify(result).length > options.maxResultChars && (result.sources.length || result.tasks.length)) {
      issue('OUTPUT_LIMIT')
      if (result.sources.length) result.sources.pop()
      else result.tasks.pop()
      describe()
    }
    return result
  }
  const cardResponse = await read({ method: 'GET', path: `/aigc/storyboard/${args.storyboard_id}` })
  if (cardResponse === null) return finish()
  let card: Row
  try { card = record(cardResponse.data) }
  catch (_error) { issue('UNREADABLE_CARD'); return finish() }
  if (identity(card.id ?? card.storyboardId) !== args.storyboard_id || !owned(card, args.script_id)) {
    issue('CARD_IDENTITY_MISMATCH'); return finish()
  }
  const historyResponse = await read({ method: 'GET', path: `/aigc/storyboard/byStoryboard/${args.storyboard_id}` })
  const linked = historyResponse === null ? null : page(historyResponse, true)
  let candidates: Row[] = linked?.rows ?? []
  const linkedComplete = linked !== null && linked.total !== null && linked.rows.length === linked.total
  if (!linkedComplete) {
    result.coverage.history = 'project'
    const linkedCandidates = candidates
    candidates = []
    const seen = new Set<number>()
    let total: number | null = null, complete = false
    for (let num = 1; num <= options.pageLimit; num++) {
      const response = await read({ method: 'GET', path: `/admin/aigc/video/task/list?scriptId=${args.script_id}`
        + `&taskType=1&pageNum=${num}&pageSize=${options.pageSize}&orderByColumn=createTime&orderBy=desc` })
      if (response === null) break
      result.coverage.pages_read++
      const data = page(response)
      if (data === null || data.total === null || (total !== null && total !== data.total)) { issue('UNSTABLE_TASK_TOTAL'); break }
      total = data.total
      let repeated = false
      for (const task of data.rows) {
        const id = identity(taskIdOf(task))
        if (id === null || seen.has(id) || !owned(task, args.script_id)) { issue('TASK_IDENTITY_MISMATCH'); repeated = true; continue }
        seen.add(id)
        candidates.push(task)
      }
      if (repeated) break
      if (candidates.length === total) { complete = true; break }
      if (candidates.length > total || data.rows.length === 0) { issue('INCOMPLETE_TASK_PAGE'); break }
    }
    if (!complete) {
      issue('TASK_SCAN_INCOMPLETE')
      for (const candidate of linkedCandidates) {
        const id = identity(taskIdOf(candidate))
        if (id !== null && !seen.has(id)) { seen.add(id); candidates.push(candidate) }
      }
    }
    else if (result.issues.every(code => ['UNREADABLE_HISTORY', 'CONTRACT_CHANGED'].includes(code))) {
      result.issues = []; result.complete = true
    }
  }
  const ids = new Set<number>()
  for (const candidate of candidates) {
    const taskId = identity(taskIdOf(candidate))
    if (taskId === null || ids.has(taskId)) { issue('TASK_IDENTITY_MISMATCH'); continue }
    ids.add(taskId)
    if (candidate.scriptId !== undefined && identity(candidate.scriptId) !== args.script_id) { issue('TASK_IDENTITY_MISMATCH'); continue }
    const listedOwner = identity(candidate.storyboardId)
    if (listedOwner !== null && listedOwner !== args.storyboard_id) {
      if (result.coverage.history === 'card') issue('LINKED_CARD_MISMATCH')
      continue
    }
    result.coverage.tasks_found++
    if (result.coverage.tasks_checked >= options.taskLimit) { issue('TASK_LIMIT'); break }
    result.coverage.tasks_checked++
    const detailResponse = await read({ method: 'GET', path: `/admin/aigc/video/task/${taskId}` })
    if (detailResponse === null) continue
    let detail: Row
    try { detail = record(detailResponse.data) }
    catch (_error) { issue('UNREADABLE_TASK'); continue }
    const owner = identity(detail.storyboardId)
    if (identity(taskIdOf(detail)) !== taskId || !owned(detail, args.script_id)
      || (listedOwner !== null && owner !== null && listedOwner !== owner)) { issue('TASK_IDENTITY_MISMATCH'); continue }
    if (owner !== null && owner !== args.storyboard_id) {
      if (result.coverage.history === 'card') issue('LINKED_CARD_MISMATCH')
      continue
    }
    const parentHasCard = owner === args.storyboard_id || listedOwner === args.storyboard_id
    let parentMatched = parentHasCard
    const parentStatus = taskStatusOf(detail, candidate)
    if (!parentStatus) issue('TASK_STATUS_UNKNOWN')
    const seenChildren = new Set<number>()
    let total: number | null = null, complete = false
    for (let num = 1; num <= options.pageLimit; num++) {
      const response = await read({ method: 'POST', path: `/admin/aigc/video/task/sub/list?pageNum=${num}`
        + `&pageSize=${options.pageSize}&orderByColumn=createTime&orderBy=desc`, body: { aigcVideoTaskId: taskId } })
      if (response === null) break
      result.coverage.pages_read++
      const data = page(response)
      if (data === null || data.total === null || (total !== null && total !== data.total)) { issue('UNSTABLE_CHILD_TOTAL'); break }
      total = data.total
      const before = seenChildren.size
      for (const child of data.rows) {
        const id = identity(child.id ?? child.subTaskId)
        if (id === null || seenChildren.has(id) || identity(child.aigcVideoTaskId) !== taskId
          || !owned(child, args.script_id)) { issue('CHILD_IDENTITY_MISMATCH'); continue }
        seenChildren.add(id)
        const childOwner = identity(child.storyboardId)
        if (childOwner !== null && childOwner !== args.storyboard_id) {
          if (parentHasCard) issue('CHILD_CARD_MISMATCH')
          continue
        }
        if (childOwner === null && !parentHasCard) { issue('CHILD_CARD_UNKNOWN'); continue }
        parentMatched = true
        let parsed: ReturnType<typeof readSubtaskPage>['rows'][number] | undefined
        try { parsed = readSubtaskPage({ total: 1, rows: [child] }).rows[0] }
        catch (_error) { issue('UNREADABLE_CHILD'); continue }
        if (parsed === undefined) { issue('UNREADABLE_CHILD'); continue }
        const status = parsed.status?.trim().toLowerCase() ?? ''
        if (!status) issue('CHILD_STATUS_UNKNOWN')
        else if (!(SUCCESS_STATUSES as readonly string[]).includes(status)
          && !(FAILED_STATUSES as readonly string[]).includes(status)) pendingChild = true
        if (!(SUCCESS_STATUSES as readonly string[]).includes(status)) continue
        if (parsed.video_url === null) { issue('SUCCESS_WITHOUT_MEDIA'); continue }
        let media: URL
        try { media = new URL(parsed.video_url) }
        catch (_error) { issue('UNREADABLE_MEDIA_URL'); continue }
        if (media.protocol !== 'https:' || media.username || media.password || parsed.video_url.includes('\\')) {
          issue('UNREADABLE_MEDIA_URL'); continue
        }
        result.coverage.results_found++
        if (result.sources.length >= options.resultLimit) { issue('RESULT_LIMIT'); continue }
        result.sources.push({ task_id: taskId, subtask_id: parsed.subtask_id, first_result_id: parsed.first_result_id,
          video_url: parsed.video_url, base_video_url: parsed.base_video_url, model_id: parsed.model_id,
          resolution: parsed.resolution, status })
      }
      if (seenChildren.size === total) { complete = true; break }
      if (seenChildren.size > total || seenChildren.size === before) { issue('INCOMPLETE_CHILD_PAGE'); break }
    }
    if (!complete) issue('CHILD_SCAN_INCOMPLETE')
    if (parentMatched) result.tasks.push({ task_id: taskId, status: parentStatus })
    else issue('TASK_CARD_UNKNOWN')
  }
  return finish()
}
