import { Script } from 'node:vm'
import { expect, it, vi } from 'vitest'
import {
  ProviderResponses,
  providerSources,
  providerRequest,
  providerMP4,
  publicMediaAddress,
  PROVIDER_MAX_BYTES,
  PROVIDER_PLAYER_PROBE,
} from '../src/douyin-provider.ts'
import {
  fixtureId as id,
  fixtureMedia as media,
  fixtureDetail as detail,
  fixtureBody,
  fixtureDebugger,
  fixtureResponse,
} from './douyin-provider-fixture.ts'

it('selects the exact work bitrate list before its plain play address without rewriting signed URLs', () => {
  const result = providerSources(JSON.stringify(fixtureBody()), id)
  expect(result.sources[0]).toMatchObject({
    targetVideoId: id,
    urls: [media],
    sourceField: 'video.bit_rate.play_addr',
    durationMs: 34434,
    width: 3840,
    height: 2160,
  })
  expect(providerSources(JSON.stringify(fixtureBody()), '7690000000000000000').sources).toEqual([])
  expect(providerSources(JSON.stringify({ recommended: fixtureBody().aweme_detail }), id).sources).toEqual([])
})
it('rejects protected, malformed, unbounded and invalid-metadata detail bodies', () => {
  for (const body of [
    '{',
    ' '.repeat(PROVIDER_MAX_BYTES + 1),
    JSON.stringify({ aweme_detail: { aweme_id: id, video: { duration: -1 } } }),
  ])
    expect(providerSources(body, id).sources).toEqual([])
  const body = fixtureBody()
  Object.assign(body.aweme_detail.video.bit_rate[0]?.play_addr ?? {}, { drm_type: 1 })
  expect(providerSources(JSON.stringify(body), id)).toEqual({ sources: [], protected: true })
})
it('rejects proxy, manifest, credentials, lookalike hosts and duplicate/wrong work IDs', () => {
  expect(providerRequest(detail, id)).toBe(true)
  for (const url of [
    detail + '&aweme_id=' + id,
    detail.replace(id, '7690000000000000000'),
    detail.replace('www.douyin.com', 'www.douyin.com.evil.test'),
    detail.replace('https:', 'http:'),
  ])
    expect(providerRequest(url, id)).toBe(false)
  for (const url of [
    'https://www.douyin.com/aweme/v1/play/?mime_type=video_mp4',
    'https://v3.douyinvod.com/x.m3u8?mime_type=video_mp4',
    media + '#fragment',
    media.replace('https://', 'https://u:p@'),
    'blob:' + media,
  ])
    expect(providerMP4(url)).toBe(false)
})
it('rejects local, private, mapped IPv6 and reserved addresses', () => {
  for (const ip of [
    '127.0.0.1',
    '10.0.0.2',
    '100.64.1.1',
    '169.254.2.1',
    '192.168.1.2',
    '::1',
    '::ffff:127.0.0.1',
    'fc00::1',
    'fe80::1',
    'ff02::1',
    'invalid',
  ])
    expect(publicMediaAddress(ip)).toBe(false)
  for (const ip of ['1.1.1.1', '2606:4700:4700::1111']) expect(publicMediaAddress(ip)).toBe(true)
})
it('requires a unique loaded video and refuses an unbounded player list', () => {
  const video = {
    getBoundingClientRect: () => ({ width: 10, height: 10 }),
    readyState: 4,
    paused: false,
    duration: 34.41,
    currentSrc: media,
    mediaKeys: null,
  }
  const probe = (document: object): unknown => new Script(PROVIDER_PLAYER_PROBE).runInNewContext({ document, URL })
  expect(probe({ querySelectorAll: () => [video] })).toEqual({ duration: 34.41, sourceSupported: true, protected: false, src: media })
  expect(probe({ querySelectorAll: () => [{ ...video, currentSrc: 'blob:https://www.douyin.com/fixture' }] }))
    .toEqual({ duration: 34.41, sourceSupported: true, protected: false, src: 'blob:https://www.douyin.com/fixture' })
  for (const currentSrc of ['blob:https://other.test/fixture', 'blob:http://www.douyin.com/fixture', 'file:///tmp/video'])
    expect(probe({ querySelectorAll: () => [{ ...video, currentSrc }] }))
      .toEqual({ duration: 34.41, sourceSupported: false, protected: false, src: currentSrc })
  expect(probe({ querySelectorAll: () => [{ ...video, mediaKeys: {} }] }))
    .toEqual({ duration: 34.41, sourceSupported: true, protected: true, src: media })
  for (const list of [
    [video, video],
    Array.from({ length: 17 }, () => video),
    [{ ...video, readyState: 1 }],
  ])
    expect(probe({ querySelectorAll: () => list })).toBeNull()
})

