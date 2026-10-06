import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import type { WebContents } from 'electron'
import { afterEach, expect, it, vi } from 'vitest'
import type { DesktopBrowserLeaseId, DouyinDesktopDataRequest, DouyinDataRequestId, DouyinTaskId } from '@deepseek-ai/dsh-client-ui-sidebar-browser/types'
import { DesktopDouyinData } from '../src/douyin-data.ts'
import { parseDouyinDataRequest } from '../src/douyin-policy.ts'
import { fixtureDebugger, fixtureId, fixtureResponse } from './douyin-provider-fixture.ts'

const page = `https://www.douyin.com/video/${fixtureId}`
const controllers: DesktopDouyinData[] = []
afterEach(async () => { await Promise.all(controllers.splice(0).map(controller => controller.dispose())); vi.useRealTimers() })
function request(change: Partial<DouyinDesktopDataRequest> = {}): DouyinDesktopDataRequest {
  return { type: 'douyin-browser-data', action: 'read', requestId: randomUUID() as DouyinDataRequestId, taskId: randomUUID() as DouyinTaskId,
    sessionId: 'owning-session', cwd: process.cwd(), selection: { url: page, source: 'public', comments: { enabled: false, count: 20 }, timeoutMs: 1000 }, ...change }
}
function setup() {
  const debug = fixtureDebugger()
  const owner = Object.assign(new EventEmitter(), { isDestroyed: () => false }) as WebContents
  let current = page
  const reload = vi.fn(() => {
    guest.emit('did-start-navigation', {}, current, false, true)
    debug.emit('message', {}, 'Page.frameNavigated', { frame: { id: 'main', loaderId: 'loader' } })
  })
  const guestMethods: Pick<WebContents, 'debugger' | 'isDestroyed' | 'getURL' | 'reload'> = {
    debugger: debug, isDestroyed: () => false, getURL: () => current, reload,
  }
  const guest = Object.assign(new EventEmitter(), guestMethods) as WebContents
  const open = vi.fn(), busy = vi.fn(() => false), controller = new DesktopDouyinData(open, busy)
  controllers.push(controller)
  controller.activeSession(owner, 'owning-session')
  const lease = { lease: randomUUID() as DesktopBrowserLeaseId, owner, guest, workspace: `cwd:${process.cwd()}`, sessionId: 'owning-session' }
  return { controller, owner, guest, debug, open, busy, lease, reload, navigate: (next: string) => { current = next; guest.emit('did-start-navigation', {}, next, false, true) } }
}
async function attached(fixture: ReturnType<typeof setup>, operation: DouyinDesktopDataRequest) {
  const result = fixture.controller.request(fixture.owner, operation)
  fixture.controller.attached(fixture.lease)
  await vi.waitFor(() => { expect(fixture.reload).toHaveBeenCalledOnce() })
  return { result }
}
function body(): object { return { aweme_detail: { aweme_id: fixtureId, statistics: {
  play_count: 0, digg_count: 4, comment_count: 123, share_count: 6, collect_count: 7,
}, author: { sec_uid: 'PRIVATE_SIG' }, video: { play_addr: { url_list: ['PRIVATE_SIG'] } } } } }
function dataBody(fixture: ReturnType<typeof setup>, response: object = body()) {
  fixture.debug.sendCommand.mockImplementation(async method => method === 'Network.getResponseBody'
    ? { body: JSON.stringify(response), base64Encoded: false } : {})
}

it('projects counters from the normal exact-target GET and joins detachment before returning', async () => {
  const fixture = setup(), operation = request(), pending = await attached(fixture, operation)
  dataBody(fixture)
  await fixtureResponse(fixture.debug)
  const result = await pending.result
  expect(result).toMatchObject({ code: 'OK', requestId: operation.requestId, data: {
    source: 'public-page', targetVideoId: fixtureId, counts: { digg_count: { value: 4, precision: 'exact' },
      play_count: { value: null, precision: 'unavailable', reason: 'not-exposed' } },
    comments: { status: 'not-requested', items: [], cursor: null, hasMore: null },
  } })
  expect(JSON.stringify(result)).not.toContain('PRIVATE_SIG')
  expect(fixture.debug.detach).toHaveBeenCalledOnce()
  expect(fixture.debug.listenerCount('message')).toBe(0)
  expect(fixture.controller.isActive).toBe(false)
})

