/**
 * Wire vocabulary of the `jubianToken` and `jubianImage` Remote namespaces.
 * Types only: the declarations below are what makes a refusal code this package
 * throws a recognised member of the Remote error map, and what gives the
 * `jubianImage` payload a public home, so the Gateway, the Client, and any other
 * consumer read one typed contract rather than a bare string.
 *
 * @module @deepseek-ai/dsh-tool-jubian/src/types
 */

// Import the protocol module so the declaration at the end of this file
// augments its error map rather than defining an unrelated ambient module.
import type {} from '@deepseek-ai/dsh-typert-protocol'
import type { Branded } from '@deepseek-ai/dsh-brand'

/**
 * One `gpt-image-2` catalogue row as the `jubianImage` namespace carries it.
 *
 * Declared here rather than reused from `dsh-jubian-api`, whose row type is not
 * reachable through a public non-wildcard subpath: a type that crosses a Remote
 * boundary has to live in a module the package exports by name.
 */
export interface ImageRouteRow {
  /** Optional explicit name for deployments exposing several image families. */
  readonly modelId?: string
  readonly modelName?: string
  /** The row's own `id`, which the paid request carries as `standardId`. */
  readonly standardId: number
  /** The platform the row buys from, such as `KU_AI`. */
  readonly platformId: string
  /** The row's unit price, or null while the catalogue states none. */
  readonly unitPrice: number | null
  /** The unit that price is quoted in, or null while the catalogue states none. */
  readonly unit: string | null
}

/** Identity of the exact report bytes and active derivative or reopening. */
export type VideoRecoveryDigest = Branded<'VideoRecoveryDigest'>

/** Lowercase hexadecimal digest of an exact local media file. */
export type VideoArtifactSha256 = Branded<'VideoArtifactSha256'>

/** Operator selection; omission of projectDir retains the selected directory. */
export interface VideoRecoveryConfigurationInput {
  readonly enabled: boolean
  readonly projectDir?: string
}

/** Original-key report operation; mutations require the displayed digest. */
export interface VideoRecoveryReviewInput {
  readonly action: 'read' | 'approve' | 'reject' | 'reopen'
  readonly idempotencyKey: string
  readonly digest?: VideoRecoveryDigest
  /** Optional rejection feedback or required reopening reason. */
  readonly reason?: string
}

/** Capture a project-relative MP4 within video_tasks for an undecided report. */
export interface VideoRecoveryAdoptionInput {
  readonly idempotencyKey: string
  readonly digest: VideoRecoveryDigest
  readonly path: string
}

/** Exact approved report selected for a direct MP4 copy. */
export interface ApprovedClipDeliveryInput {
  readonly idempotencyKey: string
  readonly digest: VideoRecoveryDigest
}

/** Current regular MP4 whose exact bytes match the approved review. */
export interface ApprovedClipDirectDelivery {
  readonly path: string
  readonly sha256: VideoArtifactSha256
}

/** Decoder evidence and the operator's decision for one original submission. */
export interface VideoRecoveryReview {
  readonly idempotencyKey: string
  readonly taskId: number
  readonly status: 'awaiting_review' | 'provider_failed'
  readonly digest: VideoRecoveryDigest
  readonly mediaChecks: readonly { readonly sha256: string; readonly video: boolean; readonly audio: boolean }[]
  readonly derivative?: { readonly path: string; readonly sha256: VideoArtifactSha256 }
  readonly directDelivery?: ApprovedClipDirectDelivery
  /** A saved receipt exists but its current output cannot be reported as delivered. */
  readonly directDeliveryProblem?: 'missing' | 'changed' | 'unreadable'
  readonly decision: 'approve' | 'reject' | null
  readonly reason?: string
  readonly reopenedFrom?: { readonly digest: VideoRecoveryDigest; readonly rejectionReason: string | null; readonly reason: string }
}

/** Saved project selection and current reports, without credentials or provider URLs. */
export interface VideoRecoveryStatus {
  readonly enabled: boolean
  readonly projectDir: string | null
  readonly configurable: boolean
  readonly decoderAvailable: boolean
  /** The saved selection is retained, but its project cannot currently be inspected. */
  readonly projectProblem?: 'unavailable'
  readonly reports: readonly VideoRecoveryReview[]
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** Project-budget read/write was refused; the message identifies the required correction. */
    'jubian-budget/rejected': {}
    /** The selected project, settings or review cannot authorize this recovery operation. */
    'jubian-video-recovery/rejected': {}
    /**
     * The credential provider refused a write of the Jubian admin token — for
     * example because a read-only source shadows the reference. The details
     * name only the reference, so no failure path can carry the value back out.
     */
    'jubian-token/rejected': { readonly ref: string }
    /**
     * The `jubianImage` namespace could not read the account catalogue, so it
     * has no rows to offer. The message is the transport's own reason — a
     * missing token, an expired one, a provider outage — which no detail field
     * narrows without restating it.
     */
    'jubian-image/catalogue-unreadable': {}
  }
}
