/** React-owned canvas copy for collecting an inline video into its conversation bubble. */
import { useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode, RefObject } from 'react'
import { createPortal } from 'react-dom'
import { absorptionGeometry } from './absorption.ts'
import type { AbsorptionGeometry, AbsorptionRect } from './absorption.ts'
import styles from './useAbsorption.module.css'

/** Callbacks owned by one stable video card. */
export interface AbsorptionOptions {
  readonly id: string
  readonly onCollect: (collected: boolean) => void
  readonly onOpen: () => void
}

function rectangle(element: Element): AbsorptionRect {
  const { left, top, width, height } = element.getBoundingClientRect()
  return { left, top, width, height }
}

function drawNeck(context: CanvasRenderingContext2D, geometry: AbsorptionGeometry): void {
  const neck = geometry.neck
  if (neck === null) return
  const { topX, topY, bottomX, bottomY, topRadius, bottomRadius, opacity } = neck
  const distance = bottomY - topY
  context.globalAlpha = opacity
  context.beginPath()
  context.moveTo(topX - topRadius, topY)
  context.bezierCurveTo(topX - topRadius, topY + distance * 0.65,
    bottomX - bottomRadius, bottomY - distance * 0.65, bottomX - bottomRadius, bottomY)
  context.lineTo(bottomX + bottomRadius, bottomY)
  context.bezierCurveTo(bottomX + bottomRadius, bottomY - distance * 0.65,
    topX + topRadius, topY + distance * 0.65, topX + topRadius, topY)
  context.closePath()
  context.fill()
  context.globalAlpha = 1
}

function captureVideo(source: HTMLElement, snapshot: HTMLCanvasElement): boolean {
  const video = source.querySelector('video')
  if (video === null || video.readyState < 2 || video.videoWidth === 0) return false
  const sourceRect = rectangle(source)
  const videoRect = rectangle(video)
  snapshot.width = Math.max(1, Math.ceil(sourceRect.width))
  snapshot.height = Math.max(1, Math.ceil(sourceRect.height))
  const context = snapshot.getContext('2d')
  if (context === null) return false
  try {
    context.drawImage(video, videoRect.left - sourceRect.left, videoRect.top - sourceRect.top, videoRect.width, videoRect.height)
    context.getImageData(0, 0, 1, 1)
    return true
  } catch (_error: unknown) {
    // Cross-origin and unavailable media retain the bubble material without a substitute frame.
    return false
  }
}

/**
 * Collect an inline video without moving its React DOM or changing its layout height.
 * The original and any enclosing delivered-file card remain in place and are hidden while a canvas copy
 * follows the nearest conversation's bubble. Only readable real video pixels enter that
 * copy; unavailable or cross-origin frames retain the receiving bubble's material.
 * @param ref - Inline card whose nearest data-chat-frame owns the receiving anchor.
 * @param options - Stable video id, collection-state callback, and existing open action.
 * @returns The frame-owned animation portal, or null until that frame exists.
 */
