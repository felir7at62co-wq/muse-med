/** Muse location chooser, shared media and per-project settings. */
import { useState } from 'react'
import { Button, IconFolderOpenOutlineRegular, IconPlayOutlineRegular, Input, Modal, SegmentedTabs } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime, PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-resources/client'
import type {} from '@deepseek-ai/dsh-client-ui-character-library/client'
import { workspaceDisplayTitle } from '@deepseek-ai/dsh-api-workspace-controller/default-workspace'
import type { IWorkspaces } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SelectedProject, StudioAsset, StudioBalance, StudioCatalog, StudioConfig, StudioNewProject, StudioEpisode, StudioLibrary, StudioLibraryQuery, StudioOptions, StudioPreferences, StudioProject, StudioProjectAssets, StudioSetting, StudioShot, StudioShotMedia } from '@deepseek-ai/dsh-jingliu-connection/types'
import type { MuseDataBoards, MuseDataCollector, MuseDataPeriod, MuseDataStock, MuseDataWorkDetail } from '@deepseek-ai/dsh-muse-account/types'
import type { ScriptDetail, ScriptList } from '@deepseek-ai/dsh-workbench-connection/types'
import css from './Production.module.css'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /**
     * The Bot team's details drawer: the asset tab of the Bot whose conversation is `sessionId`.
     * `compose` puts text into that conversation's message box.
     */
    'bot.drawer.assets': { kind: 'single'; scope: 'root'; owner: { sessionId: SessionId; quote(text: string): void; compose(text: string): void } }
    /**
     * The Bot team's details drawer: the Jingliu tabs of the Bot whose conversation is `sessionId`.
     * `project` is the production the tab in view shows, or null on the tab that lists them;
     * `openProject` opens a production in a tab of its own. `quote` puts a reference above that
     * conversation's message box; `compose` puts a prepared request into it for the user to send.
     */
    'bot.drawer.jingliu': {
      kind: 'single'
      scope: 'root'
      owner: {
        sessionId: SessionId
        project: SelectedProject | null
        openProject(project: SelectedProject): void
        quote(text: string): void
        compose(text: string): void
      }
    }
    /**
     * The Bot team's details drawer: the 剧本 tabs of the Bot whose conversation is `sessionId`.
     * `script` is the finalized script the tab in view shows, or null on the tab that lists them;
     * `openScript` opens one in a tab of its own. `quote` and `compose` act as on the Jingliu tabs.
     */
    'bot.drawer.scripts': {
      kind: 'single'
      scope: 'root'
      owner: {
        sessionId: SessionId
        script: { id: string; title: string } | null
        openScript(script: { id: string; title: string }): void
        quote(text: string): void
        compose(text: string): void
      }
    }
    /**
     * The Bot team's details drawer: the data tab of the Bot whose conversation is `sessionId`.
     * `platform` is the open data platform, or null on the tab that lists them; `openPlatform`
     * opens one under the same tab (null goes back to the list).
     */
    'bot.drawer.data': {
      kind: 'single'
      scope: 'root'
      owner: {
        sessionId: SessionId
        platform: string | null
        openPlatform(platform: string | null): void
        quote(text: string): void
        compose(text: string): void
      }
    }
  }
  interface ResourceProtocolMap {
    'jingliu-selected': SelectedProject | null
    'jingliu-projects': StudioProject[]
    'jingliu-library': StudioLibrary
    'jingliu-credit': StudioBalance
    'jingliu-options': StudioOptions
    'jingliu-prefs': StudioPreferences
    'jingliu-image': string
    'jingliu-config': StudioConfig
    'jingliu-episodes': StudioEpisode[]
    'jingliu-shots': StudioShot[]
    'jingliu-shot-media': StudioShotMedia
    'jingliu-project-assets': StudioProjectAssets
    'jingliu-catalog': StudioCatalog
    'muse-data-boards': MuseDataBoards
    'muse-data-period': MuseDataPeriod
    'muse-data-stock': MuseDataStock
    'muse-data-collector': MuseDataCollector
    'muse-data-work': MuseDataWorkDetail
    'workshop-scripts': ScriptList
    'workshop-script': ScriptDetail
  }
}

