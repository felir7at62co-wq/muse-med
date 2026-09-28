/** Account-scoped screenplay pool inspection, one-shot claims and bounded snatch jobs. */
import { setTimeout as delay } from 'node:timers/promises'
import type { JubianClient, JubianLedger } from '@deepseek-ai/dsh-jubian'
import { JubianError } from '@deepseek-ai/dsh-jubian'
import { readScriptList } from '@deepseek-ai/dsh-jubian-api'
import type { ScriptRow } from '@deepseek-ai/dsh-jubian-api'
import type { JobHooks, JobOutcome } from '@deepseek-ai/dsh-jobs'
import { bodyHash, requireKey } from './write.ts'

declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap { jubianClaim: 'jubianClaim' }
}

/** Deployment bounds on the account pool watcher. */
export interface ClaimWatchConfig {
  claimPollIntervalMs: number
  claimMaxWindowMs: number
  claimMaxLeadMs: number
  claimScanPageSize: number
  claimScanPageLimit: number
  claimMaxItems: number
}

/**
 * Resolve bounded watcher settings at plugin mount.
 * @param config - Deployment-provided limits.
 * @returns Validated polling, window, scan and claim limits.
 */
export function resolveClaimWatchConfig(config: Partial<ClaimWatchConfig>): ClaimWatchConfig {
  const resolved = {
    claimPollIntervalMs: config.claimPollIntervalMs ?? 5000,
    claimMaxWindowMs: config.claimMaxWindowMs ?? 7200000,
    claimMaxLeadMs: config.claimMaxLeadMs ?? 86400000,
    claimScanPageSize: config.claimScanPageSize ?? 300,
    claimScanPageLimit: config.claimScanPageLimit ?? 50,
    claimMaxItems: config.claimMaxItems ?? 100,
  }
  for (const [key, lower, upper] of [
    ['claimPollIntervalMs', 1000, 60000], ['claimMaxWindowMs', 1000, 86400000],
    ['claimMaxLeadMs', 1000, 604800000], ['claimScanPageSize', 1, 1000],
    ['claimScanPageLimit', 1, 100], ['claimMaxItems', 1, 100],
  ] as const) {
    if (!Number.isSafeInteger(resolved[key]) || resolved[key] < lower || resolved[key] > upper) {
      throw new TypeError(`${key} must be an integer within ${lower}..${upper}`)
    }
  }
  return resolved
}

/** One immediate account-pool call. */
export interface ClaimArgs {
  method: 'inspect' | 'claim'
  script_id: number
  idempotency_key?: string
  authorization_basis?: string
}

/** One explicitly scoped and timed watcher. */
export interface ClaimWatchArgs {
  scope: 'ids' | 'new_claimable'
  script_ids?: number[]
  start_at: string
  end_at: string
  idempotency_prefix: string
  authorization_basis: string
}

function positiveId(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new JubianError('INVALID_ARGUMENT', name)
  return value
}

function authorization(value: string | undefined): void {
  if (typeof value !== 'string' || !value.trim() || value.length > 500) {
    throw new JubianError('INVALID_ARGUMENT', 'authorization_basis')
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined
}

async function account(client: JubianClient, signal?: AbortSignal): Promise<{ id: number; name: string }> {
  const response = await client.request({ method: 'GET', path: '/getInfo',
    ...(signal === undefined ? {} : { signal }) })
  const user = record(record(response.data)?.user)
  const id = user?.userId
  const name = user?.userName
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1 || typeof name !== 'string' || !name.trim()) {
    throw new JubianError('CONTRACT_CHANGED', 'getInfo did not identify the claiming account')
  }
  return { id, name }
}

async function role(client: JubianClient, signal?: AbortSignal): Promise<'leader' | 'member'> {
  const response = await client.request({ method: 'GET', path: '/script/center/pool/viewRole',
    ...(signal === undefined ? {} : { signal }) })
  const value = response.data
  if (value === 'prodlead') return 'leader'
  if (typeof value === 'string' && /^(?:prodmember|member|producer|operator)(?:[_-].*)?$/u.test(value)) return 'member'
  throw new JubianError('CONTRACT_CHANGED', 'viewRole is not a verified leader/member role')
}

