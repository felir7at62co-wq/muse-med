/** Additive project-sharing previews, guarded submissions and provider-visible readback. */
import { randomBytes } from 'node:crypto'
import { lstat, mkdir, open, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { JubianError, type JubianClient, type JubianLedger } from '@deepseek-ai/dsh-jubian'
import { buildProjectShareBatchRequest, buildProjectShareDepartmentsRequest, buildProjectSharePageRequest,
  buildProjectShareUsersRequest, readProjectShareDepartments, readProjectSharePage, readProjectShareUsers,
  stableSha256 } from '@deepseek-ai/dsh-jubian-api'
import type { ProjectShareDepartment, ProjectShareRecord, ProjectShareType, ProjectShareTargetType } from '@deepseek-ai/dsh-jubian-api'
import { projectOperation, projectOperationReceiptPath } from './project-operation.ts'
import { requireKey } from './write.ts'

/** Inputs for directory reads, visible shares, frozen previews and confirmed sharing. */
export interface ProjectShareArgs {
  method: 'share_targets' | 'shares' | 'share_preview' | 'share_apply'
  script_id?: number
  share_type?: ProjectShareType
  share_target_type?: ProjectShareTargetType
  user_ids?: number[]
  department_id?: number
  query?: string
  preview_id?: string
  preview_fingerprint?: string
  confirm?: boolean
  idempotency_key?: string
}

/** Deployment-resolved limits for bounded inventories, local previews and complete tool results. */
export interface ProjectShareOptions {
  pageSize: number
  pageLimit: number
  maxDirectoryItems: number
  maxPreviewBytes: number
  maxResultChars: number
}

type Row = Record<string, unknown>
interface Actor { id: number; name: string; canShare: boolean }
interface Target { id: number; name: string }
interface Preview {
  version: 1
  preview_id: string
  actor_id: number
  script_id: number
  share_type: ProjectShareType
  share_target_type: ProjectShareTargetType
  project: Row
  shares: Row[]
  requested_ids: number[]
  expected_ids: number[]
  additions: Target[]
  expected_targets: Target[]
  request_body: Row
  fingerprint: string
}
interface Guard { version: 1; key: string; preview_id: string; verified: boolean }

const LIMITATION = 'Records are those visible to the current provider account, not a proven global access list. Server behavior across other accounts is unverified; no atomic guarantee applies to concurrent changes from other clients.'
function invalid(detail: string): never { throw new JubianError('INVALID_ARGUMENT', detail) }
function changed(detail: string): never { throw new JubianError('CONTRACT_CHANGED', detail) }
function row(value: unknown): Row {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return changed('Expected a provider or preview object')
  return value as Row
}
function id(value: unknown): number {
  const parsed = typeof value === 'string' && /^[1-9][0-9]*$/u.test(value) ? Number(value) : value
  if (typeof parsed !== 'number' || !Number.isSafeInteger(parsed) || parsed < 1) return invalid('A positive exact ID is required')
  return parsed
}
function same(a: unknown, b: unknown): boolean { return stableSha256(a) === stableSha256(b) }
function sorted(values: number[]): number[] { return [...new Set(values)].sort((a, b) => a - b) }
function fingerprint(value: Omit<Preview, 'fingerprint'>): string { return stableSha256(value) }
function safeResult(value: Row, options: ProjectShareOptions): Row {
  if (JSON.stringify(value, null, 2).length > options.maxResultChars) return invalid('Sharing result exceeds the configured output limit; narrow the query')
  return value
}
async function request(client: JubianClient, path: string, signal?: AbortSignal): Promise<unknown> {
  return (await client.request({ method: 'GET', path, ...(signal === undefined ? {} : { signal }) })).data
}
async function actor(client: JubianClient, signal?: AbortSignal): Promise<Actor> {
  const info = row(await request(client, '/getInfo', signal)), user = row(info.user)
  if (typeof user.userName !== 'string' || !user.userName.trim() || !Array.isArray(info.permissions)
    || !info.permissions.every((permission): permission is string => typeof permission === 'string')) {
    return changed('Current provider account identity or permissions are unreadable')
  }
  return { id: id(user.userId), name: user.userName,
    canShare: info.permissions.includes('aigc:share:add') || info.permissions.includes('*:*:*') }
}
function authorize(account: Actor, project: Row): void {
  if (!account.canShare || !(project.canShare === 1 || project.canShare === '1')) {
    return invalid('Current account lacks explicit project-sharing permission or this project is not shareable')
  }
}
async function project(client: JubianClient, scriptId: number, options: ProjectShareOptions, signal?: AbortSignal): Promise<Row> {
  const found: Row[] = [], seen = new Set<number>()
  let total: number | undefined
  for (let page = 1; page <= options.pageLimit; page++) {
    const value = row(await request(client, `/aigc/script/list?pageNum=${page}&pageSize=${options.pageSize}`, signal))
    if (!Array.isArray(value.rows) || typeof value.total !== 'number' || !Number.isSafeInteger(value.total) || value.total < 0
      || (total !== undefined && total !== value.total)) return changed('Project inventory is incomplete or changed while being read')
    total = value.total
    for (const item of value.rows) {
      const current = row(item), currentId = id(current.id ?? current.scriptId)
      if (seen.has(currentId) || (current.id !== undefined && current.scriptId !== undefined && id(current.scriptId) !== currentId)) {
        return changed('Project inventory has duplicate or conflicting identities')
      }
      seen.add(currentId)
      if (currentId === scriptId) found.push(current)
    }
    if (seen.size > total || (!value.rows.length && seen.size !== total)) return changed('Project inventory total does not match its rows')
    if (seen.size === total) {
      const exact = found[0]
      if (found.length !== 1 || exact === undefined) return invalid('The exact project is not present in the current account inventory')
      return exact
    }
  }
  return changed('Project inventory exceeds configured scan limits')
}
async function shares(client: JubianClient, scriptId: number, options: ProjectShareOptions,
  signal?: AbortSignal): Promise<ProjectShareRecord[]> {
  const result: ProjectShareRecord[] = [], seen = new Set<string>()
  let total: number | undefined
  for (let page = 1; page <= options.pageLimit; page++) {
    const query = buildProjectSharePageRequest(scriptId, page, options.pageSize)
    const current = readProjectSharePage((await client.request({ ...query, ...(signal === undefined ? {} : { signal }) })).data)
    if (total !== undefined && total !== current.total) return changed('Visible share inventory changed during paging')
    total = current.total
    for (const item of current.rows) {
      if (item.script_id !== null && item.script_id !== scriptId) return changed('Sharing response belongs to a different project')
      const key = item.snapshot.id === undefined ? stableSha256(item.snapshot) : String(id(item.snapshot.id))
      if (seen.has(key)) return changed('Visible share inventory repeats a record across pages')
      seen.add(key)
      result.push(item)
    }
    if (result.length > total || (!current.rows.length && result.length !== total)) return changed('Visible share inventory is incomplete')
    if (result.length === total) return result
  }
  return changed('Visible share inventory exceeds configured scan limits')
}
function departments(rows: ProjectShareDepartment[], maximum: number): Target[] {
  const result: Target[] = []
  let count = 0
  const visit = (items: ProjectShareDepartment[], ancestorDisabled = false): void => {
    for (const item of items) {
      if (++count > maximum) return invalid('Department directory exceeds configured scan limits')
      const disabled = ancestorDisabled || item.disabled
      if (!disabled) result.push({ id: item.department_id, name: item.name })
      visit(item.children, disabled)
    }
  }
  visit(rows)
  return result
}
async function targets(client: JubianClient, kind: ProjectShareType, options: ProjectShareOptions,
  signal?: AbortSignal): Promise<Target[]> {
  const query = kind === 2 ? buildProjectShareUsersRequest() : buildProjectShareDepartmentsRequest()
  const data = (await client.request({ ...query, ...(signal === undefined ? {} : { signal }) })).data
  const result = kind === 2 ? readProjectShareUsers(data).map(item => ({ id: item.user_id, name: item.name }))
    : departments(readProjectShareDepartments(data), options.maxDirectoryItems)
  if (result.length > options.maxDirectoryItems || new Set(result.map(item => item.id)).size !== result.length) {
    return changed('Sharing directory is too large or contains ambiguous identities')
  }
  return result
}
function select(args: ProjectShareArgs): { kind: ProjectShareType; target: ProjectShareTargetType; ids: number[] } {
  if ((args.share_type !== 1 && args.share_type !== 2) || (args.share_target_type !== 1 && args.share_target_type !== 2)) {
    return invalid('Preview requires explicit share_type and share_target_type; neither is an editing-permission level')
  }
  if (args.share_type === 2) {
    if (args.department_id !== undefined || !args.user_ids?.length) return invalid('User sharing requires user_ids without department_id')
    return { kind: 2, target: args.share_target_type, ids: sorted(args.user_ids.map(id)) }
  }
  if (args.user_ids !== undefined) return invalid('Department sharing requires only department_id')
  return { kind: 1, target: args.share_target_type, ids: [id(args.department_id)] }
}
function existingIds(records: ProjectShareRecord[], kind: ProjectShareType, target: ProjectShareTargetType): number[] {
  if (records.some(item => item.share_type !== kind || item.share_target_type !== target)) {
    return invalid('Existing shares include another type or target. Their preservation is unverified; no sharing request is allowed')
  }
  const ids = records.map(item => id(kind === 2 ? item.user_id : item.department_id))
  if (new Set(ids).size !== ids.length) return changed('Existing share recipients have ambiguous duplicate records')
  return sorted(ids)
}
async function makePreview(client: JubianClient, account: Actor, args: ProjectShareArgs, options: ProjectShareOptions,
  signal?: AbortSignal): Promise<Preview> {
  const scriptId = id(args.script_id), selected = select(args)
  const source = await project(client, scriptId, options, signal)
  authorize(account, source)
  const baseline = await shares(client, scriptId, options, signal)
  const before = existingIds(baseline, selected.kind, selected.target)
  const expected = sorted([...before, ...selected.ids])
  if (selected.kind === 1 && expected.length !== 1) return invalid('A single-department form cannot preserve several departments; no sharing request is allowed')
  const directory = await targets(client, selected.kind, options, signal)
  const expectedTargets = expected.map((recipient) => {
    const match = directory.find(item => item.id === recipient)
    if (!match) return invalid('A requested or existing recipient is absent from the current sharing directory')
    return match
  })
  const query = buildProjectShareBatchRequest({ scriptId, project: source, shareType: selected.kind, shareTargetType: selected.target,
    ...(selected.kind === 2 ? { userIds: expected } : { departmentId: id(expected[0]) }) })
  if (query.body === undefined) return changed('Sharing request has no checked body')
  const value: Omit<Preview, 'fingerprint'> = { version: 1, preview_id: randomBytes(24).toString('hex'), actor_id: account.id,
    script_id: scriptId, share_type: selected.kind, share_target_type: selected.target, project: source,
    shares: baseline.map(item => item.snapshot), requested_ids: selected.ids, expected_ids: expected,
    additions: expectedTargets.filter(item => !before.includes(item.id)), expected_targets: expectedTargets, request_body: query.body }
  return { ...value, fingerprint: fingerprint(value) }
}
function previewPath(ledger: JubianLedger, previewId: string): string {
  if (!/^[a-f0-9]{48}$/u.test(previewId)) return invalid('preview_id is not a tool-issued identifier')
  return join(ledger.root, 'share-previews', `${previewId}.json`)
}
async function readPreview(ledger: JubianLedger, args: ProjectShareArgs, options: ProjectShareOptions): Promise<Preview> {
  const path = previewPath(ledger, args.preview_id ?? '')
  const entry = await lstat(path)
  if (!entry.isFile() || entry.isSymbolicLink() || entry.size > options.maxPreviewBytes) return changed('Sharing preview is not a bounded regular file')
  const handle = await open(path, 'r')
  let text: string
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size > options.maxPreviewBytes) return changed('Sharing preview exceeds its configured limit')
    const buffer = Buffer.alloc(info.size + 1)
    const read = await handle.read(buffer, 0, buffer.length, 0)
    if (read.bytesRead !== info.size) return changed('Sharing preview changed while being read')
    text = buffer.subarray(0, read.bytesRead).toString('utf8')
  } finally { await handle.close() }
  const value: unknown = JSON.parse(text)
  const parsed = row(value), savedFingerprint = parsed.fingerprint
  const { fingerprint: _fingerprint, ...body } = parsed
  if (parsed.version !== 1 || parsed.preview_id !== args.preview_id || typeof savedFingerprint !== 'string'
    || savedFingerprint !== args.preview_fingerprint || savedFingerprint !== stableSha256(body)
    || !Array.isArray(parsed.expected_ids) || !Array.isArray(parsed.requested_ids) || !Array.isArray(parsed.shares)
    || !Array.isArray(parsed.additions) || !Array.isArray(parsed.expected_targets)) return changed('Sharing preview fingerprint or fields do not match')
  const kind = parsed.share_type, target = parsed.share_target_type
  if ((kind !== 1 && kind !== 2) || (target !== 1 && target !== 2)) return changed('Sharing preview has unknown destination codes')
  const expectedTargets = parsed.expected_targets.map((item) => {
    const target = row(item)
    if (typeof target.name !== 'string' || !target.name.trim()) return changed('Sharing preview recipient name is unreadable')
    return { id: id(target.id), name: target.name }
  })
  const additions = parsed.additions.map(item => id(row(item).id))
  return { version: 1, preview_id: String(parsed.preview_id), actor_id: id(parsed.actor_id), script_id: id(parsed.script_id),
    share_type: kind, share_target_type: target, project: row(parsed.project), shares: parsed.shares.map(row),
    expected_ids: parsed.expected_ids.map(id), requested_ids: parsed.requested_ids.map(id),
    expected_targets: expectedTargets, additions: expectedTargets.filter(item => additions.includes(item.id)),
    request_body: row(parsed.request_body), fingerprint: savedFingerprint }
}
async function saveGuard(path: string, guard: Guard): Promise<void> {
  await writeFileAtomic(path, `${JSON.stringify(guard)}\n`, { mode: 0o600, dirMode: 0o700 })
}
async function guardAt(path: string): Promise<Guard | null> {
  let text: string
  try { text = await readFile(path, 'utf8') }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null
    throw error
  }
  const value = row(JSON.parse(text))
  if (value.version !== 1 || typeof value.key !== 'string' || typeof value.preview_id !== 'string'
    || typeof value.verified !== 'boolean') return changed('Sharing operation guard is unreadable')
  return { version: 1, key: value.key, preview_id: value.preview_id, verified: value.verified }
}
async function apply(client: JubianClient, ledger: JubianLedger, args: ProjectShareArgs, options: ProjectShareOptions,
  account: Actor, signal?: AbortSignal): Promise<Row> {
  const key = requireKey(args.idempotency_key)
  if (args.confirm !== true) return invalid('share_apply requires explicit confirmation of its exact preview')
  const preview = await readPreview(ledger, args, options)
  if (preview.actor_id !== account.id || (args.script_id !== undefined && id(args.script_id) !== preview.script_id)) {
    return invalid('Sharing preview belongs to a different account or project')
  }
  const recovery = { method: args.method, script_id: preview.script_id, actor_id: account.id,
    original_idempotency_key: key, preview_id: preview.preview_id, receipt_path: projectOperationReceiptPath(ledger, key),
    scope: 'provider_visible', global_access_verified: false, result_details_omitted: true,
    explanation: 'Long provider details were omitted. Keep this original key and receipt; readback describes only provider-visible sharing.' }
  safeResult({ ...recovery, status: 'accepted_unverified', outcome: 'accepted', replayed: false,
    receipt_status: 'recorded', settlement_pending: false, readback: { status: 'unavailable' } }, options)
  const directory = join(ledger.root, 'share-operation-guards')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const path = join(directory, `${account.id}-${preview.script_id}.json`)
  return await withFileLock(path, async () => {
    const prior = await guardAt(path)
    if (prior !== null && prior.key !== key && !prior.verified) {
      return invalid(`A prior sharing result is unresolved. Query original idempotency_key ${JSON.stringify(prior.key)}; do not submit another key`)
    }
    const checkedRequest = async () => {
      const currentAccount = await actor(client, signal)
      if (currentAccount.id !== account.id) return changed('Provider account changed before sharing')
      const current = await project(client, preview.script_id, options, signal)
      authorize(currentAccount, current)
      const currentShares = await shares(client, preview.script_id, options, signal)
      if (!same(current, preview.project) || !same(currentShares.map(item => item.snapshot), preview.shares)) {
        return changed('Project or sharing state changed after preview. Create and confirm a new preview')
      }
      const before = existingIds(currentShares, preview.share_type, preview.share_target_type)
      if (!same(sorted([...before, ...preview.requested_ids]), preview.expected_ids)
        || (preview.share_type === 1 && preview.expected_ids.length !== 1)) {
        return changed('Sharing preview does not preserve the existing recipients')
      }
      const currentTargets = await targets(client, preview.share_type, options, signal)
      if (!same(sorted(preview.expected_targets.map(item => item.id)), preview.expected_ids)) {
        return changed('Sharing preview recipient identities do not match its checked request')
      }
      for (const target of preview.expected_targets) {
        if (!currentTargets.some(item => item.id === target.id && item.name === target.name)) return changed('Recipient identity changed after preview')
      }
      const checked = buildProjectShareBatchRequest({ scriptId: preview.script_id, project: current,
        shareType: preview.share_type, shareTargetType: preview.share_target_type,
        ...(preview.share_type === 2 ? { userIds: preview.expected_ids } : { departmentId: id(preview.expected_ids[0]) }) })
      if (!same(checked.body, preview.request_body)) return changed('Sharing preview request no longer matches current provider fields')
      return checked
    }
    if (!preview.additions.length) {
      await checkedRequest()
      return safeResult({ method: args.method, script_id: preview.script_id, actor_id: account.id,
        status: 'already_shared', no_changes: true, submitted: false, scope: 'provider_visible',
        global_access_verified: false, limitation: LIMITATION }, options)
    }
    const result = await projectOperation(client, ledger, { key, method: 'project_share', scriptId: preview.script_id,
      intent: { actor_id: account.id, preview_id: preview.preview_id, fingerprint: preview.fingerprint },
      prepare: async () => {
        const checked = await checkedRequest()
        await saveGuard(path, { version: 1, key, preview_id: preview.preview_id, verified: false })
        return { ...checked, ...(signal === undefined ? {} : { signal }) }
      } })
    let readback: Row
    try {
      const current = await shares(client, preview.script_id, options, signal)
      const observed = existingIds(current, preview.share_type, preview.share_target_type)
      const verified = same(observed, preview.expected_ids)
      readback = { status: verified ? 'verified' : 'unverified', expected_ids: preview.expected_ids, observed_ids: observed,
        scope: 'provider_visible', global_access_verified: false }
      if (verified && result.outcome === 'accepted' && (prior === null || prior.key === key || prior.verified)) {
        const latest = await guardAt(path)
        if (latest?.key === key) await saveGuard(path, { ...latest, verified: true })
      }
    } catch (error) {
      readback = { status: 'unavailable', reason: error instanceof JubianError ? error.message : 'Sharing readback failed',
        scope: 'provider_visible', global_access_verified: false }
    }
    const output = { ...result, method: args.method, script_id: preview.script_id, actor_id: account.id,
      original_idempotency_key: key, preview_id: preview.preview_id,
      status: result.outcome === 'accepted' && readback.status === 'verified' ? 'accepted_verified'
        : result.outcome === 'accepted' ? 'accepted_unverified' : 'unknown', readback,
      scope: 'provider_visible', global_access_verified: false, limitation: LIMITATION }
    if (JSON.stringify(output, null, 2).length <= options.maxResultChars) return output
    return safeResult({ ...recovery, status: output.status, outcome: result.outcome, replayed: result.replayed,
      receipt_status: result.receipt_status, settlement_pending: result.settlement_pending === true,
      readback: { status: readback.status } }, options)
  })
}

