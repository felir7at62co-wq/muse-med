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
  const loading = vi.fn(() => false)
  const guestMethods: Pick<WebContents, 'debugger' | 'isDestroyed' | 'getURL' | 'reload' | 'isLoadingMainFrame'> = {
    debugger: debug, isDestroyed: () => false, getURL: () => current, reload, isLoadingMainFrame: loading,
  }
  const guest = Object.assign(new EventEmitter(), guestMethods) as WebContents
  const open = vi.fn(), busy = vi.fn(() => false), controller = new DesktopDouyinData(open, busy)
  controllers.push(controller)
  controller.activeSession(owner, 'owning-session')
  const lease = { lease: randomUUID() as DesktopBrowserLeaseId, owner, guest, workspace: `cwd:${process.cwd()}`, sessionId: 'owning-session' }
  return { controller, owner, guest, debug, open, busy, lease, reload, loading, navigate: (next: string, inPlace = false) => { current = next; guest.emit('did-start-navigation', {}, next, inPlace, true) } }
}
async function attached(fixture: ReturnType<typeof setup>, operation: DouyinDesktopDataRequest) {
  const result = fixture.controller.request(fixture.owner, operation)
  fixture.controller.attached(fixture.lease)
  await vi.waitFor(() => { expect(fixture.reload).toHaveBeenCalledOnce() })
  return { result }
}
function body(): object { return { aweme_detail: { aweme_id: fixtureId, statistics: {
  play_count: 0, digg_count: 4, comment_count: 123, share_count: 6, collect_count: 7,
}, desc: '公开作品文案', create_time: 1790000000, author: { nickname: '作者', sec_uid: 'PRIVATE_SIG' }, video: { play_addr: { url_list: ['PRIVATE_SIG'] } } } } }
function dataBody(fixture: ReturnType<typeof setup>, response: object = body()) {
  fixture.debug.sendCommand.mockImplementation(async method => method === 'Network.getResponseBody'
    ? { body: JSON.stringify(response), base64Encoded: false } : {})
}

function aggregatedRequest(aggregationWaitMs = 300): DouyinDesktopDataRequest {
  const base = request()
  return { ...base, selection: { ...base.selection, aggregationWaitMs } }
}

function seriesObservation(displays: string[] | null = null): string {
  return JSON.stringify({ kind: 'public-action-strip', targetVideoId: fixtureId, displays,
    visibleSeries: { title: '页面合集', source: 'visible-series-list' } })
}

async function startAggregate(fixture: ReturnType<typeof setup>, operation = aggregatedRequest()) {
  const result = fixture.controller.request(fixture.owner, operation)
  fixture.controller.attached(fixture.lease)
  await vi.advanceTimersByTimeAsync(0)
  expect(fixture.reload).toHaveBeenCalledOnce()
  return { operation, result }
}

it.each(['page-first', 'detail-first'] as const)('combines independently timed same-work observations in either order: %s', async (order) => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-11T00:00:00.000Z'))
  const fixture = setup()
  fixture.guest.executeJavaScript = vi.fn(async () => seriesObservation())
  const { result } = await startAggregate(fixture)
  if (order === 'page-first') {
    await vi.advanceTimersByTimeAsync(100)
    await vi.advanceTimersByTimeAsync(50)
    dataBody(fixture); await fixtureResponse(fixture.debug)
  } else {
    dataBody(fixture); await fixtureResponse(fixture.debug)
    await vi.advanceTimersByTimeAsync(100)
  }
  await vi.advanceTimersByTimeAsync(300)
  const value = await result
  expect(value).toMatchObject({ code: 'OK', data: { targetVideoId: fixtureId,
    metadata: { seriesTitle: '页面合集', seriesSource: 'visible-series-list', description: '公开作品文案' },
    counts: { digg_count: { value: 4, precision: 'exact' } },
    aggregation: { status: 'complete', reason: 'paired', observations: {
      series: { source: 'page', observedAt: '2026-11-11T00:00:00.100Z' },
      counts: { digg_count: { source: 'detail', observedAt: order === 'page-first' ? '2026-11-11T00:00:00.150Z' : '2026-11-11T00:00:00.000Z' } },
      description: { source: 'detail' }, authorName: { source: 'detail' }, publishedAt: { source: 'detail' },
    } } } })
  expect(JSON.stringify(value)).not.toContain('PRIVATE_SIG')
  expect(fixture.controller.isActive).toBe(false)
})

