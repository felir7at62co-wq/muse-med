/**
 * The renderer's own vocabulary: the episode timeline, the shot sources a render
 * starts from, the measured media facts, and the canonical result every
 * `drama_render` method returns.
 *
 * @module @deepseek-ai/dsh-tool-episode-render/types
 */

/** The operation one `drama_render` call runs. */
export type DramaRenderMethod = 'prepare' | 'render' | 'verify' | 'subtitles'

/** How much one render check's failure matters. */
export type CheckSeverity = 'failure' | 'warning'

/** One clip on the episode timeline, positioned on the episode's own clock. */
export interface TimelineClip {
  /** Shot number, 1-based and contiguous. */
  readonly shot: number
  /** Microseconds from the episode start to this clip's first frame. */
  readonly startUs: number
  /** Microseconds this clip occupies. */
  readonly durationUs: number
}

/** One episode timeline: the clips plus the body end they imply. */
export interface Timeline {
  /** Every clip, in shot order. */
  readonly clips: readonly TimelineClip[]
  /** Seconds from the episode start to the last body frame, excluding the ending. */
  readonly bodyEndSeconds: number
}

/** One shot's own media, as the shot-sources manifest declares it. */
export interface ShotSource {
  /** Explicit 1-based video_tasks package number; omitted when the source has not been mapped. */
  readonly package?: number
  /** Shot number, 1-based. */
  readonly shot: number
  /** Absolute path of the reviewed provider video that supplies this shot's picture. */
  readonly video: string
  /** Absolute path of the audio that supplies this shot's sound; the video's own track when the manifest omits it. */
  readonly audio: string
}

/** One subtitle cue, positioned in seconds. */
export interface SubtitleCue {
  /** 1-based position in the subtitle file. */
  readonly index: number
  /** Seconds from the episode start to the cue's first frame. */
  readonly startSeconds: number
  /** Seconds from the episode start to the cue's last frame. */
  readonly endSeconds: number
  /** The cue's text with its line breaks removed. */
  readonly text: string
}

/** One stream of an ffprobe report, narrowed to the fields this package reads. */
export interface ProbedStream {
  /** `video`, `audio`, or another ffprobe stream type. */
  readonly codecType: string
  /** The stream's codec name, for example `h264`. */
  readonly codecName: string
  /** Pixel width; video streams only. */
  readonly width?: number
  /** Pixel height; video streams only. */
  readonly height?: number
  /** The stream's average frame rate as ffprobe reports it, for example `60/1`. */
  readonly avgFrameRate?: string
  /** The stream's nominal frame rate, used when no average is reported. */
  readonly rFrameRate?: string
  /** Audio sample rate in hertz; audio streams only. */
  readonly sampleRate?: number
  /** Audio channel count; audio streams only. */
  readonly channels?: number
}

/** One probed media file. */
export interface ProbedMedia {
  /** Every stream ffprobe reported, in container order. */
  readonly streams: readonly ProbedStream[]
  /** Container duration in seconds. */
  readonly durationSeconds: number
  /** File size in bytes. */
  readonly sizeBytes: number
  /** Overall bitrate in bits per second. */
  readonly bitRateBps: number
}

/** One finished external command. */
export interface MediaCommandOutcome {
  /** The process exit code; a non-zero code is reported here rather than thrown. */
  readonly code: number
  /** Everything the process wrote to standard output. */
  readonly stdout: string
  /** Everything the process wrote to standard error. */
  readonly stderr: string
}

/** Where one external process is started. Tests supply their own channel. */
export interface ProcessChannel {
  /**
   * Run one command to completion.
   * @param command - Absolute path or executable name to start.
   * @param args - Arguments handed to the process unchanged.
   * @returns The exit code and both captured streams.
   */
  run(command: string, args: readonly string[]): Promise<MediaCommandOutcome>
}

/** The media binaries plus the channel that starts them. */
export interface MediaToolkit {
  /** The ffmpeg executable to start. */
  readonly ffmpeg: string
  /** The ffprobe executable to start. */
  readonly ffprobe: string
  /** Where every process is started. */
  readonly channel: ProcessChannel
}

/** The encoder one render runs with, plus why it was chosen. */
export interface EncoderChoice {
  /** `h264_nvenc` when the probe succeeded, otherwise `libx264`. */
  readonly encoder: string
  /** The rate-control and profile arguments this encoder takes. */
  readonly args: readonly string[]
  /** The probe failure that forced `libx264`, collapsed to one line; empty when the GPU encoder was chosen. */
  readonly fallbackReason: string
}

