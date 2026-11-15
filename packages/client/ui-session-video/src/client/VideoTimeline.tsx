/** Proportional shot filmstrips and a keyboard-accessible media playhead. */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent, PointerEvent, ReactElement, RefObject } from 'react'
import styles from './VideoTimeline.module.css'

/** One ordered shot, with media time in seconds and an optional real thumbnail URL. */
export interface VideoTimelineShot {
  readonly id: string
  readonly index: number
  readonly startSeconds: number
  readonly endSeconds: number
  readonly thumbnail: string | null
}

/** Localized names supplied by the owning video surface. */
export interface VideoTimelineLabels {
  readonly timeline: string
  readonly playhead: string
  readonly shot: (index: number, start: number, end: number) => string
}

/** Controlled media position and shot selection; pixelsPerSecond must be positive. */
export interface VideoTimelineProps {
  readonly shots: readonly VideoTimelineShot[]
  readonly currentTime: number
  readonly selectedShotId: string | null
  readonly duration: number
  readonly pixelsPerSecond: number
  readonly onSeek: (time: number) => void
  readonly onSelectShot: (id: string) => void
  readonly labels: VideoTimelineLabels
}

type TimelineStyle = CSSProperties & {
  '--video-timeline-width'?: string
  '--video-playhead-position'?: string
  '--video-shot-left'?: string
  '--video-shot-width'?: string
  '--video-shot-thumbnail'?: string
  '--video-tick-left'?: string
}

const PLAYHEAD_HALF_WIDTH = 11

function withMountedRef<T extends HTMLElement, R>(ref: RefObject<T | null>, action: (element: T) => R): R | undefined {
  const element = ref.current
  if (element === null) return
  return action(element)
}

function timeText(seconds: number): string {
  const whole = Math.floor(seconds)
  return `${String(Math.floor(whole / 60)).padStart(2, '0')}:${String(whole % 60).padStart(2, '0')}`
}

function tickInterval(pixelsPerSecond: number): number {
  const minimum = Math.max(1, 64 / pixelsPerSecond)
  const magnitude = 10 ** Math.floor(Math.log10(minimum))
  for (const value of [1, 2, 5]) {
    if (value * magnitude >= minimum) return value * magnitude / 4
  }
  return 10 * magnitude / 4
}

/**
 * Render real shot filmstrips, a ruler, and a 22px draggable playhead.
 * Pressing the handle preserves its position; dragging measures the rendered filmstrip
 * and retains the pointer offset at any page scale. Capture ends on release, cancellation,
 * lost capture, window blur, or unmount. Arrow keys
 * move by one second; Home and End seek the media endpoints. Endpoint gutters retain
 * the complete handle, and edge fades reflect actual remaining horizontal travel.
 * @param props - Ordered shots, controlled media state, scale, actions, and localized names.
 * @returns The horizontally scrollable media timeline.
 */
