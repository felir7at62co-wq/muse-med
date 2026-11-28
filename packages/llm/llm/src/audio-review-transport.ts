/** Host-only transport for a bounded, standalone audio review. */
import type { ProviderRequestId } from './brand.ts'
import type { TokenUsage } from './types.ts'

/** A deployment-approved audio-capable provider and exact model. */
export interface AudioReviewRoute {
  readonly provider: string
  readonly model: string
}

/** The caller owns the prompt, bounded media and cancellation. */
export interface AudioReviewRequest extends AudioReviewRoute {
  readonly prompt: string
  readonly wav: readonly Uint8Array[]
  readonly signal?: AbortSignal
  /** Retain provider accounting metadata even if the answer cannot be used. */
  readonly onProviderResponse?: (receipt: AudioReviewProviderResponse) => Promise<void>
}

/** Provider response facts bound to the exact locally measured input hashes. */
export interface AudioReviewProviderResponse extends AudioReviewRoute {
  readonly audioSha256: readonly string[]
  readonly usage?: TokenUsage
  /** Provider-issued response identifier, when supplied by the wire protocol. */
  readonly requestId?: ProviderRequestId
}

/** Provider output and locally measured request hashes for review. */
export interface AudioReviewTransportResult extends AudioReviewProviderResponse {
  readonly response: Readonly<Record<string, unknown>>
  readonly listeningVerified: false
  readonly grantsApproval: false
}

/** Host service for bounded standalone audio review on deployment-approved routes. */
export interface AudioReviewTransport {
  /**
   * List explicitly configured, compatible routes without resolving any credentials.
   * @returns Eligible provider and model pairs.
   */
  configuredRoutes(): readonly AudioReviewRoute[]
  /**
   * Send one isolated request. The implementation rechecks route eligibility before dispatch.
   * @param input - Exact route, bounded WAV bytes, prompt and optional cancellation or accounting callback.
   * @returns Provider output and matching request hashes for advisory review.
   */
  request(input: AudioReviewRequest): Promise<AudioReviewTransportResult>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    audioReviewTransport: AudioReviewTransport
  }
}
