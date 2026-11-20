/**
 * The Jingliu tabs of the Bot team's details drawer: one tab lists the productions, and each
 * production opened from it has a tab of its own with a workbench of its assets and shot videos.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  Button, IconChevronDownOutlineRegular, IconChevronRightOutlineRegular, IconCopyOutlineRegular, IconPlusOutlineRegular,
  IconSearchOutlineRegular, IconShareOutlineRegular, IconSlidersTwoOutlineRegular, IconTrashOutlineRegular, Input, Modal,
  SegmentedControl, Switch,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  StudioCatalog, StudioConfig, StudioEpisode, StudioNewProject, StudioProject, StudioProjectAsset, StudioShot, StudioShotMedia,
} from '@deepseek-ai/dsh-jingliu-connection/types'
import { address, Failure, Picture, useAction, type ProductionActions, type Read, type Text } from './Production.tsx'
import css from './DrawerJingliu.module.css'

type Props = PropsLocale<'jingliuStudio'> & PropsRuntime<'bot.drawer.jingliu'> & InjectFace<ProductionActions>
type Page = 'assets' | 'videos'
type Kind = 'character' | 'location' | 'blocking' | 'prop' | 'audio' | 'poster'
type Card = 'search' | 'new' | 'config' | 'export' | 'poster'
const NO_ASSETS: StudioProjectAsset[] = []
const POSTER_RATIOS = ['1:1', '2:3', '3:4', '7:10', '9:16', '16:9'] as const

/**
 * One Jingliu tab: the list of productions, or the workbench of the production the tab shows.
 * @param props - The Bot's conversation, the tab's production, the studio resources and the message-box callbacks.
 * @returns The project list or the workbench, with the project forms over them.
 */
export function DrawerJingliu(props: Props) {
  const { sessionId, project, openProject, chooseProject, useResource, useAccountEpoch, t } = props
  const epoch = useAccountEpoch(n => n)
  const selected = useResource<'jingliu-selected'>(address('jingliu-selected', epoch, 0, { id: sessionId }))
  const [card, setCard] = useState<Card | null>(null)
  const [revision, refresh] = useState(0)
  const projects = useResource<'jingliu-projects'>(address('jingliu-projects', epoch, revision))
  const tying = useAction()
  const close = () => setCard(null)
  if (selected.status === 'failed') return <section className={css.drawer}><Failure t={t} retry={() => refresh(n => n + 1)} /></section>
  if (selected.status !== 'live') return <section className={css.drawer}><p className={css.quiet}>{t('loading')}</p></section>
  // The production Muse works on in this conversation. Looking at another one leaves it as it is.
  const tied = selected.value?.id ?? null
  const rows = projects.value ?? []
  // A production opens in a tab of its own; a conversation with none yet takes it as its own.
  const open = async (picked: { id: string; title: string }) => {
    if (tied === null) await chooseProject(sessionId, picked)
    openProject({ id: picked.id, title: picked.title })
  }
  const forms = <>
    {card === 'search' && <ProjectSearch {...props} epoch={epoch} projects={rows} tied={tied} onClose={close}
      onPick={async (picked) => { await open(picked); close() }} />}
    {(card === 'new' || (card === 'config' && project)) && <ProjectForm {...props} epoch={epoch} mode={card}
      project={card === 'config' && project ? rows.find(p => p.id === project.id) ?? null : null}
      projectId={card === 'config' && project ? project.id : ''} onClose={close}
      onDone={(saved) => { close(); refresh(n => n + 1); if (saved) openProject(saved) }} />}
  </>
  if (!project) {
    return <section className={css.drawer}>
      <ProjectList {...props} epoch={epoch} data={projects} tied={tied} onRetry={() => refresh(n => n + 1)} onNew={() => setCard('new')}
        onSearch={() => setCard('search')} onPick={open} />
      {forms}
    </section>
  }
  const row = rows.find(p => p.id === project.id)
  // A request made from a production's tab is about that production: the conversation takes
  // it as its own first, so Muse works on the one the user is looking at.
  const about = (send: (text: string) => void) => (text: string) => {
    if (tied === project.id) { send(text); return }
    void tying.run(async () => { await chooseProject(sessionId, project); send(text) })
  }
  return <section className={css.drawer}>
    <Workbench {...props} quote={about(props.quote)} compose={about(props.compose)} epoch={epoch} projectId={project.id}
      title={row?.title || project.title} generationMode={row?.profile.generationMode ?? ''} card={card} setCard={setCard} />
    {tying.error && <p role="alert" className={css.failed}>{t('navFailed')}</p>}
    {forms}
  </section>
}

// --- productions -------------------------------------------------------------------------------

const firstLetter = (title: string) => Array.from(title.trim())[0] ?? '·'
const dateOf = (iso: string) => {
  const date = iso ? new Date(iso) : null
  return date && !Number.isNaN(date.getTime()) ? date.toLocaleDateString(undefined, { month: 'long', day: 'numeric' }) : ''
}