/** Actions owned by the location and account registries. */
export interface ProductionActions {
  hooks: { accountEpoch: HostObservable<number>; workspaceList: IWorkspaces['list'] }
  addWorkspace(path: string): Promise<void>
  /** Tie a production to one conversation without leaving the current view. */
  chooseProject(sessionId: SessionId, project: Pick<StudioProject, 'id'>): Promise<void>
  /** Create a production and tie it to one conversation; resolves to the new production. */
  createProject(sessionId: SessionId, input: StudioNewProject): Promise<SelectedProject>
  /** Rename a production. */
  renameProject(projectId: string, title: string): Promise<void>
  /** Delete one shot; the studio keeps no copy. */
  deleteShot(projectId: string, shotId: string): Promise<void>
  /** Fetch a studio video through the Host; resolves to an object URL the caller revokes. */
  loadVideo(path: string, signal: AbortSignal): Promise<string>
  saveOption(id: string, key: StudioSetting, value: string): Promise<void>
  savePreferences(value: StudioPreferences): Promise<void>
}

type Props = PropsLocale<'jingliuStudio'> & PropsRuntime<'main'> & InjectFace<ProductionActions>
/** Localized text of the studio namespace. */
export type Text = Props['t']
/** The resource reader every studio view receives. */
export type Read = Props['useResource']

/**
 * Address of a studio resource for the current login.
 * @param kind - Resource protocol.
 * @param epoch - Account generation; a new login reads again.
 * @param revision - Manual refresh count.
 * @param params - Query parameters of the read.
 * @returns The resource address.
 */
export function address(kind: string, epoch: number, revision: number, params: Record<string, string> = {}) {
  return 'dsh-resource://' + kind + '/current?' + new URLSearchParams({ epoch: String(epoch), revision: String(revision), ...params }).toString()
}

/**
 * Run one user action at a time and remember whether it failed.
 * @returns The busy and failed flags and the runner.
 */
export function useAction() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  return { busy, error, run: async (action: () => Promise<void>) => {
    if (busy) return
    setBusy(true); setError(false)
    try { await action() } catch { setError(true) } finally { setBusy(false) }
  } }
}

/**
 * A studio image read through the account's resources.
 * @param props - Image path, login generation, reader, alternative text and failure text.
 * @returns The image, a failure note, or a placeholder.
 */
export function Picture({ path, epoch, useResource, name, unavailable }: {
  path: string
  epoch: number
  useResource: Read
  name: string
  unavailable?: string
}) {
  const image = useResource<'jingliu-image'>(path.startsWith('/fw') ? address('jingliu-image', epoch, 0, { path }) : 'studio://inactive')
  if (unavailable && image.status === 'failed') return <span role="status">{unavailable}</span>
  if (image.value) return <img src={image.value} loading="lazy" alt={name} />
  return <span className={css.placeholder} aria-hidden="true"><IconPlayOutlineRegular size={22} /></span>
}

/**
 * The studio failure line with a retry button.
 * @param props - Copy and retry callback.
 * @returns The alert.
 */
export function Failure({ t, retry }: { t: Text; retry: () => void }) {
  return <div className={css.notice} role="alert">{t('failed')} <Button variant="ghost" onClick={retry}>{t('refresh')}</Button></div>
}

/**
 * Show the working directory and production of the current conversation.
 * @param props - The conversation visible in this right pane.
 * @returns Its local environment and confirmed production.
 */
