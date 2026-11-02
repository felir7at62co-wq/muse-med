/** Time-aligned source material; observations and event descriptions remain model-authored notes. */
import { createHash } from 'node:crypto'
import { basename, dirname, relative } from 'node:path'
import { reviewEventCurrent } from './review-events.ts'
import { reviewImage, type VideoReview } from './review-state.ts'
import type { ReviewSpeech, ReviewSpeechUnavailable } from './review-speech.ts'
import type { VideoTranscriptResolution } from './review-transcript.ts'

/** Source-only selection; fixed time windows do not assert scene or action boundaries. */
export interface VideoTimelineSelection {
  /** Caller-resolved grouping interval in source seconds. */
  windowSeconds: number
  /** Inclusive source start; omitted selects the episode start. */
  startSeconds?: number
  /** Exclusive source end, except the episode's closing frame; omitted selects the episode end. */
  endSeconds?: number
}

/** One source revision's time windows, with raw ASR and model notes kept distinct. */
export interface VideoSourceTimeline {
  advisory: true
  semantic_assessment: 'not_performed'
  source: {
    review_id: VideoReview['id']
    episode: string
    path: string
    source_version: string
    /** Closing follow-up does not change source coverage or prevent explicit evidence reads. */
    follow_up: NonNullable<VideoReview['follow_up']>
    duration_seconds: number
    scan_complete: boolean
    scanned_until: number
  }
  scope: { start_seconds: number; end_seconds: number; full_episode: boolean; window_seconds: number }
  material_sha256: string
  windows: {
    window_id: string
    start_seconds: number
    end_seconds: number
    frames: {
      frame_id: string
      time: number
      reasons: string[]
      exposed: boolean
      image_available: boolean
      observation_source: 'model_authored_observation' | 'not_recorded'
      observation?: NonNullable<VideoReview['frames'][number]['observation']>
    }[]
    event_notes: (NonNullable<VideoReview['event_groups']>[number] & {
      evidence_source: 'model_authored_observations'
      evidence_current: boolean
    })[]
    speech_segment_ids: string[]
    continuous_speech_candidate_indexes: number[]
  }[]
  speech?: ReviewSpeech
  speech_unavailable?: ReviewSpeechUnavailable
  transcript_resolution?: VideoTranscriptResolution
  notice: string
}

function overlaps(start: number, end: number, left: number, right: number, closing: boolean): boolean {
  return start < right && end > left || start === end && start >= left && (start < right || closing && start === right)
}

/**
 * Group recorded source evidence by time without synthesizing actions, character identities or draft coverage.
 * @param review - Current video revision and its saved frame observations.
 * @param selection - Explicit time-window budget and optional source interval.
 * @param speech - Complete original saved ASR; source association remains caller supplied.
 * @param unavailable - Optional diagnostic for a saved ASR source that cannot safely be reused.
 * @param resolution - Explicit-reference or current-task read-candidate selection, without claiming shared source identity.
 * @returns Selected time windows, original overlapping ASR rows and an identity for these exact materials.
 */
