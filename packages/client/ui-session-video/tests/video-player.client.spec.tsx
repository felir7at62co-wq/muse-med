// @vitest-environment jsdom
/** Real media lifecycle, deferred seeking, and playback failures remain local. */
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionVideoSourceId } from '@deepseek-ai/dsh-session-video'
import { VideoPlayer, type VideoPlayerProps } from '../src/client/VideoPlayer.tsx'
import { en } from '../src/client/locales.ts'

const playVideo = vi.fn<() => Promise<void>>()
const pauseVideo = vi.fn<() => void>()
beforeEach(() => {
  playVideo.mockReset().mockResolvedValue()
  pauseVideo.mockReset()
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {})
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(pauseVideo)
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(playVideo)
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })
function props(): VideoPlayerProps {
  return { source: { id: brandString<SessionVideoSourceId>('first'), label: 'Actual source', origin: 'generated', path: '/work/a.mp4', eventSeq: 4,
    presentedIndex: null, callId: null, status: 'local', version: 'v1', playbackUrl: '/api/session-video?id=first', remoteUrl: null, issue: null },
  analysis: undefined, shots: [], offset: 0, duration: 0, pixelsPerSecond: 48, selectedShot: null, seekRequest: null,
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
