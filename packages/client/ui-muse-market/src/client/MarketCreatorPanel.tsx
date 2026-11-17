/** Dedicated authoring entry with independent local-source, inventory and account reads. */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Button, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { MarketActions, MarketInjected, MarketInstallation } from './market-actions.ts'
import type { createMarketViewStore } from './market-view-store.ts'
import { MarketCreatorPage } from './MarketCreatorPage.tsx'
import css from './MarketSection.module.css'
import creatorCss from './MarketCreatorPage.module.css'
import panelCss from './MarketCreatorPanel.module.css'

type Props = PropsRuntime<'main'> & PropsLocale<'settings.museMarket'> & InjectFace<MarketInjected>
  & PropsStore<ReturnType<typeof createMarketViewStore>>
type ReadKind = 'sources' | 'installed' | 'identity'
type ReadPhase = 'loading' | 'ready' | 'error'
const noSources: Awaited<ReturnType<MarketActions['sources']>> = { skills: [], complete: false }

/** Keep ZIP import and package export available when publishing or source reads fail.
 * @param props - Framework store, access hooks, navigation and real market operations.
 * @returns Dedicated creator page with independently recoverable data reads.
 */
export function MarketCreatorPanel({
  operations, reportOutcome, isCurrentAccess, useAccess, useStore, actions, onBackMarket, onOpenPublications, t,
}: Props): ReactNode {
  const draft = useStore(state => state.creator), mode = useStore(state => state.creatorMode)
  const access = useAccess(state => state)
  const [sources, setSources] = useState(noSources)
  const [installed, setInstalled] = useState<MarketInstallation[]>([])
  const [phases, setPhases] = useState<Record<ReadKind, ReadPhase>>({ sources: 'loading', installed: 'loading', identity: 'loading' })
  const alive = useRef(false), epoch = useRef(0)
  const requests = useRef({ sources: 0, installed: 0, identity: 0 })
  const read = async (kind: ReadKind): Promise<void> => {
    const generation = epoch.current, request = ++requests.current[kind], revision = access.revision
    const current = (): boolean => alive.current && epoch.current === generation
      && requests.current[kind] === request && isCurrentAccess(revision)
    setPhases(previous => ({ ...previous, [kind]: 'loading' }))
    try {
      if (kind === 'sources') {
        const result = await operations.sources()
        if (current()) setSources(result)
      } else if (kind === 'installed') {
        const result = await operations.installed()
        if (current()) setInstalled(result)
      } else {
        await operations.identity()
      }
      if (current()) setPhases(previous => ({ ...previous, [kind]: 'ready' }))
    } catch (_error) {
      if (current()) setPhases(previous => ({ ...previous, [kind]: 'error' }))
    }
  }
  useEffect(() => {
    alive.current = true; ++epoch.current
    for (const kind of ['sources', 'installed', 'identity'] as const) void read(kind)
    return () => { alive.current = false; ++epoch.current }
  }, [operations, access.revision, access.inventoryRevision])
  const accept = (item: MarketInstallation): void => {
    if (!alive.current) return
    ++requests.current.installed
    setInstalled(previous => [...previous.filter(row => row.release.id !== item.release.id), item])
    setPhases(previous => ({ ...previous, installed: 'ready' }))
  }
  const copy = {
    sources: ['creatorSourcesFailed', 'creatorRetrySources'],
    installed: ['creatorInstalledFailed', 'creatorRetryInstalled'],
    identity: ['creatorIdentityFailed', 'creatorRetryIdentity'],
  } as const
  return <div className={css.page}><section className={css.section}>
    <header className={creatorCss.header}>
      <div className={css.actions}><Button variant="ghost" onClick={onBackMarket}>{t('creatorBack')}</Button><Button variant="ghost" disabled={Object.values(phases).some(phase => phase === 'loading')} onClick={() => { for (const kind of ['sources', 'installed', 'identity'] as const) void read(kind) }}>{t('refresh')}</Button></div>
      <h1 className={panelCss.title}>{t('creatorTitle')}</h1><p>{t('creatorDescription')}</p>
    </header>
    {Object.values(phases).some(phase => phase === 'loading') && <div role="status" aria-label={t('loading')}>
      <StateDot state="ongoing" />
    </div>}
    {(['sources', 'installed', 'identity'] as const).map(kind => phases[kind] === 'error'
      ? <div key={kind} className={css.notice}><p role="alert">{t(copy[kind][0])}</p>
        <Button variant="outline" onClick={() => { void read(kind) }}>{t(copy[kind][1])}</Button></div> : null)}
    {phases.sources === 'ready' && sources.skills.length === 0 && <p>{t('creatorNoSkills')}</p>}
    <MarketCreatorPage initialMode={mode} showHeader={false} actions={operations} draft={draft}
      setDraft={actions.setCreator} prepared={actions.prepared} completeUpload={actions.completeUpload}
      discardUpload={actions.discardUpload} sources={sources} identity={access.identity}
      installed={installed} t={t} reportOutcome={reportOutcome} onPrepared={accept}
      onPublished={onOpenPublications} />
  </section></div>
}
