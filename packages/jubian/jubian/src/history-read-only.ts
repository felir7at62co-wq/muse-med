/** Request forms used to recover existing footage in the isolated historical replay. */
import type { JubianRequest } from './client.ts'
import { JubianError } from './error.ts'

const IDS = /^[1-9]\d*$/u
const DETAIL = /^(?:\/aigc\/(?:script|episode|storyboard|asset|storyboard\/byStoryboard)|\/admin\/aigc\/video\/task)\/([1-9]\d*)$/u
const PROJECT_LIST = /^\/aigc\/(episode|storyboard|asset|material)\/list$/u
const TASK_LIST = '/admin/aigc/video/task/list'
const SUBTASK_LIST = '/admin/aigc/video/task/sub/list'

/**
 * Read the launcher-selected request policy for historical replay.
 * @returns Whether this process permits only the known historical queries.
 */
export function jubianHistoryReadOnly(): boolean {
  return process.env.MUSE_JUBIAN_HISTORY_READ_ONLY === '1'
}

/**
 * Reject a request disallowed during historical replay.
 * @returns Never. Throws a local permission error without provider details.
 */
export function refuseJubianHistoryRequest(): never {
  throw new JubianError('PERMISSION_DENIED', '历史素材只读验证仅允许明确核对过的查询，当前请求没有发送')
}

function positive(value: string | null | undefined): value is string {
  return typeof value === 'string' && IDS.test(value) && Number.isSafeInteger(Number(value))
}

function hasOnly(query: URLSearchParams, keys: readonly string[]): boolean {
  return query.size === new Set(query.keys()).size && [...query.keys()].every(key => keys.includes(key))
}

function page(query: URLSearchParams, optional = false): boolean {
  const number = query.get('pageNum'), size = query.get('pageSize')
  if (optional && number === null && size === null) return true
  return positive(number) && positive(size) && Number(size) <= 1000
}

function order(query: URLSearchParams): boolean {
  const column = query.get('orderByColumn'), direction = query.get('orderBy')
  return (column === null && direction === null) || (column === 'createTime' && direction === 'desc')
}

function projectList(path: string, query: URLSearchParams): boolean {
  const common = ['scriptId', 'pageNum', 'pageSize']
  if (!positive(query.get('scriptId')) || !page(query)) return false
  if (path === '/aigc/material/list') {
    return hasOnly(query, [...common, 'isUsed', 'pageNumber'])
      && (!query.has('isUsed') || query.get('isUsed') === '1')
      && (!query.has('pageNumber') || query.get('pageNumber') === query.get('pageNum'))
  }
  if (path === '/aigc/asset/list') {
    return hasOnly(query, [...common, 'assetType', 'isParent'])
      && (!query.has('assetType') || query.get('assetType') === '4')
      && (!query.has('isParent') || query.get('isParent') === '1')
  }
  return hasOnly(query, common)
}

function knownGet(path: string, query: URLSearchParams): boolean {
  if (path === '/getInfo') return query.size === 0
  if (path === '/aigc/script/list') return query.size === 2 && query.get('pageNum') === '1' && query.get('pageSize') === '1'
  const detail = DETAIL.exec(path)
  if (detail !== null) return query.size === 0 && positive(detail[1])
  if (PROJECT_LIST.test(path)) return projectList(path, query)
  if (path === TASK_LIST) {
    return hasOnly(query, ['scriptId', 'taskType', 'pageNum', 'pageSize', 'orderByColumn', 'orderBy'])
      && positive(query.get('scriptId')) && page(query) && order(query)
      && (!query.has('taskType') || positive(query.get('taskType')))
  }
  if (path === '/model/charge/getSelectList') return query.size === 1 && query.get('taskType') === '1'
  if (path === '/aigc/material/selectNoPage') {
    return hasOnly(query, ['scriptId', 'assetId']) && positive(query.get('scriptId')) && positive(query.get('assetId'))
  }
  if (path === '/aigc/material/getGeneratedImageByAssetId') return query.size === 1 && positive(query.get('assetId'))
  return false
}

/**
 * Validate and retain the exact request values before an asynchronous credential lookup.
 * @param request - Original method, path, body and cancellation signal.
 * @returns A detached allowed historical query ready for credential lookup and dispatch.
 */
export function historicalJubianRequest(request: JubianRequest): JubianRequest {
  const { method, path, signal } = request
  const body: unknown = request.body
  // Match the raw route sent to the provider. URL normalization would accept aliases and encoded traversal.
  if (typeof path !== 'string' || !path.startsWith('/') || /[^A-Za-z0-9/?=&]/u.test(path) || path.endsWith('?')) {
    return refuseJubianHistoryRequest()
  }
  const [route, parameters = '', extra] = path.split('?')
  if (route === undefined || extra !== undefined
    || (parameters !== '' && !/^[A-Za-z0-9]+=[A-Za-z0-9]+(?:&[A-Za-z0-9]+=[A-Za-z0-9]+)*$/u.test(parameters))) {
    return refuseJubianHistoryRequest()
  }
  const query = new URLSearchParams(parameters)
  const cancellation = signal === undefined ? {} : { signal }
  if (method === 'GET' && body === undefined && knownGet(route, query)) {
    return { method, path, ...cancellation }
  }
  if (method === 'POST' && route === SUBTASK_LIST && hasOnly(query, ['pageNum', 'pageSize', 'orderByColumn', 'orderBy'])
    && page(query, true) && order(query) && typeof body === 'object' && body !== null && !Array.isArray(body)
    && Object.keys(body).length === 1 && Object.hasOwn(body, 'aigcVideoTaskId')) {
    const id = (body as Record<string, unknown>).aigcVideoTaskId
    if ((typeof id === 'number' && Number.isSafeInteger(id) && id > 0) || (typeof id === 'string' && positive(id))) {
      return { method, path, body: { aigcVideoTaskId: id }, ...cancellation }
    }
  }
  return refuseJubianHistoryRequest()
}
