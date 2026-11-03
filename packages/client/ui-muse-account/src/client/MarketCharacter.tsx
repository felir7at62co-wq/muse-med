/** Shared role portrait and introduction for market cards and author previews. */
import { useId, useState, type ReactNode } from 'react'
import { Button, HoverCard } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './MarketCharacter.module.css'
import { MarketAnimation } from './MarketAnimation.tsx'
import type { CharacterAnimation, CharacterVersionId } from './market-character-generation.ts'

/** Display-only character information; it does not alter a Bot's persona or permissions. */
export interface MarketPresentation {
  /** Profession displayed alongside the portrait. */
  role: string
  /** Fixed introduction supplied by the author. */
  introduction: string
  /** Optional approved portrait, or a local preview data URL. */
  posterUrl?: string | undefined
  /** Immutable display-media revision, separate from the installed Bot version. */
  characterVersion?: CharacterVersionId
  /** Optional approved sprite sequences; absent or failed media stays static. */
  animation?: CharacterAnimation
}

/** Render supplied artwork with the original Muse portrait as a labeled fallback.
 * @param props Artwork URL and locale-owned accessible and fallback labels.
 * @returns Contained artwork without cropping the character or resources.
 */
export function MarketArtwork({ posterUrl, label, sampleLabel }: {
  posterUrl?: string | undefined
  label: string
  sampleLabel: string
}): ReactNode {
  const [failedPoster, setFailedPoster] = useState<string>()
  return posterUrl && failedPoster !== posterUrl
    ? <img className={css.portrait} src={posterUrl} alt={label} onError={() => { setFailedPoster(posterUrl) }} />
    : <><span className={css.muse} role="img" aria-label={label} /><span className={css.sample}>{sampleLabel}</span></>
}

/** Render the same character in discovery and the local author preview.
 * @param props Character information and locale-owned control labels.
 * @returns Portrait with a hover/focus introduction and a touch-accessible toggle.
 */
export function MarketCharacter({ presentation, introduceLabel, sampleLabel, artwork }: {
  presentation: MarketPresentation
  artwork?: ReactNode
  introduceLabel: string
  sampleLabel: string
}): ReactNode {
  const [expanded, setExpanded] = useState(false)
  const [hovered, setHovered] = useState(false), [focused, setFocused] = useState(false)
  const introductionId = useId()
  const portrait = artwork ?? <MarketArtwork posterUrl={presentation.posterUrl} label={presentation.role} sampleLabel={sampleLabel} />
  return <div className={css.character} data-introducing={expanded || hovered || focused}
    onPointerEnter={() => { setHovered(true) }} onPointerLeave={() => { setHovered(false) }}
    onFocus={() => { setFocused(true) }} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false) }}
    onKeyDown={(event) => { if (event.key === 'Escape') { setExpanded(false); setFocused(false); setHovered(false) } }}>
    <HoverCard inline openDelayMs={250} disabled={expanded}
      content={<div className={css.dialog}><strong>{presentation.role}</strong><p>{presentation.introduction}</p></div>}
      anchor={<button type="button" className={css.portraitButton} aria-label={introduceLabel} aria-expanded={expanded}
        aria-controls={expanded ? introductionId : undefined}
        onClick={() => { setExpanded(value => !value) }}>
        {presentation.animation ? <MarketAnimation animation={presentation.animation} introducing={expanded || hovered || focused}
          label={presentation.role} fallback={portrait} /> : portrait}
      </button>} />
    <div className={css.caption}><span>{presentation.role}</span><Button size="sm" aria-expanded={expanded}
      aria-controls={expanded ? introductionId : undefined}
      onClick={() => { setExpanded(value => !value) }}>{introduceLabel}</Button></div>
    {expanded && <div id={introductionId} className={css.introduction}>
      <p>{presentation.introduction}</p>
    </div>}
  </div>
}
