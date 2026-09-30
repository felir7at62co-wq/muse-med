/**
 * One Session's feedback surface: the message-feedback object layer and the
 * dialog controller, plus the routing between them. A message target puts a
 * selected judgment through the message controller; the Session target records
 * through the `sessionFeedback` Remote.
 * @module @deepseek-ai/dsh-client-ui-message-feedback/client/surface
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { FeedbackRecord } from '@deepseek-ai/dsh-command-feedback/types'
import { MessageFeedbackController, describe, type MessageFeedbackActionResult } from './controller.ts'
import { FeedbackDialogController } from './dialog.ts'
import type { FeedbackDialogTarget } from './dialog.ts'
import type { FeedbackDeliveryResult } from './feedback-delivery.ts'

/** The per-session pair behind every entry of one Session. */
export class FeedbackSurface {
  /** The Session's message-feedback object layer, shared by every message control. */
  readonly feedback: MessageFeedbackController
  /** The Session's dialog and toast state, shared by the overlay entry and the message controls. */
  readonly dialog: FeedbackDialogController

  /**
   * @param ctx - the browser plugin context carrying both feedback Remotes.
   * @param sessionId - Session owning the transcript and the remark.
   */
  constructor(private readonly ctx: ClientContext, private readonly sessionId: SessionId) {
    this.feedback = new MessageFeedbackController(ctx.remote.messageFeedback, sessionId)
    this.dialog = new FeedbackDialogController((target, entry, includeDiagnostics) =>
      this.submit(target, entry, includeDiagnostics))
  }

  /** Whether this surface requires delivery to the Muse inbox. */
  get museInbox(): boolean {
    return (globalThis as typeof globalThis & { dshDesktop?: { productName?: string } }).dshDesktop?.productName === 'muse-med'
      || this.ctx.get('feedbackDelivery') !== undefined
  }

  /** Submit to the active inbox provider before recording a local receipt marker. */
  private async submit(target: FeedbackDialogTarget, entry: FeedbackRecord,
    includeDiagnostics: boolean): Promise<MessageFeedbackActionResult> {
    const delivery = this.ctx.get('feedbackDelivery')
    if (!this.museInbox) return this.record(target, entry)
    if (!delivery) return { ok: false, error: { code: 'muse-feedback/unavailable', message: 'Muse inbox is unavailable' } }
    let result: FeedbackDeliveryResult
    try {
      result = await delivery.submit(this.sessionId, target, entry, includeDiagnostics)
    } catch (error) {
      // A thrown send may already have reached the server; it cannot be retried automatically.
      return { ok: false, error: { code: 'muse-feedback/unconfirmed', message: error instanceof Error ? error.name : 'Delivery unconfirmed' } }
    }
    if (!result.ok) return result
    try {
      await this.record(target, { text: `Muse receipt: ${result.receiptId}`, ...(entry.category ? { category: entry.category } : {}) })
    } catch (error) {
      // The server receipt confirms delivery even if the local marker cannot be saved.
      void error
    }
    return { ok: true }
  }

  /** Record the local judgment or task remark. */
  private record(target: FeedbackDialogTarget, entry: FeedbackRecord): Promise<MessageFeedbackActionResult> {
    return target.kind === 'message' ? this.feedback.rate(target.messageId, target.rating, entry) : this.recordSession(entry)
  }

  /** Record one Session-level remark through the sessionFeedback Remote. */
  private async recordSession(entry: FeedbackRecord): Promise<MessageFeedbackActionResult> {
    const carried = await this.ctx.remote.sessionFeedback.record({ sessionId: this.sessionId, ...entry })
    if (!carried.ok) return { ok: false, error: { code: carried.error.code, message: carried.error.message } }
    if (carried.value.ok) return { ok: true }
    return { ok: false, error: { code: carried.value.error.code, message: describe(carried.value.error.code) } }
  }

  /** Drop both controllers when the owning fiber unloads. */
  dispose(): void {
    this.feedback.dispose()
    this.dialog.dispose()
  }
}
