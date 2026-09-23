/**
 * The write-path ledger: one append-only NDJSON record per paid or
 * state-changing call, written in two phases.
 *
 * The intent line lands before the request leaves; the settle line lands after
 * the response is read. A record with an intent and no settle line is exactly
 * the unknown state a timeout produces, and it is the only way to answer "did
 * that charge actually happen?" without guessing. A repeated idempotency key
 * never sends a second request.
 */
import { appendFile, mkdir, readdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

/** Same-runtime claims share a queue even when separate tool instances own the ledger. */
const claims = new Map<string, Promise<JubianLedgerBeginResult>>()
/** Per-process suffix for record identities created in the same millisecond. */
let recordCounter = 0

/** The write methods this ledger can record. */
export type JubianLedgerMethod =
  | 'image_generate'
  | 'asset_register'
  | 'storyboard_save'
  | 'storyboard_model_settings'
  | 'storyboard_create'
  | 'storyboard_generate'
  | 'storyboard_select_assets'
  | 'storyboard_native_submit'
  | 'erase_subtitle'
  | 'video_upscale'
  | 'video_task_retry'
  | 'video_task_execute'
  | 'video_task_terminate'
  | 'confirm_casting'
  | 'asset_remove'
  | 'asset_folder_create'
  | 'asset_move'
  | 'asset_rename'

/** A durable record of one write attempt. */
export interface JubianLedgerRecord {
  /** Monotonic per-process record identity. */
  record_id: string
  /** Set on the intent line; the settle line repeats it. */
  idempotency_key: string
  /** Tool method that produced this attempt. */
  method: JubianLedgerMethod
  /** Project the attempt belongs to, or null when the caller stated none. */
  script_id: number | null
  /** ISO timestamp of the intent line. */
  at: string
  /** Canonical hash of the request body. */
  request_sha256: string
  /** Accepted quote or operator estimate reserved before the request. */
  quoted_amount: string | null
  /** Currency unit of the accepted reservation, when one was available. */
  quote_unit: string | null
  /** Catalogue standard the quote came from. */
  quote_standard_id: number | null
  /** When the quote was observed. */
  quote_observed_at: string | null
  /** Response status, filled by the settle line. */
  http_status: number | null
  /** Application envelope code, filled by the settle line. */
  application_code: number | null
  /** Response body hash, filled by the settle line. */
  response_sha256: string | null
  /** `accepted` only for HTTP 2xx with an application code of 0 or 200; otherwise `unknown`; null before settling. */
  outcome: 'accepted' | 'unknown' | null
}

/** What one `begin` call needs. */
export interface JubianLedgerBegin {
  idempotencyKey: string
  method: JubianLedgerMethod
  requestSha256: string
  scriptId?: number
  quotedAmount?: string
  quoteUnit?: string
  quoteStandardId?: number
  quoteObservedAt?: string
}

/** What one `settle` call records. */
export interface JubianLedgerSettlement {
  httpStatus: number | null
  applicationCode: number | null
  responseSha256: string | null
  outcome: 'accepted' | 'unknown'
}

/** The verdict of a `begin`: a fresh intent, or an existing record that must not be re-sent. */
export interface JubianLedgerBeginResult {
  /** True when the key was already recorded, so nothing was or should be sent. */
  replayed: boolean
  /** The record as the ledger now holds it. */
  record: JubianLedgerRecord
}

/** Where one ledger keeps its records. */
export interface JubianLedgerOptions {
  /** Directory holding the per-day NDJSON files. */
  root: string
  /** Per-project CNY cap from the local app's current automatic series setting; absent keeps manual authorization. */
  defaultLimitCents?: () => number | undefined
}

/**
 * Read one record out of the two lines that describe it.
 * @param lines - Parsed NDJSON lines in append order.
 * @returns The merged record, or undefined when no intent line exists.
 */
function fold(lines: Record<string, unknown>[]): JubianLedgerRecord | undefined {
  let record: JubianLedgerRecord | undefined
  for (const line of lines) {
    if (line.phase === 'begin') {
      record = {
        record_id: String(line.record_id), idempotency_key: String(line.idempotency_key),
        method: line.method as JubianLedgerMethod,
        script_id: typeof line.script_id === 'number' ? line.script_id : null,
        at: String(line.at), request_sha256: String(line.request_sha256),
        quoted_amount: (line.quoted_amount as string | null) ?? null,
        quote_unit: (line.quote_unit as string | null) ?? null,
        quote_standard_id: (line.quote_standard_id as number | null) ?? null,
        quote_observed_at: (line.quote_observed_at as string | null) ?? null,
        http_status: null, application_code: null, response_sha256: null, outcome: null,
      }
    } else if (line.phase === 'settle' && record !== undefined && record.idempotency_key === line.idempotency_key) {
      record = { ...record, http_status: line.http_status as number | null,
        application_code: line.application_code as number | null,
        response_sha256: line.response_sha256 as string | null, outcome: line.outcome as 'accepted' | 'unknown' }
    }
  }
  return record
}

/** Append-only, two-phase ledger for paid and state-changing Jubian calls. */
export class JubianLedger {
  /** Directory holding this ledger's records; the budget file lives beside them. */
  readonly root: string
  /** Read at each paid claim, so a Settings edit affects the next request. */
  readonly defaultLimitCents: (() => number | undefined) | undefined

  constructor(options: JubianLedgerOptions) {
    this.root = resolve(options.root)
    this.defaultLimitCents = options.defaultLimitCents
  }

  private fileFor(now: Date): string {
    return join(this.root, `${now.toISOString().slice(0, 10)}.ndjson`)
  }

  /**
   * Read every line whose intent carries this key.
   * @param idempotencyKey - Caller-supplied key.
   * @returns The merged record, or undefined when the key is new.
   */
  async find(idempotencyKey: string): Promise<JubianLedgerRecord | undefined> {
    const matches: Record<string, unknown>[] = []
    for (const file of await this.files()) {
      for (const line of (await readFile(file, 'utf8')).split('\n')) {
        if (!line.trim()) continue
        const parsed = JSON.parse(line) as Record<string, unknown>
        if (parsed.idempotency_key === idempotencyKey) matches.push(parsed)
      }
    }
    return fold(matches)
  }

  /**
   * Persist the intent line, or replay the record an earlier call already wrote.
   * Claims are serialized across instances sharing a resolved root in this runtime, not across processes.
   * @param input - Key, method and request identity.
   * @returns Whether this call replayed an existing record, and the record itself.
   */
  async begin(input: JubianLedgerBegin): Promise<JubianLedgerBeginResult> {
    return this.beginChecked(input.idempotencyKey, () => Promise.resolve(input))
  }

  /**
   * Check a fresh key and prepare its priced intent under the same root-wide queue.
   * A replay skips preparation, so a later cap cannot turn a prior request into a new send.
   * @param idempotencyKey - Key to check before preparing the intent.
   * @param prepare - Validates authorization and supplies the intent after reading current records.
   * @returns A fresh or replayed intent; a rejected preparation writes nothing.
   */
  async beginChecked(idempotencyKey: string, prepare: () => Promise<JubianLedgerBegin>): Promise<JubianLedgerBeginResult> {
    const rootKey = process.platform === 'win32' ? this.root.toLowerCase() : this.root
    const previous = claims.get(rootKey) ?? Promise.resolve()
    const operation = previous.catch(() => undefined).then(async () => {
      const existing = await this.find(idempotencyKey)
      if (existing !== undefined) return { replayed: true, record: existing }
      const input = await prepare()
      if (input.idempotencyKey !== idempotencyKey) throw new Error('Jubian ledger: prepared key differs from claim')
      return this.appendIntent(input)
    })
    claims.set(rootKey, operation)
    try { return await operation }
    finally { if (claims.get(rootKey) === operation) claims.delete(rootKey) }
  }

  private async appendIntent(input: JubianLedgerBegin): Promise<JubianLedgerBeginResult> {
    const now = new Date()
    recordCounter += 1
    const record_id = `jub_${now.getTime().toString(36)}_${recordCounter.toString(36)}`
    const record: JubianLedgerRecord = { record_id, idempotency_key: input.idempotencyKey, method: input.method,
      script_id: input.scriptId ?? null,
      at: now.toISOString(), request_sha256: input.requestSha256, quoted_amount: input.quotedAmount ?? null,
      quote_unit: input.quoteUnit ?? null,
      quote_standard_id: input.quoteStandardId ?? null, quote_observed_at: input.quoteObservedAt ?? null,
      http_status: null, application_code: null, response_sha256: null, outcome: null }
    await mkdir(this.root, { recursive: true })
    await appendFile(this.fileFor(now), `${JSON.stringify({ phase: 'begin', ...record })}\n`, 'utf8')
    return { replayed: false, record }
  }

  /**
   * Persist the settlement line for one key.
   * @param idempotencyKey - The key whose intent line was already written.
   * @param settlement - Transport and application outcome.
   */
  async settle(idempotencyKey: string, settlement: JubianLedgerSettlement): Promise<void> {
    const now = new Date()
    await mkdir(this.root, { recursive: true })
    await appendFile(this.fileFor(now), `${JSON.stringify({ phase: 'settle', idempotency_key: idempotencyKey,
      settled_at: now.toISOString(), http_status: settlement.httpStatus,
      application_code: settlement.applicationCode, response_sha256: settlement.responseSha256,
      outcome: settlement.outcome })}\n`, 'utf8')
  }

  /**
   * List the ledger files in append order.
   * @returns Absolute paths of the per-day NDJSON files.
   */
  async files(): Promise<string[]> {
    try {
      const names = await readdir(this.root)
      return names.filter(name => name.endsWith('.ndjson')).sort().map(name => join(this.root, name))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
  }

  /**
   * Every record whose outcome is still open.
   *
   * A record is open while its intent has no settlement — the process died between
   * sending and reading, or the read timed out — and while a settlement says
   * `unknown`, which is the provider answering something other than success. Neither
   * state may be resolved by sending again: this is the list to reconcile read-only
   * after a restart, and the reason no caller of this ledger has to guess whether a
   * charge happened.
   * @param scriptId - Project to filter by, or undefined for every project.
   * @returns The open records, oldest first.
   */
  async unresolved(scriptId?: number): Promise<JubianLedgerRecord[]> {
    return (await this.records())
      .filter(record => record.outcome === null || record.outcome === 'unknown')
      .filter(record => scriptId === undefined || record.script_id === scriptId)
  }

  /**
   * Read the whole ledger.
   *
   * The budget gate and any recovery pass need every record, not one key, so this
   * reads each line once and folds the two phases together.
   * @returns Every record, in append order.
   */
  async records(): Promise<JubianLedgerRecord[]> {
    const byKey = new Map<string, Record<string, unknown>[]>()
    for (const file of await this.files()) {
      for (const line of (await readFile(file, 'utf8')).split('\n')) {
        if (!line.trim()) continue
        const parsed = JSON.parse(line) as Record<string, unknown>
        const key = String(parsed.idempotency_key)
        const lines = byKey.get(key) ?? []
        lines.push(parsed)
        byKey.set(key, lines)
      }
    }
    const records: JubianLedgerRecord[] = []
    for (const lines of byKey.values()) {
      const record = fold(lines)
      if (record !== undefined) records.push(record)
    }
    return records.sort((left, right) => left.at.localeCompare(right.at))
  }
}
