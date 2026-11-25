/** The 剧本 tab of the Bot team's details drawer opens drafts and finalized scripts. */
import { useId, useState } from 'react'
import { Button, Input, SegmentedTabs } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MuseDataPlatform, MuseDataWorkDetail } from '@deepseek-ai/dsh-muse-account/types'
import type { ScriptDetail, ScriptPerson, ScriptPickRequest, ScriptProductionRequest, ScriptStatus, ScriptSummary } from '@deepseek-ai/dsh-workbench-connection/types'
import { address, useAction, type Read, type Text } from './Production.tsx'
import { DraftLibrary, DraftView, type DraftActions } from './DrawerScriptDraft.tsx'
import data from './DrawerData.module.css'
import css from './DrawerScripts.module.css'

type Key = Parameters<Text>[0]
type Stage = ScriptStatus | 'all'

const PAGE = 50
const STAGES: readonly [Stage, Key][] = [['all', 'all'], ['waiting', 'stageWaiting'], ['picked', 'stagePicked'], ['in_production', 'stageInProduction']]
const STAGE_LABELS: Record<ScriptStatus, Key> = { waiting: 'stageWaiting', picked: 'stagePicked', in_production: 'stageInProduction' }
const PLATFORMS: Record<MuseDataPlatform, { name: Key; glyph: Key }> = {
  hongguo: { name: 'platformHongguo', glyph: 'glyphHongguo' },
  douyin: { name: 'platformDouyin', glyph: 'glyphDouyin' },
  lvpaopao: { name: 'platformLvpaopao', glyph: 'glyphLvpaopao' },
  fanqie: { name: 'platformFanqie', glyph: 'glyphFanqie' },
  qimao: { name: 'platformQimao', glyph: 'glyphQimao' },
}
/** Metrics the origin card shows at most. */
const ORIGIN_METRICS = 4

/** An open script as the drawer's strip names it. */
export interface OpenScript {
  readonly id: string
  readonly title: string
}

/** What the drawer's owner hands the tab. */
export interface DrawerScriptsProps {
  t: Text
  useResource: Read
  useAccountEpoch: <T>(select: (value: number) => T) => T
  /** The script the tab in view shows, or null on the tab that lists them. */
  script: OpenScript | null
  /** Open a script in a tab of its own. */
  openScript: (script: OpenScript) => void
  /** Put a reference above the message box of the drawer's conversation. */
  quote: (text: string) => void
  /** Put a prepared request into the drawer conversation's message box for the user to send. */
  compose: (text: string) => void
  /** Pick one version for production as the signed-in member. */
  pick: (request: ScriptPickRequest) => Promise<void>
  /** Record the Jingliu project a picked script became. */
  link: (request: ScriptProductionRequest) => Promise<void>
  /** Draft edits and finalization use the current account's server permissions. */
  draftActions: DraftActions
}

/**
 * Browse draft and finalized scripts inside the Bot team's details drawer.
 * @param props - Library resources for the current login, the open script and the conversation's message box.
 * @returns The script list, an open draft, or an open finalized script.
 */
export function DrawerScripts(props: DrawerScriptsProps) {
  const epoch = props.useAccountEpoch(n => n)
  const draftKey = /^draft:([1-9]\d*)$/u.exec(props.script?.id ?? '')?.[1]
  const draftId = Number(draftKey)
  if (Number.isSafeInteger(draftId) && draftId > 0) return <DraftView key={`${epoch}:draft:${draftId}`}
    {...props} epoch={epoch} draftId={draftId} />
  const id = props.script === null ? Number.NaN : Number(props.script.id)
  return Number.isSafeInteger(id) && id > 0
    ? <ScriptView key={`${epoch}:${id}`} {...props} epoch={epoch} id={id} />
    : <ScriptLibraries key={epoch} {...props} epoch={epoch} />
}

type LibraryView = 'finalized' | 'drafts'