async function pool(client: JubianClient, config: ClaimWatchConfig, signal?: AbortSignal): Promise<ScriptRow[]> {
  const rows: ScriptRow[] = []
  const seen = new Set<number>()
  let expectedTotal: number | undefined
  for (let page = 1; page <= config.claimScanPageLimit; page++) {
    const response = await client.request({ method: 'GET',
      path: `/script/center/pool/list?pageNum=${page}&pageSize=${config.claimScanPageSize}`,
      ...(signal === undefined ? {} : { signal }) })
    const current = readScriptList(response.data)
    if (expectedTotal !== undefined && current.total !== expectedTotal) {
      throw new JubianError('CONTRACT_CHANGED', 'pool size changed during this scan; retry the read')
    }
    expectedTotal = current.total
    for (const row of current.rows) {
      if (seen.has(row.script_id)) throw new JubianError('CONTRACT_CHANGED', 'pool repeated an ID across pages')
      seen.add(row.script_id)
      rows.push(row)
    }
    if (rows.length >= current.total) return rows
    if (!current.rows.length) break
  }
  throw new JubianError('CONTRACT_CHANGED', 'pool scan ended before its reported total')
}

function changingPool(error: unknown): boolean {
  return error instanceof JubianError && error.code === 'CONTRACT_CHANGED'
    && (error.detail === 'pool size changed during this scan; retry the read'
      || error.detail === 'pool repeated an ID across pages')
}

async function stablePool(client: JubianClient, config: ClaimWatchConfig, signal: AbortSignal): Promise<ScriptRow[]> {
  for (;;) {
    signal.throwIfAborted()
    try { return await pool(client, config, signal) }
    catch (error) {
      signal.throwIfAborted()
      if (!changingPool(error)) throw error
      await delay(config.claimPollIntervalMs, undefined, { signal })
    }
  }
}

async function readback(client: JubianClient, config: ClaimWatchConfig, scriptId: number,
  actorId: number, path: 'leader' | 'member', accepted: boolean): Promise<'verified' | 'accepted_unverified' | 'unverified'> {
  try {
    const row = (await pool(client, config)).find(item => item.script_id === scriptId)
    if (row?.status !== 'returned' && row?.can_claim === false
      && (path === 'leader' ? row.claim_leader_id : row.claim_member_id) === actorId) return 'verified'
  } catch (error) {
    // Readback can fail after the write. Keep its result uncertain and never send another POST.
    void error
  }
  return accepted ? 'accepted_unverified' : 'unverified'
}

/**
 * Inspect or submit one user-authorized screenplay ID using the current account.
 * @param client - Authenticated provider transport.
 * @param ledger - Persistent write ledger for one Muse installation.
 * @param args - ID, operation and explicit authorization fields.
 * @param config - Validated pool scan limits.
 * @param signal - Optional claim-window cancellation; a manual claim omits it.
 * @returns Account-scoped inspection or a readback-qualified claim outcome.
 */
