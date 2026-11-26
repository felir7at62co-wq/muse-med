/** Native video playback and controls above the proportional shot timeline. */
import { useEffect, useRef, useState, type CSSProperties } from 'react'
import {
  Button, DOCUMENT_ZOOM, IconFullscreenOutlineRegular, IconPanelLeftOutlineRegular, IconPauseBarsOutlineRegular,
  IconPlayTriangleOutlineRegular, IconZoomInOutlineRegular, IconZoomOutOutlineRegular, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionVideoAnalysis } from '@deepseek-ai/dsh-session-video'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { VideoTimeline, type VideoTimelineShot } from './VideoTimeline.tsx'
import { videoClock } from './timeline.ts'
import { useVideoFrames } from './video-frames.ts'
import css from './VideoShelf.module.css'

/** Source and globally concatenated shot position for the single visible player. */
export interface VideoPlayerProps extends PropsLocale<'sessionVideo'> {
  /** Pause playback while the retained curtain finishes closing. */
  readonly active?: boolean
  /** Retain browser volume, seeking and fullscreen controls for inline deliveries. */
  readonly nativeControls?: boolean
  /** Report a user-started playback or seek so its owner can retain that media. */
  readonly onUserInteract?: () => void
  /** Report the source-local playhead for aligned version comparison. */
  readonly onTimeChange?: (time: number) => void
  /** Report media failures and successful metadata loading to the owning card. */
  readonly onPlaybackFailureChange?: (failed: boolean) => void
  /** Use a compact playback bar and retain the detected filmstrip on demand. */
  readonly studio?: { readonly floating: boolean; readonly toggleFloating: () => void }
  readonly source: { readonly id: string; readonly label: string; readonly playbackUrl: string | null }
  readonly analysis: SessionVideoAnalysis | undefined
  readonly shots: readonly VideoTimelineShot[]
  readonly offset: number
  readonly duration: number
  readonly pixelsPerSecond: number
  /** Timeline-only scale multiplier; playback time remains unchanged. */
  readonly zoom: number
  readonly onZoom: (zoom: number) => void
  readonly selectedShot: string | null
  /** Equal request identities preserve playback across parent renders. */
  readonly seekRequest: { readonly time: number; readonly revision: number | string } | null
  readonly onSeek: (time: number) => void
  readonly onSelectShot: (id: string) => void
  /** Refresh the owning inventory before retrying a possibly replaced source. */
  readonly onRetrySource?: () => void
}

/** Render one real media element; effects and controls use its mounted ref.
 * @param props - Selected authorized source, detected cuts and controlled timeline.
 * @returns Player, compact play control and filmstrip.
 */
