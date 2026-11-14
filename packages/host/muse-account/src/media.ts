/** Dynamic Muse-session transport for company media tools and controlled imports. */
import { brandString } from '@deepseek-ai/dsh-brand'
import { z } from 'zod'
import { museGatewayOrigin } from './gateway.ts'
import { readMuseSession } from './session.ts'
import type { MuseStoredSession } from './session.ts'
import type {
  MuseMediaDataAction, MuseMediaDataParameters, MuseMediaDownloadRequest, MuseMediaFailure, MuseMediaJobId,
  MuseMediaJobPage, MuseMediaJson, MuseMediaOptions, MuseMediaReceipt, MuseMediaRequestId, MuseMediaStatus, MuseMediaTransfer,
} from './media-types.ts'

const jobId = z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u)
  .transform(value => brandString<MuseMediaJobId>(value))
const requestId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u).transform(value => brandString<MuseMediaRequestId>(value))
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
/** Gateway manifest filenames are preserved exactly for owned retrieval and local import. */
export const mediaFileNameSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._() -]{0,127}$/u).refine(value => !value.includes('..'))
const file = z.object({
  name: mediaFileNameSchema,
  bytes: count.positive(), sha256: z.string().regex(/^[a-f0-9]{64}$/u), kind: z.enum(['video', 'image', 'cover', 'live_video', 'metadata']),
})
const coverage = z.object({
  reported: count.nullable(), accepted: count, rejected: count.nullable(), complete: z.boolean(), truncated: z.boolean(),
})
  .refine(value => value.reported === null || value.rejected === null || value.reported === value.accepted + value.rejected)
  .refine(value => !value.complete || value.reported === value.accepted && value.rejected === 0 && value.accepted > 0 && !value.truncated)
const privateFields = new Set([
  'raw', 'task_id', 'download_id', 'cookie', 'authorization', 'api_key', 'access_token', 'refresh_token',
  'password', 'secret', 'directory', 'file_path', 'server_path', '__proto__', 'prototype', 'constructor',
])

function publicValue(value: unknown, depth = 0): value is MuseMediaJson {
  if (depth > 16) return false
  if (Array.isArray(value)) return value.length <= 1000 && value.every(item => publicValue(item, depth + 1))
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).every(([key, item]) => !privateFields.has(key.toLowerCase()) && publicValue(item, depth + 1))
  }
  return value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)
}

const source = z.custom<MuseMediaJson>(value => publicValue(value))
const receipt = z.object({
  state: z.enum(['ok', 'pending', 'unconfirmed', 'cloud_saved', 'partial', 'failed']),
  job_id: jobId.optional(), request_id: requestId.optional(),
  tool: z.enum([
    'parse_url', 'get_video', 'get_user', 'list_user_posts', 'list_comments', 'get_content_history', 'download_media', 'get_task_result',
  ]).optional(),
  files: z.array(file).max(128).optional(), file_coverage: coverage.optional(),
  code: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/u).optional(), retry_after: count.positive().optional(),
  created_at: z.number().nonnegative().optional(), updated_at: z.number().nonnegative().optional(),
  automatic_resubmit: z.literal(false).optional(), reservation_active: z.boolean().optional(),
  next_action: z.enum(['query_original', 'inspect_receipt']).optional(), data: source.optional(),
  status: z.enum(['ok', 'pending']).optional(), platform: z.enum(['douyin', 'tiktok', 'bilibili']).optional(),
  resource: z.string().max(64).optional(), content_id: z.string().max(256).optional(), uid: z.string().max(256).optional(),
  url: z.string().max(8192).optional(), cached: z.boolean().optional(), guest_fallback: z.boolean().optional(),
  cursor: z.string().max(4096).nullable().optional(), has_more: z.boolean().optional(),
  truncated: z.boolean().optional(), projection_truncated: z.boolean().optional(),
  since: z.string().max(64).optional(), point_count: count.optional(), points: z.array(source).max(500).optional(),
}).superRefine((value, context) => {
  if (value.state !== 'failed' && (value.job_id === undefined || value.files === undefined)) {
    context.addIssue({ code: 'custom', message: 'A cloud receipt requires its job and files.' })
  }
  if (value.state === 'failed' && value.code === undefined) {
    context.addIssue({ code: 'custom', message: 'A failure requires a fixed code.' })
  }
  if (value.state === 'cloud_saved' && (!value.files?.length || value.file_coverage?.complete !== true)) {
    context.addIssue({ code: 'custom', message: 'Saved media requires a complete file manifest.' })
  }
  if (value.state === 'partial' && !value.files?.length) {
    context.addIssue({ code: 'custom', message: 'Partial media requires at least one file.' })
  }
  if (value.files !== undefined && new Set(value.files.map(item => item.name)).size !== value.files.length) {
    context.addIssue({ code: 'custom', message: 'File names must be unique.' })
  }
})
const page = z.object({ jobs: z.array(receipt).max(1000), next_offset: count.nullable() })
const status = z.object({ ready: z.boolean(), limits: z.object({
  requests_per_minute: count.positive(), concurrent_requests: count.positive(),
  downloads_per_day: count.positive(), concurrent_downloads: count.positive(),
}) })
const rpc = z.object({ jsonrpc: z.literal('2.0'), id: z.string(), result: z.object({ isError: z.boolean(), structuredContent: receipt }) })