export async function claimMethod(client: JubianClient, ledger: JubianLedger, args: ClaimArgs,
  config: ClaimWatchConfig, signal?: AbortSignal): Promise<Record<string, unknown>> {
  signal?.throwIfAborted()
  const scriptId = positiveId(args.script_id, 'script_id')
  const method: string = args.method
  if (method !== 'inspect' && method !== 'claim') throw new JubianError('INVALID_ARGUMENT', 'method')
  if (args.method === 'claim') authorization(args.authorization_basis)
  const actor = await account(client, signal)
  const claimRole = await role(client, signal)
  if (args.method === 'inspect') {
    const item = (await pool(client, config, signal)).find(row => row.script_id === scriptId)
    return { script_id: scriptId, found: item !== undefined, can_claim: item?.can_claim ?? null,
      script_name: item?.script_name ?? null, status: item?.status ?? null,
      role: claimRole, sent: false }
  }
  const key = requireKey(args.idempotency_key)
  const previous = await ledger.find(key)
  if (previous !== undefined) {
    if (previous.method !== 'pool_claim' || previous.script_id !== scriptId) {
      throw new JubianError('CONTRACT_CHANGED', 'Idempotency key belongs to a different claim')
    }
    return { script_id: scriptId, status: await readback(client, config, scriptId, actor.id,
      claimRole, previous.outcome === 'accepted'), sent: false, replayed: true,
    response_sha256: previous.response_sha256,
    next: 'This key already has a local claim attempt. Reconcile the pool and do not resubmit with a new key.' }
  }
  const item = (await pool(client, config, signal)).find(row => row.script_id === scriptId)
  if (item?.can_claim !== true) {
    return { script_id: scriptId, status: 'not_claimable', can_claim: item?.can_claim ?? null,
      sent: false, replayed: false, next: 'The current account has no canClaim=1 for this ID.' }
  }
  const path = `/script/center/pool/${claimRole === 'leader' ? 'claim' : 'memberClaim'}/${scriptId}`
  signal?.throwIfAborted()
  const begun = await ledger.beginChecked(key, async () => {
    const other = (await ledger.records()).find(record => record.method === 'pool_claim'
      && record.script_id === scriptId && record.idempotency_key !== key)
    if (other) throw new JubianError('CONTRACT_CHANGED', 'This ID already has a local claim attempt; reconcile it first')
    return { idempotencyKey: key, method: 'pool_claim', scriptId, requestSha256: bodyHash(undefined) }
  })
  if (begun.replayed) {
    if (begun.record.method !== 'pool_claim' || begun.record.script_id !== scriptId) {
      throw new JubianError('CONTRACT_CHANGED', 'Idempotency key belongs to a different claim')
    }
    return { script_id: scriptId, status: await readback(client, config, scriptId, actor.id,
      claimRole, begun.record.outcome === 'accepted'), sent: false, replayed: true,
    response_sha256: begun.record.response_sha256,
    next: 'This key already has a local claim attempt. Reconcile the pool and do not resubmit with a new key.' }
  }
  let accepted = false
  let responseHash: string | null = null
  let failure: string | null = null
  try {
    signal?.throwIfAborted()
    const response = await client.request({ method: 'POST', path,
      ...(signal === undefined ? {} : { signal }) })
    responseHash = response.response_sha256
    accepted = response.data === scriptId
    if (!accepted) failure = 'claim receipt did not confirm this ID'
    await ledger.settle(key, { httpStatus: response.transport.http_status,
      applicationCode: response.transport.application_code, responseSha256: response.response_sha256,
      outcome: accepted ? 'accepted' : 'unknown' })
  } catch (error) {
    failure = error instanceof JubianError ? error.code : 'claim request failed'
    await ledger.settle(key, { httpStatus: null, applicationCode: null, responseSha256: null, outcome: 'unknown' })
  }
  return { script_id: scriptId, status: await readback(client, config, scriptId, actor.id, claimRole, accepted),
    sent: true, replayed: false, response_sha256: responseHash, failure,
    next: 'Readback is authoritative only when this account ID appears as claimant. Unknown results need read-only reconciliation; never switch keys to resubmit.' }
}

/**
 * Validate a bounded watcher window before job admission.
 * @param args - Target scope, UTC window and caller-owned key prefix.
 * @param config - Validated deployment limits.
 * @param now - Admission time.
 * @returns Validated watcher arguments.
 */
