/** Compact original-source packets keep saved manuscript lines beside temporal cache samples. */
import type { ContentBlock, ImageBlock } from '@deepseek-ai/dsh-llm'
import type { VideoSourceTimeline } from '@deepseek-ai/dsh-tool-video-inspect'
import type { ManuscriptScene } from './manuscript-scenes.ts'

/** Presentation identity; older saved receipts remain readable without suppressing this representation. */
export const MANUSCRIPT_VIDEO_PRESENTATION = 'source-and-line-temporal-packets-v2'
type Frame = VideoSourceTimeline['windows'][number]['frames'][number]
type Segment = NonNullable<VideoSourceTimeline['speech']>['segments'][number]
interface TimeCandidate { start_seconds: number; end_seconds: number; relation: string; segment_ids: readonly string[] }

/** Literal line/source candidates supplied by the manuscript reader, without semantic interpretation. */
export interface ManuscriptSourceLocation {
  anchors: readonly { draft_line: number; segment_id: string }[]
  line_candidates: readonly {
    line: number
    quote: string
    candidates: readonly {
      segment_id: string
      start_seconds: number
      end_seconds: number
      literal_match: string
      matched_characters?: number
    }[]
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
  origin?: 'draft_candidates' | 'source_timeline'
  lines: { line: number; quote: string; kind: string }[]
  sampling_lines?: { line: number; quote: string; kind: string }[]
  literal_selection?: { preferred: boolean; tier: number; matched_characters: number }
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
  return JSON.stringify([packet.scene_id, packet.origin ?? 'draft_candidates', packet.interval.start_seconds, packet.interval.end_seconds,
    packet.interval.relation, [...packet.interval.segment_ids].sort()])
}

function originalChange(frame: Frame): boolean {
  return frame.reasons.some(reason => reason === 'cut' || reason === 'appearance_or_continuity')
}

function literalTier(value: string): number {
  return value === 'exact' ? 0 : value === 'source_contains_draft' ? 1 : value === 'draft_contains_source' ? 2 : 3
}

function querySelection(query: ManuscriptSourceLocation['visual_queries'][number], interval: TimeCandidate,
  location: ManuscriptSourceLocation): NonNullable<ManuscriptFramePacket['literal_selection']> {
  const own = location.line_candidates.find(line => line.line === query.line)
  const relevant = own === undefined ? [
    { line: location.line_candidates.findLast(line => line.line < query.line), endpoint: 'previous' },
    { line: location.line_candidates.find(line => line.line > query.line), endpoint: 'next' },
  ].filter(entry => entry.line !== undefined) : [{ line: own, endpoint: 'own' }]
  const supports = relevant.flatMap(({ line, endpoint }) => {
    if (line === undefined) return []
    const matches = line.candidates.filter((candidate) => {
      if (!interval.segment_ids.includes(candidate.segment_id)) return false
      if (interval.relation === 'within_same_speech' || interval.relation === 'within_speech_candidate') {
        return candidate.start_seconds === interval.start_seconds && candidate.end_seconds === interval.end_seconds
      }
      if (interval.relation === 'between_speech_candidates_not_an_event') return endpoint === 'previous'
        ? candidate.end_seconds === interval.start_seconds : endpoint === 'next' && candidate.start_seconds === interval.end_seconds
      if (interval.relation === 'before_speech_candidate') return endpoint === 'next' && candidate.start_seconds === interval.end_seconds
      if (interval.relation === 'after_speech_candidate') return endpoint === 'previous' && candidate.end_seconds === interval.start_seconds
      return false
    })
    const bestTier = Math.min(...line.candidates.map(candidate => literalTier(candidate.literal_match)))
    const selectedTier = Math.min(...matches.map(candidate => literalTier(candidate.literal_match)))
    return [{ preferred: matches.length > 0 && selectedTier === bestTier,
      tier: Number.isFinite(selectedTier) ? selectedTier : 3,
      matched_characters: Math.max(0, ...matches.map(candidate => candidate.matched_characters ?? 0)) }]
  })
  return { preferred: supports.length > 0 && supports.every(support => support.preferred),
    tier: supports.length ? Math.max(...supports.map(support => support.tier)) : 3,
    matched_characters: supports.length ? Math.min(...supports.map(support => support.matched_characters)) : 0 }
}

function temporalSample(packet: ManuscriptFramePacket, frames: readonly Frame[], count: number, tolerance: number): ManuscriptFramePacket {
  const eligible = frames.filter(frame => frame.image_available && frame.observation_source === 'model_authored_observation'
    && inRange(frame.time, packet.interval, tolerance))
  const interior = eligible.filter(frame => inRange(frame.time, packet.interval, 0))
  const center = (packet.interval.start_seconds + packet.interval.end_seconds) / 2
  const contextTargets = new Set(eligible.flatMap(frame => frame.reasons.flatMap(reason =>
    reason.startsWith('context_for:') ? [reason.slice('context_for:'.length)] : [])))
  const anchor = [...interior.length ? interior : eligible].sort((left, right) => {
    if (packet.origin === 'source_timeline') return Number(originalChange(right)) - Number(originalChange(left))
      || Math.abs(left.time - center) - Math.abs(right.time - center) || left.time - right.time
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
 * Select source-led and literal-line temporal samples without treating model-authored captions as facts.
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
      packet = { scene_id: scene.id, origin: 'draft_candidates', lines: [], sampling_lines: [], interval, ambiguous: false, images: [],
        eligible_cache_frames: 0, selection_basis: 'not_selected' }
      candidates.push(packet)
      byRange.set(key, packet)
    }
    if (!packet.lines.some(line => line.line === query.line && line.quote === query.quote)) {
      packet.lines.push({ line: query.line, quote: query.quote, kind: query.kind })
    }
    const selection = querySelection(query, interval, location)
    if (selection.preferred) packet.sampling_lines?.push({ line: query.line, quote: query.quote, kind: query.kind })
    if (packet.literal_selection === undefined || Number(selection.preferred) > Number(packet.literal_selection.preferred)
      || selection.preferred === packet.literal_selection.preferred && (selection.tier < packet.literal_selection.tier
        || selection.tier === packet.literal_selection.tier
          && selection.matched_characters > packet.literal_selection.matched_characters)) packet.literal_selection = selection
    packet.ambiguous ||= query.time_candidates.length > 1
  }
  const hasOriginalChange = (packet: ManuscriptFramePacket) => frames.some(frame => inRange(frame.time, packet.interval, 0)
    && originalChange(frame))
  const ranked = candidates.filter(packet => frames.some(frame => frame.image_available && frame.observation_source === 'model_authored_observation'
    && inRange(frame.time, packet.interval, location.window_seconds))).sort((left, right) =>
    Number(right.literal_selection?.preferred) - Number(left.literal_selection?.preferred)
    || (left.literal_selection?.tier ?? 3) - (right.literal_selection?.tier ?? 3)
    || (right.literal_selection?.matched_characters ?? 0) - (left.literal_selection?.matched_characters ?? 0)
    || Number(hasOriginalChange(right)) - Number(hasOriginalChange(left))
    || (left.interval.end_seconds - left.interval.start_seconds) - (right.interval.end_seconds - right.interval.start_seconds)
    || (left.lines[0]?.line ?? 0) - (right.lines[0]?.line ?? 0))
  const sourceCandidates = location.windows.filter(window => window.frames.some(frame => !excluded.has(frame.frame_id)
    && frame.image_available && frame.observation_source === 'model_authored_observation' && originalChange(frame)))
    .map((window): ManuscriptFramePacket => ({ scene_id: scene.id, origin: 'source_timeline', lines: [],
      interval: { start_seconds: window.start_seconds, end_seconds: window.end_seconds,
        relation: 'source_window_not_draft_alignment', segment_ids: window.speech_segment_ids }, ambiguous: false,
      images: [], eligible_cache_frames: 0, selection_basis: 'not_selected' }))
  const uncoveredChanges = (packet: ManuscriptFramePacket) => frames.filter(frame => originalChange(frame)
    && inRange(frame.time, packet.interval, 0) && !ranked.some(current => current.literal_selection?.preferred
      && inRange(frame.time, current.interval, 0))).length
  sourceCandidates.sort((left, right) => uncoveredChanges(right) - uncoveredChanges(left)
    || left.interval.start_seconds - right.interval.start_seconds)
  const source = sourceCandidates[0], current = ranked[0]
  const groups = count <= 0 ? [] : count === 1 ? [source ?? current].filter(packet => packet !== undefined)
    : [source, current].filter(packet => packet !== undefined)
  candidates.push(...sourceCandidates)
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
  const changes = frames.filter(originalChange)
  const eventNotes = [...new Map(timeline.windows.flatMap(window => window.event_notes)
    .map(event => [event.event_id, event])).values()]
  const speech = new Map((timeline.speech?.segments ?? []).map(segment => [segment.segment_id, segment]))
  const matchedIds = new Set(plans.flatMap(plan => plan.location.line_candidates.flatMap(line =>
    line.candidates.map(candidate => candidate.segment_id))))
  const emitted = new Set<string>()
  const selected = plans.flatMap(plan => plan.selected)
  const lineRefs = plans.flatMap(plan => plan.location.line_candidates.map(line => ({ scene_id: plan.scene.id,
    line: line.line, actual_quote: line.quote, candidate_segment_ids: [...new Set(line.candidates.map(candidate => candidate.segment_id))],
    literal_matches: line.candidates.map(candidate => ({ segment_id: candidate.segment_id, match: candidate.literal_match,
      matched_characters: candidate.matched_characters })),
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
    source_change_timeline: { origin: 'original_detector_changes_independent_of_draft_lines',
      meaning: 'sampling_anchors_not_complete_actions_or_story_scene_boundaries',
      total_anchors: changes.length, omitted_for_budget: Math.max(0, changes.length - input.indexRows),
      columns: ['frame_id', 'source_seconds', 'detector_reasons'],
      rows: changes.slice(0, input.indexRows).map(frame => [frame.frame_id, frame.time, frame.reasons]),
      interpretation_source: 'unverified_prior_model_observations',
      recorded_interpretations: changes.slice(0, input.indexRows).flatMap(frame => frame.observation === undefined ? [] : [{
        frame_id: frame.frame_id, source_seconds: frame.time, observation: frame.observation }]),
      event_notes: input.indexRows > 0 ? eventNotes : [], event_notes_omitted: input.indexRows > 0 ? 0 : eventNotes.length },
    draft_speech_lines: lineRefs,
    original_asr_scope: { source_segments: speech.size, matched_segment_ids: [...matchedIds],
      selected_source_window_segment_ids: [...new Set(selected.filter(packet => packet.origin === 'source_timeline')
        .flatMap(packet => packet.interval.segment_ids))],
      matching: 'actual_source_segment_ids_not_text', speaker_identity: 'unverified' },
    continuous_speech_candidates: (timeline.speech?.continuous_speech_candidates ?? [])
      .filter(candidate => candidate.segment_ids.some(id => matchedIds.has(id)))
      .map(candidate => ({ segment_ids: candidate.segment_ids, speaker_id: candidate.speaker_id,
        speaker_identity_unverified: true, gap_seconds: candidate.gap_seconds })),
    dialogue_line_relations: plans.flatMap(plan => plan.location.between_dialogue_lines.map(pair => ({ scene_id: plan.scene.id,
      previous_line: pair.previous_line, current_line: pair.current_line, relation: pair.relation,
      ambiguous_source_matches: pair.ambiguous_source_matches, shared_segment_ids: pair.shared_segment_ids }))),
    visual_candidates: plans.flatMap(plan => plan.candidates.map(packet => ({ scene_id: plan.scene.id,
      origin: packet.origin ?? 'draft_candidates', literal_selection: packet.literal_selection,
      draft_lines: packet.lines.map(line => line.line), time_candidate: packet.interval, ambiguous: packet.ambiguous,
      selected_for_images: plan.selected.some(candidate => packetIdentity(candidate) === packetIdentity(packet)) }))),
    selected_packets: selected.length,
    unselected_packets: plans.reduce((total, plan) => total + plan.candidates.length - plan.selected.length, 0),
    prior_model_captions: 'change_anchor_notes_unverified_full_notes_available_on_demand',
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
      scene_id: packet.scene_id, scene_sha256: plan?.scene.sha256, origin: packet.origin ?? 'draft_candidates',
      actual_current_lines: packet.origin === 'source_timeline' ? [] : packet.sampling_lines?.length ? packet.sampling_lines : packet.lines,
      retained_literal_line_candidates: packet.lines, literal_selection: packet.literal_selection,
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
