/**
 * The write path: one paid or state-changing request under a two-phase ledger.
 *
 * The intent line lands before the request leaves; the settle line lands after
 * the response is read. A record with an intent and no settle line is exactly the
 * unknown state a timeout produces, and it is the only honest answer to "did that
 * already charge me?".
 *
 * The key is never generated here. A generated key would let a retry after an
 * ambiguous outcome bypass the record of the first attempt, which is the only
 * thing standing between a timeout and a second charge.
 */
import { createHash } from 'node:crypto'
import type { JubianLedger, JubianLedgerMethod } from '@deepseek-ai/dsh-jubian'
import { JubianError, checkBudget } from '@deepseek-ai/dsh-jubian'

/** What one ledger-guarded write produced. */
export interface WriteOutcome {
  replayed: boolean
  outcome: 'accepted' | 'unknown'
  response_sha256: string | null
  data: unknown
  /**
   * What the spend cap said about this call.
   *
   * Present for every write so a caller can report it: `unauthorized` means the
   * deployment holds no limit for this project and the call went out unprotected,
   * which is a fact the operator wants to see rather than infer.
   */
  budget?: { status: string; reason: string; settledCents: number; reservedCents: number } | undefined
}

/** What one write call states about itself beyond its body. */
export interface WriteOptions {
  /** Project the charge belongs to; the budget gate refuses a paid call without it. */
  readonly scriptId?: number | undefined
  /** Authorization file to read instead of the ledger's own; tests set this. */
  readonly authorizationPath?: string | undefined
}

/**
 * Require one argument the caller must supply.
 *
 * A missing argument is a caller error this process can see without any network
 * round trip, so it reports `INVALID_ARGUMENT` rather than the envelope code: a
 * caller reading "did not match the expected envelope" would look for a provider
 * change while the request never left.
 * @param value - The argument, or undefined when it was omitted.
 * @param name - Argument name, included so the caller knows what to supply.
 * @returns The argument, once it is present.
 */
export function need<T>(value: T | undefined, name?: string): T {
  if (value === undefined) throw new JubianError('INVALID_ARGUMENT', name)
  return value
}

/**
 * Reject a write that carries no usable idempotency key.
 *
 * Every write method calls this before its first network request, including the
 * reads that compile its body: a missing key must fail without spending even a
 * read.
 * @param value - Caller-supplied key.
 * @returns The key, once it is a non-empty string.
 */
export function requireKey(value: string | undefined): string {
  if (typeof value !== 'string' || !value.trim()) throw new JubianError('INVALID_ARGUMENT', 'idempotency_key')
  return value
}

/**
 * Required caller arguments per method, checked before any request or ledger write.
 *
 * The tool schema is one JSON object shared by every method of a tool, so it
 * cannot express "required for this method only". Without this table a caller who
 * omits such an argument reaches the method body, where the failure surfaces as a
 * bare contract error with nothing naming the argument.
 *
 * Arguments a method derives from what it already reads are deliberately absent:
 * `erase_subtitle` and `upscale` read the project from the task row, and
 * `submit_video` accepts either a preview file or the pair that locates one, so
 * none of those is listed here. `image_generate` is absent for `asset_type`
 * because either it or `asset_category` states the category, and the pair is
 * checked against each other in the method. `idempotency_key` is absent too —
 * {@link requireKey} owns it and names it for every write method.
 */