export function claimWatchArgs(args: ClaimWatchArgs, config: ClaimWatchConfig, now = new Date()): ClaimWatchArgs {
  const start = Date.parse(args.start_at)
  const end = Date.parse(args.end_at)
  if (!Number.isFinite(start) || !Number.isFinite(end)
    || new Date(start).toISOString() !== args.start_at || new Date(end).toISOString() !== args.end_at
    || end <= now.getTime() || end <= start || start > now.getTime() + config.claimMaxLeadMs
    || end - start > config.claimMaxWindowMs) {
    throw new JubianError('INVALID_ARGUMENT', 'start_at/end_at must be UTC ISO times inside the configured lead/window bounds')
  }
  requireKey(args.idempotency_prefix)
  authorization(args.authorization_basis)
  const scope: string = args.scope
  if (scope === 'ids') {
    const ids = args.script_ids
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > config.claimMaxItems
      || new Set(ids).size !== ids.length) throw new JubianError('INVALID_ARGUMENT', 'script_ids')
    for (const id of ids) positiveId(id, 'script_ids')
  } else if (scope === 'new_claimable') {
    if (args.script_ids !== undefined) throw new JubianError('INVALID_ARGUMENT', 'script_ids must be omitted for new_claimable')
  } else throw new JubianError('INVALID_ARGUMENT', 'scope')
  return args
}

/**
 * Start a process-local, abortable claim watcher within one authorization window.
 * @param client - Authenticated provider transport.
 * @param ledger - Persistent write ledger.
 * @param args - Explicit target scope and UTC window.
 * @param config - Validated polling and item limits.
 * @param now - Job admission time.
 * @returns Cancellation and eventual job result; Host restart does not resume it.
 */
export function claimWatchJob(client: JubianClient, ledger: JubianLedger, args: ClaimWatchArgs,
  config: ClaimWatchConfig, now = new Date()): JobHooks {
  const input = claimWatchArgs(args, config, now)
  const controller = new AbortController()
  const end = Date.parse(input.end_at)
  const deadline = setTimeout(() => { controller.abort(new Error('claim window ended')) },
    Math.max(0, end - now.getTime()))
  const done = (async (): Promise<JobOutcome> => {
    const outcomes: Record<string, unknown>[] = []
    const attempted = new Set<number>()
    try {
      const baseline = input.scope === 'new_claimable'
        ? new Set((await stablePool(client, config, controller.signal)).map(row => row.script_id)) : new Set<number>()
      const startDelay = Date.parse(input.start_at) - Date.now()
      if (startDelay > 0) await delay(startDelay, undefined, { signal: controller.signal })
      for (;;) {
        controller.signal.throwIfAborted()
        const current = await stablePool(client, config, controller.signal)
        controller.signal.throwIfAborted()
        const eligible = current.filter(row => row.can_claim === true && !attempted.has(row.script_id)
          && (input.scope === 'ids'
            ? input.script_ids?.includes(row.script_id) : !baseline.has(row.script_id)))
        for (const row of eligible) {
          controller.signal.throwIfAborted()
          if (attempted.size >= config.claimMaxItems) break
          attempted.add(row.script_id)
          try {
            outcomes.push(await claimMethod(client, ledger, { method: 'claim', script_id: row.script_id,
              idempotency_key: `${input.idempotency_prefix}/${row.script_id}`,
              authorization_basis: input.authorization_basis }, config, controller.signal))
          } catch (error) {
            if (!changingPool(error)) throw error
            attempted.delete(row.script_id)
          }
        }
        if (attempted.size >= config.claimMaxItems
          || (input.scope === 'ids' && attempted.size === input.script_ids?.length)) break
        await delay(config.claimPollIntervalMs, undefined, { signal: controller.signal })
      }
    } catch (error) {
      if (!controller.signal.aborted) return { status: 'failed', detail: error instanceof JubianError ? error.code : 'claim watcher failed',
        result: JSON.stringify({ scope: input.scope, outcomes }) }
      if (controller.signal.reason instanceof Error && controller.signal.reason.message !== 'claim window ended') {
        return { status: 'killed', detail: 'watch cancelled; submitted claims remain on the provider',
          result: JSON.stringify({ scope: input.scope, outcomes }) }
      }
    } finally { clearTimeout(deadline) }
    return { status: 'completed', detail: 'claim window ended or authorized targets processed',
      result: JSON.stringify({ scope: input.scope, attempted: [...attempted], outcomes,
        next: 'Reconcile every unverified result read-only. The job does not resume after a Host restart.' }, null, 2) }
  })()
  return { cancel: () => { controller.abort(new Error('cancelled')) }, done }
}
