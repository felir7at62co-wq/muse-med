/** Dedicated authoring panel for preparing local packages and uploading private drafts. */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Button, Input, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import type { MarketInstallation, MarketManifest, MarketRelease } from '@deepseek-ai/dsh-muse-market/types'
import { MarketAuthorPreview } from './MarketAuthorPreview.tsx'
import { MarketBrowserUpload } from './MarketBrowserUpload.tsx'
import { MarketSkillArtwork } from './MarketCatalogArtwork.tsx'
import { MarketCharacter } from './MarketCharacter.tsx'
import { MarketReleaseDetails } from './MarketReleaseDetails.tsx'
import type { MarketSectionProps } from './MarketSection.tsx'
import { downloadMarketFile } from './market-download.ts'
import { marketFailure } from './market-errors.ts'
import type { MarketLocaleKey } from './market-locales.ts'
import type { MarketActions } from './market-mount.ts'
import { matchMarketPresetPortrait, matchUnboundMarketPresetPortrait } from './market-preset-portraits.ts'
import { boundMarketPresentation } from './market-stock-art.ts'
import type { MarketWebActions } from './market-web-types.ts'
import creator from './MarketCreatorPage.module.css'
import market from './MarketSection.module.css'

/** Local authoring modes available in the desktop market. */
export type MarketCreatorKind = 'skill' | 'bot' | 'upload'

/** Authoring callbacks and the capabilities supplied by the active market carrier. */
export type MarketCreatorPageProps = Pick<MarketSectionProps, 't' | 'reportOutcome'> & {
  onBack: () => void
  initialKind?: MarketCreatorKind
} & ({ mode?: 'host'; actions: MarketActions } | { mode: 'web'; actions: MarketWebActions })

type CreatorSource = Awaited<ReturnType<MarketActions['sources']>>
type Publisher = Awaited<ReturnType<MarketActions['identity']>>['publishers'][number]
type ReadState = { phase: 'loading' } | { phase: 'error'; error: MarketLocaleKey } | {
  phase: 'ready'
  signedIn: boolean
  publishers: readonly Publisher[]
  sources?: CreatorSource
}

const authorModes = [
  { kind: 'skill', labelKey: 'creatorNewSkill' },
  { kind: 'bot', labelKey: 'creatorNewBot' },
  { kind: 'upload', labelKey: 'creatorUploadZip' },
] as const

const emptyMetadata = { name: '', title: '', description: '', version: '1.0.0', license: '', category: '', examples: '', requirements: '' }

function isAuthorPackage(item: MarketInstallation): boolean {
  return item.legacySource === undefined && item.release.status === 'draft'
}

/** Render the authoring panel with a separate explicit confirmation for cloud upload.
 * @param props Localized UI, carrier operations and navigation back to the market.
 * @returns The authoring page for the active carrier.
 */
