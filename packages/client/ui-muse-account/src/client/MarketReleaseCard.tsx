/** Shared publication card for discovery, private cloud releases and local installations. */
import type { ReactNode } from 'react'
import type { MarketLegacyResource, MarketRelease } from '@deepseek-ai/dsh-muse-market/types'
import { MarketCharacter } from './MarketCharacter.tsx'
import type { MarketSectionProps } from './MarketSection.tsx'
import { MarketSkillArtwork } from './MarketCatalogArtwork.tsx'
import css from './MarketSection.module.css'

/** Render shared role artwork and immutable publication information with caller-owned actions.
 * @param props Release, optional display-only presentation, localized copy and action children.
 * @returns Three-column-compatible publication card.
 */
export function MarketReleaseCard(props: ({
  release: MarketRelease
  resource?: never
} | {
  resource: MarketLegacyResource
  release?: never
}) & {
  showStatus?: boolean
  t: MarketSectionProps['t']
  children: ReactNode
}): ReactNode {
  const { release, resource, showStatus, t, children } = props
  const manifest = release ? release.manifest : resource
  return <article className={css.card}>
    <div className={css.cardHeading}><span className={css.badge}>{t('skill')}</span>
      <span className={css.meta}>{showStatus && release ? t(`publication.${release.status}`) : manifest.category}</span></div>
    <MarketCharacter presentation={{ role: manifest.title, introduction: manifest.description }}
      introduceLabel={t('introduce')} sampleLabel={t('samplePortrait')}
      artwork={<MarketSkillArtwork metadata={resource ? { ...resource, name: resource.id } : release.manifest} label={manifest.title} />} />
    <h3>{manifest.title}</h3><p className={css.cardSummary}>{manifest.description}</p>
    <p className={css.publisherLine}>{t('creator', { publisher: release?.publisher ?? t('legacySource'), version: manifest.version })}</p>
    <div className={css.cardActions}>{children}</div>
  </article>
}
