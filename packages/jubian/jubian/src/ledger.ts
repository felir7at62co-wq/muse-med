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
import { withLedgerQueue } from './claim-queue.ts'
/** Per-process suffix for record identities created in the same millisecond. */
let recordCounter = 0

/** The write methods this ledger can record. */
export type JubianLedgerMethod =
  | 'pool_claim'
  | 'image_generate'
  | 'asset_register'
  | 'storyboard_save'
  | 'storyboard_remove'
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
  /** Accepted, unresolved, proven not sent, or awaiting settlement. */
  outcome: 'accepted' | 'unknown' | 'not_sent' | null
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

/** Trusted Host evidence that an unresolved image request stopped before dispatch. */
export interface JubianLedgerPreDispatchAbort {
  /** Exact identity of the existing intent. */
  recordId: string
  /** Exact idempotency key of the existing intent. */
  idempotencyKey: string
  /** Method repeated from the intent; only `image_generate` is recoverable. */
  method: JubianLedgerMethod
  /** Exact request-body hash repeated from the intent. */
  requestSha256: string
  /** Trusted Host actor that observed the abort. */
  actor: string
  /** Hash of the guard evidence that stopped dispatch. */
  guardEvidenceSha256: string
  /** Hash of the read-only reconciliation evidence showing no remote request. */
  reconciliationEvidenceSha256: string
}

/** Evidence required to consume one pre-dispatch abort exactly once. */
export interface JubianLedgerResumeEvidence {
  /** Exact identity of the intent being resumed. */
  recordId: string
  /** Trusted Host actor recorded by the pre-dispatch abort. */
  actor: string
  /** Exact guard-evidence hash recorded by the pre-dispatch abort. */
  guardEvidenceSha256: string
  /** Exact reconciliation-evidence hash recorded by the pre-dispatch abort. */
  reconciliationEvidenceSha256: string
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

/** One folded record and the recovery events that affect future transitions. */
interface FoldedLedgerRecord {
  record: JubianLedgerRecord | undefined
  preDispatchAbort: JubianLedgerPreDispatchAbort | undefined
  resumed: boolean
}

function sameIntentIdentity(record: JubianLedgerRecord, line: Record<string, unknown>): boolean {
  return line.record_id === record.record_id
    && line.idempotency_key === record.idempotency_key
    && line.method === record.method
    && line.request_sha256 === record.request_sha256
}

function recoveryEvidence(line: Record<string, unknown>): JubianLedgerPreDispatchAbort | undefined {
  if (typeof line.record_id !== 'string' || typeof line.idempotency_key !== 'string'
    || typeof line.method !== 'string' || typeof line.request_sha256 !== 'string'
    || typeof line.actor !== 'string' || typeof line.guard_evidence_sha256 !== 'string'
    || typeof line.reconciliation_evidence_sha256 !== 'string') return undefined
  return { recordId: line.record_id, idempotencyKey: line.idempotency_key,
    method: line.method as JubianLedgerMethod, requestSha256: line.request_sha256, actor: line.actor,
    guardEvidenceSha256: line.guard_evidence_sha256,
    reconciliationEvidenceSha256: line.reconciliation_evidence_sha256 }
}

/**
 * Read one record and its recovery state from parsed NDJSON lines.
 * @param lines - Parsed NDJSON lines in append order.
 * @returns The merged record and its recovery state.
 */
function foldState(lines: Record<string, unknown>[]): FoldedLedgerRecord {
  let record: JubianLedgerRecord | undefined
  let preDispatchAbort: JubianLedgerPreDispatchAbort | undefined
  let resumed = false
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
      preDispatchAbort = undefined
      resumed = false
    } else if (line.phase === 'settle' && record !== undefined && record.outcome !== 'not_sent'
      && record.idempotency_key === line.idempotency_key
      && (line.outcome === 'accepted' || line.outcome === 'unknown')) {
      record = { ...record, http_status: line.http_status as number | null,
        application_code: line.application_code as number | null,
        response_sha256: line.response_sha256 as string | null, outcome: line.outcome }
    } else if (line.phase === 'pre_dispatch_abort' && record !== undefined && preDispatchAbort === undefined
      && record.method === 'image_generate' && record.outcome === 'unknown'
      && record.http_status === null && record.application_code === null && record.response_sha256 === null
      && sameIntentIdentity(record, line)) {
      const evidence = recoveryEvidence(line)
      if (evidence !== undefined) {
        preDispatchAbort = evidence
        record = { ...record, outcome: 'not_sent' }
      }
    } else if (line.phase === 'resume' && record !== undefined && preDispatchAbort !== undefined && !resumed
      && record.outcome === 'not_sent' && sameIntentIdentity(record, line)
      && line.actor === preDispatchAbort.actor
      && line.guard_evidence_sha256 === preDispatchAbort.guardEvidenceSha256
      && line.reconciliation_evidence_sha256 === preDispatchAbort.reconciliationEvidenceSha256
      && line.script_id === record.script_id && line.quoted_amount === record.quoted_amount
      && line.quote_unit === record.quote_unit && line.quote_standard_id === record.quote_standard_id) {
      record = { ...record,
        quote_observed_at: typeof line.quote_observed_at === 'string' ? line.quote_observed_at : record.quote_observed_at,
        http_status: null, application_code: null, response_sha256: null, outcome: null }
      resumed = true
    }
  }
  return { record, preDispatchAbort, resumed }
}