it('reads already served public metadata and joins a pending page read on cancellation', async () => {
  vi.useFakeTimers()
  const fixture = setup(), operation = request(), deferred = Promise.withResolvers<unknown>()
  const executeJavaScript = vi.fn(async () => deferred.promise)
  fixture.guest.executeJavaScript = executeJavaScript
  const result = fixture.controller.request(fixture.owner, operation)
  fixture.controller.attached(fixture.lease)
  await vi.advanceTimersByTimeAsync(200)
  expect(executeJavaScript).toHaveBeenCalledOnce()
  let settled = false
  void result.then(() => { settled = true })
  fixture.controller.activeSession(fixture.owner, 'different-session')
  await vi.advanceTimersByTimeAsync(0)
  expect(settled).toBe(false)
  deferred.resolve(JSON.stringify(body()))
  expect(await result).toMatchObject({ code: 'SESSION_NOT_VISIBLE' })
})
it('keeps total comments independent from requested comment items when no observed comment page is available', async () => {
  const fixture = setup(), base = request(), pending = await attached(fixture, { ...base,
    selection: { ...base.selection, comments: { enabled: true, count: 10, cursor: '20' } } })
  dataBody(fixture); await fixtureResponse(fixture.debug)
  expect(await pending.result).toMatchObject({ code: 'OK', data: { counts: { comment_count: { value: 123 } },
    comments: { status: 'blocked', items: [], code: 'COMMENTS_CURSOR_UNAVAILABLE' } } })
})
it('refuses unselected sessions and a busy download without opening a page', async () => {
  const fixture = setup()
  for (const sessionId of ['different-session', '']) expect(await fixture.controller.request(fixture.owner, request({ sessionId }))).toMatchObject({ code: 'SESSION_NOT_VISIBLE' })
  fixture.busy.mockReturnValue(true)
  expect(await fixture.controller.request(fixture.owner, request())).toMatchObject({ code: 'BUSY' })
  fixture.busy.mockReturnValue(false)
  expect(fixture.open).not.toHaveBeenCalled()
})

it('opens the normal Creator content page and reads only its permission-associated work', async () => {
  const fixture = setup(), base = request(), operation = { ...base, selection: { ...base.selection, source: 'creator' as const } }
  fixture.navigate('https://creator.douyin.com/creator-micro/content/manage')
  const pending = await attached(fixture, operation)
  expect(fixture.open).toHaveBeenCalledWith(fixture.owner, 'owning-session', 'https://creator.douyin.com/creator-micro/content/manage')
  dataBody(fixture, { status_code: 0, can_modify: [true], has_more: false,
    aweme_list: [{ aweme_id: fixtureId, statistics: { aweme_id: fixtureId, play_count: 1503, digg_count: 13 } }] })
  await fixtureResponse(fixture.debug, { url: 'https://creator.douyin.com/janus/douyin/creator/pc/work_list?count=12' })
  expect(await pending.result).toMatchObject({ code: 'OK', data: { source: 'creator-page', targetVideoId: fixtureId, counts: { play_count: { value: 1503, precision: 'exact' } } } })
  expect(fixture.debug.detach).toHaveBeenCalledOnce()
})

