/** Real inline video cards retain their place while the scroll animation collects them. */
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { useEffect, useRef, useState } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionVideoSource } from '@deepseek-ai/dsh-session-video'
import type { VideoShared } from './face.ts'
import { useAbsorption } from './useAbsorption.tsx'
import css from './VideoShelf.module.css'

/** Stable local playback element; no React-owned DOM is reparented by motion.
 * @param props - Authorized source, display name, and collection actions.
 * @returns An inline player and its transient animation layer.
 */
export function InlineVideoCard({ source, sourceUrl, label, actions, t }: Pick<VideoShared, 'actions' | 't'> & {
  readonly source: SessionVideoSource | undefined
  readonly sourceUrl: string
  readonly label: string
}) {
  const card = useRef<HTMLDivElement>(null)
  const video = useRef<HTMLVideoElement>(null)
  const [failed, setFailed] = useState(false)
  const id = source?.id ?? sourceUrl
  const absorption = useAbsorption(card, { id,
    onCollect: (value) => { actions.collect(id, value) },
    onOpen: () => { if (source) actions.openSource(source.id) } })
  useEffect(() => {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- A committed inline card always includes its video element.
    const element = video.current!
    element.src = sourceUrl
    return () => { element.pause(); element.removeAttribute('src'); element.load() }
  }, [sourceUrl])
  return <><div ref={card} className={css.inlineCard} data-muse-inline-video aria-label={t('collected')}>
    <div className={css.inlineLabel}>{label}</div>
    {failed && <p role="alert">{t('unavailable')} <Button size="sm" onClick={() => { setFailed(false); video.current?.load() }}>{t('retry')}</Button></p>}
    <video ref={video} src={sourceUrl} controls playsInline preload="metadata" aria-label={label}
      onError={() => { setFailed(true) }} />
  </div>{absorption}</>
}

/** Replace delivered-file video playback through the owner's chain slot.
 * @param props - Declared file coordinates and the shared Session store.
 * @returns The real inline player; native file controls remain with Deliverables.
 */
export function DeliveredVideoCard(props: PropsRuntime<'deliverables.video'> & VideoShared) {
  const source = props.useStore(state => state.sources.find(item => item.eventSeq === props.seq && item.presentedIndex === props.index))
  return <InlineVideoCard source={source} sourceUrl={props.sourceUrl} label={props.label} actions={props.actions} t={props.t} />
}

/** Display provider-generated results even when no explicit present call was made.
 * @param props - Closing Turn and the observed Session inventory.
 * @returns Generated videos recorded inside this Turn without a duplicate delivery card.
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
    return [<InlineVideoCard key={source.id} source={source} sourceUrl={source.playbackUrl}
      label={source.label} actions={props.actions} t={props.t} />]
  })}</>
}
