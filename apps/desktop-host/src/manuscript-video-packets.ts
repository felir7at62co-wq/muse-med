/** Compact original-source packets keep saved manuscript lines beside temporal cache samples. */
import type { ContentBlock, ImageBlock } from '@deepseek-ai/dsh-llm'
import type { VideoSourceTimeline } from '@deepseek-ai/dsh-tool-video-inspect'
import type { ManuscriptScene } from './manuscript-scenes.ts'

/** Presentation identity; older saved receipts remain readable without suppressing this representation. */
export const MANUSCRIPT_VIDEO_PRESENTATION = 'line-temporal-packets-v1'
type Frame = VideoSourceTimeline['windows'][number]['frames'][number]
type Segment = NonNullable<VideoSourceTimeline['speech']>['segments'][number]
interface TimeCandidate { start_seconds: number; end_seconds: number; relation: string; segment_ids: readonly string[] }

/** Literal line/source candidates supplied by the manuscript reader, without semantic interpretation. */
export interface ManuscriptSourceLocation {
  anchors: readonly { draft_line: number; segment_id: string }[]
  line_candidates: readonly {
    line: number
    quote: string
    candidates: readonly { segment_id: string; start_seconds: number; end_seconds: number; literal_match: string }[]
  }[]
  between_dialogue_lines: readonly {
    previous_line?: number | undefined
    current_line: number
    relation: string
    ambiguous_source_matches: boolean
    shared_segment_ids: readonly string[]
  }[]
  visual_queries: readonly { line: number; quote: string; kind: string; time_candidates: readonly TimeCandidate[] }[]
  windows: VideoSourceTimeline['windows']
  window_seconds: number
}

/** One literal manuscript range and a bounded temporal image sample, never an action verdict. */
export interface ManuscriptFramePacket {
  scene_id: string
  lines: { line: number; quote: string; kind: string }[]
  interval: TimeCandidate
  ambiguous: boolean
  selection_anchor?: { frame_id: string; time: number }
  images: { frame_id: string; time: number; role: 'before' | 'anchor' | 'after' }[]
  eligible_cache_frames: number
  selection_basis: string
}

/** Saved-scene candidates with the actual temporal samples selected for this refresh. */
export interface ManuscriptPacketPlan {
  scene: ManuscriptScene
  location: ManuscriptSourceLocation
  candidates: ManuscriptFramePacket[]
  selected: ManuscriptFramePacket[]
}

function inRange(time: number, range: TimeCandidate, tolerance: number): boolean {
  return time >= range.start_seconds - tolerance && time <= range.end_seconds + tolerance
}

function sourceFrames(windows: VideoSourceTimeline['windows']): Frame[] {
  return [...new Map(windows.flatMap(window => window.frames).map(frame => [frame.frame_id, frame])).values()]
    .sort((left, right) => left.time - right.time || left.frame_id.localeCompare(right.frame_id))
}

function packetIdentity(packet: ManuscriptFramePacket): string {
  return JSON.stringify([packet.scene_id, packet.interval.start_seconds, packet.interval.end_seconds,
    packet.interval.relation, [...packet.interval.segment_ids].sort()])
}