function ScriptLibraries(props: DrawerScriptsProps & { epoch: number }) {
  const [view, choose] = useState<LibraryView>('drafts')
  const group = useId()
  const tabs = [
    { value: 'drafts', label: props.t('scriptDrafts'), id: `${group}-drafts`, panelId: `${group}-drafts-panel` },
    { value: 'finalized', label: props.t('scriptLibrary'), id: `${group}-finalized`, panelId: `${group}-finalized-panel` },
  ] as const
  return <div className={css.libraries}>
    <SegmentedTabs items={tabs} value={view} onChange={choose} label={props.t('scriptCollections')}
      size="sm" className={css.libraryTabs} />
    {tabs.map(tab => <div key={tab.value} role="tabpanel" className={css.libraryPanel} id={tab.panelId}
      aria-labelledby={tab.id} hidden={tab.value !== view}>
      {tab.value === view && (view === 'drafts' ? <DraftLibrary {...props} /> : <Library {...props} />)}
    </div>)}
  </div>
}

function compact(value: number, t: Text): string {
  return new Intl.NumberFormat(t('numberLocale'), { notation: 'compact', maximumFractionDigits: 1 }).format(value)
}

function day(value: string, t: Text): string {
  const time = new Date(value)
  return Number.isNaN(time.getTime()) ? '' : new Intl.DateTimeFormat(t('numberLocale'), { dateStyle: 'medium' }).format(time)
}

function personName(person: ScriptPerson, t: Text): string {
  return person.name ?? t('memberName', { id: String(person.id) })
}

function formOf(script: ScriptSummary, t: Text): string {
  return t(script.kind === 'narration' ? 'typeNarration' : 'typeDrama') + ' · ' + t(script.style === '3d' ? 'look3d' : 'lookLive')
}

function firstLetter(title: string): string {
  return Array.from(title.trim())[0] ?? '·'
}

function Library({ epoch, t, useResource, openScript }: DrawerScriptsProps & { epoch: number }) {
  const [stage, setStage] = useState<Stage>('all')
  const [mine, setMine] = useState(false)
  const [draft, setDraft] = useState('')
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(1)
  const [revision, refresh] = useState(0)
  const list = useResource<'workshop-scripts'>(address('workshop-scripts', epoch, revision, {
    status: stage === 'all' ? '' : stage, q: query, mine: mine ? '1' : '', page: String(page), limit: String(PAGE),
  }))
  const counts = list.value?.counts
  const countOf: Record<Stage, number | undefined> = {
    all: counts?.all, waiting: counts?.waiting, picked: counts?.picked, in_production: counts?.inProduction,
  }
  const total = list.value?.total ?? 0
  return <section className={css.drawer} aria-label={t('scriptLibrary')}>
    <form className={data.search} role="search" onSubmit={(e) => { e.preventDefault(); setQuery(draft.trim()); setPage(1) }}>
      <Input aria-label={t('searchScripts')} placeholder={t('searchScripts')} maxLength={200} value={draft}
        onChange={(e) => { setDraft(e.target.value); if (e.target.value.trim() === '') { setQuery(''); setPage(1) } }} />
    </form>
    <div className={data.chips} role="group" aria-label={t('scriptFilter')}>
      {STAGES.map(([value, label]) => <button key={value} type="button" className={data.chip} aria-pressed={stage === value} onClick={() => { setStage(value); setPage(1) }}>
        {t(label)}{countOf[value] !== undefined && <small className={data.count}>{countOf[value]}</small>}
      </button>)}
      <button type="button" className={data.chip} aria-pressed={mine} onClick={() => { setMine(on => !on); setPage(1) }}>{t('onlyMine')}</button>
    </div>
    {list.status === 'failed' ? <Failure t={t} text="scriptsFailed" retry={() => { refresh(n => n + 1) }} />
      : list.value === undefined ? <p className={data.quiet}>{t('loading')}</p>
        : list.value.items.length === 0 ? <p className={data.quiet}>{t('nothingHere')}</p>
          : <ul className={css.list}>{list.value.items.map(item => <li key={item.id}>
            <button type="button" className={css.card} onClick={() => { openScript({ id: String(item.id), title: item.title }) }}>
              <span className={css.letter} aria-hidden="true">{firstLetter(item.title)}</span>
              <span className={data.text}>
                <strong>{item.title}</strong>
                <small>{[personName(item.owner, t), t('episodeCount', { count: String(item.episodes) }), t('wordsValue', { value: compact(item.words, t) }), formOf(item, t)].join(' · ')}</small>
              </span>
              <span className={`${css.stage} ${css[item.status]}`}>{t(STAGE_LABELS[item.status])}</span>
            </button>
          </li>)}</ul>}
    {total > PAGE && <div className={data.pages}>
      <Button variant="ghost" size="sm" disabled={page === 1} onClick={() => { setPage(n => Math.max(1, n - 1)) }}>{t('previous')}</Button>
      <Button variant="ghost" size="sm" disabled={page * PAGE >= total} onClick={() => { setPage(n => n + 1) }}>{t('next')}</Button>
    </div>}
  </section>
}

