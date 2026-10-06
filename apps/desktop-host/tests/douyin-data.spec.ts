import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import type { DouyinDataSelection, DouyinDesktopDataRequest } from '@deepseek-ai/dsh-client-ui-sidebar-browser/types'
import { dataResult, installDesktopDouyinData } from '../src/douyin-data.ts'
import { installDesktopDouyinBrowser } from '../src/douyin-browser.ts'

const videoId = '7692443246022167851'
const unavailable = { value: null, precision: 'unavailable', reason: 'not-exposed' }
function snapshot(): object {
  return { status: 'ok', source: 'public-page', targetVideoId: videoId, observedAt: '2026-10-06T00:00:00.000Z',
    counts: { play_count: unavailable, digg_count: { value: 42, precision: 'exact' }, comment_count: { value: 124, precision: 'exact' },
      share_count: { value: 40000, precision: 'rounded', display: '4万' }, collect_count: { value: null, precision: 'unavailable', reason: 'missing' } },
    comments: { status: 'not-requested', items: [], cursor: null, hasMore: null },
  }
}
function wire(data: object = snapshot()): object { return { type: 'douyin-browser-data-result', requestId: randomUUID(), code: 'OK', data } }
const selection: DouyinDataSelection = { url: `https://www.douyin.com/video/${videoId}`, source: 'public', comments: { enabled: false, count: 20 }, timeoutMs: 1000 }

it('projects safe IPC fields and discards raw headers, media addresses, identifiers and diagnostics', () => {
  const raw = { ...snapshot(), headers: { Cookie: 'PRIVATE_SIG' }, author: { sec_uid: 'PRIVATE_SIG' }, media: 'PRIVATE_SIG' }
  const result = dataResult({ ...wire(raw), diagnostic: 'PRIVATE_SIG' })
  expect(result).toMatchObject({ code: 'OK', data: { targetVideoId: videoId, counts: { digg_count: { value: 42, precision: 'exact' } } } })
  expect(JSON.stringify(result)).not.toContain('PRIVATE_SIG')
})
it.each([undefined, null, [], {}, { ...wire(), type: 'douyin-browser-result' }, { ...wire(), requestId: 'bad' },
  { ...wire(), code: 'UPSTREAM_PRIVATE_SIG' }, { ...wire(), code: 'CANCELLED' },
  wire({ ...snapshot(), source: 'official-oauth' }), wire({ ...snapshot(), targetVideoId: 'bad' }),
  wire({ ...snapshot(), observedAt: 'yesterday' }), wire({ ...snapshot(), observedAt: '2026-99-06T00:00:00.000Z' }),
  wire({ ...snapshot(), counts: { play_count: unavailable } }),
])('rejects malformed IPC response %# without projecting its unverified data', (value) => { expect(dataResult(value)).toBeUndefined() })
it.each([-1, 1.2, Number.MAX_SAFE_INTEGER + 1, '42', Infinity, { token: 'PRIVATE_SIG' }])('rejects invalid counter %s', (value) => {
  expect(dataResult(wire({ ...snapshot(), counts: { play_count: unavailable, digg_count: { value, precision: 'exact' },
    comment_count: { value: 1, precision: 'exact' }, share_count: unavailable, collect_count: unavailable } }))).toBeUndefined()
})
it('preserves public comments separately from the work total and excludes author details', () => {
  const result = dataResult(wire({ ...snapshot(), comments: { status: 'available', cursor: '20', hasMore: true,
    items: [{ id: '123', text: 'Public comment', digg_count: 0, create_time: null, reply_comment_total: 4, user: 'PRIVATE_SIG' }] } }))
  expect(result?.data?.comments).toEqual({ status: 'available', cursor: '20', hasMore: true,
    items: [{ id: '123', text: 'Public comment', digg_count: 0, create_time: null, reply_comment_total: 4 }] })
  expect(result?.data?.counts.comment_count.value).toBe(124)
  expect(JSON.stringify(result)).not.toContain('PRIVATE_SIG')
})
it.each([
  { status: 'blocked', items: [], cursor: null, hasMore: null, code: 'PRIVATE_SIG' },
  { status: 'not-requested', items: [], cursor: '20', hasMore: false },
  { status: 'available', items: [{ id: '123', text: 'Public', digg_count: -1, create_time: null, reply_comment_total: null }], cursor: null, hasMore: false },
  { status: 'available', items: [{ id: '123', text: 'Public', digg_count: 0, create_time: null, reply_comment_total: null }, { id: '123', text: 'Duplicate', digg_count: 0, create_time: null, reply_comment_total: null }], cursor: null, hasMore: false },
  { status: 'available', items: Array.from({ length: 201 }, (_, i) => ({ id: String(i), text: 'Public', digg_count: 0, create_time: null, reply_comment_total: null })), cursor: null, hasMore: false },
])('rejects invalid or unbounded comment pagination %#', (comments) => { expect(dataResult(wire({ ...snapshot(), comments }))).toBeUndefined() })

