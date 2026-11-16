/** Standalone Skill website sharing Desktop resource presentation without local activation controls. */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Button, Input, StateDot, IconPlusOutlineRegular, IconSearchOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { deepEqualJson } from '@deepseek-ai/dsh-util-values'
import type { MarketAccountId } from '@deepseek-ai/dsh-muse-market/cloud-values'
import type { MarketIdentity, MarketLegacyResource, MarketOutcomeKey, MarketPublication } from './market-actions.ts'
import { marketFailureOutcome } from './market-actions.ts'
import { MarketAccessChanged } from './market-controller.ts'
import { marketListings, type MarketListing } from './market-listing.ts'
import { MarketBrowserUpload } from './MarketBrowserUpload.tsx'
import { MarketPublications } from './MarketPublications.tsx'
import { MarketGuide, rememberMarketGuide, shouldShowMarketGuide } from './MarketGuide.tsx'
import { MarketPublicationFilter, MarketResourceCard, MarketResourceDetails,
  type MarketPublicationFilterValue, type MarketResourceDetail } from './MarketResource.tsx'
import type { MarketBrowserFile, MarketBrowserPageProps } from './market-browser-actions.ts'
import css from './MarketSection.module.css'
import mascotUrl from './assets/muse-purple-spider.png'
import contributionUrl from './assets/storyboard-skill-kit.png'

export type { MarketBrowserActions, MarketBrowserArchive, MarketBrowserFile,
  MarketBrowserPageProps, MarketBrowserView } from './market-browser-actions.ts'

type ReadPhase = 'loading' | 'ready' | 'error'
type IdentityRead = { readonly identity: MarketIdentity } | { readonly error: unknown }
type DownloadAccess = { readonly kind: 'public' }
  | { readonly kind: 'private'; readonly accountId: MarketAccountId; readonly revision: number }

type SelectedDetail = { readonly metadata: MarketResourceDetail; readonly listing: MarketListing; readonly access: DownloadAccess }

function publicationListing(publication: MarketPublication): MarketListing {
  return { ...publication.manifest, source: 'publication', publication,
    sha256: publication.sha256, bytes: publication.bytes, key: `publication:${publication.id}:${publication.sha256}` }
}

function resourceDetail(item: MarketListing): MarketResourceDetail {
  return item.source === 'publication'
    ? { ...item.publication.manifest, publisher: item.publication.publisher, sha256: item.sha256, bytes: item.bytes }
    : { ...item, skills: [{ name: item.name }], requiredSkills: item.resource.requiredSkills,
      validation: item.resource.validation, examples: [] }
}

function saveFile(file: MarketBrowserFile): void {
  const href = URL.createObjectURL(new Blob([Uint8Array.from(file.bytes)], { type: 'application/zip' }))
  const link = document.createElement('a')
  link.href = href; link.download = file.name; link.click()
  setTimeout(() => { URL.revokeObjectURL(href) }, 0)
}

/** Render public discovery, cloud review or ZIP upload using only browser-supported operations.
 * @param props - Same-origin browser operations, explicit route navigation and localized feedback.
 * @returns Shared market presentation whose downloads never imply desktop installation or activation.
 */
