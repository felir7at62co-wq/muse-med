/** Retain the closing curtain only until its own CSS transition finishes. */
import { useLayoutEffect, useState } from 'react'
import type { RefObject } from 'react'

/**
 * Keep media mounted for the exit transition without changing transcript layout.
 * Reopening cancels the pending removal; reduced-motion CSS removes it immediately.
 * @param open - Current disclosure intent.
 * @param ref - Always-mounted element owning the curtain transitions.
 * @returns Whether the curtain's contents remain mounted.
 */
export function useCurtainPresence(open: boolean, ref: RefObject<HTMLDivElement | null>): boolean {
  const [present, setPresent] = useState(open)
  useLayoutEffect(() => {
    const element = ref.current
    if (open) {
      // Resolve the collapsed track before adding content to its opening transition.
      element?.getBoundingClientRect()
      setPresent(true)
      return
    }
    const animations = element?.getAnimations() ?? []
    if (animations.length === 0) { setPresent(false); return }
    let current = true
    void Promise.allSettled(animations.map(animation => animation.finished)).then(() => {
      if (current) setPresent(false)
    })
    return () => { current = false }
  }, [open, ref])
  return open || present
}
