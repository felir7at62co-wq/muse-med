import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, realpathSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi, type Mock } from 'vitest'
import { DesktopDouyinDownloads } from '../src/douyin-downloads.ts'
import { douyinMedia, douyinPage, parseDouyinRequest, targetVideoId, DOUYIN_PLAYER_PROBE } from '../src/douyin-policy.ts'
import type { DouyinDesktopRequest } from '@deepseek-ai/dsh-client-ui-sidebar-browser/types'
import { fixtureDebugger, fixtureResponse, fixtureMedia, fixtureBody } from './douyin-provider-fixture.ts'

const id = '7692443246022167851'
const page = `https://www.douyin.com/video/${id}`
const media = 'https://v3.douyinvod.com/video.mp4?secret=transient'
let root: string
let controller: DesktopDouyinDownloads
let owner: ReturnType<typeof web>
let guest: ReturnType<typeof web>
let request: DouyinDesktopRequest
let open: Mock<ConstructorParameters<typeof DesktopDouyinDownloads>[0]>
function web() {
  return Object.assign(new EventEmitter(), {
    id: Math.random(),
    getURL: (): string => page,
    isDestroyed: (): boolean => false,
    isLoadingMainFrame: (): boolean => false,
    reload: vi.fn(),
    downloadURL: vi.fn(),
    debugger: { isAttached: () => true },
    session: { resolveHost: vi.fn(async () => ({ endpoints: [{ address: '1.1.1.1', family: 'ipv4' }] })) },
    executeJavaScript: vi.fn(async (_source: string): Promise<unknown> => ({ id, src: media })),
  })
}
class Item extends EventEmitter {
  url = media
  total = 8
  got = 8
  state = 'progressing'
  path = ''
  chain = [media]
  getURL() {
    return this.url
  }
  getURLChain() {
    return this.chain
  }
  getTotalBytes() {
    return this.total
  }
  getReceivedBytes() {
    return this.got
  }
  getMimeType() {
    return 'video/mp4'
  }
  getState() {
    return this.state
  }
  setSavePath(path: string) {
    this.path = path
    writeFileSync(path, 'fixture!')
  }
  cancel() {
    this.state = 'cancelled'
    this.emit('done', {}, 'cancelled')
  }
  complete() {
    this.state = 'completed'
    this.emit('done', {}, 'completed')
  }
}
beforeEach(() => {
  vi.useFakeTimers()
  root = realpathSync(mkdtempSync(join(tmpdir(), 'native-douyin-')))
  owner = web()
  guest = web()
  open = vi.fn()
  controller = new DesktopDouyinDownloads(open, async () => ['1.1.1.1'])
  controller.activeSession(owner as never, 'session-a')
  request = {
    type: 'douyin-browser',
    requestId: randomUUID(),
    taskId: randomUUID() as never,
    action: 'prepare',
    sessionId: 'session-a',
    cwd: root,
    url: page,
    maxDownloadBytes: 100 * 1024 ** 2,
  }
})
afterEach(async () => {
  await controller.dispose()
  rmSync(root, { recursive: true, force: true })
  vi.useRealTimers()
})
async function prepared() {
  const pending = controller.request(owner as never, request)
  controller.attached({
    owner: owner as never,
    guest: guest as never,
    lease: 'lease-a' as never,
    workspace: `cwd:${root}`,
    sessionId: 'session-a',
  })
  await vi.advanceTimersByTimeAsync(100)
  expect((await pending).code).toBe('PREPARED')
}
async function transfer() {
  await prepared()
  const result = controller.request(owner as never, {
    ...request,
    action: 'download',
    requestId: randomUUID(),
    targetVideoId: id,
  })
  controller.response({
    webContentsId: guest.id,
    statusCode: 206,
    resourceType: 'media',
    url: media,
    responseHeaders: { 'content-type': ['video/mp4'] },
  } as never)
  await vi.advanceTimersByTimeAsync(100)
  expect(guest.downloadURL).toHaveBeenCalledWith(media)
  return { result }
}

