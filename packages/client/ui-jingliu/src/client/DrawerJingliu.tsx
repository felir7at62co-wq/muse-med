/**
 * The Jingliu tab of the Bot team's details drawer: pick a production for this conversation,
 * then look through its assets and shot videos.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Button, Checkbox, Input, Modal, SegmentedTabs, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { StudioConfig, StudioProject, StudioProjectAsset, StudioShot, StudioShotMedia } from '@deepseek-ai/dsh-jingliu-connection/types'
import { address, Failure, Picture, useAction, type ProductionActions, type Read, type Text } from './Production.tsx'
import css from './DrawerJingliu.module.css'

type Props = PropsLocale<'jingliuStudio'> & PropsRuntime<'bot.drawer.jingliu'> & InjectFace<ProductionActions>
type Page = 'assets' | 'videos'
type Kind = 'character' | 'location' | 'prop' | 'audio'
const NO_ASSETS: StudioProjectAsset[] = []

/**
 * The Jingliu tab: the production tied to this conversation, or the list to pick one from.
 * @param props - The Bot's conversation, the studio resources and the message-box callbacks.
 * @returns The project picker or the workbench.
 */
export function DrawerJingliu(props: Props) {
  const { sessionId, useResource, useAccountEpoch } = props
  const epoch = useAccountEpoch(n => n)
  const selected = useResource<'jingliu-selected'>(address('jingliu-selected', epoch, 0, { id: sessionId }))
  const [choosing, setChoosing] = useState(false)
  if (selected.status === 'failed') return <section className={css.drawer}><Failure t={props.t} retry={() => setChoosing(true)} /></section>
  if (selected.status !== 'live') return <section className={css.drawer}><p className={css.quiet}>{props.t('loading')}</p></section>
  if (!selected.value || choosing) return <ProjectPicker {...props} epoch={epoch} onDone={() => setChoosing(false)} />
  const project = selected.value
  return <Workbench {...props} epoch={epoch} projectId={project.id} title={project.title} onSwitch={() => { setChoosing(true) }} />
}

function ProjectPicker({ sessionId, t, useResource, chooseProject, epoch, onDone }: Props & { epoch: number; onDone: () => void }) {
  const [revision, refresh] = useState(0)
  const [query, setQuery] = useState('')
  const data = useResource<'jingliu-projects'>(address('jingliu-projects', epoch, revision))
  const act = useAction()
  const needle = query.trim().toLocaleLowerCase()
  const rows = (data.value ?? []).filter(p => p.title.toLocaleLowerCase().includes(needle))
  const pick = (project: StudioProject) => { void act.run(async () => { await chooseProject(sessionId, project); onDone() }) }
  return <section className={css.drawer}>
    <Input aria-label={t('searchProjects')} placeholder={t('searchProjects')} value={query} onChange={e => setQuery(e.target.value)} />
    {data.status === 'failed' ? <Failure t={t} retry={() => refresh(n => n + 1)} /> : data.status !== 'live' ? <p className={css.quiet}>{t('loading')}</p>
      : rows.length === 0 ? <p className={css.quiet}>{t('emptyProjects')}</p>
        : <div className={css.projects}>{rows.map(p =>
          <button key={p.id} type="button" className={css.project} disabled={act.busy} onClick={() => pick(p)}>
            <span className={css.projectCover}><Picture path={p.thumbnail} epoch={epoch} useResource={useResource} name={p.title} /></span>
            <span className={css.projectText}><strong>{p.title}</strong><small>{t('projectStats', { episodes: p.episodes, done: p.completed, shots: p.shots })}</small></span>
          </button>)}</div>}
    {act.error && <p role="alert" className={css.quiet}>{t('navFailed')}</p>}
  </section>
}

