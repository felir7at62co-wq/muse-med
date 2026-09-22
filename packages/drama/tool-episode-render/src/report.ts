/**
 * Builder from the renderer's internal result to the model-facing one.
 *
 * The result keeps the pipeline's own snake_case spellings, because it is read
 * next to `body_end`, `body_end_seconds`, and the delivery specification it
 * reports on. Every field is always present: a method that did not measure
 * something reports the empty value, so a caller never has to branch on which
 * keys exist.
 *
 * @module @deepseek-ai/dsh-tool-episode-render/report
 */

import type {
  BgmPlanReport,
  DramaRenderMethod,
  DramaRenderReport,
  MediaFacts,
  MediaFactsReport,
  RenderCheck,
  RenderClipReport,
  RenderSummary,
  TailFrameEvidence,
  TailFrameReport,
  Timeline,
} from './types.ts'

/** The tail-frame record for a method that built no ending. */
export const NO_TAIL_FRAME: TailFrameEvidence = {
  path: '',
  frameMd5: '',
  sequentialTailMd5: '',
  fromSequentialDecode: false,
  matchesSequentialTail: false,
}

/** The measured-facts record for a method that measured no delivered file. */
export const NO_MEDIA: MediaFacts = {
  durationSeconds: 0,
  sizeBytes: 0,
  bitrateBps: 0,
  videoCodec: '',
  width: 0,
  height: 0,
  fps: 0,
  hasAudio: false,
  audioCodec: '',
  audioSampleRate: 0,
}

/** Everything one method's report is built from. */
export interface ReportInput {
  /** The operation that produced the result. */
  readonly method: DramaRenderMethod
  /** Optional declared BGM plan validated by render. */
  readonly bgmPlan?: BgmPlanReport
  /** Absolute project root. */
  readonly project: string
  /** Two-digit episode number. */
  readonly episode: string
  /** The timeline this call worked from, or a timeline with no clips. */
  readonly timeline: Timeline
  /** Absolute paths of the render inputs this call resolved: the shots on the timeline. */
  readonly sources: ReadonlyMap<number, string>
  /** The duration the delivered file must reach. */
  readonly expectedDurationSeconds: number
  /** Absolute paths this call created or overwrote. */
  readonly written: readonly string[]
  /** Absolute path of the delivered file, or an empty string. */
  readonly output: string
  /** The encoder this render used, or an empty string. */
  readonly encoder: string
  /** Whether a GPU encoder was requested. */
  readonly gpuRequested: boolean
  /** Whether the GPU encoder was actually used. */
  readonly gpuUsed: boolean
  /** Why the CPU encoder ran; empty when the GPU encoder ran. */
  readonly encoderFallbackReason: string
  /** Shots this call encoded. */
  readonly encodedShots: readonly number[]
  /** Shots this call reused from the cache. */
  readonly reusedShots: readonly number[]
  /** The ending frame's provenance. */
  readonly tailFrame: TailFrameEvidence
  /** The delivered file's measured facts. */
  readonly media: MediaFacts
  /** Every check this operation ran. */
  readonly checks: readonly RenderCheck[]
  /** One Chinese line per non-blocking observation. */
  readonly warnings: readonly string[]
  /** Absolute path of the render log, or an empty string. */
  readonly logPath: string
}

/** Map one extracted tail frame to the shape the model reads. */
function tailFrameReport(evidence: TailFrameEvidence): TailFrameReport {
  return {
    path: evidence.path,
    frame_md5: evidence.frameMd5,
    sequential_tail_md5: evidence.sequentialTailMd5,
    from_sequential_decode: evidence.fromSequentialDecode,
    matches_sequential_tail: evidence.matchesSequentialTail,
  }
}

/** Map one measured media record to the shape the model reads. */
function mediaReport(media: MediaFacts): MediaFactsReport {
  return {
    duration_seconds: media.durationSeconds,
    size_bytes: media.sizeBytes,
    bitrate_bps: media.bitrateBps,
    video_codec: media.videoCodec,
    width: media.width,
    height: media.height,
    fps: media.fps,
    has_audio: media.hasAudio,
    audio_codec: media.audioCodec,
    audio_sample_rate: media.audioSampleRate,
  }
}

/**
 * Build the canonical result of one `drama_render` call.
 *
 * `ok` is true exactly when no failure-severity check failed; warnings ride along
 * without changing it.
 * @param input - Operation identity, timeline, resolved sources, and every measured fact.
 * @returns The result the tool returns and renders.
 */
export function buildReport(input: ReportInput): DramaRenderReport {
  const failures = input.checks
    .filter(check => check.severity === 'failure' && !check.ok)
    .map(check => `${check.id}: ${check.detail} 修法：${check.fix}`)
  const warnings = [
    ...input.warnings,
    ...input.checks
      .filter(check => check.severity === 'warning' && !check.ok)
      .map(check => `${check.id}: ${check.detail} 修法：${check.fix}`),
  ]
  const clips: RenderClipReport[] = input.timeline.clips.map(clip => ({
    shot: clip.shot,
    source: input.sources.get(clip.shot) ?? '',
    start_us: clip.startUs,
    duration_us: clip.durationUs,
  }))
  const summary: RenderSummary = {
    shots: clips.length,
    encoded: input.encodedShots.length,
    reused: input.reusedShots.length,
    checks: input.checks.length,
    failed_checks: input.checks.filter(check => !check.ok).length,
    warnings: warnings.length,
  }
  return {
    method: input.method,
    ok: failures.length === 0,
    project: input.project,
    episode: input.episode,
    clips,
    body_end_seconds: input.timeline.bodyEndSeconds,
    expected_duration_seconds: input.expectedDurationSeconds,
    written: [...input.written],
    output: input.output,
    encoder: input.encoder,
    gpu_requested: input.gpuRequested,
    gpu_used: input.gpuUsed,
    encoder_fallback_reason: input.encoderFallbackReason,
    encoded_shots: [...input.encodedShots],
    reused_shots: [...input.reusedShots],
    tail_frame: tailFrameReport(input.tailFrame),
    media: mediaReport(input.media),
    checks: [...input.checks],
    not_checked: [
      'duration', 'video_stream', 'frame_rate', 'audio_stream', 'bitrate_floor',
      'black_frames', 'silence', 'subtitle_bounds', 'subtitle_present',
      'speech_alignment', 'embedded_subtitles', 'content_review', 'bgm_listening', 'bgm_plan_audio_match',
      ...(input.method === 'verify' ? ['output_source_mapping'] : []),
      ...(input.bgmPlan?.path ? [] : ['bgm_plan']),
    ].filter(id => !input.checks.some(check => check.id === id)),
    bgm_plan: input.bgmPlan ?? { path: '', bed_sha256: '', segments: [], repeated_sequence_episodes: [] },
    failures,
    warnings,
    log_path: input.logPath,
    summary,
  }
}