function temporalSample(packet: ManuscriptFramePacket, frames: readonly Frame[], count: number, tolerance: number): ManuscriptFramePacket {
  const eligible = frames.filter(frame => frame.image_available && frame.observation_source === 'model_authored_observation'
    && inRange(frame.time, packet.interval, tolerance))
  const interior = eligible.filter(frame => inRange(frame.time, packet.interval, 0))
  const center = (packet.interval.start_seconds + packet.interval.end_seconds) / 2
  const contextTargets = new Set(eligible.flatMap(frame => frame.reasons.flatMap(reason =>
    reason.startsWith('context_for:') ? [reason.slice('context_for:'.length)] : [])))
  const anchor = [...interior.length ? interior : eligible].sort((left, right) => {
    const tier = (frame: Frame) => contextTargets.has(frame.frame_id) ? 0 : frame.reasons.includes('cut') ? 1 : 2
    return tier(left) - tier(right) || Math.abs(left.time - center) - Math.abs(right.time - center)
      || left.time - right.time || left.frame_id.localeCompare(right.frame_id)
  })[0]
  if (anchor === undefined || count <= 0) return { ...packet, eligible_cache_frames: eligible.length }
  const linked = eligible.filter(frame => frame.reasons.includes(`context_for:${anchor.frame_id}`))
  const before = linked.findLast(frame => frame.time < anchor.time) ?? eligible.findLast(frame => frame.time < anchor.time)
  const after = linked.find(frame => frame.time > anchor.time) ?? eligible.find(frame => frame.time > anchor.time)
  const triple = [before === undefined ? undefined : { ...before, role: 'before' as const },
    { ...anchor, role: 'anchor' as const }, after === undefined ? undefined : { ...after, role: 'after' as const }]
    .filter((frame): frame is Frame & { role: 'before' | 'anchor' | 'after' } => frame !== undefined)
  const selected = count >= triple.length ? triple : count === 1 ? triple.filter(frame => frame.role === 'anchor')
    : before !== undefined && after !== undefined ? triple.filter(frame => frame.role !== 'anchor') : triple.slice(0, count)
  return { ...packet, eligible_cache_frames: eligible.length,
    selection_anchor: { frame_id: anchor.frame_id, time: anchor.time },
    images: selected.map(frame => ({ frame_id: frame.frame_id, time: frame.time, role: frame.role })),
    selection_basis: linked.length ? 'existing_context_for_temporal_neighbors'
      : 'nearest_cached_temporal_neighbors_not_semantic_evidence' }
}

/**
 * Select local temporal pairs or triplets without using model-authored captions as facts or ranking signals.
 * @param scene - Exact saved manuscript scene and its actual line numbers.
 * @param location - All literal ASR candidates, including repeated and shared original segments.
 * @param count - Remaining image allowance, resolved from the shared Host configuration.
 * @param excluded - Already returned cache identities within this review revision.
 * @returns Complete candidate ranges and the bounded selected packets; absent images do not block writing.
 */
export function planManuscriptVideoPackets(scene: ManuscriptScene, location: ManuscriptSourceLocation, count: number,
  excluded: ReadonlySet<string>): ManuscriptPacketPlan {
  const frames = sourceFrames(location.windows).filter(frame => !excluded.has(frame.frame_id))
  const queries = location.visual_queries.some(query => query.time_candidates.length > 0) ? location.visual_queries
    : location.line_candidates.map(line => ({ ...line, kind: 'dialogue_line', time_candidates: line.candidates.map(candidate => ({
      start_seconds: candidate.start_seconds, end_seconds: candidate.end_seconds, relation: 'within_speech_candidate',
      segment_ids: [candidate.segment_id] })) }))
  const candidates: ManuscriptFramePacket[] = [], byRange = new Map<string, ManuscriptFramePacket>()
  for (const query of queries) for (const interval of query.time_candidates) {
    const key = JSON.stringify([interval.start_seconds, interval.end_seconds, interval.relation, [...interval.segment_ids].sort()])
    let packet = byRange.get(key)
    if (packet === undefined) {
      packet = { scene_id: scene.id, lines: [], interval, ambiguous: false, images: [],
        eligible_cache_frames: 0, selection_basis: 'not_selected' }
      candidates.push(packet)
      byRange.set(key, packet)
    }
    if (!packet.lines.some(line => line.line === query.line && line.quote === query.quote)) {
      packet.lines.push({ line: query.line, quote: query.quote, kind: query.kind })
    }
    packet.ambiguous ||= query.time_candidates.length > 1
  }
  const hasOriginalChange = (packet: ManuscriptFramePacket) => frames.some(frame => inRange(frame.time, packet.interval, 0)
    && frame.reasons.some(reason => reason === 'cut' || reason === 'appearance_or_continuity'))
  const ranked = candidates.filter(packet => frames.some(frame => frame.image_available && frame.observation_source === 'model_authored_observation'
    && inRange(frame.time, packet.interval, location.window_seconds))).sort((left, right) =>
    Number(hasOriginalChange(right)) - Number(hasOriginalChange(left))
    || (left.interval.end_seconds - left.interval.start_seconds) - (right.interval.end_seconds - right.interval.start_seconds)
    || (left.lines[0]?.line ?? 0) - (right.lines[0]?.line ?? 0))
  const groups = ranked.slice(0, Math.min(ranked.length, count < 2 ? count : Math.floor(count / 2)))
  let remaining = count
  const selectedFrames = new Set<string>()
  const selected = groups.map((packet, index) => {
    const sample = temporalSample(packet, frames.filter(frame => !selectedFrames.has(frame.frame_id)),
      Math.min(3, Math.floor(remaining / (groups.length - index))), location.window_seconds)
    for (const frame of sample.images) selectedFrames.add(frame.frame_id)
    remaining -= sample.images.length
    return sample
  })
  return { scene, location, candidates, selected }
}

