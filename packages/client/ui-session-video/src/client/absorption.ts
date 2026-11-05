/** Scroll-coupled video collection geometry in viewport coordinates. */

/** Measured element rectangle; all values use CSS pixels. */
export interface AbsorptionRect {
  readonly left: number
  readonly top: number
  readonly width: number
  readonly height: number
}

/** Opaque connection between the receiving bubble and the moving video. */
export interface AbsorptionNeck {
  readonly topX: number
  readonly topY: number
  readonly bottomX: number
  readonly bottomY: number
  readonly topRadius: number
  readonly bottomRadius: number
  readonly opacity: number
}

/** One sampled position of the video and its receiving bubble. */
export interface AbsorptionGeometry {
  readonly progress: number
  readonly collected: boolean
  readonly phase: 'idle' | 'moving' | 'merging' | 'inside' | 'collected'
  readonly sprite: AbsorptionRect & { readonly radius: number }
  readonly contentOpacity: number
  readonly borderOpacity: number
  readonly fusion: number
  readonly clip: AbsorptionRect | null
  readonly neck: AbsorptionNeck | null
}

function clamp(value: number, minimum = 0, maximum = 1): number {
  return Math.max(minimum, Math.min(maximum, value))
}

function smooth(from: number, to: number, value: number): number {
  const t = clamp((value - from) / (to - from))
  return t * t * (3 - 2 * t)
}

/**
 * Sample the approved shrinking-card and opaque-neck motion from scroll position.
 * The destination overlaps the receiving bubble by 5px before entering it; after
 * progress 0.86, clipping stays 3px inside that bubble. Reduced motion retains the
 * source until collection, with no sprite or bridge animation.
 * @param input - Real source, viewport and receiving-bubble rectangles, plus motion preference.
 * @returns Scroll progress, transformed sprite, optional clipping and fusion geometry.
 */
export function absorptionGeometry(input: {
  readonly source: AbsorptionRect
  readonly viewport: AbsorptionRect
  readonly anchor: AbsorptionRect
  readonly reducedMotion: boolean
}): AbsorptionGeometry {
  const { source, viewport, anchor, reducedMotion } = input
  const progress = source.height > 0 ? clamp((viewport.top + 44 - source.top) / (source.height * 0.9 + 44)) : 0
  const idle = progress <= 0 || source.width <= 0 || anchor.width <= 0 || anchor.height <= 8
  const collected = !idle && progress >= 0.985
  const phase = idle ? 'idle' : progress >= 1 || reducedMotion && collected ? 'collected'
    : reducedMotion ? 'idle' : progress > 0.86 ? 'inside' : progress > 0.45 ? 'merging' : 'moving'
  const ease = smooth(0, 1, progress)
  const endScale = source.width > 0 && source.height > 0 ? Math.min(64 / source.width, (anchor.height - 8) / source.height) : 1
  const scale = idle ? 1 : 1 + (endScale - 1) * ease
  const width = source.width * scale
  const height = source.height * scale
  const align = smooth(0, 0.55, progress)
  const x = (source.left + source.width / 2) * (1 - align) + (anchor.left + anchor.width / 2) * align
  const desiredY = (source.top + source.height / 2) * (1 - ease) + (anchor.top + anchor.height / 2) * ease
  const landingTop = anchor.top + anchor.height - 5 - (anchor.height - 8) * smooth(0.5, 0.94, progress)
  const y = idle ? source.top + height / 2 : Math.max(desiredY, landingTop + height / 2)
  const sprite = { left: x - width / 2, top: y - height / 2, width, height,
    radius: Math.min((17 + ease * source.height / 2) * scale, width / 2, height / 2) }
  const visible = phase === 'moving' || phase === 'merging' || phase === 'inside'
  const gap = Math.max(0, sprite.top - anchor.top - anchor.height)
  const strength = visible ? smooth(0.18, 0.42, progress) * (1 - smooth(0.95, 1, progress))
    * (1 - smooth(12, 64, gap)) : 0
  const fusion = smooth(0, 0.22, strength)
  const topY = anchor.top + anchor.height - 9
  const bottomY = sprite.top + Math.min(height * 0.4, Math.max(9, sprite.radius * 0.65))
  const neckRadius = Math.min(anchor.width * 0.3, width * 0.28) * smooth(0, 0.65, strength)
  const neck = strength > 0 && bottomY > topY ? {
    topX: anchor.left + anchor.width / 2, topY,
    bottomX: x, bottomY, topRadius: neckRadius,
    bottomRadius: Math.min(width * 0.28, neckRadius * 1.35), opacity: fusion,
  } : null
  return { progress, collected, phase, sprite, neck, fusion,
    contentOpacity: 1 - smooth(0.42, 0.84, progress),
    borderOpacity: 1 - smooth(0.28, 0.62, progress),
    clip: visible && progress > 0.86 ? { left: anchor.left + 3, top: anchor.top + 3,
      width: Math.max(0, anchor.width - 6), height: Math.max(0, anchor.height - 6) } : null }
}
