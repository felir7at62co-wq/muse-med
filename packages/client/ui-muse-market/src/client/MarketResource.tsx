/** Shared resource cards, details and publication filters for Desktop and the website. */
import type { Dispatch, ReactNode, SetStateAction } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MarketPublication, MarketTranslate } from './market-actions.ts'
import type { MarketSkillArtworkMetadata } from './market-skill-artwork.ts'
import { SkillPortrait } from './SkillPortrait.tsx'
import { nextMarketListingCount } from './market-listing.ts'
import css from './MarketSection.module.css'
import mascotUrl from './assets/muse-purple-spider.png'

/** Render the shared discovery viewport and market header.
 * @param props - Carrier, card pagination, localized header content and page body.
 * @returns The market scroll viewport with consistent branding and automatic pagination.
 */
export function MarketLayout({ carrier, total, setShownCount, t, navigation, actions, children }: {
  readonly carrier: 'desktop' | 'web'
  readonly total: number
  readonly setShownCount: Dispatch<SetStateAction<number>>
  readonly t: MarketTranslate
  readonly navigation: ReactNode
  readonly actions: ReactNode
  readonly children: ReactNode
}): ReactNode {
  return <div className={css.page} data-muse-skill-market data-market-carrier={carrier === 'web' ? 'web' : undefined}
    onScroll={({ currentTarget }) => {
      const { scrollHeight, scrollTop, clientHeight } = currentTarget
      setShownCount(count => nextMarketListingCount({ scrollHeight, scrollTop, clientHeight }, count, total))
    }}>
    <section className={css.section}><header className={css.masthead}>
      <div className={css.brand}><img src={mascotUrl} alt="" /><span>{t('brand')}</span></div>
      {navigation}<div className={css.actions}>{actions}</div>
    </header>{children}</section>
  </div>
}

/** An explicit card or details action owned by its transport-specific page. */
export interface MarketResourceAction {
  readonly id: string
  readonly label: string
  readonly onSelect: () => void
  readonly disabled?: boolean
  readonly variant?: 'primary' | 'outline' | 'ghost'
}

/** Publication information displayed without local installation assumptions. */
export interface MarketResourceDetail extends MarketSkillArtworkMetadata {
  readonly version: string
  readonly license?: string
  readonly publisher?: string
  readonly requirements: readonly string[]
  readonly examples: readonly string[]
  readonly skills: readonly { readonly name: string }[]
  readonly requiredSkills?: readonly string[]
  readonly validation?: string
  readonly sha256: string
  readonly bytes: number
}

/** Render localized actions without moving transport behavior into display components. */
function ResourceActions({ actions }: { readonly actions: readonly MarketResourceAction[] }): ReactNode {
  return <div className={css.cardActions}>{actions.map(action => <Button key={action.id}
    variant={action.variant ?? 'ghost'} disabled={action.disabled ?? false} onClick={action.onSelect}>{action.label}</Button>)}</div>
}

/** Render one role card with carrier-owned actions.
 * @param props - Shared metadata, source identity, publisher and localized action labels.
 * @returns A resource card with the same portrait and framing in both clients.
 */
export function MarketResourceCard({ metadata, publisher, source, status, note, command, actions, t }: {
  readonly metadata: MarketSkillArtworkMetadata & { readonly version: string }
  readonly publisher: string
  readonly source: { readonly kind: 'publication' | 'legacy' | 'local'; readonly id: string }
  readonly status?: MarketPublication['status']
  readonly note?: string
  readonly command?: string
  readonly actions: readonly MarketResourceAction[]
  readonly t: MarketTranslate
}): ReactNode {
  return <article className={css.card} data-market-publication={source.kind === 'publication' ? source.id : undefined}
    data-market-legacy={source.kind === 'legacy' ? source.id : undefined} data-market-local={source.kind === 'local' ? source.id : undefined}>
    <div className={css.cardMeta}><span className={css.badge}>{t('skillBadge')}</span>
      <span>{status ? t(`publication.${status}`) : metadata.category}</span></div>
    <SkillPortrait metadata={metadata} introductionLabel={t('meetSkill')} closeLabel={t('close')} />
    <h2>{metadata.title}</h2><p className={css.cardSummary}>{metadata.description}</p>
    {command && <p className={css.secondary}><code>{command}</code></p>}
    <p className={css.publisherLine}>{publisher} · {metadata.version}</p>
    {note && <p>{note}</p>}
    <ResourceActions actions={actions} />
  </article>
}