// The tags a production card carries: type, look, frame ratio, resolution, generation mode, video model.
function projectTags(t: Text, project: StudioProject, catalog: StudioCatalog | undefined, tied: string | null = null): string[] {
  const type = project.mode === 'narration' || project.mode === 'narration_dlg' ? t('typeNarration') : project.mode ? t('typeDrama') : ''
  const look = project.mode === 'anime' ? t('look3d') : project.mode === 'drama' || project.mode === 'narration' ? t('lookLive') : ''
  const generation = catalog?.generationModes.find(m => m.id === project.profile.generationMode)?.name ?? project.profile.generationMode
  return [project.id === tied ? t('tiedProject') : '', type, look, project.aspect, project.profile.resolution, generation, project.profile.videoModel].filter(Boolean)
}

type ListProps = Props & {
  epoch: number
  data: { status: string; value?: StudioProject[] | undefined }
  onRetry: () => void
  onNew: () => void
  onSearch: () => void
  tied: string | null
  onPick: (project: StudioProject) => Promise<void>
}

function ProjectList({ t, useResource, epoch, data, tied, onRetry, onNew, onSearch, onPick }: ListProps) {
  const catalog = useResource<'jingliu-catalog'>(address('jingliu-catalog', epoch, 0)).value
  const act = useAction()
  const rows = [...data.value ?? []].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  const pick = (project: StudioProject) => { void act.run(() => onPick(project)) }
  return <>
    <div className={css.listTop}>
      <button type="button" className={css.newProject} onClick={onNew}><IconPlusOutlineRegular size={16} />{t('newProject')}</button>
      <button type="button" className={css.round} aria-label={t('searchProjects')} title={t('searchProjects')} onClick={onSearch}><IconSearchOutlineRegular size={18} /></button>
    </div>
    {data.status === 'failed' ? <Failure t={t} retry={onRetry} /> : data.status !== 'live' ? <p className={css.quiet}>{t('loading')}</p>
      : rows.length === 0 ? <p className={css.quiet}>{t('emptyProjects')}</p>
        : <div className={css.projects}>{rows.map(p =>
          <button key={p.id} type="button" className={css.project} disabled={act.busy} onClick={() => pick(p)}>
            <span className={css.letter} aria-hidden="true">{firstLetter(p.title)}</span>
            <span className={css.projectText}>
              <strong>{p.title}</strong>
              <small>{[t('episodeCount', { count: p.episodes }), dateOf(p.createdAt)].filter(Boolean).join(' · ')}</small>
              <span className={css.tags}>
                {projectTags(t, p, catalog, tied).map(tag => <span key={tag} className={css.tag}>{tag}</span>)}
              </span>
            </span>
            <IconChevronRightOutlineRegular size={16} />
          </button>)}</div>}
    {act.error && <p role="alert" className={css.quiet}>{t('navFailed')}</p>}
  </>
}

type SearchProps = Props & {
  epoch: number
  projects: StudioProject[]
  tied: string | null
  onClose: () => void
  onPick: (project: StudioProject) => Promise<void>
}

function ProjectSearch({ t, useResource, epoch, projects, tied, onClose, onPick }: SearchProps) {
  const catalog = useResource<'jingliu-catalog'>(address('jingliu-catalog', epoch, 0)).value
  const [query, setQuery] = useState('')
  const act = useAction()
  const needle = query.trim().toLocaleLowerCase()
  const rows = projects.filter(p => p.title.toLocaleLowerCase().includes(needle)).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  const pick = (project: StudioProject) => { void act.run(() => onPick(project)) }
  return <Modal open title={t('searchProjects')} closeLabel={t('close')} onClose={onClose}>
    <Input data-modal-autofocus aria-label={t('searchProjects')} placeholder={t('searchProjects')} value={query} onChange={e => setQuery(e.target.value)} />
    {rows.length === 0 ? <p className={css.quiet}>{t('noSuchProject')}</p> : <div className={css.results}>{rows.map(p =>
      <button key={p.id} type="button" className={css.result} disabled={act.busy} onClick={() => pick(p)}>
        <span className={css.letter} aria-hidden="true">{firstLetter(p.title)}</span>
        <span className={css.projectText}><strong>{p.title}</strong><small>{projectTags(t, p, catalog, tied).join(' · ')}</small></span>
        <small className={css.date}>{dateOf(p.createdAt)}</small>
      </button>)}</div>}
    {act.error && <p role="alert" className={css.quiet}>{t('navFailed')}</p>}
  </Modal>
}

// The studio's production modes as the form's two choices: story or narrated, live action or 3D.
type Story = 'drama' | 'narration'
type Look = 'live' | '3d'
const modeOf = (story: Story, look: Look) => story === 'drama' ? (look === 'live' ? 'drama' : 'anime') : (look === 'live' ? 'narration' : 'narration_dlg')
const storyOf = (mode: string): Story => (mode === 'narration' || mode === 'narration_dlg' ? 'narration' : 'drama')

