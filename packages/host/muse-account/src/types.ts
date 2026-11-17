/** Browser-safe account results; passwords and session cookies have no response field. */

import type {} from '@deepseek-ai/dsh-typert-protocol'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { FeedbackCategory } from '@deepseek-ai/dsh-command-feedback/types'

/** Durable record ID returned by the Muse opinion inbox. */
export type MuseFeedbackId = Branded<'MuseFeedbackId'>

/** Short-lived Desktop login attempt issued by the account gateway. */
export type MuseBrowserLoginId = Branded<'MuseBrowserLoginId'>

/** Account identifier assigned by the Muse gateway. */
export type MuseAccountId = Branded<'MuseAccountId'>

/** Administrator-maintained Muse group identifier. */
export type MuseAccountGroupId = Branded<'MuseAccountGroupId'>

/** Deduplicated model request identifier in the account usage ledger. */
export type MuseAccountUsageId = Branded<'MuseAccountUsageId'>

/** Department identifier returned by Feishu organization authorization. */
export type MuseFeishuDepartmentId = Branded<'MuseFeishuDepartmentId'>

/** Time range and page for the current account's usage; omissions select 30 days and the first 50 requests. */
export interface MuseAccountDetailsRequest {
  readonly period?: 'all' | 'today' | '7d' | '30d'
  readonly offset?: number
  readonly limit?: number
}

/** Reported token counts; input includes cached input, which is also shown separately. */
export interface MuseAccountUsageCounts {
  readonly requests: number
  readonly reportedRequests: number
  readonly inputTokens: number
  readonly outputTokens: number
  readonly totalTokens: number
  readonly cachedInputTokens: number
  readonly reasoningTokens: number
}

/** Current account profile, assigned Muse groups, and content-free model usage. */
export interface MuseAccountDetails {
  readonly account: {
    readonly id: MuseAccountId
    readonly username: string
    readonly createdAt: string
    readonly lastLoginAt: string | null
    readonly lastActivityAt: string | null
    readonly feishuIdentities: readonly {
      readonly name: string
      readonly tenantKey: string | null
      readonly boundAt: string
      readonly lastLoginAt: string | null
      /** Omission means this identity predates organization synchronization. */
      readonly organization?: {
        readonly status: 'available' | 'permission-required' | 'unavailable'
        readonly syncedAt: string
        readonly departments: readonly {
          readonly id: MuseFeishuDepartmentId
          readonly name: string
          readonly path: string
          readonly pathIds: readonly MuseFeishuDepartmentId[]
        }[]
      }
    }[]
  }
  readonly groups: readonly { readonly id: MuseAccountGroupId; readonly name: string; readonly description: string }[]
  readonly usage: {
    readonly since: string
    readonly updatedAt: string
    readonly tracking: 'gateway-and-desktop'
    readonly summary: MuseAccountUsageCounts
    readonly byModel: readonly (MuseAccountUsageCounts & { readonly provider: string; readonly model: string })[]
    readonly byDay: readonly (MuseAccountUsageCounts & { readonly date: string })[]
    readonly pagination: { readonly offset: number; readonly limit: number; readonly total: number; readonly hasMore: boolean }
    readonly recent: readonly {
      readonly id: MuseAccountUsageId
      readonly at: string
      readonly provider: string
      readonly model: string
      readonly status: number | null
      readonly source: 'gateway-relay' | 'desktop-direct'
      readonly inputTokens: number | null
      readonly outputTokens: number | null
      readonly totalTokens: number | null
      readonly cachedInputTokens: number | null
      readonly reasoningTokens: number | null
    }[]
  }
}

/** Public approval fields; the Host retains the redemption secret privately. */
export interface MuseBrowserLoginAttempt {
  readonly id: MuseBrowserLoginId
  readonly authorizeUrl: string
  readonly code: string
  readonly expiresAt: number
  readonly pollIntervalMs: number
}

/** Browser approval state; successful identity is returned only after private local persistence. */
export type MuseBrowserLoginResult =
  | { readonly state: 'pending' | 'expired' | 'cancelled' }
  | { readonly state: 'signed-in'; readonly status: Extract<MuseAccountStatus, { readonly state: 'signed-in' }> }

/** Explicitly submitted desktop feedback; diagnostics are opt-in. */
export interface MuseFeedbackRequest {
  readonly sessionId: SessionId
  readonly target: { readonly kind: 'session' } | { readonly kind: 'message'; readonly messageId: MessageId; readonly rating: 'positive' | 'negative' }
  readonly category?: FeedbackCategory
  readonly text?: string
  readonly includeDiagnostics: boolean
  /** User-authored title; omission retains the existing feedback-dialog title. */
  readonly title?: string
  /** Explicit opinion type for model-authored feedback. */
  readonly kind?: 'bug' | 'suggestion' | 'other'
  /** Stable submission key, reused with identical content after an uncertain outcome. */
  readonly requestId?: string
}

/** Confirmed durable inbox receipt without account credentials or transcript content. */
export interface MuseFeedbackReceipt {
  readonly id: MuseFeedbackId
  readonly revision: number
  /** Whether the gateway acknowledged the stable submission key. */
  readonly deduplication?: 'available' | 'unavailable'
}

/** Current owner-verified inbox status without attachments, transcript, or account credentials. */
export interface MuseFeedbackStatus extends MuseFeedbackReceipt {
  readonly title: string
  readonly category: 'bug' | 'suggestion' | 'other'
  readonly status: 'new' | 'reviewing' | 'planned' | 'resolved' | 'closed'
  readonly reply: string
  readonly createdAt: string
  readonly updatedAt: string
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
    /** Current gateway verification only; absent from locally cached status. */
    readonly admin?: boolean
    /** Canonical gateway administrator URL, available only with verified administrator status. */
    readonly adminUrl?: string
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
    'muse-feedback/request-conflict': {}
    'muse-feedback/not-found': {}
    'muse-account/invalid-input': {}
    'muse-account/invalid-credentials': {}
    'muse-account/rate-limited': {}
    'muse-account/registration-disabled': {}
    'muse-account/gateway-unavailable': {}
    'muse-account/gateway-rejected': {}
    'muse-account/storage-failed': {}
  }
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /** Local account identity changed; consumers discard private authority and reverify.
     * @mode emit
     */
    'muse-account/session-changed'(): void
  }
}