it('uses an observed player MP4 fetched through XHR when the visible source and work match', async () => {
  await prepared()
  const result = controller.request(owner as never, { ...request, action: 'download', targetVideoId: id })
  controller.response({ webContentsId: guest.id, statusCode: 206, resourceType: 'xhr', url: media,
    responseHeaders: { 'Content-Type': ['video/mp4'] } } as never)
  await vi.advanceTimersByTimeAsync(100)
  expect(guest.downloadURL).toHaveBeenCalledWith(media)
  await controller.request(owner as never, { ...request, action: 'release' })
  expect((await result).code).toBe('CANCELLED')
})

it('keeps the successful player response when another video responds during a playback probe', async () => {
  await prepared()
  let resolvePlayer: (value: unknown) => void = () => { throw new Error('Missing playback waiter') }
  guest.executeJavaScript.mockImplementation(() => new Promise((resolve) => { resolvePlayer = resolve }))
  const result = controller.request(owner as never, { ...request, action: 'download', targetVideoId: id })
  controller.response({ webContentsId: guest.id, statusCode: 200, resourceType: 'media', url: media,
    responseHeaders: { 'Content-Type': ['video/mp4'] } } as never)
  controller.response({ webContentsId: guest.id, statusCode: 206, resourceType: 'xhr',
    url: 'https://v3.douyinvod.com/recommendation.mp4', responseHeaders: { 'Content-Type': ['video/mp4'] } } as never)
  resolvePlayer({ id, src: media })
  await vi.advanceTimersByTimeAsync(0)
  expect(guest.downloadURL).toHaveBeenCalledOnce()
  expect(guest.downloadURL).toHaveBeenCalledWith(media)
  await controller.request(owner as never, { ...request, action: 'release' })
  expect((await result).code).toBe('CANCELLED')
})
it('allows only official pages, a single target ID and public HTTPS CDN names', () => {
  for (const url of [
    'http://www.douyin.com/video/' + id,
    'https://x:pass@www.douyin.com/video/' + id,
    'https://www.douyin.com.evil.test/video/' + id,
    'https://127.0.0.1/video/' + id,
    'file:///tmp/video',
  ])
    expect(douyinPage(url)).toBe(false)
  expect(douyinPage(page)).toBe(true)
  expect(douyinPage('https://v.douyin.com/zz584KwAVaA/')).toBe(true)
  expect(targetVideoId(page + '?modal_id=7690000000000000000')).toBeUndefined()
  for (const url of [
    'https://douyinvod.com.evil.test/x',
    'blob:https://www.douyin.com/x',
    'https://127.0.0.1/x',
    media.replace('https:', 'http:'),
    media.replace('.com/', '.com:9443/'),
  ])
    expect(douyinMedia(url)).toBe(false)
  expect(parseDouyinRequest({ ...request, action: 'download' })).toBeUndefined()
  expect(parseDouyinRequest({ ...request, cwd: '/tmp\0bad' })).toBeUndefined()
  for (const maxDownloadBytes of [undefined, 0, -1, 1.5, Infinity, 8 * 1024 ** 3 + 1])
    expect(parseDouyinRequest({ ...request, maxDownloadBytes })).toBeUndefined()
  expect(parseDouyinRequest({ ...request, maxDownloadBytes: 512 * 1024 ** 2 })).toBeDefined()
})
it('denies unrequested and replayed downloads while allowing one exact guest ticket', async () => {
  expect(controller.accept(new Item() as never, guest as never)).toBe(false)
  const { result } = await transfer()
  const wrong = new Item()
  wrong.url = media + 'x'
  expect(controller.accept(wrong as never, guest as never)).toBe(false)
  expect(controller.accept(new Item() as never, owner as never)).toBe(false)
  const item = new Item()
  expect(controller.accept(item as never, guest as never)).toBe(true)
  expect(controller.accept(new Item() as never, guest as never)).toBe(false)
  item.complete()
  const staged = await result
  expect(staged.code).toBe('STAGED')
  expect(JSON.stringify(staged)).not.toContain('secret=')
  expect(staged.evidence?.mediaUrlHash).toMatch(/^[a-f0-9]{64}$/)
})
it('waits for the share-page navigation to finish before granting the target reload', async () => {
  let loading = true
  guest.isLoadingMainFrame = () => loading
  const result = controller.request(owner as never, { ...request, url: 'https://v.douyin.com/zz584KwAVaA/' })
  controller.attached({ owner: owner as never, guest: guest as never, lease: 'lease-a' as never,
    workspace: `cwd:${root}`, sessionId: 'session-a' })
  const reply = vi.fn()
  void result.then(reply)
  await vi.advanceTimersByTimeAsync(500)
  expect(reply).not.toHaveBeenCalled()
  expect(guest.reload).not.toHaveBeenCalled()
  loading = false
  await vi.advanceTimersByTimeAsync(100)
  expect(await result).toMatchObject({ code: 'PREPARED', targetVideoId: id })
})
it('does not identify recommended, wrong-ID, blob or absent-metadata media as the target', async () => {
  for (const player of [
    null,
    { id: '7690000000000000000', src: media },
    { id, src: 'blob:https://www.douyin.com/x' },
  ]) {
    guest.executeJavaScript.mockResolvedValue(player)
    const prep = controller.request(owner as never, request)
    controller.attached({
      owner: owner as never,
      guest: guest as never,
      lease: 'lease-a' as never,
      workspace: `cwd:${root}`,
      sessionId: 'session-a',
    })
    await vi.advanceTimersByTimeAsync(100)
    await prep
    const result = controller.request(owner as never, { ...request, action: 'download', targetVideoId: id })
    controller.response({
      webContentsId: guest.id,
      statusCode: 200,
      resourceType: 'media',
      url: media,
      responseHeaders: { 'Content-Type': ['video/mp4'] },
    } as never)
    await vi.advanceTimersByTimeAsync(120_000)
    expect((await result).code).toBe('UNSUPPORTED_MEDIA_ASSOCIATION')
    expect(guest.downloadURL).not.toHaveBeenCalled()
    request = { ...request, taskId: randomUUID() as never }
  }
})
it('fails closed on other owners, sessions, targets, repeated clicks and leases', async () => {
  const prep = controller.request(owner as never, request)
  expect((await controller.request(owner as never, { ...request, taskId: randomUUID() as never })).code).toBe('BUSY')
  expect((await controller.request(web() as never, request)).code).toBe('SESSION_NOT_VISIBLE')
  controller.attached({
    owner: owner as never,
    guest: guest as never,
    lease: 'lease-a' as never,
    workspace: '/wrong',
    sessionId: 'session-a',
  })
  await vi.advanceTimersByTimeAsync(100)
  expect(open).toHaveBeenCalledOnce()
  await controller.request(owner as never, { ...request, action: 'release' })
  expect((await prep).code).toBe('CANCELLED')
  await prepared()
  expect((await controller.request(owner as never, {
    ...request, action: 'download', targetVideoId: id, maxDownloadBytes: 512 * 1024 ** 2,
  })).code).toBe('GRANT_MISMATCH')
  expect(
    (await controller.request(owner as never, { ...request, action: 'download', targetVideoId: '7690000000000000000' }))
      .code,
  ).toBe('GRANT_MISMATCH')
})
it.each(['session', 'lease', 'close', 'target', 'host', 'cancel'])(
  'revokes active media on %s and removes staging after cancellation',
  async (reason) => {
    const { result } = await transfer()
    const item = new Item()
    expect(controller.accept(item as never, guest as never)).toBe(true)
    if (reason === 'session') controller.activeSession(owner as never, 'session-b')
    if (reason === 'lease') controller.released('lease-a' as never)
    if (reason === 'close') guest.isDestroyed = () => true
    if (reason === 'target') guest.getURL = () => page.replace(id, '7690000000000000000')
    if (reason === 'host') void controller.dispose()
    if (reason === 'cancel') await controller.request(owner as never, { ...request, action: 'release' })
    await vi.advanceTimersByTimeAsync(100)
    expect((await result).code).not.toBe('STAGED')
    expect(item.state).toBe('cancelled')
    expect(existsSync(item.path)).toBe(false)
    expect(controller.accept(new Item() as never, guest as never)).toBe(false)
  },
)
it.each(['oversize', 'interrupted', 'redirect', 'truncated'])(
  'rejects %s instead of publishing transport completion',
  async (reason) => {
    const { result } = await transfer()
    const item = new Item()
    expect(controller.accept(item as never, guest as never)).toBe(true)
    if (reason === 'oversize') item.got = 101 * 1024 ** 2
    if (reason === 'redirect') item.chain.push('https://127.0.0.1/private')
    if (reason === 'truncated') item.got = 2
    if (reason === 'interrupted') {
      item.state = 'interrupted'
      item.emit('done', {}, 'interrupted')
    } else item.complete()
    expect((await result).code).toBe('INCOMPLETE_MEDIA')
    expect(existsSync(item.path)).toBe(false)
  },
)
it('accepts a video larger than 100 MiB when the deployment permits it', async () => {
  request = { ...request, maxDownloadBytes: 512 * 1024 ** 2 }
  const { result } = await transfer()
  const item = new Item()
  item.total = item.got = 150 * 1024 ** 2
  expect(controller.accept(item as never, guest as never)).toBe(true)
  item.complete()
  expect((await result).code).toBe('STAGED')
})
it('rejects the declared file size before saving when it exceeds the deployment limit', async () => {
  request = { ...request, maxDownloadBytes: 7 }
  const { result } = await transfer()
  expect(controller.accept(new Item() as never, guest as never)).toBe(false)
  expect((await result).code).toBe('SIZE_LIMIT')
})

