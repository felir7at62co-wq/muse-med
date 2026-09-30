/** Browser-safe account results; passwords and session cookies have no response field. */

import type {} from '@deepseek-ai/dsh-typert-protocol'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { FeedbackCategory } from '@deepseek-ai/dsh-command-feedback/types'

/** Durable record ID returned by the Muse opinion inbox. */
export type MuseFeedbackId = Branded<'MuseFeedbackId'>

/** Explicitly submitted desktop feedback; diagnostics are opt-in. */
export interface MuseFeedbackRequest {
  readonly sessionId: SessionId
  readonly target: { readonly kind: 'session' } | { readonly kind: 'message'; readonly messageId: MessageId; readonly rating: 'positive' | 'negative' }
  readonly category?: FeedbackCategory
  readonly text?: string
  readonly includeDiagnostics: boolean
}

/** Confirmed durable inbox receipt without account credentials or transcript content. */
export interface MuseFeedbackReceipt {
  readonly id: MuseFeedbackId
  readonly revision: number
}

/** Request to read the stored account or confirm it with the MUSE gateway. */
export interface MuseAccountStatusRequest {
  /** Confirm the stored cookie with the gateway when true. */
  readonly verify?: boolean
}

/** Account identity available to the Settings page and the read-only MCP tool. */
export type MuseAccountStatus =
  | { readonly state: 'signed-out' }
  | {
    readonly state: 'signed-in'
    readonly username: string
    readonly verified: boolean
    readonly environment?: string
    readonly workspaceLabel?: string
  }

/** User-entered credentials delivered only through the authenticated Remote call. */
export interface MuseAccountLoginRequest {
  readonly username: string
  readonly password: string
  /** A separate UI choice; a rejected login never creates an account unless true. */
  readonly registerIfMissing: boolean
}

/** Successful sign-in or explicitly requested first-time registration. */
export interface MuseAccountLoginResult {
  readonly outcome: 'signed-in' | 'registered'
  readonly status: Extract<MuseAccountStatus, { readonly state: 'signed-in' }>
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    'muse-feedback/sign-in-required': {}
    'muse-feedback/account-changed': {}
    'muse-feedback/unconfirmed': {}
    'muse-feedback/rejected': {}
    'muse-feedback/rate-limited': {}
    'muse-feedback/unavailable': {}
    'muse-feedback/invalid-input': {}
    'muse-account/invalid-input': {}
    'muse-account/invalid-credentials': {}
    'muse-account/rate-limited': {}
    'muse-account/registration-disabled': {}
    'muse-account/gateway-unavailable': {}
    'muse-account/gateway-rejected': {}
    'muse-account/storage-failed': {}
  }
}
