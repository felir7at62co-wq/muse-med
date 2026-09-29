/** Muse's verse-by-verse typewriter greeting, matching the web workroom. */
import { useEffect, useState, type ReactNode } from 'react'
import css from './MusePoetry.module.css'

/**
 * Animate the original-language poetry with a static reduced-motion alternative.
 * @param props - newline-delimited verses and theme-aware product mark.
 * @returns the decorative greeting and a complete verse for assistive reading.
 */
export function MusePoetry({ text, mark }: { text: string; mark: ReactNode }): ReactNode {
  const [frame, setFrame] = useState({ verse: text.split('\n')[0] ?? '', text: '', reduced: false })
  useEffect(() => {
    const verses = text.split('\n')
    const media = window.matchMedia('(prefers-reduced-motion: reduce)')
    let timer: ReturnType<typeof setTimeout> | undefined
    let index = 0
    let shown = ''
    let phase: 'type' | 'erase' = 'type'
    const publish = () => { setFrame({ verse: verses[index] ?? '', text: shown, reduced: media.matches }) }
    const schedule = (delay: number) => { timer = setTimeout(tick, delay) }
    function tick(): void {
      if (media.matches) return
      const verse = verses[index] ?? ''
      if (phase === 'type') {
        shown = Array.from(verse).slice(0, Array.from(shown).length + 1).join('')
        publish()
        if (shown === verse) { phase = 'erase'; schedule(3200) }
        else schedule(105)
      } else if (shown) {
        shown = Array.from(shown).slice(0, -1).join('')
        publish()
        schedule(45)
      } else {
        index = (index + 1) % verses.length
        phase = 'type'
        publish()
        schedule(550)
      }
    }
    const reset = () => {
      clearTimeout(timer)
      shown = media.matches ? verses[index] ?? '' : ''
      phase = 'type'
      publish()
      if (!media.matches) schedule(550)
    }
    reset()
    media.addEventListener('change', reset)
    return () => { clearTimeout(timer); media.removeEventListener('change', reset) }
  }, [text])
  return <span className={css.root} data-muse-poetry="">
    <span className={css.row} aria-hidden="true">
      {mark}
      <span className={css.line}>
        <span data-muse-poetry-line="">{frame.text}</span>
        {!frame.reduced && <span className={css.caret} data-muse-caret="" />}
      </span>
    </span>
    <span className={css.accessible} aria-live="off">{frame.verse}</span>
  </span>
}
