/** Market publication metadata and usage instructions for enabled original Skills. */
import type { ReactNode } from 'react'
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MarketRelease } from '@deepseek-ai/dsh-muse-market/types'
import type { MarketSectionProps } from './MarketSection.tsx'
import css from './MarketSection.module.css'

/** Show version, usage and license information without changing installation state.
 * @param props Selected release, original Skill activation, localized labels and dismissal action.
 * @returns Accessible publication details, or a closed modal.
 */
export function MarketReleaseDetails({ release, enabledOriginalSkill, onClose, t }: {
  release: MarketRelease | undefined
  enabledOriginalSkill: boolean
  onClose: () => void
  t: MarketSectionProps['t']
}): ReactNode {
  return <Modal open={Boolean(release)} onClose={onClose} title={release?.manifest.title ?? t('details')} closeLabel={t('close')}>
    {release && <div className={css.detailBody}>
      <p>{release.manifest.description}</p>
      <dl className={css.detailFacts}>
        <dt>{t('publisher')}</dt><dd>{release.publisher}</dd>
        <dt>{t('version')}</dt><dd>{release.manifest.version}</dd>
        <dt>{t('license')}</dt><dd>{release.manifest.license}</dd>
        <dt>{t('category')}</dt><dd>{release.manifest.category}</dd>
      </dl>
      <p>{t('bytes', { bytes: (release.bytes / 1024).toFixed(1) })}</p>
      {release.manifest.requirements.length > 0 && <section><h3>{t('requirements')}</h3>
        <ul>{release.manifest.requirements.map(item => <li key={item}>{item}</li>)}</ul></section>}
      {release.manifest.examples.length > 0 && <section><h3>{t('examples')}</h3>
        <ul>{release.manifest.examples.map(item => <li key={item}>{item}</li>)}</ul></section>}
      {release.manifest.skills.length > 0 && <section><h3>{t('sourceSkillsShort')}</h3>
        <ul>{release.manifest.skills.map(item => <li key={item.name}>{enabledOriginalSkill ? t('legacySkillUsage', { skill: item.name }) : item.name}</li>)}</ul></section>}
    </div>}
  </Modal>
}
