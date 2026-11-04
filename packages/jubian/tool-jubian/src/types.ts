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
import type {} from '@deepseek-ai/cordis'

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

/** Local operator's persisted recovery selection. The decoder belongs to the Host. */
export interface VideoRecoveryConfigurationInput {
  readonly enabled: boolean
  /** Omit to retain the saved project directory. */
  readonly projectDir?: string
}

/** Exact recorded submission and review action requested by the operator. */
export interface VideoRecoveryReviewInput {
  readonly action: 'read' | 'approve' | 'reject' | 'reopen'
  readonly idempotencyKey: string
  /** Current report digest. Required for every action that changes the review. */
  readonly digest?: string
  /** Optional rejection feedback or required reopening reason, trimmed to 1–1000 characters. */
  readonly reason?: string
}

/** A project-local MP4 to adopt for an exact, undecided recovery report. */
export interface VideoRecoveryAdoptionInput {
  readonly idempotencyKey: string
  readonly digest: string
  /** Project-relative path within video_tasks. */
  readonly path: string
}

/** Exact approved report selected for delivery. */
export interface ApprovedClipDeliveryInput {
  readonly idempotencyKey: string
  readonly digest: string
}

/** Persisted editor draft and verification of an export from that draft. */
export interface ApprovedClipDelivery {
  readonly draft: { readonly path: string; readonly name: string }
  readonly export?: {
    readonly path: string
    readonly sha256: string
    readonly videoSimilarity: number
    readonly audioSimilarity: number
  }
}

/** Project-relative MP4 delivered with the exact bytes approved in the review. */
export interface ApprovedClipDirectDelivery {
  readonly path: string
  /** Lowercase hexadecimal SHA-256 of the delivered file. */
  readonly sha256: string
}

/** Durable result of rendering one explicitly planned episode from approved clips. */
export interface ApprovedEpisodeDelivery {
  /** Project-relative MP4 path. */
  readonly path: string
  /** Lowercase hexadecimal SHA-256 of the delivered file. */
  readonly sha256: string
  /** Verified duration in seconds. */
  readonly durationSeconds: number
  /** Renderer checks retained with the receipt. */
  readonly checks: readonly { readonly id: string; readonly ok: boolean; readonly detail: string }[]
}

/** Readiness and durable delivery for an explicitly authored episode plan. */
export interface ApprovedEpisodeDeliverySummary {
  readonly episode: number
  readonly approvedShots: number
  readonly totalShots: number
  readonly readiness: 'ready' | 'incomplete' | 'invalid'
  /** Digest of the plan and the exact approved reports it references. */
  readonly digest?: string
  readonly missing: readonly string[]
  readonly delivery?: ApprovedEpisodeDelivery
}

/** Host provider for creating editable local drafts from approved media. */
export interface ApprovedClipDraftService {
  /**
   * Create or recover the editor draft for the supplied reviewed media.
   * @param input - Selected project, absolute media path, exact SHA-256 and task ID.
   * @param signal - Cancellation of local draft generation.
   * @returns The saved editor draft identity and open verification.
   */
  create(input: { projectDir: string; path: string; sha256: string; taskId: number; subtitlePath?: string },
    signal?: AbortSignal): Promise<{ path: string; name: string; editorOpenVerified: boolean }>
  /**
   * Render the verified draft to a new local MP4.
   * @param input - Exact draft identity and absolute output path.
   * @param signal - Cancellation of editor automation.
   * @returns The completed export path.
   */
  export?(input: { draftName: string; draftPath: string; outputPath: string },
    signal?: AbortSignal): Promise<{ path: string }>
}

/** Host renderer that composes a project-authored episode from approved clips. */
export interface ApprovedEpisodeRenderer {
  /**
   * Render and inspect an episode using the current deployment's media tools.
   * @param input - Approved sources and explicit project-owned editing inputs.
   * @param signal - Cancellation of rendering and verification.
   * @returns Render measurements and checks from the episode renderer.
   */
  render(input: {
    readonly projectDir: string
    readonly episode: number
    readonly clips: readonly { readonly shot: number; readonly path: string; readonly sha256: string }[]
    readonly timelinePath: string
    readonly subtitlePath: string
    readonly mixProfilePath: string
    readonly bgmPath?: string
    readonly outputPath: string
  }, signal: AbortSignal): Promise<{
    readonly durationSeconds: number
    readonly checks: readonly { readonly id: string; readonly ok: boolean; readonly detail: string }[]
  }>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    approvedClipDraft: ApprovedClipDraftService
    approvedEpisodeRenderer: ApprovedEpisodeRenderer
  }
}

/** Provider and decoder evidence plus the exact human decision on that evidence. */
export interface VideoRecoveryReview {
  readonly idempotencyKey: string
  readonly taskId: number
  readonly status: 'awaiting_review' | 'provider_failed'
  readonly digest: string
  readonly mediaChecks: readonly {
    readonly sha256: string
    readonly video: boolean
    readonly audio: boolean
  }[]
  /** The checked project-local derivative, when adopted. */
  readonly derivative?: { readonly path: string; readonly sha256: string }
  readonly delivery?: ApprovedClipDelivery
  readonly directDelivery?: ApprovedClipDirectDelivery
  readonly decision: 'approve' | 'reject' | null
  /** Recorded operator feedback, when supplied for a rejection. */
  readonly reason?: string
  /** The original rejection and operator's reason for reopening this artifact. */
  readonly reopenedFrom?: { readonly digest: string; readonly rejectionReason: string | null; readonly reason: string }
}

/** Video recovery settings and reviewed submissions for the selected project. */
export interface VideoRecoveryStatus {
  readonly enabled: boolean
  readonly projectDir: string | null
  readonly configurable: boolean
  readonly decoderAvailable: boolean
  readonly draftAvailable?: boolean
  /** A local editor export provider is registered on this Host. */
  readonly automaticExportAvailable?: boolean
  /** A host-local episode renderer is registered. */
  readonly episodeRendererAvailable?: boolean
  readonly reports: readonly VideoRecoveryReview[]
  /** Explicitly planned full-episode deliveries available in the selected project. */
  readonly episodes?: readonly ApprovedEpisodeDeliverySummary[]
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** Project-budget read/write was refused; the message identifies the required correction. */
    'jubian-budget/rejected': {}
    /** The selected project, settings, or review did not meet the recovery requirements. */
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
