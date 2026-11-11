/** Stable business-intent receipts preserve project identities without rebuilding requests from changed remote records. */
import { createHash } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { JubianError, type JubianClient, type JubianLedger, type JubianLedgerMethod,
  type JubianRequest, type JubianResponse } from '@deepseek-ai/dsh-jubian'
import { readDocumentUploadReceipt } from './document-upload.ts'
import { acceptedWriteResponse, bodyHash, requireKey, writeUnderLedger, type WriteOutcome } from './write.ts'

/** One unchanged user request and the provider request prepared only for its first attempt. */
export interface ProjectOperationInput {
  key: string
  method: JubianLedgerMethod
  scriptId?: number
  intent: Record<string, unknown>
  prepare: () => Promise<JubianRequest>
  /** One manuscript/workbench association protected across keys within this ledger. */
  binding?: { manuscriptId: number; productionType: 0 | 1 }
}

/** Ledger evidence with the location of the business receipt containing the original response data. */
export interface ProjectOperationOutcome extends WriteOutcome {
  receipt_path: string
  receipt_status: 'recorded' | 'missing'
  settlement_pending?: boolean
}

interface OperationReceipt {
  version: 1
  key_hash: string
  method: JubianLedgerMethod
  script_id: number | null
  intent_sha256: string
  intent: Record<string, unknown>
  request: JubianRequest
  request_sha256: string
  response: Pick<JubianResponse, 'transport' | 'response_sha256' | 'data'> | null
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function changed(detail: string): never { throw new JubianError('CONTRACT_CHANGED', detail) }

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (object(value)) {
    return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, canonical(item)]))
  }
  return value
}

function hash(value: string): string { return createHash('sha256').update(value).digest('hex') }
function intentHash(value: Record<string, unknown>): string { return `sha256:${hash(JSON.stringify(canonical(value)))}` }
function identity(request: JubianRequest): Record<string, unknown> {
  return { method: request.method, path: request.path, body: request.body ?? null }
}

function requestFrom(value: unknown): JubianRequest {
  if (!object(value) || typeof value.path !== 'string' || !value.path.startsWith('/')) return changed('Invalid operation receipt request')
  const method = value.method
  if (method !== 'GET' && method !== 'POST' && method !== 'PUT' && method !== 'DELETE') return changed('Invalid operation receipt method')
  if (value.body !== undefined && !object(value.body)) return changed('Invalid operation receipt body')
  return { method, path: value.path, ...(value.body === undefined ? {} : { body: value.body }) }
}

function receiptFrom(value: unknown, input: Pick<ProjectOperationInput, 'key' | 'method' | 'scriptId' | 'intent'>): OperationReceipt {
  if (!object(value) || value.version !== 1 || value.key_hash !== hash(input.key) || value.method !== input.method
    || value.script_id !== (input.scriptId ?? null) || !object(value.intent)
    || value.intent_sha256 !== intentHash(input.intent) || value.intent_sha256 !== intentHash(value.intent)) {
    return changed('Idempotency key belongs to a different business operation')
  }
  const request = requestFrom(value.request)
  if (value.request_sha256 !== bodyHash(identity(request))) return changed('Operation receipt request hash does not match its request')
  let response: OperationReceipt['response'] = null
  if (value.response !== null) {
    if (!object(value.response) || !object(value.response.transport)) return changed('Invalid operation receipt response')
    const transport = value.response.transport
    if ((transport.http_status !== null && typeof transport.http_status !== 'number')
      || (transport.application_code !== null && typeof transport.application_code !== 'number')
      || (value.response.response_sha256 !== null && typeof value.response.response_sha256 !== 'string')) {
      return changed('Invalid operation receipt response evidence')
    }
    response = { transport: { http_status: transport.http_status, application_code: transport.application_code },
      response_sha256: value.response.response_sha256, data: value.response.data }
  }
  return { version: 1, key_hash: value.key_hash, method: input.method, script_id: input.scriptId ?? null,
    intent_sha256: value.intent_sha256, intent: value.intent, request, request_sha256: value.request_sha256, response }
}

async function savedValue(path: string): Promise<{ found: false } | { found: true; value: unknown }> {
  let text: string
  try { text = await readFile(path, 'utf8') }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return { found: false }
    throw error
  }
  let value: unknown
  try { value = JSON.parse(text) }
  catch (_error) { return changed('Operation receipt is not readable JSON; no request was sent') }
  return { found: true, value }
}