export function useAbsorption(ref: RefObject<HTMLElement | null>, options: AbsorptionOptions): ReactNode {
  const [frame, setFrame] = useState<HTMLElement | null>(null)
  const layerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const materialRef = useRef<HTMLSpanElement>(null)
  const hitRef = useRef<HTMLButtonElement>(null)
  const callbacks = useRef(options)
  useLayoutEffect(() => { callbacks.current = options }, [options])
  useLayoutEffect(() => { setFrame(ref.current?.closest<HTMLElement>('[data-chat-frame]') ?? null) }, [ref, options.id])

  useLayoutEffect(() => {
    const source = ref.current
    const layer = layerRef.current
    const canvas = canvasRef.current
    const material = materialRef.current
    const hit = hitRef.current
    if (source === null || frame === null || layer === null || canvas === null || material === null || hit === null) return
    const scroll = source.closest<HTMLElement>('[data-conversation-scroll]') ?? frame.querySelector<HTMLElement>('[data-chat-scroll]')
    if (scroll === null) return
    const delivery = source.closest<HTMLElement>('[data-presented-file][data-video="true"]')
    const surfaces = [source, ...(delivery === null ? [] : [delivery])].map(element => ({
      element, visibility: element.style.visibility, inert: element.inert, aria: element.getAttribute('aria-hidden'),
    }))
    const initialOnCollect = callbacks.current.onCollect
    const snapshot = document.createElement('canvas')
    const motion = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-reduced-motion: reduce)') : undefined
    let pending = 0
    let collected = false
    let anchor: HTMLElement | null = null
    let originalFusion = ''
    let disposed = false
    let concealed = false

    const restoreSource = () => {
      for (const { element, visibility, inert, aria } of surfaces) {
        element.style.visibility = visibility
        element.inert = inert
        if (aria === null) element.removeAttribute('aria-hidden')
        else element.setAttribute('aria-hidden', aria)
      }
    }
    const clearFusion = () => {
      if (anchor?.getAttribute('data-muse-video-fusion-owner') !== options.id) return
      if (originalFusion) anchor.style.setProperty('--muse-video-fusion', originalFusion)
      else anchor.style.removeProperty('--muse-video-fusion')
      anchor.removeAttribute('data-muse-video-fusion-owner')
    }
    const paint = () => {
      pending = 0
      if (disposed) return
      const nextAnchor = frame.querySelector<HTMLElement>('[data-muse-video-anchor]')
      if (nextAnchor !== anchor) { clearFusion(); anchor = nextAnchor; originalFusion = anchor?.style.getPropertyValue('--muse-video-fusion') ?? '' }
      if (anchor === null) {
        if (collected) { collected = false; callbacks.current.onCollect(false) }
        concealed = false
        restoreSource()
        layer.hidden = true
        return
      }
      const sourceRect = rectangle(source)
      const viewport = rectangle(scroll)
      const anchorRect = rectangle(anchor)
      const result = absorptionGeometry({ source: sourceRect, viewport, anchor: anchorRect, reducedMotion: motion?.matches ?? false })
      if (result.collected !== collected) { collected = result.collected; callbacks.current.onCollect(collected) }
      const moving = result.phase === 'moving' || result.phase === 'merging' || result.phase === 'inside'
      layer.dataset.phase = result.phase
      layer.hidden = !moving
      if (moving || result.collected) {
        if (!concealed) source.querySelector('video')?.pause()
        for (const { element } of surfaces) {
          element.style.visibility = 'hidden'
          element.inert = true
          element.setAttribute('aria-hidden', 'true')
        }
      } else restoreSource()
      concealed = moving || result.collected
      if (result.fusion > 0) {
        anchor.setAttribute('data-muse-video-fusion-owner', options.id)
        anchor.style.setProperty('--muse-video-fusion', String(result.fusion))
      } else clearFusion()
      if (!moving) return
      const frameRect = rectangle(frame)
      const origin = { left: frameRect.left, top: Math.min(viewport.top, anchorRect.top) }
      const height = Math.max(viewport.top + viewport.height, anchorRect.top + anchorRect.height) - origin.top
      layer.style.setProperty('--video-absorption-left', '0px')
      layer.style.setProperty('--video-absorption-top', `${origin.top - frameRect.top}px`)
      layer.style.setProperty('--video-absorption-width', `${frameRect.width}px`)
      layer.style.setProperty('--video-absorption-height', `${height}px`)
      const { sprite } = result
      hit.style.setProperty('--video-absorption-hit-left', `${sprite.left - origin.left}px`)
      hit.style.setProperty('--video-absorption-hit-top', `${sprite.top - origin.top}px`)
      hit.style.setProperty('--video-absorption-hit-width', `${sprite.width}px`)
      hit.style.setProperty('--video-absorption-hit-height', `${sprite.height}px`)
      hit.style.setProperty('--video-absorption-hit-radius', `${sprite.radius}px`)
      const label = source.getAttribute('aria-label')
      hit.hidden = result.progress >= 0.86 || label === null
      if (label !== null) hit.setAttribute('aria-label', label)
      const ratio = Math.min(window.devicePixelRatio || 1, 2)
      canvas.width = Math.max(1, Math.ceil(frameRect.width * ratio))
      canvas.height = Math.max(1, Math.ceil(height * ratio))
      const context = canvas.getContext('2d')
      if (context === null) {
        restoreSource()
        concealed = false
        layer.hidden = true
        clearFusion()
        return
      }
      context.setTransform(ratio, 0, 0, ratio, -origin.left * ratio, -origin.top * ratio)
      const anchorColor = getComputedStyle(anchor).backgroundColor
      context.fillStyle = anchorColor === 'transparent' || anchorColor === 'rgba(0, 0, 0, 0)'
        ? getComputedStyle(material).backgroundColor : anchorColor
      context.save()
      context.beginPath()
      if (result.clip !== null) {
        const clip = result.clip
        context.roundRect(clip.left, clip.top, clip.width, clip.height, clip.height / 2)
      } else context.rect(origin.left, anchorRect.top, frameRect.width, height)
      context.clip()
      drawNeck(context, result)
      context.beginPath()
      context.roundRect(sprite.left, sprite.top, sprite.width, sprite.height, sprite.radius)
      context.fill()
      context.clip()
      if (result.contentOpacity > 0 && captureVideo(source, snapshot)) {
        context.globalAlpha = result.contentOpacity
        context.drawImage(snapshot, sprite.left, sprite.top, sprite.width, sprite.height)
      }
      context.restore()
    }
    const schedule = () => { if (!disposed && pending === 0) pending = requestAnimationFrame(paint) }
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(schedule)
    observer?.observe(source)
    observer?.observe(frame)
    observer?.observe(scroll)
    const initialAnchor = frame.querySelector<HTMLElement>('[data-muse-video-anchor]')
    if (initialAnchor !== null) observer?.observe(initialAnchor)
    scroll.addEventListener('scroll', schedule, { passive: true })
    window.addEventListener('resize', schedule)
    motion?.addEventListener('change', schedule)
    schedule()
    return () => {
      disposed = true
      cancelAnimationFrame(pending)
      scroll.removeEventListener('scroll', schedule)
      window.removeEventListener('resize', schedule)
      motion?.removeEventListener('change', schedule)
      observer?.disconnect()
      layer.hidden = true
      hit.hidden = true
      clearFusion()
      restoreSource()
      if (collected) initialOnCollect(false)
    }
  }, [frame, ref, options.id])

  return frame === null ? null : createPortal(<div ref={layerRef} className={styles.layer} hidden
    data-video-absorption={options.id}>
    <span ref={materialRef} className={styles.material} aria-hidden="true" />
    <canvas ref={canvasRef} className={styles.canvas} aria-hidden="true" />
    <button ref={hitRef} className={styles.hit} type="button" tabIndex={-1} hidden onClick={options.onOpen} />
  </div>, frame)
}