function Workbench(props: Props & { epoch: number; projectId: string; title: string; onSwitch: () => void }) {
  const { t, useResource, epoch, projectId, title, onSwitch } = props
  const [page, setPage] = useState<Page>('videos')
  const [card, setCard] = useState<'config' | 'export' | null>(null)
  const config = useResource<'jingliu-config'>(address('jingliu-config', epoch, 0, { id: projectId }))
  const episodes = useResource<'jingliu-episodes'>(address('jingliu-episodes', epoch, 0, { id: projectId }))
  const tabs = [
    { value: 'assets', label: t('assetsPage'), id: 'jl-page-assets', panelId: 'jl-page' },
    { value: 'videos', label: t('videosPage'), id: 'jl-page-videos', panelId: 'jl-page' },
  ] as const
  return <section className={css.drawer}>
    <div className={css.bar}>
      <button type="button" className={css.projectPill} title={t('switchProject')} onClick={onSwitch}>{title}</button>
      <Button size="sm" variant="outline" onClick={() => setCard('config')}>{t('projectConfig')}</Button>
      <Button size="sm" className={css.export} onClick={() => setCard('export')}>{t('batchExport')}</Button>
    </div>
    <SegmentedTabs items={tabs} value={page} onChange={setPage} label={t('workbenchPages')} size="sm" />
    <div role="tabpanel" id="jl-page" aria-labelledby={'jl-page-' + page} className={css.body}>
      {page === 'assets'
        ? <AssetsPage t={t} useResource={useResource} epoch={epoch} projectId={projectId} quote={props.quote} />
        : <VideosPage {...props} config={config.value ?? null} />}
    </div>
    <Modal open={card === 'config'} title={t('projectConfig')} closeLabel={t('close')} onClose={() => setCard(null)}>
      {config.status === 'failed' ? <Failure t={t} retry={() => setCard('config')} /> : config.value ? <ConfigRows t={t} config={config.value} /> : <p className={css.quiet}>{t('loading')}</p>}
    </Modal>
    {card === 'export' && <ExportCard t={t} episodes={episodes.value ?? []} compose={props.compose} onClose={() => setCard(null)} />}
  </section>
}

function ConfigRows({ t, config }: { t: Text; config: StudioConfig }) {
  const rows: [string, string][] = [
    [t('projectName'), config.title], [t('productionMode'), config.mode === 'narration' ? t('modeNarration') : t('modeDrama')],
    [t('artStyle'), config.artStyle], [t('aspect'), config.aspect], [t('resolution'), config.resolution],
    [t('videoModel'), config.videoModel || t('platformDefault')], [t('imageModel'), config.imageModel || t('platformDefault')],
  ]
  return <dl className={css.rows}>{rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value || '—'}</dd></div>)}</dl>
}

// Clip kinds the studio reports, as their tab labels.
const AUDIO_KINDS = { voice: 'audioVoice', narration: 'audioNarration', music: 'audioMusic', sfx: 'audioSfx' } as const
const audioKind = (t: Text, kind: string) => t(Object.hasOwn(AUDIO_KINDS, kind) ? AUDIO_KINDS[kind as keyof typeof AUDIO_KINDS] : 'audioOther')

type AssetsProps = { t: Text; useResource: Read; epoch: number; projectId: string; quote: (text: string) => void }

function AssetsPage({ t, useResource, epoch, projectId, quote }: AssetsProps) {
  const data = useResource<'jingliu-project-assets'>(address('jingliu-project-assets', epoch, 0, { id: projectId }))
  const [kind, setKind] = useState<Kind>('character')
  const tab = (value: Kind) => ({ value, label: t(value), id: 'jl-kind-' + value, panelId: 'jl-kind' })
  const tabs = [tab('character'), tab('location'), tab('prop'), tab('audio')] as const
  const items = (data.value?.assets ?? []).filter(a => a.kind === kind)
  return <>
    <SegmentedTabs items={tabs} value={kind} onChange={setKind} label={t('assetType')} size="sm" />
    <div role="tabpanel" id="jl-kind" aria-labelledby={'jl-kind-' + kind}>
      {data.status === 'failed' ? <p className={css.quiet}>{t('failed')}</p> : data.status !== 'live' ? <p className={css.quiet}>{t('loading')}</p>
        : kind === 'audio'
          ? (data.value?.audio.length ? <ul className={css.audio}>{data.value.audio.map(clip =>
            <li key={clip.id}><span className={css.audioKind}>{audioKind(t, clip.kind)}</span><span className={css.audioText}>{clip.text || '—'}</span>{clip.durationSec !== null && <small>{t('seconds', { value: clip.durationSec.toFixed(1) })}</small>}</li>)}</ul>
            : <p className={css.quiet}>{t('emptyAssets')}</p>)
          : items.length === 0 ? <p className={css.quiet}>{t('emptyAssets')}</p>
            : <div className={css.assetGrid}>{items.map(a =>
              <button key={a.id} type="button" className={css.asset} title={t('quoteAsset')} onClick={() => quote(t('assetQuote', { name: a.name }))}>
                <span className={kind === 'character' ? css.assetPortrait : css.assetPoster}>
                  <Picture path={a.imagePath} epoch={epoch} useResource={useResource} name={a.name} unavailable={t('imageFailed')} />
                </span>
                <strong>{a.name}</strong>
                {a.prompt && <small className={css.clamp}>{a.prompt}</small>}
              </button>)}</div>}
    </div>
  </>
}

