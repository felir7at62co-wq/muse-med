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

/** Logical episode delivery attempt retained across physical executions. */
export type EpisodeAttemptId = Branded<'EpisodeAttemptId'>
/** One physical renderer execution; an armed value cannot be reused. */
export type EpisodeExecutionId = Branded<'EpisodeExecutionId'>
/** Actual captured renderer provider lifetime. */
export type EpisodeRendererGeneration = Branded<'EpisodeRendererGeneration'>
/** Durable cancellation origin; a cancelled media proof does not select a retry policy. */
export type EpisodeCancellationReason = 'configuration-changed' | 'provider-disposed' | 'explicit-stop' | 'host-disconnected'

/** One authored project episode whose plan is read from editing/NN-episode-delivery.json. */
export interface EpisodeReadinessInput {
  readonly projectDir: string
  readonly episode: number
}

/** Exact readiness digest selected for an idempotent logical admission. */
export interface EpisodeStatusInput extends EpisodeReadinessInput {
  readonly digest: VideoArtifactSha256
}

/** Explicit original-task recovery; omission only reconciles its admission receipt. */
export interface EpisodeAdmissionInput extends EpisodeStatusInput {
  readonly resume?: true
}

/** Current source/renderer readiness without provider URLs or model calls. */
export interface EpisodeReadiness {
  readonly projectDir: string
  readonly episode: number
  readonly ready: boolean
  readonly digest: VideoArtifactSha256 | null
  readonly shots: number
  readonly issues: readonly string[]
  readonly renderer: {
    readonly generation: EpisodeRendererGeneration
    readonly configurationSha256: VideoArtifactSha256
    readonly codeSha256: VideoArtifactSha256
  } | null
}

/** Durable targeted state; cancellation cause is separate from guardian media outcome. */
export interface EpisodeDeliveryStatus {
  readonly projectDir: string
  readonly episode: number
  readonly digest: VideoArtifactSha256
  readonly attempt: EpisodeAttemptId | null
  /** True only when the original task has matching durable drain and needs explicit recovery. */
  readonly canResume: boolean
  readonly state: 'not-admitted' | 'queued' | 'preparing' | 'running' | 'stopping' | 'completed' | 'cancelled' | 'failed' | 'unknown'
  readonly execution?: EpisodeExecutionId
  readonly cancellationReason?: EpisodeCancellationReason
  /** Measurements recorded at publication; this field does not verify current files or listening. */
  readonly output?: { readonly path: string; readonly sha256: VideoArtifactSha256; readonly bytes: number }
  readonly problem?: string
}

/** Exact selected project configuration used by a source lease. */
export type VideoRecoveryProjectDigest = Branded<'VideoRecoveryProjectDigest'>

/** Immutable original ledger intent fields used by a source lease. */
export type VideoRecoveryIntentDigest = Branded<'VideoRecoveryIntentDigest'>

/** Approved immutable metadata; this value alone does not verify current media bytes. */
export interface ApprovedVideoSourceMetadata {
  readonly idempotencyKey: string
  readonly digest: VideoRecoveryDigest
  readonly taskId: number
  readonly kind: 'provider' | 'derivative'
  readonly path: string
  readonly sha256: VideoArtifactSha256
}

/** Current regular file identity after a full hash; not a persisted media-drain proof. */
export interface ApprovedVideoSourceVersion {
  readonly path: string
  readonly sha256: VideoArtifactSha256
  readonly dev: number
  readonly ino: number
  readonly size: number
  readonly mtimeMs: number
  readonly ctimeMs: number
}

/** One actual approved source captured under one selected-project generation. */
export interface ApprovedVideoSource {
  readonly idempotencyKey: string
  readonly digest: VideoRecoveryDigest
  readonly taskId: number
  readonly intentDigest: VideoRecoveryIntentDigest
  readonly project: {
    readonly directory: string
    readonly scriptId: number
    readonly configurationDigest: VideoRecoveryProjectDigest
  }
  readonly source: {
    readonly kind: 'provider' | 'derivative'
    readonly path: string
    readonly sha256: VideoArtifactSha256
  }
}

/** Source-owner cancellation origin, persisted before a long consumer is stopped. */
export type ApprovedVideoSourceCancellationReason = 'configuration-changed' | 'provider-disposed' | 'caller-cancelled'

/** One batch, so multiple clips never require nesting recovery-queue commits. */
export interface ApprovedVideoSourceRequest {
  readonly items: readonly ApprovedClipDeliveryInput[]
  /** Positive byte budget resolved by the consumer's validated deployment Config. */
  readonly metadataMaxBytes: number
}

/** Same-process admission facts; the recovery owner retains their generation and file versions. */
export interface ApprovedVideoSourceAdmission {
  /** Captured selection lifetime; consumers own no resources through this token. */
  readonly signal: AbortSignal
  readonly sources: readonly ApprovedVideoSource[]
}

/** Source-owner lifetime and one final serialized prepared publication. */
export interface ApprovedVideoSourceLease {
  /** Readiness token for a later short admission; it owns no consumer or disposer. */
  readonly admission: ApprovedVideoSourceAdmission
  readonly sources: readonly ApprovedVideoSource[]
  readonly signal: AbortSignal
  /** Refuse new work immediately once this lease is ending, before deferred cancellation IO finishes. */
  assertActive(): void
  /**
   * Hash every current source outside the queue, then reread all immutable facts inside it.
   * @returns Completion only when the whole captured batch still matches.
   */
  recheck(): Promise<void>
  /**
   * Verify all sources, then serialize a small prepared publication with decisions and configuration.
   * The callback must only version-check prepared files and atomically link/write small receipts;
   * copying, hashing, media work and calling recovery operations are forbidden inside it.
   * A successful atomic commit is retained when its caller disconnects afterward.
   * @param publish - Prepared, no-overwrite small IO; its signal belongs to provider teardown.
   * @returns The committed result, without rolling back already published bytes.
   */
  commit<Result>(publish: (signal: AbortSignal) => Promise<Result>): Promise<Result>
}

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

/**
 * Current source availability, excluded from the immutable review digest.
 * A known source carries its project-relative expected managed path and bare expected captured SHA-256.
 * Missing, changed or unreadable states do not report the current file's hash; only verified confirms matching regular bytes.
 */
export type VideoRecoverySource =
  | {
    readonly kind: 'provider'
    readonly path: string
    readonly sha256: VideoArtifactSha256
    readonly state: 'verified' | 'unmaterialized' | 'changed' | 'unreadable'
  }
  | {
    readonly kind: 'derivative'
    readonly path: string
    readonly sha256: VideoArtifactSha256
    readonly state: 'verified' | 'missing' | 'changed' | 'unreadable'
  }
  | { readonly kind: 'none'; readonly state: 'unverifiable' }

/** Decoder evidence and the operator's decision for one original submission. */
export interface VideoRecoveryReview {
  readonly idempotencyKey: string
  readonly taskId: number
  readonly status: 'awaiting_review' | 'provider_failed'
  readonly digest: VideoRecoveryDigest
  readonly mediaChecks: readonly { readonly sha256: string; readonly video: boolean; readonly audio: boolean }[]
  /** Read-only local verification; provider absence does not assert download history. */
  readonly source: VideoRecoverySource
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
    /** New episode admission is paused during update inspection or teardown. */
    'jubian-episode-delivery/paused': {}
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
