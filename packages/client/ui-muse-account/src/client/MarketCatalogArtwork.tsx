/** Automatically matched Muse characters shared by every Skill market view. */
import type { ReactNode } from 'react'
import { MarketArtwork } from './MarketCharacter.tsx'
import { marketPresetPortraitUrls } from './market-preset-portrait-urls.ts'
import { resolveMarketSkillArtwork, type MarketSkillArtworkMetadata } from './market-skill-artwork.ts'
import css from './MarketCharacter.module.css'

/** Display a Skill's assigned profession character with the shared silhouette normalization.
 * @param props Skill metadata and accessible title.
 * @returns A contained character portrait with a labeled fallback when the asset is unavailable.
 */
export function MarketSkillArtwork({ metadata, label }: {
  metadata: MarketSkillArtworkMetadata
  label: string
}): ReactNode {
  const portrait = resolveMarketSkillArtwork(metadata)
  return <span className={css.catalogMotion}>
    <MarketArtwork posterUrl={marketPresetPortraitUrls[portrait]} label={label} sampleLabel="" />
  </span>
}