function ScriptView({ epoch, id, t, useResource, quote, compose, pick, link }: DrawerScriptsProps & { epoch: number; id: number }) {
  const [version, setVersion] = useState<number | undefined>()
  const [revision, refresh] = useState(0)
  const detail = useResource<'workshop-script'>(address('workshop-script', epoch, revision, {
    id: String(id), ...(version === undefined ? {} : { version: String(version) }),
  }))
  if (detail.status === 'failed') return <section className={css.drawer}><Failure t={t} text="scriptsFailed" retry={() => { refresh(n => n + 1) }} /></section>
  if (detail.value === undefined) return <section className={css.drawer}><p className={data.quiet}>{t('loading')}</p></section>
  return <ScriptPage key={detail.value.content.version} detail={detail.value} epoch={epoch} t={t} useResource={useResource}
    quote={quote} compose={compose} pick={pick} link={link} chooseVersion={setVersion} reload={() => { refresh(n => n + 1) }} />
}

type PageProps = Pick<DrawerScriptsProps, 't' | 'useResource' | 'quote' | 'compose' | 'pick' | 'link'> & {
  detail: ScriptDetail
  epoch: number
  chooseVersion: (version: number) => void
  reload: () => void
}

function ScriptPage({ detail, epoch, t, useResource, quote, compose, pick, link, chooseVersion, reload }: PageProps) {
  const { script, versions, content, canPick } = detail
  const [order, setOrder] = useState(content.episodes[0]?.order ?? 0)
  const [origin, setOrigin] = useState(false)
  const [linking, setLinking] = useState(false)
  const picking = useAction()
  const shown = content.episodes.find(episode => episode.order === order) ?? content.episodes[0]
  const reference = { title: script.title, version: String(content.version), id: String(script.id) }
  const status = script.status === 'picked' && script.picked !== null
    ? t('pickedBy', { version: String(script.picked.version), name: personName(script.picked.by, t) })
    : script.status === 'in_production' && script.project !== null ? t('inProductionAs', { title: script.project.title }) : t(STAGE_LABELS[script.status])
  const canPickShown = canPick && script.status !== 'in_production' && script.picked?.version !== content.version
  const picked = canPick && script.status === 'picked'
  return <section className={css.script} aria-label={script.title}>
    <aside className={css.side} aria-label={t('scriptParams')}>
      <dl className={css.params}>
        <div><dt>{t('scriptName')}</dt><dd>{script.title}</dd></div>
        <div><dt>{t('scriptOwner')}</dt><dd>{personName(script.owner, t)}</dd></div>
        <div><dt>{t('scriptRights')}</dt><dd>{t(script.rights === 'licensed' ? 'rightsLicensed' : 'rightsOriginal')}</dd></div>
        <div><dt>{t('scriptOrigin')}</dt><dd>{script.originWorkId === null ? script.originTitle ?? '—'
          : <button type="button" className={css.origin} aria-expanded={origin} onClick={() => { setOrigin(open => !open) }}>{script.originTitle ?? script.originWorkId}</button>}</dd></div>
        <div><dt>{t('scriptForm')}</dt><dd>{formOf(script, t)}</dd></div>
        <div><dt>{t('scriptEpisodes')}</dt><dd>{content.episodes.length}</dd></div>
        <div><dt>{t('scriptWords')}</dt><dd>{t('wordsValue', { value: compact(versions.find(entry => entry.number === content.version)?.words ?? script.words, t) })}</dd></div>
        <div><dt>{t('scriptVersion')}</dt><dd>{versions.length > 1
          ? <select className={css.select} aria-label={t('scriptVersion')} value={content.version} onChange={(e) => { chooseVersion(Number(e.target.value)) }}>
            {versions.map(entry => <option key={entry.number} value={entry.number}>{t('versionLabel', { number: entry.number })}{entry.createdAt === null ? '' : ' · ' + day(entry.createdAt, t)}</option>)}
          </select>
          : t('versionLabel', { number: content.version })}</dd></div>
        <div><dt>{t('scriptStage')}</dt><dd>{status}</dd></div>
      </dl>
      {origin && script.originWorkId !== null && <OriginCard workId={script.originWorkId} epoch={epoch} t={t} useResource={useResource} />}
      <div className={css.actions}>
        {canPickShown && <Button size="sm" variant="primary" disabled={picking.busy}
          onClick={() => { void picking.run(async () => { await pick({ id: script.id, version: content.version }); reload() }) }}>{t('pickVersion')}</Button>}
        {picking.error && <small role="alert" className={css.failed}>{t('pickFailed')}</small>}
        {picked && <Button size="sm" variant="outline" onClick={() => {
          compose(t('scriptProjectRequest', { ...reference, version: String(script.picked?.version ?? content.version), form: t(script.kind === 'narration' ? 'typeNarration' : 'typeDrama'), look: t(script.style === '3d' ? 'look3d' : 'lookLive'), episodes: String(script.episodes) }))
        }}>{t('newJingliuProject')}</Button>}
        {picked && <Button size="sm" variant="ghost" aria-expanded={linking} onClick={() => { setLinking(open => !open) }}>{t('linkProject')}</Button>}
        {linking && <LinkCard scriptId={script.id} epoch={epoch} t={t} useResource={useResource} link={link}
          done={() => { setLinking(false); reload() }} />}
        <Button size="sm" variant="ghost" onClick={() => { quote(t('scriptReference', reference)) }}>{t('quoteAsset')}</Button>
      </div>
    </aside>
    <div className={css.body}>
      {content.episodes.length > 1 && <div className={data.chips} role="group" aria-label={t('scriptEpisodes')}>
        {content.episodes.map(episode => <button key={episode.order} type="button" className={data.chip} aria-pressed={episode.order === shown?.order}
          onClick={() => { setOrder(episode.order) }}>{t('episodeTab', { order: String(episode.order) })}</button>)}
      </div>}
      {shown === undefined ? <p className={data.quiet}>{t('nothingHere')}</p> : <article className={css.page}>
        <header className={css.episodeHead}>
          <h3>{shown.title || t('episodeTab', { order: String(shown.order) })}</h3>
          <button type="button" className={data.quote} aria-label={t('quoteAsset')} title={t('quoteAsset')}
            onClick={() => { quote(t('episodeReference', { ...reference, order: String(shown.order) })) }}>
            <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
              <path d="M20 15a2 2 0 0 1-2 2H8l-4 4V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2z" /><path d="M9 10h6" />
            </svg>
          </button>
        </header>
        <ScriptText text={shown.content} />
      </article>}
    </div>
  </section>
}

