/** Browse workshop drafts, review one episode, and confirm its finalization. */
import { useId, useRef, useState } from 'react'
import { Button, DiffBlock, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  ScriptDraft, ScriptDraftCandidateRequest, ScriptDraftEpisode, ScriptDraftFinalizeRequest, ScriptDraftSaveRequest, ScriptSummary,
} from '@deepseek-ai/dsh-workbench-connection/types'
import type { OpenScript } from './DrawerScripts.tsx'
import { address, type Read, type Text } from './Production.tsx'
import data from './DrawerData.module.css'
import scripts from './DrawerScripts.module.css'
import css from './DrawerScriptDraft.module.css'

/** Mutations permitted by the workshop account and performed through the Host. */
export interface DraftActions {
  saveEpisode(request: ScriptDraftSaveRequest): Promise<ScriptDraftEpisode>
  applyCandidate(request: ScriptDraftCandidateRequest): Promise<ScriptDraftEpisode>
  discardCandidate(request: ScriptDraftCandidateRequest): Promise<ScriptDraftEpisode>
  finalizeDraft(request: ScriptDraftFinalizeRequest): Promise<ScriptSummary>
}

interface LibraryProps {
  epoch: number
  openScript: (script: OpenScript) => void
  t: Text
  useResource: Read
}

const DRAFT_PAGE = 30

/**
 * Find drafts accessible to the current account and open one in the Bot drawer.
 * @param props - The account, drawer command, locale and resource reader.
 * @returns The search form and one page of matching drafts.
 */
export function DraftLibrary({ epoch, openScript, t, useResource }: LibraryProps) {
  const [search, setSearch] = useState('')
  const [query, setQuery] = useState('')
  const [offset, setOffset] = useState(0)
  const [revision, refresh] = useState(0)
  const list = useResource<'workshop-drafts'>(address('workshop-drafts', epoch, revision, {
    query, offset: String(offset), limit: String(DRAFT_PAGE),
  }))
  return <section className={scripts.drawer} aria-label={t('scriptDrafts')}>
    <form className={data.search} role="search" onSubmit={(event) => { event.preventDefault(); setQuery(search.trim()); setOffset(0) }}>
      <Input aria-label={t('searchScripts')} placeholder={t('searchScripts')} maxLength={100} value={search}
        onChange={(event) => { setSearch(event.target.value); if (event.target.value.trim() === '') { setQuery(''); setOffset(0) } }} />
    </form>
    {list.status === 'failed' ? <ReadFailure t={t} retry={() => { refresh(count => count + 1) }} />
      : list.value === undefined ? <p className={data.quiet} role="status">{t('loading')}</p>
        : list.value.items.length === 0 ? <p className={data.quiet}>{t('nothingHere')}</p>
          : <ul className={scripts.list}>{list.value.items.map(item => <li key={item.id}>
            <button type="button" className={scripts.card} onClick={() => { openScript({ id: 'draft:' + String(item.id), title: item.title }) }}>
              <span className={data.text}>
                <strong>{item.title}</strong>
                <small>{t('episodeCount', { count: String(item.episodeCount) })}</small>
              </span>
            </button>
          </li>)}</ul>}
    {(offset > 0 || typeof list.value?.nextOffset === 'number') && <div className={data.pages}>
      <Button variant="ghost" size="sm" disabled={offset === 0} onClick={() => { setOffset(current => Math.max(0, current - DRAFT_PAGE)) }}>{t('previous')}</Button>
      <Button variant="ghost" size="sm" disabled={typeof list.value?.nextOffset !== 'number'} onClick={() => {
        if (typeof list.value?.nextOffset === 'number') setOffset(list.value.nextOffset)
      }}>{t('next')}</Button>
    </div>}
  </section>
}

interface DraftViewProps extends LibraryProps {
  draftId: number
  draftActions: DraftActions
  quote: (text: string) => void
}

/**
 * Open a working draft in its own drawer tab.
 * @param props - The selected draft, its account and drawer commands.
 * @returns The episode reader and draft actions.
 */
export function DraftView(props: DraftViewProps) {
  const { draftId, epoch, t, useResource } = props
  const [recheck, refresh] = useState(0)
  const detail = useResource<'workshop-draft'>(address('workshop-draft', epoch, recheck, { id: String(draftId) }))
  if (detail.status === 'failed') return <section className={scripts.drawer}><ReadFailure t={t} retry={() => { refresh(count => count + 1) }} /></section>
  if (detail.value === undefined) return <section className={scripts.drawer}><p className={data.quiet} role="status">{t('loading')}</p></section>
  return <WorkingDraft {...props} draft={detail.value} />
}

