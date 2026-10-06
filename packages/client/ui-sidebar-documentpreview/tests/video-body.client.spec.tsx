// @vitest-environment jsdom
/** Native controls load metadata, report unsupported encodings and stop requests on unmount. */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import type { MockInstance } from 'vitest'
import { VideoBody, type VideoBodyInjected, type VideoBodyProps, type VideoSource } from '../src/client/video/VideoBody.tsx'
import { en } from '../src/client/video/locales.ts'
import { videoUrl } from '../src/client/video/index.ts'

let pause: MockInstance<HTMLMediaElement['pause']>
let load: MockInstance<HTMLMediaElement['load']>
beforeEach(() => {
  pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
  load = vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {})
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

function props(resolveSource = vi.fn<VideoBodyInjected['resolveSource']>().mockResolvedValue({ url: 'http://localhost/api/video?sessionId=owner&path=clip.mp4', version: 'v1' })): VideoBodyProps {
  const signal = new AbortController().signal
  return {
    sessionId: 'owner' as SessionId,
    resourceAddress: 'dsh-resource://file/session/owner/clip.mp4',
    content: { kind: 'renderer', revision: 1, loaded: vi.fn(), failed: vi.fn(), reload: vi.fn() },
    wrap: false, scrollportRef: vi.fn(), addResource: vi.fn(), setResources: vi.fn(), resolveSource,
    useTabInfo: () => ({ tab: { id: 'video-tab' as TabId, signal } }),
    useResource: () => ({ value: undefined }), t: (key: keyof typeof en) => en[key],
  } as VideoBodyProps
}

it('shows inline native playback controls and reports the loaded source version', async () => {
  const p = props()
  const view = render(<VideoBody {...p} />)
  const player = await screen.findByLabelText(en.player)
  expect(player.tagName).toBe('VIDEO')
  expect(player.hasAttribute('controls')).toBe(true)
  expect(player.hasAttribute('playsinline')).toBe(true)
  expect(player.getAttribute('preload')).toBe('metadata')
  expect(player.hasAttribute('autoplay')).toBe(false)
  fireEvent.loadedMetadata(player)
  expect(p.content.kind === 'renderer' && p.content.loaded).toHaveBeenCalledWith('v1')
  view.unmount()
  expect(pause).toHaveBeenCalled()
  expect(load).toHaveBeenCalled()
  expect(player.hasAttribute('src')).toBe(false)
})

it('keeps unsupported encoding and connection failure visible with localized copy', async () => {
  const p = props()
  render(<VideoBody {...p} />)
  fireEvent.error(await screen.findByLabelText(en.player))
  expect((await screen.findByRole('alert')).textContent).toBe(en.failed)
  expect(p.content.kind === 'renderer' && p.content.failed).toHaveBeenCalledOnce()
})

it('cancels pending metadata reads when the addressed video changes', async () => {
  let settle!: (source: VideoSource) => void
  const pending = new Promise<VideoSource>((yes) => { settle = yes })
  const resolve = vi.fn<VideoBodyInjected['resolveSource']>(() => pending)
  const p = props(resolve)
  const view = render(<VideoBody {...p} />)
  expect(resolve).toHaveBeenCalledOnce()
  const signal = resolve.mock.calls[0]![1]
  view.unmount()
  expect(signal.aborted).toBe(true)
  await act(async () => { settle({ url: 'http://localhost/api/video', version: 'late' }); await pending })
  expect(p.content.kind === 'renderer' && p.content.loaded).not.toHaveBeenCalled()
})

it('reports failed metadata in place and ignores a late failure after the tab closes', async () => {
  const current = props(vi.fn<VideoBodyInjected['resolveSource']>().mockRejectedValue(new Error('private transport diagnostic')))
  const view = render(<VideoBody {...current} />)
  expect((await screen.findByRole('alert')).textContent).toBe(en.failed)
  expect(current.content.kind === 'renderer' && current.content.failed).toHaveBeenCalledOnce()
  view.unmount()
  let reject!: (reason: Error) => void
  const pending = new Promise<VideoSource>((_yes, no) => { reject = no })
  const later = props(vi.fn<VideoBodyInjected['resolveSource']>(() => pending))
  const closed = new AbortController()
  const tab = later.useTabInfo().tab
  render(<VideoBody {...later} useTabInfo={() => ({ ...later.useTabInfo(), tab: { ...tab, signal: closed.signal } })} />)
  closed.abort()
  await act(async () => { reject(new Error('late private error')); await pending.catch(() => {}) })
  expect(later.content.kind === 'renderer' && later.content.failed).not.toHaveBeenCalled()
  expect(screen.queryByRole('alert')).toBeNull()
})

it('leaves ordinary byte content to its owner without requesting video metadata', () => {
  const resolve = vi.fn<VideoBodyInjected['resolveSource']>()
  const view = render(<VideoBody {...props(resolve)} content={{ kind: 'bytes', data: new Uint8Array(0) }} />)
  expect(view.container.childElementCount).toBe(0)
  expect(resolve).not.toHaveBeenCalled()
})

it('retains the new revision when old metadata or removed player events arrive', async () => {
  let settle!: (source: VideoSource) => void
  const pending = new Promise<VideoSource>((yes) => { settle = yes })
  const resolve = vi.fn<VideoBodyInjected['resolveSource']>()
    .mockResolvedValueOnce({ url: 'http://localhost/api/video?version=old', version: 'old' })
    .mockImplementationOnce(() => pending)
    .mockResolvedValueOnce({ url: 'http://localhost/api/video?version=current', version: 'current' })
  const p = props(resolve)
  const view = render(<VideoBody {...p} />)
  const oldPlayer = await screen.findByLabelText(en.player)
  const next = { kind: 'renderer' as const, revision: 2, loaded: vi.fn(), failed: vi.fn(), reload: vi.fn() }
  view.rerender(<VideoBody {...p} content={next} />)
  const latest = { ...next, revision: 3, loaded: vi.fn(), failed: vi.fn() }
  view.rerender(<VideoBody {...p} content={latest} />)
  const player = await screen.findByLabelText(en.player)
  await act(async () => { settle({ url: 'http://localhost/api/video?version=late', version: 'late' }); await pending })
  expect(player.getAttribute('src')).toContain('version=current')
  fireEvent.loadedMetadata(oldPlayer)
  fireEvent.error(oldPlayer)
  expect(p.content.kind === 'renderer' && p.content.loaded).not.toHaveBeenCalled()
  expect(p.content.kind === 'renderer' && p.content.failed).not.toHaveBeenCalled()
  expect(next.loaded).not.toHaveBeenCalled()
  fireEvent.loadedMetadata(player)
  expect(latest.loaded).toHaveBeenCalledExactlyOnceWith('current')
  fireEvent.error(player)
  expect(latest.failed).toHaveBeenCalledOnce()
})

it('builds same-origin authenticated URLs for browser and Desktop without credentials', () => {
  const file = { sessionId: 'owner' as SessionId, path: 'final/镜头 1.mp4' }
  for (const base of ['https://muse.example/chat', 'dsh-app://app/']) {
    const url = new URL(videoUrl(file, base))
    expect(url.origin).toBe(new URL(base).origin)
    expect(url.pathname).toBe('/api/video')
    expect(url.searchParams.get('path')).toBe(file.path)
    expect(url.searchParams.get('sessionId')).toBe('owner')
    expect(url.username).toBe('')
  }
})

it('keeps the selected computer and app mount in the video stream URL', () => {
  const file = { sessionId: 'owner' as SessionId, path: 'final/镜头 1.mp4' }
  const url = new URL(videoUrl(file, 'https://muse.example/muse/computer/desktop-1/', 'v2'))
  expect(url.pathname).toBe('/muse/computer/desktop-1/api/video')
  expect(url.searchParams.get('path')).toBe(file.path)
  expect(url.searchParams.get('sessionId')).toBe('owner')
  expect(url.searchParams.get('version')).toBe('v2')
  expect([...url.searchParams.keys()]).toEqual(['sessionId', 'path', 'version'])
})
