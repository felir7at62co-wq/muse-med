/** Compact video entries open playback in their conversation workspace. */
import { Button, IconChevronRightOutlineRegular, IconPlayOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { useEffect, useRef, useState } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ChatSnapshot } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { UserMessageNode } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionVideoSource } from '@deepseek-ai/dsh-session-video/types'
import type { VideoShared } from './face.ts'
import { parseVideoWorkspaceAddress, type VideoTarget, videoWorkspaceAddress } from './target-selection.ts'
import { videoEditions } from './video-editions.ts'
import { videoSelectionRule } from './user-text-rules.ts'
import studio from './StudioCards.module.css'
import css from './VideoShelf.module.css'

interface ReturnedShot {
  readonly target: Extract<VideoTarget, { kind: 'shot' }>
  readonly playbackUrl: string
  readonly episode: number
  readonly shot: number
  readonly edition: number
  readonly requested: boolean
}

function inputBeforeDelivery(chat: ChatSnapshot, seq: number): UserMessageNode | undefined {
  const turn = chat.timeline.turnOrder.findLast((number) => {
    const location = chat.timeline.turns.get(number)
    return location?.start !== undefined && location.end !== undefined && location.start.seq < seq && seq < location.end.seq
  })
  return turn === undefined ? undefined : chat.nodes.turnDataSource(turn, 'user').getSnapshot().findLast(message => message.seq < seq)
}

function requestedShots(input: UserMessageNode | undefined, sessionId: SessionId): readonly Extract<VideoTarget, { kind: 'shot' }>[] {
  return input?.content.flatMap((block) => {
    if (block.type !== 'text') return []
    const result: Extract<VideoTarget, { kind: 'shot' }>[] = []
    for (let match = videoSelectionRule.match(block.text, 0); match !== undefined;
      match = videoSelectionRule.match(block.text, match.end)) {
      if (match.data.sessionId !== sessionId) continue
      for (const item of match.data.items) {
        const target = parseVideoWorkspaceAddress(item.reviewLink)?.target
        if (target?.kind === 'shot') result.push(target)
      }
    }
    return result
  }) ?? []
}

function returnedShots(
  source: SessionVideoSource, sources: readonly SessionVideoSource[], requested: ReturnType<typeof requestedShots>,
): ReturnedShot[] {
  const version = source.version
  const playbackUrl = source.playbackUrl
  const episode = source.production?.episodeNumber
  if (version === null || playbackUrl === null || episode === undefined) return []
  return (source.production?.shotRanges ?? []).flatMap((range) => {
    const comparison = videoEditions(sources, source, range.shotNumber)
    if (comparison === null || comparison.current.number === 1) return []
    const { current } = comparison
    const earlierRecordings = comparison.items.filter(item => item.number < current.number
      && (source.path === null || source.path !== item.source.path)
      && (source.remoteUrl === null || source.remoteUrl !== item.source.remoteUrl))
    if (earlierRecordings.length === 0) return []
    const selected = requested.some(target => earlierRecordings.some(item => item.source.id === target.sourceId
      && item.source.version === target.sourceVersion && item.shotId === target.shotId
      && item.startSeconds === target.startSeconds && item.endSeconds === target.endSeconds))
    return [{ episode, shot: range.shotNumber, edition: current.number, requested: selected, playbackUrl, target: {
      kind: 'shot', sourceId: source.id, sourceVersion: version, shotId: current.shotId,
      startSeconds: current.startSeconds, endSeconds: current.endSeconds,
    } }]
  })
}

function VideoThumbnail({ sourceUrl, className, previewAt }: {
  readonly sourceUrl: string
  readonly className: string | undefined
  readonly previewAt?: number
}) {
  const video = useRef<HTMLVideoElement>(null)
  const [failedUrl, setFailedUrl] = useState<string | null>(null)
  const failed = failedUrl === sourceUrl
  useEffect(() => {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- A committed inline card always includes its video element.
    const element = video.current!
    element.src = sourceUrl
    return () => { element.pause(); element.removeAttribute('src'); element.load() }
  }, [sourceUrl])
  return <span className={className} aria-hidden="true">
    <video ref={video} src={sourceUrl} muted playsInline preload="metadata" hidden={failed}
      onLoadedMetadata={previewAt === undefined ? undefined : (event) => {
        const element = event.currentTarget
        if (!Number.isNaN(element.duration)) element.currentTime = Math.min(previewAt, element.duration)
      }} onError={() => { setFailedUrl(sourceUrl) }} />
    {failed && <IconPlayOutlineRegular />}
  </span>
}

