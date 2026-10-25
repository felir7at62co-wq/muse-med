/** Compact original-source packets keep saved manuscript lines beside temporal cache samples. */
import type { ContentBlock, ImageBlock } from '@deepseek-ai/dsh-llm'
import type { VideoSourceTimeline } from '@deepseek-ai/dsh-tool-video-inspect'
import type { ManuscriptScene } from './manuscript-scenes.ts'

/** Presentation identity; older saved receipts remain readable without suppressing this representation. */
export const MANUSCRIPT_VIDEO_PRESENTATION = 'source-and-line-temporal-packets-v7'
type Frame = VideoSourceTimeline['windows'][number]['frames'][number]
type Segment = NonNullable<VideoSourceTimeline['speech']>['segments'][number]
type EventNote = VideoSourceTimeline['windows'][number]['event_notes'][number]
interface TimeInterval { start_seconds: number; end_seconds: number }
interface TimeCandidate extends TimeInterval { relation: string; segment_ids: readonly string[] }

/** Current-document text hunks and source-local event identities supplied by the saved-manuscript reader. */
export interface PacketContext {
  document_sha256: string
  previous_status: 'available' | 'unavailable'
  previous_hunks?: readonly {
    basis: 'successful_native_mutation' | 'complete_read_source_difference'
    before: readonly { line: number; quote: string }[]
    after_lines: readonly number[]
    source_path?: string
    source_text_sha256?: string
  }[]
  excluded_event_ids?: ReadonlySet<string>
}

interface EventCandidate extends TimeInterval {
  event_id: string
  observation_digest: string
  evidence_current: boolean
  frame_ids: readonly string[]
  missing_local_frame_ids: string[]
  unreadable_frame_ids: string[]
  association: 'event_time_intersects_literal_candidate_only'
}

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
  visual_queries: readonly {
    line: number
    quote: string
    kind: string
    time_candidates: readonly TimeCandidate[]
    nearest_aligned_dialogue_lines?: { previous_line?: number; next_line?: number }
    skipped_unaligned_dialogue_lines?: readonly number[]
  }[]
  windows: VideoSourceTimeline['windows']
  window_seconds: number
}

/** One literal manuscript range and a bounded temporal image sample, never an action verdict. */
export interface ManuscriptFramePacket {
  scene_id: string
  origin?: 'draft_candidates' | 'source_timeline'
  lines: { line: number; quote: string; kind: string }[]
  sampling_lines?: { line: number; quote: string; kind: string }[]
  changed_visual_lines?: { line: number; quote: string; kind: string }[]
  literal_selection?: { preferred: boolean; tier: number; matched_characters: number }
  changed_literal_selection?: { preferred: boolean; tier: number; matched_characters: number }
  interval: TimeCandidate
  sampling_interval: TimeInterval
  ambiguous: boolean
  selection_anchor?: { frame_id: string; time: number }
  images: { frame_id: string; time: number; role: 'before' | 'anchor' | 'after' }[]
  eligible_cache_frames: number
  selection_basis: string
  event_candidates?: EventCandidate[]
  event_selection?: {
    event_id: string
    referenced_frame_ids: string[]
    context_frame_ids: string[]
    sampling_interval: TimeInterval
    association: 'event_frame_refs_not_asr_or_verified_action_alignment'
  }
}

/** Saved-scene candidates with the actual temporal samples selected for this refresh. */
export interface ManuscriptPacketPlan {
  scene: ManuscriptScene
  location: ManuscriptSourceLocation
  changed_visual_lines: { line: number; quote: string; kind: string }[]
  candidates: ManuscriptFramePacket[]
  selected: ManuscriptFramePacket[]
  selected_event_ids: string[]
  context?: PacketContext
}

