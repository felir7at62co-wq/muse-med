/** Shared publication card for discovery, private cloud releases and local installations. */
import type { ReactNode } from 'react'
import type { MarketRelease } from '@deepseek-ai/dsh-muse-market/types'
import { MarketArtwork, MarketCharacter, type MarketPresentation } from './MarketCharacter.tsx'
import type { MarketSectionProps } from './MarketSection.tsx'
import { boundMarketPresentation, stockMarketPresentation } from './market-stock-art.ts'
import type { MarketLegacyResource } from './market-web-types.ts'
import { MarketCatalogBot, MarketCatalogSkill } from './MarketCatalogArtwork.tsx'
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
  presentation?: MarketPresentation | undefined
  showStatus?: boolean
  t: MarketSectionProps['t']
  children: ReactNode
}): ReactNode {
  const { release, resource, presentation, showStatus, t, children } = props
  const stock = presentation || !release ? undefined : stockMarketPresentation(release)
  const manifest = release ? release.manifest : resource
  const character = (release && boundMarketPresentation(release.manifest)) ?? presentation ?? stock ?? { role: manifest.title, introduction: resource && manifest.kind === 'bot'
    ? t('legacyBotIntroduction', { role: manifest.title, description: manifest.description }) : manifest.description }
  return <article className={css.card}>
    <div className={css.cardHeading}><span className={css.badge}>{t(manifest.kind)}</span>
      <span className={css.meta}>{showStatus && release ? t(`publication.${release.status}`) : manifest.category}</span></div>
    {manifest.kind === 'bot'
      ? <MarketCharacter presentation={character} introduceLabel={t('introduce')} sampleLabel={t('samplePortrait')}
        artwork={resource && <MarketCatalogBot id={resource.id} label={manifest.title}
          fallback={<MarketArtwork label={manifest.title} sampleLabel={t('samplePortrait')} />} />} />
      : <div className={css.skillMedia}>{resource ? <MarketCatalogSkill category={manifest.category} label={manifest.title} />
        : <MarketArtwork posterUrl={character.posterUrl} label={manifest.title} sampleLabel={t('samplePortrait')} />}</div>}
    <h3>{manifest.title}</h3><p className={css.cardSummary}>{manifest.description}</p>
    <p className={css.publisherLine}>{t('creator', { publisher: release?.publisher ?? t('legacySource'), version: manifest.version })}</p>
    {stock && <p className={css.meta}>{t('stockArtworkHint')}</p>}
    <div className={css.cardActions}>{children}</div>
  </article>
}
