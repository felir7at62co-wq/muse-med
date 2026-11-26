/** Published review links prepare an editable request against one verified source version. */
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { InputActions, InputState } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionVideoAnalysis, SessionVideoInventory, SessionVideoSource } from '@deepseek-ai/dsh-session-video/types'
import type { VideoInjected } from './face.ts'
import type { VideoTarget, VideoWorkspaceNavigation } from './target-selection.ts'
import { isVideoSuggestionText } from './target-selection.ts'
import { assembleTimeline, authoredShots } from './timeline.ts'

/** Existing revision-guarded draft actions; this preparation has no submission capability. */
export interface VideoSuggestionEditor extends Pick<VideoInjected, 'addTargetReference' | 'setReviewMode'> {
  readonly input: Pick<InputState, 'draftRev' | 'phase'>
  readonly actions: Pick<InputActions, 'captureInsertion' | 'insertText' | 'persistDraft'>
}

/** Refusals leave the user's draft text and attachments intact. */
export type VideoSuggestionResult = 'applied' | 'invalid' | 'stale' | 'draft-refused'

/** Bring one selected suggestion into the same conversation without sending it.
 * @param request - Current resource inventory, observations and exact advice navigation.
 * @param editor - Existing input actions and the render's revision to guard against intervening edits.
 * @param label - Locale-owned source, version and interval label for the video chip.
 * @returns Applied, or a visible refusal beside the retained draft. A source chip inserted before a later refusal is retained.
 */
export function bringVideoSuggestion(request: {
  readonly sessionId: SessionId
  readonly navigation: VideoWorkspaceNavigation
  readonly inventory: SessionVideoInventory
  readonly analyses: readonly SessionVideoAnalysis[]
}, editor: VideoSuggestionEditor, label: (source: SessionVideoSource, target: VideoTarget) => string): VideoSuggestionResult {
  const { sessionId, navigation, inventory, analyses } = request
  const { target, editSuggestion } = navigation
  if (navigation.sessionId !== sessionId || inventory.sessionId !== sessionId || target === undefined
    || editSuggestion === undefined || !isVideoSuggestionText(editSuggestion)) return 'invalid'
  const source = inventory.sources.find(source => source.id === target.sourceId)
  if (source === undefined || source.version !== target.sourceVersion || source.playbackUrl === null) return 'stale'
  if (target.kind === 'shot') {
    const shots = [...authoredShots(source), ...assembleTimeline([source], analyses).shots]
    if (!shots.some(shot => shot.id === target.shotId && shot.localStart === target.startSeconds
      && shot.localEnd === target.endSeconds)) return 'stale'
  }
  const span = editor.actions.captureInsertion()
  if (editor.input.phase !== 'plain' || span.draftRev !== editor.input.draftRev) return 'draft-refused'
  if (!editor.addTargetReference(target, label(source, target), span)) return 'draft-refused'
  try {
    if (!editor.setReviewMode(false, editor.actions.captureInsertion())) return 'draft-refused'
    const insertion = editor.actions.captureInsertion()
    return editor.actions.insertText(`\n${editSuggestion}`, { ...insertion, start: insertion.end }) ? 'applied' : 'draft-refused'
  } finally { editor.actions.persistDraft() }
}
