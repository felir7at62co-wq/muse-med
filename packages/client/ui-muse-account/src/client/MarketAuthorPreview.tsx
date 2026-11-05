/** Skill publication preview with its automatically assigned Muse character. */
import type { ReactNode } from 'react'
import type { MarketSectionProps } from './MarketSection.tsx'
import { MarketSkillArtwork } from './MarketCatalogArtwork.tsx'
import type { MarketSkillArtworkMetadata } from './market-skill-artwork.ts'
import { MarketCharacter } from './MarketCharacter.tsx'
import css from './MarketSection.module.css'

/** Preview the same character and Skill metadata that will appear on the publication card.
 * @param props Current author fields and localized page labels.
 * @returns Live Skill summary, automatic character, and source Skill names.
 */
export function MarketAuthorPreview({ metadata, version, publisher, skillNames, t }: {
  metadata: MarketSkillArtworkMetadata
  version: string
  publisher: string
  skillNames: readonly string[]
  t: MarketSectionProps['t']
}): ReactNode {
  const { title, description } = metadata
  const previewTitle = title || t('untitledSkill')
  return <aside className={css.preview} aria-label={t('preview')}>
    <div className={css.previewHeading}><h3>{t('preview')}</h3><span className={css.badge}>{t('localPreview')}</span></div>
    <MarketCharacter presentation={{ role: previewTitle, introduction: description || t('skillPreviewHint') }}
      artwork={<MarketSkillArtwork metadata={{ ...metadata, skills: skillNames.map(name => ({ name })) }} label={previewTitle} />}
      introduceLabel={t('introduce')} sampleLabel={t('samplePortrait')} />
    <h3>{previewTitle}</h3>
    <p>{description || t('skillPreviewHint')}</p>
    <div className={css.meta}>{publisher || t('publisherPending')} · {version || t('versionPending')}</div>
    <div className={css.previewFacts}><span>{t('sourceSkillsShort')}</span><p>{skillNames.join(' / ') || t('noSelectedSkills')}</p></div>
    <p className={css.previewHint}>{t('previewBeforeUpload')}</p>
  </aside>
}