it('reads a paused loaded player without changing playback', () => {
  const play = vi.fn(), pause = vi.fn()
  const video = { getBoundingClientRect: () => ({ width: 10, height: 10 }), readyState: 2, paused: true,
    duration: 34.41, currentSrc: 'blob:https://www.douyin.com/fixture', mediaKeys: null, play, pause }
  const result: unknown = new Script(PROVIDER_PLAYER_PROBE).runInNewContext({ document: { querySelectorAll: () => [video] }, URL })
  expect(result).toEqual({ duration: 34.41, sourceSupported: true, protected: false, src: video.currentSrc })
  expect(play).not.toHaveBeenCalled()
  expect(pause).not.toHaveBeenCalled()
})
it('reads only bounded exact main-document JSON responses and detaches its own observer', async () => {
  const debug = fixtureDebugger(),
    deliver = vi.fn(),
    protectedMedia = vi.fn()
  const observer = new ProviderResponses(
    { debugger: debug, isDestroyed: () => false } as never,
    id,
    () => 1,
    deliver,
    protectedMedia,
  )
  expect(await observer.start()).toBe(true)
  observer.newDocument()
  debug.emit('message', {}, 'Page.frameNavigated', { frame: { id: 'main', loaderId: 'loader' } })
  await fixtureResponse(debug)
  expect(deliver).toHaveBeenCalledWith(expect.objectContaining({ targetVideoId: id, documentEpoch: 1 }))
  expect(protectedMedia).not.toHaveBeenCalled()
  observer.close()
  expect(debug.detach).toHaveBeenCalledOnce()
  expect(debug.listenerCount('message')).toBe(0)
})
it.each(['wrong-frame', 'wrong-id', '403', 'oversize', 'reload', 'closed'])(
  'does not select from %s CDP evidence',
  async (reason) => {
    const debug = fixtureDebugger(),
      deliver = vi.fn()
    let epoch = 1
    const observer = new ProviderResponses(
      { debugger: debug, isDestroyed: () => false } as never,
      id,
      () => epoch,
      deliver,
      vi.fn(),
    )
    await observer.start()
    observer.newDocument()
    debug.emit('message', {}, 'Page.frameNavigated', { frame: { id: 'main', loaderId: 'loader' } })
    if (reason === 'reload') epoch = 2
    if (reason === 'closed') observer.close()
    await fixtureResponse(debug, {
      ...(reason === 'wrong-frame' ? { frame: 'child' } : {}),
      ...(reason === 'wrong-id' ? { url: detail.replace(id, '7690000000000000000') } : {}),
      ...(reason === '403' ? { status: 403 } : {}),
      ...(reason === 'oversize' ? { bytes: PROVIDER_MAX_BYTES + 1 } : {}),
    })
    expect(deliver).not.toHaveBeenCalled()
    observer.close()
  },
)
it('does not take over another debugger or deliver a body resolving after a document change', async () => {
  const debug = fixtureDebugger()
  debug.attach()
  const observer = new ProviderResponses(
    { debugger: debug, isDestroyed: () => false } as never,
    id,
    () => 1,
    vi.fn(),
    vi.fn(),
  )
  expect(await observer.start()).toBe(false)
  observer.close()
  expect(debug.detach).not.toHaveBeenCalled()
  debug.detach()
  let epoch = 1
  const deliver = vi.fn(),
    deferred = Promise.withResolvers<object>()
  const next = new ProviderResponses(
    { debugger: debug, isDestroyed: () => false } as never,
    id,
    () => epoch,
    deliver,
    vi.fn(),
  )
  await next.start()
  next.newDocument()
  debug.emit('message', {}, 'Page.frameNavigated', { frame: { id: 'main', loaderId: 'loader' } })
  debug.sendCommand.mockImplementation(async () => deferred.promise)
  await fixtureResponse(debug)
  epoch = 2
  next.newDocument()
  deferred.resolve({ body: JSON.stringify(fixtureBody()), base64Encoded: false })
  for (let i = 0; i < 12; i++) await Promise.resolve()
  expect(deliver).not.toHaveBeenCalled()
  next.close()
})