function originalSpeech(segment: Segment, plans: readonly ManuscriptPacketPlan[]) {
  return { segment_id: segment.segment_id, start_seconds: segment.start_seconds, end_seconds: segment.end_seconds,
    text: segment.text, ...segment.speaker_id === undefined ? {} : { speaker_id: segment.speaker_id },
    speaker_identity_unverified: true, draft_line_refs: plans.flatMap(plan => plan.location.line_candidates.flatMap(line =>
      line.candidates.some(candidate => candidate.segment_id === segment.segment_id)
        ? [{ scene_id: plan.scene.id, line: line.line }] : [])) }
}

/**
 * Assemble one source index and original-ASR catalogue, interleaving selected current lines with real cached image blocks.
 * @param input - Verified current source, actual document SHA, line plans, immutable images and explicit index-row budget.
 * @returns Logged-ready source blocks; all original matched ASR rows survive image-budget and text-only routes.
 */
export function manuscriptVideoPacketContent(input: {
  timeline: VideoSourceTimeline
  documentSha256: string
  plans: readonly ManuscriptPacketPlan[]
  images: ReadonlyMap<string, ImageBlock>
  indexRows: number
}): ContentBlock[] {
  const { timeline, plans, images } = input, frames = sourceFrames(timeline.windows)
  const source = timeline.source, qualified = (id: string) => `${source.review_id}/${id}`
  const speech = new Map((timeline.speech?.segments ?? []).map(segment => [segment.segment_id, segment]))
  const matchedIds = new Set(plans.flatMap(plan => plan.location.line_candidates.flatMap(line =>
    line.candidates.map(candidate => candidate.segment_id))))
  const emitted = new Set<string>()
  const selected = plans.flatMap(plan => plan.selected)
  const lineRefs = plans.flatMap(plan => plan.location.line_candidates.map(line => ({ scene_id: plan.scene.id,
    line: line.line, actual_quote: line.quote, candidate_segment_ids: [...new Set(line.candidates.map(candidate => candidate.segment_id))],
    literal_matches: line.candidates.map(candidate => ({ segment_id: candidate.segment_id, match: candidate.literal_match })),
    ambiguous_source_matches: line.candidates.length > 1 })))
  const content: ContentBlock[] = [{ type: 'text', text: JSON.stringify({ manuscript_video_source: {
    presentation_version: MANUSCRIPT_VIDEO_PRESENTATION, source, source_scope: timeline.scope,
    source_material_sha256: timeline.material_sha256, document_sha256: input.documentSha256,
    transcript_resolution: timeline.transcript_resolution, speech_source: timeline.speech?.source,
    speech_unavailable: timeline.speech_unavailable, speech_association: timeline.speech?.association,
    frame_index: { columns: ['frame_id', 'source_seconds', 'image_available', 'prior_observation_recorded'],
      total_frames: frames.length, returned_rows: Math.min(input.indexRows, frames.length),
      omitted_for_budget: Math.max(0, frames.length - input.indexRows),
      rows: frames.slice(0, input.indexRows).map(frame => [frame.frame_id, frame.time, frame.image_available,
        frame.observation_source === 'model_authored_observation']) },
    window_index: { columns: ['window_id', 'start', 'end', 'frame_count'],
      rows: timeline.windows.map(window => [window.window_id, window.start_seconds, window.end_seconds, window.frames.length]) },
    draft_speech_lines: lineRefs,
    original_asr_scope: { source_segments: speech.size, matched_segment_ids: [...matchedIds],
      matching: 'actual_source_segment_ids_not_text', speaker_identity: 'unverified' },
    continuous_speech_candidates: (timeline.speech?.continuous_speech_candidates ?? [])
      .filter(candidate => candidate.segment_ids.some(id => matchedIds.has(id)))
      .map(candidate => ({ segment_ids: candidate.segment_ids, speaker_id: candidate.speaker_id,
        speaker_identity_unverified: true, gap_seconds: candidate.gap_seconds })),
    dialogue_line_relations: plans.flatMap(plan => plan.location.between_dialogue_lines.map(pair => ({ scene_id: plan.scene.id,
      previous_line: pair.previous_line, current_line: pair.current_line, relation: pair.relation,
      ambiguous_source_matches: pair.ambiguous_source_matches, shared_segment_ids: pair.shared_segment_ids }))),
    visual_candidates: plans.flatMap(plan => plan.candidates.map(packet => ({ scene_id: plan.scene.id,
      draft_lines: packet.lines.map(line => line.line), time_candidate: packet.interval, ambiguous: packet.ambiguous,
      selected_for_images: plan.selected.some(candidate => packetIdentity(candidate) === packetIdentity(packet)) }))),
    selected_packets: selected.length,
    unselected_packets: plans.reduce((total, plan) => total + plan.candidates.length - plan.selected.length, 0),
    prior_model_captions: 'omitted_unverified_available_on_demand',
    scope: 'bounded_temporal_samples_not_all_actions_or_lines_verified',
  } }) }]
  for (const packet of selected) {
    const plan = plans.find(candidate => candidate.scene.id === packet.scene_id)
    const ids = [...new Set(packet.interval.segment_ids)]
    const originals = ids.flatMap((id) => {
      const segment = speech.get(id)
      if (segment === undefined || emitted.has(id)) return []
      emitted.add(id)
      return [originalSpeech(segment, plans)]
    })
    content.push({ type: 'text', text: JSON.stringify({ manuscript_source_packet: {
      review_id: source.review_id, source_version: source.source_version, document_sha256: input.documentSha256,
      scene_id: packet.scene_id, scene_sha256: plan?.scene.sha256, actual_current_lines: packet.lines,
      time_candidate: packet.interval, source_time_ambiguous: packet.ambiguous,
      original_asr_first_occurrences: originals, asr_segment_refs: ids,
      selection_anchor: packet.selection_anchor, temporal_roles: 'source_time_only_not_verified_event_phases',
      selection_anchor_returned: packet.images.some(frame => frame.frame_id === packet.selection_anchor?.frame_id
        && images.has(frame.frame_id)),
      selection_basis: packet.selection_basis, eligible_cached_frames: packet.eligible_cache_frames,
      requested_frame_ids: packet.images.map(frame => qualified(frame.frame_id)),
    } }) })
    for (const [index, frame] of packet.images.entries()) {
      const image = images.get(frame.frame_id), previous = packet.images[index - 1]
      content.push({ type: 'text', text: `VIDEO_FRAME ${qualified(frame.frame_id)} ${JSON.stringify({
        time: frame.time, temporal_role: frame.role, review_id: source.review_id, source_version: source.source_version,
        skipped_cached_frames_since_previous: previous === undefined ? 0
          : frames.filter(candidate => candidate.time > previous.time && candidate.time < frame.time).length,
        delivery: image === undefined ? 'cache_block_not_returned' : image.offloaded ? 'returned_offloaded_not_admitted'
          : 'cached_image_block_not_understanding',
      })}` })
      if (image !== undefined) content.push(image)
    }
  }
  content.push({ type: 'text', text: JSON.stringify({ manuscript_source_speech: {
    review_id: source.review_id, source_version: source.source_version,
    original_asr_remaining: [...matchedIds].flatMap((id) => {
      const segment = speech.get(id)
      return segment === undefined || emitted.has(id) ? [] : [originalSpeech(segment, plans)]
    }), unavailable_segment_ids: [...matchedIds].filter(id => !speech.has(id)),
  } }) })
  return content
}
