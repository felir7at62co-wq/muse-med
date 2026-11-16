// @vitest-environment jsdom
/** Real media lifecycle, deferred seeking, and playback failures remain local. */
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { Suspense } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionVideoAnalysis, SessionVideoShotId, SessionVideoSourceId } from '@deepseek-ai/dsh-session-video'
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
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers() })
function props(): VideoPlayerProps & { source: VideoPlayerProps['source'] & { version: string } } {
  return { source: { id: brandString<SessionVideoSourceId>('first'), label: 'Actual source', origin: 'generated', path: '/work/a.mp4', eventSeq: 4,
    presentedIndex: null, callId: null, status: 'local', version: 'v1', playbackUrl: '/api/session-video?id=first', remoteUrl: null, issue: null },
  analysis: undefined, shots: [], offset: 0, duration: 0, pixelsPerSecond: 48, zoom: 1, onZoom: vi.fn(),
  selectedShot: null, seekRequest: null,
  onSeek: vi.fn(), onSelectShot: vi.fn(), t: makeTranslate(en) }
}

function thumbnailProps(count = 2): VideoPlayerProps & { analysis: SessionVideoAnalysis } {
  const input = props()
  const shots = Array.from({ length: count }, (_, index) => ({
    id: brandString<SessionVideoShotId>(`shot-${index + 1}`), index: index + 1,
    startSeconds: index * 2, endSeconds: (index + 1) * 2, thumbnail: null,
  }))
  return { ...input, shots, duration: count * 2, analysis: {
    sourceId: input.source.id, sourceVersion: input.source.version, state: 'ready', durationSeconds: count * 2,
    width: 1920, height: 1080, shots, method: 'ffmpeg-scene', threshold: 0.3, issue: null,
  } }
}

function thumbnailHarness(input: VideoPlayerProps = thumbnailProps()) {
  const created = vi.spyOn(document, 'createElement')
  const drawImage = vi.fn<(image: CanvasImageSource, dx: number, dy: number, ...coordinates: number[]) => void>()
  const context: Pick<CanvasRenderingContext2D, 'drawImage'> = { drawImage }
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as CanvasRenderingContext2D)
  const encode = vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL')
    .mockReturnValueOnce('data:image/jpeg;base64,first').mockReturnValue('data:image/jpeg;base64,next')
  const view = render(<VideoPlayer {...input} />)
  const elements: HTMLElement[] = []
  for (const result of created.mock.results) {
    if (result.value instanceof HTMLElement) elements.push(result.value)
  }
  const capture = elements
    .find((element): element is HTMLVideoElement => element instanceof HTMLVideoElement && !element.isConnected)
  const canvas = elements
    .find((element): element is HTMLCanvasElement => element instanceof HTMLCanvasElement)
  if (!capture || !canvas) throw new Error('Missing thumbnail media elements')
  return { view, capture, canvas, drawImage, encode }
}