/** Fixed media failure; neither upstream response bodies nor credentials are retained. */
export class MuseMediaError extends Error {
  /**
   * @param code - Safe product failure.
   * @param retryAfter - Optional server delay in seconds.
   */
  constructor(readonly code: MuseMediaFailure, readonly retryAfter?: number) {
    super(`Muse media: ${code}`)
  }
}

interface Operation {
  readonly session: MuseStoredSession
  readonly signal: AbortSignal
  readonly assertCurrent: () => Promise<void>
  afterCommit?: () => Promise<void>
}

function retryAfter(response: Response): number | undefined {
  const header = response.headers.get('retry-after')
  if (header === null) return undefined
  const seconds = /^\d+$/u.test(header) ? Number(header) : Math.ceil((Date.parse(header) - Date.now()) / 1000)
  return Number.isSafeInteger(seconds) && seconds > 0 && seconds <= 604800 ? seconds : undefined
}

async function cancelBody(response: Response | undefined): Promise<void> {
  if (response === undefined || response.bodyUsed) return
  try { await response.body?.cancel() }
  catch (_error) { /* The fixed operation failure is preserved when cleanup encounters a closed body. */ }
}

/** Owns current-login requests, streams and import callbacks until disposal has settled. */
export class MuseMediaClient {
  private readonly origin: string
  private readonly stop = new AbortController()
  private readonly pending = new Set<Promise<unknown>>()

  /** @param options - Product origin, private account file and validated independent limits. */
  constructor(private readonly options: MuseMediaOptions) {
    this.origin = museGatewayOrigin(options.baseUrl)
  }

  /**
   * Read public platform data through the current account.
   * @param action - Public read tool.
   * @param parameters - That tool's parameters.
   * @param signal - Optional caller cancellation.
   * @returns Public receipt without credentials.
   */
  async data<Action extends MuseMediaDataAction>(
    action: Action, parameters: MuseMediaDataParameters[Action], signal?: AbortSignal,
  ): Promise<MuseMediaReceipt> {
    return await this.run(signal, false, false, operation => this.call(operation, action, parameters))
  }

  /**
   * Submit one cloud download with a stable account-owned key.
   * Receipts identifying a job must acknowledge this request key.
   * @param request - Stable submission key and media target.
   * @param signal - Optional caller cancellation.
   * @returns Cloud receipt; no automatic retry is performed.
   */
  async download(request: MuseMediaDownloadRequest, signal?: AbortSignal): Promise<MuseMediaReceipt> {
    const { requestId: key, ...target } = request
    return await this.run(signal, false, true, async (operation) => {
      const value = await this.call(operation, 'download_media', { ...target, request_id: key })
      if (value.job_id !== undefined && value.request_id !== key) throw new MuseMediaError('invalid-response')
      return value
    })
  }