function WorkingDraft(props: DraftViewProps & { draft: ScriptDraft }) {
  const { draftId, epoch, t, useResource } = props
  const [selected, select] = useState<number | undefined>()
  const [revision, setRevision] = useState(0)
  const [needsReview, setNeedsReview] = useState(false)
  const [finalize, setFinalize] = useState(0)
  const [confirming, setConfirming] = useState<string | null>(null)
  const refreshed = useResource<'workshop-draft'>(revision === 0 ? 'studio://inactive'
    : address('workshop-draft', epoch, revision, { id: String(draftId), refresh: '1' }))
  const draft = refreshed.value ?? props.draft
  const ready = revision === 0 || refreshed.status === 'live'
  const episode = draft.episodes.find(item => item.episode === selected)?.episode ?? draft.episodes[0]?.episode
  const confirm = () => { setFinalize(value => value + 1); setConfirming(draft.revision) }
  const review = () => { setNeedsReview(false); setRevision(value => value + 1) }
  return <section className={css.draft} aria-label={draft.title}>
    <header className={css.header}><h2>{draft.title}</h2></header>
    {needsReview && <p className={data.quiet}>{t('reviewBeforeFinalizing')}</p>}
    {refreshed.status === 'failed' && revision !== 0 && <ReadFailure t={t} retry={review} />}
    {episode === undefined ? <p className={data.quiet}>{t('emptyEpisodes')}</p>
      : <EpisodeEditor key={episode} {...props} draft={draft} episode={episode} selectEpisode={select} confirm={confirm}
        finalizeReady={ready && !needsReview} refreshDraft={review} draftChanged={() => { setNeedsReview(true) }} />}
    {confirming !== null && <FinalizeDraft key={finalize} {...props} refresh={finalize} baseRevision={confirming}
      close={() => { setConfirming(null) }} />}
  </section>
}

function ReadFailure({ t, retry }: { t: Text; retry: () => void }) {
  return <div className={data.failure} role="alert"><span>{t('draftsFailed')}</span>
    <Button variant="ghost" size="sm" onClick={retry}>{t('retry')}</Button></div>
}

interface MutationState {
  busy: boolean
  problem: 'failed' | 'conflict' | null
  reset: () => void
  run(action: () => Promise<void>): Promise<void>
}

function useMutation(): MutationState {
  const inFlight = useRef(false)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<MutationState['problem']>(null)
  return { busy, problem, reset: () => { setProblem(null) }, run: async (action) => {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setProblem(null)
    try { await action() }
    catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
      setProblem(code === 'SCRIPT_EDITOR_VERSION_CHANGED' || code === 'SCRIPT_EDITOR_CANDIDATE_CHANGED' ? 'conflict' : 'failed')
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  } }
}

interface EpisodeEditorProps extends DraftViewProps {
  draft: ScriptDraft
  episode: number
  selectEpisode: (episode: number) => void
  confirm: () => void
  finalizeReady: boolean
  refreshDraft: () => void
  draftChanged: () => void
}

