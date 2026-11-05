// @vitest-environment jsdom
/** Real media lifecycle, deferred seeking, and playback failures remain local. */
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionVideoSourceId } from '@deepseek-ai/dsh-session-video'
import { VideoPlayer, type VideoPlayerProps } from '../src/client/VideoPlayer.tsx'
import { en } from '../src/client/locales.ts'

const playVideo = vi.fn<() => Promise<void>>()
const pauseVideo = vi.fn<() => void>()
const loadVideo = vi.fn<() => void>()
beforeEach(() => {
  playVideo.mockReset().mockResolvedValue()
  pauseVideo.mockReset()
  loadVideo.mockReset()
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(loadVideo)
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(pauseVideo)
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(playVideo)
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })
function props(): VideoPlayerProps {
  return { source: { id: brandString<SessionVideoSourceId>('first'), label: 'Actual source', origin: 'generated', path: '/work/a.mp4', eventSeq: 4,
    presentedIndex: null, callId: null, status: 'local', version: 'v1', playbackUrl: '/api/session-video?id=first', remoteUrl: null, issue: null },
  analysis: undefined, shots: [], offset: 0, duration: 0, pixelsPerSecond: 48, zoom: 1, onZoom: vi.fn(),
  selectedShot: null, seekRequest: null,
  onSeek: vi.fn(), onSelectShot: vi.fn(), t: makeTranslate(en) }
}
it('places compact playback controls after the real media, and releases its resource on unmount', () => {
  const view = render(<VideoPlayer {...props()} />)
  const video = view.getByLabelText('Actual source') as HTMLVideoElement
  const play = view.getByRole('button', { name: 'Play' })
  expect(video.compareDocumentPosition(play) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  fireEvent.click(play)
  expect(playVideo).toHaveBeenCalledOnce()
  Object.defineProperty(video, 'paused', { configurable: true, value: false })
  fireEvent.play(video)
  fireEvent.click(view.getByRole('button', { name: 'Pause' }))
  expect(pauseVideo).toHaveBeenCalled()
  view.unmount()
  expect(video.hasAttribute('src')).toBe(false)
})
it('waits for metadata before seeking the original source-local shot time', () => {
  const view = render(<VideoPlayer {...props()} seekRequest={{ time: 2.125, revision: 1 }} />)
  const video = view.getByLabelText('Actual source') as HTMLVideoElement
  expect(video.currentTime).toBe(0)
  fireEvent.loadedMetadata(video)
  expect(video.currentTime).toBe(2.125)
})
it('removes the old deferred seek when a different shot is selected', () => {
  const input = props()
  const view = render(<VideoPlayer {...input} seekRequest={{ time: 1, revision: 1 }} />)
  const video = view.getByLabelText('Actual source') as HTMLVideoElement
  view.rerender(<VideoPlayer {...input} seekRequest={{ time: 2.5, revision: 2 }} />)
  fireEvent.loadedMetadata(video)
  expect(video.currentTime).toBe(2.5)
})
it('keeps media errors in place and retries the same authorized URL', () => {
  const view = render(<VideoPlayer {...props()} />)
  const video = view.getByLabelText('Actual source') as HTMLVideoElement
  fireEvent.error(video)
  expect(view.getByRole('alert').textContent).toContain(en.unavailable)
  fireEvent.click(view.getByRole('button', { name: 'Retry' }))
  expect(video.getAttribute('src')).toBe('/api/session-video?id=first')
  fireEvent.loadedMetadata(video)
  expect(view.queryByRole('alert')).toBeNull()
})

it('pauses inactive closing media without clearing its source, position or DOM, and does not autoplay on reopening', () => {
  const input = props()
  const view = render(<VideoPlayer {...input} />)
  const video = view.getByLabelText('Actual source') as HTMLVideoElement
  video.currentTime = 2.25
  pauseVideo.mockClear(); loadVideo.mockClear(); playVideo.mockClear()
  view.rerender(<VideoPlayer {...input} active={false} />)
  expect(pauseVideo).toHaveBeenCalledOnce()
  expect(loadVideo).not.toHaveBeenCalled()
  expect(video.getAttribute('src')).toBe('/api/session-video?id=first')
  expect(video.currentTime).toBe(2.25)
  expect(view.getByLabelText('Actual source')).toBe(video)
  view.rerender(<VideoPlayer {...input} active />)
  expect(playVideo).not.toHaveBeenCalled()
  expect(loadVideo).not.toHaveBeenCalled()
  expect(video.currentTime).toBe(2.25)
  view.unmount()
  expect(video.hasAttribute('src')).toBe(false)
})

it('changes only timeline scale while retaining the same media, playback time and selected shot', () => {
  const input = { ...props(), duration: 3, shots: [{ id: 'shot', index: 1, startSeconds: 0, endSeconds: 3, thumbnail: null }] }
  const view = render(<VideoPlayer {...input} />)
  const video = view.getByLabelText('Actual source') as HTMLVideoElement
  video.currentTime = 1.25
  loadVideo.mockClear()
  const range = view.getByRole('slider', { name: 'Timeline zoom' })
  fireEvent.change(range, { target: { value: '2' } })
  expect(input.onZoom).toHaveBeenLastCalledWith(2)
  view.rerender(<VideoPlayer {...input} zoom={2} />)
  expect(view.getByRole('button', { name: /^Shot 1/u }).style.getPropertyValue('--video-shot-width')).toBe('288px')
  expect(view.getByLabelText('Actual source')).toBe(video)
  expect(video.currentTime).toBe(1.25)
  expect(input.onSeek).not.toHaveBeenCalled()
  expect(loadVideo).not.toHaveBeenCalled()
  fireEvent.click(view.getByRole('button', { name: 'Zoom out timeline' }))
  expect(input.onZoom).toHaveBeenLastCalledWith(1.75)
  view.rerender(<VideoPlayer {...input} zoom={0.25} />)
  expect((view.getByRole('button', { name: 'Zoom out timeline' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(view.getByRole('button', { name: 'Zoom in timeline' }))
  expect(input.onZoom).toHaveBeenLastCalledWith(0.5)
  view.rerender(<VideoPlayer {...input} zoom={4} />)
  expect((view.getByRole('button', { name: 'Zoom in timeline' }) as HTMLButtonElement).disabled).toBe(true)
})

it('ignores a rejected play attempt after closing and reopening instead of reporting a stale media error', async () => {
  let rejectPlay: ((reason: Error) => void) | undefined
  playVideo.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectPlay = reject }))
  const input = props()
  const view = render(<VideoPlayer {...input} />)
  fireEvent.click(view.getByRole('button', { name: 'Play' }))
  view.rerender(<VideoPlayer {...input} active={false} />)
  view.rerender(<VideoPlayer {...input} active />)
  await act(async () => { rejectPlay?.(new Error('Playback paused during close')) })
  expect(view.queryByRole('alert')).toBeNull()
  playVideo.mockRejectedValueOnce(new Error('Decoder unavailable'))
  fireEvent.click(view.getByRole('button', { name: 'Play' }))
  await act(async () => { await Promise.resolve() })
  expect(view.getByRole('alert').textContent).toContain(en.unavailable)
})

it('replaces source media while retaining the active timeline and discarding the previous source clock and error', () => {
  const input = { ...props(), duration: 6, shots: [{ id: 'shot', index: 1, startSeconds: 0, endSeconds: 6, thumbnail: null }] }
  const view = render(<VideoPlayer {...input} />)
  const original = view.getByLabelText('Actual source') as HTMLVideoElement
  const playhead = view.getByRole('slider', { name: 'Playback position' })
  original.currentTime = 1.5
  fireEvent.timeUpdate(original)
  fireEvent.error(original)
  expect(playhead.getAttribute('aria-valuenow')).toBe('1.5')
  expect(view.getByRole('alert')).toBeTruthy()
  const next = { ...input, offset: 3, source: { ...input.source, id: brandString<SessionVideoSourceId>('second'),
    label: 'Second source', playbackUrl: '/api/session-video?id=second' } }
  view.rerender(<VideoPlayer {...next} />)
  const second = view.getByLabelText('Second source') as HTMLVideoElement
  expect(original.isConnected).toBe(false)
  expect(original.hasAttribute('src')).toBe(false)
  expect(second.getAttribute('src')).toBe(next.source.playbackUrl)
  expect(view.getByRole('slider', { name: 'Playback position' })).toBe(playhead)
  expect(playhead.getAttribute('aria-valuenow')).toBe('3')
  expect(view.queryByRole('alert')).toBeNull()
  second.currentTime = 1.25
  fireEvent.timeUpdate(second)
  expect(playhead.getAttribute('aria-valuenow')).toBe('4.25')
})
