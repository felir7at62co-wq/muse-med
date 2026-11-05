/** Native video playback and controls above the proportional shot timeline. */
import { useEffect, useRef, useState } from 'react'
import { Button, IconPlayTriangleOutlineRegular, IconPauseBarsOutlineRegular, IconZoomInOutlineRegular, IconZoomOutOutlineRegular, Tooltip, DOCUMENT_ZOOM } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionVideoAnalysis, SessionVideoSource } from '@deepseek-ai/dsh-session-video'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { VideoTimeline, type VideoTimelineShot } from './VideoTimeline.tsx'
import css from './VideoShelf.module.css'

/** Source and globally concatenated shot position for the single visible player. */
export interface VideoPlayerProps extends PropsLocale<'sessionVideo'> {
  /** Pause playback while the retained curtain finishes closing. */
  readonly active?: boolean
  readonly source: SessionVideoSource
  readonly analysis: SessionVideoAnalysis | undefined
  readonly shots: readonly VideoTimelineShot[]
  readonly offset: number
  readonly duration: number
  readonly pixelsPerSecond: number
  /** Timeline-only scale multiplier; playback time remains unchanged. */
  readonly zoom: number
  readonly onZoom: (zoom: number) => void
  readonly selectedShot: string | null
  readonly seekRequest: { readonly time: number; readonly revision: number } | null
  readonly onSeek: (time: number) => void
  readonly onSelectShot: (id: string) => void
}

/** Render one real media element and keep its lifecycle local.
 * @param props - Selected authorized source, detected cuts and controlled timeline.
 * @returns Player, compact play control and filmstrip.
 */
