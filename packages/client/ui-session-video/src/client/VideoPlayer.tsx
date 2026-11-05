/** Native video playback and controls above the proportional shot timeline. */
import { useEffect, useRef, useState } from 'react'
import { Button, IconPlayTriangleOutlineRegular, IconPauseBarsOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionVideoAnalysis, SessionVideoSource } from '@deepseek-ai/dsh-session-video'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { VideoTimeline, type VideoTimelineShot } from './VideoTimeline.tsx'
import css from './VideoShelf.module.css'

/** Source and globally concatenated shot position for the single visible player. */
export interface VideoPlayerProps extends PropsLocale<'sessionVideo'> {
  readonly source: SessionVideoSource
  readonly analysis: SessionVideoAnalysis | undefined
  readonly shots: readonly VideoTimelineShot[]
  readonly offset: number
  readonly duration: number
  readonly pixelsPerSecond: number
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
  seekRequest, onSeek, onSelectShot, t }: VideoPlayerProps) {
  const player = useRef<HTMLVideoElement>(null)
  const [playing, setPlaying] = useState(false)
  const [time, setTime] = useState(0)
  const [failed, setFailed] = useState(false)
  const [retry, setRetry] = useState(0)
  const [thumbnails, setThumbnails] = useState<Readonly<Record<string, string>>>({})
  useEffect(() => {
    const video = player.current
    if (!video) return
    video.src = source.playbackUrl ?? ''
    video.load()
    return () => { video.pause(); video.removeAttribute('src'); video.load() }
  }, [source.playbackUrl, retry])
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
        setThumbnails({ ...result })
      }
    }
    void capture().catch((_error: unknown) => { /* Playback remains usable when a source disallows frame capture. */ })
    return () => { controller.abort(); video.pause(); video.removeAttribute('src'); video.load() }
  }, [analysis, source.playbackUrl])
  return <>
    <div className={css.picture}>
      <video ref={player} playsInline preload="metadata" aria-label={source.label} data-muse-shelf-video
        onLoadedMetadata={() => { setFailed(false); setPlaying(false); setTime(0) }}
        onTimeUpdate={(event) => { setTime(event.currentTarget.currentTime) }} onPlay={() => { setPlaying(true) }}
        onPause={() => { setPlaying(false) }} onError={() => { setFailed(true) }} />
      <div className={css.caption}>{source.label}</div>
      {failed && <div className={css.mediaError} role="alert">{t('unavailable')} <Button size="sm" onClick={() => { setRetry(value => value + 1) }}>{t('retry')}</Button></div>}
    </div>
    <div className={css.controls}>
      <Button className={css.play} aria-label={t(playing ? 'pause' : 'play')} onClick={() => {
        const video = player.current
        if (video === null) return
        if (!video.paused) video.pause()
        else void video.play().catch((_error: unknown) => { setFailed(true) })
      }}>{playing ? <IconPauseBarsOutlineRegular /> : <IconPlayTriangleOutlineRegular />}</Button>
    </div>
    {shots.length > 0 && <VideoTimeline shots={shots.map(shot => ({ ...shot, thumbnail: thumbnails[shot.id] ?? shot.thumbnail }))}
      currentTime={offset + time} selectedShotId={selectedShot} duration={duration} pixelsPerSecond={pixelsPerSecond}
      onSeek={onSeek} onSelectShot={onSelectShot} labels={{ timeline: t('timeline'), playhead: t('playhead'),
        shot: (index, start, end) => t('shot', { index, start: start.toFixed(2), end: end.toFixed(2) }) }} />}
  </>
}
