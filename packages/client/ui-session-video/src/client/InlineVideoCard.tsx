/** Compact video entries open playback in their conversation workspace. */
import { Button, IconChevronRightOutlineRegular, IconPlayOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { useEffect, useRef, useState } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionVideoSource } from '@deepseek-ai/dsh-session-video/types'
import type { VideoShared } from './face.ts'
import { videoWorkspaceAddress } from './target-selection.ts'
import css from './VideoShelf.module.css'

/** Open the recorded source from a muted metadata thumbnail.
 * @param props - Authorized source, display name, and conversation navigation actions.
 * @returns A compact source entry; playback and retries remain in the video workspace.
 */
export function InlineVideoCard({ source, sourceUrl, label, actions, openWorkspace, t }: Pick<VideoShared, 'actions' | 'openWorkspace' | 't'> & {
  readonly source: SessionVideoSource | undefined
  readonly sourceUrl: string
  readonly label: string
}) {
  const video = useRef<HTMLVideoElement>(null)
  const [failedUrl, setFailedUrl] = useState<string | null>(null)
  const failed = failedUrl === sourceUrl
  const open = () => {
    if (source) { actions.selectEpisode(source.production?.episodeNumber ?? 'unassigned'); actions.select(source.id) }
    openWorkspace()
  }
  useEffect(() => {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- A committed inline card always includes its video element.
    const element = video.current!
    element.src = sourceUrl
    return () => { element.pause(); element.removeAttribute('src'); element.load() }
  }, [sourceUrl])
  return <div className={css.inlineCard} data-muse-inline-video>
    <Button className={css.inlineOpen} variant="ghost" aria-label={t('source', { name: label })} onClick={open}>
      <span className={css.inlineThumbnail} aria-hidden="true">
        <video ref={video} src={sourceUrl} muted playsInline preload="metadata" hidden={failed}
          onError={() => { setFailedUrl(sourceUrl) }} />
        {failed && <IconPlayOutlineRegular />}
      </span>
      <span className={css.inlineLabel}>{label}</span><IconChevronRightOutlineRegular />
    </Button>
  </div>
}

/** Replace a delivered video's preview through the owner's chain slot.
 * @param props - Declared file coordinates and the shared Session store.
 * @returns A workspace entry; native file controls remain with Deliverables.
 */
export function DeliveredVideoCard(props: PropsRuntime<'deliverables.video'> & VideoShared) {
  const source = props.useResource<'session-video'>(videoWorkspaceAddress(props.sessionId)).value?.sources
    .find(item => item.eventSeq === props.seq && item.presentedIndex === props.index)
  return <InlineVideoCard source={source} sourceUrl={props.sourceUrl} label={props.label} actions={props.actions}
    openWorkspace={props.openWorkspace} t={props.t} />
}

/** Display provider-generated results even when no explicit present call was made.
 * @param props - Closing Turn and the observed Session inventory.
 * @returns Generated videos recorded inside this Turn without a duplicate delivery card.
 */
export function GeneratedVideoCards(props: PropsRuntime<'conversation.chat.turnTail'> & VideoShared) {
  const sources = props.useResource<'session-video'>(videoWorkspaceAddress(props.sessionId)).value?.sources ?? []
  const start = props.turn.start?.seq
  const end = props.turn.end?.seq ?? props.seq
  if (start === undefined) return null
  return <>{sources.flatMap((source) => {
    if (source.origin !== 'generated' || source.presentedIndex !== null || source.eventSeq < start
      || source.eventSeq > end || source.playbackUrl === null
      || sources.some(item => item.presentedIndex !== null && item.path !== null && item.path === source.path)) return []
    return [<InlineVideoCard key={source.id} source={source} sourceUrl={source.playbackUrl}
      label={source.label} actions={props.actions} openWorkspace={props.openWorkspace} t={props.t} />]
  })}</>
}