/**
 * Read visible sharing data, prepare an additive preview or submit its confirmed request once.
 * @param client - Live credential client; one private credential snapshot is used for this complete invocation.
 * @param ledger - Local write ledger and private preview/operation stores.
 * @param args - Exact project, real directory IDs, preview identity and confirmed original key.
 * @param options - Explicit deployment inventory and output limits.
 * @param signal - Optional cancellation for provider reads and the sharing submission.
 * @returns Scoped observations or separate submission and readback evidence, never a global access guarantee.
 */
export async function projectShareMethod(client: JubianClient, ledger: JubianLedger, args: ProjectShareArgs,
  options: ProjectShareOptions, signal?: AbortSignal): Promise<Row> {
  const pinned = await client.snapshotCredential(), account = await actor(pinned, signal)
  if (args.method === 'share_targets') {
    const kinds = args.share_type === undefined ? [1, 2] as const : [args.share_type]
    const result: Row = { method: args.method, actor_id: account.id, share_types: { 1: 'department', 2: 'user' },
      share_target_types: { 1: 'comic_drama_video', 2: 'canvas' }, editing_permissions: 'not_expressed_by_these_codes' }
    for (const kind of kinds) {
      let choices = await targets(pinned, kind, options, signal)
      if (args.query !== undefined) {
        if (!args.query.trim()) return invalid('query must contain a recipient name')
        const query = args.query.trim().toLocaleLowerCase()
        choices = choices.filter(item => item.name.toLocaleLowerCase().includes(query))
      }
      result[kind === 1 ? 'departments' : 'users'] = choices
    }
    return safeResult(result, options)
  }
  if (args.method === 'shares') {
    const scriptId = id(args.script_id)
    await project(pinned, scriptId, options, signal)
    const current = await shares(pinned, scriptId, options, signal)
    return safeResult({ method: args.method, script_id: scriptId, actor_id: account.id, scope: 'provider_visible', complete: true,
      global_access_verified: false, rows: current.map(({ snapshot: _snapshot, ...fields }) => fields), limitation: LIMITATION }, options)
  }
  if (args.method === 'share_apply') return await apply(pinned, ledger, args, options, account, signal)
  const preview = await makePreview(pinned, account, args, options, signal)
  if (Buffer.byteLength(JSON.stringify(preview)) > options.maxPreviewBytes) return invalid('Sharing preview exceeds configured byte limit')
  const path = previewPath(ledger, preview.preview_id)
  await writeFileAtomic(path, `${JSON.stringify(preview)}\n`, { mode: 0o600, dirMode: 0o700 })
  return safeResult({ method: args.method, preview_id: preview.preview_id, preview_fingerprint: preview.fingerprint,
    actor_id: account.id, script_id: preview.script_id, share_type: preview.share_type, share_target_type: preview.share_target_type,
    additions: preview.additions, preserved_and_expected: preview.expected_targets, no_changes: !preview.additions.length,
    scope: 'provider_visible', global_access_verified: false, confirmation_required: true, limitation: LIMITATION }, options)
}