/** Open the recorded source from a muted metadata thumbnail.
 * @param props - Authorized source, display name, and conversation navigation actions.
 * @returns A compact source entry; playback and retries remain in the video workspace.
 */
export function InlineVideoCard({ source, sources = [], requested = [], sourceUrl, label, actions, openWorkspace, t }:
Pick<VideoShared, 'actions' | 'openWorkspace' | 't'> & {
  readonly source: SessionVideoSource | undefined
  readonly sources?: readonly SessionVideoSource[]
  readonly requested?: ReturnType<typeof requestedShots>
  readonly sourceUrl: string
  readonly label: string
}) {
  const related = source === undefined ? [] : returnedShots(source, sources, requested)
  const chosen = related.filter(item => item.requested)
  const revisions = chosen.length === 0 ? related : chosen
  const first = revisions[0]
  if (first !== undefined) {
    const summary = (revision: ReturnedShot) => [t('episodeLabel', { episode: revision.episode }),
      t('authoredShot', { index: revision.shot }), t('revisionNumber', { number: revision.edition })].join(' · ')
    const compare = t('compareOriginal')
    return <article className={studio.revision} data-muse-inline-video data-muse-revised-video>
      <span className={studio.revisionAvatar} aria-hidden="true" />
      <div className={studio.revisionBody}>
        <strong className={studio.revisionTitle}>{t('revisedDelivery')}</strong>
        {revisions.length === 1 && <span className={studio.revisionMeta}>{summary(first)}</span>}
        <div className={studio.revisionControls}>
          <VideoThumbnail key={first.target.shotId} sourceUrl={first.playbackUrl} className={studio.revisionThumbnail}
            previewAt={(first.target.startSeconds + first.target.endSeconds) / 2} />
          <div className={studio.revisionChoices}>
            {revisions.map(revision => <Button key={revision.target.shotId} variant="ghost" className={studio.revisionChoice}
              onClick={() => { openWorkspace('sidebar', revision.target, 'compare') }}>
              {revisions.length === 1 ? compare : `${summary(revision)} · ${compare}`}
            </Button>)}
          </div>
        </div>
      </div>
    </article>
  }
  const open = () => {
    if (source) { actions.selectEpisode(source.production?.episodeNumber ?? 'unassigned'); actions.select(source.id) }
    openWorkspace()
  }
  return <div className={css.inlineCard} data-muse-inline-video>
    <Button className={css.inlineOpen} variant="ghost" aria-label={t('source', { name: label })} onClick={open}>
      <VideoThumbnail sourceUrl={sourceUrl} className={css.inlineThumbnail} />
      <span className={css.inlineLabel}>{label}</span><IconChevronRightOutlineRegular />
    </Button>
  </div>
}

/** Replace a delivered video's preview through the owner's chain slot.
 * @param props - Declared file coordinates and the shared Session store.
 * @returns A workspace entry; native file controls remain with Deliverables.
 */
export function DeliveredVideoCard(props: PropsRuntime<'deliverables.video'> & VideoShared) {
  const sources = props.useResource<'session-video'>(videoWorkspaceAddress(props.sessionId)).value?.sources ?? []
  const source = sources.find(item => item.eventSeq === props.seq && item.presentedIndex === props.index)
  const input = props.useChat(chat => inputBeforeDelivery(chat, props.seq))
  return <InlineVideoCard source={source} sources={sources} requested={requestedShots(input, props.sessionId)}
    sourceUrl={props.sourceUrl} label={props.label} actions={props.actions}
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
  const inputs = props.useChat(chat => chat.nodes.turnDataSource(props.turn.turn, 'user').getSnapshot())
  if (start === undefined) return null
  return <>{sources.flatMap((source) => {
    if (source.origin !== 'generated' || source.presentedIndex !== null || source.eventSeq < start
      || source.eventSeq > end || source.playbackUrl === null
      || sources.some(item => item.presentedIndex !== null && item.path !== null && item.path === source.path)) return []
    const input = inputs.findLast(input => input.seq < source.eventSeq)
    return [<InlineVideoCard key={source.id} source={source} sources={sources} requested={requestedShots(input, props.sessionId)}
      sourceUrl={source.playbackUrl} label={source.label} actions={props.actions} openWorkspace={props.openWorkspace} t={props.t} />]
  })}</>
}