export function MarketCreatorPage(props: MarketCreatorPageProps): ReactNode {
  const { actions, onBack, t, reportOutcome } = props
  const host = props.mode === 'web' ? undefined : props.actions
  const web = props.mode === 'web' ? props.actions : undefined
  const [kind, setKind] = useState<MarketCreatorKind>(props.initialKind ?? 'skill')
  const [read, setRead] = useState<ReadState>({ phase: 'loading' })
  const [attempt, setAttempt] = useState(0)
  const [busy, setBusy] = useState(false)
  const [publisher, setPublisher] = useState('')
  const [bot, setBot] = useState('')
  const [skill, setSkill] = useState('')
  const [botSkills, setBotSkills] = useState<string[]>([])
  const [forms, setForms] = useState({ skill: emptyMetadata, bot: emptyMetadata })
  const [localPackages, setLocalPackages] = useState<MarketInstallation[]>([])
  const [selectedPackage, setSelectedPackage] = useState('')
  const [prepared, setPrepared] = useState<Record<'bot' | 'skill', MarketInstallation | undefined>>({ bot: undefined, skill: undefined })
  const [detail, setDetail] = useState<MarketRelease>()
  const [uploaded, setUploaded] = useState<MarketRelease['id']>()
  const activeOperation = useRef<symbol | null>(null)
  const uploadKeys = useRef(new Map<string, string>())

  useEffect(() => {
    let active = true
    setRead({ phase: 'loading' })
    setBusy(false)
    void Promise.all([
      actions.identity().catch((error: unknown) => {
        if (marketFailure(error) !== 'error.login-required') throw error
        return undefined
      }),
      host?.sources(),
      host?.installed(),
    ]).then(([identity, sources, packages]) => {
      if (!active) return
      const publishers = identity?.publishers ?? []
      setPublisher(publishers[0]?.id ?? '')
      setBot(sources?.bots[0]?.id ?? '')
      setLocalPackages((packages ?? []).filter(isAuthorPackage))
      setRead({ phase: 'ready', signedIn: identity !== undefined, publishers, ...(sources === undefined ? {} : { sources }) })
    }, (error: unknown) => { if (active) setRead({ phase: 'error', error: marketFailure(error) }) })
    return () => { active = false; activeOperation.current = null }
  }, [actions, attempt, host])

  const run = async (operation: (current: () => boolean) => Promise<void>, success: MarketLocaleKey = 'done'): Promise<void> => {
    if (activeOperation.current !== null) return
    const token = Symbol()
    activeOperation.current = token
    setBusy(true)
    const current = (): boolean => activeOperation.current === token
    try { await operation(current); reportOutcome(success, false) }
    catch (error) { reportOutcome(marketFailure(error), true) }
    finally { if (current()) { activeOperation.current = null; setBusy(false) } }
  }

  const isBot = kind === 'bot'
  const formKind = isBot ? 'bot' : 'skill'
  const metadata = forms[formKind]
  const selectedSkills = isBot ? botSkills : skill ? [skill] : []
  const presetPortrait = isBot ? matchMarketPresetPortrait(metadata).id : undefined
  const readyPackage = kind === 'upload' ? localPackages.find(item => item.release.id === selectedPackage)
    : prepared[kind]
  const readyManifest = readyPackage?.release.manifest
  const archivePortrait = readyManifest && matchUnboundMarketPresetPortrait(readyManifest)
  const archivePresentation = kind === 'upload' && readyManifest && boundMarketPresentation(readyManifest, archivePortrait)
  const publishers = read.phase === 'ready' ? read.publishers : []
  const sources = read.phase === 'ready' ? read.sources : undefined
  const acceptPackage = (item: MarketInstallation): void => {
    setLocalPackages(previous => [...previous.filter(row => row.release.id !== item.release.id), item])
    setSelectedPackage(item.release.id)
    setUploaded(undefined)
  }
  const invalidatePrepared = (): void => {
    setPrepared(previous => ({ ...previous, [formKind]: undefined }))
  }
  const prepare = (hostActions: MarketActions): void => {
    void run(async (current) => {
      const manifest: MarketManifest = { ...metadata, formatVersion: 1, kind: formKind, skills: [],
        ...(presetPortrait ? { presetPortrait } : {}), examples: metadata.examples.split('\n').filter(Boolean),
        requirements: metadata.requirements.split('\n').filter(Boolean) }
      const item = await hostActions.prepare(manifest, selectedSkills, isBot ? bot : '')
      if (current()) { setPrepared(previous => ({ ...previous, [formKind]: item })); acceptPackage(item) }
    })
  }
  const importZip = (hostActions: MarketActions, file: File): void => {
    void run(async (current) => {
      if (file.size > 64 * 1024 * 1024) throw Error('expanded-limit')
      const bytes = new Uint8Array(await file.arrayBuffer())
      if (!current()) return
      let encoded = ''
      for (let offset = 0; offset < bytes.length; offset += 16384) encoded += String.fromCharCode(...bytes.subarray(offset, offset + 16384))
      const item = await hostActions.importPackage(btoa(encoded))
      if (current()) acceptPackage(item)
    })
  }
  const upload = (hostActions: MarketActions, id: MarketRelease['id'], portrait?: MarketManifest['presetPortrait']): void => {
    void run(async (current) => {
      const key = `${id}:${publisher}`
      const requestId = uploadKeys.current.get(key) ?? randomUUID()
      uploadKeys.current.set(key, requestId)
      const publisherId = publisher as Parameters<MarketActions['publishDraft']>[1]
      const release = portrait ? await hostActions.publishDraft(id, publisherId, requestId, portrait)
        : await hostActions.publishDraft(id, publisherId, requestId)
      uploadKeys.current.delete(key)
      if (current()) { setUploaded(id); setDetail(release) }
    }, 'draft')
  }
  const publisherField = <label className={market.field}>{t('publisher')}<select value={publisher} disabled={busy || !publishers.length}
    onChange={(event) => { setPublisher(event.target.value); setUploaded(undefined) }}>
    {!publishers.length && <option value="">{t('noPublisher')}</option>}
    {publishers.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}
  </select></label>

  return <section className={market.section}><div className={creator.page}>
    <header className={creator.header}>
      <Button className={creator.back} variant="ghost" disabled={busy} onClick={onBack}>{t('creatorBack')}</Button>
      <div className={creator.heading}><h1 className={creator.title}>{t('creatorTitle')}</h1>
        <p className={creator.description}>{t(web ? 'creatorWebDescription' : 'creatorDescription')}</p></div>
    </header>
    {host && <div className={creator.modeSwitch} role="group" aria-label={t('creatorModes')}>
      {authorModes.map(mode => <Button key={mode.kind} variant="ghost"
        disabled={busy} aria-pressed={kind === mode.kind} onClick={() => { setKind(mode.kind) }}>{t(mode.labelKey)}</Button>)}
    </div>}
    <div className={creator.main} aria-busy={read.phase === 'loading'}>
      {read.phase === 'loading' && <div className={creator.notice} role="status" aria-label={t('loading')}><StateDot state="ongoing" /></div>}
      {read.phase === 'error' && <div className={creator.notice}><p role="alert">{t(read.error)}</p>
        <Button variant="outline" onClick={() => { setAttempt(value => value + 1) }}>{t('retry')}</Button></div>}
      {read.phase === 'ready' && web && (!read.signedIn
        ? <div className={creator.notice}><p>{t('browserSignInHint')}</p><a href="/login">{t('browserSignIn')}</a></div>
        : <MarketBrowserUpload actions={web} publishers={publishers} onUploaded={setDetail} reportOutcome={reportOutcome} t={t} />)}
      {read.phase === 'ready' && host && <>
        {kind === 'upload' ? <div className={`${market.form} ${creator.card}`}>
          <h2 className={creator.sectionTitle}>{t('creatorUploadZip')}</h2>
          {publisherField}
          <label className={market.field}>{t('localPackages')}<select value={selectedPackage} disabled={busy || !localPackages.length}
            onChange={(event) => { setSelectedPackage(event.target.value); setUploaded(undefined) }}>
            <option value="">{t('creatorChooseLocal')}</option>
            {localPackages.map(item => <option key={item.release.id} value={item.release.id}>
              {item.release.manifest.title} · {item.release.manifest.version}
            </option>)}
          </select></label>
          <label className={market.field}>{t('browserArchive')}<input type="file" accept=".zip,application/zip" disabled={busy}
            onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; if (file) importZip(host, file) }} /></label>
        </div> : <div className={`${market.authorLayout} ${creator.layout}`}>
          <form className={`${market.form} ${creator.card}`} onSubmit={(event) => { event.preventDefault(); prepare(host) }}>
            <h2 className={creator.sectionTitle}>{t('publicationInfo')}</h2><p className={creator.sectionHint}>{t('prepareDescription')}</p>
            {isBot && <label className={market.field}>{t('sourceBot')}<select value={bot} disabled={busy || !sources?.bots.length}
              onChange={(event) => { setBot(event.target.value); invalidatePrepared() }}>
              {!sources?.bots.length && <option value="">{t('creatorNoBots')}</option>}
              {sources?.bots.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select></label>}
            <fieldset className={`${market.skills} ${creator.sources}`} disabled={busy}>
              <legend>{t(isBot ? 'sourceSkills' : 'creatorSourceSkill')}</legend>
              {!sources?.skills.length && <span>{t('creatorNoSkills')}</span>}
              {sources?.skills.map(item => <label key={item.name}>
                {isBot ? <input type="checkbox" checked={botSkills.includes(item.name)}
                  onChange={(event) => {
                    invalidatePrepared()
                    setBotSkills(previous => event.target.checked ? [...previous, item.name] : previous.filter(name => name !== item.name))
                  }} />
                  : <input type="radio" name="market-skill" checked={skill === item.name} onChange={() => { setSkill(item.name); invalidatePrepared() }} />}
                {item.name}</label>)}
            </fieldset>
            {publisherField}
            <div className={creator.fields}>
              {(['title', 'name', 'version', 'description', 'license', 'category', 'examples', 'requirements'] as const).map((key) => {
                const short = key === 'name' || key === 'version' || key === 'license' || key === 'category'
                return <label key={key} className={short ? market.field : `${market.field} ${creator.fullField}`}>
                  {t(key === 'title' ? 'label' : key === 'description' ? 'summary' : key)}
                  <Input value={metadata[key]} disabled={busy} required={key !== 'examples' && key !== 'requirements'}
                    onChange={(event) => {
                      const value = event.target.value
                      invalidatePrepared()
                      setForms(previous => ({ ...previous, [formKind]: { ...previous[formKind], [key]: value } }))
                    }} />
                </label>
              })}
            </div>
            <Button type="submit" variant="primary" disabled={busy || (isBot ? !bot : !skill)}>{t('prepare')}</Button>
          </form>
          <div className={creator.preview}><MarketAuthorPreview key={isBot ? bot : 'skill'} metadata={metadata}
            version={metadata.version} publisher={publishers.find(item => item.id === publisher)?.title ?? ''}
            bot={isBot} skillNames={selectedSkills} t={t} presetPortrait={presetPortrait} /></div>
        </div>}
        {readyPackage && <section className={`${market.form} ${creator.card}`}>
          <h2 className={creator.sectionTitle}>{t('creatorPrepared')}</h2>
          {kind === 'upload' && readyPackage.release.manifest.kind === 'skill' && <MarketSkillArtwork
            metadata={readyPackage.release.manifest} label={readyPackage.release.manifest.title} />}
          {archivePresentation && <>
            <MarketCharacter presentation={archivePresentation} introduceLabel={t('introduce')} sampleLabel={t('samplePortrait')} />
            <p className={market.previewHint}>{t('boundPortraitHint')}</p>
          </>}
          <p>{readyPackage.release.manifest.title} · {readyPackage.release.manifest.version}</p>
          <p className={creator.sectionHint}>{readyPackage.release.manifest.description}</p>
          <div className={creator.actions}>
            <Button variant="outline" disabled={busy} onClick={() => void run(async (current) => {
              const file = await host.exportPackage(readyPackage.release.id)
              if (current()) downloadMarketFile({ name: file.name, bytes: Uint8Array.from(atob(file.base64), char => char.charCodeAt(0)) })
            })}>{t('export')}</Button>
            <Button variant="primary" disabled={busy || !publisher || uploaded === readyPackage.release.id}
              onClick={() => { upload(host, readyPackage.release.id, archivePortrait) }}>{t('upload')}</Button>
          </div>
        </section>}
      </>}
    </div>
    <MarketReleaseDetails release={detail} enabledOriginalSkill={false} onClose={() => { setDetail(undefined) }} t={t} />
  </div></section>
}