function EpisodeEditor({
  draft, episode, selectEpisode, confirm, finalizeReady, refreshDraft, draftChanged, epoch, t, useResource, draftActions, quote,
}: EpisodeEditorProps) {
  const [revision, refresh] = useState(0)
  const [receipt, setReceipt] = useState<ScriptDraftEpisode>()
  const [manual, setManual] = useState<string | null>(null)
  const [showCurrent, setShowCurrent] = useState(false)
  const [saved, setSaved] = useState(false)
  const write = useMutation()
  const detail = useResource<'workshop-draft-episode'>(address('workshop-draft-episode', epoch, revision, {
    id: String(draft.id), episode: String(episode),
  }))
  const value = receipt ?? detail.value
  const candidate = value?.candidate ?? null
  const episodeLabel = t('episodeNumber', { number: String(episode) })
  const staleCandidate = candidate !== null && candidate.baseRevision !== value?.revision
  const reread = () => {
    setReceipt(undefined)
    setSaved(false)
    setShowCurrent(false)
    write.reset()
    refresh(count => count + 1)
    refreshDraft()
  }
  const save = (action: () => Promise<ScriptDraftEpisode>, changed: boolean) => {
    setSaved(false)
    void write.run(async () => {
      setReceipt(await action())
      setManual(null)
      setShowCurrent(false)
      setSaved(changed)
      if (changed) draftChanged()
    })
  }
  return <>
    <div className={css.toolbar}>
      <select className={css.select} aria-label={t('scriptEpisodes')} value={episode}
        disabled={write.busy || manual !== null} onChange={(event) => { selectEpisode(Number(event.target.value)) }}>
        {draft.episodes.map(item => <option key={item.episode} value={item.episode}>
          {t('episodeNumber', { number: String(item.episode) })}{item.title ? ' · ' + item.title : ''}
        </option>)}
      </select>
      <div className={css.controls}>
        <Button variant="ghost" size="sm" disabled={write.busy || manual !== null} onClick={reread}>{t('refresh')}</Button>
        <Button variant="ghost" size="sm" onClick={() => { quote(t('draftEpisodeReference', {
          title: draft.title, id: String(draft.id), episode: String(episode),
        })) }}>{t('quoteAsset')}</Button>
        {draft.canFinalize && <Button variant="outline" size="sm" disabled={!finalizeReady || value === undefined || write.busy || manual !== null}
          onClick={confirm}>{t('finalizeDraft')}</Button>}
      </div>
    </div>
    <div className={css.reading}>
      {detail.status === 'failed' && value === undefined ? <ReadFailure t={t} retry={reread} />
        : value === undefined ? <p className={data.quiet} role="status">{t('loading')}</p>
          : <>
            <div className={css.episodeBar}>
              <h3>{value.title || episodeLabel}</h3>
              <span className={data.quiet}>{t('versionLabel', { number: value.version })}</span>
              {manual === null && (candidate === null || showCurrent) && <Button variant="ghost" size="sm" disabled={write.busy}
                onClick={() => { setManual(value.content); write.reset() }}>{t('editEpisode')}</Button>}
              {candidate !== null && manual === null && <Button variant="ghost" size="sm" disabled={write.busy}
                onClick={() => { setShowCurrent(current => !current) }}>{t(showCurrent ? 'candidateChanges' : 'currentDraft')}</Button>}
            </div>
            {write.problem !== null && <p className={scripts.failed} role="alert">{t(write.problem === 'conflict' ? 'draftConflict' : 'draftSaveFailed')}</p>}
            {saved && <p className={data.quiet} role="status">{t('draftSaved')}</p>}
            {manual !== null ? <form className={css.editor} onSubmit={(event) => {
              event.preventDefault()
              if (manual.trim() !== '' && manual !== value.content) save(() => draftActions.saveEpisode({
                draftId: draft.id, episode, baseRevision: value.revision, content: manual,
              }), true)
            }}>
              <textarea aria-label={t('editEpisode')} className={css.manuscript} value={manual} disabled={write.busy}
                onChange={(event) => { setManual(event.target.value) }} />
              <div className={css.controls}>
                <Button variant="ghost" size="sm" disabled={write.busy} onClick={() => { setManual(null); write.reset() }}>{t('cancel')}</Button>
                <Button variant="primary" size="sm" type="submit" disabled={write.busy || manual.trim() === '' || manual === value.content}>{t('save')}</Button>
              </div>
            </form> : candidate !== null && !showCurrent ? <section className={css.candidate} aria-label={t('candidateChanges')}>
              {candidate.summary !== '' && <p className={css.summary}>{candidate.summary}</p>}
              {staleCandidate ? <p className={scripts.failed} role="status">{t('draftConflict')}</p>
                : <DiffBlock diffs={[{ path: episodeLabel, oldText: value.content, newText: candidate.content }]} labels={{
                  codeLabel: t('candidateChanges'), copy: t('copyShot'), copied: t('diffCopied'),
                  wrapLabel: t('diffWrap'), unwrapLabel: t('diffUnwrap'), collapse: t('diffCollapse'),
                  expand: count => t('diffExpand', { count }), collapseAria: t('diffCollapse'),
                  expandAria: count => t('diffExpand', { count }),
                }} />}
              <div className={css.controls}>
                <Button variant="ghost" size="sm" disabled={write.busy}
                  onClick={() => { save(() => draftActions.discardCandidate({ draftId: draft.id, episode, candidateId: candidate.id }), false) }}>{t('discardDraftCandidate')}</Button>
                <Button variant="primary" size="sm" disabled={write.busy || staleCandidate || write.problem === 'conflict'}
                  onClick={() => { save(() => draftActions.applyCandidate({ draftId: draft.id, episode, candidateId: candidate.id }), true) }}>{t('applyDraftCandidate')}</Button>
              </div>
            </section> : <div className={css.manuscript}>{value.content || t('nothingHere')}</div>}
          </>}
    </div>
  </>
}

