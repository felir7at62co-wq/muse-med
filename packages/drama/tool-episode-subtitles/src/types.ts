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
  | 'shots_missing'
  | 'video_missing'
  | 'media_unavailable'
  | 'subtitle_job_failed'
  | 'subtitle_job_unknown'

/** The source-file range of one shot that the episode plays, in microseconds of the source file. */
export interface ShotWindow {
  readonly clipInUs: number
  readonly durationUs: number
  readonly speed: number
}

/** One shot of a resolved episode, in clip order. */
export interface SourceShot {
  /** Shot number: the package number of a local episode, the production-wide shot order of a Jingliu episode. */
  readonly shot: number
  /** Absolute path of the sound whose words become this shot's subtitles. */
  readonly audio: string
  /** Spoken script lines of this shot, in order; read-only input to correction. */
  readonly lines: readonly string[]
  /** Played source range; a local whole-file shot plays from 0 at speed 1 for its measured duration. */
  readonly window: ShotWindow
  /** Jingliu identity recorded in the clock receipt for a Jingliu shot. */
  readonly jingliu?: SubtitleClockJingliuSource
  /** What Jingliu reported about the shot's stored subtitles when the episode was resolved. */
  readonly remote?: RemoteSubtitles
}

/** Jingliu's subtitle status of one shot, computed by the server when the edit plan was read. */
export interface RemoteSubtitles {
  readonly status: 'fresh' | 'stale' | 'unverified' | 'missing'
  /**
   * Rows written before Jingliu recorded where a subtitle came from; they may have been added by hand, so the shot is
   * sent only when the call allows replacing them.
   */
  readonly legacy: number
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

/** The provider of episodes for one `source` value. */
export interface EpisodeSource {
  readonly kind: EpisodeSourceKind
  /** Root directory of `transcript/` and the hash cache. */
  readonly root: string
  /** Model-facing pattern of the SRT paths, for the result. */
  readonly filesPattern: string
  /**
   * Whether cues the clock clips (`cut_by_trim`) or reads too fast (`too_fast`) become review items. False where the
   * source places stored cues itself, so a decision on them could not reach the delivered subtitles.
   */
  readonly clockReview: boolean
  /**
   * Resolve the requested episodes; an episode that cannot be built is returned blocked, never thrown.
   * @param episodes - Episode numbers in request order.
   * @param signal - Owning call cancellation.
   * @returns One entry per episode, in request order.
   */
  resolve(episodes: readonly number[], signal?: AbortSignal): Promise<(ResolvedEpisode | BlockedEpisode)[]>
  /**
   * Store an episode's corrected shots where the source keeps its subtitles; absent for a local project, whose SRT is
   * the stored form. A shot left out of the returned map keeps its cached items and stored mark.
   * @param episode - Resolved episode.
   * @param shots - Every shot of the episode with its current correction input and cached state.
   * @param options - Whether legacy rows may be replaced.
   * @param signal - Owning call cancellation.
   * @returns The stored shots' review items, or why the episode must wait or is blocked.
   */
  store?(episode: ResolvedEpisode, shots: readonly StoreShot[], options: StoreOptions, signal?: AbortSignal): Promise<StoreOutcome>
}

/** What one build allows {@link EpisodeSource.store} to do. */
export interface StoreOptions {
  /** Whether a shot's legacy rows may be archived and replaced; the user chooses this. */
  readonly replaceLegacy: boolean
}

/** One shot handed to {@link EpisodeSource.store}. */
export interface StoreShot {
  readonly shot: SourceShot
  /** Correction input: digest, words, lines, names, decisions and flags. */
  readonly rules: RulesShot
  /** Correction state this call computed or reused. */
  readonly state: ShotState
}

/** Where a shot's corrected subtitles were stored. */
export interface StoredMark {
  /** Stored address of the video the subtitles were made from. */
  readonly video_path: string
  /** Correction key of the stored subtitles. */
  readonly key: string
  /** Job that wrote them. */
  readonly job: string
}

/** Result of storing one episode. */
export type StoreOutcome =
  | {
    readonly kind: 'stored'
    readonly shots: ReadonlyMap<number, { readonly items: readonly ReviewItem[]; readonly stored: StoredMark }>
    /** Shots not stored because they keep legacy rows; the user chooses to keep or replace them. */
    readonly legacy: readonly number[]
  }
  /** The store is still working, or refused shots whose video changed since they were resolved; build again. */
  | { readonly kind: 'waiting'; readonly changed: readonly number[] }
  | { readonly kind: 'blocked'; readonly reason: BlockReason; readonly shots: readonly number[] }

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
  /** Where the source stored these subtitles; only sources with {@link EpisodeSource.store} set it. */
  readonly stored?: StoredMark
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
