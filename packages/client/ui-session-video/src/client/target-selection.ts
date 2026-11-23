/** Version-bound source and cut selections serialized into ordinary user messages. */
import type { SessionVideoShotId, SessionVideoSource, SessionVideoSourceId } from '@deepseek-ai/dsh-session-video/types'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { authoredShots } from './timeline.ts'

/** Opening delimiter for this plugin's model-visible selection evidence. */
export const VIDEO_SELECTION_OPEN = '<muse-video-selection>'
/** Closing delimiter for this plugin's model-visible selection evidence. */
export const VIDEO_SELECTION_CLOSE = '</muse-video-selection>'
/** Recorded intent consumed by the bounded, read-only review operation. */
export const VIDEO_REVIEW_REQUEST = '<!-- muse-video-review: use muse_video review for the selected source/version/interval and include its review_link with every suggestion. -->'
/** Protocol bound for one ordinary-text change carried by an advice link. */
export const VIDEO_SUGGESTION_MAX_LENGTH = 2000

/** Accept one bounded plain-text suggestion without embedded protocol or control markup.
 * @param text - Decoded text carried by an Assistant resource link.
 * @returns Whether it can be inserted as ordinary editable draft text.
 */
export function isVideoSuggestionText(text: string): boolean {
  return text.length > 0 && text.length <= VIDEO_SUGGESTION_MAX_LENGTH && text.trim() === text
    && !/[\p{Cc}\p{Zl}\p{Zp}<>]/u.test(text)
}

/** A Session video address optionally points at one exact recorded source version. */
export interface VideoWorkspaceNavigation {
  readonly sessionId: SessionId
  readonly target?: VideoTarget
  /** Source-local evidence time, independent of the selected draft range. */
  readonly seekSeconds?: number
  /** Observation and its screenplay or delivery basis from one published advice link. */
  readonly issue?: { readonly problem: string; readonly basis: string }
  /** A published suggestion becomes an unsent edit request, preserving the target coordinates. */
  readonly editSuggestion?: string
  /** A returned shot opens at an aligned comparison position. */
  readonly compareVersions?: true
  /** Presentation-only moves retain the navigation already applied to this workspace. */
  readonly retainedNavigationKey?: string
}

declare module '@deepseek-ai/dsh-client-ui-sidebar-right/client' {
  interface SidebarRightResourceParamsMap {
    /** Source-local navigation carried by video advice links. */
    'session-video': VideoWorkspaceNavigation
  }
}

/** One recorded source version, optionally narrowed to its original cut coordinates. */
export type VideoTarget = {
  readonly sourceId: SessionVideoSourceId
  readonly sourceVersion: string
} & (
  | { readonly kind: 'source' }
  | { readonly kind: 'shot'; readonly shotId: SessionVideoShotId; readonly startSeconds: number; readonly endSeconds: number }
)

/** Episode browsing leaves unassigned sources distinct from the complete inventory. */
export type VideoEpisodeFilter = 'all' | 'unassigned' | number

/** User intent determines whether the request asks for advice or an actual modification. */
export type VideoPromptIntent = 'review' | 'edit' | 'regenerate'

/** Localized request copy supplied by the owning interface. */
export interface VideoPromptCopy {
  readonly requests: Readonly<Record<VideoPromptIntent, string>>
  readonly selection: string
}

/** A rejected preparation retains the selected labels for explicit reselection. */
export type VideoPromptResult =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly reason: 'empty' | 'stale'; readonly targetKeys: readonly string[] }

/** Identify an exact source version and optional cut without relying on its display name.
 * @param target - Selected recorded source or cut.
 * @returns Stable JSON-compatible selection key.
 */
export function targetKey(target: VideoTarget): string {
  return JSON.stringify(target.kind === 'source'
    ? [target.sourceId, target.sourceVersion, target.kind]
    : [target.sourceId, target.sourceVersion, target.kind, target.shotId, target.startSeconds, target.endSeconds])
}

/** Build a navigable workspace or version-bound advice address.
 * @param sessionId - Conversation owning the selected source.
 * @param target - Source or cut to locate; omitted opens the workspace.
 * @param seekSeconds - Source-local position inside the selected source or cut.
 * @returns A resource URL whose time coordinates belong to the original source.
 */
export function videoWorkspaceAddress(sessionId: SessionId, target?: VideoTarget, seekSeconds?: number): string {
  const address = new URL(`dsh-resource://session-video/session/${encodeURIComponent(sessionId)}`)
  if (target !== undefined) {
    address.searchParams.set('source', target.sourceId)
    address.searchParams.set('version', target.sourceVersion)
    if (seekSeconds !== undefined) address.searchParams.set('at', String(seekSeconds))
    if (target.kind === 'shot') {
      address.searchParams.set('shot', target.shotId)
      address.searchParams.set('start', String(target.startSeconds))
      address.searchParams.set('end', String(target.endSeconds))
    }
  }
  return address.toString()
}

/** Decode a video resource URL without trusting its source identity or version.
 * @param address - URL selected by a user or emitted in an Agent suggestion.
 * @returns Syntactically complete navigation; the consumer must match it against current inventory.
 */