export const REQUIRED_ARGUMENTS: Record<string, readonly string[]> = {
  'jubian_catalog.rate': ['standard_id'],
  'jubian_catalog.script': ['script_id'],
  'jubian_catalog.episodes': ['script_id'],
  'jubian_asset.get': ['asset_id'],
  'jubian_asset.list': ['script_id'],
  'jubian_asset.materials': ['script_id'],
  'jubian_asset.generated_image': ['asset_id'],
  'jubian_asset.confirm_casting': ['material_id'],
  'jubian_asset.register': ['script_id', 'asset_name', 'asset_type', 'asset_url'],
  'jubian_asset.remove': ['asset_id', 'script_id'],
  'jubian_asset.upload_reference': ['image_path'],
  'jubian_asset.create_folder': ['folder_name', 'asset_scope_type', 'root_category_type'],
  'jubian_asset.move': ['material_ids', 'target_folder_id', 'asset_scope_type', 'root_category_type'],
  'jubian_asset.rename': ['material_id', 'asset_name'],
  'jubian_video.task': ['task_id'],
  'jubian_video.tasks': ['script_id'],
  'jubian_video.subtasks': ['task_id'],
  'jubian_video.image_generate': ['script_id', 'asset_name', 'prompt'],
  'jubian_video.upscale': ['task_id'],
  'jubian_video.retry': ['task_id'],
  'jubian_storyboard.get': ['storyboard_id'],
  'jubian_storyboard.create': [],
  'jubian_storyboard.save': ['storyboard_id'],
  'jubian_storyboard.generate': ['storyboard_id', 'content_duration_ms'],
  'jubian_storyboard.select_assets': ['storyboard_id', 'selections'],
  'jubian_storyboard.prepare_video': ['storyboard_id', 'project_dir'],
  'jubian_storyboard.erase_subtitle': ['task_id', 'model_id', 'video_width', 'video_height'],
  'jubian_media.download': ['media_url', 'media_kind', 'output_path'],
  'jubian_organize.index': ['script_id', 'project_dir'],
  'jubian_model.preview': ['script_id', 'project_dir', 'scope', 'changes'],
  'jubian_model.apply': ['script_id', 'project_dir', 'preview_path'],
}

/**
 * Reject a call whose method cannot run without an argument the caller omitted.
 *
 * Runs before dispatch so the failure costs no request, no ledger line and no
 * provider state change.
 * @param tool - Tool name, e.g. `jubian_storyboard`.
 * @param args - The dispatched arguments.
 * @throws {JubianError} `INVALID_ARGUMENT` naming the first missing argument.
 */
export function requireArguments(tool: string, args: { method?: string } & Record<string, unknown>): void {
  const method = typeof args.method === 'string' ? args.method : ''
  if (tool === 'jubian_storyboard' && method === 'create'
    && args.body === undefined && args.body_path === undefined) {
    throw new JubianError('INVALID_ARGUMENT', 'jubian_storyboard create requires body or body_path')
  }
  for (const name of REQUIRED_ARGUMENTS[`${tool}.${method}`] ?? []) {
    if (args[name] === undefined) throw new JubianError('INVALID_ARGUMENT', `${tool} ${method} requires ${name}`)
  }
}

/**
 * Canonical hash of a request body, so the ledger can tell two attempts apart.
 * @param body - The exact body about to be sent, or undefined for a bodyless write.
 * @returns The `sha256:`-prefixed hash of the body's canonical JSON.
 */
