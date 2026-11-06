/** Shared creator invitation occupying the same grid as publication cards. */
import type { ReactNode } from 'react'
import { Button, IconPlusOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MarketSectionProps } from './MarketSection.tsx'
import css from './MarketSection.module.css'
import characterCss from './MarketCharacter.module.css'

/** Open the owning page's upload form without selecting or uploading a file.
 * @param props Localized copy, pending state and upload-form navigation callback.
 * @returns Creator invitation card.
 */
export function MarketContributionCard({ t, disabled, onUpload }: {
  t: MarketSectionProps['t']
  disabled: boolean
  onUpload: () => void
}): ReactNode {
  return <article className={css.contribute}>
    <span className={css.badge}>{t('contributeTag')}</span><div className={css.contributeArt}>
      <span className={characterCss.muse} role="img" aria-label={t('brand')} /></div>
    <h3>{t('contributeTitle')}</h3><p>{t('contributeDescription')}</p>
    <Button variant="primary" disabled={disabled} icon={<IconPlusOutlineRegular size={18} />} onClick={onUpload}>{t('uploadEntry')}</Button>
    <p className={css.meta}>{t('contributeHint')}</p>
  </article>
}