const SCENE = /^(?:[0-9]{1,3}\s*[-－—]\s*[0-9]{1,3}|第\s*[0-9]{1,3}\s*场|场景\s*[0-9]|【[^】]{0,40}】$)/u
const ACTION = /^[△▲※]/u
const SPEECH = /^([^\s：:，。！？「」（）()]{1,12})((?:（[^）]{0,16}）|\([^)]{0,16}\))?)\s*[：:]\s*(.+)$/u

/** One script line as the page sets it: a scene heading, an action line, a spoken line, or plain text. */
function ScriptText({ text }: { text: string }) {
  const lines = text.split(/\r?\n/u).map(line => line.trim()).filter(line => line !== '')
  return <>{lines.map((line, index) => {
    const key = String(index)
    if (/^#{1,6}\s/u.test(line) || SCENE.test(line)) return <h4 key={key} className={css.scene}>{line.replace(/^#{1,6}\s*/u, '')}</h4>
    if (ACTION.test(line)) return <p key={key} className={css.action}>{line}</p>
    const speech = SPEECH.exec(line)
    if (speech !== null) return <p key={key} className={css.speech}><b>{speech[1]}{speech[2]}</b>{speech[3]}</p>
    return <p key={key} className={css.line}>{line}</p>
  })}</>
}

function OriginCard({ workId, epoch, t, useResource }: { workId: string; epoch: number; t: Text; useResource: Read }) {
  const [revision, refresh] = useState(0)
  const work = useResource<'muse-data-work'>(address('muse-data-work', epoch, revision, { id: workId }))
  if (work.status === 'failed') return <div className={css.originCard}><Failure t={t} text="dataFailed" retry={() => { refresh(n => n + 1) }} /></div>
  if (work.value === undefined) return <div className={css.originCard}><p className={data.quiet}>{t('loading')}</p></div>
  return <OriginWork work={work.value} t={t} />
}

function OriginWork({ work, t }: { work: MuseDataWorkDetail; t: Text }) {
  const platform = PLATFORMS[work.platform]
  const metrics = work.metrics
    .filter((metric): metric is typeof metric & { readonly value: number } => metric.value !== null)
    .slice(0, ORIGIN_METRICS)
  const facts = [
    work.rank === null ? work.board : t('originRank', { board: work.board, rank: String(work.rank) }),
    work.episodeCount === null ? '' : t('episodeCount', { count: String(work.episodeCount) }),
    work.wordCount === null ? '' : t('wordsValue', { value: compact(work.wordCount, t) }),
  ].filter(Boolean)
  return <div className={css.originCard} aria-label={t('originData')}>
    <div className={css.originHead}>
      <span aria-hidden="true" className={`${data.glyph} ${data[work.platform]}`}>{t(platform.glyph)}</span>
      <span className={data.text}><strong>{work.title ?? work.sourceId}</strong><small>{[t(platform.name), work.author ?? ''].filter(Boolean).join(' · ')}</small></span>
    </div>
    {facts.length > 0 && <p className={data.quiet}>{facts.join(' · ')}</p>}
    {metrics.length > 0 && <dl className={css.metrics}>{metrics.map(metric => <div key={metric.key}>
      <dt>{metric.label}</dt><dd>{compact(metric.value, t)}</dd>
    </div>)}</dl>}
    {work.tags.length > 0 && <p className={data.quiet}>{work.tags.slice(0, 6).join(' · ')}</p>}
    {day(work.observedAt, t) !== '' && <small className={data.quiet}>{t('observedAt', { date: day(work.observedAt, t) })}</small>}
  </div>
}

function LinkCard({ scriptId, epoch, t, useResource, link, done }: Pick<DrawerScriptsProps, 't' | 'useResource' | 'link'> & { scriptId: number; epoch: number; done: () => void }) {
  const [revision, refresh] = useState(0)
  const projects = useResource<'jingliu-projects'>(address('jingliu-projects', epoch, revision))
  const [chosen, setChosen] = useState('')
  const act = useAction()
  if (projects.status === 'failed') return <Failure t={t} text="failed" retry={() => { refresh(n => n + 1) }} />
  if (projects.value === undefined) return <p className={data.quiet}>{t('loading')}</p>
  const project = projects.value.find(entry => entry.id === chosen) ?? projects.value[0]
  if (project === undefined) return <p className={data.quiet}>{t('emptyProjects')}</p>
  return <div className={css.link}>
    <select className={css.select} aria-label={t('chooseProject')} value={project.id} onChange={(e) => { setChosen(e.target.value) }}>
      {projects.value.map(entry => <option key={entry.id} value={entry.id}>{entry.title}</option>)}
    </select>
    <Button size="sm" variant="primary" disabled={act.busy}
      onClick={() => { void act.run(async () => { await link({ id: scriptId, projectId: project.id, projectTitle: project.title }); done() }) }}>{t('linkProject')}</Button>
    {act.error && <small role="alert" className={css.failed}>{t('linkFailed')}</small>}
  </div>
}

function Failure({ t, text, retry }: { t: Text; text: Key; retry: () => void }) {
  return <div className={data.failure} role="alert">{t(text)} <Button variant="ghost" size="sm" onClick={retry}>{t('refresh')}</Button></div>
}
