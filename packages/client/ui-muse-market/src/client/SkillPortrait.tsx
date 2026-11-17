/** A fixed silhouette stage shared by discovery, installed releases and creation previews. */
import { useState, type ReactNode } from 'react'
import { HoverCard, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { resolveMarketSkillArtwork, type MarketSkillArtworkMetadata } from './market-skill-artwork.ts'
import { marketPresetPortraitUrls } from './market-preset-portrait-urls.ts'
import { marketPortraitStyle, presetPortraitFraming } from './market-portrait-framing.ts'
import css from './MarketSection.module.css'
import fallbackPortrait from './assets/muse-purple-spider.png'

/** Display a deterministically matched character and its keyboard-accessible introduction. */
export function SkillPortrait({ metadata, introductionLabel, closeLabel }: {
  readonly metadata: MarketSkillArtworkMetadata
  readonly introductionLabel?: string
  readonly closeLabel?: string
}): ReactNode {
  const id = resolveMarketSkillArtwork(metadata)
  const [failedId, setFailedId] = useState<string>()
  const [introducing, setIntroducing] = useState(false)
  const fallback = failedId === id
  return <div className={css.portraitStage}>
    <HoverCard inline content={<div className={css.introduction}>
      <strong>{metadata.title}</strong><p>{metadata.description}</p></div>}
    anchor={<button className={css.portrait} type="button" aria-label={metadata.title} data-market-portrait={id}
      aria-haspopup={closeLabel ? 'dialog' : undefined} aria-expanded={closeLabel ? introducing : undefined}
      onClick={closeLabel ? () => { setIntroducing(value => !value) } : undefined}>
      <span className={css.portraitFrame}><span className={css.portraitMotion}><img src={fallback ? fallbackPortrait : marketPresetPortraitUrls[id]} onError={() => { setFailedId(id) }} alt="" loading="lazy" decoding="async" style={fallback ? undefined : marketPortraitStyle(presetPortraitFraming[id])} /></span></span>
      {introductionLabel && <span className={css.portraitHint}>{introductionLabel}</span>}
    </button>} />
    {closeLabel && <Modal open={introducing} title={metadata.title} closeLabel={closeLabel} onClose={() => { setIntroducing(false) }}>
      <p>{metadata.description}</p></Modal>}
  </div>
}