function FinalizeDraft({ draftId, epoch, t, useResource, draftActions, openScript, refresh, baseRevision, close }:
  DraftViewProps & { refresh: number; baseRevision: string; close: () => void }) {
  const durable = useResource<'workshop-draft'>(address('workshop-draft', epoch, refresh, { id: String(draftId), confirmation: '1' }))
  const [rights, setRights] = useState<ScriptDraftFinalizeRequest['rights']>()
  const [kind, setKind] = useState<ScriptDraftFinalizeRequest['kind']>('drama')
  const [style, setStyle] = useState<ScriptDraftFinalizeRequest['style']>('realistic')
  const [originWorkId, setOriginWorkId] = useState('')
  const [originTitle, setOriginTitle] = useState('')
  const submit = useMutation()
  const id = useId()
  const draft = durable.status === 'failed' ? undefined : durable.value
  const changed = draft !== undefined && draft.revision !== baseRevision
  const blocked = draft?.canFinalize !== true || changed || rights === undefined || submit.busy || submit.problem === 'conflict'
    || (rights === 'licensed' && !originWorkId.trim())
  return <Modal open title={t('finalizeDraft')} closeLabel={t('close')} onClose={() => { if (!submit.busy) close() }} footer={
    <>
      <Button size="sm" variant="ghost" disabled={submit.busy} onClick={close}>{t('cancel')}</Button>
      <Button size="sm" variant="primary" disabled={blocked} type="submit" form={id}>{t('finalizeDraft')}</Button>
    </>
  }>
    {durable.status === 'failed' ? <p className={scripts.failed} role="alert">{t('draftsFailed')}</p>
      : draft === undefined ? <p className={data.quiet} role="status">{t('loading')}</p>
        : changed ? <p className={scripts.failed} role="alert">{t('draftConflict')}</p>
          : draft.canFinalize ? <form id={id} className={css.finalize} onSubmit={(event) => {
            event.preventDefault()
            if (blocked) return
            void submit.run(async () => {
              const script = await draftActions.finalizeDraft({ draftId, baseRevision, rights, kind, style,
                ...(rights === 'licensed' ? { originWorkId: originWorkId.trim(), ...(originTitle.trim() ? { originTitle: originTitle.trim() } : {}) } : {}),
              })
              close()
              openScript({ id: String(script.id), title: script.title })
            })
          }}>
            <p className={data.quiet}>{t('finalizeDescription', { title: draft.title, count: String(draft.episodes.length) })}</p>
            <label>{t('scriptRights')}<select className={css.select} value={rights ?? ''} disabled={submit.busy} required
              onChange={(event) => { setRights(event.target.value === 'licensed' ? 'licensed' : 'original') }}>
              <option value="" disabled>{t('selectScriptRights')}</option>
              <option value="original">{t('rightsOriginal')}</option>
              <option value="licensed">{t('rightsLicensed')}</option>
            </select></label>
            {rights === 'licensed' && <>
              <Input aria-label={t('sourceWorkId')} placeholder={t('sourceWorkId')} required value={originWorkId} disabled={submit.busy}
                onChange={(event) => { setOriginWorkId(event.target.value) }} />
              <Input aria-label={t('scriptOrigin')} placeholder={t('scriptOrigin')} value={originTitle} disabled={submit.busy}
                onChange={(event) => { setOriginTitle(event.target.value) }} />
            </>}
            <label>{t('scriptForm')}<select className={css.select} value={kind} disabled={submit.busy}
              onChange={(event) => { setKind(event.target.value === 'narration' ? 'narration' : 'drama') }}>
              <option value="drama">{t('typeDrama')}</option>
              <option value="narration">{t('typeNarration')}</option>
            </select></label>
            <label>{t('look')}<select className={css.select} value={style} disabled={submit.busy}
              onChange={(event) => { setStyle(event.target.value === '3d' ? '3d' : 'realistic') }}>
              <option value="realistic">{t('lookLive')}</option>
              <option value="3d">{t('look3d')}</option>
            </select></label>
            {submit.problem !== null && <p className={scripts.failed} role="alert">{t(submit.problem === 'conflict' ? 'draftConflict' : 'finalizeDraftFailed')}</p>}
          </form> : <p className={data.quiet}>{t('draftCannotFinalize')}</p>}
  </Modal>
}