async function providerTransfer() {
  const debug = fixtureDebugger()
  Object.assign(guest, { debugger: debug })
  guest.executeJavaScript.mockResolvedValue({ duration: 34.41, sourceSupported: true, protected: false })
  guest.reload.mockImplementation(() => {
    guest.emit('did-start-navigation', {}, page, false, true)
    debug.emit('message', {}, 'Page.frameNavigated', { frame: { id: 'main', loaderId: 'loader' } })
  })
  await prepared()
  const result = controller.request(owner as never, { ...request, action: 'download', targetVideoId: id })
  await vi.advanceTimersByTimeAsync(100)
  return { result, debug }
}

it('waits for exact provider evidence after an observed MP4 encounters a blob player', async () => {
  const { result, debug } = await providerTransfer()
  guest.executeJavaScript.mockImplementation(async source => source === DOUYIN_PLAYER_PROBE
    ? { unsupported: 'BLOB_OR_SEGMENTS' }
    : { duration: 34.41, sourceSupported: true, protected: false, src: 'blob:https://www.douyin.com/fixture' })
  controller.response({ webContentsId: guest.id, statusCode: 206, resourceType: 'xhr', url: fixtureMedia,
    responseHeaders: { 'Content-Type': ['video/mp4'] } } as never)
  await vi.advanceTimersByTimeAsync(0)
  expect(guest.executeJavaScript).toHaveBeenCalledWith(DOUYIN_PLAYER_PROBE)
  expect(controller.isActive).toBe(true)
  expect(guest.downloadURL).not.toHaveBeenCalled()
  await fixtureResponse(debug)
  await vi.advanceTimersByTimeAsync(0)
  expect(guest.downloadURL).toHaveBeenCalledExactlyOnceWith(fixtureMedia)
  const item = new Item()
  item.url = fixtureMedia
  item.chain = [fixtureMedia]
  expect(controller.accept(item as never, guest as never)).toBe(true)
  controller.response({ webContentsId: guest.id, statusCode: 200, resourceType: 'other', url: fixtureMedia,
    responseHeaders: { 'Content-Type': ['video/mp4'] } } as never)
  item.complete()
  expect(await result).toMatchObject({ code: 'STAGED', evidence: {
    association: 'provider-detail-verified', currentSrcMatched: false, provider: { targetVideoId: id, documentEpoch: 1 },
  } })
})