async function readReceipt(path: string, input: ProjectOperationInput): Promise<OperationReceipt | null> {
  const saved = await savedValue(path)
  return saved.found ? receiptFrom(saved.value, input) : null
}

async function saveReceipt(path: string, receipt: OperationReceipt): Promise<void> {
  await writeFileAtomic(path, `${JSON.stringify(receipt)}\n`, { mode: 0o600, dirMode: 0o700 })
}

async function checkBinding(path: string, input: ProjectOperationInput,
  binding: NonNullable<ProjectOperationInput['binding']>): Promise<void> {
  const saved = await savedValue(path)
  if (!saved.found) return
  const value = saved.value
  if (!object(value) || value.version !== 1 || value.manuscript_id !== binding.manuscriptId
    || value.production_type !== binding.productionType || typeof value.original_key !== 'string'
    || !value.original_key.trim()) return changed('Manuscript project binding is unreadable; no project request was sent')
  if (value.original_key !== input.key) {
    throw new JubianError('INVALID_ARGUMENT', `This ledger already records a project attempt for this manuscript and workbench. Query its original idempotency_key ${JSON.stringify(value.original_key)} before further action; no new project request was sent.`)
  }
}

async function saveBinding(path: string | undefined, input: ProjectOperationInput): Promise<void> {
  if (path === undefined || input.binding === undefined) return
  await writeFileAtomic(path, `${JSON.stringify({ version: 1, manuscript_id: input.binding.manuscriptId,
    production_type: input.binding.productionType, original_key: input.key })}\n`, { mode: 0o600, dirMode: 0o700 })
}

/**
 * Recover an original operation's data using only its original key, without creating files or contacting the provider.
 * @param ledger - Existing account-scoped write ledger.
 * @param suppliedKey - Original idempotency key, unchanged from the mutation.
 * @returns Verified operation identity and response data, or unknown evidence when either original record is missing.
 */
export async function readProjectOperationReceipt(ledger: JubianLedger, suppliedKey: string): Promise<Record<string, unknown>> {
  const key = requireKey(suppliedKey)
  const foundRecord = await ledger.find(key)
  if (foundRecord?.method === 'document_upload') return await readDocumentUploadReceipt(ledger, key)
  if (foundRecord === undefined) {
    const upload = await readDocumentUploadReceipt(ledger, key)
    if (upload.found === true) return upload
  }
  const path = join(ledger.root, 'operation-receipts', `${hash(key)}.json`)
  const saved = await savedValue(path)
  const record = await ledger.find(key)
  const base = { original_idempotency_key: key, receipt_path: path,
    request_sha256: record?.request_sha256 ?? null, response_sha256: record?.response_sha256 ?? null,
    evidence: { receipt: saved.found ? 'recorded' : 'missing', ledger: record === undefined ? 'missing' : 'recorded',
      ledger_outcome: record?.outcome ?? null, lookup_provider_requests: 0 } }
  if (!saved.found) {
    return { ...base, found: record !== undefined, status: record === undefined ? 'not_found' : 'unknown', data: null,
      operation: record === undefined ? null : { method: record.method, script_id: record.script_id } }
  }
  const value = saved.value
  if (!object(value) || value.version !== 1 || value.key_hash !== hash(key) || !object(value.intent)
    || value.intent_sha256 !== intentHash(value.intent)) return changed('Operation receipt identity or intent hash is invalid')
  const request = requestFrom(value.request)
  if (value.request_sha256 !== bodyHash(identity(request))) return changed('Operation receipt request hash is invalid')
  if (record === undefined) {
    return { ...base, found: true, status: 'unknown', data: null, request_sha256: value.request_sha256,
      operation: null, reason: 'Original ledger record is missing; the receipt cannot be matched to its recorded operation.' }
  }
  const receipt = receiptFrom(value, { key, method: record.method, intent: value.intent,
    ...(record.script_id === null ? {} : { scriptId: record.script_id }) })
  if (record.request_sha256 !== receipt.request_sha256) return changed('Operation receipt differs from the ledger request')
  if (receipt.response !== null && record.response_sha256 !== null
    && receipt.response.response_sha256 !== record.response_sha256) return changed('Operation receipt differs from the ledger response')
  const accepted = receipt.response !== null && acceptedWriteResponse(receipt.response.transport)
  return { ...base, found: true, status: accepted ? 'accepted' : 'unknown', data: receipt.response?.data ?? null,
    response_sha256: receipt.response?.response_sha256 ?? record.response_sha256,
    operation: { method: receipt.method, script_id: receipt.script_id, intent: receipt.intent,
      intent_sha256: receipt.intent_sha256 }, ...(accepted && record.outcome !== 'accepted' ? { settlement_pending: true } : {}) }
}

