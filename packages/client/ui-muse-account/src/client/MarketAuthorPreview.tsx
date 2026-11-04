/** Publication and character preview beside the author form. */
import { useState, type ReactNode } from 'react'
import { Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MarketPresetPortraitId } from '@deepseek-ai/dsh-muse-market/types'
import { marketPresetPortraitUrls } from './market-preset-portrait-urls.ts'
import type { MarketSectionProps } from './MarketSection.tsx'
import { MarketSkillArtwork } from './MarketCatalogArtwork.tsx'
import type { MarketSkillArtworkMetadata } from './market-skill-artwork.ts'
import { MarketCharacter } from './MarketCharacter.tsx'
import css from './MarketSection.module.css'

/** Preview the automatically matched publication portrait before package preparation.
 * @param props Current author fields and localized page labels.
 * @returns Live package summary and matched artwork.
 */
export function MarketAuthorPreview({
  metadata, version, publisher, bot, skillNames, presetPortrait, t,
}: {
  metadata: MarketSkillArtworkMetadata
  version: string
  publisher: string
  bot: boolean
  skillNames: readonly string[]
  presetPortrait: MarketPresetPortraitId | undefined
  t: MarketSectionProps['t']
}): ReactNode {
  const { title, description } = metadata
  const [role, setRole] = useState(''), [introduction, setIntroduction] = useState('')
  const previewTitle = title || t(bot ? 'untitledBot' : 'untitledSkill')
  return <aside className={css.preview} aria-label={t('preview')}>
    <div className={css.previewHeading}><h3>{t('preview')}</h3><span className={css.badge}>{t('localPreview')}</span></div>
    {bot && <>
      <MarketCharacter presentation={{ role: role || previewTitle,
        introduction: introduction || description || t('introductionPlaceholder'),
        posterUrl: presetPortrait && marketPresetPortraitUrls[presetPortrait] }}
      introduceLabel={t('introduce')} sampleLabel={t('samplePortrait')} />
      <p className={css.previewHint}>{t('preparedPortraitHint')}</p>
      <label className={css.field}>{t('role')}<Input maxLength={80} value={role}
        placeholder={t('rolePlaceholder')} onChange={(event) => { setRole(event.target.value) }} /></label>
      <label className={css.field}>{t('introduction')}<textarea maxLength={500} rows={3} value={introduction}
        placeholder={t('introductionPlaceholder')} onChange={(event) => { setIntroduction(event.target.value) }} /></label>
      <p className={css.previewHint}>{t('portraitLocalOnly')}</p>
    </>}
    {!bot && <div className={css.skillMedia}>
      <MarketSkillArtwork metadata={{ ...metadata, skills: skillNames.map(name => ({ name })) }} label={previewTitle} />
    </div>}
    <h3>{previewTitle}</h3>
    <p>{description || t(bot ? 'summaryPlaceholder' : 'skillPreviewHint')}</p>
    <div className={css.meta}>{publisher || t('publisherPending')} · {version || t('versionPending')}</div>
    <div className={css.previewFacts}><span>{t('sourceSkillsShort')}</span><p>{skillNames.join(' / ') || t('noSelectedSkills')}</p></div>
    <p className={css.previewHint}>{t('previewBeforeUpload')}</p>
  </aside>
}
