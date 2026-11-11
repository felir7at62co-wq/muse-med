/** Upload screenplay documents through the workbench's existing TOS destination without parsing or modifying their contents. */
import { createHash, randomBytes } from 'node:crypto'
import { mkdir, open, readFile } from 'node:fs/promises'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { basename, extname, isAbsolute, join, resolve } from 'node:path'
import { JubianError, type JubianLedger } from '@deepseek-ai/dsh-jubian'
import { buildDocumentObjectKey, signTosObjectPut } from '@deepseek-ai/dsh-jubian-api'
import { loadTosConfig, putObject } from './reference.ts'
import { requireKey } from './write.ts'
import type { ReferenceUploadDeps } from './reference.ts'

/** Local resource limits, independent of the provider's unspecified document-size limit. */
export interface DocumentUploadOptions {
  /** Largest local document this deployment permits, in bytes. */
  maxBytes: number
  /** Caller cancellation; omission leaves cancellation to the optional timeout. */
  signal?: AbortSignal | undefined
  /** Total operation time limit; omission applies no separate upload timeout. */
  timeoutMs?: number | undefined
}

/** Transport and clock overrides used by document-upload tests and callers. */
export type DocumentUploadDeps = Pick<ReferenceUploadDeps, 'fetch' | 'now'>

/** A document's suffix and upload media type; only its container signature is inspected. */
interface DocumentFormat {
  format: 'doc' | 'docx' | 'txt'
  contentType: string
  extension: string
}

function invalid(detail: string): never {
  throw new JubianError('INVALID_ARGUMENT', detail)
}

