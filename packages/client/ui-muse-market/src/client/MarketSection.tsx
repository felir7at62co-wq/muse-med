/** Skill-only discovery, exact-version installation and defaults for future Sessions. */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Button, Input, Modal, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { MarketDefaultSnapshot, MarketInjected, MarketInstallation, MarketPublication } from './market-actions.ts'
import { archiveBase64, defaultFor, downloadMarketFile, marketFailureOutcome } from './market-actions.ts'
import { MarketCreatorPage } from './MarketCreatorPage.tsx'
import { MarketPublications } from './MarketPublications.tsx'
import type { createMarketViewStore } from './market-view-store.ts'
import css from './MarketSection.module.css'

export type MarketPageProps = PropsRuntime<'main'> & PropsLocale<'settings.museMarket'> & InjectFace<MarketInjected> & PropsStore<ReturnType<typeof createMarketViewStore>>

type Tab = 'discover' | 'installed' | 'publish'
type Detail = Pick<MarketInstallation['release'], 'manifest' | 'sha256' | 'bytes'> & { readonly accessRevision?: number }
type Selection = { item: MarketInstallation; expected: MarketInstallation['release']['id'] | null; disable: boolean }

/** Keep installation separate from a confirmed, compare-and-swap default change. */
export function MarketPage({
  operations: actions, reportOutcome, isCurrentAccess, useAccess, useStore, actions: view, t,
}: MarketPageProps): ReactNode {
  const draft = useStore(state => state.creator)
  const [tab, setTab] = useState<Tab>('discover')
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('')
  const [items, setItems] = useState<MarketPublication[]>([])
  const [itemsAccessRevision, setItemsAccessRevision] = useState(0)
  const [installed, setInstalled] = useState<MarketInstallation[]>([])
  const [defaults, setDefaults] = useState<MarketDefaultSnapshot>({ revision: 0, defaults: [] })
  const access = useAccess(value => value)
  const identity = access.identity
  const [sources, setSources] = useState<Awaited<ReturnType<typeof actions.sources>>>()
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading')
  const [busy, setBusy] = useState(false)
  const [detail, setDetail] = useState<Detail>()
  const [selection, setSelection] = useState<Selection>()
  const alive = useRef(false), generation = useRef(0)
  const read = async (target: Tab): Promise<void> => {
    const token = ++generation.current, accessRevision = access.revision
    const current = () => alive.current && token === generation.current && isCurrentAccess(accessRevision)
    setPhase('loading')
    try {
      const [local, active] = await Promise.all([actions.installed(), actions.defaults()])
      if (!current()) return
      setInstalled(local); setDefaults(active); setPhase('ready')
      if (target === 'installed') return
      void actions.sources().then((found) => { if (current()) setSources(found) }, () => undefined)
      const [cloud, _account] = await Promise.allSettled([
        actions.catalog(target === 'discover' ? query : '', target === 'publish'), actions.identity(),
      ])
      if (!current()) return
      if (cloud.status === 'fulfilled') { setItems(cloud.value); setItemsAccessRevision(accessRevision) }
      setPhase(cloud.status === 'fulfilled' ? 'ready' : 'error')
    } catch (_error) {
      if (alive.current && token === generation.current) { setPhase('error') }
    }
  }
  useEffect(() => {
    alive.current = true; setItems(previous => previous.filter(item => item.status === 'published')); void read(tab)
    return () => { alive.current = false; ++generation.current }
  }, [actions, access.revision, access.inventoryRevision])
  const accept = (item: MarketInstallation): void => {
    setInstalled(previous => [...previous.filter(row => row.release.id !== item.release.id), item])
  }
  const run = async (operation: () => Promise<void>, success: Parameters<typeof reportOutcome>[0] = 'done'): Promise<void> => {
    if (busy) return
    setBusy(true); ++generation.current
    try { await operation(); reportOutcome(success, false) }
    catch (error) {
      const outcome = marketFailureOutcome(error)
      if (outcome === 'defaultConflict') {
        const fresh = await actions.defaults().catch(() => undefined)
        if (alive.current && fresh) { setDefaults(fresh); setSelection(undefined) }
      }
      reportOutcome(outcome, true)
    }
    finally { if (alive.current) setBusy(false) }
  }
  const changeDefault = async ({ item, expected, disable }: Selection): Promise<void> => {
    await run(async () => {
      const skillName = item.release.manifest.skills[0]?.name
      if (skillName === undefined) { reportOutcome('invalidPackage', true); return }
      const confirmed = await actions.setDefault({ skillName,
        expected, target: disable ? null : item.release.id })
      if (alive.current) { setDefaults(confirmed); setSelection(undefined) }
    }, 'defaultDone')
  }
  const choose = (item: MarketInstallation, disable: boolean): void => {
    setSelection({ item, disable, expected: defaultFor(item, defaults)?.releaseId ?? null })
  }
  const replacePublication = (item: MarketPublication): void => {
    if (alive.current) setItems(previous => previous.map(row => row.id === item.id ? item : row))
  }
  const authorizedItems = items.filter(item => item.status === 'published' || itemsAccessRevision === access.revision)
  const shownDetail = detail?.accessRevision !== undefined && detail.accessRevision !== access.revision ? undefined : detail
  const visible = authorizedItems.filter(item => !category || item.manifest.category === category)
  const categories = [...new Set(authorizedItems.map(item => item.manifest.category))]
  return <div className={css.page} data-muse-skill-market><section className={css.section}>
    <header><h1>{t('nav')}</h1><p>{t('description')}</p></header>
    <div className={css.toolbar} role="tablist" aria-label={t('nav')}>
      {(['discover', 'installed', 'publish'] as const).map(value => <Button key={value} role="tab" aria-selected={tab === value}
        disabled={busy} variant={tab === value ? 'outline' : 'ghost'} onClick={() => { setTab(value); setCategory(''); void read(value) }}>{t(value)}</Button>)}
      <Button disabled={busy || phase === 'loading'} onClick={() => { void read(tab) }}>{t('refresh')}</Button>
    </div>
    {tab === 'discover' && <><form className={css.toolbar} onSubmit={(event) => { event.preventDefault(); void read(tab) }}>
      <Input className={css.query} type="search" aria-label={t('query')} value={query} disabled={busy || phase === 'loading'}
        onChange={(event) => { setQuery(event.target.value) }} /><Button type="submit" disabled={busy || phase === 'loading'}>{t('search')}</Button>
    </form><div className={css.actions} role="group" aria-label={t('category')}>
      {['', ...categories].map(value => <Button key={value} size="sm" aria-pressed={category === value}
        variant={category === value ? 'outline' : 'ghost'} onClick={() => { setCategory(value) }}>{value || t('allCategories')}</Button>)}
    </div></>}
    {tab === 'installed' && <><p>{t('defaultsHint')}</p><label className={css.field}>{t('import')}
      <input type="file" accept=".zip,application/zip" disabled={busy} onChange={(event) => {
        const file = event.target.files?.[0]; event.target.value = ''
        if (file) void run(async () => { const item = await actions.importPackage(await archiveBase64(file)); if (alive.current) accept(item) }, 'installedDone')
      }} /></label></>}
    {phase === 'error' && <div className={css.notice}><p role="alert">{t('readFailedRetained')}</p>
      <Button disabled={busy} onClick={() => { void read(tab) }}>{t('retry')}</Button></div>}
    {phase === 'loading' && <div role="status" aria-label={t('loading')} className={css.skeletons}><StateDot state="ongoing" /></div>}
    {tab === 'discover' && <div className={css.grid}>{visible.map((item) => {
      const local = installed.find(row => row.release.id === item.sha256)
      const skillName = item.manifest.skills[0]?.name
      const prior = defaults.defaults.find(row => row.skillName === skillName)
      return <article key={item.id} className={css.card} data-market-publication={item.id}>
        <h2>{item.manifest.title}</h2><p>{item.manifest.description}</p><p>{item.publisher} · {item.manifest.version}</p>
        <div className={css.actions}><Button variant="outline" onClick={() => { setDetail(item) }}>{t('details')}</Button>
          {local ? <Button disabled={busy || prior?.releaseId === local.release.id} onClick={() => { choose(local, false) }}>{t(prior?.releaseId === local.release.id ? 'default' : 'useVersion')}</Button>
            : <Button disabled={busy || phase !== 'ready'} onClick={() => { void run(async () => {
              const result = await actions.installPublication(item.id, item.sha256)
              if (alive.current) accept(result.installation)
            }, 'installedDone') }}>{t(prior && prior.releaseId !== item.sha256 ? 'installUpdate' : 'install')}</Button>}
        </div>
      </article>
    })}</div>}
    {tab === 'installed' && <div className={css.grid}>{installed.map((item) => {
      const active = defaultFor(item, defaults)?.releaseId === item.release.id
      return <article key={item.release.id} className={css.card} data-market-local={item.release.id}>
        <h2>{item.release.manifest.title}</h2><p>{item.release.manifest.version} · {t(active ? 'default' : 'stored')}</p>
        <div className={css.actions}><Button variant="outline" onClick={() => { setDetail(item.release) }}>{t('details')}</Button>
          <Button disabled={busy} onClick={() => { choose(item, active) }}>{t(active ? 'disable' : 'useVersion')}</Button>
          <Button disabled={busy} onClick={() => { void run(async () => { downloadMarketFile(await actions.exportPackage(item.release.id)) }) }}>{t('export')}</Button>
          <Button disabled={busy || active} onClick={() => { void run(async () => {
            await actions.removePackage(item.release.id)
            if (alive.current) setInstalled(previous => previous.filter(row => row.release.id !== item.release.id))
          }) }}>{t('remove')}</Button></div>
      </article>
    })}</div>}
    {tab === 'publish' && sources && <>
      <MarketCreatorPage actions={actions} draft={draft} setDraft={view.setCreator} prepared={view.prepared}
        completeUpload={view.completeUpload} discardUpload={view.discardUpload} sources={sources}
        identity={identity} installed={installed} t={t} reportOutcome={reportOutcome}
        onPrepared={accept} onPublished={() => { void read('publish') }} />
      {identity && <MarketPublications accessRevision={access.revision} isCurrentAccess={isCurrentAccess}
        items={authorizedItems} identity={identity} actions={actions} busy={busy} t={t} reportOutcome={reportOutcome}
        onReplace={replacePublication}
        onDetails={(item) => { setDetail({ ...item, accessRevision: access.revision }) }}
        onInstall={(item) => { void run(async () => {
          const result = await actions.installPublication(item.id, item.sha256)
          if (alive.current) accept(result.installation)
        }, 'installedDone') }} />}
    </>}
    {phase === 'ready' && (tab === 'discover' ? visible.length === 0 : tab === 'installed' && installed.length === 0) && <p>{t('empty')}</p>}
    <Modal open={Boolean(shownDetail)} title={shownDetail?.manifest.title ?? t('details')} closeLabel={t('close')}
      onClose={() => { setDetail(undefined) }}>
      {shownDetail && <div className={css.form}><p>{shownDetail.manifest.description}</p>
        <p>{shownDetail.manifest.version} · {shownDetail.manifest.license}</p>
        <h3>{t('field.requirements')}</h3><ul>{shownDetail.manifest.requirements.map(text => <li key={text}>{text}</li>)}</ul>
        <h3>{t('field.examples')}</h3><ul>{shownDetail.manifest.examples.map(text => <li key={text}>{text}</li>)}</ul>
        <code>{shownDetail.sha256}</code><p>{shownDetail.bytes.toLocaleString()} {t('bytes')}</p>
      </div>}
    </Modal>
    <Modal open={Boolean(selection)} title={t(selection?.disable ? 'disable' : 'useVersion')} closeLabel={t('close')}
      onClose={() => { if (!busy) setSelection(undefined) }}>
      {selection && <div className={css.form}><p>{selection.item.release.manifest.title} · {selection.item.release.manifest.version}</p>
        <p>{t('defaultsHint')}</p><Button variant="primary" disabled={busy} onClick={() => { void changeDefault(selection) }}>{t('confirm')}</Button></div>}
    </Modal>
  </section></div>
}
