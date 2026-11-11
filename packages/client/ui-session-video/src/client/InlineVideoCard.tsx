/** Session-bound inline video playback and shot editing. */
import { Button, IconRefreshOutlineRegular, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { useEffect, useRef, useState } from 'react'
import type { PropsRuntime, SessionStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionVideoSource } from '@deepseek-ai/dsh-session-video'
import type { VideoShared } from './face.ts'
import { VideoPlayer } from './VideoPlayer.tsx'
import { assembleTimeline } from './timeline.ts'
import css from './VideoShelf.module.css'

type InlineProps = Pick<SessionStandardProps, 'useInput' | 'inputActions'> & VideoShared & {
  readonly source: SessionVideoSource | undefined
  readonly sourceUrl: string
  readonly label: string
}

/** Render the full Session video player in each recorded video's chat card.
 * @param props - Authorized original source and Session-bound player actions.
 * @returns A player with independent source selection, filmstrip, and modification draft.
 */
export function InlineVideoCard({ source: original, sourceUrl, label, useStore, actions, useInput, inputActions,
  pixelsPerSecond, t }: InlineProps) {
  const sources = useStore(state => state.sources)
  const analyses = useStore(state => state.analyses)
  const errors = useStore(state => state.detectErrors)
  const draftLength = useInput(state => state.draft.length)
  const draftRev = useInput(state => state.draftRev)
  const [selectedSource, setSelectedSource] = useState<string | null>(null)
  const [pendingUrl, setPendingUrl] = useState<string | null>(null)
  const [failedVersion, setFailedVersion] = useState<string | null>(null)
  const [selection, setSelection] = useState<string | null>(null)
  const [zoom, setZoom] = useState(1)
  const [seek, setSeek] = useState<{ time: number; revision: number } | null>(null)
  const [visible, setVisible] = useState(() => typeof IntersectionObserver === 'undefined')
  const card = useRef<HTMLDivElement>(null)
  const originalIdentity = useRef(sourceUrl)
  const revision = useRef(0)
  const source = sources.find(value => value.id === (selectedSource ?? original?.id))
  useEffect(() => {
    const element = card.current
    if (element === null || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver((entries) => { setVisible(entries.some(entry => entry.isIntersecting)) })
    observer.observe(element)
    return () => { observer.disconnect() }
  }, [])
  useEffect(() => {
    if (!visible || source === undefined) return
    actions.observe(source.id, 1)
    return () => { actions.observe(source.id, -1) }
  }, [visible, source?.id, actions])
  const timeline = assembleTimeline(sources, Object.values(analyses))
  const hasBoundSource = source !== undefined && source.status === 'local' && source.version !== null && source.playbackUrl !== null
  const binding = source === undefined ? null : JSON.stringify([source.id, source.version])
  const canUseTimeline = hasBoundSource && pendingUrl === null && failedVersion !== binding
  const shot = canUseTimeline ? timeline.shots.find(value => value.id === selection) : undefined
  const selectShot = (id: string) => {
    const target = timeline.shots.find(value => value.id === id)
    if (!target) return
    setPendingUrl(null); setSelectedSource(target.source.id === original?.id ? null : target.source.id); setSelection(id)
    setSeek({ time: target.localStart, revision: ++revision.current })
  }
  const seekTo = (time: number) => {
    const target = timeline.shots.find((value, index) => time >= value.startSeconds
      && (time < value.endSeconds || index === timeline.shots.length - 1))
    if (!target) return
    setPendingUrl(null); setSelectedSource(target.source.id === original?.id ? null : target.source.id); setSelection(target.id)
    setSeek({ time: target.localStart + Math.min(time, target.endSeconds) - target.startSeconds, revision: ++revision.current })
  }
  const analysis = source === undefined ? undefined : analyses[source.id]
  const currentAnalysis = analysis?.sourceVersion === source?.version ? analysis : undefined
  const failed = source !== undefined && (currentAnalysis?.state === 'failed' || errors[source.id] === source.version)
  const playbackSource = selectedSource === null
    ? { id: `original:${originalIdentity.current}`, label: source?.label ?? label,
      playbackUrl: pendingUrl ?? (hasBoundSource ? source.playbackUrl : sourceUrl) }
    : source === undefined ? undefined : { id: source.id, label: source.label, playbackUrl: pendingUrl ?? source.playbackUrl }
  const changeSource = (id: string) => {
    setPendingUrl(null); setSelectedSource(id === original?.id ? null : id); setSelection(null); setSeek(null)
  }
  return <div ref={card} className={css.inlineCard} data-muse-inline-video>
    <div className={css.inlineHeading}>
      {source !== undefined ? <select aria-label={t('library')} value={source.id} onChange={(event) => { changeSource(event.currentTarget.value) }}>
        {sources.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
      </select> : selectedSource === null ? <span className={css.inlineLabel}>{label}</span>
        : <><select aria-label={t('library')} value="" onChange={(event) => { changeSource(event.currentTarget.value) }}>
          <option value="" disabled>{t('unavailable')}</option>
          {sources.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
        </select><Button size="sm" onClick={() => { setPendingUrl(null); setSelectedSource(null); setSelection(null); setSeek(null) }}>{t('originalVideo')}</Button></>}
      {source !== undefined && <Tooltip label={t('selectShotToRedo')} disabled={shot !== undefined} portal>
        <span><Button size="sm" disabled={shot === undefined} onClick={() => {
          if (shot === undefined) return
          const prompt = t('redoPrompt', { name: shot.source.label, source: shot.source.path ?? shot.source.id,
            id: shot.id, start: shot.localStart.toFixed(3), end: shot.localEnd.toFixed(3) })
          if (inputActions.insertText(`\n\n${prompt}`, { start: draftLength, end: draftLength, draftRev })) inputActions.persistDraft()
        }}><IconRefreshOutlineRegular /><span>{t('redo')}</span></Button></span>
      </Tooltip>}
    </div>
    <div className={css.inlineContents}>
      {playbackSource?.playbackUrl !== null && playbackSource !== undefined ? <VideoPlayer
        active={visible} nativeControls source={playbackSource} analysis={canUseTimeline ? currentAnalysis : undefined} t={t}
        onUserInteract={() => { if (!hasBoundSource && playbackSource.playbackUrl !== null) setPendingUrl(playbackSource.playbackUrl) }}
        onPlaybackFailureChange={(value) => { setFailedVersion(value ? binding : null) }}
        shots={canUseTimeline ? timeline.shots : []} offset={source === undefined ? 0 : timeline.offsets[source.id] ?? 0}
        duration={timeline.duration} pixelsPerSecond={pixelsPerSecond} zoom={zoom} onZoom={setZoom}
        selectedShot={selection} seekRequest={seek} onSeek={seekTo} onSelectShot={selectShot} />
        : <p className={css.status} role="alert">{t('unavailable')}</p>}
      {pendingUrl !== null && hasBoundSource && <div className={css.status} role="status">{t('unboundVideo')}
        <Button size="sm" onClick={() => { setPendingUrl(null); setSelection(null); setSeek(null) }}>{t('bindVideo')}</Button></div>}
      {binding !== null && failedVersion === binding && <div className={css.status} role="status">{t('unavailable')}
        <Button size="sm" onClick={() => { actions.refreshInventory() }}>{t('retry')}</Button></div>}
      {source?.status === 'remote-only' && currentAnalysis?.state === 'ready'
        && <div className={css.status} role="status">{t('awaitBoundVideo')}
          <Button size="sm" onClick={() => { actions.refreshInventory() }}>{t('retry')}</Button></div>}
      {failed ? <div className={css.status} role="status">{t('detectionFailed')}
        <Button size="sm" onClick={() => { actions.retryFailed() }}>{t('retry')}</Button></div>
        : visible && currentAnalysis === undefined && source?.version !== null && source?.playbackUrl !== null && source !== undefined
          ? <div className={css.status} role="status">{t('detecting')}</div> : null}
    </div>
  </div>
}

/** Replace delivered-file video playback through the owner's chain slot.
 * @param props - Declared file coordinates and the shared Session store.
 * @returns The inline player; native file controls remain with Deliverables.
 */
export function DeliveredVideoCard(props: PropsRuntime<'deliverables.video'> & VideoShared) {
  const source = props.useStore(state => state.sources.find(item => item.eventSeq === props.seq && item.presentedIndex === props.index))
  return <InlineVideoCard {...props} source={source} />
}

/** Display generated results recorded in this Turn without duplicating delivered files.
 * @param props - Closing Turn and the observed Session inventory.
 * @returns The Session-bound inline video players for this Turn.
 */
export function GeneratedVideoCards(props: PropsRuntime<'conversation.chat.turnTail'> & VideoShared) {
  const sources = props.useStore(state => state.sources)
  const start = props.turn.start?.seq
  const end = props.turn.end?.seq ?? props.seq
  if (start === undefined) return null
  return <>{sources.flatMap((source) => {
    if (source.origin !== 'generated' || source.presentedIndex !== null || source.eventSeq < start
      || source.eventSeq > end || source.playbackUrl === null
      || sources.some(item => item.presentedIndex !== null && item.path !== null && item.path === source.path)) return []
    return [<InlineVideoCard {...props} key={source.id} source={source} sourceUrl={source.playbackUrl} label={source.label} />]
  })}</>
}