export function MarketBrowserPage({ actions, view, onNavigate, t, reportOutcome }: MarketBrowserPageProps): ReactNode {
  const [items, setItems] = useState<MarketPublication[]>([]), [originals, setOriginals] = useState<MarketLegacyResource[]>([])
  const [privateItems, setPrivateItems] = useState<MarketPublication[]>([])
  const [publishedPhase, setPublishedPhase] = useState<ReadPhase>('loading')
  const [legacyPhase, setLegacyPhase] = useState<ReadPhase>('loading')
  const [privatePhase, setPrivatePhase] = useState<ReadPhase>('loading')
  const [identityPhase, setIdentityPhase] = useState<ReadPhase>('loading')
  const [identityError, setIdentityError] = useState<MarketOutcomeKey>('signInRequired')
  const [identity, setIdentity] = useState<MarketIdentity>()
  const [accessRevision, setAccessRevision] = useState(0)
  const [query, setQuery] = useState(''), [category, setCategory] = useState('')
  const [shownCount, setShownCount] = useState(12)
  const [status, setStatus] = useState<MarketPublicationFilterValue>('')
  const [detail, setDetail] = useState<SelectedDetail>()
  const [guide, setGuide] = useState(shouldShowMarketGuide)
  const [busy, setBusy] = useState(false)
  const alive = useRef(false), epoch = useRef(0), downloading = useRef(false)
  const currentView = useRef(view)
  currentView.current = view
  const identityRef = useRef<MarketIdentity | undefined>(undefined), privateRevision = useRef(0)
  const sequence = useRef({ publication: 0, legacy: 0, identity: 0, private: 0 })
  const revoke = (outcome: MarketOutcomeKey): void => {
    identityRef.current = undefined; setIdentity(undefined); ++privateRevision.current
    setAccessRevision(privateRevision.current); setPrivateItems([]); setIdentityPhase('error'); setIdentityError(outcome)
  }
  const readIdentity = async (): Promise<IdentityRead> => {
    const token = ++sequence.current.identity, owner = epoch.current
    setIdentityPhase('loading')
    try {
      const found = await actions.identity()
      if (!alive.current || epoch.current !== owner || sequence.current.identity !== token) throw new MarketAccessChanged()
      if (!deepEqualJson(identityRef.current ?? null, found)) {
        ++privateRevision.current; setAccessRevision(privateRevision.current); setPrivateItems([])
      }
      identityRef.current = found; setIdentity(found); setIdentityPhase('ready')
      return { identity: found }
    } catch (error) {
      if (alive.current && epoch.current === owner && sequence.current.identity === token) {
        revoke(marketFailureOutcome(error))
      }
      return { error }
    }
  }
  const verifyIdentity = async (expected: MarketAccountId): Promise<MarketIdentity> => {
    const result = await readIdentity()
    if ('error' in result) throw result.error
    if (result.identity.accountId !== expected) throw new MarketAccessChanged()
    return result.identity
  }
  const readPublic = async (kind: 'publication' | 'legacy', search = query): Promise<void> => {
    const token = ++sequence.current[kind], owner = epoch.current
    const current = (): boolean => alive.current && epoch.current === owner && sequence.current[kind] === token
    if (kind === 'publication') setPublishedPhase('loading')
    else setLegacyPhase('loading')
    try {
      if (kind === 'publication') {
        const found = await actions.catalog(search, false)
        if (current()) { setItems(found); setPublishedPhase('ready') }
      } else {
        const found = await actions.legacyCatalog(search)
        if (current()) { setOriginals(found); setLegacyPhase('ready') }
      }
    } catch (_error) {
      if (current()) { if (kind === 'publication') setPublishedPhase('error'); else setLegacyPhase('error') }
    }
  }
  const readPrivate = async (): Promise<void> => {
    const token = ++sequence.current.private, owner = epoch.current
    const current = (): boolean => alive.current && owner === epoch.current && sequence.current.private === token
    setPrivateItems([])
    setPrivatePhase('loading')
    const result = await readIdentity()
    if (!current()) return
    if ('error' in result) { setPrivatePhase('error'); return }
    const found = result.identity
    const revision = privateRevision.current
    try {
      const rows = await actions.catalog('', true)
      if (!current() || revision !== privateRevision.current) return
      await verifyIdentity(found.accountId)
      if (!current()) return
      if (revision !== privateRevision.current) throw new MarketAccessChanged()
      setPrivateItems(rows); setPrivatePhase('ready')
    } catch (_error) {
      if (current()) setPrivatePhase('error')
    }
  }
  useEffect(() => {
    alive.current = true; ++epoch.current
    if (view === 'discover') { void readPublic('publication'); void readPublic('legacy'); void readIdentity() }
    else if (view === 'publish') void readPrivate()
    else void readIdentity()
    return () => { alive.current = false; ++epoch.current }
  }, [actions, view])
  const refresh = (): void => {
    if (view === 'discover') { void readPublic('publication'); void readPublic('legacy'); void readIdentity() }
    else if (view === 'publish') void readPrivate()
    else void readIdentity()
  }
  const downloadBytes = (item: MarketListing): Promise<MarketBrowserFile> => item.source === 'publication'
    ? actions.downloadPublication(item.publication) : actions.downloadLegacy(item.resource)
  const canUsePrivateDownload = (access: Extract<DownloadAccess, { kind: 'private' }>, owner: number): boolean => alive.current
    && owner === epoch.current && access.revision === privateRevision.current && identityRef.current?.accountId === access.accountId
  const privateDownload = async (item: MarketListing, access: Extract<DownloadAccess, { kind: 'private' }>, owner: number): Promise<MarketBrowserFile | undefined> => {
    const current = (): boolean => canUsePrivateDownload(access, owner)
    if (!current()) throw new MarketAccessChanged()
    const file = await downloadBytes(item)
    if (!current()) return undefined
    await verifyIdentity(access.accountId)
    if (!current()) return undefined
    return file
  }
  const download = async (item: MarketListing, access: DownloadAccess): Promise<void> => {
    if (downloading.current) return
    downloading.current = true; setBusy(true)
    const owner = epoch.current, revision = privateRevision.current
    try {
      const transfer = access.kind === 'private' ? privateDownload(item, access, owner) : downloadBytes(item)
      const file = await transfer
      if (file === undefined) return
      if (!alive.current) return
      if (access.kind === 'private' && !canUsePrivateDownload(access, owner)) return
      saveFile(file); reportOutcome('browserDownloaded', false)
    } catch (error) {
      if (alive.current) {
        const outcome = marketFailureOutcome(error)
        if (revision === privateRevision.current && (outcome === 'signInRequired' || outcome === 'permissionDenied')) revoke(outcome)
        reportOutcome(outcome, true)
      }
    } finally { downloading.current = false; if (alive.current) setBusy(false) }
  }
  const visible = marketListings(items, originals, query, category)
  const categories = [...new Set(marketListings(items, originals, query).map(item => item.category))]
  const publicationAccess = (item: MarketPublication, accountId: MarketAccountId): DownloadAccess => item.status === 'published'
    ? { kind: 'public' } : { kind: 'private', accountId, revision: accessRevision }
  const showDetails = (listing: MarketListing, access: DownloadAccess): void => {
    setDetail({ metadata: resourceDetail(listing), listing, access })
  }
  const shownDetail = detail?.access.kind === 'private' && detail.access.revision !== accessRevision ? undefined : detail
  const reviewOperations = (accountId: MarketAccountId) => ({
    getPublication: (id: Parameters<typeof actions.getPublication>[0]) => actions.getPublication(id),
    review: async (...args: Parameters<Parameters<typeof MarketPublications>[0]['actions']['review']>) => {
      await verifyIdentity(accountId)
      return await actions.review(...args, accountId)
    },
  })
  return <div className={css.page} data-muse-skill-market data-market-carrier="web" onScroll={(event) => {
    const element = event.currentTarget
    if (element.scrollHeight - element.scrollTop - element.clientHeight < 320 && shownCount < visible.length) {
      setShownCount(count => Math.min(count + 12, visible.length))
    }
  }}><section className={css.section}>
      <header className={css.masthead}>
        <div className={css.brand}><img src={mascotUrl} alt="" /><span>{t('brand')}</span></div>
        <nav className={css.navigation} role="tablist" aria-label={t('nav')}>
          {(['discover', 'publish'] as const).map(tab => <Button key={tab} role="tab" aria-selected={view === tab}
            variant="ghost" className={css.navButton} onClick={() => { onNavigate(tab) }}>{t(tab)}</Button>)}
        </nav>
        <div className={css.actions}><Button variant="ghost" onClick={() => { setGuide(true) }}>{t('guideEntry')}</Button>
          <Button variant="primary" icon={<IconPlusOutlineRegular size={18} />} onClick={() => { onNavigate('upload') }}>{t('creatorUploadZip')}</Button>
          <a href={identity ? '/account' : '/login'}>{t(identity ? 'browserAccount' : 'browserSignIn')}</a></div>
      </header>
      <div className={css.hero}><div className={css.heroCopy}>
        {view === 'upload' && <Button variant="ghost" onClick={() => { onNavigate('publish') }}>{t('creatorBack')}</Button>}
        <p className={css.eyebrow}>{t(view === 'discover' ? 'discoverEyebrow' : 'creatorEyebrow')}</p>
        <h1>{t(view === 'discover' ? 'discoverTitle' : view === 'publish' ? 'myPublications' : 'creatorTitle')}</h1>
        <p>{t(view === 'discover' ? 'discoverDescription' : view === 'publish' ? 'publicationsDescription' : 'browserUploadDescription')}</p>
      </div>{view === 'discover' && <form className={css.search} onSubmit={(event) => {
        event.preventDefault(); void readPublic('publication'); void readPublic('legacy')
      }}><Input className={css.query} icon={<IconSearchOutlineRegular size={18} />} type="search" maxLength={200}
          value={query} aria-label={t('query')} placeholder={t('query')}
          onChange={(event) => { setQuery(event.target.value); setShownCount(12) }} /><Button type="submit" variant="outline">{t('search')}</Button></form>}</div>
      <div className={css.discoveryBar}>{view === 'discover' ? <div className={css.filters} role="group" aria-label={t('category')}>
        {['', ...categories].map(value => <Button key={value} size="sm" aria-pressed={category === value}
          variant={category === value ? 'outline' : 'ghost'} onClick={() => { setCategory(value); setShownCount(12) }}>{value || t('allCategories')}</Button>)}
      </div> : <span>{t(view === 'publish' ? 'publish' : 'creatorUploadZip')}</span>}
      <Button variant="ghost" onClick={refresh}>{t('refresh')}</Button></div>
      {(view === 'publish' && privatePhase === 'loading' || view === 'upload' && identityPhase === 'loading')
      && <div className={css.skeletons} role="status" aria-label={t('loading')}><StateDot state="ongoing" /></div>}
      {view === 'discover' && <>
        {publishedPhase === 'error' && <div className={css.notice}><p role="alert">{t('publishedReadFailed')}</p>
          <Button onClick={() => { void readPublic('publication') }}>{t('retryPublished')}</Button></div>}
        {legacyPhase === 'error' && <div className={css.notice}><p role="alert">{t('originalReadFailed')}</p>
          <Button onClick={() => { void readPublic('legacy') }}>{t('retryOriginal')}</Button></div>}
        {visible.length === 0 && (publishedPhase === 'loading' || legacyPhase === 'loading') && <div className={css.skeletons} aria-hidden="true">
          {[0, 1, 2].map(key => <div key={key} className={css.skeletonCard}><span /><span /><span /></div>)}</div>}
        <div className={css.grid}>{visible.slice(0, shownCount).map(item => <MarketResourceCard key={item.key} metadata={item}
          source={{ kind: item.source, id: item.source === 'publication' ? item.publication.id : item.resource.id }}
          publisher={item.source === 'publication' ? item.publication.publisher : t('originalResources')} t={t} actions={[
            { id: 'details', label: t('details'), variant: 'outline', onSelect: () => { showDetails(item, { kind: 'public' }) } },
            { id: 'download', label: t('browserDownload'), variant: 'primary', disabled: busy, onSelect: () => { void download(item, { kind: 'public' }) } },
          ]} />)}{!query.trim() && !category && visible.length > 0 && <aside className={css.contributionCard}>
          <span className={css.badge}>{t('discoverEyebrow')}</span><img src={contributionUrl} alt="" />
          <h2>{t('contributeTitle')}</h2><p>{t('contributeDescription')}</p>
          <Button variant="outline" onClick={() => { onNavigate('upload') }}>{t('creatorUploadZip')}</Button></aside>}</div>
        {visible.length === 0 && publishedPhase === 'ready' && legacyPhase === 'ready' && <p>{t('empty')}</p>}
      </>}
      {view === 'publish' && <section className={css.publications}>
        {identity ? <><MarketPublicationFilter value={status} onChange={setStatus} t={t} />
          {identity.admin && <p className={css.badge}>{t('administrator')}</p>}
          {privatePhase === 'error' && <div className={css.notice}><p>{t('publishedReadFailed')}</p>
            <Button onClick={() => { void readPrivate() }}>{t('retryPublished')}</Button></div>}
          <MarketPublications key={accessRevision} items={privateItems.filter(item => !status || item.status === status)}
            identity={identity} actions={reviewOperations(identity.accountId)} accessRevision={accessRevision}
            isCurrentAccess={revision => alive.current && privateRevision.current === revision} busy={busy} t={t}
            downloadLabel={t('browserDownload')} reportOutcome={reportOutcome}
            onReplace={(item) => { setPrivateItems(previous => previous.map(row => row.id === item.id ? item : row)) }}
            onDetails={(item) => { showDetails(publicationListing(item), publicationAccess(item, identity.accountId)) }}
            onInstall={(item) => { void download(publicationListing(item), publicationAccess(item, identity.accountId)) }} />
          {privatePhase === 'ready' && privateItems.filter(item => !status || item.status === status).length === 0 && <div className={css.emptyState}>
            <h2>{t('noPublications')}</h2><p>{t('noPublicationsHint')}</p><Button onClick={() => { onNavigate('upload') }}>{t('creatorUploadZip')}</Button></div>}
        </> : identityPhase === 'error' && <div className={css.notice}><p role="alert">{t(identityError)}</p>
          {identityError === 'signInRequired' ? <a href="/login">{t('browserSignIn')}</a>
            : <Button onClick={() => { void readPrivate() }}>{t('retry')}</Button>}</div>}
      </section>}
      {/* Keep the original upload bytes and request key alive across market navigation. */}
      <div hidden={view !== 'upload'}><MarketBrowserUpload actions={actions} identity={identity} identityError={identityError}
        identityLoading={identityPhase === 'loading'} retryIdentity={() => { void readIdentity() }} verifyIdentity={verifyIdentity}
        onUploaded={() => { if (currentView.current === 'upload') onNavigate('publish') }} reportOutcome={reportOutcome} t={t} /></div>
      <p className={css.secondary}>{t('browserDownloadHint')}</p>
      <MarketResourceDetails detail={shownDetail?.metadata} t={t} onClose={() => { setDetail(undefined) }}
        onFindSkill={(name) => { setDetail(undefined); setQuery(name); setCategory(''); setShownCount(12); onNavigate('discover')
          void readPublic('publication', name); void readPublic('legacy', name) }}
        actions={shownDetail ? [{ id: 'download', label: t('browserDownload'), variant: 'primary', disabled: busy,
          onSelect: () => { void download(shownDetail.listing, shownDetail.access) } }] : []} />
      {guide && <MarketGuide web t={t} onClose={() => { rememberMarketGuide(); setGuide(false) }} />}
    </section></div>
}