/** Render publication facts and explicit carrier-specific actions in the shared dialog.
 * @param props - Selected metadata, close/navigation callbacks and localized labels.
 * @returns A closed dialog or the selected resource without inferring installation state.
 */
export function MarketResourceDetails({ detail, actions, onClose, onFindSkill, t }: {
  readonly detail: MarketResourceDetail | undefined
  readonly actions: readonly MarketResourceAction[]
  readonly onClose: () => void
  readonly onFindSkill: (name: string) => void
  readonly t: MarketTranslate
}): ReactNode {
  return <Modal open={Boolean(detail)} title={detail?.title ?? t('details')} closeLabel={t('close')}
    className={css.detailDialog} contentClassName={css.detailContent} onClose={onClose}
    footer={detail && <ResourceActions actions={actions} />}>
    {detail && <div className={css.detailBody}>
      <div className={css.detailHero}><SkillPortrait metadata={detail} />
        <div><span className={css.badge}>{detail.category}</span><h2>{detail.title}</h2><p>{detail.description}</p></div></div>
      <dl className={css.detailFacts}><dt>{t('field.version')}</dt><dd>{detail.version}</dd>
        {detail.license && <><dt>{t('field.license')}</dt><dd>{detail.license}</dd></>}
        {detail.publisher && <><dt>{t('publisher')}</dt><dd>{detail.publisher}</dd></>}
        <dt>{t('packageSize')}</dt><dd>{detail.bytes.toLocaleString()} {t('bytes')}</dd></dl>
      <section><h3>{t('containedSkills')}</h3><ul>{detail.skills.map(skill => <li key={skill.name}>{skill.name}</li>)}</ul></section>
      {Boolean(detail.requiredSkills?.length) && <section><h3>{t('requiredSkills')}</h3>
        <ul>{detail.requiredSkills?.map(name => <li key={name}><Button variant="ghost"
          onClick={() => { onFindSkill(name) }}>{name}</Button></li>)}</ul><p>{t('requiredSkillsHint')}</p></section>}
      {detail.validation && <section><h3>{t('validation')}</h3><p>{detail.validation}</p></section>}
      <section><h3>{t('field.requirements')}</h3>{detail.requirements.length
        ? <ul>{detail.requirements.map(text => <li key={text}>{text}</li>)}</ul> : <p>{t('noRequirements')}</p>}</section>
      {detail.examples.length > 0 && <section><h3>{t('field.examples')}</h3>
        <ul>{detail.examples.map(text => <li key={text}>{text}</li>)}</ul></section>}
      <details><summary>{t('packageVerification')}</summary><code>{detail.sha256}</code></details>
    </div>}
  </Modal>
}

/** Selected publication lifecycle status, or every visible status. */
export type MarketPublicationFilterValue = MarketPublication['status'] | ''

/** Render the same publication-status filters for every market carrier.
 * @param props - Current status, explicit selection callback and localized labels.
 * @returns A single-choice group without fetching or changing publications.
 */
export function MarketPublicationFilter({ value, onChange, t }: {
  readonly value: MarketPublicationFilterValue
  readonly onChange: (value: MarketPublicationFilterValue) => void
  readonly t: MarketTranslate
}): ReactNode {
  return <div className={css.filters} role="group" aria-label={t('publicationFilter')}>
    {(['', 'draft', 'pending', 'published', 'rejected', 'withdrawn'] as const).map(status => <Button key={status} size="sm"
      aria-pressed={value === status} variant={value === status ? 'outline' : 'ghost'}
      onClick={() => { onChange(status) }}>{t(status ? `publication.${status}` : 'allPublications')}</Button>)}
  </div>
}