export function VideoTimeline({ shots, currentTime, selectedShotId, duration, pixelsPerSecond,
  onSeek, onSelectShot, labels }: VideoTimelineProps): ReactElement {
  const scrollRef = useRef<HTMLDivElement>(null)
  const laneRef = useRef<HTMLDivElement>(null)
  const trackRef = useRef<HTMLDivElement>(null)
  const suppressClick = useRef(false)
  const [edges, setEdges] = useState({ before: false, after: false })
  const [dragPointer, setDragPointer] = useState<number | null>(null)
  const capture = useRef<{ target: HTMLDivElement; pointerId: number; offset: number; originX: number; moved: boolean } | null>(null)
  const releaseCapture = useCallback(() => {
    const current = capture.current
    capture.current = null
    if (current?.target.hasPointerCapture(current.pointerId)) current.target.releasePointerCapture(current.pointerId)
  }, [])
  useLayoutEffect(() => releaseCapture, [releaseCapture])
  const position = Math.max(0, Math.min(duration, currentTime))
  const width = duration * pixelsPerSecond
  const interval = tickInterval(pixelsPerSecond)
  const ticks = Array.from({ length: Math.floor(duration / interval) + 1 }, (_, index) => index * interval)
  if (ticks.at(-1) !== duration) ticks.push(duration)

  const updateEdges = useCallback(() => {
    withMountedRef(scrollRef, (scroll) => {
      const max = Math.max(0, scroll.scrollWidth - scroll.clientWidth)
      const before = max > 0 && scroll.scrollLeft > 0
      const after = max > 0 && scroll.scrollLeft < max
      setEdges(previous => previous.before === before && previous.after === after ? previous : { before, after })
    })
  }, [])

  const seekAt = useCallback((clientX: number) => {
    withMountedRef(trackRef, (track) => {
      const bounds = track.getBoundingClientRect()
      if (bounds.width <= 0) return
      onSeek(Math.max(0, Math.min(duration, (clientX - bounds.left) / bounds.width * duration)))
    })
  }, [duration, onSeek])

  useLayoutEffect(() => {
    withMountedRef(scrollRef, (scroll) => {
      const x = PLAYHEAD_HALF_WIDTH + position * pixelsPerSecond
      const maximum = Math.max(0, scroll.scrollWidth - scroll.clientWidth)
      if (x - PLAYHEAD_HALF_WIDTH < scroll.scrollLeft) scroll.scrollLeft = Math.max(0, x - PLAYHEAD_HALF_WIDTH)
      else if (x + PLAYHEAD_HALF_WIDTH > scroll.scrollLeft + scroll.clientWidth) {
        scroll.scrollLeft = Math.min(maximum, x + PLAYHEAD_HALF_WIDTH - scroll.clientWidth)
      }
      updateEdges()
    })
  }, [position, pixelsPerSecond, width, updateEdges])

  useEffect(() => withMountedRef(scrollRef, scroll => withMountedRef(laneRef, (lane) => {
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(updateEdges)
    observer?.observe(scroll)
    observer?.observe(lane)
    window.addEventListener('resize', updateEdges)
    return () => { observer?.disconnect(); window.removeEventListener('resize', updateEdges) }
  })), [updateEdges])

  useLayoutEffect(() => {
    if (dragPointer === null) return
    const owner = capture.current?.target
    if (owner === undefined) return
    const move = (event: globalThis.PointerEvent) => {
      const drag = capture.current
      if (event.pointerId !== dragPointer || drag?.pointerId !== dragPointer) return
      if (event.clientX !== drag.originX) drag.moved = true
      if (drag.moved) seekAt(event.clientX - drag.offset)
    }
    const finish = (event: globalThis.PointerEvent) => {
      if (event.pointerId !== dragPointer || capture.current?.pointerId !== dragPointer) return
      const drag = capture.current
      if (event.type === 'pointerup') {
        if (drag.moved) seekAt(event.clientX - drag.offset)
        suppressClick.current = true
      }
      releaseCapture()
      setDragPointer(null)
    }
    const cancel = () => { releaseCapture(); setDragPointer(null) }
    const lost = (event: globalThis.PointerEvent) => {
      if (event.pointerId === dragPointer && capture.current?.pointerId === dragPointer) cancel()
    }
    owner.addEventListener('lostpointercapture', lost)
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', finish)
    window.addEventListener('blur', cancel)
    return () => {
      owner.removeEventListener('lostpointercapture', lost)
      // Seek callbacks change during controlled playback; their refresh keeps the native capture.
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', finish)
      window.removeEventListener('blur', cancel)
    }
  }, [dragPointer, seekAt, releaseCapture])

  function startDrag(event: PointerEvent<HTMLDivElement>): void {
    if (event.button !== 0 || capture.current !== null) return
    event.preventDefault()
    const target = event.currentTarget
    target.focus({ preventScroll: true })
    const bounds = target.getBoundingClientRect()
    capture.current = { target, pointerId: event.pointerId,
      offset: event.clientX - bounds.left - bounds.width / 2, originX: event.clientX, moved: false }
    target.setPointerCapture(event.pointerId)
    setDragPointer(event.pointerId)
  }

  function moveWithKeyboard(event: KeyboardEvent<HTMLDivElement>): void {
    let next: number
    switch (event.key) {
      case 'ArrowLeft': next = position - 1; break
      case 'ArrowRight': next = position + 1; break
      case 'Home': next = 0; break
      case 'End': next = duration; break
      default: return
    }
    event.preventDefault()
    onSeek(Math.max(0, Math.min(duration, next)))
  }

  const laneStyle: TimelineStyle = {
    '--video-timeline-width': `${width + PLAYHEAD_HALF_WIDTH * 2}px`,
    '--video-playhead-position': `${PLAYHEAD_HALF_WIDTH + position * pixelsPerSecond}px`,
  }

  return <div className={styles.window}>
    <div ref={scrollRef} className={styles.scroll} role="group" aria-label={labels.timeline}
      tabIndex={0} onScroll={updateEdges}>
      <div ref={laneRef} className={styles.lane} style={laneStyle}
        onPointerDownCapture={() => { suppressClick.current = false }} onClickCapture={(event) => {
          if (suppressClick.current && event.detail > 0) { suppressClick.current = false; event.stopPropagation() }
        }} onClick={(event) => {
          if (event.target instanceof Element && event.target.closest('[role="slider"]')) return
          seekAt(event.clientX)
        }}>
        <div className={styles.ruler} aria-hidden="true">
          {ticks.map((time, index) => {
            const major = index % 4 === 0 || time === duration
            const tickStyle: TimelineStyle = { '--video-tick-left': `${time * pixelsPerSecond}px` }
            return <span key={time} className={styles.tick} style={tickStyle}
              data-major={major} data-end={time === duration && time !== 0}>
              {major && <span className={styles.tickLabel}>{timeText(time)}</span>}
            </span>
          })}
        </div>
        <div ref={trackRef} className={styles.track} style={{ width: `${width}px` }}>
          {shots.map((shot, index) => {
            const shotStyle: TimelineStyle = {
              '--video-shot-left': `${shot.startSeconds * pixelsPerSecond}px`,
              '--video-shot-width': `${Math.max(0, (shot.endSeconds - shot.startSeconds) * pixelsPerSecond
                - (index < shots.length - 1 ? 3 : 0))}px`,
              '--video-shot-thumbnail': shot.thumbnail === null ? 'none' : `url(${JSON.stringify(shot.thumbnail)})`,
            }
            return <button key={shot.id} type="button" className={styles.shot} style={shotStyle}
              aria-label={labels.shot(shot.index, shot.startSeconds, shot.endSeconds)}
              aria-pressed={shot.id === selectedShotId} onClick={(event) => {
                event.stopPropagation()
                onSelectShot(shot.id)
                if (event.detail === 0 || event.clientX === 0 && event.clientY === 0) onSeek(shot.startSeconds)
                else seekAt(event.clientX)
              }} />
          })}
        </div>
        <div className={styles.playhead} role="slider" tabIndex={0} aria-label={labels.playhead}
          aria-valuemin={0} aria-valuemax={duration} aria-valuenow={position}
          aria-valuetext={timeText(position)} aria-orientation="horizontal"
          onPointerDown={startDrag} onKeyDown={moveWithKeyboard}>
          <span className={styles.cap} aria-hidden="true" />
        </div>
      </div>
    </div>
    <span className={styles.fadeBefore} data-timeline-fade="start" aria-hidden="true" hidden={!edges.before} />
    <span className={styles.fadeAfter} data-timeline-fade="end" aria-hidden="true" hidden={!edges.after} />
  </div>
}
