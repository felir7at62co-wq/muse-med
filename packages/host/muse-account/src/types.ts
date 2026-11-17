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
  /** Opaque next-page value returned by account-data-v1 gateways. */
  readonly cursor?: string
  /** Successful account-data-v1 UTC range retained while following its cursors. */
  readonly range?: { readonly from: string; readonly to: string }
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
export interface MuseAccountFullDetails {
  readonly protocol?: 'muse-account-details'
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

/** Supplier-reported counters retained by the relay-only account-data-v1 ledger. */
export interface MuseAccountRelayTokenFields {
  readonly prompt_tokens?: number | undefined
  readonly completion_tokens?: number | undefined
  readonly total_tokens?: number | undefined
  readonly input_tokens?: number | undefined
  readonly output_tokens?: number | undefined
  readonly prompt_cache_hit_tokens?: number | undefined
  readonly prompt_cache_miss_tokens?: number | undefined
  readonly reasoning_tokens?: number | undefined
  readonly prompt_tokens_details?: {
    readonly cached_tokens?: number | undefined
    readonly audio_tokens?: number | undefined
  } | undefined
  readonly completion_tokens_details?: {
    readonly reasoning_tokens?: number | undefined
    readonly audio_tokens?: number | undefined
    readonly accepted_prediction_tokens?: number | undefined
    readonly rejected_prediction_tokens?: number | undefined
  } | undefined
  readonly input_tokens_details?: {
    readonly cached_tokens?: number | undefined
    readonly audio_tokens?: number | undefined
  } | undefined
  readonly output_tokens_details?: {
    readonly reasoning_tokens?: number | undefined
    readonly audio_tokens?: number | undefined
  } | undefined
}

/** Authenticated relay-only measurements; summaries cover the full UTC date range, items one cursor page. */
export interface MuseAccountRelayUsage {
  readonly version: 1
  readonly coverage: { readonly transport: 'relay-only'; readonly direct: 'unobserved' }
  readonly from: string
  readonly to: string
  readonly summary: {
    readonly requests: number
    readonly completedRequests: number
    readonly failedRequests: number
    readonly pendingRequests: number
    readonly unknownRequests: number
    readonly reportedUsageRequests: number
    readonly partialUsageRequests: number
    readonly unreportedUsageRequests: number
    readonly inputTokens: number | null
    readonly outputTokens: number | null
    readonly totalTokens: number | null
  }
  readonly items: readonly {
    readonly requestId: MuseAccountUsageId
    readonly startedAt: string
    readonly finishedAt: string | null
    readonly channel: 'cloud-relay' | 'desktop-relay'
    readonly route: string | null
    readonly state: 'completed' | 'failed' | 'pending' | 'unknown'
    readonly usageStatus: 'reported' | 'partial' | 'unreported'
    readonly usage: MuseAccountRelayTokenFields | null
    readonly requestedModel: string | null
    readonly forwardedModel: string | null
    readonly responseModel: string | null
    readonly upstreamStatus: number | null
    readonly clientStatus: number | null
    readonly errorKind: 'request_rejected' | 'upstream_http' | 'invalid_content_type' | 'transport' | 'cancelled' | null
  }[]
  readonly nextCursor: string | null
  readonly health: { readonly state: 'ok' | 'degraded' }
}

/** Verified current-account profile and organization data, independent of usage measurement coverage. */
export interface MuseAccountProfile {
  readonly version: 1
  readonly account: MuseAccountFullDetails['account']
  readonly groups: MuseAccountFullDetails['groups']
  readonly organization: {
    readonly status: 'available' | 'unavailable'
    readonly updatedAt: string | null
    readonly departments: readonly {
      readonly id: MuseFeishuDepartmentId
      readonly name: string
      readonly path: string
      readonly pathIds: readonly MuseFeishuDepartmentId[]
    }[]
  }
}

/** Account-data-v1 identity and relay measurements, with optional verified personal profile support. */
export interface MuseAccountRelayDetails {
  readonly protocol: 'account-data-v1'
  readonly account: { readonly id: MuseAccountId; readonly username: string }
  /** Omission means the gateway does not implement the personal-profile endpoint. */
  readonly profile?: MuseAccountProfile
  /** Account-level departments from the profile or the authenticated self workbench. */
  readonly organization?: MuseAccountProfile['organization']
  readonly availability: {
    readonly profile: 'available' | 'unavailable'
    readonly groups: 'available' | 'unavailable'
    readonly feishuOrganization: 'available' | 'unavailable'
  }
  readonly usage: MuseAccountRelayUsage
}

/** Current-account data with explicit gateway capabilities and measurement coverage. */
export type MuseAccountDetails = MuseAccountFullDetails | MuseAccountRelayDetails

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