it('completes when one target-bound page observation already has both series and counts', async () => {
  vi.useFakeTimers()
  const fixture = setup()
  fixture.guest.executeJavaScript = vi.fn(async () => seriesObservation(['13', '4', '1', '3']))
  const { result } = await startAggregate(fixture)
  await vi.advanceTimersByTimeAsync(100)
  expect(await result).toMatchObject({ code: 'OK', data: { metadata: { seriesTitle: '页面合集' },
    counts: { digg_count: { value: 13, precision: 'exact' } },
    aggregation: { status: 'complete', reason: 'paired', observations: { counts: { digg_count: { source: 'page' } }, series: { source: 'page' } } } } })
})

it('retains complementary counter fields from both observations', async () => {
  vi.useFakeTimers()
  const fixture = setup()
  fixture.guest.executeJavaScript = vi.fn(async () => seriesObservation(['13', '评论', '收藏', '分享']))
  const { result } = await startAggregate(fixture)
  dataBody(fixture, { aweme_detail: { aweme_id: fixtureId, statistics: { play_count: 42 } } })
  await fixtureResponse(fixture.debug)
  await vi.advanceTimersByTimeAsync(100)
  const value = await result
  expect(value).toMatchObject({ code: 'OK', data: { metadata: { seriesTitle: '页面合集' },
    counts: { play_count: { value: 42, precision: 'exact' }, digg_count: { value: 13, precision: 'exact' } },
    aggregation: { observations: { counts: { play_count: { source: 'detail' }, digg_count: { source: 'page' } } } } } })
})

it.each(['page-first', 'detail-first'] as const)('uses the exact count for an equal rounded page count in either order: %s', async (order) => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-11T00:00:00.000Z'))
  const fixture = setup()
  fixture.guest.executeJavaScript = vi.fn()
    .mockResolvedValueOnce(JSON.stringify({ kind: 'public-action-strip', targetVideoId: fixtureId,
      displays: ['4万', '评论', '收藏', '分享'], visibleSeries: null }))
    .mockResolvedValue(seriesObservation())
  const { result } = await startAggregate(fixture)
  const detail = async (): Promise<void> => {
    dataBody(fixture, { aweme_detail: { aweme_id: fixtureId, statistics: { digg_count: 40000 } } })
    await fixtureResponse(fixture.debug)
  }
  if (order === 'page-first') { await vi.advanceTimersByTimeAsync(100); await detail() }
  else { await detail(); await vi.advanceTimersByTimeAsync(100) }
  await vi.advanceTimersByTimeAsync(100)
  expect(await result).toMatchObject({ code: 'OK', data: { counts: { digg_count: { value: 40000, precision: 'exact' } },
    aggregation: { status: 'complete', observations: { counts: { digg_count: { source: 'detail',
      observedAt: order === 'page-first' ? '2026-11-11T00:00:00.100Z' : '2026-11-11T00:00:00.000Z' } } } } } })
})

it.each(['page-first', 'detail-first'] as const)('does not infer a rounding interval for unequal observations: %s', async (order) => {
  vi.useFakeTimers()
  const fixture = setup()
  fixture.guest.executeJavaScript = vi.fn(async () => JSON.stringify({ kind: 'public-action-strip', targetVideoId: fixtureId,
    displays: ['4万', '评论', '收藏', '分享'], visibleSeries: null }))
  const { result } = await startAggregate(fixture)
  const detail = async (): Promise<void> => {
    dataBody(fixture, { aweme_detail: { aweme_id: fixtureId, statistics: { digg_count: 41234 } } })
    await fixtureResponse(fixture.debug)
  }
  if (order === 'page-first') { await vi.advanceTimersByTimeAsync(100); await detail() }
  else { await detail(); await vi.advanceTimersByTimeAsync(100) }
  expect(await result).toMatchObject({ code: 'DATA_OBSERVATION_CONFLICT' })
})