function fold(lines: Record<string, unknown>[]): JubianLedgerRecord | undefined {
  return foldState(lines).record
}

function requireRecoveryEvidence(input: JubianLedgerPreDispatchAbort | JubianLedgerResumeEvidence): void {
  if (!input.recordId.trim() || !input.actor.trim() || !input.guardEvidenceSha256.trim()
    || !input.reconciliationEvidenceSha256.trim()) {
    throw new Error('Jubian ledger: recovery identity, actor and evidence hashes must be nonempty')
  }
  const sha256 = /^(?:sha256:)?[a-f0-9]{64}$/u
  if (!sha256.test(input.guardEvidenceSha256) || !sha256.test(input.reconciliationEvidenceSha256)) {
    throw new Error('Jubian ledger: recovery evidence hashes must be SHA-256 digests')
  }
}

function sameResumeIntent(record: JubianLedgerRecord, input: JubianLedgerBegin): boolean {
  return input.idempotencyKey === record.idempotency_key
    && input.method === record.method
    && input.requestSha256 === record.request_sha256
    && (input.scriptId ?? null) === record.script_id
    && (input.quotedAmount ?? null) === record.quoted_amount
    && (input.quoteUnit ?? null) === record.quote_unit
    && (input.quoteStandardId ?? null) === record.quote_standard_id
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
    return fold(await this.linesFor(idempotencyKey))
  }

  private async linesFor(idempotencyKey: string): Promise<Record<string, unknown>[]> {
    const matches: Record<string, unknown>[] = []
    for (const file of await this.files()) {
      for (const line of (await readFile(file, 'utf8')).split('\n')) {
        if (!line.trim()) continue
        const parsed = JSON.parse(line) as Record<string, unknown>
        if (parsed.idempotency_key === idempotencyKey) matches.push(parsed)
      }
    }
    return matches
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
    return await withLedgerQueue(this.root, async () => {
      const existing = await this.find(idempotencyKey)
      if (existing !== undefined) return { replayed: true, record: existing }
      const input = await prepare()
      if (input.idempotencyKey !== idempotencyKey) throw new Error('Jubian ledger: prepared key differs from claim')
      return this.appendIntent(input)
    })
  }

  /**
   * Reserve a whole priced batch before any request leaves this process.
   * The callback checks the aggregate budget inside the same root-wide queue.
   * Existing keys or a rejected callback append no intents; cross-process claims remain unsupported.
   * @param idempotencyKeys - Distinct keys in input order.
   * @param prepare - Returns one priced intent per key after aggregate authorization.
   * @returns Newly reserved records in input order.
   */
  async beginManyChecked(idempotencyKeys: readonly string[],
    prepare: () => Promise<readonly JubianLedgerBegin[]>): Promise<JubianLedgerRecord[]> {
    if (idempotencyKeys.length === 0 || new Set(idempotencyKeys).size !== idempotencyKeys.length) {
      throw new Error('Jubian ledger: batch keys must be distinct and nonempty')
    }
    return await withLedgerQueue(this.root, async () => {
      const existing = new Set((await this.records()).map(record => record.idempotency_key))
      if (idempotencyKeys.some(key => existing.has(key))) {
        throw new Error('Jubian ledger: batch key already has a record; reconcile the batch without resending')
      }
      const inputs = await prepare()
      if (inputs.length !== idempotencyKeys.length || inputs.some((input, index) =>
        input.idempotencyKey !== idempotencyKeys[index])) {
        throw new Error('Jubian ledger: prepared batch keys differ from the claim')
      }
      const now = new Date()
      const records = inputs.map(input => this.intentRecord(input, now))
      await mkdir(this.root, { recursive: true })
      await appendFile(this.fileFor(now), records.map(record => `${JSON.stringify({ phase: 'begin', ...record })}\n`).join(''), 'utf8')
      return records
    })
  }

  private intentRecord(input: JubianLedgerBegin, now: Date): JubianLedgerRecord {
    recordCounter += 1
    const record_id = `jub_${now.getTime().toString(36)}_${recordCounter.toString(36)}`
    return { record_id, idempotency_key: input.idempotencyKey, method: input.method,
      script_id: input.scriptId ?? null, at: now.toISOString(), request_sha256: input.requestSha256,
      quoted_amount: input.quotedAmount ?? null, quote_unit: input.quoteUnit ?? null,
      quote_standard_id: input.quoteStandardId ?? null, quote_observed_at: input.quoteObservedAt ?? null,
      http_status: null, application_code: null, response_sha256: null, outcome: null }
  }

  private async appendIntent(input: JubianLedgerBegin): Promise<JubianLedgerBeginResult> {
    const now = new Date()
    const record = this.intentRecord(input, now)
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
    const suppliedOutcome: unknown = settlement.outcome
    if (suppliedOutcome !== 'accepted' && suppliedOutcome !== 'unknown') {
      throw new Error('Jubian ledger: settlement outcome must be accepted or unknown')
    }
    await withLedgerQueue(this.root, async () => {
      const now = new Date()
      await mkdir(this.root, { recursive: true })
      await appendFile(this.fileFor(now), `${JSON.stringify({ phase: 'settle', idempotency_key: idempotencyKey,
        settled_at: now.toISOString(), http_status: settlement.httpStatus,
        application_code: settlement.applicationCode, response_sha256: settlement.responseSha256,
        outcome: settlement.outcome })}\n`, 'utf8')
    })
  }

  /**
   * Record trusted proof that one unresolved image request stopped before dispatch.
   * Only an `unknown` settlement with no response evidence is eligible. The event
   * repeats the full intent identity so unrelated evidence cannot release a key.
   * @param input - Existing intent identity and trusted Host evidence.
   * @returns The record folded to `not_sent` after the append succeeds.
   */
  async preDispatchAbort(input: JubianLedgerPreDispatchAbort): Promise<JubianLedgerRecord> {
    requireRecoveryEvidence(input)
    if (!input.idempotencyKey.trim() || !input.requestSha256.trim()) {
      throw new Error('Jubian ledger: recovery key and request hash must be nonempty')
    }
    return await withLedgerQueue(this.root, async () => {
      const lines = await this.linesFor(input.idempotencyKey)
      const state = foldState(lines)
      const record = state.record
      if (record === undefined) throw new Error('Jubian ledger: pre-dispatch abort has no matching intent')
      if (state.resumed) {
        throw new Error('Jubian ledger: pre-dispatch abort was already resumed')
      }
      if (state.preDispatchAbort !== undefined) {
        const prior = state.preDispatchAbort
        if (record.outcome === 'not_sent'
          && input.recordId === prior.recordId
          && input.idempotencyKey === prior.idempotencyKey
          && input.method === prior.method
          && input.requestSha256 === prior.requestSha256
          && input.actor === prior.actor
          && input.guardEvidenceSha256 === prior.guardEvidenceSha256
          && input.reconciliationEvidenceSha256 === prior.reconciliationEvidenceSha256) {
          return record
        }
        throw new Error('Jubian ledger: pre-dispatch abort was already recorded with different evidence')
      }
      if (record.method !== 'image_generate' || record.outcome !== 'unknown'
        || record.http_status !== null || record.application_code !== null || record.response_sha256 !== null) {
        throw new Error('Jubian ledger: only an unknown image request with no response evidence can be marked not sent')
      }
      if (input.recordId !== record.record_id || input.method !== record.method
        || input.requestSha256 !== record.request_sha256) {
        throw new Error('Jubian ledger: pre-dispatch abort identity differs from the intent')
      }
      const now = new Date()
      const event = { phase: 'pre_dispatch_abort', record_id: record.record_id,
        idempotency_key: record.idempotency_key, method: record.method, request_sha256: record.request_sha256,
        actor: input.actor, guard_evidence_sha256: input.guardEvidenceSha256,
        reconciliation_evidence_sha256: input.reconciliationEvidenceSha256, aborted_at: now.toISOString() }
      await mkdir(this.root, { recursive: true })
      await appendFile(this.fileFor(now), `${JSON.stringify(event)}\n`, 'utf8')
      return { ...record, outcome: 'not_sent' }
    })
  }

  /**
   * Recheck authorization and consume a trusted pre-dispatch abort once.
   * Preparation runs while the `not_sent` record does not reserve budget. Its
   * returned intent must repeat the original key, method, body, project and quote;
   * only quote observation time may advance.
   * @param idempotencyKey - Exact key of the record being resumed.
   * @param evidence - Exact abort identity and evidence hashes.
   * @param prepare - Revalidates the current guard and budget before the resume append.
   * @returns The original record folded back to an unsettled state.
   */
  async resumeChecked(idempotencyKey: string, evidence: JubianLedgerResumeEvidence,
    prepare: () => Promise<JubianLedgerBegin>): Promise<JubianLedgerRecord> {
    requireRecoveryEvidence(evidence)
    return await withLedgerQueue(this.root, async () => {
      const lines = await this.linesFor(idempotencyKey)
      const state = foldState(lines)
      const record = state.record
      if (record === undefined) throw new Error('Jubian ledger: resume has no matching intent')
      if (state.resumed) throw new Error('Jubian ledger: pre-dispatch abort was already resumed')
      if (state.preDispatchAbort === undefined || record.outcome !== 'not_sent') {
        throw new Error('Jubian ledger: record has no trusted pre-dispatch abort')
      }
      const abort = state.preDispatchAbort
      if (evidence.recordId !== record.record_id || evidence.recordId !== abort.recordId
        || evidence.actor !== abort.actor
        || evidence.guardEvidenceSha256 !== abort.guardEvidenceSha256
        || evidence.reconciliationEvidenceSha256 !== abort.reconciliationEvidenceSha256) {
        throw new Error('Jubian ledger: resume evidence differs from the pre-dispatch abort')
      }
      const input = await prepare()
      if (!sameResumeIntent(record, input)) {
        throw new Error('Jubian ledger: prepared resume identity differs from the original intent')
      }
      const now = new Date()
      const event = { phase: 'resume', record_id: record.record_id, idempotency_key: record.idempotency_key,
        method: record.method, request_sha256: record.request_sha256, script_id: record.script_id,
        quoted_amount: record.quoted_amount, quote_unit: record.quote_unit,
        quote_standard_id: record.quote_standard_id,
        quote_observed_at: input.quoteObservedAt ?? record.quote_observed_at,
        actor: abort.actor, guard_evidence_sha256: abort.guardEvidenceSha256,
        reconciliation_evidence_sha256: abort.reconciliationEvidenceSha256, resumed_at: now.toISOString() }
      await mkdir(this.root, { recursive: true })
      await appendFile(this.fileFor(now), `${JSON.stringify(event)}\n`, 'utf8')
      return { ...record, quote_observed_at: event.quote_observed_at,
        http_status: null, application_code: null, response_sha256: null, outcome: null }
    })
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