export function Environment({ sessionId, t, useWorkspaceList, addWorkspace, renderSlot }: Props & PropsRenderSlots<'workspace.environment.directoryFlow'> & { sessionId: SessionId }) {
  const workspace = useWorkspaceList(list => list.items.find(row => row.sessionIds.includes(sessionId)))
  const folderName = workspace && workspaceDisplayTitle(workspace.title, '')
  const [pick, setPick] = useState(false)
  const [pickerError, setPickerError] = useState(false)
  const act = useAction()
  return <section className={css.environment} aria-label={t('environment')}>
    <header><strong>{t('environment')}</strong><button type="button" title={t('addWorkspace')} aria-label={t('addWorkspace')}
      disabled={act.busy} onClick={() => { setPickerError(false); setPick(true) }}>+</button></header>
    <div className={css.machine} title={workspace?.path}><IconFolderOpenOutlineRegular size={16} /><span>{t('computer')}</span>{folderName && <small>{folderName}</small>}</div>
    {renderSlot('workspace.environment.directoryFlow', {
      open: pick, busy: act.busy,
      onPicked: (path) => { setPick(false); void act.run(() => addWorkspace(path)) },
      onCancel: () => setPick(false), onError: () => { setPick(false); setPickerError(true) },
    })}
    {(act.error || pickerError) && <small role="alert">{t('envFailed')}</small>}
  </section>
}

/**
 * Browse the shared production media catalog.
 * @param props - Library resources scoped to the current login.
 * @returns The shared Jingliu asset catalog.
 */
export function Assets(props: Pick<Props, 'useResource' | 'useAccountEpoch' | 't'>) {
  const epoch = props.useAccountEpoch(n => n)
  return <AssetBrowser key={epoch} epoch={epoch} t={props.t} useResource={props.useResource} />
}

function AssetBrowser({ epoch, t, useResource }: { epoch: number; t: Text; useResource: Read }) {
  const [selected, select] = useState<StudioAsset | null>(null)
  const [kind, setKind] = useState<StudioLibraryQuery['kind']>('all')
  const [query, setQuery] = useState('')
  const [draft, setDraft] = useState('')
  const [offset, setOffset] = useState(0)
  const [revision, refresh] = useState(0)
  const list = useResource<'jingliu-library'>(address('jingliu-library', epoch, revision, { kind, query, offset: String(offset) }))
  const tab = (value: StudioLibraryQuery['kind']) => ({ value, label: t(value), id: 'studio-kind-' + value, panelId: 'studio-assets' })
  const tabs = [tab('all'), tab('character'), tab('location'), tab('prop')] as const
  return <section className={css.page}>
    <div className={css.heading}><h1>{t('shared')}</h1><Button variant="ghost" onClick={() => refresh(n => n + 1)}>{t('refresh')}</Button></div>
    <form className={css.toolbar} onSubmit={(e) => { e.preventDefault(); setQuery(draft.trim()); setOffset(0) }}>
      <Input aria-label={t('searchAssets')} placeholder={t('searchAssets')} maxLength={200} value={draft} onChange={e => setDraft(e.target.value)} />
      <Button type="submit" variant="outline">{t('search')}</Button>
    </form>
    <SegmentedTabs items={tabs} value={kind} onChange={(v) => { setKind(v); setOffset(0) }} label={t('assetType')} size="sm" />
    <div role="tabpanel" id="studio-assets" aria-labelledby={'studio-kind-' + kind}>
      {list.status === 'failed' || list.status === 'none' ? <Failure t={t} retry={() => refresh(n => n + 1)} /> : list.status !== 'live' ? <p>{t('loading')}</p> :
        !list.value?.items.length ? <p>{t('emptyAssets')}</p> : <div className={css.grid}>{list.value.items.map(a =>
          <button key={a.id} className={css.card} type="button" onClick={() => select(a)} aria-label={a.name}>
            <div className={a.kind === 'character' ? css.portrait : css.poster}>
              <Picture path={a.thumbnail} epoch={epoch} useResource={useResource} name={a.name} unavailable={t('imageFailed')} />
            </div>
            <strong>{a.name}</strong>
            {a.description && <small className={css.assetCaption}>{a.description}</small>}
          </button>,
        )}</div>}
    </div>
    {((list.value?.total ?? 0) > 24 || offset > 0) && <div className={css.toolbar}>
      <Button disabled={!offset} onClick={() => setOffset(n => n - 24)}>{t('previous')}</Button>
      <Button disabled={offset + 24 >= (list.value?.total ?? 0)} onClick={() => setOffset(n => n + 24)}>{t('next')}</Button>
    </div>}
    {selected && <Modal open title={selected.name} closeLabel={t('close')} onClose={() => select(null)}
      {...(selected.referenceOnly && { description: t('referenceOnly') })} className={css.previewDialog as string}>
      <div className={css.fullImage}><Picture path={selected.thumbnail} epoch={epoch} useResource={useResource}
        name={selected.name} unavailable={t('imageFailed')} /></div>
      {selected.description && <p>{selected.description}</p>}
    </Modal>}
  </section>
}