it.each(['page', 'detail'] as const)('returns the observed %s side as partial at the aggregation deadline', async (side) => {
  vi.useFakeTimers()
  const fixture = setup()
  fixture.guest.executeJavaScript = vi.fn(async () => side === 'page' ? seriesObservation() : null)
  const { result } = await startAggregate(fixture)
  if (side === 'page') await vi.advanceTimersByTimeAsync(100)
  else { dataBody(fixture); await fixtureResponse(fixture.debug) }
  await vi.advanceTimersByTimeAsync(300)
  const value = await result
  expect(value).toMatchObject({ code: 'OK', data: { aggregation: { status: 'partial', reason: 'wait_expired' } } })
  if (side === 'page') expect(value.data).toMatchObject({ metadata: { seriesTitle: '页面合集' },
    counts: { digg_count: { value: null, precision: 'unavailable' } }, aggregation: { observations: { series: { source: 'page' }, counts: { digg_count: null } } } })
  else expect(value.data).toMatchObject({ counts: { digg_count: { value: 4, precision: 'exact' } },
    aggregation: { observations: { series: null, counts: { digg_count: { source: 'detail' } } } } })
})

it('returns partial data at the original deadline when the first observation arrives late', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-11T00:00:00.000Z'))
  const fixture = setup(), start = Date.now()
  fixture.guest.executeJavaScript = vi.fn(async () => Date.now() - start >= 900 ? seriesObservation() : null)
  const { result } = await startAggregate(fixture)
  await vi.advanceTimersByTimeAsync(1000)
  expect(await result).toMatchObject({ code: 'OK', data: { metadata: { seriesTitle: '页面合集' },
    aggregation: { status: 'partial', reason: 'deadline', observations: { series: {
      source: 'page', observedAt: '2026-11-11T00:00:00.900Z',
    }, counts: { digg_count: null } } } } })
})

it('rejects inconsistent same-work observations instead of combining conflicting metadata', async () => {
  vi.useFakeTimers()
  const fixture = setup()
  fixture.guest.executeJavaScript = vi.fn(async () => JSON.stringify({ status_code: 0,
    aweme_detail: { aweme_id: fixtureId, desc: '页面文案' },
    visibleSeries: { title: '页面合集', source: 'visible-series-list' } }))
  const { result } = await startAggregate(fixture)
  await vi.advanceTimersByTimeAsync(100)
  dataBody(fixture); await fixtureResponse(fixture.debug)
  await vi.advanceTimersByTimeAsync(300)
  expect(await result).toMatchObject({ code: 'DATA_OBSERVATION_CONFLICT' })
})

it.each(['session', 'navigation', 'lease', 'dispose', 'release'] as const)(
  'discards a partial observation if %s revokes the task while aggregation waits', async (cause) => {
    vi.useFakeTimers()
    const fixture = setup()
    fixture.guest.executeJavaScript = vi.fn(async () => seriesObservation())
    const { operation, result } = await startAggregate(fixture)
    await vi.advanceTimersByTimeAsync(100)
    let disposed: Promise<void> | undefined
    let released: Promise<unknown> | undefined
    if (cause === 'session') fixture.controller.activeSession(fixture.owner, 'different-session')
    if (cause === 'navigation') fixture.navigate(page)
    if (cause === 'lease') fixture.controller.released(fixture.lease.lease)
    if (cause === 'dispose') disposed = fixture.controller.dispose()
    if (cause === 'release') released = fixture.controller.request(fixture.owner, { ...operation, action: 'release', requestId: randomUUID() as DouyinDataRequestId })
    await vi.advanceTimersByTimeAsync(400)
    await disposed; await released
    const value = await result
    expect(value.code).toBe(cause === 'session' ? 'SESSION_NOT_VISIBLE' : cause === 'navigation' ? 'DOCUMENT_CHANGED'
      : cause === 'lease' ? 'LEASE_RELEASED' : cause === 'dispose' ? 'HOST_UNAVAILABLE' : 'CANCELLED')
    expect(value.data).toBeUndefined()
    expect(fixture.controller.isActive).toBe(false)
  },
)