/**
 * Perform one ledger-protected project write and persist its response before ledger settlement.
 * @param client - Existing authenticated client; credentials and headers are never stored in this receipt.
 * @param ledger - Existing write ledger, which retains the hash of the actual method, path and body.
 * @param input - Stable business fields and a request builder used only when neither a receipt nor ledger record exists.
 * @returns Original response data on replay, or unresolved evidence when the original receipt cannot prove a response.
 */
export async function projectOperation(client: JubianClient, ledger: JubianLedger,
  input: ProjectOperationInput): Promise<ProjectOperationOutcome> {
  const key = requireKey(input.key)
  const binding = input.binding
  if (binding !== undefined) {
    const directory = join(ledger.root, 'manuscript-project-bindings')
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const path = join(directory, `${binding.manuscriptId}-${binding.productionType}.json`)
    return await withFileLock(path, async () => {
      await checkBinding(path, input, binding)
      return await performProjectOperation(client, ledger, input, key, path)
    })
  }
  return await performProjectOperation(client, ledger, input, key)
}

async function performProjectOperation(client: JubianClient, ledger: JubianLedger,
  input: ProjectOperationInput, key: string, bindingPath?: string): Promise<ProjectOperationOutcome> {
  const directory = join(ledger.root, 'operation-receipts')
  const path = join(directory, `${hash(key)}.json`)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  return await withFileLock(path, async () => {
    const prior = await readReceipt(path, input)
    const record = await ledger.find(key)
    if (record === undefined && (await readDocumentUploadReceipt(ledger, key)).found === true) {
      return changed('Idempotency key belongs to a recorded document upload')
    }
    if (record !== undefined && (record.method !== input.method || record.script_id !== (input.scriptId ?? null))) {
      return changed('Idempotency key belongs to a different ledger operation')
    }
    if (prior !== null || record !== undefined) {
      if (prior !== null && record !== undefined && prior.request_sha256 !== record.request_sha256) {
        return changed('Operation receipt differs from the ledger request')
      }
      const response = prior?.response
      if (response !== null && response !== undefined && record?.response_sha256 !== null
        && record?.response_sha256 !== undefined && response.response_sha256 !== record.response_sha256) {
        return changed('Operation receipt differs from the ledger response')
      }
      const accepted = record !== undefined && response !== null && response !== undefined && acceptedWriteResponse(response.transport)
      await saveBinding(bindingPath, input)
      return { replayed: true, outcome: accepted ? 'accepted' : 'unknown',
        data: response?.data ?? null, response_sha256: response?.response_sha256 ?? record?.response_sha256 ?? null,
        receipt_path: path, receipt_status: prior === null ? 'missing' : 'recorded',
        ...(accepted && record.outcome !== 'accepted' ? { settlement_pending: true } : {}) }
    }
    const prepared = await input.prepare()
    const request = requestFrom(JSON.parse(JSON.stringify({ method: prepared.method, path: prepared.path,
      ...(prepared.body === undefined ? {} : { body: prepared.body }) })))
    const receipt: OperationReceipt = { version: 1, key_hash: hash(key), method: input.method,
      script_id: input.scriptId ?? null, intent_sha256: intentHash(input.intent),
      intent: structuredClone(input.intent), request, request_sha256: bodyHash(identity(request)), response: null }
    await saveReceipt(path, receipt)
    await saveBinding(bindingPath, input)
    const result = await writeUnderLedger(ledger, key, input.method, () => identity(request), async () => {
      const response = await client.request({ ...request, ...(prepared.signal === undefined ? {} : { signal: prepared.signal }) })
      receipt.response = { transport: response.transport, response_sha256: response.response_sha256, data: response.data }
      await saveReceipt(path, receipt)
      return response
    }, undefined, { verifyReplayBody: true, ...(input.scriptId === undefined ? {} : { scriptId: input.scriptId }) })
    return { ...result, ...(result.replayed && receipt.response === null ? { outcome: 'unknown' as const, data: null } : {}),
      receipt_path: path, receipt_status: 'recorded' }
  })
}
