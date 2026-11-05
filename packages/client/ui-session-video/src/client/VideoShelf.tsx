/** Conversation-owned single-player shelf and real cut ranges across its videos. */
import { useEffect, useRef, useState } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { Button, IconChevronDownOutlineRegular, IconChevronUpOutlineRegular, IconRefreshOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { VideoShared } from './face.ts'
import { VideoPlayer } from './VideoPlayer.tsx'
import { assembleTimeline } from './timeline.ts'
import css from './VideoShelf.module.css'

/** Mount the spider control outside the clipped Chat scroll surface.
 * @param props - Native Session context and this plugin's declared store.
 * @returns The compact toggle and one expandable player bubble.
 */
export function VideoShelf(props: PropsRuntime<'conversation.chat.pinned'> & VideoShared) {
  const { useStore, actions, sessionId, useSession, useChat, listVideos, detectShots, pixelsPerSecond, inputActions, useInput, t } = props
  const sources = useStore(state => state.sources)
  const open = useStore(state => state.open)
  const selected = useStore(state => state.selected)
  const analyses = useStore(state => state.analyses)
  const inventoryIssue = useStore(state => state.issue)
  const draftLength = useInput(state => state.draft.length)
  const draftRev = useInput(state => state.draftRev)
  const running = useSession(state => state.running)
  const tail = useChat(state => state.order.at(-1))
  const [loadError, setLoadError] = useState(false)
  const [reload, setReload] = useState(0)
  const [detecting, setDetecting] = useState(false)
  const [detectError, setDetectError] = useState(false)
  const [selection, setSelection] = useState<string | null>(null)
  const [seek, setSeek] = useState<{ time: number; revision: number } | null>(null)
  const revision = useRef(0)
  useEffect(() => {
    const controller = new AbortController()
    void listVideos(sessionId, controller.signal).then((value) => {
      if (!controller.signal.aborted) { actions.inventory(value); setLoadError(false) }
    }).catch((_error: unknown) => { if (!controller.signal.aborted) setLoadError(true) })
    return () => { controller.abort() }
  }, [sessionId, tail, running, reload, listVideos, actions])
  const candidate = [...sources].sort((a, b) => Number(b.id === selected) - Number(a.id === selected))
    .find(item => item.version !== null && item.playbackUrl !== null && analyses[item.id]?.sourceVersion !== item.version)
  useEffect(() => {
    if (!open || candidate === undefined || candidate.version === null) { setDetecting(false); return }
    const controller = new AbortController()
    setDetecting(true); setDetectError(false)
    void detectShots(sessionId, candidate.id, candidate.version, controller.signal).then(async (value) => {
      if (controller.signal.aborted) return
      if (value.state === 'ready' && candidate.status === 'remote-only') {
        try {
          const inventory = await listVideos(sessionId, controller.signal)
          controller.signal.throwIfAborted()
          actions.inventory(inventory)
        } catch (_error: unknown) {
          // A failed optional refresh retains the original playable provider URL.
        }
      }
      controller.signal.throwIfAborted()
      actions.analysis(value)
    }).catch((_error: unknown) => { if (!controller.signal.aborted) { setDetectError(true); setDetecting(false) } })
    return () => { controller.abort() }
  }, [open, candidate, sessionId, reload, detectShots, listVideos, actions])
  const source = sources.find(value => value.id === selected) ?? sources[0]
  const timeline = assembleTimeline(sources, Object.values(analyses))
  const shot = timeline.shots.find(value => value.id === selection)
  const selectShot = (id: string) => {
    const target = timeline.shots.find(value => value.id === id)
    if (!target) return
    actions.select(target.source.id); setSelection(id)
    setSeek({ time: target.localStart, revision: ++revision.current })
  }
  const seekTo = (time: number) => {
    const target = timeline.shots.find((value, index) => time >= value.startSeconds
      && (time < value.endSeconds || index === timeline.shots.length - 1))
    if (!target) return
    actions.select(target.source.id); setSelection(target.id)
    setSeek({ time: target.localStart + Math.min(time, target.endSeconds) - target.startSeconds, revision: ++revision.current })
  }
  return <div className={css.seat} data-muse-video-shelf data-open={open || undefined}>
    <section className={css.bubble} aria-label={t('library')}>
      <div className={css.heading}>
        <button type="button" className={css.anchor} data-muse-video-anchor aria-expanded={open}
          aria-label={t('library')} onClick={() => { actions.toggle() }}>
          <span className={css.spider} aria-hidden="true" /><span>{t('brand')}</span>
          {open ? <IconChevronUpOutlineRegular /> : <IconChevronDownOutlineRegular />}
        </button>
      </div>
      <div className={css.curtain} aria-hidden={!open} ref={(element) => { if (element) element.inert = !open }}>
        <div className={css.curtainInner}>
          {open && <div className={css.contents}>
            {source === undefined ? <p className={css.status} role="status">{t(loadError ? 'unavailable' : 'empty')}</p> : <>
              <div className={css.sourceControls}>
                <select aria-label={t('library')} value={source.id} onChange={(event) => {
                  actions.select(event.currentTarget.value); setSelection(null); setSeek(null)
                }}>
                  {sources.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
                </select>
                {shot && <Button size="sm" onClick={() => {
                  const prompt = t('redoPrompt', { name: shot.source.label, source: shot.source.path ?? shot.source.id, id: shot.id,
                    start: shot.localStart.toFixed(3), end: shot.localEnd.toFixed(3) })
                  const span = { start: draftLength, end: draftLength, draftRev }
                  if (inputActions.insertText(`\n\n${prompt}`, span)) inputActions.persistDraft()
                }}><IconRefreshOutlineRegular />{t('redo')}</Button>}
              </div>
              {source.playbackUrl !== null ? <VideoPlayer key={source.id} source={source} analysis={analyses[source.id]} t={t}
                shots={timeline.shots} offset={timeline.offsets[source.id] ?? 0}
                duration={timeline.duration} pixelsPerSecond={pixelsPerSecond}
                selectedShot={selection} seekRequest={seek} onSeek={seekTo} onSelectShot={selectShot} />
                : <p className={css.status} role="alert">{t('unavailable')}</p>}
              {(detecting || detectError || analyses[source.id]?.state === 'failed') && <div className={css.status} role="status">
                {t(detecting ? 'detecting' : 'detectionFailed')}
                {!detecting && <Button size="sm" onClick={() => { actions.retryFailed(); setReload(value => value + 1) }}>{t('retry')}</Button>}
              </div>}
            </>}
            {(loadError || inventoryIssue !== null) && <div className={css.status} role="status">{t(loadError ? 'unavailable' : 'incomplete')}
              <Button size="sm" onClick={() => { setReload(value => value + 1) }}>{t('retry')}</Button></div>}
          </div>}
        </div>
      </div>
    </section>
  </div>
}