it('discards cached facts when an in-place target switch returns to the original URL', async () => {
  vi.useFakeTimers()
  const fixture = setup()
  fixture.guest.executeJavaScript = vi.fn(async () => seriesObservation())
  const { result } = await startAggregate(fixture)
  await vi.advanceTimersByTimeAsync(100)
  fixture.navigate('https://www.douyin.com/video/7690000000000000000', true)
  fixture.navigate(page, true)
  dataBody(fixture); await fixtureResponse(fixture.debug)
  await vi.advanceTimersByTimeAsync(400)
  expect(await result).toMatchObject({ code: 'DOCUMENT_CHANGED' })
})

it('rejects a main-frame did-navigate-in-page ABA even without did-start-navigation', async () => {
  vi.useFakeTimers()
  const fixture = setup()
  fixture.guest.executeJavaScript = vi.fn(async () => seriesObservation())
  const { result } = await startAggregate(fixture)
  await vi.advanceTimersByTimeAsync(100)
  fixture.guest.emit('did-navigate-in-page', {}, 'https://www.douyin.com/video/7690000000000000000', true)
  fixture.guest.emit('did-navigate-in-page', {}, page, true)
  dataBody(fixture); await fixtureResponse(fixture.debug)
  await vi.advanceTimersByTimeAsync(400)
  const value = await result
  expect(value.code).toBe('DOCUMENT_CHANGED')
  expect(value.data).toBeUndefined()
})

it('restarts same-target in-page navigation without publishing prior facts or a late page read', async () => {
  vi.useFakeTimers()
  const fixture = setup(), deferred = Promise.withResolvers<unknown>()
  fixture.guest.executeJavaScript = vi.fn().mockReturnValueOnce(deferred.promise).mockResolvedValue(seriesObservation())
  const { result } = await startAggregate(fixture)
  dataBody(fixture); await fixtureResponse(fixture.debug)
  await vi.advanceTimersByTimeAsync(100)
  fixture.navigate(page, true)
  fixture.guest.emit('did-navigate-in-page', {}, page, true)
  deferred.resolve(seriesObservation())
  await vi.advanceTimersByTimeAsync(100)
  let settled = false
  void result.then(() => { settled = true })
  await vi.advanceTimersByTimeAsync(0)
  expect(settled).toBe(false)
  dataBody(fixture, { aweme_detail: { aweme_id: fixtureId, statistics: { digg_count: 19 } } })
  await fixtureResponse(fixture.debug)
  await vi.advanceTimersByTimeAsync(300)
  expect(await result).toMatchObject({ code: 'OK', data: { metadata: { seriesTitle: '页面合集', description: null },
    counts: { digg_count: { value: 19 } }, aggregation: { status: 'complete' } } })
})

it('keeps old first-success clients usable after same-target in-page navigation', async () => {
  vi.useFakeTimers()
  const fixture = setup(), result = fixture.controller.request(fixture.owner, request())
  fixture.controller.attached(fixture.lease)
  await vi.advanceTimersByTimeAsync(0)
  fixture.navigate(page, true)
  fixture.guest.emit('did-navigate-in-page', {}, page, true)
  dataBody(fixture); await fixtureResponse(fixture.debug)
  const value = await result
  expect(value).toMatchObject({ code: 'OK', data: { counts: { digg_count: { value: 4 } } } })
  expect(value.data).not.toHaveProperty('aggregation')
})

it('discards an old detail response body that arrives after same-target navigation', async () => {
  vi.useFakeTimers()
  const fixture = setup(), deferred = Promise.withResolvers<object>()
  fixture.guest.executeJavaScript = vi.fn(async () => seriesObservation())
  const { result } = await startAggregate(fixture)
  fixture.debug.sendCommand.mockImplementation(async method => method === 'Network.getResponseBody' ? deferred.promise : {})
  await fixtureResponse(fixture.debug)
  fixture.navigate(page, true)
  fixture.guest.emit('did-navigate-in-page', {}, page, true)
  deferred.resolve({ body: JSON.stringify(body()), base64Encoded: false })
  await vi.advanceTimersByTimeAsync(100)
  let settled = false
  void result.then(() => { settled = true })
  await vi.advanceTimersByTimeAsync(0)
  expect(settled).toBe(false)
  dataBody(fixture, { aweme_detail: { aweme_id: fixtureId, statistics: { digg_count: 19 } } })
  await fixtureResponse(fixture.debug)
  await vi.advanceTimersByTimeAsync(300)
  expect(await result).toMatchObject({ code: 'OK', data: { counts: { digg_count: { value: 19 } },
    metadata: { description: null }, aggregation: { status: 'complete' } } })
})

