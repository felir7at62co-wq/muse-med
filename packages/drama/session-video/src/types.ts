/** Session-bound video inventory and visual cut ranges exposed by `sessionVideo`. */
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** Opaque identity derived from a video's exact Session event coordinate. */
export type SessionVideoSourceId = Branded<'SessionVideoSourceId'>
/** Opaque identity of one range in a version-bound detection result. */
export type SessionVideoShotId = Branded<'SessionVideoShotId'>

/** One video explicitly recorded by the selected conversation. */
export interface SessionVideoSource {
  readonly id: SessionVideoSourceId
  readonly label: string
  readonly origin: 'workspace' | 'presented' | 'attachment' | 'generated'
  /** Recorded local source path, or null when only the provider URL is known. */
  readonly path: string | null
  readonly eventSeq: number
  readonly presentedIndex: number | null
  readonly callId: string | null
  readonly status: 'local' | 'remote-only' | 'missing' | 'unsupported'
  /** Opaque file or provider-URL version; detection refuses a different version. */
  readonly version: string | null
  /** Document-relative authenticated route, or a verified public provider media URL. */
  readonly playbackUrl: string | null
  readonly remoteUrl: string | null
  readonly issue: string | null
}

/** Complete or explicitly bounded inventory from one Session log observation. */
export interface SessionVideoInventory {
  readonly sessionId: SessionId
  readonly sources: readonly SessionVideoSource[]
  readonly complete: boolean
  readonly issues: readonly string[]
}

/** Visual interval in the original video; no story-scene or character claim is made. */
export interface SessionVideoShot {
  readonly id: SessionVideoShotId
  /** One-based chronological position. */
  readonly index: number
  readonly startSeconds: number
  readonly endSeconds: number
  /** The Client may capture a frame from the same playback source. */
  readonly thumbnail: null
}

/** A complete detection result or an explicit failure without invented cut ranges. */
export interface SessionVideoAnalysis {
  readonly sourceId: SessionVideoSourceId
  readonly sourceVersion: string
  readonly state: 'ready' | 'failed'
  readonly durationSeconds: number | null
  readonly width: number | null
  readonly height: number | null
  readonly shots: readonly SessionVideoShot[]
  readonly method: 'ffmpeg-scene'
  readonly threshold: number
  readonly issue: string | null
}