export function parseVideoWorkspaceAddress(address: string): VideoWorkspaceNavigation | null {
  let url: URL
  try { url = new URL(address) } catch (_error: unknown) { return null /* Not a resource URL. */ }
  if (url.protocol !== 'dsh-resource:' || url.hostname !== 'session-video' || url.username !== '' || url.password !== ''
    || url.port !== '' || url.hash !== '') return null
  const encodedSession = /^\/session\/([^/]+)$/u.exec(url.pathname)?.[1]
  if (encodedSession === undefined) return null
  let session: string
  try { session = decodeURIComponent(encodedSession) } catch (_error: unknown) { return null /* Invalid URL escaping. */ }
  const sessionId = brandString<SessionId>(session)
  const source = url.searchParams.get('source'), version = url.searchParams.get('version')
  const shot = url.searchParams.get('shot'), start = url.searchParams.get('start'), end = url.searchParams.get('end')
  const editSuggestion = url.searchParams.get('suggestion')
  const at = url.searchParams.get('at'), problem = url.searchParams.get('problem'), basis = url.searchParams.get('basis')
  const seekSeconds = at === null ? undefined : Number(at)
  if (editSuggestion !== null && !isVideoSuggestionText(editSuggestion)) return null
  if (seekSeconds !== undefined && (!/^\d+(?:\.\d+)?$/u.test(at ?? '') || !Number.isFinite(seekSeconds))) return null
  if ((problem !== null || basis !== null || seekSeconds !== undefined && editSuggestion !== null)
    && (problem === null || basis === null || seekSeconds === undefined || editSuggestion === null
      || !isVideoSuggestionText(problem) || !isVideoSuggestionText(basis))) return null
  if ([...url.searchParams.keys()].some(key => !['source', 'version', 'shot', 'start', 'end', 'suggestion', 'at', 'problem', 'basis'].includes(key)
    || url.searchParams.getAll(key).length !== 1)) return null
  if (source === null && version === null && shot === null && start === null && end === null) {
    return editSuggestion === null && seekSeconds === undefined ? { sessionId } : null
  }
  if (!source || !version) return null
  const common = { sourceId: brandString<SessionVideoSourceId>(source), sourceVersion: version }
  const details = { ...(editSuggestion === null ? {} : { editSuggestion }), ...(seekSeconds === undefined ? {} : { seekSeconds }),
    ...(problem === null || basis === null ? {} : { issue: { problem, basis } }) }
  if (shot === null && start === null && end === null) return { sessionId, target: { ...common, kind: 'source' }, ...details }
  if (!shot || !start || !end) return null
  const startSeconds = Number(start), endSeconds = Number(end)
  if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds) || startSeconds < 0 || endSeconds <= startSeconds) return null
  if (seekSeconds !== undefined && (seekSeconds < startSeconds || seekSeconds >= endSeconds)) return null
  return { sessionId, target: { ...common, kind: 'shot', shotId: brandString<SessionVideoShotId>(shot), startSeconds, endSeconds }, ...details }
}

/** Prepare source evidence without accepting a replaced or unavailable source version.
 * @param intent - Advice, modification, or regeneration requested by the user.
 * @param targets - Selected versions and source-local cut ranges in display order.
 * @param sources - Latest inventory of this same Session.
 * @param copy - Localized request and selection heading.
 * @param sessionId - Conversation to reopen from advice links.
 * @returns User-visible prompt text, or the selections requiring another choice.
 */
export function prepareVideoPrompt(
  intent: VideoPromptIntent,
  targets: readonly VideoTarget[],
  sources: readonly SessionVideoSource[],
  copy: VideoPromptCopy,
  sessionId: SessionId,
): VideoPromptResult {
  const selection = serializeVideoTargets(targets, sources, sessionId)
  return selection.ok
    ? { ok: true, text: `${copy.requests[intent]}\n\n${copy.selection}\n${selection.text}` }
    : selection
}

/** Serialize selected source evidence after checking the latest inventory.
 * @param targets - Source versions and original cut coordinates to include.
 * @param sources - Current inventory of the same conversation.
 * @param sessionId - Conversation encoded into each advice navigation link.
 * @returns Explicitly delimited JSON evidence or a refusal naming the selections to refresh.
 */
export function serializeVideoTargets(
  targets: readonly VideoTarget[],
  sources: readonly SessionVideoSource[],
  sessionId: SessionId,
): VideoPromptResult {
  if (targets.length === 0) return { ok: false, reason: 'empty', targetKeys: [] }
  const selected = [...new Map(targets.map(target => [targetKey(target), target])).values()]
  const stale = selected.filter((target) => {
    const source = sources.find(source => source.id === target.sourceId)
    return source === undefined || source.version !== target.sourceVersion || source.playbackUrl === null
  })
  if (stale.length > 0) return { ok: false, reason: 'stale', targetKeys: stale.map(targetKey) }
  const records = selected.map((target) => {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- Selected sources match this unchanged inventory.
    const source = sources.find(source => source.id === target.sourceId)!
    const authoredNumber = target.kind === 'source' ? undefined : authoredShots(source).find(shot => shot.id === target.shotId)?.authoredNumber
    return {
      source_id: source.id,
      source_version: target.sourceVersion,
      label: source.label,
      path: source.path,
      remote_url: source.remoteUrl,
      review_link: videoWorkspaceAddress(sessionId, target),
      event_seq: source.eventSeq,
      presented_index: source.presentedIndex,
      call_id: source.callId,
      review_tool: 'muse_video',
      ...(source.production === undefined ? {} : { production: source.production }),
      ...(target.kind === 'source' ? {} : {
        shot_id: target.shotId,
        start_seconds: target.startSeconds,
        end_seconds: target.endSeconds,
        ...(authoredNumber === undefined ? {} : { authored_shot_number: authoredNumber }),
      }),
    }
  })
  return { ok: true, text: `${VIDEO_SELECTION_OPEN}\n${JSON.stringify(records, null, 2)}\n${VIDEO_SELECTION_CLOSE}` }
}