/** What proves one extracted ending frame is the source's real last frame. */
export interface TailFrameEvidence {
  /** Absolute path of the written PNG. */
  readonly path: string
  /** MD5 of the written frame as ffmpeg's `framemd5` reports it. */
  readonly frameMd5: string
  /** MD5 of the source's last frame from a full sequential decode. */
  readonly sequentialTailMd5: string
  /** Whether the frame came from a sequential decode instead of the `-sseof` seek. */
  readonly fromSequentialDecode: boolean
  /** Whether the written frame's MD5 equals the sequential decode's last frame. */
  readonly matchesSequentialTail: boolean
}

/** The measured facts about the delivered file. */
export interface MediaFacts {
  /** Container duration in seconds; 0 when nothing was measured. */
  readonly durationSeconds: number
  /** File size in bytes; 0 when nothing was measured. */
  readonly sizeBytes: number
  /** Overall bitrate in bits per second; 0 when nothing was measured. */
  readonly bitrateBps: number
  /** Video codec name; empty when nothing was measured. */
  readonly videoCodec: string
  /** Pixel width; 0 when nothing was measured. */
  readonly width: number
  /** Pixel height; 0 when nothing was measured. */
  readonly height: number
  /** Average frame rate; 0 when nothing was measured. */
  readonly fps: number
  /** Whether the file carries an audio stream. */
  readonly hasAudio: boolean
  /** Audio codec name; empty when the file has no audio stream. */
  readonly audioCodec: string
  /** Audio sample rate in hertz; 0 when the file has no audio stream. */
  readonly audioSampleRate: number
}

/** One checked property of the delivered file. */
export interface RenderCheck {
  /** Stable check name; a repair loop keys on it. */
  readonly id: string
  /** `failure` makes the delivered file unusable; `warning` records a fact worth reading. */
  readonly severity: CheckSeverity
  /** Whether this check passed. */
  readonly ok: boolean
  /** The measured value the verdict came from. */
  readonly detail: string
  /** Chinese repair instruction; empty when the check passed. */
  readonly fix: string
}

/** The tail frame's provenance as the model reads it. */
export interface TailFrameReport {
  /** Absolute path of the extracted PNG; empty when no ending was built. */
  readonly path: string
  /** MD5 of the frame that was written; empty when no ending was built. */
  readonly frame_md5: string
  /** MD5 of the source's last frame from a full sequential decode. */
  readonly sequential_tail_md5: string
  /** Whether the frame came from a sequential decode instead of the `-sseof` seek. */
  readonly from_sequential_decode: boolean
  /** Whether the written frame proved equal to the sequential decode's last frame. */
  readonly matches_sequential_tail: boolean
}

/** The delivered file's measured facts as the model reads them. */
export interface MediaFactsReport {
  /** Container duration in seconds; 0 when nothing was measured. */
  readonly duration_seconds: number
  /** File size in bytes; 0 when nothing was measured. */
  readonly size_bytes: number
  /** Overall bitrate in bits per second; 0 when nothing was measured. */
  readonly bitrate_bps: number
  /** Video codec name; empty when nothing was measured. */
  readonly video_codec: string
  /** Pixel width; 0 when nothing was measured. */
  readonly width: number
  /** Pixel height; 0 when nothing was measured. */
  readonly height: number
  /** Average frame rate; 0 when nothing was measured. */
  readonly fps: number
  /** Whether the file carries an audio stream. */
  readonly has_audio: boolean
  /** Audio codec name; empty when the file has no audio stream. */
  readonly audio_codec: string
  /** Audio sample rate in hertz; 0 when the file has no audio stream. */
  readonly audio_sample_rate: number
}

/** One clip as the result reports it. */
export interface RenderClipReport {
  /** Shot number. */
  readonly shot: number
  /** Absolute path of the source video on the episode timeline; empty when the method resolved none. */
  readonly source: string
  /** Microseconds from the episode start to this clip's first frame. */
  readonly start_us: number
  /** Microseconds this clip occupies. */
  readonly duration_us: number
}

/** Counts over one result's lists. */
export interface RenderSummary {
  /** Clips on the timeline. */
  readonly shots: number
  /** Shots encoded by this call. */
  readonly encoded: number
  /** Shots reused from the cache by this call. */
  readonly reused: number
  /** Checks run. */
  readonly checks: number
  /** Checks that did not pass, warnings included. */
  readonly failed_checks: number
  /** Warnings recorded. */
  readonly warnings: number
}

/**
 * The canonical value every `drama_render` method returns.
 *
 * The field spellings are the pipeline's own snake_case, because the result is
 * read next to `body_end`, `shot_00N.mp4`, and the delivery numbers it reports.
 * Every field is always present: a method that did not measure something reports
 * the empty value, so a caller never has to branch on which keys exist.
 */