it('retains a blob player while the exact provider observer is still starting', async () => {
  const debug = fixtureDebugger()
  const frame = Promise.withResolvers<object>()
  const tree = { frameTree: { frame: { id: 'main', loaderId: 'loader' } } }
  debug.sendCommand.mockImplementation(async method => method === 'Page.getFrameTree' ? frame.promise
    : method === 'Network.getResponseBody' ? { body: JSON.stringify(fixtureBody()), base64Encoded: false } : {})
  Object.assign(guest, { debugger: debug })
  guest.reload.mockImplementation(() => {
    guest.emit('did-start-navigation', {}, page, false, true)
    debug.emit('message', {}, 'Page.frameNavigated', { frame: { id: 'main', loaderId: 'loader' } })
  })
  guest.executeJavaScript.mockImplementation(async source => source === DOUYIN_PLAYER_PROBE
    ? { unsupported: 'BLOB_OR_SEGMENTS' }
    : { duration: 34.41, sourceSupported: true, protected: false, src: 'blob:https://www.douyin.com/fixture' })
  await prepared()
  const result = controller.request(owner as never, { ...request, action: 'download', targetVideoId: id })
  try {
    await vi.advanceTimersByTimeAsync(0)
    expect(debug.sendCommand).toHaveBeenCalledWith('Page.getFrameTree')
    expect(guest.reload).not.toHaveBeenCalled()
    controller.response({ webContentsId: guest.id, statusCode: 206, resourceType: 'xhr', url: fixtureMedia,
      responseHeaders: { 'Content-Type': ['video/mp4'] } } as never)
    await vi.advanceTimersByTimeAsync(0)
    expect(controller.isActive).toBe(true)
    expect(guest.downloadURL).not.toHaveBeenCalled()
    frame.resolve(tree)
    await vi.advanceTimersByTimeAsync(0)
    expect(guest.reload).toHaveBeenCalledOnce()
    await fixtureResponse(debug)
    await vi.advanceTimersByTimeAsync(0)
    expect(guest.downloadURL).toHaveBeenCalledExactlyOnceWith(fixtureMedia)
    await controller.request(owner as never, { ...request, action: 'release' })
    expect((await result).code).toBe('CANCELLED')
  } finally {
    frame.resolve(tree)
    await vi.advanceTimersByTimeAsync(0)
  }
})