async function mediaEvent(video: HTMLVideoElement, type: string) {
  await act(async () => { video.dispatchEvent(new Event(type)) })
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
  fireEvent.pause(video)
  expect(view.getByRole('button', { name: 'Play' })).toBeTruthy()
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

it('seeks immediately after metadata is available and stops an abandoned metadata seek', () => {
  const input = props()
  vi.spyOn(HTMLMediaElement.prototype, 'readyState', 'get').mockReturnValue(1)
  const view = render(<VideoPlayer {...input} seekRequest={{ time: 1.75, revision: 1 }} />)
  const video = view.getByLabelText('Actual source') as HTMLVideoElement
  expect(video.currentTime).toBe(1.75)
  vi.spyOn(HTMLMediaElement.prototype, 'readyState', 'get').mockReturnValue(0)
  view.rerender(<VideoPlayer {...input} seekRequest={{ time: 3, revision: 2 }} />)
  view.rerender(<VideoPlayer {...input} seekRequest={null} />)
  fireEvent.loadedMetadata(video)
  expect(video.currentTime).toBe(1.75)
})

it('does not create thumbnail media without an authorized playback URL', () => {
  const input = thumbnailProps()
  const created = vi.spyOn(document, 'createElement')
  const view = render(<VideoPlayer {...input} source={{ ...input.source, playbackUrl: null }} />)
  const video = view.getByLabelText('Actual source') as HTMLVideoElement
  expect(video.getAttribute('src')).toBe('')
  expect(created.mock.results.filter(result => result.value instanceof HTMLVideoElement)).toHaveLength(1)
  expect(view.getByRole('button', { name: /^Shot 1/u }).style.getPropertyValue('--video-shot-thumbnail')).toBe('none')
})

it('publishes each decoded thumbnail at the shot midpoint without moving the visible player', async () => {
  vi.useFakeTimers()
  const input = thumbnailProps()
  const { view, capture, canvas, drawImage, encode } = thumbnailHarness(input)
  const video = view.getByLabelText('Actual source') as HTMLVideoElement
  video.currentTime = 0.5
  expect(capture.muted).toBe(true)
  expect(capture.preload).toBe('auto')
  expect(capture.crossOrigin).toBe('anonymous')
  expect(capture.getAttribute('src')).toBe(input.source.playbackUrl)
  expect([canvas.width, canvas.height]).toEqual([120, 68])
  expect(vi.getTimerCount()).toBe(1)
  await mediaEvent(capture, 'loadedmetadata')
  expect(capture.currentTime).toBe(1)
  expect(drawImage).not.toHaveBeenCalled()
  await mediaEvent(capture, 'seeked')
  expect(drawImage).toHaveBeenLastCalledWith(capture, 0, 0, 120, 68)
  expect(encode).toHaveBeenCalledWith('image/jpeg', 0.65)
  expect(view.getByRole('button', { name: /^Shot 1/u }).style.getPropertyValue('--video-shot-thumbnail'))
    .toContain('data:image/jpeg;base64,first')
  expect(view.getByRole('button', { name: /^Shot 2/u }).style.getPropertyValue('--video-shot-thumbnail')).toBe('none')
  expect(capture.currentTime).toBe(3)
  await mediaEvent(capture, 'seeked')
  expect(drawImage).toHaveBeenCalledTimes(2)
  expect(view.getByRole('button', { name: /^Shot 2/u }).style.getPropertyValue('--video-shot-thumbnail'))
    .toContain('data:image/jpeg;base64,next')
  expect(vi.getTimerCount()).toBe(0)
  expect(video.currentTime).toBe(0.5)
  fireEvent.click(view.getByRole('button', { name: /^Shot 2/u }))
  expect(input.onSelectShot).toHaveBeenCalledWith('shot-2')
  expect(input.onSeek).toHaveBeenCalledWith(2)
  view.unmount()
  expect(capture.hasAttribute('src')).toBe(false)
  expect(pauseVideo.mock.instances).toContain(capture)
  expect(loadVideo.mock.instances).toContain(capture)
})

it('limits capture to the first 48 shots while retaining the remaining timeline shots', async () => {
  vi.useFakeTimers()
  const { view, capture, drawImage } = thumbnailHarness(thumbnailProps(49))
  await mediaEvent(capture, 'loadedmetadata')
  for (let index = 0; index < 48; index++) {
    expect(capture.currentTime).toBe(index * 2 + 1)
    await mediaEvent(capture, 'seeked')
  }
  expect(drawImage).toHaveBeenCalledTimes(48)
  expect(view.getByRole('button', { name: /^Shot 48 /u }).style.getPropertyValue('--video-shot-thumbnail')).toContain('data:image/jpeg')
  expect(view.getByRole('button', { name: /^Shot 49 /u }).style.getPropertyValue('--video-shot-thumbnail')).toBe('none')
  expect(vi.getTimerCount()).toBe(0)
})

it.each(['error', 'timeout'] as const)('keeps playback usable when thumbnail metadata ends in %s', async (failure) => {
  vi.useFakeTimers()
  const { view, capture, drawImage } = thumbnailHarness()
  if (failure === 'error') await mediaEvent(capture, 'error')
  else await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
  await mediaEvent(capture, 'loadedmetadata')
  expect(drawImage).not.toHaveBeenCalled()
  expect(view.queryByRole('alert')).toBeNull()
  expect(vi.getTimerCount()).toBe(0)
  fireEvent.click(view.getByRole('button', { name: 'Play' }))
  expect(playVideo).toHaveBeenCalledOnce()
})

it('retains earlier thumbnails when decoding a later shot fails', async () => {
  vi.useFakeTimers()
  const { view, capture, drawImage } = thumbnailHarness()
  await mediaEvent(capture, 'loadedmetadata')
  await mediaEvent(capture, 'seeked')
  await mediaEvent(capture, 'error')
  await mediaEvent(capture, 'seeked')
  expect(drawImage).toHaveBeenCalledOnce()
  expect(view.getByRole('button', { name: /^Shot 1/u }).style.getPropertyValue('--video-shot-thumbnail')).toContain('data:image/jpeg;base64,first')
  expect(view.getByRole('button', { name: /^Shot 2/u }).style.getPropertyValue('--video-shot-thumbnail')).toBe('none')
  expect(view.queryByRole('alert')).toBeNull()
  expect(vi.getTimerCount()).toBe(0)
})

it.each(['context', 'encoding'] as const)('keeps the timeline usable when canvas %s is unavailable', async (failure) => {
  vi.useFakeTimers()
  const { view, capture, drawImage, encode } = thumbnailHarness()
  if (failure === 'context') vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
  else encode.mockReset().mockImplementation(() => { throw new DOMException('Canvas is tainted', 'SecurityError') })
  await mediaEvent(capture, 'loadedmetadata')
  await mediaEvent(capture, 'seeked')
  expect(drawImage).toHaveBeenCalledTimes(failure === 'context' ? 0 : 1)
  expect(view.getByRole('button', { name: /^Shot 1/u }).style.getPropertyValue('--video-shot-thumbnail')).toBe('none')
  expect(view.queryByRole('alert')).toBeNull()
  expect(vi.getTimerCount()).toBe(0)
})

it.each(['loadedmetadata', 'seeked'] as const)('cancels the pending thumbnail %s listener on unmount', async (pending) => {
  vi.useFakeTimers()
  const { view, capture, drawImage } = thumbnailHarness()
  if (pending === 'seeked') await mediaEvent(capture, 'loadedmetadata')
  expect(vi.getTimerCount()).toBe(1)
  view.unmount()
  await mediaEvent(capture, pending)
  expect(drawImage).not.toHaveBeenCalled()
  expect(capture.hasAttribute('src')).toBe(false)
  expect(vi.getTimerCount()).toBe(0)
})

it('stops before seeking when unmount follows metadata before its continuation runs', async () => {
  vi.useFakeTimers()
  const { view, capture, drawImage } = thumbnailHarness()
  act(() => { capture.dispatchEvent(new Event('loadedmetadata')); view.unmount() })
  await act(async () => { await Promise.resolve() })
  expect(capture.currentTime).toBe(0)
  expect(drawImage).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
})

it('discards old source thumbnails and releases the capture resource when the source changes', async () => {
  vi.useFakeTimers()
  const input = thumbnailProps(1)
  const { view, capture } = thumbnailHarness(input)
  await mediaEvent(capture, 'loadedmetadata')
  await mediaEvent(capture, 'seeked')
  expect(view.getByRole('button', { name: /^Shot 1/u }).style.getPropertyValue('--video-shot-thumbnail')).toContain('data:image/jpeg')
  view.rerender(<VideoPlayer {...input} source={{ ...input.source, playbackUrl: '/api/next' }}
    analysis={{ ...input.analysis, state: 'failed', issue: 'Analysis unavailable' }} />)
  expect(capture.hasAttribute('src')).toBe(false)
  expect(view.getByRole('button', { name: /^Shot 1/u }).style.getPropertyValue('--video-shot-thumbnail')).toBe('none')
  expect(view.getByLabelText('Actual source').getAttribute('src')).toBe('/api/next')
})

it('does not restart a player hidden by a suspended parent', () => {
  const pending = new Promise<void>(() => {})
  function Wait({ blocked }: { blocked: boolean }) {
    if (blocked) throw pending
    return null
  }
  const input = props()
  const view = render(<Suspense fallback={<span>Loading</span>}><VideoPlayer {...input} /><Wait blocked={false} /></Suspense>)
  const play = view.getByRole('button', { name: 'Play' })
  fireEvent.error(view.getByLabelText('Actual source'))
  const retry = view.getByRole('button', { name: 'Retry' })
  view.rerender(<Suspense fallback={<span>Loading</span>}><VideoPlayer {...input} /><Wait blocked /></Suspense>)
  expect(view.getByText('Loading')).toBeTruthy()
  loadVideo.mockClear()
  fireEvent.click(retry)
  expect(loadVideo).not.toHaveBeenCalled()
  fireEvent.click(play)
  expect(playVideo).not.toHaveBeenCalled()
})