function describeFormat(path: string, bytes: Uint8Array): DocumentFormat {
  const extension = extname(path).toLowerCase()
  if (extension === '.doc') {
    if (![0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1].every((byte, index) => bytes[index] === byte)) {
      return invalid('document_path has a .doc suffix but is not a Compound File document; no upload was attempted')
    }
    return { format: 'doc', contentType: 'application/msword', extension }
  }
  if (extension === '.docx') {
    if (![0x50, 0x4b, 0x03, 0x04].every((byte, index) => bytes[index] === byte)) {
      return invalid('document_path has a .docx suffix but is not a ZIP document; no upload was attempted')
    }
    return { format: 'docx', contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', extension }
  }
  if (extension === '.txt') {
    let text: string
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch (error) {
      // Invalid UTF-8 would change the screenplay if silently decoded with replacement characters.
      if (error instanceof TypeError) return invalid('TXT documents must contain valid UTF-8 text; no upload was attempted')
      throw error
    }
    if (!text.trim() || text.includes('\0')) return invalid('TXT documents must contain nonempty text without NUL characters; no upload was attempted')
    return { format: 'txt', contentType: 'text/plain; charset=utf-8', extension }
  }
  return invalid('document_path must name a .doc, .docx or UTF-8 .txt file; no upload was attempted')
}

interface DocumentReceipt {
  version: 1
  method: 'document_upload'
  key_sha256: string
  source: string
  request_sha256: string
  document: Record<string, unknown>
  uploaded: boolean
}

function hash(value: string): string { return createHash('sha256').update(value).digest('hex') }
function requestHash(source: string, document: Record<string, unknown>): string {
  return `sha256:${hash(JSON.stringify({ source, document }))}`
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
async function loadReceipt(path: string, key: string): Promise<DocumentReceipt | null> {
  let text: string
  try { text = await readFile(path, 'utf8') }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null
    throw error
  }
  const value: unknown = JSON.parse(text)
  if (!object(value) || value.version !== 1 || value.method !== 'document_upload' || value.key_sha256 !== hash(key)
    || typeof value.source !== 'string' || !object(value.document) || typeof value.uploaded !== 'boolean'
    || value.request_sha256 !== requestHash(value.source, value.document)) {
    throw new JubianError('CONTRACT_CHANGED', 'Document upload receipt is unreadable or changed; no upload was attempted')
  }
  return { version: 1, method: 'document_upload', key_sha256: value.key_sha256, source: value.source,
    document: value.document, request_sha256: value.request_sha256, uploaded: value.uploaded }
}
async function saveReceipt(path: string, receipt: DocumentReceipt): Promise<void> {
  await writeFileAtomic(path, `${JSON.stringify(receipt)}\n`, { mode: 0o600, dirMode: 0o700 })
}
function receiptPath(ledger: JubianLedger, key: string): string {
  return join(ledger.root, 'document-upload-receipts', `${hash(key)}.json`)
}
async function originalUpload(ledger: JubianLedger, key: string, source?: string): Promise<Record<string, unknown> | null> {
  const receipt = await loadReceipt(receiptPath(ledger, key), key)
  const record = await ledger.find(key)
  if (record !== undefined && record.method !== 'document_upload') {
    throw new JubianError('CONTRACT_CHANGED', 'Idempotency key belongs to a different operation')
  }
  if (receipt === null && record === undefined) return null
  if (receipt !== null && source !== undefined && receipt.source !== source) {
    throw new JubianError('CONTRACT_CHANGED', 'Idempotency key belongs to a different document path')
  }
  if (receipt !== null && record !== undefined && record.request_sha256 !== receipt.request_sha256) {
    throw new JubianError('CONTRACT_CHANGED', 'Document upload receipt differs from the ledger')
  }
  const accepted = receipt !== null && receipt.uploaded && record !== undefined
  return { ...(accepted ? receipt.document : {}), uploaded: accepted, replayed: true, found: true,
    status: accepted ? 'accepted' : 'unknown',
    outcome: accepted ? 'accepted' : 'unknown', original_idempotency_key: key, receipt_path: receiptPath(ledger, key),
    receipt_status: receipt === null ? 'missing' : 'recorded', paidRequests: 0,
    request_sha256: receipt?.request_sha256 ?? record?.request_sha256 ?? null,
    original_file_sha256: receipt?.document.sha256 ?? null,
    ...(accepted && record.outcome !== 'accepted' ? { settlement_pending: true } : {}),
    original_source: receipt?.source ?? null, source_reread: false,
    ...(!accepted ? { next: 'Upload outcome is unknown. Retain the original key and receipt; do not upload again or register an unverified URL.' } : {}) }
}

/**
 * Read an original upload receipt without opening the source or contacting the provider.
 * @param ledger - Original account write ledger.
 * @param suppliedKey - Stable key used for the upload.
 * @returns Original document metadata or unresolved evidence; this read creates no files.
 */
export async function readDocumentUploadReceipt(ledger: JubianLedger, suppliedKey: string): Promise<Record<string, unknown>> {
  const key = requireKey(suppliedKey)
  return await originalUpload(ledger, key) ?? { uploaded: false, found: false, status: 'not_found',
    original_idempotency_key: key, paidRequests: 0 }
}

async function readDocument(source: string, options: DocumentUploadOptions): Promise<Uint8Array> {
  const extension = extname(source).toLowerCase()
  if (!['.doc', '.docx', '.txt'].includes(extension)) return invalid('document_path must name a .doc, .docx or UTF-8 .txt file; no upload was attempted')
  let bytes: Uint8Array
  try {
    const handle = await open(source, 'r')
    try {
      const stat = await handle.stat()
      if (!stat.isFile()) return invalid('document_path must name a regular local file; no upload was attempted')
      if (stat.size < 1 || stat.size > options.maxBytes) return invalid(`Document must contain 1 to ${options.maxBytes} bytes under this Muse deployment's local limit; no upload was attempted`)
      const buffer = new Uint8Array(stat.size + 1)
      let length = 0
      while (length < buffer.length) {
        options.signal?.throwIfAborted()
        const read = await handle.read(buffer, length, buffer.length - length, null)
        if (read.bytesRead === 0) break
        length += read.bytesRead
      }
      if (length !== stat.size) return invalid('Document changed while being read; no upload was attempted')
      const after = await handle.stat()
      if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) {
        return invalid('Document changed while being read; no upload was attempted')
      }
      bytes = buffer.subarray(0, length)
    } finally {
      await handle.close()
    }
  } catch (error) {
    if (options.signal?.aborted) throw options.signal.reason
    if (error instanceof JubianError) throw error
    return invalid('document_path could not be read as a local file; verify the path and permissions; no upload was attempted')
  }
  return bytes
}