it('rejects a blob player when provider observation is unavailable', async () => {
  guest.executeJavaScript.mockResolvedValue({ unsupported: 'BLOB_OR_SEGMENTS' })
  await prepared()
  const result = controller.request(owner as never, { ...request, action: 'download', targetVideoId: id })
  await vi.advanceTimersByTimeAsync(0)
  controller.response({ webContentsId: guest.id, statusCode: 206, resourceType: 'xhr', url: fixtureMedia,
    responseHeaders: { 'Content-Type': ['video/mp4'] } } as never)
  await vi.advanceTimersByTimeAsync(0)
  expect((await result).code).toBe('UNSUPPORTED_MEDIA_ASSOCIATION')
  expect(guest.downloadURL).not.toHaveBeenCalled()
  expect(guest.debugger.isAttached()).toBe(true)
})

it('rejects a protected player even while provider observation is available', async () => {
  const { result, debug } = await providerTransfer()
  guest.executeJavaScript.mockResolvedValue({ unsupported: 'PROTECTED_MEDIA' })
  controller.response({ webContentsId: guest.id, statusCode: 206, resourceType: 'xhr', url: fixtureMedia,
    responseHeaders: { 'Content-Type': ['video/mp4'] } } as never)
  await vi.advanceTimersByTimeAsync(0)
  expect((await result).code).toBe('UNSUPPORTED_MEDIA_ASSOCIATION')
  expect(guest.downloadURL).not.toHaveBeenCalled()
  expect(debug.isAttached()).toBe(false)
})

it('expires a blob association when an available observer never supplies exact provider evidence', async () => {
  const { result, debug } = await providerTransfer()
  guest.executeJavaScript.mockResolvedValue({ unsupported: 'BLOB_OR_SEGMENTS' })
  controller.response({ webContentsId: guest.id, statusCode: 206, resourceType: 'xhr', url: fixtureMedia,
    responseHeaders: { 'Content-Type': ['video/mp4'] } } as never)
  await vi.advanceTimersByTimeAsync(120_000)
  expect((await result).code).toBe('UNSUPPORTED_MEDIA_ASSOCIATION')
  expect(guest.downloadURL).not.toHaveBeenCalled()
  expect(debug.isAttached()).toBe(false)
})