type FormProps = Props & {
  epoch: number
  mode: 'new' | 'config'
  project: StudioProject | null
  projectId: string
  onClose: () => void
  /** The production the form created or renamed, or null when only another setting changed. */
  onDone: (saved: { id: string; title: string } | null) => void
}

function ProjectForm(props: FormProps) {
  const { t, useResource, epoch, mode, projectId } = props
  const catalog = useResource<'jingliu-catalog'>(address('jingliu-catalog', epoch, 0))
  const config = useResource<'jingliu-config'>(mode === 'config' ? address('jingliu-config', epoch, 0, { id: projectId }) : 'studio://inactive')
  const ready = catalog.value && (mode === 'new' || config.value)
  return <Modal open title={mode === 'new' ? t('newProject') : t('projectConfig')} closeLabel={t('close')} onClose={props.onClose}>
    {catalog.status === 'failed' || config.status === 'failed' ? <Failure t={t} retry={props.onClose} />
      : !ready ? <p className={css.quiet}>{t('loading')}</p>
        : <FormFields {...props} catalog={catalog.value} config={config.value ?? null} />}
  </Modal>
}

type FieldsProps = FormProps & { catalog: StudioCatalog; config: StudioConfig | null }

function FormFields(props: FieldsProps) {
  const { t, mode, sessionId, projectId, project, catalog, config, createProject, renameProject, saveOption, onClose, onDone } = props
  const editing = mode === 'config'
  const liveStyles = catalog.modes.find(m => m.key === 'drama')?.styles.map(s => s.key) ?? []
  const startMode = config?.mode || 'drama'
  const [title, setTitle] = useState(config?.title ?? '')
  const [story, setStory] = useState<Story>(storyOf(startMode))
  const [look, setLook] = useState<Look>(startMode === 'anime' || (startMode === 'narration_dlg' && !liveStyles.includes(config?.artStyle ?? '')) ? '3d' : 'live')
  const modeKey = modeOf(story, look)
  const styles = (catalog.modes.find(m => m.key === modeKey)?.styles ?? []).filter(s => modeKey !== 'narration_dlg' || (look === 'live') === liveStyles.includes(s.key))
  const [artStyle, setArtStyle] = useState(config?.artStyle ?? '')
  const style = styles.some(s => s.key === artStyle) ? artStyle : styles.find(s => s.enabled)?.key ?? ''
  const [aspect, setAspect] = useState(config?.aspect || catalog.aspects[0] || '')
  const [resolution, setResolution] = useState(config?.resolution || (catalog.resolutions.includes('1080p') ? '1080p' : catalog.resolutions[0] ?? ''))
  const [videoModel, setVideoModel] = useState(config?.videoModel ?? '')
  const [imageModel, setImageModel] = useState(config?.imageModel ?? '')
  const [generationMode, setGenerationMode] = useState(project?.profile.generationMode ?? '')
  const act = useAction()
  const submit = () => { void act.run(async () => {
    if (editing) {
      const renamed = title.trim() !== (config?.title ?? '')
      if (renamed) await renameProject(projectId, title)
      if (resolution !== (config?.resolution ?? '')) await saveOption(projectId, 'resolution', resolution)
      onDone(renamed ? { id: projectId, title: title.trim() } : null)
    } else {
      const input: StudioNewProject = { title, mode: modeKey, artStyle: style, aspect, resolution, videoModel, imageModel, generationMode }
      onDone(await createProject(sessionId, input))
    }
  }) }
  const row = (label: string, control: ReactNode) => <div className={css.field}>
    <span className={css.fieldLabel}>{label}</span><div className={css.fieldControl}>{control}</div>
  </div>
  // Up to four choices sit in one segmented row; more wrap as single-pick buttons.
  type Option<V extends string> = { value: V; label: string; disabled?: boolean }
  type Pick<V extends string> = (next: V) => void
  const choice = <V extends string>(id: string, label: string, value: V, options: Option<V>[], onChange: Pick<V>, fixed = false) =>
    row(label, options.length <= 4
      ? <SegmentedControl id={id} label={label} value={value} options={options} onChange={onChange} disabled={fixed}
        className={css.choice} />
      : <span className={css.picks} role="radiogroup" aria-label={label}>{options.map(o =>
        <button key={o.value} type="button" role="radio" aria-checked={o.value === value} disabled={fixed || o.disabled === true} onClick={() => onChange(o.value)}>{o.label}</button>)}</span>)
  const select = (label: string, value: string, options: { id: string; name: string }[], onChange: (next: string) => void, fixed = false) =>
    row(label, <select className={css.select} aria-label={label} value={value} disabled={fixed} onChange={e => onChange(e.target.value)}>
      <option value="">{t('platformDefault')}</option>
      {options.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
      {value && !options.some(o => o.id === value) && <option value={value}>{value}</option>}
    </select>)
  return <div className={css.form}>
    {row(t('projectName'), <Input data-modal-autofocus aria-label={t('projectName')} placeholder={t('projectNamePlaceholder')} maxLength={255} value={title} onChange={e => setTitle(e.target.value)} />)}
    {choice('jl-story', t('projectType'), story, [{ value: 'drama', label: t('typeDrama') }, { value: 'narration', label: t('typeNarration') }], setStory, editing)}
    {choice('jl-look', t('look'), look, [{ value: 'live', label: t('lookLive') }, { value: '3d', label: t('look3d') }], setLook, editing)}
    {styles.length > 0 && choice('jl-style', t('artStyle'), style, styles.map(s => ({ value: s.key, label: s.label, disabled: !s.enabled })), setArtStyle, editing)}
    {catalog.aspects.length > 0 && choice('jl-aspect', t('formAspect'), aspect, catalog.aspects.map(a => ({ value: a, label: a })), setAspect, editing)}
    {catalog.resolutions.length > 0 && choice('jl-resolution', t('formResolution'), resolution, catalog.resolutions.map(r => ({ value: r, label: r })), setResolution)}
    {select(t('videoModel'), videoModel, catalog.videoModels, setVideoModel, editing)}
    {select(t('imageModel'), imageModel, catalog.imageModels, setImageModel, editing)}
    {select(t('generationMode'), generationMode, catalog.generationModes, setGenerationMode, editing)}
    {act.error && <p role="alert" className={css.failed}>{t('saveFailed')}</p>}
    <div className={css.formFoot}>
      <Button variant="ghost" onClick={onClose}>{t('cancel')}</Button>
      <Button variant="primary" disabled={act.busy || title.trim() === ''} onClick={submit}>{editing ? t('save') : t('create')}</Button>
    </div>
  </div>
}

// --- workbench ---------------------------------------------------------------------------------

type BenchProps = Props & {
  epoch: number
  projectId: string
  title: string
  generationMode: string
  card: Card | null
  setCard: (card: Card | null) => void
}

function Workbench(props: BenchProps) {
  const { t, useResource, epoch, projectId, title, card, setCard } = props
  const [page, setPage] = useState<Page>('videos')
  const config = useResource<'jingliu-config'>(address('jingliu-config', epoch, 0, { id: projectId }))
  const episodes = useResource<'jingliu-episodes'>(address('jingliu-episodes', epoch, 0, { id: projectId }))
  const assets = useResource<'jingliu-project-assets'>(address('jingliu-project-assets', epoch, 0, { id: projectId }))
  const characters = (assets.value?.assets ?? NO_ASSETS).filter(a => a.kind === 'character').map(a => a.name)
  const catalog = useResource<'jingliu-catalog'>(address('jingliu-catalog', epoch, 0)).value
  const generation = catalog?.generationModes.find(m => m.id === props.generationMode)?.name ?? props.generationMode
  return <>
    <div className={css.bar}>
      <button type="button" className={css.projectPill} aria-label={t('switchProjectLabel', { title })} onClick={() => setCard('search')}>
        <span className={css.letter} aria-hidden="true">{firstLetter(title)}</span><strong>{title}</strong><IconChevronDownOutlineRegular size={14} />
      </button>
      <button type="button" className={css.round} aria-label={t('newProject')} title={t('newProject')} aria-pressed={card === 'new'} onClick={() => setCard(card === 'new' ? null : 'new')}><IconPlusOutlineRegular size={18} /></button>
      <SegmentedControl id="jl-page" label={t('workbenchPages')} value={page} className={css.pages}
        options={[{ value: 'assets', label: t('assetsPage') }, { value: 'videos', label: t('videosPage') }]} onChange={(next) => { setPage(next); setCard(null) }} />
      <span className={css.spacer} />
      <Button size="sm" variant="outline" icon={<IconSlidersTwoOutlineRegular size={15} />} aria-pressed={card === 'config'} onClick={() => setCard(card === 'config' ? null : 'config')}>{t('projectConfig')}</Button>
      <Button size="sm" className={css.export} icon={<IconShareOutlineRegular size={15} />} aria-pressed={card === 'export'} onClick={() => setCard(card === 'export' ? null : 'export')}>{t('batchExport')}</Button>
    </div>
    <div className={css.body}>
      {page === 'assets'
        ? <AssetsPage t={t} useResource={useResource} epoch={epoch} projectId={projectId} quote={props.quote} onPoster={() => setCard('poster')} />
        : <VideosPage {...props} config={config.value ?? null} generation={generation} />}
    </div>
    {card === 'export' && <ExportCard t={t} episodes={episodes.value ?? []} compose={props.compose} onClose={() => setCard(null)} />}
    {card === 'poster' && <PosterCard t={t} title={title} leads={characters} compose={props.compose} onClose={() => setCard(null)} />}
  </>
}

// Clip kinds the studio reports, as their labels.
const AUDIO_KINDS = { voice: 'audioVoice', narration: 'audioNarration', music: 'audioMusic', sfx: 'audioSfx' } as const
const audioKind = (t: Text, kind: string) => t(Object.hasOwn(AUDIO_KINDS, kind) ? AUDIO_KINDS[kind as keyof typeof AUDIO_KINDS] : 'audioOther')

type AssetsProps = { t: Text; useResource: Read; epoch: number; projectId: string; quote: (text: string) => void; onPoster: () => void }

function AssetsPage({ t, useResource, epoch, projectId, quote, onPoster }: AssetsProps) {
  const data = useResource<'jingliu-project-assets'>(address('jingliu-project-assets', epoch, 0, { id: projectId }))
  const [kind, setKind] = useState<Kind>('character')
  // A blocking diagram is the wide picture of one video package: who stands where in a fixed scene.
  const kinds: Kind[] = ['character', 'location', 'blocking', 'prop', 'audio', 'poster']
  const items = (data.value?.assets ?? []).filter(a => a.kind === kind)
  const frame = kind === 'character' ? css.portrait : kind === 'audio' ? css.wave : css.landscape
  const ready = (path: string) => <span className={path ? css.dot : css.dotPending} aria-hidden="true" />
  return <>
    <div className={css.subBar}>
      <SegmentedControl id="jl-kind" label={t('assetType')} value={kind} className={css.kinds}
        options={kinds.map(value => ({ value, label: t(value) }))} onChange={setKind} />
      <span className={css.spacer} />
      {kind === 'poster' && <Button size="sm" variant="primary" onClick={onPoster}>{t('generatePoster')}</Button>}
    </div>
    {data.status === 'failed' ? <p className={css.quiet}>{t('failed')}</p> : data.status !== 'live' ? <p className={css.quiet}>{t('loading')}</p>
      : kind === 'poster' ? <p className={css.quiet}>{t('noPosters')}</p>
        : kind === 'audio'
          ? (data.value?.audio.length ? <div className={css.grid}>{data.value.audio.map(clip =>
            <div key={clip.id} className={css.asset}>
              <span className={frame}><small>{audioKind(t, clip.kind)}</small></span>
              <span className={css.assetName}><span className={css.dot} aria-hidden="true" /><strong>{clip.text || audioKind(t, clip.kind)}</strong>
                {clip.durationSec !== null && <small>{t('seconds', { value: clip.durationSec.toFixed(1) })}</small>}</span>
            </div>)}</div>
            : <p className={css.quiet}>{t('emptyAssets')}</p>)
          : items.length === 0 ? <p className={css.quiet}>{t('emptyAssets')}</p>
            : <div className={css.grid}>{items.map(a =>
              <button key={a.id} type="button" className={css.asset} title={t('quoteAsset')} onClick={() => quote(t('assetQuote', { name: a.name }))}>
                <span className={frame}>{a.imagePath
                  ? <Picture path={a.imagePath} epoch={epoch} useResource={useResource} name={a.name} unavailable={t('imageFailed')} />
                  : <small>{t('notGenerated')}</small>}</span>
                <span className={css.assetName}>{ready(a.imagePath)}<strong>{a.name}</strong></span>
                {a.scope && <small className={css.assetScope}>{a.scope}</small>}
              </button>)}</div>}
  </>
}

function VideosPage(props: BenchProps & { config: StudioConfig | null; generation: string }) {
  const { t, useResource, epoch, projectId } = props
  const episodes = useResource<'jingliu-episodes'>(address('jingliu-episodes', epoch, 0, { id: projectId }))
  const assets = useResource<'jingliu-project-assets'>(address('jingliu-project-assets', epoch, 0, { id: projectId })).value?.assets ?? NO_ASSETS
  const list = episodes.value ?? []
  const [chosen, choose] = useState<number | null>(null)
  const [revision, refresh] = useState(0)
  const episode = chosen ?? list.find(e => e.hasShots)?.number ?? list[0]?.number ?? null
  const shots = useResource<'jingliu-shots'>(episode === null ? 'studio://inactive' : address('jingliu-shots', epoch, revision, { id: projectId, episode: String(episode) }))
  if (episodes.status === 'failed') return <p className={css.quiet}>{t('failed')}</p>
  if (episodes.status !== 'live') return <p className={css.quiet}>{t('loading')}</p>
  if (episode === null) return <p className={css.quiet}>{t('emptyEpisodes')}</p>
  return <div className={css.videos}>
    <nav className={css.episodes} aria-label={t('episodes')}>{list.map(e =>
      <button key={e.number} type="button" aria-current={e.number === episode ? 'true' : undefined} className={e.hasShots ? undefined : css.noShots} onClick={() => choose(e.number)}>{e.number}</button>)}</nav>
    <div className={css.cards}>
      {shots.status === 'failed' ? <p className={css.quiet}>{t('failed')}</p> : shots.status !== 'live' ? <p className={css.quiet}>{t('loading')}</p>
        : !shots.value?.length ? <p className={css.quiet}>{t('emptyShots')}</p>
          : shots.value.map(shot =>
            <ShotCard key={shot.id} {...props} assets={assets} shot={shot} episode={episode} onDeleted={() => refresh(n => n + 1)} />)}
    </div>
  </div>
}

// The prompt with each asset it names marked where it is mentioned, its picture beside the name.
type PromptProps = { prompt: string; assets: StudioProjectAsset[]; epoch: number; useResource: Read }

function PromptText({ prompt, assets, epoch, useResource }: PromptProps) {
  const named = useMemo(() => assets.filter(a => a.name.length > 1).sort((a, b) => b.name.length - a.name.length), [assets])
  if (named.length === 0) return <p className={css.prompt}>{prompt}</p>
  const pattern = new RegExp('(' + named.map(a => a.name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('|') + ')', 'gu')
  const parts: ReactNode[] = prompt.split(pattern).map((part, index) => {
    const asset = index % 2 === 1 ? named.find(a => a.name === part) : undefined
    if (!asset) return part
    return <span key={index} className={css.mention}>
      {asset.imagePath
        ? <span className={css.mentionFace}><Picture path={asset.imagePath} epoch={epoch} useResource={useResource} name="" /></span>
        : <span className={css.mentionMissing} aria-hidden="true" />}@{part}
    </span>
  })
  return <p className={css.prompt}>{parts}</p>
}

type CardProps = BenchProps & {
  config: StudioConfig | null
  generation: string
  assets: StudioProjectAsset[]
  shot: StudioShot
  episode: number
  onDeleted: () => void
}

function ShotCard(props: CardProps) {
  const { t, useResource, epoch, projectId, config, generation, assets, shot, episode } = props
  const { quote, compose, loadVideo, deleteShot, onDeleted } = props
  const media = useResource<'jingliu-shot-media'>(shot.hasVideo || shot.failReason ? address('jingliu-shot-media', epoch, 0, { id: projectId, shot: shot.id }) : 'studio://inactive')
  const [version, setVersion] = useState<number | null>(null)
  const [quoted, setQuoted] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const act = useAction()
  const label = t('shotLabel', { episode, index: shot.index })
  const shown = media.value ? pickVersion(media.value, version) : null
  const model = shown?.model || config?.videoModel || t('platformDefault')
  const materials = assets.filter(a => a.name === shot.location || shot.characters.includes(a.name) || shot.props.includes(a.name))
  const versions = [...media.value?.versions ?? []].sort((a, b) => b.number - a.number)
  const current = version ?? media.value?.adoptedVersion ?? null
  const remove = () => { void act.run(async () => { await deleteShot(projectId, shot.id); onDeleted() }) }
  return <article className={css.card} aria-label={label}>
    <div className={css.script}>
      <header className={css.cardHead}>
        <h2>{t('shotNumber', { index: shot.index })}</h2>
        {shot.durationSec !== null && <small className={css.quiet}>{t('seconds', { value: shot.durationSec.toFixed(1) })}</small>}
        <span className={css.spacer} />
        {confirming
          ? <>
            <Button size="sm" variant="ghost" className={css.danger} disabled={act.busy} onClick={remove}>{t('deleteShot')}</Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>{t('cancel')}</Button>
          </>
          : <>
            <button type="button" className={css.icon} aria-label={t('copyShotLabel', { shot: label })} title={t('copyShot')} onClick={() => compose(t('copyRequest', { shot: label }))}><IconCopyOutlineRegular size={16} /></button>
            <button type="button" className={css.icon} aria-label={t('deleteShotLabel', { shot: label })} title={t('deleteShot')} onClick={() => setConfirming(true)}><IconTrashOutlineRegular size={16} /></button>
          </>}
      </header>
      {act.error && <p role="alert" className={css.failed}>{t('deleteFailed')}</p>}
      {shot.failReason && <p className={css.failed}>{shot.failReason}</p>}
      {shot.prompt ? <PromptText prompt={shot.prompt} assets={assets} epoch={epoch} useResource={useResource} /> : <p className={css.quiet}>{t('noPrompt')}</p>}
    </div>
    <div className={css.media}>
      {shot.hasVideo
        ? <ShotVideo key={shown?.videoPath ?? 'none'} path={shown?.videoPath ?? ''} poster={media.value?.firstFramePath ?? ''} current={current} epoch={epoch} useResource={useResource} loadVideo={loadVideo} t={t} />
        : <div className={css.videoEmpty}>{t('notGenerated')}</div>}
      {versions.length > 1 && <div className={css.versions} role="group" aria-label={t('versions')}>{versions.map(v =>
        <button key={v.number} type="button" aria-pressed={v.number === current} title={t('versionLabel', { number: v.number })} onClick={() => setVersion(v.number)}>{v.number}</button>)}</div>}
    </div>
    <div className={css.side}>
      <dl className={css.params}>
        <div><dt>{t('paramModel')}</dt><dd>{model}</dd></div>
        <div><dt>{t('generationMode')}</dt><dd>{generation || t('platformDefault')}</dd></div>
        <div><dt>{t('aspect')}</dt><dd>{config?.aspect || '—'}</dd></div>
        <div><dt>{t('paramClarity')}</dt><dd>{config?.resolution || '—'}</dd></div>
        <div><dt>{t('duration')}</dt><dd>{shot.durationSec === null ? '—' : t('seconds', { value: shot.durationSec.toFixed(1) })}</dd></div>
        <div><dt>{t('quantity')}</dt><dd>1</dd></div>
      </dl>
      <div className={css.materials}>
        {materials.map(a =>
          <span key={a.id} className={css.material} title={a.name}>
            <span className={css.materialFace}>
              {a.imagePath ? <Picture path={a.imagePath} epoch={epoch} useResource={useResource} name={a.name} /> : null}
            </span>
            <small>{a.name}</small>
          </span>)}
        <button type="button" className={css.materialAdd} aria-label={t('pickAsset')} title={t('pickAsset')} onClick={() => compose(t('pickAssetRequest', { shot: label }))}><IconPlusOutlineRegular size={18} /></button>
      </div>
      <footer className={css.cardFoot}>
        <Button size="sm" variant="primary" aria-pressed={quoted} onClick={() => { if (!quoted) quote(label); setQuoted(!quoted) }}>{quoted ? t('quoted') : t('quoteShot')}</Button>
        <Button size="sm" variant="outline" className={css.grow} onClick={() => compose(t(shot.hasVideo ? 'againRequest' : 'generateRequest', { shot: label }))}>{shot.hasVideo ? t('again') : t('generate')}</Button>
      </footer>
    </div>
  </article>
}

function pickVersion(media: StudioShotMedia, version: number | null): { videoPath: string; model: string } {
  const picked = media.versions.find(v => v.number === (version ?? media.adoptedVersion))
  return picked ? { videoPath: picked.videoPath || media.videoPath, model: picked.model } : { videoPath: media.videoPath, model: '' }
}

// The first frame until the user plays it; the Host fetches the video on demand and the
// page holds it as an object URL until the card leaves.
type VideoProps = { path: string; poster: string; current: number | null; epoch: number; useResource: Read; loadVideo: ProductionActions['loadVideo']; t: Text }

function ShotVideo({ path, poster, current, epoch, useResource, loadVideo, t }: VideoProps) {
  const [playing, setPlaying] = useState(false)
  const [url, setUrl] = useState('')
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    if (!playing || !path) return undefined
    const controller = new AbortController()
    let made = ''
    void loadVideo(path, controller.signal).then((next) => {
      if (controller.signal.aborted) { URL.revokeObjectURL(next); return }
      made = next
      setUrl(next)
    }, () => {
      if (controller.signal.aborted) return
      setFailed(true)
      setPlaying(false)
    })
    return () => { controller.abort(); if (made) URL.revokeObjectURL(made) }
  }, [playing, path, loadVideo])
  if (url) return <video className={css.video} src={url} controls autoPlay playsInline />
  return <button type="button" className={css.poster} disabled={!path || playing} aria-label={failed ? t('videoFailed') : t('playVideo')} title={failed ? t('videoFailed') : undefined} onClick={() => { setFailed(false); setPlaying(true) }}>
    {poster ? <Picture path={poster} epoch={epoch} useResource={useResource} name="" /> : null}
    <span className={css.play} aria-hidden="true">{playing ? '…' : failed ? '!' : '▶'}</span>
    {current !== null && <small className={css.versionTag}>{t('versionLabel', { number: current })}</small>}
  </button>
}

