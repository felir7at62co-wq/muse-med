/** Composer references retain selected video coordinates through ordinary message submission. */
import type { InputTriggerSource } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionVideoInventory } from '@deepseek-ai/dsh-session-video/types'
import type { VideoTarget } from './target-selection.ts'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { parseVideoWorkspaceAddress, serializeVideoTargets, VIDEO_REVIEW_REQUEST } from './target-selection.ts'

/** Reference codec identity carried by video chips in the composer. */
export const VIDEO_REFERENCE_SOURCE = 'muse-video'
/** Reference codec identity for the removable read-only review mode. */
export const VIDEO_REVIEW_REFERENCE_SOURCE = 'muse-video-review'
/** Persisted reference value for this plugin's read-only review mode. */
export const VIDEO_REVIEW_REFERENCE = 'read-only'

/** Keep review intent readable in the composer and serialize it only on submission.
 * @param copy - Current localized mode label and invalid-reference error.
 * @returns An insertion-only source whose clipboard projection contains no protocol markers.
 */
export function createVideoReviewReferenceSource(copy: {
  readonly label: () => string
  readonly invalid: () => string
}): InputTriggerSource {
  return {
    trigger: '@', name: VIDEO_REVIEW_REFERENCE_SOURCE, showGroupTitle: false,
    candidates: () => Promise.resolve([]),
    onPick: () => undefined,
    codec: {
      clipboardText: () => copy.label(),
      serialize: (ref, signal) => Promise.resolve().then(() => {
        signal.throwIfAborted()
        if (ref !== VIDEO_REVIEW_REFERENCE) throw new Error(copy.invalid())
        return VIDEO_REVIEW_REQUEST
      }),
    },
  }
}

/** Decode a video chip's exact Session and source coordinates.
 * @param ref - Reference URL stored in the semantic composer document.
 * @returns A complete selection, or null for malformed and workspace-only addresses.
 */
export function parseVideoReference(ref: string): { readonly sessionId: SessionId; readonly target: VideoTarget } | null {
  const parsed = parseVideoWorkspaceAddress(ref)
  return parsed?.target === undefined || parsed.seekSeconds !== undefined || parsed.editSuggestion !== undefined
    ? null : { sessionId: parsed.sessionId, target: parsed.target }
}

/** Copy owned by the video interface for refused serialized selections. */
export interface VideoReferenceCopy {
  readonly invalid: () => string
  readonly stale: () => string
}

/** Build the source which resolves a selected video against its current Host inventory.
 * @param list - Generated inventory reader with the submission's cancellation signal.
 * @param open - Reveal a valid same-conversation reference without sending it.
 * @param copy - Localized errors retained on the existing composer.
 * @returns An insertion-only reference source; its empty candidate list leaves normal @ discovery unchanged.
 */
export function createVideoReferenceSource(
  list: (sessionId: SessionId, signal: AbortSignal) => Promise<RemoteResult<SessionVideoInventory>>,
  open: (address: string) => boolean,
  copy: VideoReferenceCopy,
): InputTriggerSource {
  return {
    trigger: '@', name: VIDEO_REFERENCE_SOURCE, showGroupTitle: false,
    candidates: () => Promise.resolve([]),
    onPick: () => undefined,
    openReference: (session, { ref }) => {
      const navigation = parseVideoReference(ref)
      if (navigation === null || navigation.sessionId !== session.sessionId) return false
      return open(ref)
    },
    codec: {
      clipboardText: ref => ref,
      serialize: async (ref, signal) => {
        const navigation = parseVideoReference(ref)
        if (navigation === null) throw new Error(copy.invalid())
        const result = await list(navigation.sessionId, signal)
        if (!result.ok) throw result.error
        signal.throwIfAborted()
        const selected = serializeVideoTargets([navigation.target], result.value.sources, navigation.sessionId)
        if (!selected.ok) throw new Error(copy.stale())
        return selected.text
      },
    },
  }
}