export function VideoPlayer({ source, analysis, shots, offset, duration, pixelsPerSecond, selectedShot,
  seekRequest, onSeek, onSelectShot, onRetrySource, t, zoom, onZoom, active = true, nativeControls = false, onUserInteract,
  onPlaybackFailureChange, onTimeChange, studio }: VideoPlayerProps) {
  const player = useRef<HTMLVideoElement>(null)
  const playAttempt = useRef(0)
  const initialPlayback = { sourceId: source.id, time: 0, mediaDuration: 0, playing: false, failed: false }
  const [playback, setPlayback] = useState(initialPlayback)
  const current = playback.sourceId === source.id ? playback : initialPlayback
  const { time, playing, failed } = current
  const updatePlayback = (update: Partial<Omit<typeof playback, 'sourceId'>>) => {
    setPlayback(previous => ({ ...(previous.sourceId === source.id ? previous : current), ...update }))
  }
  const [retry, setRetry] = useState(0)
  const seekTime = seekRequest?.time
  const seekRevision = seekRequest?.revision
  const [detailedTimelineOpen, setDetailedTimelineOpen] = useState(false)
  useEffect(() => { if (!active) { playAttempt.current++; player.current?.pause() } }, [active])
  useEffect(() => {
    // This unconditional video is mounted before React commits its effect.
    const video = player.current as HTMLVideoElement
    video.src = source.playbackUrl ?? ''
    video.load()
    return () => { playAttempt.current++; video.pause(); video.removeAttribute('src'); video.load() }
  }, [source.id, source.playbackUrl, retry])
  useEffect(() => {
    const video = player.current
    if (!video || seekTime === undefined) return
    const seek = () => { video.currentTime = seekTime }
    if (video.readyState >= 1) seek()
    else video.addEventListener('loadedmetadata', seek, { once: true })
    return () => { video.removeEventListener('loadedmetadata', seek) }
  }, [source.id, source.playbackUrl, seekTime, seekRevision])
  const frames = useVideoFrames(active && (studio === undefined || detailedTimelineOpen), source.playbackUrl,
    analysis?.state === 'ready' ? analysis.shots : undefined)
  const timelineShots = shots.map(shot => ({ ...shot, thumbnail: frames[shot.id] ?? shot.thumbnail }))
  const playButton = <Button className={css.play} aria-label={t(playing ? 'pause' : 'play')} onClick={() => {
    onUserInteract?.()
    const video = player.current
    if (video === null) return
    const attempt = ++playAttempt.current
    if (!video.paused) video.pause()
    else void video.play().catch((_error: unknown) => {
      if (playAttempt.current === attempt) { onPlaybackFailureChange?.(true); updatePlayback({ failed: true }) }
    })
  }}>{playing ? <IconPauseBarsOutlineRegular /> : <IconPlayTriangleOutlineRegular />}</Button>
  const zoomControls = <div className={css.zoom} data-muse-video-zoom role="group" aria-label={t('zoomControls')}>
    <Tooltip label={t('zoomOut')} portal>
      <span><Button size="sm" aria-label={t('zoomOut')} disabled={zoom <= DOCUMENT_ZOOM.minimum}
        onClick={() => { onZoom(Math.max(DOCUMENT_ZOOM.minimum, zoom - DOCUMENT_ZOOM.step)) }}><IconZoomOutOutlineRegular /></Button></span>
    </Tooltip>
    <input type="range" aria-label={t('zoomControls')} aria-valuetext={t('zoomValue', { percent: Math.round(zoom * 100) })}
      min={DOCUMENT_ZOOM.minimum} max={DOCUMENT_ZOOM.maximum} step={DOCUMENT_ZOOM.step} value={zoom}
      onChange={(event) => { onZoom(event.currentTarget.valueAsNumber) }} />
    <Tooltip label={t('zoomIn')} portal>
      <span><Button size="sm" aria-label={t('zoomIn')} disabled={zoom >= DOCUMENT_ZOOM.maximum}
        onClick={() => { onZoom(Math.min(DOCUMENT_ZOOM.maximum, zoom + DOCUMENT_ZOOM.step)) }}><IconZoomInOutlineRegular /></Button></span>
    </Tooltip>
  </div>
  const timeline = <VideoTimeline shots={timelineShots}
    currentTime={offset + time} selectedShotId={selectedShot} duration={duration} pixelsPerSecond={pixelsPerSecond * zoom}
    onSeek={onSeek} onSelectShot={onSelectShot} labels={{ timeline: t('timeline'), playhead: t('playhead'),
      shot: (index, start, end) => t('shot', { index, start: start.toFixed(2), end: end.toFixed(2) }) }} />
  const mediaDuration = current.mediaDuration || duration
  const playbackProgress = Math.min(time, mediaDuration)
  const progressStyle: CSSProperties & { '--video-playback-progress': string } = {
    '--video-playback-progress': `${mediaDuration > 0 ? playbackProgress / mediaDuration * 100 : 0}%`,
  }
  return <>
    <div className={studio === undefined ? css.picture : `${css.picture} ${css.studioPicture}`}>
      <video key={source.id} ref={player} controls={nativeControls} playsInline preload="metadata" aria-label={source.label} data-muse-shelf-video
        onPointerDown={() => { onUserInteract?.() }} onKeyDown={() => { onUserInteract?.() }}
        onLoadedMetadata={(event) => {
          const video = event.currentTarget
          onPlaybackFailureChange?.(false)
          updatePlayback({ failed: false, playing: false, time: video.currentTime,
            mediaDuration: Number.isFinite(video.duration) ? video.duration : 0 })
        }}
        onTimeUpdate={(event) => {
          updatePlayback({ time: event.currentTarget.currentTime }); onTimeChange?.(event.currentTarget.currentTime)
        }}
        onPlay={() => { onUserInteract?.(); updatePlayback({ playing: true }) }}
        onSeeking={() => { onUserInteract?.() }} onPause={() => { updatePlayback({ playing: false }) }}
        onError={() => { onPlaybackFailureChange?.(true); updatePlayback({ failed: true }) }} />
      {failed && <div className={css.mediaError} role="alert">{t('unavailable')} <Button size="sm" onClick={() => {
        onRetrySource?.(); setRetry(value => value + 1)
      }}>{t('retry')}</Button></div>}
    </div>
    {studio === undefined ? <>
      <div className={css.controls} data-muse-video-controls>{playButton}{zoomControls}</div>
      {shots.length > 0 && timeline}
    </> : <>
      <div className={css.studioControls} data-muse-video-controls>
        {playButton}
        <span className={css.clock} aria-hidden="true">{videoClock(playbackProgress)} / {videoClock(mediaDuration)}</span>
        <input className={css.scrubber} style={progressStyle} type="range" aria-label={t('playhead')}
          aria-valuetext={videoClock(playbackProgress)} min={0} max={mediaDuration} step="any" disabled={mediaDuration <= 0}
          value={playbackProgress} onChange={(event) => { onSeek(event.currentTarget.valueAsNumber) }} />
        <Tooltip label={t(studio.floating ? 'dock' : 'float')} portal><span>
          <Button className={css.toggleFloating} size="sm" variant="ghost" aria-label={t(studio.floating ? 'dock' : 'float')}
            onClick={studio.toggleFloating}>{studio.floating ? <IconPanelLeftOutlineRegular /> : <IconFullscreenOutlineRegular />}</Button>
        </span></Tooltip>
      </div>
      {shots.length > 0 && <details className={css.detailedTimeline}
        onToggle={(event) => { setDetailedTimelineOpen(event.currentTarget.open) }}>
        <summary>{t('timeline')}</summary>
        {detailedTimelineOpen && <>
          <div className={css.detailControls}>{zoomControls}</div>
          {timeline}
        </>}
      </details>}
    </>}
  </>
}