// --- floating cards ----------------------------------------------------------------------------

type ExportProps = { t: Text; episodes: StudioEpisode[]; compose: (text: string) => void; onClose: () => void }

function ExportCard({ t, episodes, compose, onClose }: ExportProps) {
  const ready = episodes.filter(e => e.hasShots).map(e => e.number)
  const missing = episodes.filter(e => !e.hasShots).map(e => e.number)
  const [picked, setPicked] = useState<number[]>(ready)
  const [options, setOptions] = useState({ subtitles: true, music: true, ending: true, watermark: true })
  const [mark, setMark] = useState(t('watermarkDefault'))
  const all = picked.length === ready.length && ready.length > 0
  const toggle = (number: number) => {
    setPicked(list => list.includes(number) ? list.filter(n => n !== number) : [...list, number].sort((a, b) => a - b))
  }
  const send = () => {
    const extras = [options.subtitles && t('exportSubtitles'), options.music && t('exportMusic'), options.ending && t('exportEnding'),
      options.watermark && t('exportWatermark', { text: mark.trim() || t('watermarkDefault') })].filter(Boolean).join(t('listJoin'))
    compose(t('exportRequest', { episodes: picked.join(t('listJoin')), extras: extras || t('exportNothing') }))
    onClose()
  }
  const option = (key: keyof typeof options, label: string, extra?: ReactNode) => <div className={css.option}>
    <span className={css.optionName}>{label}</span>
    {options[key] && extra}
    <span className={css.spacer} />
    <Switch checked={options[key]} label={label} onChange={on => setOptions(o => ({ ...o, [key]: on }))} />
  </div>
  const summary = [picked.length > 0 ? t('exportPicked', { count: picked.length }) : t('exportNone'),
    missing.length > 0 ? t('exportMissing', { episodes: rangeText(missing, t) }) : ''].filter(Boolean).join(' · ')
  return <Modal open title={t('batchExport')} closeLabel={t('close')} onClose={onClose}
    footer={<><Button variant="ghost" onClick={onClose}>{t('cancel')}</Button><Button variant="primary" disabled={picked.length === 0} onClick={send}>{t('exportDrafts')}</Button></>}>
    <div className={css.exportHead}><Button size="sm" variant="ghost" disabled={ready.length === 0} aria-pressed={all} onClick={() => setPicked(all ? [] : ready)}>{t('selectAll')}</Button></div>
    <div className={css.exportEpisodes}>{episodes.map(e =>
      <button key={e.number} type="button" aria-pressed={picked.includes(e.number)} disabled={!e.hasShots}
        aria-label={e.hasShots ? t('episodeNumber', { number: e.number }) : t('episodeNoVideo', { number: e.number })} onClick={() => toggle(e.number)}>{e.number}</button>)}</div>
    <div className={css.exportOptions} role="group" aria-label={t('withOptions')}>
      <small className={css.quiet}>{t('withOptions')}</small>
      {option('subtitles', t('optionSubtitles'))}
      {option('music', t('optionMusic'))}
      {option('ending', t('optionEnding'), <span className={css.chips}><span className={css.chip}>{t('endingEffect')}</span><span className={css.chip}>{t('endingSound')}</span></span>)}
      {option('watermark', t('optionWatermark'), <Input aria-label={t('watermarkText')} className={css.markInput} maxLength={40} value={mark} onChange={e => setMark(e.target.value)} />)}
    </div>
    <p className={css.quiet}>{summary}</p>
  </Modal>
}