it('stages only native MP4 completion with provider evidence and never claims currentSrc equality', async () => {
  const { result, debug } = await providerTransfer()
  await fixtureResponse(debug)
  await vi.advanceTimersByTimeAsync(100)
  expect(guest.downloadURL).toHaveBeenCalledWith(fixtureMedia)
  const item = new Item()
  item.url = fixtureMedia
  item.chain = [fixtureMedia]
  expect(controller.accept(item as never, guest as never)).toBe(true)
  controller.response({
    webContentsId: guest.id,
    statusCode: 200,
    resourceType: 'other',
    url: fixtureMedia,
    responseHeaders: { 'Content-Type': ['video/mp4'] },
  } as never)
  item.complete()
  expect(await result).toMatchObject({
    code: 'STAGED',
    evidence: {
      association: 'provider-detail-verified',
      currentSrcMatched: false,
      provider: { targetVideoId: id, documentEpoch: 1 },
    },
  })
  expect(debug.isAttached()).toBe(false)
})
it.each(['wrong-duration', 'protected', 'changed-document', 'private-dns', 'wrong-response'])(
  'rejects provider transfer on %s',
  async (reason) => {
    if (reason === 'private-dns') {
      controller = new DesktopDouyinDownloads(open, async () => ['127.0.0.1'])
      controller.activeSession(owner as never, 'session-a')
    }
    const { result, debug } = await providerTransfer()
    if (reason === 'wrong-duration')
      guest.executeJavaScript.mockResolvedValue({ duration: 1, sourceSupported: true, protected: false })
    if (reason === 'protected') {
      const body = fixtureBody()
      Object.assign(body.aweme_detail.video, { drm_type: 1 })
      debug.sendCommand.mockResolvedValue({ body: JSON.stringify(body), base64Encoded: false })
    }
    if (reason === 'changed-document') guest.emit('did-start-navigation', {}, page, false, true)
    await fixtureResponse(debug)
    await vi.advanceTimersByTimeAsync(100)
    if (reason === 'wrong-response') {
      const item = new Item()
      item.url = fixtureMedia
      item.chain = [fixtureMedia]
      expect(controller.accept(item as never, guest as never)).toBe(true)
      controller.response({
        webContentsId: guest.id,
        statusCode: 403,
        resourceType: 'other',
        url: fixtureMedia,
        responseHeaders: { 'Content-Type': ['text/html'] },
      } as never)
    }
    await vi.advanceTimersByTimeAsync(120_000)
    expect((await result).code).not.toBe('STAGED')
    if (reason !== 'wrong-response') expect(guest.downloadURL).not.toHaveBeenCalled()
    expect(debug.isAttached()).toBe(false)
  },
)
it('retains provider facts until main-document loading finishes before probing playback', async () => {
  const { debug } = await providerTransfer()
  guest.isLoadingMainFrame = () => true
  await fixtureResponse(debug)
  await vi.advanceTimersByTimeAsync(500)
  expect(guest.executeJavaScript).not.toHaveBeenCalled()
  expect(guest.downloadURL).not.toHaveBeenCalled()
  guest.isLoadingMainFrame = () => false
  await vi.advanceTimersByTimeAsync(100)
  expect(guest.downloadURL).toHaveBeenCalledWith(fixtureMedia)
})
it('uses the leased browser network resolver for media and redirect address checks', async () => {
  controller = new DesktopDouyinDownloads(open)
  controller.activeSession(owner as never, 'session-a')
  const { result, debug } = await providerTransfer()
  await fixtureResponse(debug)
  await vi.advanceTimersByTimeAsync(100)
  expect(guest.session.resolveHost).toHaveBeenCalledWith('v3.douyinvod.com')
  expect(guest.downloadURL).toHaveBeenCalledWith(fixtureMedia)
  guest.session.resolveHost.mockResolvedValue({ endpoints: [{ address: '127.0.0.1', family: 'ipv4' }] })
  expect(await controller.blocksRequest('https://v4.douyinvod.com/redirect.mp4', guest.id)).toBe(true)
  expect(guest.session.resolveHost).toHaveBeenLastCalledWith('v4.douyinvod.com')
  expect((await result).code).toBe('PRIVATE_MEDIA_ADDRESS')
})
it.each(['player', 'dns', 'staging', 'download'] as const)(
  'reports the failed provider %s stage without disclosing response data', async (stage) => {
    if (stage === 'dns') {
      controller = new DesktopDouyinDownloads(open, async () => { throw new Error('private diagnostics') })
      controller.activeSession(owner as never, 'session-a')
    }
    const { result, debug } = await providerTransfer()
    if (stage === 'player') guest.executeJavaScript.mockRejectedValue(new Error('private diagnostics'))
    if (stage === 'staging') writeFileSync(join(root, 'source'), 'not a directory')
    if (stage === 'download') guest.downloadURL.mockImplementation(() => { throw new Error('private diagnostics') })
    await fixtureResponse(debug)
    await vi.advanceTimersByTimeAsync(100)
    const codes = { player: 'PLAYER_PROBE_UNAVAILABLE', dns: 'MEDIA_DNS_UNAVAILABLE',
      staging: 'MEDIA_STAGING_UNAVAILABLE', download: 'NATIVE_DOWNLOAD_UNAVAILABLE' }
    const response = await result
    expect(response.code).toBe(codes[stage])
    expect(JSON.stringify(response)).not.toContain('private diagnostics')
  },
)
it('denies private redirect resolution and cannot issue a download after cancellation during DNS', async () => {
  const dns = Promise.withResolvers<readonly string[]>()
  controller = new DesktopDouyinDownloads(open, () => dns.promise)
  controller.activeSession(owner as never, 'session-a')
  const { result, debug } = await providerTransfer()
  await fixtureResponse(debug)
  await controller.request(owner as never, { ...request, action: 'release' })
  dns.resolve(['1.1.1.1'])
  await vi.advanceTimersByTimeAsync(100)
  expect((await result).code).toBe('CANCELLED')
  expect(guest.downloadURL).not.toHaveBeenCalled()
  controller = new DesktopDouyinDownloads(open, async host => [host === 'v3.douyinvod.com' ? '1.1.1.1' : '10.0.0.1'])
  controller.activeSession(owner as never, 'session-a')
  request = { ...request, taskId: randomUUID() as never }
  const next = await providerTransfer()
  await fixtureResponse(next.debug)
  await vi.advanceTimersByTimeAsync(100)
  expect(await controller.blocksRequest('https://v4.douyinvod.com/redirect.mp4', guest.id)).toBe(true)
  expect((await next.result).code).toBe('PRIVATE_MEDIA_ADDRESS')
})