export function VideoPlayer({ source, analysis, shots, offset, duration, pixelsPerSecond, selectedShot,
  seekRequest, onSeek, onSelectShot, t, zoom, onZoom, active = true }: VideoPlayerProps) {
  const player = useRef<HTMLVideoElement>(null)
  const playAttempt = useRef(0)
  const [playback, setPlayback] = useState({ sourceId: source.id, time: 0, playing: false, failed: false })
  const current = playback.sourceId === source.id ? playback : { sourceId: source.id, time: 0, playing: false, failed: false }
  const { time, playing, failed } = current
  const updatePlayback = (update: Partial<Pick<typeof playback, 'time' | 'playing' | 'failed'>>) => {
    setPlayback(previous => ({ ...(previous.sourceId === source.id ? previous : current), ...update }))
  }
  const [retry, setRetry] = useState(0)
  const [thumbnails, setThumbnails] = useState<{ url: string | null; frames: Readonly<Record<string, string>> }>({ url: null, frames: {} })
  useEffect(() => { if (!active) { playAttempt.current++; player.current?.pause() } }, [active])
  useEffect(() => {
    const video = player.current
    if (!video) return
    video.src = source.playbackUrl ?? ''
    video.load()
    return () => { playAttempt.current++; video.pause(); video.removeAttribute('src'); video.load() }
  }, [source.id, source.playbackUrl, retry])
  useEffect(() => {
    const video = player.current
    if (!video || seekRequest === null) return
    const seek = () => { video.currentTime = seekRequest.time }
    if (video.readyState >= 1) seek()
    else video.addEventListener('loadedmetadata', seek, { once: true })
    return () => { video.removeEventListener('loadedmetadata', seek) }
  }, [source.id, seekRequest])
  useEffect(() => {
    const playbackUrl = source.playbackUrl
    if (analysis?.state !== 'ready' || playbackUrl === null) return
    const video = document.createElement('video')
    const canvas = document.createElement('canvas')
    const controller = new AbortController()
    const signal = controller.signal
    video.muted = true; video.preload = 'auto'; video.crossOrigin = 'anonymous'
    canvas.width = 120; canvas.height = 68
    const wait = (event: string) => new Promise<void>((resolve, reject) => {
      const done = () => { clean(); resolve() }
      const fail = () => { clean(); reject(new Error('Thumbnail unavailable')) }
      const timer = setTimeout(fail, 5000)
      const clean = () => {
        clearTimeout(timer); video.removeEventListener(event, done); video.removeEventListener('error', fail); signal.removeEventListener('abort', fail)
      }
      video.addEventListener(event, done, { once: true }); video.addEventListener('error', fail, { once: true }); signal.addEventListener('abort', fail, { once: true })
    })
    const capture = async () => {
      const loaded = wait('loadedmetadata'); video.src = playbackUrl; await loaded
      const result: Record<string, string> = {}
      for (const shot of analysis.shots.slice(0, 48)) {
        if (signal.aborted) return
        const seeked = wait('seeked'); video.currentTime = (shot.startSeconds + shot.endSeconds) / 2; await seeked
        const context = canvas.getContext('2d')
        if (context === null) return
        context.drawImage(video, 0, 0, canvas.width, canvas.height)
        result[shot.id] = canvas.toDataURL('image/jpeg', 0.65)
        setThumbnails({ url: playbackUrl, frames: { ...result } })
      }
    }
    void capture().catch((_error: unknown) => { /* Playback remains usable when a source disallows frame capture. */ })
    return () => { controller.abort(); video.pause(); video.removeAttribute('src'); video.load() }
  }, [analysis, source.playbackUrl])
  const frames = thumbnails.url === source.playbackUrl ? thumbnails.frames : {}
  const timelineShots = shots.map(shot => ({ ...shot, thumbnail: frames[shot.id] ?? shot.thumbnail }))
  return <>
    <div className={css.picture}>
      <video key={source.id} ref={player} playsInline preload="metadata" aria-label={source.label} data-muse-shelf-video
        onLoadedMetadata={(event) => { updatePlayback({ failed: false, playing: false, time: event.currentTarget.currentTime }) }}
        onTimeUpdate={(event) => { updatePlayback({ time: event.currentTarget.currentTime }) }}
        onPlay={() => { updatePlayback({ playing: true }) }} onPause={() => { updatePlayback({ playing: false }) }}
        onError={() => { updatePlayback({ failed: true }) }} />
      {failed && <div className={css.mediaError} role="alert">{t('unavailable')} <Button size="sm" onClick={() => { setRetry(value => value + 1) }}>{t('retry')}</Button></div>}
    </div>
    <div className={css.controls} data-muse-video-controls>
      <Button className={css.play} aria-label={t(playing ? 'pause' : 'play')} onClick={() => {
        const video = player.current
        if (video === null) return
        const attempt = ++playAttempt.current
        if (!video.paused) video.pause()
        else void video.play().catch((_error: unknown) => { if (playAttempt.current === attempt) updatePlayback({ failed: true }) })
      }}>{playing ? <IconPauseBarsOutlineRegular /> : <IconPlayTriangleOutlineRegular />}</Button>
      <div className={css.zoom} data-muse-video-zoom role="group" aria-label={t('zoomControls')}>
        <Tooltip label={t('zoomOut')} portal>
          <span><Button size="sm" aria-label={t('zoomOut')} disabled={zoom <= DOCUMENT_ZOOM.minimum}
            onClick={() => { onZoom(Math.max(DOCUMENT_ZOOM.minimum, zoom - DOCUMENT_ZOOM.step)) }}>
            <IconZoomOutOutlineRegular /></Button></span>
        </Tooltip>
        <input type="range" aria-label={t('zoomControls')} aria-valuetext={t('zoomValue', { percent: Math.round(zoom * 100) })}
          min={DOCUMENT_ZOOM.minimum} max={DOCUMENT_ZOOM.maximum} step={DOCUMENT_ZOOM.step} value={zoom}
          onChange={(event) => { onZoom(event.currentTarget.valueAsNumber) }} />
        <Tooltip label={t('zoomIn')} portal>
          <span><Button size="sm" aria-label={t('zoomIn')} disabled={zoom >= DOCUMENT_ZOOM.maximum}
            onClick={() => { onZoom(Math.min(DOCUMENT_ZOOM.maximum, zoom + DOCUMENT_ZOOM.step)) }}>
            <IconZoomInOutlineRegular /></Button></span>
        </Tooltip>
      </div>
    </div>
    {shots.length > 0 && <VideoTimeline shots={timelineShots}
      currentTime={offset + time} selectedShotId={selectedShot} duration={duration} pixelsPerSecond={pixelsPerSecond * zoom}
      onSeek={onSeek} onSelectShot={onSelectShot} labels={{ timeline: t('timeline'), playhead: t('playhead'),
        shot: (index, start, end) => t('shot', { index, start: start.toFixed(2), end: end.toFixed(2) }) }} />}
  </>
}
