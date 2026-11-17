/** Skill-only discovery, exact-version installation and defaults for future Sessions. */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Button, Input, Modal, StateDot, IconPlusOutlineRegular, IconSearchOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { MarketDefaultSnapshot, MarketInjected, MarketInstallation, MarketLegacyResource, MarketPublication } from './market-actions.ts'
import { archiveBase64, defaultFor, downloadMarketFile, marketFailureOutcome } from './market-actions.ts'
import { MarketPublications } from './MarketPublications.tsx'
import { MarketGuide, rememberMarketGuide, shouldShowMarketGuide } from './MarketGuide.tsx'
import { MarketLayout, MarketPublicationFilter, MarketResourceCard, MarketResourceDetails,
  type MarketResourceAction, type MarketResourceDetail } from './MarketResource.tsx'
import { installMarketListing, listingInstallation, marketListings, type MarketListing } from './market-listing.ts'
import type { createMarketViewStore } from './market-view-store.ts'
import css from './MarketSection.module.css'
import contributionUrl from './assets/storyboard-skill-kit.png'

export type MarketPageProps = PropsRuntime<'main'> & PropsLocale<'settings.museMarket'> & InjectFace<MarketInjected> & PropsStore<ReturnType<typeof createMarketViewStore>>

type Tab = 'discover' | 'installed' | 'publish'
type Detail = MarketResourceDetail & {
  readonly accessRevision?: number
  readonly listing?: MarketListing
  readonly localId?: MarketInstallation['release']['id']
}
type ReadPhase = 'loading' | 'ready' | 'error'
type Selection = { item: MarketInstallation; expected: MarketInstallation['release']['id'] | null; disable: boolean }
const detailFor = (item: Pick<MarketInstallation['release'], 'manifest' | 'sha256' | 'bytes'>): Detail => ({ ...item.manifest, sha256: item.sha256, bytes: item.bytes })