function VideosPage(props: Props & { epoch: number; projectId: string; config: StudioConfig | null }) {
  const { t, useResource, epoch, projectId } = props
  const episodes = useResource<'jingliu-episodes'>(address('jingliu-episodes', epoch, 0, { id: projectId }))
  const assets = useResource<'jingliu-project-assets'>(address('jingliu-project-assets', epoch, 0, { id: projectId })).value?.assets ?? NO_ASSETS
  const list = episodes.value ?? []
  const [chosen, choose] = useState<number | null>(null)
  const episode = chosen ?? list.find(e => e.hasShots)?.number ?? list[0]?.number ?? null
  const shots = useResource<'jingliu-shots'>(episode === null ? 'studio://inactive' : address('jingliu-shots', epoch, 0, { id: projectId, episode: String(episode) }))
  if (episodes.status === 'failed') return <p className={css.quiet}>{t('failed')}</p>
  if (episodes.status !== 'live') return <p className={css.quiet}>{t('loading')}</p>
  if (episode === null) return <p className={css.quiet}>{t('emptyEpisodes')}</p>
  return <div className={css.videos}>
    <nav className={css.episodes} aria-label={t('episodes')}>{list.map(e =>
      <button key={e.number} type="button" aria-current={e.number === episode ? 'true' : undefined} className={e.hasShots ? undefined : css.noShots} onClick={() => choose(e.number)}>{e.number}</button>)}</nav>
    <div className={css.cards}>
      {shots.status === 'failed' ? <p className={css.quiet}>{t('failed')}</p> : shots.status !== 'live' ? <p className={css.quiet}>{t('loading')}</p>
        : !shots.value?.length ? <p className={css.quiet}>{t('emptyShots')}</p>
          : shots.value.map(shot => <ShotCard key={shot.id} {...props} assets={assets} shot={shot} episode={episode} />)}
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
      {asset.imagePath && <span className={css.mentionFace}><Picture path={asset.imagePath} epoch={epoch} useResource={useResource} name="" /></span>}@{part}
    </span>
  })
  return <p className={css.prompt}>{parts}</p>
}

type CardProps = Props & {
  epoch: number
  projectId: string
  config: StudioConfig | null
  assets: StudioProjectAsset[]
  shot: StudioShot
  episode: number
}

function ShotCard({ t, useResource, epoch, projectId, config, assets, shot, episode, quote, compose, loadVideo }: CardProps) {
  const media = useResource<'jingliu-shot-media'>(shot.hasVideo || shot.failReason ? address('jingliu-shot-media', epoch, 0, { id: projectId, shot: shot.id }) : 'studio://inactive')
  const [version, setVersion] = useState<number | null>(null)
  const label = t('shotLabel', { episode, index: shot.index })
  const shown = media.value ? pickVersion(media.value, version) : null
  const model = shown?.model || config?.videoModel || t('platformDefault')
  const materials = assets.filter(a => a.name === shot.location || shot.characters.includes(a.name) || shot.props.includes(a.name))
  return <article className={css.card} aria-label={label}>
    <header className={css.cardHead}>
      <strong>{label}</strong>
      {shot.failReason ? <small className={css.failed}>{shot.failReason}</small> : !shot.hasVideo ? <small className={css.quiet}>{t('noVideo')}</small> : null}
    </header>
    {shot.prompt ? <PromptText prompt={shot.prompt} assets={assets} epoch={epoch} useResource={useResource} /> : <p className={css.quiet}>{t('noPrompt')}</p>}
    {shot.hasVideo && <div className={css.media}>
      <ShotVideo key={shown?.videoPath ?? 'none'} path={shown?.videoPath ?? ''} poster={media.value?.firstFramePath ?? ''} epoch={epoch} useResource={useResource} loadVideo={loadVideo} t={t} />
      {media.value && media.value.versions.length > 1 && <div className={css.versions} role="group" aria-label={t('versions')}>{media.value.versions.map(v =>
        <button key={v.number} type="button" aria-pressed={v.number === (version ?? media.value?.adoptedVersion)} title={t('versionLabel', { number: v.number })} onClick={() => setVersion(v.number)}>{v.number}</button>)}</div>}
    </div>}
    <dl className={css.params}>
      <div><dt>{t('videoModel')}</dt><dd>{model}</dd></div>
      <div><dt>{t('aspect')}</dt><dd>{config?.aspect || '—'}</dd></div>
      <div><dt>{t('resolution')}</dt><dd>{config?.resolution || '—'}</dd></div>
      <div><dt>{t('duration')}</dt><dd>{shot.durationSec === null ? '—' : t('seconds', { value: shot.durationSec.toFixed(1) })}</dd></div>
    </dl>
    {materials.length > 0 && <div className={css.materials}>{materials.map(a =>
      <span key={a.id} className={css.material} title={a.name}>
        <span className={css.materialFace}><Picture path={a.imagePath} epoch={epoch} useResource={useResource} name={a.name} /></span>
        <small>{a.name}</small>
      </span>)}</div>}
    <footer className={css.cardFoot}>
      <Button size="sm" variant="primary" onClick={() => quote(label)}>{t('quoteShot')}</Button>
      <Button size="sm" variant="outline" onClick={() => compose(t('againRequest', { shot: label }))}>{t('again')}</Button>
    </footer>
  </article>
}

