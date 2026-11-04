/** Shared sprite player with static fallback and local visibility/motion controls. */
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import type { CharacterAnimation } from './market-character-generation.ts'
import css from './MarketCharacter.module.css'

/** Play supplied frame sequences; this component never requests image generation.
 * @param props Approved sprite metadata, interaction state, and static fallback artwork.
 * @returns A contained sprite cell or the original static portrait.
 */
export function MarketAnimation({ animation, introducing, label, fallback }: {
  animation: CharacterAnimation
  introducing: boolean
  label: string
  fallback: ReactNode
}): ReactNode {
  const container = useRef<HTMLSpanElement>(null)
  const frameClip = useId()
  const [canAnimate, setCanAnimate] = useState(false)
  const [loadedSheet, setLoadedSheet] = useState(''), [failedSheet, setFailedSheet] = useState('')
  const frames = introducing ? animation.introduce : animation.idle
  const [frame, setFrame] = useState({ sequence: frames, index: 0 })
  const ready = loadedSheet === animation.sheetUrl && failedSheet !== animation.sheetUrl
  const playing = ready && canAnimate && frames.length > 0
  useEffect(() => {
    const element = container.current
    if (typeof window.matchMedia !== 'function') return
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)')
    let visible = false
    const update = (): void => { setCanAnimate(visible && !motion.matches && !document.hidden) }
    const observer = typeof IntersectionObserver === 'undefined' ? undefined : new IntersectionObserver((entries) => {
      visible = entries.some(entry => entry.isIntersecting); update()
    })
    if (element) observer?.observe(element)
    motion.addEventListener('change', update)
    document.addEventListener('visibilitychange', update)
    update()
    return () => { observer?.disconnect(); motion.removeEventListener('change', update); document.removeEventListener('visibilitychange', update) }
  }, [])
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined, index = 0
    setFrame({ sequence: frames, index: 0 })
    if (!playing) return
    const next = (): void => {
      const duration = frames[index]?.durationMs
      if (duration === undefined) return
      timer = setTimeout(() => {
        index = (index + 1) % frames.length; setFrame({ sequence: frames, index }); next()
      }, duration)
    }
    next()
    return () => { clearTimeout(timer) }
  }, [frames, playing])
  const index = frame.sequence === frames ? frame.index : 0
  const cell = frames[index]?.cell ?? frames[0]?.cell ?? 0
  return <span ref={container} className={css.animation} data-playing={playing}>
    {!playing && fallback}
    {failedSheet !== animation.sheetUrl && <span className={css.sprite} hidden={!playing}>
      <svg viewBox={`0 0 ${animation.cellWidth} ${animation.cellHeight}`} role="img" aria-label={label}>
        <defs><clipPath id={frameClip} clipPathUnits="userSpaceOnUse">
          <rect x={0} y={0} width={animation.cellWidth} height={animation.cellHeight} />
        </clipPath></defs>
        <g clipPath={`url(#${frameClip})`}>
          <image href={animation.sheetUrl} onLoad={() => { setLoadedSheet(animation.sheetUrl) }}
            onError={() => { setFailedSheet(animation.sheetUrl) }} width={animation.columns * animation.cellWidth}
            height={animation.rows * animation.cellHeight} x={-(cell % animation.columns) * animation.cellWidth}
            y={-Math.floor(cell / animation.columns) * animation.cellHeight} />
        </g>
      </svg>
    </span>}
  </span>
}
