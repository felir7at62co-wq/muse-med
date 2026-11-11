/** Project-sharing requests and strict readers for the public workbench's recipient directories. */
import { JubianError, type JubianRequest } from '@deepseek-ai/dsh-jubian'
import { readPayload } from './reading.ts'
import { invalid, wireObject, wirePositiveId } from './wire.ts'

/** Recipient mode: one department or selected individual users. */
export type ProjectShareType = 1 | 2
/** Project category: comic-drama video or canvas. */
export type ProjectShareTargetType = 1 | 2

/** One provider-visible sharing record; its snapshot retains unprojected provider fields. */
export interface ProjectShareRecord {
  share_type: ProjectShareType
  share_target_type: ProjectShareTargetType
  user_id: number | null
  department_id: number | null
  script_id: number | null
  snapshot: Record<string, unknown>
}

/** One candidate user, identified by the provider's numeric user ID rather than a display name. */
export interface ProjectShareUser {
  user_id: number
  name: string
  snapshot: Record<string, unknown>
}

/** One fully loaded department-tree node with its provider selection state. */
export interface ProjectShareDepartment {
  department_id: number
  name: string
  disabled: boolean
  children: ProjectShareDepartment[]
  snapshot: Record<string, unknown>
}

/** A management-page response; total describes only the provider-visible query scope. */
export interface ProjectSharePage {
  rows: ProjectShareRecord[]
  total: number
}

/** Explicit sharing fields override any stale sharing fields in the original project row. */
export interface ProjectShareBatchInput {
  scriptId: number
  project: Record<string, unknown>
  shareType: ProjectShareType
  shareTargetType: ProjectShareTargetType
  userIds?: readonly number[]
  departmentId?: number | null
}

function argument(field: string): never { throw new JubianError('INVALID_ARGUMENT', field) }

function positive(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) argument(field)
  return value
}

function selectedMode<T extends number>(value: T, choices: readonly T[], field: string): T {
  if (!choices.includes(value)) argument(field)
  return value
}

function readMode(value: unknown): 1 | 2 {
  const mode = wirePositiveId(value)
  if (mode !== 1 && mode !== 2) invalid()
  return mode
}

function optionalId(value: unknown): number | null {
  return value === undefined || value === null || value === 0 || value === '0' ? null : wirePositiveId(value)
}

function label(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) invalid()
  return value
}

function count(value: unknown): number {
  const candidate = typeof value === 'string' && /^(0|[1-9][0-9]*)$/u.test(value) ? Number(value) : value
  if (typeof candidate !== 'number' || !Number.isSafeInteger(candidate) || candidate < 0) invalid()
  return candidate
}

function records(value: unknown): ProjectShareRecord[] {
  if (!Array.isArray(value)) invalid()
  return value.map((entry) => {
    const row = wireObject(entry)
    const shareType = readMode(row.shareType)
    const userId = optionalId(row.shareUserId)
    const departmentId = optionalId(row.shareDeptId)
    if (shareType === 1 ? departmentId === null || userId !== null : userId === null || departmentId !== null) invalid()
    return { share_type: shareType, share_target_type: readMode(row.shareTargetType),
      user_id: userId, department_id: departmentId,
      script_id: row.scriptId === undefined ? null : wirePositiveId(row.scriptId), snapshot: structuredClone(row) }
  })
}

/**
 * Build the sharing dialog's creator-filtered record lookup.
 * @param scriptId - Exact production-project ID.
 * @returns The current frontend's mineOnly request, which does not establish a complete project ACL.
 */
export function buildProjectShareListRequest(scriptId: number): JubianRequest {
  return { method: 'GET', path: `/aigc/share/list?scriptId=${positive(scriptId, 'scriptId')}&mineOnly=true` }
}

/**
 * Read the sharing dialog's rows, refusing a stated total that reveals truncation or inconsistency.
 * @param data - Normalized envelope containing rows and an optional total.
 * @returns Every returned record without filtering; absence of total does not imply project-wide completeness.
 */
export function readProjectShareList(data: unknown): ProjectShareRecord[] {
  return readPayload('readProjectShareList', data, () => {
    const payload = wireObject(data)
    const rows = records(payload.rows)
    if (payload.total !== undefined && count(payload.total) !== rows.length) invalid()
    return rows
  })
}

/**
 * Build one management-page share query without the dialog's mineOnly filter.
 * @param scriptId - Exact production-project ID.
 * @param pageNum - One-based requested page.
 * @param pageSize - Explicit records per page.
 * @returns The provider-visible management request; no account-wide visibility is inferred.
 */