it('returns unverified ownership when the completed Creator list lacks the selected work', async () => {
  const fixture = setup(), base = request()
  fixture.navigate('https://creator.douyin.com/creator-micro/content/manage')
  const pending = await attached(fixture, { ...base, selection: { ...base.selection, source: 'creator' } })
  dataBody(fixture, { status_code: 0, aweme_list: [], can_modify: [], has_more: false })
  await fixtureResponse(fixture.debug, { url: 'https://creator.douyin.com/janus/douyin/creator/pc/work_list' })
  expect(await pending.result).toMatchObject({ code: 'CREATOR_OWNERSHIP_UNVERIFIED' })
})
it.each(['session', 'navigation', 'lease', 'dispose'] as const)('joins a pending body after %s revokes the observation and refuses its late success', async (cause) => {
  const fixture = setup(), operation = request(), pending = await attached(fixture, operation), deferred = Promise.withResolvers<object>()
  fixture.debug.sendCommand.mockImplementation(async () => deferred.promise)
  await fixtureResponse(fixture.debug)
  let settled = false
  void pending.result.then(() => { settled = true })
  let disposed: Promise<void> | undefined
  if (cause === 'session') fixture.controller.activeSession(fixture.owner, 'different-session')
  if (cause === 'navigation') fixture.navigate(page)
  if (cause === 'lease') fixture.controller.released(fixture.lease.lease)
  if (cause === 'dispose') disposed = fixture.controller.dispose()
  try {
    for (let i = 0; i < 10; i++) await Promise.resolve()
    expect(settled).toBe(false)
    expect(fixture.controller.isActive).toBe(true)
  } finally { deferred.resolve({ body: JSON.stringify(body()), base64Encoded: false }); await disposed }
  expect(await pending.result).toMatchObject({ code: cause === 'session' ? 'SESSION_NOT_VISIBLE'
    : cause === 'navigation' ? 'DOCUMENT_CHANGED' : cause === 'lease' ? 'LEASE_RELEASED' : 'HOST_UNAVAILABLE' })
  expect(fixture.controller.isActive).toBe(false)
})
it('releases only the initiating task and waits for its joined result', async () => {
  const fixture = setup(), operation = request(), pending = await attached(fixture, operation)
  expect(await fixture.controller.request(fixture.owner, { ...operation, action: 'release', requestId: randomUUID() as DouyinDataRequestId, taskId: randomUUID() as DouyinTaskId })).toMatchObject({ code: 'RELEASED' })
  expect(fixture.controller.isActive).toBe(true)
  expect(await fixture.controller.request(fixture.owner, { ...operation, action: 'release', requestId: randomUUID() as DouyinDataRequestId })).toMatchObject({ code: 'RELEASED' })
  expect(await pending.result).toMatchObject({ code: 'CANCELLED' })
})
it('does not associate another window, workspace, Session or target with a request', async () => {
  const fixture = setup(), operation = request(), result = fixture.controller.request(fixture.owner, operation)
  for (const change of [{ owner: Object.assign(new EventEmitter(), { isDestroyed: () => false }) as WebContents },
    { workspace: '/different' }, { workspace: process.cwd() }, { sessionId: 'different-session' }]) fixture.controller.attached({ ...fixture.lease, ...change })
  expect(fixture.reload).not.toHaveBeenCalled()
  fixture.navigate('https://www.douyin.com/video/7690000000000000000')
  fixture.controller.attached(fixture.lease)
  expect(await result).toMatchObject({ code: 'TARGET_MISMATCH' })
})
it('bounds an unanswered normal page without accepting unrelated provider content', async () => {
  vi.useFakeTimers()
  const fixture = setup(), pending = fixture.controller.request(fixture.owner, request())
  fixture.controller.attached(fixture.lease)
  await vi.advanceTimersByTimeAsync(0)
  dataBody(fixture, { aweme_detail: { aweme_id: '7690000000000000000', statistics: { digg_count: 100 } } })
  await fixtureResponse(fixture.debug)
  await vi.advanceTimersByTimeAsync(1000)
  expect(await pending).toMatchObject({ code: 'PUBLIC_DATA_UNAVAILABLE' })
})
it.each([
  { selection: { url: 'https://evil.test/video/7692443246022167851', source: 'public', comments: { enabled: false, count: 20 }, timeoutMs: 1000 } },
  { action: 'delete' }, { taskId: 'bad-id' }, { sessionId: '' }, { cwd: 'relative' },
  { selection: { url: page, source: 'oauth', comments: { enabled: false, count: 20 }, timeoutMs: 1000 } },
  { selection: { url: page, source: 'public', comments: { enabled: 'true', count: 20 }, timeoutMs: 1000 } },
  { selection: { url: page, source: 'public', comments: { enabled: true, count: 201 }, timeoutMs: 1000 } },
  { selection: { url: page, source: 'public', comments: { enabled: true, count: 1, cursor: 'PRIVATE_SIG' }, timeoutMs: 1000 } },
  { selection: { url: page, source: 'public', comments: { enabled: false, count: 1, cursor: '20' }, timeoutMs: 1000 } },
  { selection: { url: page, source: 'public', comments: { enabled: false, count: 1 }, timeoutMs: 300001 } },
])('rejects invalid private wire selection %# before creating a browser task', (change) => {
  expect(parseDouyinDataRequest({ ...request(), ...change })).toBeUndefined()
})
