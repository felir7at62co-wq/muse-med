/** Shared types of the episode subtitle builder; this module contains no runtime code. */
import type { ResolvedShot, SubtitleClockJingliuSource } from '@deepseek-ai/dsh-tool-episode-render/subtitles'

/** Where an episode's shots, media and script lines come from. */
export type EpisodeSourceKind = 'local' | 'jingliu'

/** Why an episode cannot be built now; each names the shots involved. */
export type BlockReason =
  | 'package_missing'
  | 'selection_missing'
  | 'package_changed'
  | 'selection_changed'
  | 'media_unreadable'
  | 'media_changed'
  | 'sign_in_required'
  | 'daily_quota'
  | 'asr_failed'
  | 'asr_uncertain'
  | 'asr_error'
  | 'jingliu_outdated'

/** The source-file range of one shot that the episode plays, in microseconds of the source file. */
export interface ShotWindow {
  readonly clipInUs: number
  readonly durationUs: number
  readonly speed: number
}

/** One shot of a resolved episode, in clip order. */
export interface SourceShot {
  /** Clip order inside the episode, starting at 1. */
  readonly shot: number
  /** Absolute path of the sound whose words become this shot's subtitles. */
  readonly audio: string
  /** Spoken script lines of this shot, in order; read-only input to correction. */
  readonly lines: readonly string[]
  /** Played source range; a local whole-file shot plays from 0 at speed 1 for its measured duration. */
  readonly window: ShotWindow
  /** Jingliu identity recorded in the clock receipt for a Jingliu shot. */
  readonly jingliu?: SubtitleClockJingliuSource
}

/** Where one episode's outputs live. */
export interface EpisodeFiles {
  /** Canonical SRT; its clock receipt sits beside it. */
  readonly srt: string
  /** Per-shot cache of correction results. */
  readonly state: string
  /** Current review items. */
  readonly review: string
  /** Decisions by review item ID. */
  readonly decisions: string
}

/** An episode whose shots and media are known. */
export interface ResolvedEpisode {
  readonly kind: 'ok'
  readonly episode: number
  /** Two-digit episode identity used by every receipt. */
  readonly code: string
  readonly shots: readonly SourceShot[]
  /** Measured picture clock in clip order, as the renderer and the draft use it. */
  readonly clock: readonly ResolvedShot[]
  /** Character names and speakers the correction may treat as names. */
  readonly names: readonly string[]
  readonly files: EpisodeFiles
}

/** An episode that cannot be built until the named shots are fixed. */
export interface BlockedEpisode {
  readonly kind: 'blocked'
  readonly episode: number
  readonly reason: BlockReason
  readonly shots: readonly number[]
}

/** The provider of episodes for one `source` value; M6 adds the Jingliu provider behind the same methods. */
export interface EpisodeSource {
  readonly kind: EpisodeSourceKind
  /** Root directory of `transcript/` and the hash cache. */
  readonly root: string
  /** Model-facing pattern of the SRT paths, for the result. */
  readonly filesPattern: string
  /**
   * Resolve the requested episodes; an episode that cannot be built is returned blocked, never thrown.
   * @param episodes - Episode numbers in request order.
   * @param signal - Owning call cancellation.
   * @returns One entry per episode, in request order.
   */
  resolve(episodes: readonly number[], signal?: AbortSignal): Promise<(ResolvedEpisode | BlockedEpisode)[]>
}

/** One measured word in shot-local source seconds. */
export interface TimedWord {
  readonly start: number
  readonly end: number
  /** Recognized text, with the punctuation or space that follows it in the segment. */
  readonly text: string
  /** Recognition segment; cues never cross it. */
  readonly seg: number
  readonly speaker_id?: string
}

/** A finding from packing or splitting that the review lists. */
export interface TranscriptFlag {
  readonly kind: 'boundary'
  readonly start: number
  readonly end: number
}

/** `transcript/shots/<audio_sha256>.json`: one shot's recognized words, independent of any episode. */
export interface ShotTranscript {
  readonly version: 1
  readonly audio_sha256: string
  readonly samples: number
  readonly pack: { readonly sha256: string; readonly receipt: string; readonly offset_samples: number }
  readonly service_version?: string
  readonly silent: boolean
  readonly words: readonly TimedWord[]
  readonly flags: readonly TranscriptFlag[]
}

/** A review decision action. */
export type DecisionAction = 'heard' | 'script' | 'drop'

/** A cue in shot-local source seconds. */
export interface ShotCue {
  readonly start: number
  readonly end: number
  readonly text: string
}

/** A review item as the rules or the clock layout produce it. */
export interface ReviewItem {
  readonly id: string
  readonly kind: string
  readonly heard: string
  readonly script: string
  readonly start: number
  readonly end: number
  readonly decision: DecisionAction | null
}

/** Correction output cached per shot in `NN.state.json`. */
export interface ShotState {
  readonly shot: number
  readonly audio_sha256: string
  /** Digest of transcript, lines, names, rules and relevant decisions. */
  readonly key: string
  readonly cues: readonly ShotCue[]
  readonly items: readonly ReviewItem[]
}

/** One shot of a rules request. */
export interface RulesShot {
  readonly key: string
  readonly audio_sha256: string
  readonly words: readonly TimedWord[]
  readonly lines: readonly string[]
  readonly names: readonly string[]
  readonly decisions: readonly { readonly id: string; readonly action: DecisionAction }[]
  readonly flags: readonly TranscriptFlag[]
}

/** One shot of a rules response. */
export interface RulesShotResult {
  readonly key: string
  readonly cues: readonly ShotCue[]
  readonly items: readonly ReviewItem[]
  readonly pending: number
}

/** Correction and layout of many shots in one call. */
export interface SubtitleRules {
  /**
   * Digest of the rule files, equal to the one the runner reports.
   * @returns Lowercase SHA-256.
   */
  digest(): Promise<string>
  /**
   * Correct and lay out every shot.
   * @param shots - Shots to process.
   * @param signal - Owning call cancellation.
   * @returns One result per shot, keyed like the request.
   */
  run(shots: readonly RulesShot[], signal?: AbortSignal): Promise<RulesShotResult[]>
}
