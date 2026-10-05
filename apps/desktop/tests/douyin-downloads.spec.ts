import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, realpathSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi, type Mock } from 'vitest'
import { DesktopDouyinDownloads } from '../src/douyin-downloads.ts'
import { douyinMedia, douyinPage, parseDouyinRequest, targetVideoId } from '../src/douyin-policy.ts'
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
    reload: vi.fn(),
    downloadURL: vi.fn(),
    debugger: { isAttached: () => true },
    executeJavaScript: vi.fn(async () => ({ id, src: media })),
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
it('does not identify recommended, wrong-ID, blob or absent-metadata media as the target', async () => {
  for (const player of [
    null,
    { id: '7690000000000000000', src: media },
    { id, src: 'blob:https://www.douyin.com/x' },
  ]) {
    guest.executeJavaScript.mockResolvedValue(player as never)
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

async function providerTransfer() {
  const debug = fixtureDebugger()
  Object.assign(guest, { debugger: debug })
  guest.executeJavaScript.mockResolvedValue({ duration: 34.41, https: true, protected: false } as never)
  guest.reload.mockImplementation(() => {
    guest.emit('did-start-navigation', {}, page, false, true)
    debug.emit('message', {}, 'Page.frameNavigated', { frame: { id: 'main', loaderId: 'loader' } })
  })
  await prepared()
  const result = controller.request(owner as never, { ...request, action: 'download', targetVideoId: id })
  await vi.advanceTimersByTimeAsync(100)
  return { result, debug }
}
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
      guest.executeJavaScript.mockResolvedValue({ duration: 1, https: true, protected: false } as never)
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