function inRange(time: number, range: TimeInterval, tolerance: number): boolean {
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

function sourceEvents(windows: VideoSourceTimeline['windows']): EventNote[] {
  return [...new Map(windows.flatMap(window => window.event_notes).map(event => [event.event_id, event])).values()]
}

function intersects(left: TimeInterval, right: TimeInterval): boolean {
  return left.start_seconds <= right.end_seconds && left.end_seconds >= right.start_seconds
}

function readable(frame: Frame): boolean {
  return frame.image_available && frame.observation !== undefined
}

function eventCandidates(interval: TimeInterval, events: readonly EventNote[], frames: readonly Frame[]): EventCandidate[] {
  const byId = new Map(frames.map(frame => [frame.frame_id, frame]))
  return events.filter(event => intersects(event, interval)).map(event => ({
    event_id: event.event_id, observation_digest: event.observation_digest, evidence_current: event.evidence_current,
    start_seconds: event.start_seconds, end_seconds: event.end_seconds, frame_ids: event.frame_ids,
    missing_local_frame_ids: event.frame_ids.filter(id => !byId.has(id)),
    unreadable_frame_ids: event.frame_ids.filter((id) => {
      const frame = byId.get(id)
      return frame !== undefined && !readable(frame)
    }),
    association: 'event_time_intersects_literal_candidate_only',
  }))
}

function eventSample(packet: ManuscriptFramePacket, frames: readonly Frame[], count: number,
  excluded: ReadonlySet<string>): ManuscriptFramePacket | undefined {
  if (count <= 0) return undefined
  const available = frames.filter(readable)
  for (const event of packet.event_candidates ?? []) {
    if (!event.evidence_current || excluded.has(event.event_id)) continue
    const named = available.filter(frame => event.frame_ids.includes(frame.frame_id))
    const first = named[0]
    if (first === undefined) continue
    const context = available.filter(frame => !event.frame_ids.includes(frame.frame_id)
      && named.some(anchor => frame.reasons.includes(`context_for:${anchor.frame_id}`)))
    const center = (event.start_seconds + event.end_seconds) / 2
    const nearest = (values: readonly Frame[]) => [...values].sort((left, right) =>
      Math.abs(left.time - center) - Math.abs(right.time - center) || left.time - right.time)[0]
    const last = named.at(-1) ?? first
    let selected: [Frame, ...Frame[]] = count === 1 ? [nearest(named) ?? first] : named.length > 1 ? [first, last] : [first]
    if (count > selected.length) {
      const extra = nearest(named.filter(frame => !selected.includes(frame))) ?? nearest(context)
      if (extra !== undefined) selected.push(extra)
    }
    selected = selected.sort((left, right) => left.time - right.time)
    const interval = { start_seconds: selected[0].time, end_seconds: (selected.at(-1) ?? selected[0]).time }
    return { ...packet, sampling_interval: interval,
      eligible_cache_frames: new Set([...named, ...context].map(frame => frame.frame_id)).size,
      images: selected.map((frame, index) => ({ frame_id: frame.frame_id, time: frame.time,
        role: selected.length === 1 ? 'anchor' : index === 0 ? 'before' : index === selected.length - 1 ? 'after' : 'anchor' })),
      event_selection: { event_id: event.event_id,
        referenced_frame_ids: selected.filter(frame => event.frame_ids.includes(frame.frame_id)).map(frame => frame.frame_id),
        context_frame_ids: selected.filter(frame => !event.frame_ids.includes(frame.frame_id)).map(frame => frame.frame_id),
        sampling_interval: interval, association: 'event_frame_refs_not_asr_or_verified_action_alignment' },
      selection_basis: 'current_event_frame_refs_and_recorded_context_not_semantic_alignment' }
  }
  return undefined
}

function samplingInterval(interval: TimeCandidate, windowSeconds: number): TimeInterval {
  if (interval.relation === 'before_speech_candidate') return {
    start_seconds: Math.max(interval.start_seconds, interval.end_seconds - windowSeconds), end_seconds: interval.end_seconds,
  }
  if (interval.relation === 'after_speech_candidate') return {
    start_seconds: interval.start_seconds, end_seconds: Math.min(interval.end_seconds, interval.start_seconds + windowSeconds),
  }
  return { start_seconds: Math.max(0, interval.start_seconds - windowSeconds), end_seconds: interval.end_seconds + windowSeconds }
}

function samplingAnchorInterval(packet: ManuscriptFramePacket): TimeInterval {
  return packet.interval.relation === 'before_speech_candidate' || packet.interval.relation === 'after_speech_candidate'
    ? packet.sampling_interval : packet.interval
}

function literalTier(value: string): number {
  return value === 'exact' ? 0 : value === 'source_contains_draft' ? 1 : value === 'draft_contains_source' ? 2 : 3
}

function compareLiteral(left: ManuscriptFramePacket['literal_selection'], right: ManuscriptFramePacket['literal_selection']): number {
  return Number(right?.preferred ?? false) - Number(left?.preferred ?? false)
    || (left?.tier ?? 3) - (right?.tier ?? 3) || (right?.matched_characters ?? 0) - (left?.matched_characters ?? 0)
}

function querySelection(query: ManuscriptSourceLocation['visual_queries'][number], interval: TimeCandidate,
  location: ManuscriptSourceLocation): NonNullable<ManuscriptFramePacket['literal_selection']> {
  const own = location.line_candidates.find(line => line.line === query.line)
  const support = query.nearest_aligned_dialogue_lines
  const relevant = own === undefined ? [
    { line: support === undefined ? location.line_candidates.findLast(line => line.line < query.line)
      : location.line_candidates.find(line => line.line === support.previous_line), endpoint: 'previous' },
    { line: support === undefined ? location.line_candidates.find(line => line.line > query.line)
      : location.line_candidates.find(line => line.line === support.next_line), endpoint: 'next' },
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

function temporalSample(packet: ManuscriptFramePacket, frames: readonly Frame[], count: number,
  excludedEvents: ReadonlySet<string>): ManuscriptFramePacket {
  const event = eventSample(packet, frames, count, excludedEvents)
  if (event !== undefined) return event
  const eligible = frames.filter(frame => frame.image_available && frame.observation_source === 'model_authored_observation'
    && inRange(frame.time, packet.sampling_interval, 0))
  const anchorInterval = samplingAnchorInterval(packet)
  const interior = eligible.filter(frame => inRange(frame.time, anchorInterval, 0))
  const center = (anchorInterval.start_seconds + anchorInterval.end_seconds) / 2
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

function changedPacketGroups(ranked: readonly ManuscriptFramePacket[], count: number): ManuscriptFramePacket[] {
  const groups: ManuscriptFramePacket[] = [], representedLines = new Set<number>(), representedRanges = new Set<string>()
  const rangeIdentity = (packet: ManuscriptFramePacket) => JSON.stringify([packet.interval.start_seconds, packet.interval.end_seconds])
  const representedCandidates = (packet: ManuscriptFramePacket) => {
    const preferred = packet.changed_visual_lines
      ?.filter(line => packet.sampling_lines?.some(candidate => candidate.line === line.line)) ?? []
    return preferred.length > 0 ? preferred : packet.changed_visual_lines ?? []
  }
  const changed = ranked.filter(packet => packet.changed_visual_lines?.length)
  while (groups.length < Math.ceil(count / 2)) {
    const next = changed.filter(packet => !representedRanges.has(rangeIdentity(packet))).sort((left, right) => {
      const newLines = (packet: ManuscriptFramePacket) => representedCandidates(packet)
        .filter(line => !representedLines.has(line.line)).length
      return Number(newLines(right) > 0) - Number(newLines(left) > 0)
        || compareLiteral(left.changed_literal_selection, right.changed_literal_selection) || ranked.indexOf(left) - ranked.indexOf(right)
    })[0]
    if (next === undefined) break
    groups.push(next)
    representedRanges.add(rangeIdentity(next))
    for (const line of representedCandidates(next)) representedLines.add(line.line)
  }
  return groups
}

/**
 * Select source-led and literal-line temporal samples without treating model-authored captions as facts.
 * @param scene - Exact saved manuscript scene and its actual line numbers.
 * @param location - All literal ASR candidates, including repeated and shared original segments.
 * @param count - Remaining image allowance, resolved from the shared Host configuration.
 * @param excluded - Already returned cache identities within this review revision.
 * @param changedLines - Actual current-document changed line numbers, bound to that document SHA by the caller.
 * @param context - Optional current-document text hunks and event identities already presented for this source.
 * @returns Complete candidate ranges and bounded packets, preserving initial samples and filling unused allowance from other ranges.
 */
export function planManuscriptVideoPackets(scene: ManuscriptScene, location: ManuscriptSourceLocation, count: number,
  excluded: ReadonlySet<string>, changedLines?: ReadonlySet<number>, context?: PacketContext): ManuscriptPacketPlan {
  const allFrames = sourceFrames(location.windows), frames = allFrames.filter(frame => !excluded.has(frame.frame_id))
  const events = sourceEvents(location.windows), selectedEvents = new Set(context?.excluded_event_ids)
  const queries = location.visual_queries.some(query => query.time_candidates.length > 0) ? location.visual_queries
    : location.line_candidates.map(line => ({ ...line, kind: 'dialogue_line', time_candidates: line.candidates.map(candidate => ({
      start_seconds: candidate.start_seconds, end_seconds: candidate.end_seconds, relation: 'within_speech_candidate',
      segment_ids: [candidate.segment_id] })) }))
  const changedVisualLines = location.visual_queries.filter(query => changedLines?.has(query.line)
    && (query.kind === 'action_line' || query.kind === 'dialogue_parenthetical'))
    .map(({ line, quote, kind }) => ({ line, quote, kind }))
  const candidates: ManuscriptFramePacket[] = [], byRange = new Map<string, ManuscriptFramePacket>()
  for (const query of queries) for (const interval of query.time_candidates) {
    const key = JSON.stringify([interval.start_seconds, interval.end_seconds, interval.relation, [...interval.segment_ids].sort()])
    let packet = byRange.get(key)
    if (packet === undefined) {
      packet = { scene_id: scene.id, origin: 'draft_candidates', lines: [], sampling_lines: [], changed_visual_lines: [],
        interval, sampling_interval: samplingInterval(interval, location.window_seconds),
        ambiguous: false, images: [], eligible_cache_frames: 0, selection_basis: 'not_selected' }
      candidates.push(packet)
      byRange.set(key, packet)
    }
    if (!packet.lines.some(line => line.line === query.line && line.quote === query.quote)) {
      packet.lines.push({ line: query.line, quote: query.quote, kind: query.kind })
      if (changedVisualLines.some(line => line.line === query.line)) {
        packet.changed_visual_lines?.push({ line: query.line, quote: query.quote, kind: query.kind })
      }
    }
    const selection = querySelection(query, interval, location)
    if (selection.preferred) packet.sampling_lines?.push({ line: query.line, quote: query.quote, kind: query.kind })
    if (packet.literal_selection === undefined || compareLiteral(selection, packet.literal_selection) < 0) {
      packet.literal_selection = selection
    }
    if (changedVisualLines.some(line => line.line === query.line)
      && (packet.changed_literal_selection === undefined || compareLiteral(selection, packet.changed_literal_selection) < 0)) {
      packet.changed_literal_selection = selection
    }
    packet.ambiguous ||= query.time_candidates.length > 1
  }
  const hasOriginalChange = (packet: ManuscriptFramePacket) => frames.some(frame => inRange(frame.time, samplingAnchorInterval(packet), 0)
    && originalChange(frame))
  for (const packet of candidates) {
    packet.event_candidates = eventCandidates(packet.interval, events, allFrames)
    packet.eligible_cache_frames = new Set(frames.filter(frame => frame.image_available
      && frame.observation_source === 'model_authored_observation' && inRange(frame.time, packet.sampling_interval, 0)
      || readable(frame) && packet.event_candidates?.some(event => event.evidence_current
        && !selectedEvents.has(event.event_id) && event.frame_ids.includes(frame.frame_id))).map(frame => frame.frame_id)).size
  }
  const ranked = candidates.filter(packet => packet.eligible_cache_frames > 0).sort((left, right) =>
    compareLiteral(left.literal_selection, right.literal_selection)
    || Number(hasOriginalChange(right)) - Number(hasOriginalChange(left))
    || (left.interval.end_seconds - left.interval.start_seconds) - (right.interval.end_seconds - right.interval.start_seconds)
    || (left.lines[0]?.line ?? 0) - (right.lines[0]?.line ?? 0))
  const sourceCandidates = location.windows.filter(window => window.frames.some(frame => !excluded.has(frame.frame_id)
    && frame.image_available && frame.observation_source === 'model_authored_observation' && originalChange(frame)))
    .map((window): ManuscriptFramePacket => ({ scene_id: scene.id, origin: 'source_timeline', lines: [],
      interval: { start_seconds: window.start_seconds, end_seconds: window.end_seconds,
        relation: 'source_window_not_draft_alignment', segment_ids: window.speech_segment_ids }, ambiguous: false,
      sampling_interval: { start_seconds: Math.max(0, window.start_seconds - location.window_seconds),
        end_seconds: window.end_seconds + location.window_seconds },
      images: [], eligible_cache_frames: 0, selection_basis: 'not_selected' }))
  const uncoveredChanges = (packet: ManuscriptFramePacket) => frames.filter(frame => originalChange(frame)
    && inRange(frame.time, packet.interval, 0) && !ranked.some(current => current.literal_selection?.preferred
      && inRange(frame.time, current.interval, 0))).length
  sourceCandidates.sort((left, right) => uncoveredChanges(right) - uncoveredChanges(left)
    || left.interval.start_seconds - right.interval.start_seconds)
  const source = sourceCandidates[0], current = ranked[0], changedGroups = count > 0 ? changedPacketGroups(ranked, count) : []
  const groups = changedGroups.length > 0 ? changedGroups : count <= 0 ? []
    : count === 1 ? [source ?? current].filter(packet => packet !== undefined)
      : [source, current].filter(packet => packet !== undefined)
  candidates.push(...sourceCandidates)
  let remaining = count
  const selectedFrames = new Set<string>()
  const selected = groups.map((packet, index) => {
    const allowance = changedGroups.length > 0 ? Math.ceil(remaining / (groups.length - index))
      : Math.floor(remaining / (groups.length - index))
    const sample = temporalSample(packet, frames.filter(frame => !selectedFrames.has(frame.frame_id)),
      Math.min(3, allowance), selectedEvents)
    for (const frame of sample.images) selectedFrames.add(frame.frame_id)
    if (sample.event_selection !== undefined) selectedEvents.add(sample.event_selection.event_id)
    remaining -= sample.images.length
    return sample
  })
  const rangeIdentity = (packet: ManuscriptFramePacket) => JSON.stringify([packet.interval.start_seconds, packet.interval.end_seconds])
  const attemptedRanges = new Set(groups.map(rangeIdentity))
  const refill = changedGroups.length > 0
    ? [...ranked.filter(packet => packet.changed_visual_lines?.length), ...ranked, ...sourceCandidates] : [...ranked, ...sourceCandidates]
  for (const packet of refill) {
    if (remaining <= 0) break
    const range = rangeIdentity(packet)
    if (attemptedRanges.has(range)) continue
    attemptedRanges.add(range)
    const availableFrames = frames.filter(frame => !selectedFrames.has(frame.frame_id))
    const sample = temporalSample(packet, availableFrames, Math.min(3, remaining), selectedEvents)
    if (sample.images.length === 0) continue
    for (const frame of sample.images) selectedFrames.add(frame.frame_id)
    if (sample.event_selection !== undefined) selectedEvents.add(sample.event_selection.event_id)
    remaining -= sample.images.length
    selected.push(sample)
  }
  return { scene, location, changed_visual_lines: changedVisualLines, candidates, selected,
    selected_event_ids: selected.flatMap(packet => packet.event_selection === undefined ? [] : [packet.event_selection.event_id]),
    ...context === undefined ? {} : { context } }
}

/**
 * Sample the cached source ending independently of manuscript lines or an inferred ending hook.
 * @param scene - Saved scene receiving this source-only packet; no line alignment is claimed.
 * @param timeline - Current source timeline, original ASR and cached images with provider-readable observations.
 * @param count - Remaining shared image allowance; at most two distinct images are selected.
 * @param excluded - Cache identities already returned within this source revision.
 * @returns Source-tail middle/latest samples, or no packet when no new eligible cache images remain.
 */
export function planManuscriptSourceTail(scene: ManuscriptScene, timeline: VideoSourceTimeline, count: number,
  excluded: ReadonlySet<string>): ManuscriptFramePacket | undefined {
  if (count <= 0) return undefined
  const end = timeline.source.duration_seconds
  const speech = timeline.speech?.segments ?? [], lastSpeechEnd = speech.length > 0
    ? Math.max(...speech.map(segment => segment.end_seconds)) : undefined
  const frames = sourceFrames(timeline.windows).filter(frame => frame.image_available)
  const afterSpeech = lastSpeechEnd === undefined ? [] : frames.filter(frame => frame.time > lastSpeechEnd && frame.time <= end)
  const interval = { start_seconds: afterSpeech.length > 0 && lastSpeechEnd !== undefined ? lastSpeechEnd
    : Math.max(0, end - timeline.scope.window_seconds), end_seconds: end }
  const available = (afterSpeech.length > 0 ? afterSpeech : frames.filter(frame => inRange(frame.time, interval, 0)))
    .filter(frame => frame.observation !== undefined && !excluded.has(frame.frame_id))
  const last = available.at(-1)
  if (last === undefined) return undefined
  const center = (interval.start_seconds + interval.end_seconds) / 2
  const middle = available.filter(frame => frame.frame_id !== last.frame_id).sort((left, right) =>
    Math.abs(left.time - center) - Math.abs(right.time - center) || left.time - right.time
    || left.frame_id.localeCompare(right.frame_id))[0]
  const selected = count < 2 || middle === undefined ? [{ ...last, role: 'after' as const }]
    : [{ ...middle, role: 'anchor' as const }, { ...last, role: 'after' as const }]
  return { scene_id: scene.id, origin: 'source_timeline', lines: [],
    interval: { ...interval, relation: 'source_tail_not_aligned_to_draft_ending', segment_ids: [] },
    sampling_interval: interval, ambiguous: false,
    images: selected.map(frame => ({ frame_id: frame.frame_id, time: frame.time, role: frame.role })),
    eligible_cache_frames: available.length,
    selection_basis: afterSpeech.length > 0 ? 'cached_middle_latest_after_final_asr_end_not_draft_alignment'
      : lastSpeechEnd === undefined ? 'rolling_source_tail_without_asr_not_draft_alignment'
        : 'rolling_source_tail_without_post_asr_cache_not_draft_alignment' }
}

function originalSpeech(segment: Segment, plans: readonly ManuscriptPacketPlan[]) {
  return { segment_id: segment.segment_id, start_seconds: segment.start_seconds, end_seconds: segment.end_seconds,
    text: segment.text, ...segment.speaker_id === undefined ? {} : { speaker_id: segment.speaker_id },
    speaker_identity_unverified: true, draft_line_refs: plans.flatMap(plan => plan.location.line_candidates.flatMap(line =>
      line.candidates.some(candidate => candidate.segment_id === segment.segment_id)
        ? [{ scene_id: plan.scene.id, line: line.line }] : [])) }
}

function pairedEvents(timeline: VideoSourceTimeline, plans: readonly ManuscriptPacketPlan[], actualFrameIds: ReadonlySet<string>) {
  return sourceEvents(timeline.windows).flatMap((event) => {
    const matchingPlans = plans.filter(plan => plan.selected.some(packet => packet.images.some(frame =>
      actualFrameIds.has(frame.frame_id) && event.frame_ids.includes(frame.frame_id))))
    if (matchingPlans.length === 0) return []
    const candidates = matchingPlans.flatMap(plan => plan.location.visual_queries
      .filter(query => query.time_candidates.some(range => intersects(range, event)))
      .map(({ line, quote, kind }) => ({ scene_id: plan.scene.id, line, quote, kind })))
    const lines = [...new Map(candidates.map(line => [`${line.scene_id}:${line.line}`, line])).values()]
    return [{ event, candidate_current_lines: lines }]
  })
}

/**
 * Identify source events whose referenced images were returned, with or without literal scene-time candidates.
 * @param timeline - Verified current source and optional prior model-authored events.
 * @param plans - Current scene packets, including independent source-tail samples.
 * @param actualFrameIds - Source-local identities with actual returned image blocks.
 * @returns Event ids for notice-local explanation deduplication, without asserting interpretation or coverage.
 */
export function manuscriptPacketEventIds(timeline: VideoSourceTimeline, plans: readonly ManuscriptPacketPlan[],
  actualFrameIds: ReadonlySet<string>): string[] {
  return pairedEvents(timeline, plans, actualFrameIds).map(entry => entry.event.event_id)
}

function candidateLines(plan: ManuscriptPacketPlan | undefined, packet: ManuscriptFramePacket, frames: readonly Frame[],
  events: readonly EventNote[]) {
  if (plan === undefined) return []
  const imageIds = new Set(packet.images.map(frame => frame.frame_id))
  const times = frames.filter(frame => imageIds.has(frame.frame_id)).map(frame => frame.time)
  const linked = events.filter(event => event.frame_ids.some(id => imageIds.has(id)))
  return plan.location.visual_queries.filter(query => query.time_candidates.some(range =>
    times.some(time => inRange(time, range, 0)) || linked.some(event => intersects(range, event))))
    .map(({ line, quote, kind }) => ({ line, quote, kind }))
}

function previousText(plan: ManuscriptPacketPlan | undefined, lines: readonly { line: number }[]) {
  const context = plan?.context
  const hunks = context?.previous_hunks?.filter(hunk => hunk.after_lines.some(line => lines.some(current => current.line === line))) ?? []
  return { status: context === undefined ? 'context_not_supplied' : context.previous_status === 'unavailable'
    ? 'previous_context_unavailable' : hunks.length ? 'same_text_diff_hunk_candidates' : 'no_corresponding_hunk_supplied',
  context_document_sha256: context?.document_sha256, mapping: 'text_diff_hunk_not_semantic_line_pair', adoption: 'not_asserted',
  hunks: hunks.map(hunk => ({ ...hunk, source_role: hunk.basis === 'complete_read_source_difference'
    ? 'read_text_comparison_candidate_not_approved_baseline' : 'previous_native_saved_text_not_approved_baseline' })) }
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
  const eventNotes = sourceEvents(timeline.windows)
  const selected = plans.flatMap(plan => plan.selected)
  const actualFrameIds = new Set(selected.flatMap(packet => packet.images
    .filter(frame => images.has(frame.frame_id)).map(frame => frame.frame_id)))
  const paired = pairedEvents(timeline, plans, actualFrameIds), pairedIds = new Set(paired.map(entry => entry.event.event_id))
  const priorEvents = new Set(plans.flatMap(plan => [...(plan.context?.excluded_event_ids ?? [])]))
  const speech = new Map((timeline.speech?.segments ?? []).map(segment => [segment.segment_id, segment]))
  const matchedIds = new Set(plans.flatMap(plan => plan.location.line_candidates.flatMap(line =>
    line.candidates.map(candidate => candidate.segment_id))))
  const emitted = new Set<string>()
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
      recorded_interpretations: changes.slice(0, input.indexRows).flatMap(frame => frame.observation === undefined
        || actualFrameIds.has(frame.frame_id) ? [] : [{
          frame_id: frame.frame_id, source_seconds: frame.time, observation: frame.observation }]),
      selected_frame_observation_refs: frames.filter(frame => actualFrameIds.has(frame.frame_id)).map(frame => qualified(frame.frame_id)),
      event_notes: input.indexRows > 0 ? eventNotes.map(event => !pairedIds.has(event.event_id) && !priorEvents.has(event.event_id)
        ? event : {
          event_id: event.event_id, start_seconds: event.start_seconds, end_seconds: event.end_seconds,
          frame_ids: event.frame_ids, evidence_current: event.evidence_current,
          interpretation: priorEvents.has(event.event_id) ? 'already_presented_in_this_notice' : 'returned_after_cached_images' }) : [],
      event_notes_omitted: input.indexRows > 0 ? 0 : eventNotes.length },
    draft_speech_lines: lineRefs,
    visual_query_anchor_skips: plans.flatMap(plan => plan.location.visual_queries
      .filter(query => query.skipped_unaligned_dialogue_lines?.length)
      .map(query => ({ scene_id: plan.scene.id, line: query.line,
        nearest_aligned_dialogue_lines: query.nearest_aligned_dialogue_lines,
        skipped_unaligned_dialogue_lines: query.skipped_unaligned_dialogue_lines,
        scope: 'nearest_literal_dialogue_candidates_not_semantic_alignment' }))),
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
      changed_visual_line_candidates: packet.changed_visual_lines, changed_literal_selection: packet.changed_literal_selection,
      draft_lines: packet.lines.map(line => line.line), time_candidate: packet.interval, sampling_interval: packet.sampling_interval,
      event_candidates: packet.event_candidates,
      ambiguous: packet.ambiguous,
      selected_for_images: plan.selected.some(candidate => packetIdentity(candidate) === packetIdentity(packet)) }))),
    changed_visual_line_sampling: plans.flatMap(plan => plan.changed_visual_lines.map((line) => {
      const candidates = plan.candidates.filter(packet => packet.changed_visual_lines?.some(candidate => candidate.line === line.line))
      const samples = plan.selected.filter(packet => packet.changed_visual_lines?.some(candidate => candidate.line === line.line))
      return { scene_id: plan.scene.id, actual_current_line: line, candidate_ranges: candidates.length,
        selected_ranges: samples.length,
        requested_frame_ids: samples.flatMap(packet => packet.images.map(frame => qualified(frame.frame_id))),
        returned_frame_ids: samples.flatMap(packet => packet.images
          .filter(frame => images.has(frame.frame_id)).map(frame => qualified(frame.frame_id))),
        sampling_status: samples.some(packet => packet.images.length > 0) ? 'temporal_samples_not_action_verification'
          : samples.length > 0 ? 'no_distinct_cached_sample_after_shared_selection' : candidates.length === 0
            ? 'no_literal_time_candidate' : candidates.every(packet => packet.eligible_cache_frames === 0)
              ? 'no_available_cached_sample' : 'not_selected_within_shared_image_allowance' }
    })),
    selected_packets: selected.length,
    unselected_packets: plans.reduce((total, plan) => total + plan.candidates.length - plan.selected.length, 0),
    prior_model_captions: 'change_anchor_notes_unverified_full_notes_available_on_demand',
    scope: 'bounded_temporal_samples_not_all_actions_or_lines_verified',
  } }) }]
  for (const packet of selected) {
    const plan = plans.find(candidate => candidate.scene.id === packet.scene_id)
    const candidates = candidateLines(plan, packet, frames, eventNotes)
    const currentLines = packet.origin === 'source_timeline' ? [] : packet.sampling_lines?.length ? packet.sampling_lines : packet.lines
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
      actual_current_lines: currentLines,
      candidate_current_lines: candidates, candidate_current_lines_scope: 'temporal_candidates_not_verified_event_alignment',
      previous_text: previousText(plan, [...currentLines, ...candidates]),
      retained_literal_line_candidates: packet.lines, literal_selection: packet.literal_selection,
      changed_visual_line_candidates: packet.changed_visual_lines, changed_literal_selection: packet.changed_literal_selection,
      time_candidate: packet.interval, sampling_interval: packet.sampling_interval, source_time_ambiguous: packet.ambiguous,
      original_asr_first_occurrences: originals, asr_segment_refs: ids,
      selection_anchor: packet.selection_anchor, temporal_roles: 'source_time_only_not_verified_event_phases',
      selection_anchor_returned: packet.images.some(frame => frame.frame_id === packet.selection_anchor?.frame_id
        && images.has(frame.frame_id)),
      selection_basis: packet.selection_basis, eligible_cached_frames: packet.eligible_cache_frames,
      event_candidates: packet.event_candidates, event_selection: packet.event_selection,
      event_refs: paired.filter(entry => entry.event.frame_ids.some(id => packet.images.some(frame => frame.frame_id === id)))
        .map(entry => ({ event_id: entry.event.event_id, frame_ids: entry.event.frame_ids,
          evidence_current: entry.event.evidence_current, interpretation_source: 'prior_model_authored_unverified' })),
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
  content.push({ type: 'text', text: JSON.stringify({ manuscript_prior_frame_observations: {
    review_id: source.review_id, source_version: source.source_version, document_sha256: input.documentSha256,
    interpretation_source: 'prior_model_authored_unverified', meaning: 'recorded_observations_not_visual_truth_or_coverage',
    frames: frames.filter(frame => actualFrameIds.has(frame.frame_id)).map(frame => ({
      frame_id: qualified(frame.frame_id), time: frame.time,
      status: frame.observation === undefined ? 'not_recorded' : 'recorded', observation: frame.observation })),
  } }) })
  content.push({ type: 'text', text: JSON.stringify({ manuscript_prior_event_interpretations: {
    review_id: source.review_id, source_version: source.source_version, document_sha256: input.documentSha256,
    interpretation_source: 'prior_model_authored_unverified', association: 'event_frame_refs_and_literal_time_overlap_not_semantic_alignment',
    events: paired.filter(entry => !priorEvents.has(entry.event.event_id)).map(entry => ({ ...entry,
      returned_frame_ids: entry.event.frame_ids.filter(id => actualFrameIds.has(id)).map(qualified) })),
    already_presented_event_refs: paired.filter(entry => priorEvents.has(entry.event.event_id)).map(entry => entry.event.event_id),
  } }) })
  content.push({ type: 'text', text: JSON.stringify({ manuscript_source_speech: {
    review_id: source.review_id, source_version: source.source_version,
    original_asr_remaining: [...matchedIds].flatMap((id) => {
      const segment = speech.get(id)
      return segment === undefined || emitted.has(id) ? [] : [originalSpeech(segment, plans)]
    }), unavailable_segment_ids: [...matchedIds].filter(id => !speech.has(id)),
  } }) })
  return content
}
