/** Account-authenticated delivery of feedback from the existing dialog. */
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { MessageId } from '@deepseek-ai/dsh-api-remotes/client'
import type { FeedbackCategory } from '@deepseek-ai/dsh-command-feedback/types'

/** Category keys in presentation order, checked against the durable feedback taxonomy. */
export const FEEDBACK_CATEGORY_CHIPS = {
  'task-result': true,
  'instruction-following': true,
  'product-interaction': true,
  'service-stability': true,
  'resource-cost': true,
  'security-privacy-permission': true,
  'other': true,
} satisfies Record<FeedbackCategory, true>

/** Task or rated assistant message selected in the feedback dialog. */
export type FeedbackDeliveryTarget =
  | { readonly kind: 'session' }
  | { readonly kind: 'message'; readonly messageId: MessageId; readonly rating: 'positive' | 'negative' }

/** Description and category sent to the inbox provider. */
export interface FeedbackDeliveryEntry {
  readonly text?: string
  readonly category?: keyof typeof FEEDBACK_CATEGORY_CHIPS
}

/** A confirmed inbox receipt or a delivery failure, including uncertain outcomes. */
export type FeedbackDeliveryResult =
  | { readonly ok: true; readonly receiptId: string }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }

/** Delivery provider for the account's Muse inbox. */
export interface FeedbackDelivery {
  /**
   * Submit the user's current draft without automatic retries.
   * @param sessionId - local Session containing the reported task or message.
   * @param target - task or rated assistant message selected by the user.
   * @param entry - category and description entered in the dialog.
   * @param includeDiagnostics - whether the user selected bounded conversation diagnostics.
   * @returns a server-confirmed receipt or a classified failure.
   */
  submit(sessionId: SessionId, target: FeedbackDeliveryTarget, entry: FeedbackDeliveryEntry,
    includeDiagnostics: boolean): Promise<FeedbackDeliveryResult>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    feedbackDelivery: FeedbackDelivery
  }
}