it.each(['https://www.douyin.com/video/7690000000000000000', 'https://www.douyin.com/'])(
  'rejects a changed or unknown in-page navigation target: %s', async (next) => {
    vi.useFakeTimers()
    const fixture = setup()
    fixture.guest.executeJavaScript = vi.fn(async () => seriesObservation())
    const { result } = await startAggregate(fixture)
    await vi.advanceTimersByTimeAsync(100)
    fixture.navigate(next, true)
    fixture.guest.emit('did-navigate-in-page', {}, next, true)
    const value = await result
    expect(value.code).toBe('DOCUMENT_CHANGED')
    expect(value.data).toBeUndefined()
  },
)

it('rejects a same-target commit whose address differs from its start', async () => {
  vi.useFakeTimers()
  const fixture = setup()
  const { result } = await startAggregate(fixture)
  fixture.navigate(`${page}?variant=1`, true)
  fixture.guest.emit('did-navigate-in-page', {}, page, true)
  expect(await result).toMatchObject({ code: 'DOCUMENT_CHANGED' })
})

it('rejects overlapping same-target starts that cannot be matched to one commit', async () => {
  vi.useFakeTimers()
  const fixture = setup()
  const { result } = await startAggregate(fixture)
  fixture.navigate(page, true)
  fixture.navigate(page, true)
  fixture.guest.emit('did-navigate-in-page', {}, page, true)
  expect(await result).toMatchObject({ code: 'DOCUMENT_CHANGED' })
})

it('revokes an apparent success if same-target navigation begins while cleanup waits for a page read', async () => {
  vi.useFakeTimers()
  const fixture = setup(), deferred = Promise.withResolvers<unknown>()
  fixture.guest.executeJavaScript = vi.fn().mockResolvedValueOnce(seriesObservation()).mockReturnValue(deferred.promise)
  const { result } = await startAggregate(fixture)
  await vi.advanceTimersByTimeAsync(200)
  dataBody(fixture); await fixtureResponse(fixture.debug)
  fixture.navigate(page, true)
  fixture.guest.emit('did-navigate-in-page', {}, page, true)
  deferred.resolve(seriesObservation())
  await vi.advanceTimersByTimeAsync(0)
  const value = await result
  expect(value.code).toBe('DOCUMENT_CHANGED')
  expect(value.data).toBeUndefined()
})

it('does not publish cached facts when the session changes while cleanup joins a page read', async () => {
  vi.useFakeTimers()
  const fixture = setup(), deferred = Promise.withResolvers<unknown>()
  fixture.guest.executeJavaScript = vi.fn(async () => deferred.promise)
  const { result } = await startAggregate(fixture)
  await vi.advanceTimersByTimeAsync(100)
  dataBody(fixture); await fixtureResponse(fixture.debug)
  await vi.advanceTimersByTimeAsync(300)
  let settled = false
  void result.then(() => { settled = true })
  await vi.advanceTimersByTimeAsync(0)
  expect(settled).toBe(false)
  fixture.controller.activeSession(fixture.owner, 'different-session')
  deferred.resolve(seriesObservation())
  await vi.advanceTimersByTimeAsync(0)
  const value = await result
  expect(value.code).toBe('SESSION_NOT_VISIBLE')
  expect(value.data).toBeUndefined()
})

it('projects counters from the normal exact-target GET and joins detachment before returning', async () => {
  const fixture = setup(), operation = request(), pending = await attached(fixture, operation)
  dataBody(fixture)
  await fixtureResponse(fixture.debug)
  const result = await pending.result
  expect(result).toMatchObject({ code: 'OK', requestId: operation.requestId, data: {
    source: 'public-page', targetVideoId: fixtureId, counts: { digg_count: { value: 4, precision: 'exact' },
      play_count: { value: null, precision: 'unavailable', reason: 'not-exposed' } },
    metadata: { description: '公开作品文案', authorName: '作者', publishedAt: 1790000000 },
    comments: { status: 'not-requested', items: [], cursor: null, hasMore: null },
  } })
  expect(JSON.stringify(result)).not.toContain('PRIVATE_SIG')
  expect(fixture.debug.detach).toHaveBeenCalledOnce()
  expect(fixture.debug.listenerCount('message')).toBe(0)
  expect(fixture.controller.isActive).toBe(false)
})

