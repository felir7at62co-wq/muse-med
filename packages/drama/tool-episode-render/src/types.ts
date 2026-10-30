/**
 * The renderer's own vocabulary: the episode timeline, the shot sources a render
 * starts from, the measured media facts, and the canonical result every
 * `drama_render` method returns.
 *
 * @module @deepseek-ai/dsh-tool-episode-render/types
 */

import type { BgmLicenseRecord, BgmUsage, LicenseInfo } from '@deepseek-ai/dsh-bgm-license-info'
import type { SpeechCoverageReport } from './speech-coverage.ts'

/** The operation one `drama_render` call runs. */
export type DramaRenderMethod = 'prepare' | 'render' | 'verify' | 'subtitles' | 'audio_preview' | 'subtitle_overlay'
  | 'speech_coverage' | 'subtitle_layout'

/** How the effect source occupies the existing ending window. */
export type EndingEffectFit = 'source_once' | 'stretch_to_window'

/** Measured effect timing passed to the ending encoder. */
export interface EndingEffectTiming {
  /** Explicit source playback treatment. */
  readonly fit: EndingEffectFit
  /** Measured source duration. */
  readonly sourceDurationSeconds: number
  /** Actual effect coverage, at most the existing ending window. */
  readonly targetDurationSeconds: number
  /** Source seconds consumed per output second. */
  readonly speed: number
}

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

/** Explicit project medium; free-text style never selects delivery behavior. */
export type VisualMedium = 'animation_3d' | 'photorealistic'

/** Explicit project subtitle overrides; omitted fields retain deployment or legacy styling. */
export interface DeliverySubtitle {
  /** ASS-safe font family; selecting it does not install the font. */
  readonly font_family?: string
  /** Nominal font size in final output pixels, not measured glyph bounds. */
  readonly font_size_px?: number
  /** Bottom margin in final output pixels, converted to integer ASS margin units. */
  readonly margin_bottom_px?: number
}

/** One project-owned visual intent, in a reference raster, independently adapted to each renderer. */
export interface DeliverySubtitleVisual {
  /** Adapter contract version; an explicit empty section disables this optional mode. */
  readonly schema_version: 1
  /** Reference raster width, used to explain the approved preview geometry. */
  readonly reference_width: number
  /** Reference height used to scale nominal typography to the actual output. */
  readonly reference_height: number
  /** Nominal font size in reference pixels, not the measured glyph height. */
  readonly font_size_px: number
  /** Black outline thickness in reference pixels. */
  readonly outline_px: number
  /** Text-box centre relative to picture height, measured from the top. */
  readonly center_y_ratio: number
  /** Available single-line width as a fraction of the actual picture width. */
  readonly max_width_ratio: number
  /** Optional requested family; does not install a font or prove the editor uses it. */
  readonly font_family?: string
}

/** Explicit linear gains applied by the existing delivery mix, including zero for mute. */
export interface DeliveryAudio {
  /** Dialogue master gain, from 0 through 8. */
  readonly master_gain?: number
  /** Pure music bed gain, from 0 through 8. */
  readonly bgm_gain?: number
}

/** Editable-draft typography in editor UI units, independent of ASS pixel settings. */
export interface DeliveryDraftStyle {
  /** Optional AI-mark size; animation still omits the mark. */
  readonly watermark?: {
    /** Finite editor font size greater than zero and at most 100. */
    readonly font_size_ui?: number
  }
  /** Optional body-subtitle overrides; omitted fields retain draft defaults. */
  readonly subtitle?: {
    /** Requested font name, not evidence that editor resources or rights are available. */
    readonly font_family?: string
    /** Finite editor font size greater than zero and at most 100. */
    readonly font_size_ui?: number
    /** Finite black-border width from 0 through 100 editor units. */
    readonly border_width_ui?: number
    /** Finite editor-relative vertical position from -1 through 1. */
    readonly transform_y?: number
  }
}

/** Validated delivery snapshot stored in timeline JSON. */
export interface TimelineDelivery {
  /** Explicit medium, omitted for legacy projects that have not selected one. */
  readonly visual_medium?: VisualMedium
  /** Delivered pixel width. */
  readonly width: number
  /** Delivered pixel height. */
  readonly height: number
  /** Delivered frames per second. */
  readonly fps: number
  /** Optional project subtitle section captured by prepare; never inferred from an SRT. */
  readonly subtitle?: DeliverySubtitle
  /** Shared visual intent. A saved empty section restores the legacy per-engine path. */
  readonly subtitle_visual?: DeliverySubtitleVisual | { readonly schema_version?: never }
  /** Optional project mix section captured by prepare. */
  readonly audio?: DeliveryAudio
  /** Optional complete draft-style section captured by prepare, with no ASS effect. */
  readonly draft_style?: DeliveryDraftStyle
}

