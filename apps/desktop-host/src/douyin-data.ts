/** Bounded data IPC consumer; only projected page facts reach the initiating Agent. */
import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {
  DouyinTaskId, DouyinVideoId, DouyinCommentId, DouyinDataRequestId, DouyinDataCode, DouyinDataCount, DouyinDataComments,
  DouyinDataSelection, DouyinDataSnapshot, DouyinDesktopDataRequest, DouyinDesktopDataResult,
} from '@deepseek-ai/dsh-client-ui-sidebar-browser/types'

const codes: readonly DouyinDataCode[] = [
  'OK', 'RELEASED', 'HOST_UNAVAILABLE', 'TRANSPORT_TIMEOUT', 'SESSION_NOT_VISIBLE', 'BUSY',
  'INVALID_REQUEST', 'INVALID_URL', 'INVALID_RESULT', 'CANCELLED', 'WORKSPACE_UNAVAILABLE',
  'UI_UNAVAILABLE', 'LEASE_RELEASED', 'DOCUMENT_CHANGED', 'TARGET_MISMATCH',
  'LOGIN_OR_VERIFICATION_REQUIRED', 'PUBLIC_DATA_UNAVAILABLE', 'CREATOR_DATA_UNAVAILABLE',
  'CREATOR_OWNERSHIP_UNVERIFIED', 'COMMENTS_UNAVAILABLE', 'COMMENTS_CURSOR_UNAVAILABLE', 'EXPIRED',
]
function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}
function count(value: unknown): DouyinDataCount | undefined {
  const item = record(value)
  if (item === undefined) return undefined
  if (item.value === null && item.precision === 'unavailable'
    && (item.reason === 'not-exposed' || item.reason === 'missing' || item.reason === 'invalid')) {
    return { value: null, precision: 'unavailable', reason: item.reason }
  }
  if (typeof item.value !== 'number' || !Number.isSafeInteger(item.value) || item.value < 0
    || (item.precision !== 'exact' && item.precision !== 'rounded')
    || (item.display !== undefined && (typeof item.display !== 'string' || item.display.length > 64 || /[\x00-\x1f]/.test(item.display)))) return undefined
  return { value: item.value, precision: item.precision, ...(item.display === undefined ? {} : { display: item.display }) }
}
function nullableInteger(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
}
function comments(value: unknown): DouyinDataComments | undefined {
  const item = record(value)
  if (item === undefined || !Array.isArray(item.items) || item.items.length > 200
    || (item.status !== 'not-requested' && item.status !== 'available' && item.status !== 'blocked')
    || (item.cursor !== null && (typeof item.cursor !== 'string' || !/^\d{1,64}$/.test(item.cursor)))
    || (item.hasMore !== null && typeof item.hasMore !== 'boolean')
    || (item.code !== undefined && item.code !== 'COMMENTS_UNAVAILABLE' && item.code !== 'COMMENTS_CURSOR_UNAVAILABLE')
    || (item.status !== 'available' && (item.items.length > 0 || item.cursor !== null || item.hasMore !== null))
    || (item.status === 'blocked' ? item.code === undefined : item.code !== undefined)) return undefined
  const items: DouyinDataComments['items'][number][] = []
  for (const raw of item.items) {
    const comment = record(raw)
    if (comment === undefined || typeof comment.id !== 'string' || !/^\d{1,25}$/.test(comment.id)
      || typeof comment.text !== 'string' || comment.text.length > 10_000 || comment.text.includes('\0')
      || !nullableInteger(comment.digg_count) || !nullableInteger(comment.create_time)
      || !nullableInteger(comment.reply_comment_total)) return undefined
    items.push({ id: comment.id as DouyinCommentId, text: comment.text, digg_count: comment.digg_count,
      create_time: comment.create_time, reply_comment_total: comment.reply_comment_total })
  }
  if (new Set(items.map(comment => comment.id)).size !== items.length) return undefined
  return { status: item.status, items, cursor: item.cursor, hasMore: item.hasMore,
    ...(item.code === undefined ? {} : { code: item.code }) }
}

/** @param value - Untrusted Main IPC response. @returns Validated, credential-free fields or undefined. */
export function dataResult(value: unknown): DouyinDesktopDataResult | undefined {
  const result = record(value)
  if (result === undefined || result.type !== 'douyin-browser-data-result'
    || typeof result.requestId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(result.requestId)
    || typeof result.code !== 'string' || !codes.includes(result.code as DouyinDataCode)) return undefined
  if (result.code !== 'OK') return result.data === undefined
    ? { type: 'douyin-browser-data-result', requestId: result.requestId as DouyinDataRequestId, code: result.code as DouyinDataCode } : undefined
  const data = record(result.data), values = record(data?.counts)
  if (data?.status !== 'ok' || (data.source !== 'public-page' && data.source !== 'creator-page')
    || typeof data.targetVideoId !== 'string' || !/^\d{10,25}$/.test(data.targetVideoId)
    || typeof data.observedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(data.observedAt)
    || Number.isNaN(Date.parse(data.observedAt)) || values === undefined) return undefined
  const play_count = count(values.play_count), digg_count = count(values.digg_count), comment_count = count(values.comment_count),
    share_count = count(values.share_count), collect_count = count(values.collect_count), pageComments = comments(data.comments)
  if (play_count === undefined || digg_count === undefined || comment_count === undefined
    || share_count === undefined || collect_count === undefined || pageComments === undefined) return undefined
  return { type: 'douyin-browser-data-result', requestId: result.requestId as DouyinDataRequestId, code: 'OK', data: {
    status: 'ok', source: data.source, targetVideoId: data.targetVideoId as DouyinVideoId, observedAt: data.observedAt,
    counts: { play_count, digg_count, comment_count, share_count, collect_count }, comments: pageComments,
  } }
}