function pickVersion(media: StudioShotMedia, version: number | null): { videoPath: string; model: string } {
  const picked = media.versions.find(v => v.number === (version ?? media.adoptedVersion))
  return picked ? { videoPath: picked.videoPath || media.videoPath, model: picked.model } : { videoPath: media.videoPath, model: '' }
}

// The first frame until the user plays it; the Host fetches the video on demand and the
// page holds it as an object URL until the card leaves.
function ShotVideo({ path, poster, epoch, useResource, loadVideo, t }: { path: string; poster: string; epoch: number; useResource: Read; loadVideo: ProductionActions['loadVideo']; t: Text }) {
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
  </button>
}

type ExportProps = { t: Text; episodes: { number: number; hasShots: boolean }[]; compose: (text: string) => void; onClose: () => void }

function ExportCard({ t, episodes, compose, onClose }: ExportProps) {
  const ready = episodes.filter(e => e.hasShots).map(e => e.number)
  const [picked, setPicked] = useState<number[]>(ready)
  const [options, setOptions] = useState({ subtitles: true, music: true, ending: true, watermark: true })
  const all = picked.length === ready.length && ready.length > 0
  const toggle = (number: number) => {
    setPicked(list => list.includes(number) ? list.filter(n => n !== number) : [...list, number].sort((a, b) => a - b))
  }
  const send = () => {
    const extras = [options.subtitles && t('exportSubtitles'), options.music && t('exportMusic'), options.ending && t('exportEnding'), options.watermark && t('exportWatermark')].filter(Boolean).join(t('listJoin'))
    compose(t('exportRequest', { episodes: picked.join(t('listJoin')), extras: extras || t('exportNothing') }))
    onClose()
  }
  return <Modal open title={t('batchExport')} closeLabel={t('close')} onClose={onClose}
    footer={<><Button variant="ghost" onClick={onClose}>{t('cancel')}</Button><Button variant="primary" disabled={picked.length === 0} onClick={send}>{t('exportDrafts')}</Button></>}>
    <Checkbox checked={all} label={t('selectAll')} onChange={next => setPicked(next ? ready : [])} />
    <div className={css.exportEpisodes}>{episodes.map(e =>
      <Checkbox key={e.number} checked={picked.includes(e.number)} disabled={!e.hasShots} label={t('episodeNumber', { number: e.number })} onChange={() => toggle(e.number)} />)}</div>
    <div className={css.exportOptions}>
      <Switch checked={options.subtitles} label={t('optionSubtitles')} onChange={subtitles => setOptions(o => ({ ...o, subtitles }))} />
      <Switch checked={options.music} label={t('optionMusic')} onChange={music => setOptions(o => ({ ...o, music }))} />
      <Switch checked={options.ending} label={t('optionEnding')} onChange={ending => setOptions(o => ({ ...o, ending }))} />
      <Switch checked={options.watermark} label={t('optionWatermark')} onChange={watermark => setOptions(o => ({ ...o, watermark }))} />
    </div>
  </Modal>
}
