/** Settled Agent advice opens the same recorded interval or prepares a draft. */
import type { HocShare, PropsLocale, PropsRuntime, SlotMap } from '@deepseek-ai/dsh-client-ui-slots'
import { useMarkdownDelegate } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MouseEvent } from 'react'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import { parseVideoWorkspaceAddress, videoWorkspaceAddress, type VideoWorkspaceNavigation } from './target-selection.ts'
import { videoSelectionLabel } from './selection-labels.ts'
import type {} from './resource-provider.ts'
import css from './StudioCards.module.css'

type VideoSuggestionLinkProps = PropsRuntime<'conversation.chat.markdown.resource-link'>
  & HocShare<SlotMap['conversation.chat.markdown.resource-link']> & PropsLocale<'sessionVideo'> & VideoSuggestionLinkInjected

/** Structured advice actions share the conversation's video workspace. */
export interface VideoSuggestionLinkInjected {
  readonly openAdvice: (navigation: VideoWorkspaceNavigation) => void
}

function timecode(seconds: number): string {
  const ticks = Math.round((seconds % 60) * 100)
  const minutes = String(Math.floor(seconds / 60) + Math.floor(ticks / 6_000)).padStart(2, '0')
  const withinMinute = String(Math.floor(ticks / 100) % 60).padStart(2, '0')
  const fraction = ticks % 100
  return `${minutes}:${withinMinute}${fraction ? `.${String(fraction).padStart(2, '0')}` : ''}`
}

/** Add a visible draft action to this Session's exact, bounded video advice links.
 * @param props - The sanitized address, its ordinary anchor, and the active Session.
 * @returns An interval link and draft action when the advice is actionable, otherwise the ordinary anchor.
 */
export function VideoSuggestionLink({ address, sessionId, children, useResource, openAdvice, t }: VideoSuggestionLinkProps) {
  const { openResourceLink } = useMarkdownDelegate()
  const navigation = parseVideoWorkspaceAddress(address)
  if (navigation?.sessionId !== sessionId || navigation.target === undefined || navigation.editSuggestion === undefined
    || openResourceLink === undefined) return children
  const exact = { ...navigation, target: navigation.target, editSuggestion: navigation.editSuggestion }
  return <SuggestionActions address={address} navigation={exact} useResource={useResource} t={t}
    openResourceLink={openResourceLink} openAdvice={openAdvice} />
}

type VideoSuggestion = VideoWorkspaceNavigation & Required<Pick<VideoWorkspaceNavigation, 'target' | 'editSuggestion'>>

function SuggestionActions({ address, navigation, useResource, t, openResourceLink, openAdvice }:
Pick<VideoSuggestionLinkProps, 'address' | 'useResource' | 't' | 'openAdvice'> & {
  readonly navigation: VideoSuggestion
  readonly openResourceLink: (address: string) => void
}) {
  const { sessionId, target, editSuggestion, issue, seekSeconds } = navigation
  const sources = useResource<'session-video'>(videoWorkspaceAddress(sessionId)).value?.sources ?? []
  const source = sources.find(item => item.id === target.sourceId && item.version === target.sourceVersion)
  const scope = source === undefined ? undefined : videoSelectionLabel(source, target, t, sources)
  const interval = target.kind === 'shot' ? `${timecode(target.startSeconds)}–${timecode(target.endSeconds)}` : source?.label
  const inspect = videoWorkspaceAddress(sessionId, target, seekSeconds)
  const activation = (open: () => void) => (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    event.preventDefault()
    open()
  }
  if (issue !== undefined && seekSeconds !== undefined) {
    return <span className={`${css.suggestion} ${css.adviceCard}`} data-muse-suggestion data-muse-suggestion-card
      role="group" aria-label={t('shotAdvice')}>
      <span className={css.adviceHeader}>
        <span className={css.adviceAvatar} aria-hidden="true" />
        <span className={css.adviceBrand}>{t('brand')}</span>
        <a href={inspect} className={css.timeLink} title={scope}
          onClick={activation(() => { openAdvice({ sessionId, target, seekSeconds }) })}>{timecode(seekSeconds)}</a>
      </span>
      <strong className={css.adviceProblem}>{issue.problem}</strong>
      <span className={css.adviceDetail}><span className={css.adviceLabel}>{t('adviceBasis')}</span><span>{issue.basis}</span></span>
      <span className={css.adviceDetail}><span className={css.adviceLabel}>{t('adviceChange')}</span><span>{editSuggestion}</span></span>
      <a href={address} className={css.suggestionAction} onClick={activation(() => { openAdvice(navigation) })}>{t('bringSuggestion')}</a>
    </span>
  }
  return <span className={css.suggestion} data-muse-suggestion>
    {interval !== undefined && <a href={inspect} className={css.timeLink} title={scope}
      onClick={activation(() => { openResourceLink(inspect) })}>{interval}</a>}
    <a href={address} className={css.suggestionAction} title={editSuggestion}
      onClick={activation(() => { openResourceLink(address) })}>{t('bringSuggestion')}</a>
  </span>
}