it('uses the playing verified alternative when the first provider address returns 403', async () => {
  const backup = 'https://v26-web.douyinvod.com/video.mp4?synthetic=backup'
  const { result, debug } = await providerTransfer()
  const body = fixtureBody()
  body.aweme_detail.video.bit_rate = [{ bit_rate: 1000000, play_addr: { url_list: [fixtureMedia, backup] } }]
  debug.sendCommand.mockResolvedValue({ body: JSON.stringify(body), base64Encoded: false })
  guest.executeJavaScript.mockResolvedValue({ duration: 34.41, sourceSupported: true, protected: false, src: backup })
  guest.downloadURL.mockImplementation((selected: string) => {
    controller.response({ webContentsId: guest.id, statusCode: 403, resourceType: 'other', url: fixtureMedia,
      responseHeaders: { 'Content-Type': ['text/html'] } } as never)
    if (selected === backup) controller.response({ webContentsId: guest.id, statusCode: 206, resourceType: 'other',
      url: backup, responseHeaders: { 'Content-Type': ['video/mp4'] } } as never)
  })
  await fixtureResponse(debug)
  await vi.advanceTimersByTimeAsync(100)
  expect(guest.downloadURL).toHaveBeenCalledExactlyOnceWith(backup)
  const item = new Item()
  item.url = backup
  item.chain = [backup]
  expect(controller.accept(item as never, guest as never)).toBe(true)
  item.complete()
  expect(await result).toMatchObject({ code: 'STAGED', evidence: { responseStatus: 206,
    association: 'provider-detail-verified', provider: { targetVideoId: id, documentEpoch: 1 } } })
})

