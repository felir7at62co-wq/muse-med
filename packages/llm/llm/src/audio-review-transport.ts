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

export interface AudioReviewTransport {
  /** List explicitly configured, compatible routes without resolving any credentials. */
  configuredRoutes(): readonly AudioReviewRoute[]
  /** Send one isolated request. The implementation rechecks route eligibility before dispatch. */
  request(input: AudioReviewRequest): Promise<AudioReviewTransportResult>
}

/** Read complete 16-bit PCM audio accepted by the dedicated listening route.
 * @param wav - Exact WAV bytes to send.
 * @returns Sample-derived duration in seconds, or undefined for invalid media.
 */
export function audioReviewWavDuration(wav: Uint8Array): number | undefined {
  const bytes = Buffer.isBuffer(wav) ? wav : Buffer.from(wav)
  if (bytes.length < 44 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.readUInt32LE(4) !== bytes.length - 8
    || bytes.toString('ascii', 8, 12) !== 'WAVE') return undefined
  let rate = 0
  let frameBytes = 0
  let dataBytes: number | undefined
  for (let offset = 12; offset < bytes.length;) {
    if (offset + 8 > bytes.length) return undefined
    const tag = bytes.toString('ascii', offset, offset + 4)
    const length = bytes.readUInt32LE(offset + 4)
    const start = offset + 8
    offset = start + length + (length % 2)
    if (offset > bytes.length) return undefined
    if (tag === 'fmt ') {
      if (rate !== 0 || length < 16 || bytes.readUInt16LE(start) !== 1 || bytes.readUInt16LE(start + 14) !== 16) return undefined
      const channels = bytes.readUInt16LE(start + 2)
      if (channels !== 1 && channels !== 2) return undefined
      rate = bytes.readUInt32LE(start + 4)
      frameBytes = channels * 2
      if (rate < 8000 || rate > 48000 || bytes.readUInt16LE(start + 12) !== frameBytes
        || bytes.readUInt32LE(start + 8) !== rate * frameBytes) return undefined
    } else if (tag === 'data') {
      if (rate === 0 || dataBytes !== undefined || length === 0 || length % frameBytes !== 0) return undefined
      dataBytes = length
    }
  }
  if (dataBytes === undefined) return undefined
  return dataBytes / (rate * frameBytes)
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    audioReviewTransport: AudioReviewTransport
  }
}