/**
 * Manage generation preferences for a production.
 * @param props - Cloud balance and native project settings.
 * @returns The Jingliu section in Muse Settings.
 */
export function ProductionSettings({ t, useResource, useAccountEpoch, savePreferences, saveOption }: Props) {
  const epoch = useAccountEpoch(n => n)
  const [revision, refresh] = useState(0)
  const [chosen, select] = useState('')
  const credit = useResource<'jingliu-credit'>(address('jingliu-credit', epoch, revision))
  const projects = useResource<'jingliu-projects'>(address('jingliu-projects', epoch, revision))
  const id = projects.value?.find(p => p.id === chosen)?.id ?? projects.value?.[0]?.id
  const options = useResource<'jingliu-options'>(id ? address('jingliu-options', epoch, revision, { id }) : 'studio://inactive')
  const prefs = useResource<'jingliu-prefs'>(id ? address('jingliu-prefs', epoch, revision, { id }) : 'studio://inactive')
  const act = useAction()
  const data = options.value
  const preference = prefs.value
  return <section className={css.page}>
    <div className={css.heading}><h1>{t('studioSettings')}</h1><Button variant="ghost" onClick={() => refresh(n => n + 1)}>{t('refresh')}</Button></div>
    <div className={css.amount}><span>{t('balance')}</span><strong>{credit.value ? credit.value.unlimited ? t('unlimited') : '¥' + credit.value.available : '—'}</strong></div>
    {credit.value && <small>{t('usage', { spent: (credit.value.usedFen / 100).toFixed(2), held: (credit.value.heldFen / 100).toFixed(2) })}</small>}
    {projects.value?.length ? <><label className={css.setting}>{t('project')}<select value={id} onChange={e => select(e.target.value)}>{projects.value.map(p => <option value={p.id} key={p.id}>{p.title}</option>)}</select></label>
      {data && (['character', 'location', 'prop', 'resolution'] as const).map((key) => {
        const items = key === 'resolution' ? data.resolutions.map(value => ({ id: value, name: value })) : data.models
        return <label key={key} className={css.setting}>{t(key)}<select value={data[key]} disabled={act.busy} onChange={(event) => {
          const value = event.target.value
          void act.run(async () => { await saveOption(data.projectId, key, value); refresh(n => n + 1) })
        }}><option value="">{t('projectDefault')}{key !== 'resolution' && data.projectModel && ' · ' + data.projectModel}</option>
          {items.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      })}
      {preference && <label className={css.setting}><span>{t('chips')}</span><input type="checkbox" checked={preference.hidePromptChips} disabled={act.busy} onChange={(e) => {
        const value = { projectId: preference.projectId, hidePromptChips: e.target.checked }
        void act.run(async () => { await savePreferences(value); refresh(n => n + 1) })
      }} /></label>}</> : null}
    {(credit.status === 'failed' || projects.status === 'failed' || prefs.status === 'failed' || options.status === 'failed' || act.error) && <Failure t={t} retry={() => refresh(n => n + 1)} />}
  </section>
}

/**
 * Show the production allowance in the sidebar.
 * @param props - Per-account balance resource and settings navigation.
 * @returns The studio credit shortcut.
 */
export function CreditEntry({ wide, t, useResource, useAccountEpoch }: Props & { wide: boolean }) {
  const epoch = useAccountEpoch(n => n)
  const credit = useResource<'jingliu-credit'>(address('jingliu-credit', epoch, 0))
  if (!wide || !credit.value || credit.status !== 'live') return null
  return <span className={css.credit} title={t('balance')}>{t('balance')} · {credit.value.unlimited ? t('unlimited') : '¥' + credit.value.available}</span>
}