export function buildProjectSharePageRequest(scriptId: number, pageNum: number, pageSize: number): JubianRequest {
  return { method: 'GET', path: `/aigc/share/list?pageNum=${positive(pageNum, 'pageNum')}`
    + `&pageSize=${positive(pageSize, 'pageSize')}&scriptId=${positive(scriptId, 'scriptId')}` }
}

/**
 * Read one management page with its required nonnegative total.
 * @param data - Normalized rows/total envelope.
 * @returns Every page row and its provider-visible total, without asserting all pages were read.
 */
export function readProjectSharePage(data: unknown): ProjectSharePage {
  return readPayload('readProjectSharePage', data, () => {
    const payload = wireObject(data)
    const rows = records(payload.rows)
    const total = count(payload.total)
    if (total < rows.length) invalid()
    return { rows, total }
  })
}

/**
 * Build the user selector's directory request.
 * @returns The explicit project-share user category, without a display-name query filter.
 */
export function buildProjectShareUsersRequest(): JubianRequest {
  return { method: 'GET', path: '/system/user/getSelectUserList?dataType=3' }
}

/**
 * Read candidate users without guessing account-name fields or dropping malformed records.
 * @param data - User-selector envelope data array.
 * @returns Numeric identities and original nonblank display names; duplicate identities are refused.
 */
export function readProjectShareUsers(data: unknown): ProjectShareUser[] {
  return readPayload('readProjectShareUsers', data, () => {
    if (!Array.isArray(data)) invalid()
    const identities = new Set<number>()
    return data.map((entry) => {
      const row = wireObject(entry)
      const id = wirePositiveId(row.userId)
      if (identities.has(id)) invalid()
      identities.add(id)
      return { user_id: id, name: label(row.nickName), snapshot: structuredClone(row) }
    })
  })
}

/**
 * Build the department selector's tree request.
 * @returns The frontend's unfiltered department-sharing directory lookup.
 */
export function buildProjectShareDepartmentsRequest(): JubianRequest {
  return { method: 'GET', path: '/system/user/shareList' }
}

/**
 * Read fully loaded id/label/children departments used by the unmodified TreeSelect normalizer.
 * @param data - Department-selector envelope data array.
 * @returns The complete returned tree with disabled flags; lazy null children and duplicate IDs are refused.
 */
export function readProjectShareDepartments(data: unknown): ProjectShareDepartment[] {
  return readPayload('readProjectShareDepartments', data, () => {
    const identities = new Set<number>()
    const level = (value: unknown): ProjectShareDepartment[] => {
      if (!Array.isArray(value)) invalid()
      return value.map((entry) => {
        const row = wireObject(entry)
        const id = wirePositiveId(row.id)
        if (identities.has(id)) invalid()
        identities.add(id)
        if (row.isDisabled !== undefined && typeof row.isDisabled !== 'boolean') invalid()
        return { department_id: id, name: label(row.label), disabled: row.isDisabled === true,
          children: row.children === undefined ? [] : level(row.children), snapshot: structuredClone(row) }
      })
    }
    return level(data)
  })
}

/**
 * Build one explicit sharing submission while retaining the original project-row fields.
 * @param input - Exact project, recipient type and complete selected recipients for this submission.
 * @returns The batchAddShare request; this builder does not establish append or replacement semantics.
 */
export function buildProjectShareBatchRequest(input: ProjectShareBatchInput): JubianRequest {
  const scriptId = positive(input.scriptId, 'scriptId')
  const shareType = selectedMode(input.shareType, [1, 2], 'shareType')
  const shareTargetType = selectedMode(input.shareTargetType, [1, 2], 'shareTargetType')
  const project = wireObject(input.project)
  const fields = ['id', 'scriptId', 'script_id'].filter(field => project[field] !== undefined)
  if (!fields.length || fields.some(field => wirePositiveId(project[field]) !== scriptId)) {
    argument('Original project identity does not match scriptId')
  }
  let departmentId: number | null = null
  let userIds: number[] | null = null
  if (shareType === 1) {
    if (input.departmentId === undefined || input.departmentId === null) argument('departmentId')
    departmentId = positive(input.departmentId, 'departmentId')
    if (input.userIds !== undefined && input.userIds.length) argument('Department shares cannot carry userIds')
  } else {
    if (input.departmentId !== undefined && input.departmentId !== null) argument('User shares cannot carry departmentId')
    if (input.userIds === undefined || !input.userIds.length) argument('userIds')
    userIds = input.userIds.map(id => positive(id, 'userIds'))
    if (new Set(userIds).size !== userIds.length) argument('Duplicate userIds')
  }
  return { method: 'POST', path: '/aigc/share/batchAddShare', body: { ...structuredClone(project),
    scriptId, shareDeptId: departmentId, userIdList: userIds, shareType, shareTargetType } }
}