async function harness(run: (fixture: {
  ctx: Context
  agent: Agent
  sent: DouyinDesktopDataRequest[]
  respond: (request: DouyinDesktopDataRequest, code?: string, data?: object) => void
  onSend: (handler: (request: DouyinDesktopDataRequest) => void) => void
}) => Promise<void>): Promise<void> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'muse-douyin-data-host-'))), ctx = new Context()
  const connected = Object.getOwnPropertyDescriptor(process, 'connected'), send = Object.getOwnPropertyDescriptor(process, 'send')
  const sent: DouyinDesktopDataRequest[] = []
  const respond = (request: DouyinDesktopDataRequest, code = request.action === 'read' ? 'OK' : 'RELEASED', data = code === 'OK' ? snapshot() : undefined): void => {
    EventEmitter.prototype.emit.call(process, 'message', { type: 'douyin-browser-data-result', requestId: request.requestId, code, ...(data === undefined ? {} : { data }) })
  }
  let handler: (request: DouyinDesktopDataRequest) => void = (request) => { queueMicrotask(() => { respond(request) }) }
  Object.defineProperty(process, 'connected', { value: true, configurable: true })
  Object.defineProperty(process, 'send', { configurable: true, value: (request: DouyinDesktopDataRequest, callback: (error: Error | null) => void) => {
    sent.push(request); handler(request); callback(null)
  } })
  try {
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create(SessionId('data-transport-fixture'), { meta: { cwd: root } })
    const agent = { id: session.id, session } as Agent
    await run({ ctx, agent, sent, respond, onSend: (next) => { handler = next } })
  } finally {
    await ctx.fiber.dispose()
    if (connected !== undefined) Object.defineProperty(process, 'connected', connected); else Reflect.deleteProperty(process, 'connected')
    if (send !== undefined) Object.defineProperty(process, 'send', send); else Reflect.deleteProperty(process, 'send')
    rmSync(root, { recursive: true, force: true })
    vi.useRealTimers()
  }
}
it('provides version 3 data while retaining the download method and forwarded timeout', async () => harness(async (fixture) => {
  installDesktopDouyinBrowser(fixture.ctx)
  expect(fixture.ctx.douyinBrowser.version).toBe(3)
  expect(typeof fixture.ctx.douyinBrowser.download).toBe('function')
  expect(await fixture.ctx.douyinBrowser.data(fixture.agent, selection, new AbortController().signal))
    .toMatchObject({ targetVideoId: videoId })
  expect(fixture.sent.map(request => request.action)).toEqual(['read', 'release'])
  expect(fixture.sent[0]?.selection).toEqual(selection)
}))
it('releases and joins the cancelled read before rejecting, without returning a late snapshot', async () => harness(async (fixture) => {
  const method = installDesktopDouyinData(fixture.ctx), cancellation = new AbortController(), release = Promise.withResolvers<undefined>()
  let read: DouyinDesktopDataRequest | undefined
  fixture.onSend((request) => {
    if (request.action === 'read') read = request
    else void release.promise.then(() => { if (read !== undefined) fixture.respond(read, 'CANCELLED', undefined); fixture.respond(request) })
  })
  const pending = method(fixture.agent, selection, cancellation.signal)
  const outcome = pending.then(() => 'late success', (error: unknown) => error)
  cancellation.abort('cancelled by user')
  let settled = false; void outcome.then(() => { settled = true })
  try { for (let i = 0; i < 10; i++) await Promise.resolve(); expect(settled).toBe(false) }
  finally { release.resolve(undefined) }
  expect(await outcome).toBe('cancelled by user')
  expect(fixture.sent.map(request => request.action)).toEqual(['read', 'release'])
}))
it('joins pending reads and releases during Context disposal and removes its message listeners', async () => harness(async (fixture) => {
  const before = process.listenerCount('message'), method = installDesktopDouyinData(fixture.ctx)
  fixture.onSend(() => {})
  const outcome = method(fixture.agent, selection, new AbortController().signal).then(() => false, () => true)
  await fixture.ctx.fiber.dispose()
  expect(await outcome).toBe(true)
  expect(process.listenerCount('message')).toBe(before)
}))
it('returns a fixed transport deadline and joins the release without leaking invalid IPC fields', async () => harness(async (fixture) => {
  vi.useFakeTimers()
  const method = installDesktopDouyinData(fixture.ctx)
  fixture.onSend((request) => {
    if (request.action === 'release') fixture.respond(request)
    else EventEmitter.prototype.emit.call(process, 'message', { ...wire(), requestId: request.requestId, code: 'PRIVATE_SIG' })
  })
  const pending = method(fixture.agent, selection, new AbortController().signal)
  await vi.advanceTimersByTimeAsync(selection.timeoutMs + 10_000)
  expect(await pending).toEqual({ status: 'blocked', code: 'TRANSPORT_TIMEOUT' })
}))
it.each(['target', 'source', 'comments'] as const)('rejects a successful response that changes the selected %s', async changed => harness(async (fixture) => {
  const method = installDesktopDouyinData(fixture.ctx)
  fixture.onSend((request) => { fixture.respond(request, request.action === 'read' ? 'OK' : 'RELEASED', request.action === 'read' ? {
    ...snapshot(), ...(changed === 'target' ? { targetVideoId: '7690000000000000000' }
      : changed === 'source' ? { source: 'creator-page' }
        : { comments: { status: 'available', items: [], cursor: null, hasMore: false } }),
  } : undefined) })
  expect(await method(fixture.agent, selection, new AbortController().signal)).toEqual({ status: 'blocked', code: 'INVALID_RESULT' })
}))