it.each([
  'https://v5.douyinvod.com/unlisted.mp4?synthetic=not-authorized',
  'https://untrusted.example/video.mp4',
  'blob:https://www.douyin.com/playing-video',
])('cannot authorize a player address outside its verified provider list: %s', async (unlisted) => {
  const { result, debug } = await providerTransfer()
  guest.executeJavaScript.mockResolvedValue({ duration: 34.41, sourceSupported: true, protected: false, src: unlisted })
  await fixtureResponse(debug)
  await vi.advanceTimersByTimeAsync(100)
  expect(guest.downloadURL).toHaveBeenCalledExactlyOnceWith(fixtureMedia)
  expect(guest.downloadURL).not.toHaveBeenCalledWith(unlisted)
  const item = new Item()
  item.url = unlisted
  item.chain = [unlisted]
  expect(controller.accept(item as never, guest as never)).toBe(false)
  await controller.request(owner as never, { ...request, action: 'release' })
  expect((await result).code).toBe('CANCELLED')
})

it('does not authorize a playing address from a wrong-target provider response', async () => {
  const { result, debug } = await providerTransfer()
  const body = fixtureBody()
  body.aweme_detail.aweme_id = '7690000000000000000'
  debug.sendCommand.mockResolvedValue({ body: JSON.stringify(body), base64Encoded: false })
  guest.executeJavaScript.mockResolvedValue({ duration: 34.41, sourceSupported: true, protected: false, src: fixtureMedia })
  await fixtureResponse(debug)
  await vi.advanceTimersByTimeAsync(120_000)
  expect(guest.downloadURL).not.toHaveBeenCalled()
  expect((await result).code).toBe('UNSUPPORTED_MEDIA_ASSOCIATION')
})

it('discards player selection when its exact-target document changes during the probe', async () => {
  const { result, debug } = await providerTransfer()
  const probing = Promise.withResolvers<unknown>()
  guest.executeJavaScript.mockImplementation(() => probing.promise)
  await fixtureResponse(debug)
  expect(guest.executeJavaScript).toHaveBeenCalledOnce()
  guest.emit('did-start-navigation', {}, page, false, true)
  probing.resolve({ duration: 34.41, sourceSupported: true, protected: false, src: fixtureMedia })
  await vi.advanceTimersByTimeAsync(100)
  expect(guest.downloadURL).not.toHaveBeenCalled()
  expect((await result).code).toBe('DOCUMENT_CHANGED')
  expect(debug.isAttached()).toBe(false)
})

it('joins native cancellation before removing the selected provider download', async () => {
  const { result, debug } = await providerTransfer()
  guest.executeJavaScript.mockResolvedValue({ duration: 34.41, sourceSupported: true, protected: false, src: fixtureMedia })
  await fixtureResponse(debug)
  await vi.advanceTimersByTimeAsync(100)
  class DeferredItem extends Item {
    requested = false
    override cancel() { this.requested = true }
    close() { this.state = 'cancelled'; this.emit('done', {}, 'cancelled') }
  }
  const item = new DeferredItem()
  item.url = fixtureMedia
  item.chain = [fixtureMedia]
  expect(controller.accept(item as never, guest as never)).toBe(true)
  expect(controller.isActive).toBe(true)
  let released = false
  const releasing = controller.request(owner as never, { ...request, action: 'release' }).then(() => { released = true })
  try {
    expect(item.requested).toBe(true)
    expect(controller.isActive).toBe(false)
    expect((await result).code).toBe('CANCELLED')
    expect(released).toBe(false)
    expect(existsSync(item.path)).toBe(true)
  } finally { item.close(); await releasing }
  expect(released).toBe(true)
  expect(existsSync(item.path)).toBe(false)
  expect(guest.downloadURL).toHaveBeenCalledExactlyOnceWith(fixtureMedia)
})