it.each(['public', 'creator'] as const)('waits for the initial %s document before beginning its one-document observation', async (source) => {
  vi.useFakeTimers()
  const fixture = setup(), base = request()
  const operation = { ...base, selection: { ...base.selection, source } }
  if (source === 'creator') fixture.navigate('https://creator.douyin.com/creator-micro/content/manage')
  fixture.loading.mockReturnValue(true)
  const result = fixture.controller.request(fixture.owner, operation)
  fixture.controller.attached(fixture.lease)
  await vi.advanceTimersByTimeAsync(200)
  expect(fixture.reload).not.toHaveBeenCalled()
  expect(fixture.debug.attach).not.toHaveBeenCalled()
  fixture.navigate(source === 'creator' ? 'https://creator.douyin.com/creator-micro/content/manage' : page)
  fixture.loading.mockReturnValue(false)
  await vi.advanceTimersByTimeAsync(100)
  expect(fixture.reload).toHaveBeenCalledOnce()
  dataBody(fixture, source === 'creator' ? { status_code: 0, can_modify: [true], has_more: false,
    aweme_list: [{ aweme_id: fixtureId, statistics: { aweme_id: fixtureId, play_count: 42 } }] } : body())
  await fixtureResponse(fixture.debug, source === 'creator' ? { url: 'https://creator.douyin.com/janus/douyin/creator/pc/work_list' } : {})
  expect(await result).toMatchObject({ code: 'OK', data: { targetVideoId: fixtureId } })
  expect(fixture.debug.detach).toHaveBeenCalledOnce()
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
it('returns the first valid detail response when it precedes the visible-page probe', async () => {
  vi.useFakeTimers()
  const fixture = setup(), operation = request()
  const executeJavaScript = vi.fn(async () => JSON.stringify({ kind: 'public-action-strip', targetVideoId: fixtureId,
    displays: null, visibleSeries: { title: '页面合集', source: 'visible-series-list' } }))
  fixture.guest.executeJavaScript = executeJavaScript
  const result = fixture.controller.request(fixture.owner, operation)
  fixture.controller.attached(fixture.lease)
  await vi.advanceTimersByTimeAsync(0)
  expect(fixture.reload).toHaveBeenCalledOnce()
  dataBody(fixture); await fixtureResponse(fixture.debug)
  const value = await result
  expect(value.data?.metadata?.seriesTitle).toBeUndefined()
  expect(value.data?.counts.digg_count.value).toBe(4)
  expect(executeJavaScript).not.toHaveBeenCalled()
})
it('returns the first valid visible-page series when it precedes the detail response', async () => {
  vi.useFakeTimers()
  const fixture = setup(), operation = request()
  fixture.guest.executeJavaScript = vi.fn(async () => JSON.stringify({ kind: 'public-action-strip', targetVideoId: fixtureId,
    displays: null, visibleSeries: { title: '页面合集', source: 'visible-series-list' } }))
  const result = fixture.controller.request(fixture.owner, operation)
  fixture.controller.attached(fixture.lease)
  await vi.advanceTimersByTimeAsync(100)
  const value = await result
  expect(value.data?.metadata?.seriesTitle).toBe('页面合集')
  expect(value.data?.counts.digg_count.value).toBeNull()
  expect(fixture.debug.listenerCount('message')).toBe(0)
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

it('preserves old first-success requests and accepts a bounded aggregation window', () => {
  const base = request()
  expect(parseDouyinDataRequest(base)?.selection.aggregationWaitMs).toBe(0)
  expect(parseDouyinDataRequest(aggregatedRequest())?.selection.aggregationWaitMs).toBe(300)
})

it.each([-1, 0.5, 1001, Number.NaN, Number.POSITIVE_INFINITY, '300'])(
  'rejects invalid aggregation windows before opening a browser: %s', (aggregationWaitMs) => {
    const base = request()
    expect(parseDouyinDataRequest({ ...base, selection: { ...base.selection, aggregationWaitMs } })).toBeUndefined()
  },
)