/** Keep installation separate from a confirmed, compare-and-swap default change. */
export function MarketPage({
  operations: actions, reportOutcome, isCurrentAccess, useAccess, useStore, actions: view, onOpenCreator, t,
}: MarketPageProps): ReactNode {
  const tab = useStore(state => state.marketTab)
  const setTab = view.setMarketTab
  const [guide, setGuide] = useState(shouldShowMarketGuide)
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('')
  const [items, setItems] = useState<MarketPublication[]>([])
  const [legacy, setLegacy] = useState<MarketLegacyResource[]>([])
  const [publishedPhase, setPublishedPhase] = useState<ReadPhase>('loading')
  const [legacyPhase, setLegacyPhase] = useState<ReadPhase>('loading')
  const [shownCount, setShownCount] = useState(12)
  const [confirmed, setConfirmed] = useState<Readonly<Record<string, MarketInstallation['release']['id']>>>({})
  const [itemsAccessRevision, setItemsAccessRevision] = useState(0)
  const [installed, setInstalled] = useState<MarketInstallation[]>([])
  const [defaults, setDefaults] = useState<MarketDefaultSnapshot>({ revision: 0, defaults: [] })
  const access = useAccess(value => value)
  const identity = access.identity
  const [identityError, setIdentityError] = useState<Parameters<typeof reportOutcome>[0]>()
  const [publicationStatus, setPublicationStatus] = useState<MarketPublication['status'] | ''>('')
  const [installedQuery, setInstalledQuery] = useState('')
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading')
  const [busy, setBusy] = useState(false)
  const [detail, setDetail] = useState<Detail>()
  const [selection, setSelection] = useState<Selection>()
  const alive = useRef(false), generation = useRef(0)
  const requests = useRef({ local: 0, identity: 0, publication: 0, legacy: 0 })
  const read = async (target: Tab, only?: 'publication' | 'legacy', searchText = query): Promise<void> => {
    const token = only === undefined ? ++generation.current : generation.current, accessRevision = access.revision
    const current = () => alive.current && token === generation.current && isCurrentAccess(accessRevision)
    setPhase('loading')
    const localRequest = ++requests.current.local
    const pending: Promise<void>[] = [Promise.allSettled([
      Promise.resolve().then(() => actions.installed()), Promise.resolve().then(() => actions.defaults()),
    ]).then(([local, active]) => {
      if (!current() || localRequest !== requests.current.local) return
      if (local.status === 'fulfilled') setInstalled(local.value)
      if (active.status === 'fulfilled') setDefaults(active.value)
      setPhase(local.status === 'fulfilled' && active.status === 'fulfilled' ? 'ready' : 'error')
    })]
    if (target === 'installed') { await Promise.all(pending); return }
    setIdentityError(undefined)
    const identityRequest = ++requests.current.identity
    void Promise.resolve().then(() => actions.identity()).catch((error: unknown) => {
      if (current() && identityRequest === requests.current.identity) setIdentityError(marketFailureOutcome(error))
    })
    if (only !== 'legacy') {
      const request = ++requests.current.publication
      const accepts = () => current() && request === requests.current.publication
      setPublishedPhase('loading')
      pending.push(Promise.resolve().then(() => actions.catalog(target === 'discover' ? searchText : '', target === 'publish')).then((cloud) => {
        if (accepts()) { setItems(cloud); setItemsAccessRevision(accessRevision); setPublishedPhase('ready') }
      }, () => { if (accepts()) setPublishedPhase('error') }))
    }
    if (target === 'discover' && only !== 'publication') {
      const request = ++requests.current.legacy
      const accepts = () => current() && request === requests.current.legacy
      setLegacyPhase('loading')
      pending.push(Promise.resolve().then(() => actions.legacyCatalog(searchText)).then((originals) => {
        if (accepts()) { setLegacy(originals); setLegacyPhase('ready') }
      }, () => { if (accepts()) setLegacyPhase('error') }))
    }
    await Promise.all(pending)
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
    finally {
      if (alive.current) {
        setBusy(false)
        if (tab !== 'installed' && (publishedPhase === 'loading' || tab === 'discover' && legacyPhase === 'loading')) void read(tab)
      }
    }
  }
  const changeDefault = async ({ item, expected, disable }: Selection): Promise<void> => {
    await run(async () => {
      const skillName = item.release.manifest.skills[0]?.name
      if (skillName === undefined) throw Object.assign(new Error('Missing Skill invocation'), { details: { code: 'invalid-skill' } })
      const confirmed = await actions.setDefault({ skillName,
        expected, target: disable ? null : item.release.id })
      if (alive.current) { setDefaults(confirmed); setSelection(undefined) }
    }, 'defaultDone')
  }
  const choose = (item: MarketInstallation, disable: boolean): void => {
    setSelection({ item, disable, expected: defaultFor(item, defaults)?.releaseId ?? null })
  }
  const switchTab = (target: Tab): void => { setTab(target); setCategory(''); setShownCount(12); void read(target) }
  const replacePublication = (item: MarketPublication): void => {
    if (alive.current) setItems(previous => previous.map(row => row.id === item.id ? item : row))
  }
  const authorizedItems = items.filter(item => item.status === 'published' || itemsAccessRevision === access.revision)
  const shownDetail = detail?.accessRevision !== undefined && detail.accessRevision !== access.revision ? undefined : detail
  const allListings = marketListings(authorizedItems, legacy, query)
  const visible = allListings.filter(item => !category || item.category === category)
  const categories = [...new Set(allListings.map(item => item.category))]
  const detailLocal = shownDetail?.listing ? listingInstallation(shownDetail.listing, installed, confirmed)
    : installed.find(item => item.release.id === shownDetail?.localId)
  const detailActive = detailLocal && defaultFor(detailLocal, defaults)?.releaseId === detailLocal.release.id
  const detailListing = shownDetail?.listing
  const detailActions: MarketResourceAction[] = detailLocal ? [
    { id: 'activate', label: t(detailActive ? 'disable' : 'useVersion'), variant: 'primary', disabled: busy,
      onSelect: () => { setDetail(undefined); choose(detailLocal, Boolean(detailActive)) } },
    { id: 'export', label: t('export'), disabled: busy,
      onSelect: () => { void run(async () => { downloadMarketFile(await actions.exportPackage(detailLocal.release.id)) }) } },
  ] : detailListing ? [{ id: 'install', label: t('install'), variant: 'primary', disabled: busy,
    onSelect: () => {
      void run(async () => {
        const item = await installMarketListing(actions, detailListing)
        if (alive.current) { accept(item); setConfirmed(previous => ({ ...previous, [detailListing.key]: item.release.id })) }
      }, 'installedDone')
    } }] : []
  const filteredInstalled = installed.filter(item => [item.release.manifest.name, item.release.manifest.title, item.release.manifest.description, item.release.manifest.version, ...item.release.manifest.skills.map(skill => skill.name)].join(' ').toLowerCase().includes(installedQuery.trim().toLowerCase()))
  const loading = tab === 'installed' ? phase === 'loading'
    : publishedPhase === 'loading' || tab === 'discover' && legacyPhase === 'loading'
  return <MarketLayout carrier="desktop" total={visible.length} setShownCount={setShownCount} t={t}
    navigation={<nav className={css.navigation} role="tablist" aria-label={t('nav')}>
      {(['discover', 'installed', 'publish'] as const).map(value => <Button key={value} role="tab" aria-selected={tab === value}
        className={css.navButton} disabled={busy} variant="ghost" onClick={() => { switchTab(value) }}>{t(value)}</Button>)}
    </nav>}
    actions={<><Button variant="outline" disabled={busy} onClick={() => { onOpenCreator('skill') }}>{t('creatorNewSkill')}</Button>
      <Button variant="ghost" aria-haspopup="dialog" onClick={() => { setGuide(true) }}>{t('guideEntry')}</Button>
      <Button variant="primary" icon={<IconPlusOutlineRegular size={18} />} disabled={busy} onClick={() => { onOpenCreator('upload') }}>{t('creatorUploadZip')}</Button></>}>
    <div className={css.hero}><div className={css.heroCopy}>
      <p className={css.eyebrow}>{t(tab === 'discover' ? 'discoverEyebrow' : tab === 'installed' ? 'installedEyebrow' : 'creatorEyebrow')}</p>
      <h1>{t(tab === 'discover' ? 'discoverTitle' : tab === 'installed' ? 'installedTitle' : 'myPublications')}</h1>
      <p>{t(tab === 'discover' ? 'discoverDescription' : tab === 'installed' ? 'installedDescription' : 'publicationsDescription')}</p>
    </div>
    {tab === 'discover' && <form className={css.search} onSubmit={(event) => { event.preventDefault(); void read(tab) }}>
      <Input className={css.query} icon={<IconSearchOutlineRegular size={18} />} placeholder={t('query')} type="search" aria-label={t('query')} value={query} disabled={busy}
        onChange={(event) => { setQuery(event.target.value); setShownCount(12) }} /><Button variant="outline" type="submit" disabled={busy}>{t('search')}</Button>
    </form>}</div>
    <div className={css.discoveryBar}>{tab === 'discover' ? <div className={css.filters} role="group" aria-label={t('category')}>
      {['', ...categories].map(value => <Button key={value} size="sm" aria-pressed={category === value}
        variant={category === value ? 'outline' : 'ghost'} onClick={() => { setCategory(value); setShownCount(12) }}>{value || t('allCategories')}</Button>)}
    </div> : <span>{t(tab === 'installed' ? 'installed' : 'publish')}</span>}
    <div className={css.actions}>{loading && <span role="status" aria-label={t('loading')}><StateDot state="ongoing" /></span>}
      <Button variant="ghost" size="sm" disabled={busy} onClick={() => { void read(tab) }}>{t('refresh')}</Button></div></div>
    {tab === 'installed' && <><Input className={css.query} type="search" aria-label={t('installedSearch')} placeholder={t('installedSearch')} value={installedQuery} onChange={(event) => { setInstalledQuery(event.target.value) }} /><p>{t('defaultsHint')}</p><label className={css.importControl}><span>{t('import')}</span>
      <input className={css.fileInput} type="file" accept=".zip,application/zip" disabled={busy} onChange={(event) => {
        const file = event.target.files?.[0]; event.target.value = ''
        if (file) void run(async () => { const item = await actions.importPackage(await archiveBase64(file)); if (alive.current) accept(item) }, 'installedDone')
      }} /></label></>}
    {phase === 'error' && <div className={css.notice}><p role="alert">{t('readFailedRetained')}</p>
      <Button disabled={busy} onClick={() => { void read(tab) }}>{t('retry')}</Button></div>}
    {tab !== 'installed' && publishedPhase === 'error' && <div className={css.notice}><p role="alert">{t('publishedReadFailed')}</p>
      <Button disabled={busy} onClick={() => { void read(tab, 'publication') }}>{t('retryPublished')}</Button></div>}
    {tab === 'discover' && legacyPhase === 'error' && <div className={css.notice}><p role="alert">{t('originalReadFailed')}</p>
      <Button disabled={busy} onClick={() => { void read(tab, 'legacy') }}>{t('retryOriginal')}</Button></div>}
    {loading && tab === 'discover' && visible.length === 0 && <div className={css.skeletons} aria-hidden="true">
      {[0, 1, 2].map(key => <div key={key} className={css.skeletonCard}><span /><span /><span /></div>)}
    </div>}
    {tab === 'discover' && <div className={css.grid}>{visible.slice(0, shownCount).map((item) => {
      const local = listingInstallation(item, installed, confirmed)
      const skillName = item.source === 'publication' ? item.publication.manifest.skills[0]?.name : item.name
      const prior = defaults.defaults.find(row => row.skillName === skillName)
      return <MarketResourceCard key={item.key} metadata={item} t={t}
        source={{ kind: item.source, id: item.source === 'publication' ? item.publication.id : item.resource.id }}
        publisher={item.source === 'publication' ? item.publication.publisher : t('originalResources')}
        actions={[{ id: 'details', label: t('details'), variant: 'outline', onSelect: () => {
          setDetail(item.source === 'publication' ? { ...detailFor(item.publication), publisher: item.publication.publisher, listing: item }
            : { ...item, skills: [{ name: item.name }], requiredSkills: item.resource.requiredSkills,
              validation: item.resource.validation, examples: [], listing: item })
        } }, local ? { id: 'activate', label: t(prior?.releaseId === local.release.id ? 'default' : 'useVersion'),
          disabled: busy || prior?.releaseId === local.release.id, onSelect: () => { choose(local, false) } }
          : { id: 'install', label: t('install'), variant: 'primary',
            disabled: busy || (item.source === 'publication' ? publishedPhase !== 'ready' : legacyPhase !== 'ready'),
            onSelect: () => { void run(async () => {
              const installation = await installMarketListing(actions, item)
              if (alive.current) {
                accept(installation); setConfirmed(previous => ({ ...previous, [item.key]: installation.release.id }))
              }
            }, 'installedDone') } }]} />
    })}{!query.trim() && !category && visible.length > 0 && <aside className={css.contributionCard}>
      <span className={css.badge}>{t('discoverEyebrow')}</span><img src={contributionUrl} alt="" />
      <h2>{t('contributeTitle')}</h2><p>{t('contributeDescription')}</p>
      <Button variant="outline" onClick={() => { onOpenCreator('skill') }}>{t('createEntry')}</Button>
    </aside>}</div>}
    {tab === 'installed' && <div className={css.grid}>{filteredInstalled.map((item) => {
      const active = defaultFor(item, defaults)?.releaseId === item.release.id
      return <MarketResourceCard key={item.release.id} metadata={item.release.manifest} t={t}
        source={{ kind: 'local', id: item.release.id }} publisher={t(active ? 'default' : 'stored')}
        command={`/${item.release.manifest.skills[0]?.name}`} actions={[
          { id: 'details', label: t('details'), variant: 'outline',
            onSelect: () => { setDetail({ ...detailFor(item.release), localId: item.release.id }) } },
          { id: 'activate', label: t(active ? 'disable' : 'useVersion'), variant: active ? 'outline' : 'primary',
            disabled: busy, onSelect: () => { choose(item, active) } },
          { id: 'export', label: t('export'), disabled: busy,
            onSelect: () => { void run(async () => { downloadMarketFile(await actions.exportPackage(item.release.id)) }) } },
          { id: 'remove', label: t('remove'), disabled: busy || active, onSelect: () => { void run(async () => {
            await actions.removePackage(item.release.id)
            if (alive.current) setInstalled(previous => previous.filter(row => row.release.id !== item.release.id))
          }) } },
        ]} />
    })}</div>}
    {tab === 'publish' && <section className={css.publications}>
      {identityError && <div className={css.notice}><p role="alert">{t(identityError)}</p><Button onClick={() => { void read('publish') }}>{t('retry')}</Button></div>}
      {identity && <>
        {identity.admin && <p className={css.badge}>{t('administrator')}</p>}
        <MarketPublicationFilter value={publicationStatus} onChange={setPublicationStatus} t={t} />
        <MarketPublications accessRevision={access.revision} isCurrentAccess={isCurrentAccess}
          items={authorizedItems.filter(item => !publicationStatus || item.status === publicationStatus)}
          identity={identity} actions={actions} busy={busy} t={t} reportOutcome={reportOutcome}
          onReplace={replacePublication}
          onDetails={(item) => { setDetail({ ...detailFor(item), publisher: item.publisher, listing: { ...item.manifest, source: 'publication', publication: item, key: `publication:${item.id}:${item.sha256}`, sha256: item.sha256, bytes: item.bytes }, accessRevision: access.revision }) }}
          onInstall={(item) => { void run(async () => { const result = await actions.installPublication(item.id, item.sha256); if (alive.current) accept(result.installation) }, 'installedDone') }} />
        {publishedPhase === 'ready' && authorizedItems.filter(item => !publicationStatus || item.status === publicationStatus).length === 0 && <div className={css.emptyState}><h2>{t('noPublications')}</h2><p>{t('noPublicationsHint')}</p><Button variant="primary" onClick={() => { onOpenCreator('skill') }}>{t('creatorNewSkill')}</Button></div>}
      </>}
    </section>}
    {!loading && (tab === 'discover' ? visible.length === 0 && publishedPhase === 'ready' && legacyPhase === 'ready' : tab === 'installed' && phase === 'ready' && installed.length === 0) && <p>{t('empty')}</p>}
    <MarketResourceDetails detail={shownDetail} actions={detailActions} t={t} onClose={() => { setDetail(undefined) }}
      onFindSkill={(name) => { setDetail(undefined); setQuery(name); setCategory(''); setTab('discover'); void read('discover', undefined, name) }} />
    <Modal open={Boolean(selection)} title={t(selection?.disable ? 'disable' : 'useVersion')} closeLabel={t('close')}
      onClose={() => { if (!busy) setSelection(undefined) }}>
      {selection && <div className={css.form}><p>{selection.item.release.manifest.title} · {selection.item.release.manifest.version}</p>
        <p>{t('defaultsHint')}</p><Button variant="primary" disabled={busy} onClick={() => { void changeDefault(selection) }}>{t('confirm')}</Button></div>}
    </Modal>
    {guide && <MarketGuide t={t} onClose={() => { rememberMarketGuide(); setGuide(false) }} />}
  </MarketLayout>
}