/**
 * Upload unchanged document bytes once under a durable original-key receipt.
 * @param ledger - Account-scoped write ledger and local receipt directory.
 * @param args - Exact local document path and stable upload key; replay returns its original bytes hash without rereading the source.
 * @param options - Deployment-owned file-size limit, independent of provider limits.
 * @param deps - Optional HTTP transport and clock overrides.
 * @returns Uploaded public URL and file metadata, or unknown original-operation evidence; screenplay content remains unverified.
 */
export async function uploadDocumentMethod(ledger: JubianLedger,
  args: { document_path?: string | undefined; idempotency_key?: string | undefined }, options: DocumentUploadOptions,
  deps: DocumentUploadDeps = {}): Promise<Record<string, unknown>> {
  const key = requireKey(args.idempotency_key)
  const path = args.document_path
  if (path === undefined || !path.trim() || !isAbsolute(path)) return invalid('upload_document requires an absolute document_path')
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1) return invalid('document upload maxBytes must be a positive safe integer')
  if (options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs)
    || options.timeoutMs < 1 || options.timeoutMs > 2147483647)) {
    return invalid('document upload timeoutMs must be an integer within 1..2147483647')
  }
  const timeout = options.timeoutMs === undefined ? undefined : AbortSignal.timeout(options.timeoutMs)
  const signal = options.signal === undefined ? timeout
    : timeout === undefined ? options.signal : AbortSignal.any([options.signal, timeout])
  signal?.throwIfAborted()
  const source = resolve(path)
  const directory = join(ledger.root, 'document-upload-receipts')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  return await withFileLock(receiptPath(ledger, key), async () => {
    signal?.throwIfAborted()
    const prior = await originalUpload(ledger, key, source)
    if (prior !== null) return prior
    const bytes = await readDocument(source, { ...options, signal })
    const descriptor = describeFormat(source, bytes)
    const baseTransport = deps.fetch ?? fetch
    const transport: typeof fetch = async (input, init) => {
      signal?.throwIfAborted()
      return await baseTransport(input, { ...init, ...(signal === undefined ? {} : { signal }) })
    }
    const now = deps.now?.() ?? new Date()
    const objectKey = buildDocumentObjectKey(now, randomBytes(16).toString('hex'), descriptor.extension)
    const config = await loadTosConfig(transport)
    const signed = signTosObjectPut({ config, key: objectKey, payload: bytes, content_type: descriptor.contentType, now })
    const document = { material_url: signed.url, object_key: objectKey, file_name: basename(source),
      format: descriptor.format, content_type: descriptor.contentType, bytes: bytes.byteLength,
      sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`, format_validation: 'container_signature' }
    const receipt: DocumentReceipt = { version: 1, method: 'document_upload', key_sha256: hash(key), source,
      document, request_sha256: requestHash(source, document), uploaded: false }
    await saveReceipt(receiptPath(ledger, key), receipt)
    const intent = await ledger.begin({ idempotencyKey: key, method: 'document_upload', requestSha256: receipt.request_sha256 })
    if (intent.replayed) return await readDocumentUploadReceipt(ledger, key)
    let httpStatus: number
    try { httpStatus = await putObject(transport, signed.url, signed.headers, bytes) }
    catch (error) {
      await ledger.settle(key, { httpStatus: null, applicationCode: null, responseSha256: null, outcome: 'unknown' })
      throw error
    }
    receipt.uploaded = true
    await saveReceipt(receiptPath(ledger, key), receipt)
    await ledger.settle(key, { httpStatus, applicationCode: null,
      responseSha256: null, outcome: 'accepted' })
    return { ...document, uploaded: true, replayed: false, outcome: 'accepted', paidRequests: 0,
      original_idempotency_key: key, receipt_path: receiptPath(ledger, key), receipt_status: 'recorded',
      original_source: source, source_reread: true }
  })
}