  /**
   * Reconcile an owned receipt without resubmitting its download.
   * @param id - Owned company receipt ID.
   * @param signal - Optional caller cancellation.
   * @returns Reconciled cloud receipt.
   */
  async get(id: MuseMediaJobId, signal?: AbortSignal): Promise<MuseMediaReceipt> {
    return await this.run(signal, false, false, operation => this.getReceipt(operation, id))
  }

  /**
   * List the current account's cloud receipts.
   * @param signal - Optional caller cancellation.
   * @param offset - Omitted starts the first page.
   * @returns Only the current account's receipts and continuation.
   */
  async list(signal?: AbortSignal, offset = 0): Promise<MuseMediaJobPage> {
    return await this.run(signal, false, false, async operation => this.parse(
      page, await this.json(operation, `/api/media/jobs?offset=${encodeURIComponent(offset)}`),
    ))
  }

  /**
   * Read service readiness and the current account's limits.
   * @param signal - Optional caller cancellation.
   * @returns Readiness and current-account limits, without global identity-pool information.
   */
  async status(signal?: AbortSignal): Promise<MuseMediaStatus> {
    return await this.run(signal, false, false, async operation => this.parse(status, await this.json(operation, '/api/media/status')))
  }

  /**
   * Keep one original login and lifecycle through file verification and publication.
   * @param id - Owned company receipt ID.
   * @param name - Exact persisted manifest name.
   * @param consume - Consume the whole stream, using assertCurrent before and after publishing files.
   * @param signal - Optional caller cancellation, also provided to the consumer.
   * @param confirmImport - Native importer confirmation after hash, decoding and publication; ordinary reads leave it false.
   * @returns Consumer result after complete consumption and a final account check;
   * an unconfirmed cloud receipt retains longer protection.
   */
  async withFile<Result>(
    id: MuseMediaJobId, name: string, consume: (transfer: MuseMediaTransfer) => Promise<Result>,
    signal?: AbortSignal, confirmImport = false,
  ): Promise<Result> {
    return await this.run(signal, true, false, async (operation) => {
      const job = await this.getReceipt(operation, id)
      const entry = job.files?.find(item => item.name === name)
      if ((job.state !== 'cloud_saved' && job.state !== 'partial') || entry === undefined) throw new MuseMediaError('not-found')
      if (entry.bytes > this.options.maxFileBytes) throw new MuseMediaError('file-too-large')
      await operation.assertCurrent()
      let response: Response | undefined
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
      let cancellation: Promise<void> | undefined
      const abort = (): void => {
        cancellation ??= reader?.cancel().catch((_error: unknown) => {
          /* The body may already have failed when its transport closes. */
        })
      }
      try {
        response = await this.fetch(operation, `/api/media/jobs/${encodeURIComponent(id)}/files/${encodeURIComponent(entry.name)}`)
        const declared = response.headers.get('content-length')
        if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) !== entry.bytes)) throw new MuseMediaError('file-incomplete')
        reader = response.body?.getReader()
        if (reader === undefined) throw new MuseMediaError('invalid-response')
        const sourceReader = reader
        const consumption = { bytes: 0, complete: false }
        operation.signal.addEventListener('abort', abort, { once: true })
        operation.signal.throwIfAborted()
        const body = new ReadableStream<Uint8Array>({
          pull: async (controller) => {
            try {
              operation.signal.throwIfAborted()
              const next = await sourceReader.read()
              operation.signal.throwIfAborted()
              if (next.done) {
                if (consumption.bytes !== entry.bytes) throw new MuseMediaError('file-incomplete')
                consumption.complete = true
                controller.close()
              } else {
                consumption.bytes += next.value.byteLength
                if (consumption.bytes > this.options.maxFileBytes) throw new MuseMediaError('file-too-large')
                if (consumption.bytes > entry.bytes) throw new MuseMediaError('file-incomplete')
                controller.enqueue(next.value)
              }
            } catch (error) {
              controller.error(error instanceof MuseMediaError || operation.signal.aborted ? error : new MuseMediaError('unavailable'))
            }
          },
          cancel: async () => { await sourceReader.cancel() },
        })
        const result = await consume({ body, file: entry, job, signal: operation.signal, assertCurrent: operation.assertCurrent })
        if (!consumption.complete) throw new MuseMediaError('file-incomplete')
        await operation.assertCurrent()
        const lease = response.headers.get('x-muse-media-lease')
        if (confirmImport && lease !== null && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(lease)) {
          operation.afterCommit = async () => {
            try {
              const acknowledgement = await this.json(operation,
                `/api/media/jobs/${encodeURIComponent(id)}/files/${encodeURIComponent(entry.name)}/imported`,
                JSON.stringify({ lease, sha256: entry.sha256 }))
              this.parse(z.object({ state: z.literal('acknowledged') }), acknowledgement)
            } catch (_error) {
              // Confirmation cannot undo a local file committed before the account or transport changed.
            }
          }
        }
        return result
      } finally {
        operation.signal.removeEventListener('abort', abort)
        if (reader !== undefined) {
          try { await (cancellation ?? reader.cancel()) }
          catch (_error) { /* Consumer and account failures remain authoritative after a closed stream. */ }
          reader.releaseLock()
        } else { await cancelBody(response) }
      }
    })
  }

  /** Abort requests and import callbacks, then wait for all owned work to finish. */
  async dispose(): Promise<void> {
    this.stop.abort()
    await Promise.allSettled([...this.pending])
  }

  private async run<Result>(
    caller: AbortSignal | undefined, fileOperation: boolean, submission: boolean, execute: (operation: Operation) => Promise<Result>,
  ): Promise<Result> {
    const operation = this.operation(caller, fileOperation, submission, execute)
    this.pending.add(operation)
    try { return await operation }
    finally { this.pending.delete(operation) }
  }

  private async operation<Result>(
    caller: AbortSignal | undefined, fileOperation: boolean, submission: boolean, execute: (operation: Operation) => Promise<Result>,
  ): Promise<Result> {
    const timeout = AbortSignal.timeout(fileOperation ? this.options.fileTimeoutMs : this.options.requestTimeoutMs)
    const signal = AbortSignal.any([this.stop.signal, timeout, ...(caller === undefined ? [] : [caller])])
    try {
      signal.throwIfAborted()
      let session: MuseStoredSession | null
      try { session = await readMuseSession(this.options.sessionFile, this.origin) }
      catch (_error) { throw new MuseMediaError('unavailable') }
      signal.throwIfAborted()
      if (session === null) throw new MuseMediaError('sign-in-required')
      const original = session
      const assertCurrent = async (): Promise<void> => {
        signal.throwIfAborted()
        let current: MuseStoredSession | null
        try { current = await readMuseSession(this.options.sessionFile, this.origin) }
        catch (_error) { throw new MuseMediaError('account-changed') }
        signal.throwIfAborted()
        if (current?.revision !== original.revision) throw new MuseMediaError('account-changed')
      }
      const operation: Operation = { session: original, signal, assertCurrent }
      const result = await execute(operation)
      await assertCurrent()
      await operation.afterCommit?.()
      return result
    } catch (error) {
      if (caller?.aborted === true || this.stop.signal.aborted) throw new MuseMediaError('cancelled')
      if (timeout.aborted) throw new MuseMediaError(submission ? 'unconfirmed' : 'timeout')
      throw error
    }
  }

  private parse<Schema extends z.ZodType>(schema: Schema, value: unknown): z.output<Schema> {
    try {
      const parsed = schema.safeParse(value)
      if (!parsed.success) throw new MuseMediaError('invalid-response')
      return parsed.data
    } catch (_error) { throw new MuseMediaError('invalid-response') }
  }

  private async fetch(operation: Operation, path: string, body?: string): Promise<Response> {
    await operation.assertCurrent()
    let response: Response
    try {
      response = await (this.options.fetcher ?? fetch)(new URL(path, this.origin), {
        method: body === undefined ? 'GET' : 'POST', redirect: 'manual', signal: operation.signal,
        headers: { cookie: operation.session.cookie, origin: this.origin, accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body }),
      })
    } catch (_error) { throw new MuseMediaError(body === undefined ? 'unavailable' : 'unconfirmed') }
    if (response.status === 200) return response
    try {
      if (response.status === 401 || response.status === 303) throw new MuseMediaError('sign-in-required')
      if (response.status === 403) throw new MuseMediaError('company-access-required')
      if (response.status === 429) throw new MuseMediaError('rate-limited', retryAfter(response))
      if (response.status === 404) throw new MuseMediaError('not-found')
      if (response.status === 409) throw new MuseMediaError('request-conflict')
      if ([400, 413, 415, 422].includes(response.status)) throw new MuseMediaError('invalid-input')
      throw new MuseMediaError(response.status >= 500 && body !== undefined ? 'unconfirmed' : 'unavailable')
    } finally { await cancelBody(response) }
  }

  private async json(operation: Operation, path: string, body?: string): Promise<unknown> {
    const response = await this.fetch(operation, path, body)
    const reader = response.body?.getReader()
    if (reader === undefined) throw new MuseMediaError('invalid-response')
    let cancellation: Promise<void> | undefined
    const abort = (): void => {
      cancellation ??= reader.cancel().catch((_error: unknown) => {
        /* The body may already have failed when its transport closes. */
      })
    }
    const chunks: Uint8Array[] = []
    let bytes = 0
    try {
      operation.signal.addEventListener('abort', abort, { once: true })
      operation.signal.throwIfAborted()
      if (response.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json') throw new MuseMediaError('invalid-response')
      const declared = response.headers.get('content-length')
      if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > this.options.maxReplyBytes)) {
        throw new MuseMediaError('invalid-response')
      }
      for (;;) {
        const next = await reader.read()
        operation.signal.throwIfAborted()
        if (next.done) break
        bytes += next.value.byteLength
        if (bytes > this.options.maxReplyBytes) throw new MuseMediaError('invalid-response')
        chunks.push(next.value)
      }
      const buffer = new Uint8Array(bytes)
      let offset = 0
      for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.byteLength }
      const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer)
      if (text.includes(operation.session.cookie) || text.includes(operation.session.cookie.slice('__Host-muse='.length))) {
        throw new MuseMediaError('invalid-response')
      }
      const value: unknown = JSON.parse(text)
      return value
    } catch (error) {
      if (error instanceof MuseMediaError) throw error
      throw new MuseMediaError('invalid-response')
    } finally {
      operation.signal.removeEventListener('abort', abort)
      try { await (cancellation ?? reader.cancel()) }
      catch (_error) { /* A failed transport can reject body cleanup without changing the safe error. */ }
      reader.releaseLock()
    }
  }

  private async call(operation: Operation, name: MuseMediaDataAction | 'download_media', args: object): Promise<MuseMediaReceipt> {
    const id = globalThis.crypto.randomUUID()
    const value = this.parse(rpc, await this.json(operation, '/api/media/mcp/', JSON.stringify({
      jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args },
    })))
    if (value.id !== id || value.result.isError !== (value.result.structuredContent.state === 'failed')) {
      throw new MuseMediaError('invalid-response')
    }
    return value.result.structuredContent
  }

  private async getReceipt(operation: Operation, id: MuseMediaJobId): Promise<MuseMediaReceipt> {
    const value = this.parse(receipt, await this.json(operation, `/api/media/jobs/${encodeURIComponent(id)}`))
    if (value.job_id !== id) throw new MuseMediaError('invalid-response')
    return value
  }
}
