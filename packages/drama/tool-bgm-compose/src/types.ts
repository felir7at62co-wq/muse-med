/** Types shared by the short-drama BGM composer. */

/** One story interval assigned to one source track. */
export interface BgmPlanSegment {
  /** Human-readable track name. */
  readonly track: string
  /** Source audio path; absolute or relative to the project. */
  readonly source: string
  /** First second on the episode body timeline. */
  readonly start_seconds: number
  /** Exclusive end second on the episode body timeline. */
  readonly end_seconds: number
  /** Story reason for this selection. */
  readonly reason: string
  /** Optional caller-approved source offset. */
  readonly source_start_seconds?: number
  /** Optional frozen source digest. */
  readonly source_sha256?: string
  /** Optional measured valence from candidate matching. */
  readonly valence?: number
  /** Optional measured arousal from candidate matching. */
  readonly arousal?: number
}

/** One episode row in a BGM plan. */
export interface BgmEpisodePlan {
  /** Episode number, conventionally two digits. */
  readonly episode: string
  /** Body duration excluding the ending. */
  readonly body_duration_seconds: number
  /** Crossfade duration centered on each adjacent segment boundary. */
  readonly crossfade_seconds?: number
  /** Ordered, contiguous story intervals. */
  readonly segments: BgmPlanSegment[]
}

/** One validated segment with its source contribution length. */
export interface ValidatedBgmSegment extends BgmPlanSegment {
  /** Source duration consumed before adjacent overlaps are removed. */
  readonly inputDurationSeconds: number
}

/** One completed external command. */
export interface ProcessOutcome {
  /** Exit code; non-zero is failure. */
  readonly code: number
  /** Captured standard output. */
  readonly stdout: string
  /** Captured standard error. */
  readonly stderr: string
}

/** Injectable process runner used by media operations and tests. */
export interface ProcessChannel {
  /**
   * Run one command to completion.
   * @param command - Executable path.
   * @param args - Command arguments.
   * @param signal - Optional cancellation signal.
   * @returns Captured process outcome.
   */
  run(command: string, args: readonly string[], signal?: AbortSignal): Promise<ProcessOutcome>
}

/** Detected source offset and the evidence used for it. */
export interface SourceStart {
  /** Source offset in seconds. */
  readonly seconds: number
  /** Detection method. */
  readonly kind: 'explicit' | 'onset'
}

/** FFmpeg operations required by the composer. */
export interface MediaToolkit {
  /**
   * Detect the first audible onset in the analysis window.
   * @param source - Source audio path.
   * @param signal - Optional cancellation signal.
   * @returns Detected offset.
   */
  detectSourceStart(source: string, signal?: AbortSignal): Promise<SourceStart>
  /**
   * Measure one source window's mean volume.
   * @param source - Source audio path.
   * @param startSeconds - Source offset.
   * @param durationSeconds - Window duration.
   * @param signal - Optional cancellation signal.
   * @returns Mean decibels.
   */
  meanVolume(source: string, startSeconds: number, durationSeconds: number, signal?: AbortSignal): Promise<number>
}

/** Supported BGM composer operation. */
export type DramaBgmMethod = 'preview' | 'compose' | 'verify'

/** Model-facing call after snake_case mapping. */
export interface DramaBgmArguments {
  /** Operation to run. */
  readonly method: DramaBgmMethod
  /** Short-drama project root. */
  readonly project: string
  /** Positive episode number. */
  readonly episode: number
  /** Episode timeline JSON path. */
  readonly timeline: string
  /** BGM plan JSON path. */
  readonly plan: string
  /** WAV output path; defaulted for compose and required by verify. */
  readonly output?: string
}

/** One analyzed segment in a composer report. */
export interface BgmSegmentReport {
  /** Track label from the plan. */
  readonly track: string
  /** Resolved source path. */
  readonly source: string
  /** Actual source SHA-256. */
  readonly source_sha256: string
  /** Story timeline start. */
  readonly start_seconds: number
  /** Story timeline end. */
  readonly end_seconds: number
  /** Story reason from the plan. */
  readonly reason: string
  /** Source contribution duration before overlap removal. */
  readonly input_duration_seconds: number
  /** Selected source offset. */
  readonly source_start_seconds: number
  /** How the source offset was selected. */
  readonly source_start_kind: 'explicit' | 'onset'
  /** Source-window mean volume. */
  readonly source_mean_db: number
  /** Applied source-window gain. */
  readonly applied_gain_db: number
  /** Optional measured valence copied from the plan. */
  readonly valence?: number
  /** Optional measured arousal copied from the plan. */
  readonly arousal?: number
}

/** Parsed audio facts returned by ffprobe. */
export interface ProbedAudio {
  /** Container format names reported by ffprobe. */
  readonly formatName: string
  /** Audio codec. */
  readonly codec: string
  /** Sample rate in hertz. */
  readonly sampleRate: number
  /** Channel count. */
  readonly channels: number
  /** Container duration in seconds. */
  readonly durationSeconds: number
  /** Container size in bytes. */
  readonly sizeBytes: number
}

/** Audio facts returned by ffprobe. */
export interface BgmMediaReport {
  /** Audio codec or an empty string before output exists. */
  readonly codec: string
  /** Sample rate in hertz. */
  readonly sample_rate: number
  /** Channel count. */
  readonly channels: number
  /** Container duration in seconds. */
  readonly duration_seconds: number
  /** File size in bytes. */
  readonly size_bytes: number
  /** File SHA-256 or an empty string before output exists. */
  readonly sha256: string
}

/** Canonical report returned by every composer operation. */
export interface DramaBgmReport {
  /** Operation that produced the report. */
  readonly method: DramaBgmMethod
  /** Two-digit episode number. */
  readonly episode: string
  /** Absolute project path. */
  readonly project: string
  /** Absolute plan path. */
  readonly plan: string
  /** Absolute timeline path. */
  readonly timeline: string
  /** Output WAV path. */
  readonly output: string
  /** Report sidecar path for compose, otherwise empty. */
  readonly report: string
  /** Body duration excluding the ending. */
  readonly body_duration_seconds: number
  /** Crossfade duration. */
  readonly crossfade_seconds: number
  /** Analyzed segments; verify returns the plan intervals without source analysis. */
  readonly segments: BgmSegmentReport[]
  /** Other episodes declaring the same ordered source sequence. */
  readonly repeated_sequence_episodes: string[]
  /** Output media facts. */
  readonly media: BgmMediaReport
}

/** Validated values used by preview and compose. */
export interface ValidatedBgmEpisodePlan {
  /** Body duration excluding the ending. */
  readonly bodyDurationSeconds: number
  /** Crossfade duration. */
  readonly crossfadeSeconds: number
  /** Ordered segments with derived source lengths. */
  readonly segments: ValidatedBgmSegment[]
}
