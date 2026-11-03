/** Publication and character preview beside the author form. */
import { useRef, useState, type ReactNode } from 'react'
import { Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MarketPresetPortraitId } from '@deepseek-ai/dsh-muse-market/types'
import { findMarketPresetPortrait, marketPresetPortraits } from './market-preset-portraits.ts'
import { marketPresetPortraitUrls } from './market-preset-portrait-urls.ts'
import type { MarketSectionProps } from './MarketSection.tsx'
import { MarketCharacter, type MarketPresentation } from './MarketCharacter.tsx'
import { MarketCharacterGenerator } from './MarketCharacterGenerator.tsx'
import type { CharacterGenerationActions } from './market-character-generation.ts'
import css from './MarketSection.module.css'

/** Preview the publication portrait and optional local artwork before package preparation.
 * @param props Current author fields and localized page labels.
 * @returns Live package summary and portrait selection controls.
 */
export function MarketAuthorPreview({
  title, description, version, publisher, bot, skillNames, presetPortrait, onPresetPortraitChange, generation, reportOutcome, t,
}: {
  title: string
  description: string
  version: string
  publisher: string
  bot: boolean
  skillNames: readonly string[]
  presetPortrait: MarketPresetPortraitId | undefined
  onPresetPortraitChange: (id: MarketPresetPortraitId) => void
  t: MarketSectionProps['t']
  generation?: CharacterGenerationActions | undefined
  reportOutcome: MarketSectionProps['reportOutcome']
}): ReactNode {
  const [role, setRole] = useState(''), [introduction, setIntroduction] = useState('')
  const [media, setMedia] = useState<Pick<MarketPresentation, 'posterUrl' | 'animation' | 'characterVersion'>>({})
  const [imageError, setImageError] = useState(false)
  const selection = useRef(0)
  return <aside className={css.preview} aria-label={t('preview')}>
    <div className={css.previewHeading}><h3>{t('preview')}</h3><span className={css.badge}>{t('localPreview')}</span></div>
    {bot && <>
      <MarketCharacter presentation={{ role: role || title || t('untitledBot'),
        introduction: introduction || description || t('introductionPlaceholder'),
        posterUrl: presetPortrait && marketPresetPortraitUrls[presetPortrait], ...media }}
      introduceLabel={t('introduce')} sampleLabel={t('samplePortrait')} />
      <label className={css.field}>{t('releasePortrait')}
        <select value={presetPortrait ?? ''} onChange={(event) => {
          const choice = findMarketPresetPortrait(event.target.value)
          if (!choice) return
          ++selection.current
          setMedia({}); setImageError(false)
          onPresetPortraitChange(choice.id)
        }}>
          {marketPresetPortraits.map(row => <option key={row.id} value={row.id}>{t(`presetPortrait.${row.id}`)}</option>)}
        </select>
      </label>
      <p className={css.previewHint}>{t('preparedPortraitHint')}</p>
      <label className={css.field}>{t('role')}<Input maxLength={80} value={role}
        placeholder={t('rolePlaceholder')} onChange={(event) => { setRole(event.target.value) }} /></label>
      <label className={css.field}>{t('introduction')}<textarea maxLength={500} rows={3} value={introduction}
        placeholder={t('introductionPlaceholder')} onChange={(event) => { setIntroduction(event.target.value) }} /></label>
      <label className={css.field}>{t('portrait')}<input type="file" accept="image/png,image/jpeg,image/webp"
        onChange={(event) => {
          const current = ++selection.current
          const file = event.target.files?.[0]
          event.target.value = ''
          if (!file) return
          if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 4 * 1024 * 1024) {
            setImageError(true); return
          }
          const reader = new FileReader()
          reader.onload = () => {
            if (selection.current !== current) return
            if (typeof reader.result === 'string') { setMedia({ posterUrl: reader.result }); setImageError(false) }
          }
          reader.onerror = () => { if (selection.current === current) setImageError(true) }
          reader.readAsDataURL(file)
        }} /></label>
      {imageError && <p role="alert">{t('portraitError')}</p>}
      <p className={css.previewHint}>{t('portraitLocalOnly')}</p>
      <MarketCharacterGenerator brief={{ title, description, role: role || title, introduction: introduction || description }}
        actions={generation} appliedVersion={media.characterVersion} t={t} reportOutcome={reportOutcome} onApply={(result) => {
          ++selection.current
          setRole(result.candidate.role); setIntroduction(result.candidate.introduction)
          setMedia({ posterUrl: result.candidate.posterUrl, characterVersion: result.id, animation: result.animation })
          setImageError(false)
        }} />
    </>}
    {!bot && <div className={css.skillPreview}><span className={css.badge}>{t('skill')}</span><p>{t('skillPreviewHint')}</p></div>}
    <h3>{title || t(bot ? 'untitledBot' : 'untitledSkill')}</h3>
    <p>{description || t('summaryPlaceholder')}</p>
    <div className={css.meta}>{publisher || t('publisherPending')} · {version || t('versionPending')}</div>
    <div className={css.previewFacts}><span>{t('sourceSkillsShort')}</span><p>{skillNames.join(' / ') || t('noSelectedSkills')}</p></div>
    <p className={css.previewHint}>{t('previewBeforeUpload')}</p>
  </aside>
}
