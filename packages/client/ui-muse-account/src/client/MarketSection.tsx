/** Discovery, explicit local activation and creator-reviewed publication controls. */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Button, Input, StateDot, IconDownloadOutlineRegular, IconPlusOutlineRegular, IconSearchOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import type { PropsLocale, InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import type { MarketInstallation, MarketManifest, MarketRelease } from '@deepseek-ai/dsh-muse-market/types'
import type { MarketActions } from './market-mount.ts'
import type { MarketLocaleKey } from './market-locales.ts'
import css from './MarketSection.module.css'
import { type MarketPresentation } from './MarketCharacter.tsx'
import { MarketAuthorPreview } from './MarketAuthorPreview.tsx'
import { MarketReleaseDetails } from './MarketReleaseDetails.tsx'
import characterCss from './MarketCharacter.module.css'
import type { CharacterGenerationActions } from './market-character-generation.ts'
import { MarketPublications } from './MarketPublications.tsx'
import { marketFailure } from './market-errors.ts'
import type { MarketLegacyResource, MarketWebActions } from './market-web-types.ts'
import { MarketBrowserUpload } from './MarketBrowserUpload.tsx'
import { MarketReleaseCard } from './MarketReleaseCard.tsx'
import { downloadMarketFile } from './market-download.ts'
import { matchMarketPresetPortrait } from './market-preset-portraits.ts'
import { MarketContributionCard } from './MarketContributionCard.tsx'

const resourceBatchSize = 12

/** Shared market content props; actions never expose the account cookie. */
export type MarketSectionProps = PropsLocale<'settings.museMarket'> & InjectFace<{
  initialView?: 'discover' | 'publish'
  /** Shell-owned feedback survives navigation away from this page. */
  reportOutcome: (key: MarketLocaleKey, failed: boolean) => void
  /** Display-only data keyed by immutable release ID; supplied separately from package manifests. */
  presentations?: Readonly<Record<string, MarketPresentation>>
  /** Separate media adapter; omitted until the generation service is connected. */
  characterGeneration?: CharacterGenerationActions
}> & ({ mode?: 'host'; actions: MarketActions } | { mode: 'web'; actions: MarketWebActions })

/** Render market discovery, local packages and explicit publication forms.
 * @param props Localized content, Host actions and shell feedback.
 * @returns Market page content.
 */
export function MarketSection(props: MarketSectionProps): ReactNode {
  const { t, actions, presentations, characterGeneration, reportOutcome } = props
  const hostActions = props.mode === 'web' ? undefined : props.actions
  const webActions = props.mode === 'web' ? props.actions : undefined
  const [signedIn, setSignedIn] = useState<boolean>()
  const [tab, setTab] = useState<'discover' | 'installed' | 'publish'>(props.initialView ?? 'discover')
  const [resources, setResources] = useState<MarketLegacyResource[]>([])
  const [legacyFailed, setLegacyFailed] = useState(false)
  const [visibleResources, setVisibleResources] = useState(resourceBatchSize)
  const [releases, setReleases] = useState<MarketRelease[]>([])
  const [installed, setInstalled] = useState<MarketInstallation[]>([])
  const [sources, setSources] = useState<Awaited<ReturnType<MarketActions['sources']>>>()
  const [publishers, setPublishers] = useState<{ id: string; title: string }[]>([])
  const [publisher, setPublisher] = useState('')
  const [admin, setAdmin] = useState(false), [publicationRefresh, setPublicationRefresh] = useState(0)
  const [query, setQuery] = useState(''), [kind, setKind] = useState('')
  const [category, setCategory] = useState('')
  const [detail, setDetail] = useState<MarketRelease>()
  const [busy, setBusy] = useState(false)
  const [loadState, setLoadState] = useState<{ phase: 'loading' | 'ready' } | { phase: 'error'; error: MarketLocaleKey }>({ phase: 'loading' })
  const [bot, setBot] = useState(''), [selected, setSelected] = useState<string[]>([])
  const [metadata, setMetadata] = useState({ name: '', title: '', description: '', version: '1.0.0', license: '', category: '', examples: '', requirements: '' })
  const [portraitOverride, setPortraitOverride] = useState<MarketManifest['presetPortrait']>()
  const presetPortrait = bot ? portraitOverride ?? matchMarketPresetPortrait(metadata).id : undefined
  const selectBot = (id: string): void => { setBot(id); setPortraitOverride(undefined) }
  const moreResources = useRef<HTMLDivElement>(null)
  const uploadAnchor = useRef<HTMLDivElement>(null)
  const uploadKeys = useRef(new Map<string, string>())
  const pending = useRef<symbol | null>(null)

  const run = async (operation: (current: () => boolean) => Promise<void>, success: MarketLocaleKey = 'done'): Promise<void> => {
    if (pending.current) return
    const token = Symbol()
    pending.current = token; setBusy(true)
    try { await operation(() => pending.current === token); if (!webActions || pending.current === token) reportOutcome(success, false) }
    catch (error) { if (!webActions || pending.current === token) reportOutcome(marketFailure(error), true) }
    finally { if (pending.current === token) { pending.current = null; setBusy(false) } }
  }
  const read = async (target: typeof tab, token: symbol, filters = { query, kind }): Promise<void> => {
    setBusy(true); setLoadState({ phase: 'loading' })
    try {
      const [rows, local, found, identity, legacy] = await Promise.all([
        hostActions ? hostActions.installed() : [], hostActions?.sources(),
        target === 'discover' ? actions.catalog(filters.query, filters.kind, false) : undefined,
        target === 'publish' || webActions ? actions.identity().catch((error: unknown) => {
          if (webActions && marketFailure(error) === 'error.login-required') return undefined
          throw error
        }) : undefined,
        target === 'discover' ? webActions?.legacyCatalog?.(filters.query, filters.kind).catch(() => null) : undefined,
      ])
      if (pending.current !== token) return
      setInstalled(rows); setSources(local)
      if (found) {
        setReleases(found); setCategory(''); setVisibleResources(resourceBatchSize)
        const digests = new Set(found.map(row => row.sha256))
        setResources((legacy ?? []).filter(row => !digests.has(row.sha256)))
        setLegacyFailed(legacy === null)
      }
      if (webActions) setSignedIn(Boolean(identity))
      if (identity || webActions) { setPublishers(identity?.publishers ?? []); setAdmin(identity?.admin ?? false); setPublisher(identity?.publishers[0]?.id ?? '') }
      setLoadState({ phase: 'ready' })
    } catch (error) {
      if (pending.current === token) setLoadState({ phase: 'error', error: marketFailure(error) })
    } finally {
      if (pending.current === token) { pending.current = null; setBusy(false) }
    }
  }
  const refresh = (target: typeof tab = tab, filters = { query, kind }): void => {
    if (pending.current) return
    const token = Symbol(); pending.current = token
    void read(target, token, filters)
  }
  const acceptInstallation = (item: MarketInstallation): void => {
    setInstalled(previous => [...previous.filter(row => row.release.id !== item.release.id), item])
  }
  useEffect(() => {
    const token = Symbol(); pending.current = token
    setResources([]); setLegacyFailed(false)
    setReleases([]); setInstalled([]); setSources(undefined); setPublishers([]); setPublisher(''); setAdmin(false); setSignedIn(undefined)
    void read(tab, token)
    return () => { pending.current = null }
  }, [actions])

  const switchTab = (next: typeof tab): void => {
    if (pending.current) return
    setTab(next)
    refresh(next)
  }
  const exportFile = async (item: MarketInstallation, host: MarketActions): Promise<void> => {
    const file = await host.exportPackage(item.release.id)
    downloadMarketFile({ name: file.name, bytes: Uint8Array.from(atob(file.base64), char => char.charCodeAt(0)) })
  }
  const downloadRelease = async (release: MarketRelease, current: () => boolean): Promise<void> => {
    if (props.mode === 'web') { const file = await props.actions.downloadArchive(release); if (current()) downloadMarketFile(file) }
    else { const item = await props.actions.install(release.id); if (current()) acceptInstallation(item) }
  }
  const upload = async (item: MarketInstallation, current: () => boolean, host: MarketActions): Promise<void> => {
    const key = `${item.release.id}:${publisher}`
    const requestId = uploadKeys.current.get(key) ?? randomUUID()
    uploadKeys.current.set(key, requestId)
    await host.publishDraft(item.release.id, publisher as Parameters<MarketActions['publishDraft']>[1], requestId)
    uploadKeys.current.delete(key)
    if (current()) setPublicationRefresh(value => value + 1)
  }
  const rows = tab === 'discover' ? releases.filter(row => !category || row.manifest.category === category)
    : installed.map(item => item.release)
  const legacyRows = tab === 'discover' ? resources.filter(row => !category || row.category === category) : []
  const categories = [...new Set([...releases.map(row => row.manifest.category), ...resources.map(row => row.category)])]
  const openCreator = (): void => {
    if (pending.current) return
    if (sources?.bots[0]) selectBot(sources.bots[0].id)
    switchTab('publish')
  }
  const leadBot = legacyRows.find(row => row.id === 'muse/bots/storyboard-director-16-9') ?? legacyRows.find(row => row.kind === 'bot')
  const leadSkill = legacyRows.find(row => row.kind === 'skill')
  const resourceCount = legacyRows.length
  const canLoadMore = loadState.phase === 'ready' && visibleResources < resourceCount
  useEffect(() => {
    const sentinel = moreResources.current
    if (!canLoadMore || !sentinel) return
    if (typeof IntersectionObserver === 'undefined') {
      setVisibleResources(resourceCount)
      return
    }
    let active = true
    const observer = new IntersectionObserver((entries) => {
      if (!active || !entries.some(entry => entry.isIntersecting)) return
      observer.disconnect()
      setVisibleResources(count => Math.min(count + resourceBatchSize, resourceCount))
    }, { rootMargin: '0px 0px 400px 0px' })
    observer.observe(sentinel)
    return () => {
      active = false
      observer.disconnect()
    }
  }, [canLoadMore, visibleResources, resourceCount])
  const featured = !kind && !category && rows.length === 0 && leadBot && leadSkill ? [leadBot, leadSkill] : []
  const remainingLegacy = legacyRows.filter(row => !featured.includes(row))
  const showContribution = tab === 'discover' && rows.length + legacyRows.length > 0 && loadState.phase === 'ready'
  const renderLegacyCard = (resource: MarketLegacyResource): ReactNode => <MarketReleaseCard key={resource.id} resource={resource} t={t}>
    <details><summary>{t('requirements')}</summary>
      <ul>{resource.requirements.map(requirement => <li key={requirement}>{requirement}</li>)}</ul>
      {resource.requiredSkills.length > 0 && <p>{t('sourceSkillsShort')}: {resource.requiredSkills.join(', ')}</p>}
      <p>{t(resource.kind === 'bot' ? 'legacyBotInstall' : 'legacySkillInstall')}</p>
      <p>{resource.validation}</p>
    </details>
    <a href={resource.href} download>{t('legacyDownload')}</a>
  </MarketReleaseCard>
  return <section className={css.section}>
    <div className={css.masthead}>
      <div className={css.brand}><span className={characterCss.brandMark} aria-hidden="true" /><span>{t('brand')}</span></div>
      <div className={css.navigation}>{(webActions ? ['discover', 'publish'] as const : ['discover', 'installed', 'publish'] as const).map(value => <Button key={value}
        variant="ghost" className={css.navButton} disabled={busy} aria-pressed={tab === value} onClick={() => { switchTab(value) }}>{t(value)}</Button>)}</div>
      <Button className={css.uploadEntry} variant="primary" disabled={busy} icon={<IconPlusOutlineRegular size={18} />} onClick={openCreator}>{t('uploadEntry')}</Button>
      {webActions && signedIn !== undefined && <a className={css.accountLink} href={signedIn ? '/account' : '/login'}>{t(signedIn ? 'browserAccount' : 'browserSignIn')}</a>}
    </div>
    <div className={css.hero}><div className={css.heroCopy}>
      <h1 className={css.title}>{t('title')}</h1><p>{t('description')}</p></div>
    {tab === 'discover' && <div className={css.discoveryTools}><form className={css.search} onSubmit={(event) => { event.preventDefault(); refresh() }}>
      <Input className={css.query} icon={<IconSearchOutlineRegular size={18} />} aria-label={t('query')} placeholder={t('query')}
        value={query} disabled={busy} maxLength={200} onChange={(event) => { setQuery(event.target.value) }} />
      <Button type="submit" variant="outline" disabled={busy}>{t('search')}</Button>
    </form><div className={css.filters}>
      <div className={css.kindTabs} role="group" aria-label={t('typeFilter')}>{(['', 'bot', 'skill'] as const).map(value => <Button key={value}
        variant={kind === value ? 'primary' : 'ghost'} disabled={busy} aria-pressed={kind === value} onClick={() => {
          setKind(value); refresh('discover', { query, kind: value })
        }}>{t(value || 'all')}</Button>)}</div>
      <div className={css.categoryTabs} role="group" aria-label={t('category')}>{['', ...categories].map(value => <Button key={value}
        size="sm" variant={category === value ? 'outline' : 'ghost'} disabled={busy} aria-pressed={category === value}
        onClick={() => { setCategory(value); setVisibleResources(resourceBatchSize) }}>{value || t('allCategories')}</Button>)}</div>
    </div></div>}</div>
    {busy && loadState.phase !== 'loading' && <div role="status" aria-label={t('loading')} className={css.notice}><StateDot state="ongoing" /></div>}
    {hostActions && tab === 'installed' && <div className={css.actions}><label className={css.field}>{t('import')}<input type="file" disabled={busy} accept=".zip,application/zip" onChange={(event) => {
      const file = event.target.files?.[0]; event.target.value = ''; if (!file) return
      void run(async (current) => { if (file.size > 64 * 1024 * 1024) throw Error('expanded-limit'); const bytes = new Uint8Array(await file.arrayBuffer()); let encoded = ''; for (let offset = 0; offset < bytes.length; offset += 16384) encoded += String.fromCharCode(...bytes.subarray(offset, offset + 16384)); const item = await hostActions.importPackage(btoa(encoded)); if (current()) acceptInstallation(item) })
    }} /></label><Button disabled={busy} onClick={() => { refresh() }}>{t('refresh')}</Button></div>}
    {loadState.phase === 'error' && <div className={rows.length ? css.readNotice : css.empty}>
      <p role="alert">{t(loadState.error === 'error.generic' ? rows.length ? 'readFailedRetained' : 'readFailed' : loadState.error)}</p>
      <Button variant="outline" disabled={busy} onClick={() => { refresh() }}>{t('retry')}</Button></div>}
    {tab === 'publish' && loadState.phase === 'ready' && <>
      {webActions && !signedIn && <div className={css.empty}><p>{t('browserSignInHint')}</p><a href="/login">{t('browserSignIn')}</a></div>}
      {(!webActions || signedIn) && <MarketPublications actions={actions} publishers={publishers} admin={admin}
        refreshKey={publicationRefresh}
        reportOutcome={reportOutcome} onDetails={setDetail} localBusy={busy} t={t} presentations={presentations}
        browserMode={Boolean(webActions)}
        onUpload={webActions && publishers.length ? () => { uploadAnchor.current?.scrollIntoView({ block: 'start' }) } : undefined}
        onDownload={(release) => {
          void run(current => downloadRelease(release, current), webActions ? 'archiveDownloaded' : 'done')
        }} />}
      {webActions && signedIn && <div ref={uploadAnchor}>
        <MarketBrowserUpload actions={webActions} publishers={publishers} t={t} reportOutcome={reportOutcome}
          onUploaded={(release) => { setPublicationRefresh(value => value + 1); setDetail(release) }} /></div>}
      {hostActions && <>
        <p>{t('prepareDescription')}</p><div className={css.authorLayout}><form className={css.form} onSubmit={(event) => { event.preventDefault(); void run(async (current) => {
          const manifest: MarketManifest = { ...metadata, formatVersion: 1, kind: bot ? 'bot' : 'skill', ...(presetPortrait ? { presetPortrait } : {}), skills: [], examples: metadata.examples.split('\n').filter(Boolean), requirements: metadata.requirements.split('\n').filter(Boolean) }
          const item = await hostActions.prepare(manifest, selected, bot); if (current()) acceptInstallation(item)
        }) }}>
          <h3>{t('publicationInfo')}</h3>
          <label className={css.field}>{t('publisher')}<select value={publisher} onChange={(event) => { setPublisher(event.target.value) }} disabled={!publishers.length}>{!publishers.length && <option value="">{t('noPublisher')}</option>}{publishers.map(row => <option key={row.id} value={row.id}>{row.title}</option>)}</select></label>
          <label className={css.field}>{t('sourceBot')}<select value={bot} onChange={(event) => { selectBot(event.target.value) }}><option value="">{t('noBot')}</option>{sources?.bots.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}</select></label>
          {(['name', 'title', 'version', 'description', 'license', 'category', 'examples', 'requirements'] as const).map(key => <label key={key} className={css.field}>{t(key === 'title' ? 'label' : key === 'description' ? 'summary' : key)}<Input value={metadata[key]} required={!['examples', 'requirements'].includes(key)} onChange={(event) => { setMetadata(previous => ({ ...previous, [key]: event.target.value })) }} /></label>)}
          <fieldset className={css.skills}><legend>{t('sourceSkills')}</legend>{sources?.skills.map(row => <label key={row.name}><input type="checkbox" checked={selected.includes(row.name)} onChange={(event) => { setSelected(previous => event.target.checked ? [...previous, row.name] : previous.filter(name => name !== row.name)) }} />{row.name}</label>)}</fieldset>
          <Button type="submit" variant="primary" disabled={busy || !bot && selected.length !== 1}>{t('prepare')}</Button>
        </form>
        <MarketAuthorPreview key={bot} title={metadata.title} description={metadata.description} version={metadata.version}
          publisher={publishers.find(row => row.id === publisher)?.title ?? ''} bot={Boolean(bot)} skillNames={selected} t={t}
          presetPortrait={presetPortrait} onPresetPortraitChange={setPortraitOverride}
          generation={characterGeneration} reportOutcome={reportOutcome} /></div>
        <h3 className={css.subheading}>{t('localPackages')}</h3></>}
    </>}
    {tab === 'discover' && legacyFailed && loadState.phase === 'ready' && <div className={css.readNotice}>
      <p role="alert">{t('legacyUnavailable')}</p><Button onClick={() => { refresh() }}>{t('retry')}</Button>
    </div>}
    {!(webActions && tab === 'publish') && <div className={css.grid} aria-busy={loadState.phase === 'loading'}>
      {rows.length === 0 && legacyRows.length === 0 && loadState.phase === 'loading' && <div role="status" aria-label={t('loading')} className={css.skeletons}>
        {[0, 1, 2].map(index => <div key={index} className={css.skeleton} aria-hidden="true"><span /><span /><span /></div>)}
      </div>}
      {rows.length === 0 && legacyRows.length === 0 && !legacyFailed && loadState.phase === 'ready' && <div className={css.empty}>
        <h3>{t(tab === 'discover' ? 'emptyDiscovery' : 'emptyInstalled')}</h3>
        <p>{t(tab === 'discover' ? webActions ? 'emptyWebDiscoveryHint' : 'emptyDiscoveryHint' : 'emptyInstalledHint')}</p>
        {webActions && tab === 'discover' && <Button onClick={openCreator}>{t('publish')}</Button>}
        {tab !== 'discover' && <Button onClick={() => { switchTab('discover') }}>{t('discover')}</Button>}
      </div>}
      {rows.map((release) => {
        const local = installed.find(item => item.release.sha256 === release.sha256)
        return <MarketReleaseCard key={release.id} release={release} presentation={presentations?.[release.id]} t={t}>
          <Button variant="outline" onClick={() => { setDetail(release) }}>{t('details')}</Button>
          {webActions ? <Button variant="primary" disabled={busy} icon={<IconDownloadOutlineRegular size={18} />} onClick={() => void run(current => downloadRelease(release, current), 'archiveDownloaded')}>{t('browserDownload')}</Button> : hostActions && (!local ? <Button variant="primary" disabled={busy} icon={<IconDownloadOutlineRegular size={18} />} onClick={() => void run(async (current) => { const item = await hostActions.install(release.id); if (current()) acceptInstallation(item) })}>{t('download')}</Button> : <>
            <span>{t(local.enabled ? 'enabled' : 'disabled')}</span><Button variant={local.enabled ? 'outline' : 'primary'} disabled={busy} onClick={() => void run(async (current) => { const item = await hostActions.enable(local.release.id, !local.enabled); if (current()) acceptInstallation(item) })}>{t(local.enabled ? 'disable' : 'enable')}</Button>
            <Button disabled={busy} onClick={() => void run(() => exportFile(local, hostActions))}>{t('export')}</Button>
            {!local.enabled && <Button disabled={busy} onClick={() => void run(async (current) => { await hostActions.remove(local.release.id); if (current()) setInstalled(previous => previous.filter(row => row.release.id !== local.release.id)) })}>{t('remove')}</Button>}
            {tab === 'publish' && <Button disabled={busy || !publisher} onClick={() => void run(current => upload(local, current, hostActions), 'draft')}>{t('upload')}</Button>}
          </>)}</MarketReleaseCard>
      })}
      {featured.map(renderLegacyCard)}
      {showContribution && featured.length > 0 && <MarketContributionCard t={t} disabled={busy} onUpload={openCreator} />}
      {remainingLegacy.slice(0, visibleResources - featured.length).map(renderLegacyCard)}
      {showContribution && featured.length === 0 && <MarketContributionCard t={t} disabled={busy} onUpload={openCreator} />}
    </div>}
    {canLoadMore && <div ref={moreResources} className={css.scrollSentinel} aria-hidden="true" />}
    <div className={css.footer}><span>{t(webActions ? 'browserDownloadHint' : 'downloadHint')}</span>{sources && <a href={sources.website} target="_blank" rel="noreferrer">{t('website')}</a>}</div>
    <MarketReleaseDetails release={detail} onClose={() => { setDetail(undefined) }} t={t} />
  </section>
}