// "1–3, 5" for a sorted list of episode numbers.
function rangeText(numbers: number[], t: Text): string {
  const runs: string[] = []
  for (let i = 0; i < numbers.length; i += 1) {
    let j = i
    while (j + 1 < numbers.length && numbers[j + 1] === (numbers[j] ?? 0) + 1) j += 1
    runs.push(j > i ? `${numbers[i]}–${numbers[j]}` : String(numbers[i]))
    i = j
  }
  return runs.join(t('listJoin'))
}

type PosterProps = { t: Text; title: string; leads: string[]; compose: (text: string) => void; onClose: () => void }

function PosterCard({ t, title, leads, compose, onClose }: PosterProps) {
  const [name, setName] = useState(title)
  const [ratios, setRatios] = useState<string[]>([...POSTER_RATIOS])
  const [people, setPeople] = useState<string[]>(leads.slice(0, 2))
  const count = ratios.length + people.length
  const flip = (list: string[], value: string) => list.includes(value) ? list.filter(v => v !== value) : [...list, value]
  const send = () => {
    compose(t('posterRequest', { title: name.trim(), ratios: ratios.join(t('listJoin')) || t('exportNothing'),
      leads: people.join(t('listJoin')) || t('exportNothing'), count }))
    onClose()
  }
  return <Modal open title={t('generatePoster')} closeLabel={t('close')} onClose={onClose}
    footer={<><Button variant="ghost" onClick={onClose}>{t('cancel')}</Button><Button variant="primary" disabled={count === 0 || name.trim() === ''} onClick={send}>{t('generatePoster')}</Button></>}>
    <div className={css.form}>
      <div className={css.field}><span className={css.fieldLabel}>{t('posterTitle')}</span>
        <div className={css.fieldControl}><Input data-modal-autofocus aria-label={t('posterTitle')} value={name} onChange={e => setName(e.target.value)} /><small className={css.quiet}>{t('posterTitleHint')}</small></div></div>
      <div className={css.field}><span className={css.fieldLabel}>{t('posterRatios')}</span>
        <div className={css.fieldControl}><span className={css.picks}>{POSTER_RATIOS.map(r =>
          <button key={r} type="button" aria-pressed={ratios.includes(r)} onClick={() => setRatios(list => flip(list, r))}>{r}</button>)}</span></div></div>
      {leads.length > 0 && <div className={css.field}><span className={css.fieldLabel}>{t('posterLeads')}</span>
        <div className={css.fieldControl}><span className={css.picks}>{leads.map(p =>
          <button key={p} type="button" aria-pressed={people.includes(p)} onClick={() => setPeople(list => flip(list, p))}>{p}</button>)}</span></div></div>}
      <p className={css.quiet}>{t('posterCount', { count })}</p>
    </div>
  </Modal>
}