export function buildVideoSourceTimeline(review: VideoReview, selection: VideoTimelineSelection,
  speech?: ReviewSpeech, unavailable?: ReviewSpeechUnavailable, resolution?: VideoTranscriptResolution): VideoSourceTimeline {
  const start = selection.startSeconds ?? 0, end = selection.endSeconds ?? review.duration
  if (!Number.isFinite(selection.windowSeconds) || selection.windowSeconds <= 0 || !Number.isFinite(start)
    || !Number.isFinite(end) || start < 0 || end > review.duration || start >= end) {
    throw Error('VIDEO_TIMELINE_RANGE: 时间窗须为正数，范围须在当前视频内且结束晚于开始。')
  }
  const selectedSegments = speech?.segments.filter(segment => overlaps(segment.start_seconds, segment.end_seconds,
    start, end, end === review.duration))
  const segmentIds = new Set(selectedSegments?.map(segment => segment.segment_id))
  const continuous = speech?.continuous_speech_candidates.filter(candidate => candidate.segment_ids.some(id => segmentIds.has(id))) ?? []
  const contextIds = new Set(continuous.flatMap(candidate => candidate.segment_ids))
  const selectedSpeech = speech === undefined ? undefined : { ...speech,
    segments: speech.segments.filter(segment => segmentIds.has(segment.segment_id) || contextIds.has(segment.segment_id)),
    continuous_speech_candidates: continuous }
  const windows: VideoSourceTimeline['windows'] = []
  for (let index = Math.floor(start / selection.windowSeconds); index * selection.windowSeconds < end; index++) {
    const left = Math.max(start, index * selection.windowSeconds), right = Math.min(end, (index + 1) * selection.windowSeconds)
    const closing = right === review.duration
    const frames = review.frames.filter(frame => frame.time >= left && (frame.time < right || closing && frame.time === right))
      .sort((a, b) => a.time - b.time || a.id.localeCompare(b.id))
    const windowSegments = selectedSpeech?.segments.filter(segment =>
      overlaps(segment.start_seconds, segment.end_seconds, left, right, closing)) ?? []
    const windowSegmentIds = new Set(windowSegments.map(segment => segment.segment_id))
    windows.push({ window_id: `W${String(index + 1).padStart(5, '0')}`, start_seconds: left, end_seconds: right,
      frames: frames.map(frame => ({ frame_id: frame.id, time: frame.time, reasons: frame.reasons,
        exposed: frame.exposed, image_available: reviewImage(frame) !== undefined,
        observation_source: frame.observation === undefined ? 'not_recorded' : 'model_authored_observation',
        ...frame.observation === undefined ? {} : { observation: frame.observation } })),
      event_notes: (review.event_groups ?? []).filter(event =>
        overlaps(event.start_seconds, event.end_seconds, left, right, closing) || event.end_seconds === left)
        .map(event => ({ ...event, evidence_source: 'model_authored_observations',
          evidence_current: reviewEventCurrent(event, review.frames) })),
      speech_segment_ids: windowSegments.map(segment => segment.segment_id),
      continuous_speech_candidate_indexes: (selectedSpeech?.continuous_speech_candidates ?? []).flatMap((candidate, candidateIndex) =>
        candidate.segment_ids.some(id => windowSegmentIds.has(id)) ? [candidateIndex] : []),
    })
  }
  const source = { review_id: review.id, episode: review.episode, path: review.path, source_version: review.source_version,
    follow_up: review.follow_up ?? { status: 'active' as const },
    duration_seconds: review.duration, scan_complete: review.scan_complete, scanned_until: review.scanned_until }
  const scope = { start_seconds: start, end_seconds: end, full_episode: start === 0 && end === review.duration,
    window_seconds: selection.windowSeconds }
  const materials = { source, scope, windows, ...selectedSpeech === undefined ? {} : { speech: selectedSpeech },
    ...unavailable === undefined ? {} : { speech_unavailable: unavailable },
    ...resolution === undefined ? {} : { transcript_resolution: resolution } }
  const { review_id: _id, follow_up: _followUp, ...sourceIdentity } = source
  const normalizedPath = (path: string) => relative(dirname(review.path), path).replaceAll('\\', '/')
  const normalizedReference = (reference: NonNullable<VideoTranscriptResolution['reference']>) => ({
    ...reference, path: normalizedPath(reference.path) })
  const digestMaterials = { ...materials, source: { ...sourceIdentity, path: basename(source.path) },
    ...selectedSpeech === undefined ? {} : { speech: { ...selectedSpeech,
      source: { ...selectedSpeech.source, path: normalizedPath(selectedSpeech.source.path) } } },
    ...unavailable === undefined ? {} : { speech_unavailable: { reference: normalizedReference(unavailable.reference),
      ...unavailable.current_version === undefined ? {} : { current_version: unavailable.current_version } } },
    ...resolution === undefined ? {} : { transcript_resolution: { kind: resolution.kind,
      ...resolution.reference === undefined ? {} : { reference: normalizedReference(resolution.reference) },
      diagnostics: resolution.diagnostics.map(diagnostic => ({ path: normalizedPath(diagnostic.path), status: diagnostic.status,
        ...diagnostic.reference === undefined ? {} : { reference: normalizedReference(diagnostic.reference) } }))
        .sort((a, b) => a.path.localeCompare(b.path) || a.status.localeCompare(b.status)) } } }
  return { advisory: true, semantic_assessment: 'not_performed', ...materials,
    material_sha256: createHash('sha256').update(JSON.stringify(digestMaterials)).digest('hex'),
    notice: '按实际时间并列画面记录、动作笔记和ASR原段；时间窗不是换场或动作分界。观察与事件均由模型记录，不代表动作已经核实。'
      + '连续发言仅为候选，不推定角色或自动合并台词；未记录帧与未确认状态保持可见，不按帧数补动作。'
      + '局部范围不代表全片已核对；需要时重看对应缓存原图，材料本身不是新增写作要求或交付条件。' }
}