/** Resolved medium-specific treatment and delivery geometry. */
export interface DeliveryPolicy {
  /** Timeline geometry and effective explicit medium. */
  readonly delivery: TimelineDelivery
  /** Whether the ASS script adds the AI-content mark. */
  readonly addWatermark: boolean
  /** Ending duration, zero for 3D animation. */
  readonly endingSeconds: number
  /** Missing-medium warning for legacy projects. */
  readonly warnings: readonly string[]
}

/** One episode timeline: the clips plus the body end they imply. */
export interface Timeline {
  /** Explicit effect treatment; omitted timelines retain source-once playback. */
  readonly endingEffectFit?: EndingEffectFit
  /** Project delivery settings captured when this timeline was prepared. */
  readonly delivery?: TimelineDelivery
  /** Original body_end when the source JSON declares it; checked for animation endings. */
  readonly declaredBodyEndSeconds?: number
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

/** An authored instruction to retain existing picture text instead of overlaying a whole cue. */
export interface EmbeddedSubtitleDecision {
  /** Shot number on this timeline. */
  readonly shot: number
  /** SHA-256 of the actual selected shot video. */
  readonly source_sha256: string
  /** Inclusive start relative to the shot, seconds. */
  readonly start_seconds: number
  /** Exclusive end relative to the shot, seconds. */
  readonly end_seconds: number
  /** Dialogue expected in the picture. */
  readonly text: string
  /** Keep the existing picture text, without an additional overlay. */
  readonly action: 'retain_embedded'
  /** The caller's rationale, not an independently issued inspection receipt. */
  readonly reason: string
  /** Caller-declared OCR/frame evidence references, not trusted Host attestations. */
  readonly evidence_paths: readonly string[]
}

/** Compact result binding a resolved subtitle overlay to its source files. */
export interface SubtitleOverlayReport {
  /** Two-digit episode number. */
  readonly episode: string
  /** Authored plan path. */
  readonly plan_path: string
  /** Actual plan SHA-256. */
  readonly plan_sha256: string
  /** Unmodified authored SRT. */
  readonly original_srt: string
  /** Actual original SRT SHA-256. */
  readonly original_srt_sha256: string
  /** New SRT containing only external overlays. */
  readonly resolved_srt: string
  /** Actual resolved SRT SHA-256. */
  readonly resolved_srt_sha256: string
  /** Full decision report JSON. */
  readonly decision_report: string
  /** Selected videos checked against authored source digests. */
  readonly sources: { readonly shot: number; readonly path: string; readonly sha256: string }[]
  /** Ordered selected clip geometry used for local-to-episode time mapping. */
  readonly timeline_clips: { readonly shot: number; readonly start_us: number; readonly duration_us: number }[]
  /** Authored cue indexes whose matching text is retained in the video pixels. */
  readonly retained_cue_indexes: number[]
  /** Whole authored cues retained in the original video pixels, on the episode clock. */
  readonly retained_embedded: {
    readonly cue_index: number
    readonly shot: number
    readonly text: string
    readonly start_seconds: number
    readonly end_seconds: number
    readonly source_sha256: string
    readonly editable: false
  }[]
  /** Original cue count. */
  readonly original_cue_count: number
  /** Cue count in the resolved external overlay. */
  readonly overlay_cue_count: number
  /** Authored references do not certify OCR accuracy or inspection. */
  readonly evidence_kind: 'caller_declared'
  /** Retained text is burned in, not editable subtitle content. */
  readonly retained_text_editable: false
  /** External styles cannot change existing picture text. */
  readonly retained_text_style_adjustable: false
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

/** The tail frame's source record as the model reads it. */
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

/** Subtitle design values and their nominal scale at the delivered size, not measured glyph bounds. */
export interface SubtitleRenderStyle {
  /** Explicit centre for the optional unified visual mode; omitted for legacy bottom alignment. */
  readonly center_y_output_px?: number
  /** Requested usable width, checked against rendered glyphs rather than character count. */
  readonly max_width_output_px?: number
  /** ASS design canvas width. */
  readonly design_width: number
  /** ASS design canvas height. */
  readonly design_height: number
  /** Font size in ASS design units. */
  readonly font_size_design: number
  /** Character spacing in ASS design units. */
  readonly spacing_design: number
  /** Outline in ASS design units. */
  readonly outline_design: number
  /** Bottom margin in ASS design units. */
  readonly margin_bottom_design: number
  /** Nominal font size scaled to output pixels; not an actual glyph measurement. */
  readonly font_size_output_px: number
  /** Nominal outline scaled to output pixels. */
  readonly outline_output_px: number
  /** Bottom margin scaled to output pixels. */
  readonly margin_bottom_output_px: number
}

/** Resolved inputs for preparing or performing a render; not a listening or visual approval. */
export interface RenderPreview {
  /** Effective timeline geometry and optional medium. */
  readonly delivery: Pick<TimelineDelivery, 'width' | 'height' | 'fps' | 'visual_medium'>
  /** Selected subtitle file, font and scaled design values. */
  readonly subtitle: SubtitleRenderStyle & {
    /** Selected SRT file. */
    readonly path: string
    /** Project-selected ASS font family, otherwise the deployment font. */
    readonly font_family: string
  }
  /** Explicit input paths and gains; an absent prepare input is an empty string. */
  readonly audio: {
    /** Prepared source-dialogue master. */
    readonly master_path: string
    /** Explicitly selected music bed, or empty when not selected during prepare. */
    readonly bgm_path: string
    /** Explicit segment-plan file, or empty when omitted. */
    readonly bgm_plan_path: string
    /** Gain applied to the dialogue master. */
    readonly master_gain: number
    /** Gain applied to the selected music bed. */
    readonly bgm_gain: number
  }
}

/** Compact real-glyph observations; complete per-text measurements and font traces stay in the report file. */
export interface SubtitleLayoutSummary {
  /** Summary format version. */
  readonly schema_version: 1
  /** A successful measurement is not editor or human acceptance. */
  readonly status: 'not_requested' | 'measured' | 'partial' | 'not_measured'
  /** Complete measurement JSON, or an empty string when it could not be saved. */
  readonly report_path: string
  /** Different authored texts measured once each. */
  readonly distinct_texts: number
  /** Texts with complete, non-clipped white-ink bounds. */
  readonly measured_texts: number
  /** Original cue indexes wider than the project band including estimated outline allowance. */
  readonly overwidth_cue_indexes: number[]
  /** Original cue indexes with failed, empty or edge-clipped measurement. */
  readonly uncertain_cue_indexes: number[]
  /** Actually written full-width probe previews, not completed-episode frames. */
  readonly preview_paths: string[]
  /** Actually written complete FFmpeg output for font selection and technical diagnosis. */
  readonly stderr_paths: string[]
}

/**
 * The canonical value every `drama_render` method returns.
 *
 * The field spellings are the pipeline's own snake_case, because the result is
 * read next to `body_end`, `shot_00N.mp4`, and the delivery numbers it reports.
 * Base fields are always present, with empty values for measurements not made.
 * Explicit audio profiles add optional `audio_mix` evidence.
 */
export interface DramaRenderReport {
  /** Advisory real-glyph evidence; omitted from legacy renders without an active visual profile. */
  readonly subtitle_layout?: SubtitleLayoutSummary
  /** Word-timed ASR comparison candidates; never a listening or silence verdict. */
  readonly speech_coverage?: SpeechCoverageReport
  /** Explicit subtitle-overlay decisions; omitted for legacy calls. */
  readonly subtitle_overlay?: SubtitleOverlayReport
  /** Measured timing for an explicitly selected effect fit. */
  readonly ending_effect?: {
    readonly fit: EndingEffectFit
    readonly source_duration_seconds: number
    readonly target_duration_seconds: number
    readonly speed: number
  }
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
  /** The ending frame's source record. */
  readonly tail_frame: TailFrameReport
  /** The delivered file's measured facts. */
  readonly media: MediaFactsReport
  /** Every check this operation ran; `ok` applies only to these checks, not overall creative approval. */
  readonly checks: RenderCheck[]
  /** QA areas not measured by this operation, even when `ok` is true. */
  readonly not_checked: string[]
  /** Optional music-plan evidence; empty values when no plan was checked. */
  readonly bgm_plan: BgmPlanReport
  /** Explicit audio-profile evidence; omitted for unchanged legacy calls. */
  readonly audio_mix?: AudioMixReport
  /** Effective prepare/render inputs; null when this method does not prepare or encode media. */
  readonly render_preview: RenderPreview | null
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
  /** Stable catalog identity when declared in the plan. */
  readonly track_id?: string
  /** Normalized audio license declaration, not independently verified rights. */
  readonly license_info: LicenseInfo
  /** Source digest declared in the plan; the renderer does not rehash each track. */
  readonly source_sha256?: string
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
  /** Declared episode use, or unknown when no plan was read. */
  readonly intended_use: BgmUsage
  /** Declared track rights and non-blocking use risks; empty when no plan was read. */
  readonly license_records: BgmLicenseRecord[]
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
  /** Deployment fallback when the timeline does not select a tail-effect fit. */
  readonly defaultEndingEffectFit?: EndingEffectFit
  /** Deployment's fallback subtitle target when the project has not selected a style. */
  readonly defaultSubtitleVisual?: DeliverySubtitleVisual
  /** Apply the deployment subtitle target even to old project and timeline overrides. */
  readonly enforceSubtitleVisual?: boolean
  /** Normalize display text while retaining source SRT and measured cue times. */
  readonly normalizeSubtitleText?: boolean
  /** Deployment ceiling for the final BGM multiplier; omitted retains the legacy limit of 8. */
  readonly maxBgmVolume?: number
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
  /** Explicit project profile; omission preserves the legacy filter. */
  readonly profile?: ResolvedAudioMixProfile
  /** Original-audio input index; render uses 1 and audio previews use 0. */
  readonly originalInput?: number
  /** Ending-audio input index when an ending exists. */
  readonly endingInput?: number
  /** Expose an independent, already-gained music output pad named musicstem. */
  readonly musicStem?: boolean
  /** Shared timeline offset for a bounded audio preview. */
  readonly startSeconds?: number
}

/** Explicit, versioned choices for added music; original sound is not speech-separated. */
export interface AudioMixProfile {
  /** Profile format version. */
  readonly schema_version: 1
  /** Legacy gains, no added music, or original-audio-driven ducking. */
  readonly mode: 'legacy' | 'no_bgm' | 'ducking'
  /** Gain of the retained original audio. */
  readonly original_gain?: number
  /** Gain of the added music. */
  readonly music_gain?: number
  /** Duration of each measurement frame, in milliseconds. */
  readonly analysis_window_ms: number
  /** Required explicit compressor parameters in ducking mode. */
  readonly ducking?: {
    readonly threshold_db: number
    readonly ratio: number
    readonly attack_ms: number
    readonly release_ms: number
    readonly knee: number
  }
}

/** Project profile after deployment gains have been captured once. */
export interface ResolvedAudioMixProfile extends AudioMixProfile {
  /** Absolute, real project-owned profile path. */
  readonly path: string
  /** Resolved original-audio gain. */
  readonly original_gain: number
  /** Resolved added-music gain. */
  readonly music_gain: number
}

/** Paths and explicit parameters of one audio mix or bounded audition. */
export interface AudioMixReport {
  /** Report version. */
  readonly schema_version: 1
  /** Real project-owned profile path. */
  readonly profile_path: string
  /** Selected added-music behavior. */
  readonly mode: AudioMixProfile['mode']
  /** Effective parameters, excluding the profile path. */
  readonly parameters: AudioMixProfile & { readonly original_gain: number; readonly music_gain: number }
  /** Original-audio energy is not semantic voice activity detection. */
  readonly detector: 'source_audio_rms_not_speech_vad' | 'none'
  /** Original sound, which can already contain effects or music. */
  readonly original_audio: string
  /** Added-music input; empty in no_bgm mode. */
  readonly music_audio: string
  /** Music-only output; never contains the original audio. */
  readonly music_stem: string
  /** Whether a composer receipt supplied source-window gains for this exact bed. */
  readonly composition_gain_status: 'provided' | 'not_provided'
  /** Verified composer receipt and its per-source gains. */
  readonly composition?: {
    readonly path: string
    readonly bed_sha256: string
    readonly segments: {
      readonly track: string
      readonly source: string
      readonly start_seconds: number
      readonly end_seconds: number
      readonly source_mean_db: number
      readonly applied_gain_db: number
    }[]
  }
  /** Bounded, aligned audio comparison and measurement paths. */
  readonly preview?: {
    readonly start_seconds: number
    readonly duration_seconds: number
    readonly selected_mix: string
    readonly without_added_music: string
    readonly music_stem: string
    readonly analysis: string
  }
}

/** One fixed-duration audio frame measured by FFmpeg astats. */
export interface AudioWindow {
  /** Offset relative to the start of the audition. */
  readonly time_seconds: number
  /** RMS level in dBFS; null denotes digital silence. */
  readonly rms_dbfs: number | null
  /** Sample peak in dBFS; null denotes digital silence. */
  readonly peak_dbfs: number | null
  /** Both RMS and peak are negative infinity. */
  readonly silent: boolean
}