export interface DramaRenderReport {
  /** The operation that produced this result. */
  readonly method: DramaRenderMethod
  /** Whether the operation completed and every failure-severity check passed. */
  readonly ok: boolean
  /** Absolute project root. */
  readonly project: string
  /** Two-digit episode number. */
  readonly episode: string
  /** The clips the operation worked from, in shot order. */
  readonly clips: RenderClipReport[]
  /** Seconds from the episode start to the last body frame; 0 when no timeline was read. */
  readonly body_end_seconds: number
  /** Body end plus the ending length: the duration the delivered file must reach. */
  readonly expected_duration_seconds: number
  /** Absolute paths this call created or overwrote, in write order. */
  readonly written: string[]
  /** Absolute path of the delivered file; empty until `render` writes one. */
  readonly output: string
  /** The encoder this render used; empty when no render ran. */
  readonly encoder: string
  /** Whether a GPU encoder was requested. */
  readonly gpu_requested: boolean
  /** Whether the GPU encoder was actually used. */
  readonly gpu_used: boolean
  /** The probe failure that forced the CPU encoder, or why no GPU encoder was requested; empty when the GPU encoder ran. */
  readonly encoder_fallback_reason: string
  /** Shots this call encoded, in shot order. */
  readonly encoded_shots: number[]
  /** Shots this call reused from the render cache, in shot order. */
  readonly reused_shots: number[]
  /** The ending frame's provenance. */
  readonly tail_frame: TailFrameReport
  /** The delivered file's measured facts. */
  readonly media: MediaFactsReport
  /** Every check this operation ran; `ok` applies only to these checks, not overall creative approval. */
  readonly checks: RenderCheck[]
  /** QA areas not measured by this operation, even when `ok` is true. */
  readonly not_checked: string[]
  /** Optional music-plan evidence; empty values when no plan was checked. */
  readonly bgm_plan: BgmPlanReport
  /** One Chinese line per failure-severity check that failed. */
  readonly failures: string[]
  /** One Chinese line per warning-severity check that failed, plus every non-blocking observation. */
  readonly warnings: string[]
  /** Absolute path of the render log; empty when no log was written. */
  readonly log_path: string
  /** Counts a caller can read without walking the lists. */
  readonly summary: RenderSummary
}

/** A declared music segment on the episode clock, not an acoustic measurement. */
export interface BgmSegment {
  /** Human-readable track identity. */
  readonly track: string
  /** Track source path declared by the plan. */
  readonly source: string
  /** Segment start on the body clock. */
  readonly start_seconds: number
  /** Segment end on the body clock. */
  readonly end_seconds: number
  /** Creative rationale supplied by the caller. */
  readonly reason: string
}

/** Declared BGM metadata bound to the bed used by this render. */
export interface BgmPlanReport {
  /** Plan file, or empty when none was supplied. */
  readonly path: string
  /** SHA-256 of the bed, not a verification that it matches the declared tracks. */
  readonly bed_sha256: string
  /** Segments for this episode, or empty when not checked. */
  readonly segments: BgmSegment[]
  /** Other planned episodes with the same ordered track sources; advisory only. */
  readonly repeated_sequence_episodes: string[]
}

/** The deployment-varying choices one render resolves. */
export interface RenderSettings {
  /** ffmpeg executable to start. */
  readonly ffmpeg: string
  /** ffprobe executable to start. */
  readonly ffprobe: string
  /** Gain applied to the episode's own master audio. */
  readonly masterVolume: number
  /** Gain applied to the BGM bed. */
  readonly bgmVolume: number
  /** Whether the GPU encoder is probed at all. */
  readonly preferNvenc: boolean
  /** Directory libass resolves the subtitle font from. */
  readonly fontsDir: string
  /** Validated ASS subtitle font family. */
  readonly subtitleFontFamily: string
  /** Validated ASS watermark font family. */
  readonly watermarkFontFamily: string
  /** Injection point for tests; the process channel is otherwise the real one. */
  readonly channel?: ProcessChannel
}

/** One audio mix: the three gains and the two boundaries the graph cuts at. */
export interface AudioMixSpec {
  /** Seconds of picture before the ending starts. */
  readonly bodyEndSeconds: number
  /** Seconds of picture in total, including the ending. */
  readonly totalSeconds: number
  /** Seconds the ending occupies. */
  readonly endingSeconds: number
  /** Gain applied to the episode's own master audio. */
  readonly masterVolume: number
  /** Gain applied to the BGM bed. */
  readonly bgmVolume: number
}