export function bodyHash(body: Record<string, unknown> | undefined): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(body ?? null)).digest('hex')}`
}

/**
 * Run one write method under the two-phase ledger.
 *
 * The intent line lands before the request leaves; the settle line lands after
 * the response is read. A replayed key for the same method returns the recorded
 * outcome and sends nothing; a key owned by another method is rejected.
 *
 * `body` is an async thunk on purpose, and it is awaited. Some bodies can only be
 * compiled by reading the provider first — an image request needs its selectors
 * from the live catalogue — and that read must not happen for a key already
 * recorded. Building the body lazily is what makes "replayed" mean zero network
 * requests rather than one, and awaiting it is what lets the quote below observe
 * what that read returned.
 * @param ledger - The write-path ledger.
 * @param idempotencyKey - Caller-supplied key; required, never generated here.
 * @param method - Ledger method name.
 * @param body - Computes the exact body about to be sent, or undefined for a bodyless write.
 * @param send - Performs the single request, receiving the computed body.
 * @param quote - Optional quote snapshot, observed after the body is built.
 * @param options - The project the charge belongs to, and an authorization path override.
 * @returns The outcome, whether it was replayed, any envelope data, and the spend verdict.
 * @throws {JubianError} `BUDGET_EXCEEDED` when a paid call is not covered by the authorization.
 */
export async function writeUnderLedger(
  ledger: JubianLedger,
  idempotencyKey: string | undefined,
  method: JubianLedgerMethod,
  body: () => Promise<Record<string, unknown> | undefined> | Record<string, unknown> | undefined,
  send: (body: Record<string, unknown> | undefined) => Promise<{
    transport: { http_status: number | null; application_code: number | null }
    response_sha256: string | null
    data: unknown
  }>,
  quote?: () => { amount?: string; unit?: string; standardId?: number; observedAt?: string } | undefined,
  options?: WriteOptions,
): Promise<WriteOutcome> {
  const key = requireKey(idempotencyKey)
  const existing = await ledger.find(key)
  if (existing !== undefined) {
    if (existing.method !== method) throw new JubianError('CONTRACT_CHANGED', 'Idempotency key belongs to a different write')
    return { replayed: true, outcome: existing.outcome ?? 'unknown', response_sha256: existing.response_sha256, data: null }
  }
  // Awaited on purpose: a body may be compiled from a provider read, and the
  // quote below observes what that read returned.
  const payload = await body()
  const quoted = quote?.()
  // The cap is checked here, at the one path every write takes, and before the
  // intent line lands: a refused call must leave no record that reads like an
  // attempt, and must reach no provider.
  const budget = await checkBudget({ ledger, method,
    ...(options?.scriptId === undefined ? {} : { scriptId: options.scriptId }),
    ...(quoted === undefined ? {} : { quote: quoted }),
    ...(options?.authorizationPath === undefined ? {} : { authorizationPath: options.authorizationPath }) })
  if (budget.status === 'refused') throw new JubianError('BUDGET_EXCEEDED', budget.reason)
  const begun = await ledger.begin({ idempotencyKey: key, method, requestSha256: bodyHash(payload),
    ...(options?.scriptId === undefined ? {} : { scriptId: options.scriptId }),
    ...(quoted?.amount === undefined ? {} : { quotedAmount: quoted.amount }),
    ...(quoted?.unit === undefined ? {} : { quoteUnit: quoted.unit }),
    ...(quoted?.standardId === undefined ? {} : { quoteStandardId: quoted.standardId }),
    ...(quoted?.observedAt === undefined ? {} : { quoteObservedAt: quoted.observedAt }) })
  if (begun.replayed) {
    if (begun.record.method !== method || begun.record.request_sha256 !== bodyHash(payload)) {
      throw new JubianError('CONTRACT_CHANGED', 'Idempotency key belongs to a different write')
    }
    return { replayed: true, outcome: begun.record.outcome ?? 'unknown',
      response_sha256: begun.record.response_sha256, data: null,
      budget: { status: budget.status, reason: budget.reason, settledCents: budget.settledCents,
        reservedCents: budget.reservedCents } }
  }
  try {
    const response = await send(payload)
    const code = response.transport.application_code
    const http = response.transport.http_status
    const outcome = http !== null && http >= 200 && http < 300 && (code === 0 || code === 200) ? 'accepted' : 'unknown'
    await ledger.settle(key, { httpStatus: http, applicationCode: code,
      responseSha256: response.response_sha256, outcome })
    return { replayed: false, outcome, response_sha256: response.response_sha256, data: response.data,
      budget: { status: budget.status, reason: budget.reason, settledCents: budget.settledCents,
        reservedCents: budget.reservedCents } }
  } catch (error) {
    // The provider may have applied the change; only readback can resolve this.
    await ledger.settle(key, { httpStatus: null, applicationCode: null, responseSha256: null,
      outcome: 'unknown' })
    throw error
  }
}
