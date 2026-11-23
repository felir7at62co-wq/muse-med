/** Bounded capture of real source-local video frames for filmstrips and shot cards. */
import { useEffect, useState } from 'react'

interface FrameInterval {
  readonly id: string
  readonly startSeconds: number
  readonly endSeconds: number
}

/** Capture one midpoint per located interval without touching the visible player's clock.
 * @param active - Whether the owning preview is visible.
 * @param url - Authorized playback address for the current source version.
 * @param intervals - Source-local intervals in display order.
 * @param cover - Crop the source to fill the thumbnail without stretching.
 * @returns Available frame URLs indexed by the interval's exact identity.
 */
export function useVideoFrames(active: boolean, url: string | null, intervals: readonly FrameInterval[] | undefined,
  cover = false): Readonly<Record<string, string>> {
  const [captured, setCaptured] = useState<{
    url: string
    intervals: readonly FrameInterval[]
    frames: Readonly<Record<string, string>>
  } | null>(null)
  useEffect(() => {
    if (!active || url === null || intervals === undefined || intervals.length === 0) return
    const video = document.createElement('video')
    const canvas = document.createElement('canvas')
    const controller = new AbortController()
    const signal = controller.signal
    video.muted = true; video.preload = 'auto'; video.crossOrigin = 'anonymous'
    canvas.width = cover ? 240 : 120; canvas.height = cover ? 135 : 68
    const wait = (event: string) => new Promise<void>((resolve, reject) => {
      const done = () => { clean(); resolve() }
      const fail = () => { clean(); reject(new Error('Thumbnail unavailable')) }
      const timer = setTimeout(fail, 5000)
      const clean = () => {
        clearTimeout(timer); video.removeEventListener(event, done); video.removeEventListener('error', fail)
        signal.removeEventListener('abort', fail)
      }
      video.addEventListener(event, done, { once: true }); video.addEventListener('error', fail, { once: true })
      signal.addEventListener('abort', fail, { once: true })
    })
    const capture = async () => {
      const loaded = wait('loadedmetadata'); video.src = url; await loaded
      const frames: Record<string, string> = {}
      for (const interval of intervals.slice(0, 48)) {
        if (signal.aborted) return
        const seeked = wait('seeked'); video.currentTime = (interval.startSeconds + interval.endSeconds) / 2; await seeked
        signal.throwIfAborted()
        const context = canvas.getContext('2d')
        if (context === null) return
        if (cover && video.videoWidth > 0 && video.videoHeight > 0) {
          const ratio = canvas.width / canvas.height
          const width = Math.min(video.videoWidth, video.videoHeight * ratio)
          const height = width / ratio
          context.drawImage(video, (video.videoWidth - width) / 2, (video.videoHeight - height) / 2, width, height,
            0, 0, canvas.width, canvas.height)
        } else context.drawImage(video, 0, 0, canvas.width, canvas.height)
        frames[interval.id] = canvas.toDataURL('image/jpeg', 0.65)
        setCaptured({ url, intervals, frames: { ...frames } })
      }
    }
    void capture().catch((_error: unknown) => { /* Playback remains available if the source disallows frame capture. */ })
    return () => { controller.abort(); video.pause(); video.removeAttribute('src'); video.load() }
  }, [active, url, intervals, cover])
  return captured !== null && captured.url === url && captured.intervals === intervals ? captured.frames : {}
}