/** Unavailable page observations carry fixed diagnostics. */
export interface DouyinDataBlocked { readonly status: 'blocked'; readonly code: DouyinDataCode }
/**
 * Data-only acquisition method used by the version 4 browser service.
 * @param agent - Initiating Agent with a canonical workspace.
 * @param selection - Validated official page and bounded observation options.
 * @param signal - Tool cancellation lifetime.
 * @returns Safe page facts or a fixed blocked result; cancellation rejects after release settles.
 */
export type DouyinDataMethod = (
  agent: Agent, selection: DouyinDataSelection, signal: AbortSignal,
) => Promise<DouyinDataSnapshot | DouyinDataBlocked>

/** @param ctx - Booted Desktop Host. @returns An owned data method whose disposal joins all pending reads and releases. */
export function installDesktopDouyinData(ctx: Context): DouyinDataMethod {
  const pending = new Map<string, { resolve: (result: DouyinDesktopDataResult) => void; timer: ReturnType<typeof setTimeout> }>()
  const running = new Set<Promise<DouyinDataSnapshot | DouyinDataBlocked>>()
  const lifetime = new AbortController()
  let closing = false
  const answer = (raw: unknown): void => {
    const result = dataResult(raw)
    if (result === undefined) return
    const item = pending.get(result.requestId)
    if (item === undefined) return
    clearTimeout(item.timer)
    pending.delete(result.requestId)
    item.resolve(result)
  }
  const send = (request: DouyinDesktopDataRequest): Promise<DouyinDesktopDataResult> => new Promise((resolve) => {
    const fail = (code: DouyinDataCode): void =>{  answer({ type: 'douyin-browser-data-result', requestId: request.requestId, code }) }
    pending.set(request.requestId, { resolve, timer: setTimeout(() => { fail('TRANSPORT_TIMEOUT') }, request.selection.timeoutMs + 10_000) })
    if (closing || !process.connected || process.send === undefined) { fail('HOST_UNAVAILABLE'); return }
    process.send(request, (error) => { if (error !== null) fail('HOST_UNAVAILABLE') })
  })
  const disconnect = (): void => {
    closing = true
    lifetime.abort()
    for (const requestId of [...pending.keys()]) answer({ type: 'douyin-browser-data-result', requestId, code: 'HOST_UNAVAILABLE' })
  }
  process.on('message', answer)
  process.once('disconnect', disconnect)
  ctx.effect(() => async () => {
    disconnect()
    await Promise.allSettled(running)
    process.removeListener('message', answer)
    process.removeListener('disconnect', disconnect)
  }, 'douyin: join normal-page observations')
  const acquire: DouyinDataMethod = async (agent, selection, callerSignal) => {
    const signal = AbortSignal.any([lifetime.signal, callerSignal])
    signal.throwIfAborted()
    const workspace = agent.session.header.cwd
    if (typeof workspace !== 'string') return { status: 'blocked', code: 'WORKSPACE_UNAVAILABLE' }
    let cwd: string
    try { cwd = realpathSync(workspace) } catch { return { status: 'blocked', code: 'WORKSPACE_UNAVAILABLE' } }
    const taskId = randomUUID() as DouyinTaskId
    const base = { type: 'douyin-browser-data' as const, taskId, sessionId: agent.id, cwd, selection }
    let release: Promise<DouyinDesktopDataResult> | undefined
    const releaseTask = (): Promise<DouyinDesktopDataResult> => release ??= send({ ...base, requestId: randomUUID() as DouyinDataRequestId, action: 'release' })
    const abort = (): void => { void releaseTask() }
    signal.addEventListener('abort', abort, { once: true })
    try {
      signal.throwIfAborted()
      const result = await send({ ...base, requestId: randomUUID() as DouyinDataRequestId, action: 'read' })
      signal.throwIfAborted()
      if (result.code !== 'OK' || result.data === undefined) return { status: 'blocked', code: result.code }
      const url = new URL(selection.url)
      const path = /^\/(?:share\/)?video\/(\d{10,25})\/?$/.exec(url.pathname)?.[1]
      const requested = path ?? url.searchParams.get('modal_id')
      if ((requested !== null && requested !== result.data.targetVideoId)
        || (selection.source === 'public' && result.data.source !== 'public-page')
        || (selection.source === 'creator' && result.data.source !== 'creator-page')
        || result.data.comments.items.length > selection.comments.count
        || (!selection.comments.enabled && result.data.comments.status !== 'not-requested')) return { status: 'blocked', code: 'INVALID_RESULT' }
      return result.data
    } finally {
      signal.removeEventListener('abort', abort)
      await releaseTask()
    }
  }
  return (agent, selection, signal) => {
    const operation = acquire(agent, selection, signal)
    running.add(operation)
    return operation.finally(() => { running.delete(operation) })
  }
}
