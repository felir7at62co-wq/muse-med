/** Version-bound local source materials for saved episode drafts; no semantic verdict or delivery control. */
import { realpath, stat } from 'node:fs/promises'
import { dirname, relative, resolve, sep } from 'node:path'
import { diffLines } from 'diff'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock, ImageBlock, Message, MessageId, ToolCallBlock } from '@deepseek-ai/dsh-llm'
import { readVideoSourceTimeline, videoReviewSummaries, type VideoReviewSummary, type VideoSourceTimeline } from '@deepseek-ai/dsh-tool-video-inspect'
import { z } from 'zod'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { Config } from './manuscript-revisions.ts'
import { isManuscript, readManuscript } from './manuscript-document.ts'
import { MANUSCRIPT_PREAMBLE_EPISODE, manuscriptScenes, manuscriptTextHash, type ManuscriptScene } from './manuscript-scenes.ts'
import { manuscriptEndingCue, manuscriptFormatReferenceText, manuscriptPresentationEvidence } from './manuscript-presentation.ts'
import { manuscriptDeliveryIntent } from './manuscript-task-intent.ts'
import { manuscriptReadText, manuscriptTextReadSnapshots, manuscriptVideoReadCandidates, manuscriptVideoReviewReader } from './manuscript-video-reads.ts'
import { loggedManuscriptVideoReceipts, manuscriptVideoReceiptOf, type ManuscriptVideoReceipt } from './manuscript-video-receipts.ts'
import { MANUSCRIPT_VIDEO_PRESENTATION, manuscriptPacketEventIds, manuscriptVideoPacketContent,
  planManuscriptSourceTail, planManuscriptVideoPackets, type ManuscriptPacketPlan, type PacketContext } from './manuscript-video-packets.ts'

const callArguments = z.object({ file_path: z.string().optional(), draft_path: z.string().optional(),
  review_id: z.string().optional(), method: z.string().optional() })
type CallArguments = z.infer<typeof callArguments>
type DeclaredOutputs = ReturnType<typeof manuscriptDeclaredOutputs>
interface MessageMaterialCache {
  message: Message
  declarations?: DeclaredOutputs
  receipts?: Receipt[]
}
interface MaterialCache {
  messages: Map<string, MessageMaterialCache>
  calls: Map<string, { block: ToolCallBlock; args: CallArguments | undefined }>
}
type Receipt = ManuscriptVideoReceipt & { offloaded_frames?: string[] }
interface SavedMutation {
  sha256: string
  baselineText: string | null
  returned: boolean
  lines: Set<number>
  basis: 'successful_native_mutation' | 'new_saved_document'
}

function parsedJson(text: string): unknown {
  try { return JSON.parse(text) }
  catch (error) {
    if (error instanceof SyntaxError) return undefined
    throw error
  }
}

function readArguments(block: ToolCallBlock, cache: MaterialCache): CallArguments | undefined {
  const old = cache.calls.get(block.id)
  if (old?.block === block) return old.args
  const parsed = callArguments.safeParse(parsedJson(block.arguments)), args = parsed.success ? parsed.data : undefined
  cache.calls.set(block.id, { block, args })
  return args
}

function cachedMessage(message: Message, cache: MaterialCache): MessageMaterialCache {
  const old = cache.messages.get(message.id)
  if (old?.message === message) return old
  const current = { message }
  cache.messages.set(message.id, current)
  return current
}

function declaredOutputs(message: Message, cwd: string, cache: MaterialCache): DeclaredOutputs {
  const entry = cachedMessage(message, cache)
  entry.declarations ??= manuscriptDeclaredOutputs([message], cwd)
  return entry.declarations
}

function registeredPaths(messages: readonly Message[], cwd: string, cache: MaterialCache) {
  const calls = new Map<string, ToolCallBlock>(), paths = new Set<string>()
  for (const message of messages) {
    if (message.role === 'assistant') for (const block of message.content) {
      if (block.type === 'tool-call') calls.set(block.id, block)
    }
    if (message.role !== 'tool' || message.isError) continue
    const call = calls.get(message.toolCallId)
    if (!call || !['write', 'edit', 'video_inspect'].includes(call.name)) continue
    const args = readArguments(call, cache)
    if (args === undefined) continue
    const selected = call.name === 'video_inspect' ? args.draft_path === undefined ? [] : [args.draft_path]
      : args.file_path === undefined ? [] : [args.file_path]
    for (const path of selected) if (isManuscript(path)) paths.add(resolve(cwd, path))
  }
  return [...paths]
}

const offloadDiagnosticSchema = z.object({ manuscript_video_image_delivery: z.object({ offloaded_frames: z.array(z.string()) }) })

/** @param text - One logged notice text block. @returns Frame labels named by an offload diagnostic, otherwise none. */
function offloadDiagnosticFrames(text: string): string[] {
  if (!text.startsWith('{"manuscript_video_image_delivery":')) return []
  const parsed = offloadDiagnosticSchema.safeParse(parsedJson(text))
  return parsed.success ? parsed.data.manuscript_video_image_delivery.offloaded_frames : []
}

function receipts(messages: readonly Message[], cache: MaterialCache): Receipt[] {
  return messages.flatMap(message => message.role !== 'user' || message.source.kind !== 'muse-manuscript' ? []
    : cachedMessage(message, cache).receipts ??= message.content.flatMap((block) => {
      const receipt = block.type === 'text' ? manuscriptVideoReceiptOf(block.text) : undefined
      if (receipt === undefined) return []
      const offloaded = new Set<string>()
      let label: string | undefined
      for (const part of message.content) {
        if (part.type === 'text') label = /^VIDEO_FRAME (\S+) /u.exec(part.text)?.[1]
        if (part.type === 'image' && part.offloaded && label) offloaded.add(label)
      }
      return [{ ...receipt, ...offloaded.size ? { offloaded_frames: [...offloaded] } : {} }]
    }))
}

function videoTaskSourcePaths(messages: readonly Message[], cwd: string, boundary: number, cache: MaterialCache,
  sources: readonly VideoReviewSummary[]) {
  const firstUser = messages.findIndex(message => message.role === 'user' && message.source.kind === 'user')
  const start = boundary < 0 ? firstUser : boundary
  const calls = new Map<string, { path: string; close: boolean }>(), paths = new Set<string>()
  for (const message of messages.slice(Math.max(0, start))) {
    if (message.role === 'assistant') for (const block of message.content) {
      if (block.type !== 'tool-call' || block.name !== 'video_inspect') continue
      const args = readArguments(block, cache)
      if (args === undefined || ['reopen', 'list', 'status'].includes(args.method ?? '')) continue
      const path = args.file_path === undefined ? sources.find(source => source.review_id === args.review_id)?.path
        : resolve(cwd, args.file_path)
      if (path !== undefined) calls.set(block.id, { path, close: args.method === 'close' })
    }
    if (message.role === 'tool' && !message.isError) {
      const source = calls.get(message.toolCallId)
      if (source !== undefined) {
        if (source.close) paths.delete(source.path)
        else paths.add(source.path)
      }
    }
  }
  return { paths, requireCurrentSource: boundary > firstUser }
}

/**
 * Find the latest real human request that is not an explicit continuation such as “继续” or “我的文件呢”.
 * @param messages - Logged and pending author messages.
 * @returns Its index, or -1 when no real human message has started a request.
 */
function taskRequestIndex(messages: readonly Message[]): number {
  return messages.findLastIndex(message => message.role === 'user' && message.source.kind === 'user'
    && !manuscriptDeliveryIntent(message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')).continuation)
}

/**
 * Read exact file candidates from the most recent real-user output declaration, excluding code and block quotations.
 * @param messages - Logged current author messages.
 * @param cwd - Session workspace for literal relative paths.
 * @returns Explicit candidate paths; this does not adopt a draft or discover files by modification time.
 */
export function manuscriptDeclaredOutputs(messages: readonly Message[], cwd: string) {
  for (const message of [...messages].reverse()) {
    if (message.role !== 'user' || message.source.kind !== 'user') continue
    const paths: { literal: string; basis: string; candidates: string[] }[] = []
    let fenced = false
    for (const block of message.content) {
      if (block.type !== 'text') continue
      for (const line of block.text.split('\n')) {
        if (/^\s*(?:```|~~~)/u.test(line)) { fenced = !fenced; continue }
        if (fenced || /^\s*>/u.test(line)) continue
        const output = /(?:保存(?:为|到)|输出(?:为|到)|写入|另存为|save\s+(?:as|to)|output\s+to)\s*[:：]?\s*(.*)/iu.exec(line)?.[1]
        if (output === undefined) continue
        let directory: string | undefined
        const declaration = output.split(/[。！？]/u)[0] ?? ''
        const tokens = /`([^`\n]+\.(?:md|txt|docx))`|["“]([^"”\n]+\.(?:md|txt|docx))["”]|([a-z0-9_./~-]+\.(?:md|txt|docx))/giu
        for (const match of declaration.matchAll(tokens)) {
          const path = match[1] ?? match[2] ?? match[3]
          if (path === undefined) continue
          if (path.includes('/') || path.includes('\\')) {
            directory = dirname(resolve(cwd, path))
            paths.push({ literal: path, basis: 'literal_user_output_path', candidates: [resolve(cwd, path)] })
          } else {
            const candidates = [...new Set([resolve(cwd, path), ...directory === undefined ? [] : [resolve(directory, path)]])]
            paths.push({ literal: path, basis: candidates.length > 1 ? 'parallel_output_directory_candidates' : 'literal_user_output_path', candidates })
          }
        }
      }
    }
    if (paths.length) return paths
  }
  return []
}

/**
 * Normalize an explicit episode label without selecting a file by its name or modification time.
 * @param value - Source episode label or parsed screenplay episode number.
 * @returns A decimal label when the complete input is recognized; otherwise undefined.
 */
export function manuscriptEpisodeNumber(value: string): string | undefined {
  const label = /^(?:第\s*)?([\d一二三四五六七八九十百零〇]+)(?:\s*集)?$/u.exec(value.trim())?.[1]
    ?? /^EP\s*0*(\d+)$/iu.exec(value.trim())?.[1]
  if (label === undefined) return undefined
  if (/^\d+$/u.test(label)) return String(Number(label))
  const digits = '零一二三四五六七八九', units: Record<string, number> = { 十: 10, 百: 100 }
  let result = 0, digit = 0
  for (const symbol of label.replaceAll('〇', '零')) {
    const unit = units[symbol]
    if (unit !== undefined) { result += (digit || 1) * unit; digit = 0 }
    else { const next = digits.indexOf(symbol); if (next < 0) return undefined; digit = next }
  }
  return String(result + digit)
}

function normalizedSpeech(value: string): string { return value.replace(/[^\p{L}\p{N}]/gu, '') }

function episodeReadLines(text: string, episode: string) {
  const lines = text.split('\n'), selected = new Set<number>()
  for (const scene of manuscriptScenes(text)) {
    if (manuscriptEpisodeNumber(scene.episode) !== episode) continue
    const prefixLines = scene.prefix.split('\n').length - 1
    for (let line = scene.startLine - prefixLines; line <= scene.endLine; line++) selected.add(line)
  }
  return [...selected].sort((left, right) => left - right).map(number => ({ number, text: lines[number - 1] ?? '' }))
}

function sourceLineChanges(before: ReturnType<typeof episodeReadLines>, after: ReturnType<typeof episodeReadLines>, maxEditLength: number) {
  const parts = diffLines(before.map(line => line.text).join('\n'), after.map(line => line.text).join('\n'), { maxEditLength })
  if (parts === undefined) return undefined
  const changes: { kind: string; before: typeof before; after: typeof after }[] = []
  let oldLine = 0, newLine = 0, pending: typeof changes[number] | undefined
  const flush = () => {
    if (pending === undefined) return
    pending.kind = pending.before.length === 0 ? 'insert' : pending.after.length === 0 ? 'delete' : 'replace'
    changes.push(pending)
    pending = undefined
  }
  for (const part of parts) {
    if (!part.added && !part.removed) { flush(); oldLine += part.count; newLine += part.count; continue }
    pending ??= { kind: '', before: [], after: [] }
    if (part.removed) { pending.before.push(...before.slice(oldLine, oldLine + part.count)); oldLine += part.count }
    else { pending.after.push(...after.slice(newLine, newLine + part.count)); newLine += part.count }
  }
  flush()
  return changes
}

async function readSourceRevisions(ctx: Context, agent: Agent, document: Awaited<ReturnType<typeof readManuscript>>,
  scenes: readonly ManuscriptScene[], config: Config, signal: AbortSignal) {
  const snapshots = manuscriptTextReadSnapshots(ctx, agent.session), cwd = agent.session.header.cwd ?? ''
  const episodes = [...new Set(scenes.flatMap((scene) => {
    const episode = manuscriptEpisodeNumber(scene.episode)
    return episode === undefined ? [] : [episode]
  }))]
  const reports = []
  const identityPath = (path: string) => relative(cwd, path).split(sep).join('/')
  for (const episode of episodes) {
    const sameEpisodeReads = (snapshots?.reads ?? []).filter(read => resolve(cwd, read.path) !== document.path
      && read.episodeLabels.some(label => manuscriptEpisodeNumber(label) === episode))
    const sameEpisode = [...new Set(sameEpisodeReads.map(read => read.path))].flatMap((path) => {
      const reads = sameEpisodeReads.filter(read => read.path === path)
      const selected = reads.find(read => read.status === 'complete') ?? reads.at(-1)
      return selected === undefined ? [] : [selected]
    })
    const candidates = await Promise.all(sameEpisode.map(async (read) => {
      let current: Awaited<ReturnType<typeof readManuscript>> | undefined, reason: string | undefined
      try { current = await readManuscript(read.path, cwd, config, signal) }
      catch (error) { signal.throwIfAborted(); reason = error instanceof Error ? error.message : String(error) }
      const currentReadHash = current === undefined ? undefined : manuscriptTextHash(manuscriptReadText(current.text))
      const status = read.status !== 'complete' ? read.status : current === undefined ? 'source_unavailable'
        : currentReadHash !== read.readTextSha256 ? 'current_source_changed' : 'current'
      return { path: read.path, read_call_id: read.readCallId, read_result_seq: read.readResultSeq,
        read_text_sha256: read.readTextSha256, read_window_sha256: read.readWindowSha256,
        read_scope: { status: read.status, offset: read.offset, returned_lines: read.returnedLines, total_lines: read.totalLines },
        current_status: status, current_source_file_sha256: current?.sha256, current_read_text_sha256: currentReadHash,
        read_diagnostics: sameEpisodeReads.filter(other => other.path === read.path && other !== read).map(other => ({
          read_call_id: other.readCallId, read_result_seq: other.readResultSeq, read_window_sha256: other.readWindowSha256,
          status: other.status, offset: other.offset, returned_lines: other.returnedLines, total_lines: other.totalLines })),
        ...reason === undefined ? {} : { reason }, snapshot: read }
    }))
    const valid = candidates.filter(candidate => candidate.current_status === 'current')
    const selected = valid.length === 1 && candidates.length === 1 ? valid[0] : undefined
    const before = selected?.snapshot.text === undefined ? [] : episodeReadLines(selected.snapshot.text, episode)
    const after = episodeReadLines(manuscriptReadText(document.text), episode)
    const changes = selected === undefined || before.length > config.maxParagraphs || after.length > config.maxParagraphs
      ? undefined : sourceLineChanges(before, after, config.maxEditLength)
    reports.push({ episode, relationship: 'current_task_read_source_candidate',
      adopted_authorization: 'not_inferred', source_truth: 'read_text_not_verified_video_facts',
      status: selected !== undefined ? changes === undefined ? 'diff_budget_exceeded' : 'compared'
        : candidates.length > 1 ? 'ambiguous' : candidates[0]?.current_status ?? 'no_matching_read_snapshot',
      candidates: candidates.map(({ snapshot: _snapshot, ...candidate }) => candidate),
      omitted_read_snapshots: snapshots?.omitted ?? 0,
      current_document: { path: document.path, file_sha256: document.sha256 },
      normalization: 'native_read_line_text_crlf_normalized_final_newline_omitted_not_file_bytes',
      ...selected === undefined ? {} : { comparison_source: { path: selected.path,
        read_text_sha256: selected.read_text_sha256, read_call_id: selected.read_call_id, read_result_seq: selected.read_result_seq,
        source_line_numbers: before.map(line => line.number) } },
      hunks: changes ?? [], semantic_assessment: 'not_performed' })
  }
  // Keep unbound-session hashes stable without reading historical tool bindings.
  const identity = { binding: null, reports: reports.map(report => ({
    episode: report.episode, relationship: report.relationship, status: report.status,
    omitted_read_snapshots: report.omitted_read_snapshots,
    bound_text_paths_without_matching_snapshot: [],
    candidates: report.candidates.map(candidate => ({ path: identityPath(candidate.path),
      read_text_sha256: candidate.read_text_sha256, read_window_sha256: candidate.read_window_sha256,
      read_scope: candidate.read_scope, current_status: candidate.current_status,
      current_source_file_sha256: candidate.current_source_file_sha256,
      current_read_text_sha256: candidate.current_read_text_sha256 })) })) }
  return { reports, identity: manuscriptTextHash(JSON.stringify(identity)) }
}

/** @param lines - Line numbers in any order. @returns Sorted inclusive `[first, last]` runs. */
function lineRanges(lines: Iterable<number>): [number, number][] {
  const ranges: [number, number][] = []
  for (const line of [...new Set(lines)].sort((left, right) => left - right)) {
    const last = ranges.at(-1)
    if (last !== undefined && last[1] + 1 === line) last[1] = line
    else ranges.push([line, line])
  }
  return ranges
}

/**
 * Line-range form of one read-source comparison; the compared text stays in the source file and the current draft.
 * An episode without any same-episode read keeps only its status.
 */
function readRevisionRefs(report: Awaited<ReturnType<typeof readSourceRevisions>>['reports'][number]) {
  const { candidates, comparison_source: comparison, hunks, ...rest } = report
  if (candidates.length === 0) return { episode: report.episode, status: report.status,
    ...report.omitted_read_snapshots > 0 ? { omitted_read_snapshots: report.omitted_read_snapshots } : {} }
  return { ...rest, candidates: candidates.map(candidate => ({ path: candidate.path, read_call_id: candidate.read_call_id,
    read_text_sha256: candidate.read_text_sha256, read_scope: candidate.read_scope, current_status: candidate.current_status,
    ...candidate.reason === undefined ? {} : { reason: candidate.reason },
    other_reads: candidate.read_diagnostics.length })),
  ...comparison === undefined ? {} : { comparison_source: { path: comparison.path, read_text_sha256: comparison.read_text_sha256,
    read_call_id: comparison.read_call_id, read_result_seq: comparison.read_result_seq } },
  hunks: hunks.map(hunk => ({ kind: hunk.kind, source_lines: lineRanges(hunk.before.map(line => line.number)),
    current_lines: lineRanges(hunk.after.map(line => line.number)) })) }
}

/** Positions-only form of {@link manuscriptPresentationEvidence}; quotes stay in the current draft. */
function presentationRefs(presentation: ReturnType<typeof manuscriptPresentationEvidence>) {
  return { advisory: true, semantic_assessment: 'not_performed', scope: presentation.scope,
    episodes: presentation.episodes.map(episode => ({ path: episode.path, episode: episode.episode,
      ending: { marker_status: episode.ending.marker_status, marker_count: episode.ending.marker_count,
        last_scene: episode.ending.last_scene, last_material_locations: episode.ending.last_material_locations,
        hook_marker_lines: episode.ending.hook_markers.findings.map(line => line.line),
        suspense_assessment: episode.ending.suspense_assessment },
      action_lines: episode.action_locations.findings.map(line => line.line),
      action_lines_total: episode.action_locations.total })),
    omitted_episodes: presentation.omitted_episodes }
}

function sceneSpeech(scene: ManuscriptScene) {
  return scene.text.split('\n').flatMap((quote, offset) => {
    if (/^\s*[▲△]/u.test(quote)) return []
    const match = /^\s*([^：:\n]+)[：:]\s*(.+)$/u.exec(quote)
    if (!match?.[2] || /^(?:人物|地点|场景|时间)$/u.test(match[1]?.trim() ?? '')) return []
    const text = normalizedSpeech(match[2])
    return text ? [{ line: scene.startLine + offset, quote, text }] : []
  })
}

function sceneVisualQueries(scene: ManuscriptScene) {
  return scene.text.split('\n').flatMap((quote, offset) => {
    const action = /^\s*[▲△]\s*(.+)$/u.exec(quote)?.[1]
    const parenthetical = /^\s*[^：:\n（(]+[（(]([^）)]+)[）)]\s*[：:]/u.exec(quote)?.[1]
    const text = action ?? parenthetical
    return text === undefined ? [] : [{ line: scene.startLine + offset, quote,
      kind: action === undefined ? 'dialogue_parenthetical' : 'action_line', text }]
  })
}

/**
 * Locate manuscript lines against saved ASR; action ranges may skip unaligned dialogue to the nearest literal candidates in this scene.
 * @param scene - Complete current scene with actual line locations.
 * @param timeline - Verified current video material and original saved ASR rows.
 * @returns Candidate source windows, line anchors and literal visual queries; no semantic coverage verdict.
 */
export function manuscriptSourceWindows(scene: ManuscriptScene, timeline: VideoSourceTimeline) {
  const speech = sceneSpeech(scene)
  const anchors = speech.flatMap(line => (timeline.speech?.segments ?? []).flatMap((segment) => {
    const text = normalizedSpeech(segment.text)
    if (!text || !line.text.includes(text) && !text.includes(line.text)) return []
    return [{ draft_line: line.line, draft_quote: line.quote, segment_id: segment.segment_id,
      start_seconds: segment.start_seconds, end_seconds: segment.end_seconds, source_text: segment.text,
      literal_match: text === line.text ? 'exact' : text.includes(line.text) ? 'source_contains_draft' : 'draft_contains_source',
      matched_characters: Math.min(Array.from(text).length, Array.from(line.text).length) }]
  }))
  const repeated = (timeline.speech?.segments ?? []).filter(segment => anchors.some(anchor => anchor.segment_id === segment.segment_id)
    && timeline.speech?.segments.some(other => other.segment_id !== segment.segment_id
      && normalizedSpeech(other.text) === normalizedSpeech(segment.text)))
  const lineCandidates = speech.map(line => ({ ...line, candidates: anchors.filter(anchor => anchor.draft_line === line.line) }))
  const betweenLines = lineCandidates.slice(1).map((line, index) => {
    const previous = lineCandidates[index]
    const shared = previous?.candidates.filter(left => line.candidates.some(right => right.segment_id === left.segment_id)) ?? []
    return { previous_line: previous?.line, current_line: line.line,
      relation: shared.length ? 'within_same_speech' : !previous?.candidates.length || !line.candidates.length
        ? 'not_aligned' : 'between_speech_candidates_not_an_event',
      ambiguous_source_matches: (previous?.candidates.length ?? 0) > 1 || line.candidates.length > 1,
      shared_segment_ids: [...new Set(shared.map(anchor => anchor.segment_id))],
      previous_candidates: previous?.candidates ?? [], current_candidates: line.candidates }
  })
  const start = anchors.length ? Math.min(...anchors.map(anchor => anchor.start_seconds)) - timeline.scope.window_seconds : undefined
  const end = anchors.length ? Math.max(...anchors.map(anchor => anchor.end_seconds)) + timeline.scope.window_seconds : undefined
  const windows = start === undefined || end === undefined ? timeline.windows
    : timeline.windows.filter(window => window.end_seconds > start && window.start_seconds < end)
  const visualQueries = sceneVisualQueries(scene).map((query) => {
    const own = lineCandidates.find(line => line.line === query.line)
    const previous = lineCandidates.findLast(line => line.line < query.line && line.candidates.length > 0)
    const next = lineCandidates.find(line => line.line > query.line && line.candidates.length > 0)
    const skipped = query.kind === 'action_line' ? lineCandidates.filter(line => line.candidates.length === 0
      && (previous === undefined || line.line > previous.line) && (next === undefined || line.line < next.line)) : []
    const ranges = query.kind === 'dialogue_parenthetical'
      ? (own?.candidates ?? []).map(anchor => ({ start_seconds: anchor.start_seconds, end_seconds: anchor.end_seconds,
        relation: 'within_speech_candidate', segment_ids: [anchor.segment_id] }))
      : previous !== undefined && next !== undefined ? previous.candidates.flatMap(left => next.candidates.flatMap((right) => {
        if (left.segment_id === right.segment_id) return [{ start_seconds: left.start_seconds, end_seconds: left.end_seconds,
          relation: 'within_same_speech', segment_ids: [left.segment_id] }]
        return left.end_seconds <= right.start_seconds ? [{ start_seconds: left.end_seconds, end_seconds: right.start_seconds,
          relation: 'between_speech_candidates_not_an_event', segment_ids: [left.segment_id, right.segment_id] }] : []
      })) : previous !== undefined ? previous.candidates.map(anchor => ({ start_seconds: anchor.end_seconds,
        end_seconds: windows.at(-1)?.end_seconds ?? anchor.end_seconds, relation: 'after_speech_candidate',
        segment_ids: [anchor.segment_id] })) : (next?.candidates ?? []).map(anchor => ({
        start_seconds: windows[0]?.start_seconds ?? anchor.start_seconds, end_seconds: anchor.start_seconds,
        relation: 'before_speech_candidate', segment_ids: [anchor.segment_id] }))
    return { ...query, time_candidates: ranges,
      ...skipped.length === 0 ? {} : { nearest_aligned_dialogue_lines: {
        ...previous === undefined ? {} : { previous_line: previous.line }, ...next === undefined ? {} : { next_line: next.line } },
      skipped_unaligned_dialogue_lines: skipped.map(line => line.line) },
      temporal_alignment: ranges.length ? 'literal_speech_time_candidates' : 'not_aligned',
      source_ambiguity_retained: ranges.length > 1 }
  })
  return { basis: anchors.length ? 'literal_asr_text_candidates' : 'source_order_not_aligned',
    anchors, line_candidates: lineCandidates, between_dialogue_lines: betweenLines,
    visual_queries: visualQueries, windows, window_seconds: timeline.scope.window_seconds,
    image_selection_scope: visualQueries.some(query => query.time_candidates.length > 0)
      ? 'visual_query_time_candidates' : 'scene_speech_span_candidates',
    automatic_images: anchors.length ? 'bounded_local_candidates' : 'none_without_source_anchor',
    repeated_source_text_segment_ids: repeated.map(segment => segment.segment_id),
    notice: '正文行号与ASR字面对应仅为定位候选；短句、语气词及重复台词保留全部命中，不作精确场景对齐或角色识别。'
      + '保留锚之间的连续画面和前后时间窗，包含无对白段；同一ASR原段对应两行标为within_same_speech，行间不制造动作空隙。'
      + '▲和括注原句对应时间候选，不把旧看图笔记当事实；无ASR锚仍保持未对齐，来源时间包不声称与正文对应。未自动判断动作遗漏、衔接或剧情通过。' }
}

/**
 * Return the bounded temporal packet identities selected for one saved scene.
 * @param scene - Exact saved scene supplying its identity and current lines.
 * @param location - Literal manuscript/ASR candidates and the independent source-change timeline.
 * @param count - Available shared image allowance.
 * @param excluded - Identities already returned from this review revision.
 * @returns Cached frame ids; selection does not verify actions or model understanding.
 */
export function manuscriptEvidenceFrames(scene: ManuscriptScene, location: ReturnType<typeof manuscriptSourceWindows>, count: number,
  excluded: ReadonlySet<string>): string[] {
  return planManuscriptVideoPackets(scene, location, count, excluded).selected.flatMap(packet => packet.images.map(frame => frame.frame_id))
}

function sourceEnding(timeline: VideoSourceTimeline, maximum: number) {
  const end = timeline.source.duration_seconds, start = Math.max(0, end - timeline.scope.window_seconds)
  const windows = timeline.windows.filter(window => window.end_seconds >= start)
  const frames = windows.flatMap(window => window.frames).filter(frame => frame.time >= start)
  const allSpeech = timeline.speech?.segments ?? []
  const lastSpeech = allSpeech.reduce<typeof allSpeech[number] | undefined>((last, segment) =>
    last === undefined || segment.end_seconds > last.end_seconds ? segment : last, undefined)
  const segments = allSpeech.filter(segment => segment.end_seconds >= start && segment.start_seconds <= end)
  return { source_end_seconds: timeline.source.duration_seconds, scanned_until: timeline.source.scanned_until,
    scan_complete: timeline.source.scan_complete, window: {
      window_ids: windows.map(window => window.window_id), start_seconds: start, end_seconds: end,
      frame_refs: frames.slice(-maximum).map(frame => ({ frame_id: frame.frame_id, time: frame.time })),
      omitted_frames: Math.max(0, frames.length - maximum) },
    tail_asr_segment_ids: segments.slice(-maximum).map(segment => segment.segment_id), omitted_asr: Math.max(0, segments.length - maximum),
    last_recorded_asr: lastSpeech === undefined ? null : { segment_id: lastSpeech.segment_id, start_seconds: lastSpeech.start_seconds,
      end_seconds: lastSpeech.end_seconds, text: lastSpeech.text },
    selection: 'rolling_source_tail_last_recorded_speech_separate_from_silent_tail',
    relationship: 'source_tail_not_aligned_to_draft_ending', suspense_assessment: 'not_performed' }
}

function observationLocations(location: ReturnType<typeof manuscriptSourceWindows>, maximum: number) {
  const rows = location.visual_queries.flatMap((query) => {
    if (!query.time_candidates.length) return []
    const inside = (time: number) => query.time_candidates.some(range => time >= range.start_seconds && time <= range.end_seconds)
    const overlaps = (event: { start_seconds: number; end_seconds: number }) => query.time_candidates.some(range =>
      event.start_seconds <= range.end_seconds && event.end_seconds >= range.start_seconds)
    const frames = new Set(location.windows.flatMap(window => window.frames
      .filter(frame => frame.observation !== undefined && inside(frame.time)).map(frame => frame.frame_id)))
    const events = new Set(location.windows.flatMap(window => window.event_notes.filter(overlaps).map(event => event.event_id)))
    return [[query.line, Math.min(...query.time_candidates.map(range => range.start_seconds)),
      Math.max(...query.time_candidates.map(range => range.end_seconds)), frames.size, events.size]]
  })
  return { columns: ['line', 'start_seconds', 'end_seconds', 'recorded_frames', 'event_refs'],
    rows: rows.slice(0, maximum), total: rows.length, omitted: Math.max(0, rows.length - maximum),
    relationship: 'time_overlap_candidates_not_event_equivalence', unmatched: 'unjudged_not_an_omission' }
}

/**
 * Connect successfully saved manuscript paths to current Session-local video sources and logged source receipts.
 * @param config - Deployment-controlled scene, image and source-read budgets.
 */
export class ManuscriptVideoEvidence {
  /** Successful tool paths with the human request that was current when each was saved. */
  private readonly saved = new WeakMap<Agent, Map<string, MessageId | undefined>>()
  private readonly parsed = new WeakMap<Agent, MaterialCache>()
  private readonly mutations = new WeakMap<Session, Map<string, SavedMutation>>()

  constructor(private readonly config: Config) {}

  /**
   * Mark only an actually logged source receipt as returned, without claiming image admission or understanding.
   * @param session - Session owning the committed receipt and pending native mutation.
   * @param event - Newly committed event; unrelated events do not inspect prior history.
   */
  observeReceipt(session: Session, event: SessionEvent): void {
    if (event.type !== 'user/message' || event.data.source.kind !== 'muse-manuscript') return
    const pending = this.mutations.get(session)
    if (pending === undefined || pending.size === 0) return
    for (const block of event.data.content) {
      const receipt = block.type === 'text' ? manuscriptVideoReceiptOf(block.text) : undefined
      if (receipt === undefined) continue
      const mutation = pending.get(receipt.path)
      if (mutation !== undefined && mutation.sha256 === receipt.complete_lf_text_sha256) mutation.returned = true
    }
  }

  /**
   * Retain a successful tool result's actual path, including nested dispatches whose arguments are not top-level messages.
   * The path is tagged with the latest real human request that is not an explicit continuation at save time.
   * @param agent - Owning author Session.
   * @param path - Actual successful write/edit result path.
   * @param mutation - Native LF-normalized mutation text, used only while its complete after text matches the saved file.
   * @returns Once the existing file identity is retained; a later unavailable file does not change the successful tool result.
   */
  async remember(agent: Agent, path: string, mutation?: {
    before: string | null
    after: string
    operation?: 'create' | 'update' | undefined
  }): Promise<void> {
    if (!isManuscript(path)) return
    const paths = this.saved.get(agent) ?? new Map<string, MessageId | undefined>(), messages = agent.session.deriveMessages()
    const request = taskRequestIndex(messages)
    paths.set(path, request < 0 ? undefined : messages[request]?.id)
    this.saved.set(agent, paths)
    const resolved = resolve(agent.session.header.cwd ?? '', path)
    let key: string
    try { key = await realpath(resolved) }
    catch (_error) {
      // A successful write can disappear before this advisory reads its identity; no mutation is inferred.
      this.mutations.get(agent.session)?.delete(resolved)
      return
    }
    const retained = this.mutations.get(agent.session) ?? new Map<string, SavedMutation>(), previous = retained.get(key)
    retained.delete(key)
    if (mutation !== undefined && (mutation.before !== null || mutation.operation === 'create')
      && (mutation.before === null || mutation.before.length <= this.config.maxTextChars)
      && mutation.after.length <= this.config.maxTextChars && retained.size < this.config.maxDocuments) {
      const continuesPending = previous !== undefined && !previous.returned && mutation.before !== null
        && previous.sha256 === manuscriptTextHash(mutation.before)
      const baselineText = continuesPending ? previous.baselineText : mutation.before
      const numbered = (text: string) => manuscriptReadText(text).split('\n').map((text, index) => ({ number: index + 1, text }))
      const before = baselineText === null ? [] : numbered(baselineText), after = numbered(mutation.after)
      const changes = before.length > this.config.maxParagraphs || after.length > this.config.maxParagraphs
        ? undefined : sourceLineChanges(before, after, this.config.maxEditLength)
      if (changes !== undefined) retained.set(key, { sha256: manuscriptTextHash(mutation.after), baselineText, returned: false,
        lines: new Set(changes.flatMap(hunk => hunk.after.map(line => line.number))),
        basis: baselineText === null ? 'new_saved_document' : 'successful_native_mutation' })
    }
    this.mutations.set(agent.session, retained)
  }

  /**
   * Return local current-draft/source materials once per exact saved draft and source-material identity in the Session log,
   * including material later replaced by compaction.
   * Without an output declaration, only paths saved or registered since the latest real human request
   * that is not an explicit continuation are read.
   * @param ctx - Current video provider and filesystem scope.
   * @param agent - Author Session supplying logged tool results and prior material receipts.
   * @param signal - Cancels source and manuscript reads.
   * @param pendingMessages - Current admitted inputs, which enter the log with this request.
   * @returns Logged-message-ready blocks, only for saved current-task scenes with a single matched video source timeline
   *   or a differing complete same-episode read; no input is rewritten, approved or required for delivery.
   *   Draft materials after the first returned draft stay within the remaining `videoEvidenceMaxBytes`; a draft that does
   *   not fit waits for a later step without a receipt.
   */
  async refresh(ctx: Context, agent: Agent, signal: AbortSignal, pendingMessages: readonly Message[] = []): Promise<ContentBlock[]> {
    const cwd = agent.session.header.cwd
    if (!cwd || ctx.get('sessionProjections') === undefined) return []
    const sources = videoReviewSummaries(manuscriptVideoReviewReader(ctx), agent.session)
    const llm = ctx.get('llm'), provider = agent.options.provider, model = agent.options.model
    const modelInfo = llm === undefined || provider === undefined || model === undefined ? undefined
      : await llm.resolveModelInfo(provider, model, signal)
    const imageCapable = modelInfo?.inputModalities?.includes('image') === true
    const messages = [...agent.session.deriveMessages(), ...pendingMessages]
    const cache: MaterialCache = this.parsed.get(agent) ?? { messages: new Map(), calls: new Map() }
    this.parsed.set(agent, cache)
    const retained = new Set<string>(messages.map(message => message.id)), retainedCalls = new Set<string>()
    for (const id of cache.messages.keys()) if (!retained.has(id)) cache.messages.delete(id)
    for (const message of messages) for (const block of message.content) if (block.type === 'tool-call') retainedCalls.add(block.id)
    for (const id of cache.calls.keys()) if (!retainedCalls.has(id)) cache.calls.delete(id)
    // Logged receipts include material whose notice compaction later replaced.
    const prior: Receipt[] = [...loggedManuscriptVideoReceipts(ctx, agent.session), ...receipts(pendingMessages, cache)]
    const outputBoundary = messages.findLastIndex(message => message.role === 'user' && message.source.kind === 'user'
      && declaredOutputs(message, cwd, cache).length > 0)
    // Without an output declaration, the latest human request that is not an explicit continuation starts the task.
    const taskStart = outputBoundary >= 0 ? outputBoundary : taskRequestIndex(messages)
    const taskId = taskStart < 0 ? undefined : messages[taskStart]?.id
    const sourceScope = videoTaskSourcePaths(messages, cwd, outputBoundary, cache, sources)
    const automaticSources = sources.filter(source => source.follow_up.status === 'active' || sourceScope.paths.has(source.path))
    const transcriptCandidates = manuscriptVideoReadCandidates(ctx, agent.session)
    const registered = registeredPaths(taskStart < 0 ? messages : messages.slice(taskStart), cwd, cache)
    if (!automaticSources.length && !manuscriptTextReadSnapshots(ctx, agent.session)?.reads.length) return []
    const output: ContentBlock[] = [], declarations = new Map<string, { literal: string; basis: string; candidates: string[] }>()
    // Frames already named by an offload diagnostic still in context are not listed again.
    const reported = new Set(messages.flatMap(message => message.source.kind !== 'muse-manuscript' ? []
      : message.content.flatMap(block => block.type === 'text' ? offloadDiagnosticFrames(block.text) : [])))
    const offloaded = [...new Set(receipts(messages, cache).flatMap(receipt => receipt.offloaded_frames ?? []))]
      .filter(frame => !reported.has(frame))
    if (offloaded.length) {
      output.push({ type: 'text', text: JSON.stringify({ manuscript_video_image_delivery: { offloaded_frames: offloaded,
        status: 'returned_blocks_offloaded_not_confirmed_admitted', automatic_retry: 'not_required',
        notice: '这些重显原图已被上下文卸载，不计为本次实际看图；保留曾返回事实，不为重显自动加轮或反复重发。需要时可读取对应缓存。' } }) })
    }
    const ambiguities = new Set<string>()
    const outputMessage = messages[outputBoundary]
    const declared = outputMessage === undefined ? [] : declaredOutputs(outputMessage, cwd, cache)
    for (const declaration of declared) {
      const existing: string[] = []
      for (const candidate of declaration.candidates) {
        try { if ((await stat(candidate)).isFile()) existing.push(await realpath(candidate)) }
        catch (error) {
          if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
        }
      }
      const unique = [...new Set(existing)]
      if (unique.length > 1) {
        for (const candidate of declaration.candidates) ambiguities.add(candidate)
        const text = JSON.stringify({ manuscript_video_output_candidates: { ...declaration,
          existing: unique, association: 'ambiguous_not_selected', advisory: true,
          notice: '同一并列输出清单省略目录，多个实际文件均存在，未按mtime挑稿；这不是采用稿或审校结论，不阻止继续。' } })
        if (!messages.some(message => message.source.kind === 'muse-manuscript'
          && message.content.some(block => block.type === 'text' && block.text === text))) output.push({ type: 'text', text })
      } else if (unique[0]) declarations.set(unique[0], declaration)
    }
    const saved = outputBoundary >= 0 ? [] : [...this.saved.get(agent) ?? []].flatMap(([path, task]) => task === taskId ? [path] : [])
    const paths = [...new Set([...registered, ...declarations.keys(), ...saved])].filter(path => !ambiguities.has(path))
    if (paths.length > this.config.maxDocuments) throw Error('MANUSCRIPT_VIDEO_DOCUMENT_LIMIT: 已保存文稿路径超出配置，未扫描其他文件。')
    paths.sort((a, b) => (prior.findLast(entry => entry.path === a)?.returned_frames.length ?? 0)
      - (prior.findLast(entry => entry.path === b)?.returned_frames.length ?? 0))
    let remainingFrames = this.config.videoEvidenceMaxFrames, remainingBytes = this.config.videoEvidenceMaxBytes, returnedDocuments = 0
    let deferred = false
    const referenceText = manuscriptFormatReferenceText()
    let referenceSent = messages.some(message => message.source.kind === 'muse-manuscript'
      && message.content.some(block => block.type === 'text' && block.text === referenceText))
    const returnedEvents = new Map<string, Set<string>>()
    for (const path of paths) {
      let document
      try { document = await readManuscript(path, cwd, this.config, signal) }
      catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') continue
        throw error
      }
      const scenes = manuscriptScenes(document.text)
      if (scenes.every(scene => scene.episode === MANUSCRIPT_PREAMBLE_EPISODE)) continue
      const readRevisions = await readSourceRevisions(ctx, agent, document, scenes, this.config, signal)
      const mutation = this.mutations.get(agent.session)?.get(document.path)
      const currentMutation = mutation?.sha256 === manuscriptTextHash(document.text.replaceAll('\r\n', '\n')) ? mutation : undefined
      const readChanges = readRevisions.reports.filter(report => report.status === 'compared')
      const numbered = (text: string) => manuscriptReadText(text).split('\n').map((text, index) => ({ number: index + 1, text }))
      const nativeBaseline = currentMutation?.baselineText
      const nativeChanges = nativeBaseline === undefined || nativeBaseline === null ? undefined
        : sourceLineChanges(numbered(nativeBaseline), numbered(document.text), this.config.maxEditLength)
      const nativeSourceTextHash = nativeBaseline === undefined || nativeBaseline === null ? undefined
        : manuscriptTextHash(manuscriptReadText(nativeBaseline))
      const changedLines = currentMutation?.basis === 'successful_native_mutation' ? currentMutation.lines : readChanges.length
        ? new Set(readChanges.flatMap(report => report.hunks.flatMap(hunk => hunk.after.map(line => line.number))))
        : currentMutation?.lines
      const changedSelection = { basis: currentMutation?.basis === 'successful_native_mutation' ? currentMutation.basis
        : readChanges.length ? 'complete_read_source_difference' : currentMutation?.basis ?? 'unavailable',
      current_file_sha256: document.sha256, after_changed_line_ranges: lineRanges(changedLines ?? []),
      native_text_comparison: 'complete_lf_normalized_text_with_final_newline_preserved',
      native_mutation_status: mutation === undefined ? 'not_retained' : currentMutation === undefined ? 'after_hash_mismatch' : 'current',
      semantic_assessment: 'not_performed' }
      const episodeLabels = new Set(scenes.map(scene => manuscriptEpisodeNumber(scene.episode)).filter(label => label !== undefined))
      const currentSources = sources.filter(source => sourceScope.paths.has(source.path))
      const singleCurrent = episodeLabels.size === 1 && sourceScope.paths.size === 1 && currentSources.length === 1
        && manuscriptEpisodeNumber(currentSources[0]?.episode ?? '') === undefined
        ? currentSources[0] : undefined
      const matching = scenes.map(scene => ({ scene, singleCurrentCandidate: singleCurrent !== undefined
        && manuscriptEpisodeNumber(scene.episode) !== undefined
        && manuscriptEpisodeNumber(scene.episode) !== manuscriptEpisodeNumber(singleCurrent.episode),
      sources: singleCurrent !== undefined && manuscriptEpisodeNumber(scene.episode) !== undefined ? [singleCurrent]
        : automaticSources.filter((source) => {
          const episode = manuscriptEpisodeNumber(scene.episode)
          return episode !== undefined && episode === manuscriptEpisodeNumber(source.episode)
            && (!sourceScope.requireCurrentSource || sourceScope.paths.has(source.path))
        }) }))
      const materials = await Promise.all([...new Set(matching.flatMap(entry => entry.sources.length === 1
        ? entry.sources.map(source => source.review_id) : []))].map(async (id) => {
        const material = await readVideoSourceTimeline(ctx, agent.session, id, {
          windowSeconds: this.config.videoEvidenceWindowSeconds, maxFrames: this.config.videoEvidenceMaxFrames,
          maxBytes: this.config.videoEvidenceMaxBytes, maxTranscriptBytes: this.config.videoEvidenceMaxTranscriptBytes,
          ...transcriptCandidates === undefined ? {} : { transcriptCandidates },
        }, signal, manuscriptVideoReviewReader(ctx))
        return [id, material.timeline] as const
      }))
      const timelines = new Map(materials)
      const identityPath = (path: string) => relative(cwd, path).split(sep).join('/')
      const sourceMaterialHash = manuscriptTextHash(JSON.stringify({
        source_candidates: matching.map(entry => ({ scene: entry.scene.id, sources: entry.sources.map(source => ({
          ...source, path: identityPath(source.path), ...source.transcript_reference === undefined ? {} : {
            transcript_reference: { ...source.transcript_reference, path: identityPath(source.transcript_reference.path) },
          },
        })) })),
        sources: materials.map(([id, timeline]) => ({ id, digest: timeline.material_sha256 })) }))
      const sourceIdentityHash = manuscriptTextHash(JSON.stringify({ read_source: readRevisions.identity,
        video_sources: matching.map(entry => ({ scene: entry.scene.id,
          sources: entry.sources.map((source) => {
            const timeline = timelines.get(source.review_id)
            const reference = timeline?.speech?.source ?? timeline?.speech_unavailable?.reference ?? source.transcript_reference
            return { review_id: source.review_id, path: identityPath(source.path), source_version: source.source_version,
              observation_state: timeline?.source.scan_complete && timeline.windows.every(window => window.frames
                .every(frame => frame.exposed && frame.observation_source === 'model_authored_observation')) ? 'complete' : 'pending',
              speech_available: timeline?.speech !== undefined,
              ...reference === undefined ? {} : { transcript: { path: identityPath(reference.path),
                version: reference.version, sha256: reference.sha256 } } }
          }) })) }))
      const evidenceKey = manuscriptTextHash(JSON.stringify({
        path: identityPath(document.path), sha256: document.sha256, sourceIdentityHash,
        presentation_version: MANUSCRIPT_VIDEO_PRESENTATION,
      }))
      const previousReceipt = prior.findLast(entry => entry.path === document.path && entry.evidence_key === evidenceKey)
        ?? prior.findLast(entry => entry.path === document.path)
      const carried = previousReceipt?.presentation_version === MANUSCRIPT_VIDEO_PRESENTATION
        && (previousReceipt.source_identity_sha256 === sourceIdentityHash
          || previousReceipt.source_identity_sha256 === undefined && previousReceipt.source_material_sha256 === sourceMaterialHash)
        ? previousReceipt : undefined
      const deliveredScenes = carried?.scene_versions
        .filter(old => scenes.some(scene => scene.id === old.id && scene.sha256 === old.sha256)) ?? []
      const locations = matching.map((entry) => {
        const source = entry.sources.length === 1 ? entry.sources[0] : undefined
        const timeline = source === undefined ? undefined : timelines.get(source.review_id)
        return { ...entry, timeline, location: timeline === undefined ? undefined : manuscriptSourceWindows(entry.scene, timeline) }
      })
      const priority = (entry: typeof locations[number]) => entry.location?.visual_queries.some(query => changedLines?.has(query.line)
        && query.time_candidates.length) ? 2 : sceneVisualQueries(entry.scene).some(query => changedLines?.has(query.line)) ? 1 : 0
      const episodeOf = (entry: typeof locations[number]) => manuscriptEpisodeNumber(entry.scene.episode)
      const comparedEpisodes = new Set(readRevisions.reports.flatMap(report => report.status === 'compared' && report.hunks.length > 0
        ? [report.episode] : []))
      // A scene needs one video source timeline or a differing complete read of its episode; a preamble matches neither.
      const pending = locations.filter(entry => entry.scene.episode !== MANUSCRIPT_PREAMBLE_EPISODE
        && (entry.timeline !== undefined || comparedEpisodes.has(episodeOf(entry) ?? ''))
        && !deliveredScenes.some(old => old.id === entry.scene.id && old.sha256 === entry.scene.sha256))
      // A read-only episode returns one comparison entry; its other changed scenes are returned with it.
      const changed = pending.filter((entry, index) => entry.timeline !== undefined
        || pending.findIndex(other => other.timeline === undefined && episodeOf(other) === episodeOf(entry)) === index)
        .sort((left, right) => priority(right) - priority(left))
      const invalidatedFrames = new Set(carried?.sha256 === document.sha256 ? [] : changed.flatMap(entry => entry.location?.windows
        .flatMap(window => window.frames.map(frame => `${entry.sources[0]?.review_id}/${frame.frame_id}`)) ?? []))
      const carriedFrames = carried?.returned_frames.filter(frame => !invalidatedFrames.has(`${frame.review_id}/${frame.frame_id}`)) ?? []
      const selected = changed.slice(0, this.config.videoEvidenceMaxScenes)
      if (!selected.length) continue
      const readOnlyEpisodes = new Set(selected.flatMap(entry => entry.timeline === undefined ? [episodeOf(entry)] : []))
      const covered = pending.filter(entry => entry.timeline === undefined && !selected.includes(entry)
        && readOnlyEpisodes.has(episodeOf(entry)))
      const returned = [...selected, ...covered]
      const reports = []
      const returnedReadEpisodes = new Set<string>()
      const packetSources = new Map<string, {
        timeline: VideoSourceTimeline
        plans: ManuscriptPacketPlan[]
        images: Map<string, ImageBlock>
      }>()
      const sourceEndings = new Map<string, ReturnType<typeof sourceEnding> & { episode: string; draft_path: string }>()
      const returnedFrames = [...carriedFrames]
      for (const [selectedIndex, entry] of selected.entries()) {
        const episode = episodeOf(entry)
        const readRevision = episode === undefined ? undefined : readRevisions.reports.find(report => report.episode === episode)
        const readMaterial = episode === undefined || returnedReadEpisodes.has(episode) ? { read_source_revision_ref: episode }
          : { read_source_revision: readRevision === undefined ? undefined : readRevisionRefs(readRevision) }
        if (episode !== undefined) returnedReadEpisodes.add(episode)
        const source = entry.sources.length === 1 ? entry.sources[0] : undefined
        const timeline = entry.timeline
        if (source === undefined || timeline === undefined) {
          reports.push({ manuscript_scene_refs: pending.filter(other => other.timeline === undefined && episodeOf(other) === episode)
            .map(other => ({ id: other.scene.id, start_line: other.scene.startLine, end_line: other.scene.endLine })),
          ...readMaterial, source_alignment: entry.sources.length ? 'ambiguous_episode_sources'
            : sourceScope.requireCurrentSource ? 'no_current_task_video_source' : 'no_matching_episode_source',
          semantic_assessment: 'not_performed' })
          continue
        }
        const index = scenes.indexOf(entry.scene)
        const sceneRef = (scene: ManuscriptScene | undefined) => scene === undefined ? null
          : { id: scene.id, start_line: scene.startLine, end_line: scene.endLine }
        const manuscript = { current: sceneRef(entry.scene), previous: sceneRef(scenes[index - 1]), next: sceneRef(scenes[index + 1]) }
        const location = entry.location ?? manuscriptSourceWindows(entry.scene, timeline)
        const priorityScenes = selected.slice(selectedIndex).filter(candidate => priority(candidate) > 0).length
        const allowance = imageCapable ? priority(entry) > 0
          ? Math.floor(remainingFrames / Math.max(1, priorityScenes))
          : Math.min(remainingFrames, Math.max(1, Math.floor(this.config.videoEvidenceMaxFrames / (selected.length * paths.length)))) : 0
        const alreadyReturned = new Set(returnedFrames.filter(frame => frame.review_id === source.review_id).map(frame => frame.frame_id))
        const tail = imageCapable && !sourceEndings.has(source.review_id)
          ? planManuscriptSourceTail(entry.scene, timeline, Math.min(2, remainingFrames), alreadyReturned) : undefined
        const tailIds = tail?.images.map(frame => frame.frame_id) ?? []
        const previousHunks = readRevision?.status === 'compared'
          ? readRevision.hunks.map(hunk => ({ basis: 'complete_read_source_difference' as const,
            before_lines: hunk.before.map(line => line.number), after_lines: hunk.after.map(line => line.number),
            ...readRevision.comparison_source === undefined ? {} : { source_path: readRevision.comparison_source.path,
              ...readRevision.comparison_source.read_text_sha256 === undefined ? {} : {
                source_text_sha256: readRevision.comparison_source.read_text_sha256 } } }))
          : nativeChanges?.map(hunk => ({ basis: 'successful_native_mutation' as const,
            before_lines: hunk.before.map(line => line.number), after_lines: hunk.after.map(line => line.number),
            source_path: document.path,
            ...nativeSourceTextHash === undefined ? {} : { source_text_sha256: nativeSourceTextHash } }))
        const packetContext: PacketContext = { document_sha256: document.sha256,
          previous_status: previousHunks === undefined ? 'unavailable' : 'available',
          ...previousHunks === undefined ? {} : { previous_hunks: previousHunks },
          excluded_event_ids: new Set(returnedEvents.get(source.review_id)) }
        const plan = planManuscriptVideoPackets(entry.scene, location,
          tail === undefined ? allowance : remainingFrames - tailIds.length,
          new Set([...alreadyReturned, ...tailIds]), changedLines, packetContext)
        if (tail !== undefined) { plan.candidates.push(tail); plan.selected.unshift(tail) }
        const frameIds = plan.selected.flatMap(packet => packet.images.map(frame => frame.frame_id))
        const selectedMaterial = frameIds.length ? await readVideoSourceTimeline(ctx, agent.session, source.review_id, {
          windowSeconds: this.config.videoEvidenceWindowSeconds, maxFrames: this.config.videoEvidenceMaxFrames,
          maxBytes: this.config.videoEvidenceMaxBytes, maxTranscriptBytes: this.config.videoEvidenceMaxTranscriptBytes,
          ...transcriptCandidates === undefined ? {} : { transcriptCandidates },
          frameIds,
        }, signal, manuscriptVideoReviewReader(ctx)) : undefined
        if (selectedMaterial && selectedMaterial.timeline.material_sha256 !== timeline.material_sha256) {
          throw Error('MANUSCRIPT_VIDEO_SOURCE_CHANGED: 来源在局部证据读取期间变化，未将材料标记为已核对。')
        }
        const packetSource = packetSources.get(source.review_id) ?? { timeline, plans: [], images: new Map<string, ImageBlock>() }
        packetSource.plans.push(plan)
        packetSources.set(source.review_id, packetSource)
        if (selectedMaterial) {
          let frameId: string | undefined
          for (const block of selectedMaterial.content) {
            if (block.type === 'text') {
              const label = /^VIDEO_FRAME (\S+)/u.exec(block.text)?.[1], prefix = `${source.review_id}/`
              frameId = label?.startsWith(prefix) ? label.slice(prefix.length) : undefined
            } else if (block.type === 'image' && frameId !== undefined) packetSource.images.set(frameId, block)
          }
        }
        remainingFrames -= frameIds.length
        const actualFrames = frameIds.filter(id => packetSource.images.has(id))
        returnedFrames.push(...actualFrames.map(frame_id => ({ review_id: source.review_id, frame_id })))
        const availableFrames = location.windows.flatMap(window => window.frames).filter(frame => frame.image_available)
        const sourceFirst = plan.selected.some(packet => packet.origin === 'source_timeline')
        const ending = sourceEndings.has(source.review_id) ? { source_ending_ref: source.review_id }
          : { source_ending: sourceEnding(timeline, this.config.maxRepeatFindings) }
        if ('source_ending' in ending) sourceEndings.set(source.review_id, { ...ending.source_ending,
          episode: entry.scene.episode, draft_path: document.path })
        reports.push({ manuscript, ...readMaterial, source_alignment: location.basis,
          source_association: entry.singleCurrentCandidate ? 'single_current_task_video_candidate'
            : sourceScope.paths.has(source.path) ? 'logged_current_task_video_call' : 'episode_label_candidate',
          source: { review_id: source.review_id, episode: timeline.source.episode, follow_up: timeline.source.follow_up },
          automatic_images: sourceFirst ? 'bounded_source_timeline_samples' : location.automatic_images,
          image_selection_scope: sourceFirst ? 'source_timeline_samples_not_draft_alignment' : location.image_selection_scope,
          ...timeline.speech_unavailable === undefined ? {} : { speech_unavailable: timeline.speech_unavailable },
          ...ending,
          observation_locations: observationLocations(location, this.config.maxRepeatFindings),
          images: { returned_frame_ids: actualFrames, returned: actualFrames.length,
            requested_frame_ids: frameIds, unavailable_frame_ids: frameIds.filter(id => !packetSource.images.has(id)),
            available_in_selected_windows: availableFrames.length,
            not_returned_from_selected_windows: availableFrames
              .filter(frame => !alreadyReturned.has(frame.frame_id) && !frameIds.includes(frame.frame_id)).length } })
      }
      const receipt: Receipt = { path: document.path, sha256: document.sha256, evidence_key: evidenceKey,
        complete_lf_text_sha256: manuscriptTextHash(document.text.replaceAll('\r\n', '\n')),
        presentation_version: MANUSCRIPT_VIDEO_PRESENTATION,
        read_source_identity_sha256: readRevisions.identity,
        source_material_sha256: sourceMaterialHash, source_identity_sha256: sourceIdentityHash, returned_frames: returnedFrames,
        scene_versions: [...deliveredScenes.filter(old => !returned.some(entry => entry.scene.id === old.id)),
          ...returned.map(entry => ({ id: entry.scene.id, sha256: entry.scene.sha256 }))] }
      const remainingImages = locations.filter(entry => entry.location !== undefined && entry.sources[0] !== undefined
        && manuscriptEvidenceFrames(entry.scene, entry.location, 1, new Set(returnedFrames
          .filter(frame => frame.review_id === entry.sources[0]?.review_id).map(frame => frame.frame_id))).length > 0)
      const videoEpisodes = new Set(selected.flatMap(entry => entry.timeline === undefined ? [] : [entry.scene.episode]))
      const videoScenes = scenes.flatMap(scene => videoEpisodes.has(scene.episode) ? [{ ...scene, path: document.path }] : [])
      const presentation = manuscriptPresentationEvidence(videoScenes,
        { maximumFindings: this.config.maxRepeatFindings, maxTextCharacters: this.config.maxTextChars },
        changedLines === undefined ? undefined : new Map([[document.path, changedLines]]),
        new Map([[document.path, videoEpisodes]]))
      const cue = manuscriptEndingCue(presentation, [...sourceEndings.values()].map(ending => ({
        episode: ending.episode, draft_path: ending.draft_path, last_asr: ending.last_recorded_asr,
        frames: ending.window.frame_refs })),
      { maximumFindings: this.config.maxRepeatFindings, maxTextCharacters: this.config.maxTextChars })
      const text = JSON.stringify({ manuscript_video_evidence: { advisory: true, semantic_assessment: 'not_performed', receipt,
        ...presentation.episodes.length ? { presentation_evidence: presentationRefs(presentation) } : {},
        changed_line_selection: changedSelection,
        output_association: declarations.get(document.path) ?? { basis: 'successful_tool_path' },
        image_delivery: 'cached_blocks_returned_not_admission_or_understanding',
        image_route: imageCapable ? 'image_capable' : 'text_only_or_unknown_no_images_returned',
        changed_scenes: pending.length, returned_scenes: returned.length,
        not_returned_scenes: pending.filter(entry => !returned.includes(entry)).length,
        remaining_image_scenes: remainingImages.length,
        scope: 'saved_draft_changed_scenes_with_source_candidates', scenes: reports,
        read: '这里只给行号、ASR段号和帧号；需要原文时用read读当前稿相应行，画面记录与ASR用video_inspect timeline按review_id和时间段读取，缓存原图用video_inspect revisit。',
        notice: '引用和模型笔记不是独立事实。未返回范围未核对，不要求消成零或自动重跑；无审批、动作配额或交付限制。' } })
      // The fixed notation reference follows the first ending cue still present in the model context.
      const reference = cue && !referenceSent ? referenceText : undefined
      const content: ContentBlock[] = [...cue ? [{ type: 'text' as const, text: cue }] : [],
        ...reference === undefined ? [] : [{ type: 'text' as const, text: reference }], { type: 'text', text },
        ...[...packetSources.values()].flatMap(packetSource => manuscriptVideoPacketContent({ ...packetSource,
          documentSha256: document.sha256 }))]
      const size = Buffer.byteLength(JSON.stringify(content))
      if (size > remainingBytes) {
        // A later draft that does not fit gets no receipt, so a later refresh can return it; the deferral is stated.
        if (returnedDocuments > 0) {
          deferred = true
          break
        }
        throw Error('MANUSCRIPT_VIDEO_RESULT_SIZE: 局部材料超出配置，未截断原句或声明核对完成。')
      }
      const current = await readManuscript(path, cwd, this.config, signal)
      if (current.sha256 !== document.sha256) throw Error('MANUSCRIPT_VIDEO_DRAFT_CHANGED: 文稿在局部证据读取期间变化，请以新版本为准。')
      const currentReadRevisions = await readSourceRevisions(ctx, agent, current, scenes, this.config, signal)
      if (currentReadRevisions.identity !== readRevisions.identity) {
        throw Error('MANUSCRIPT_READ_SOURCE_CHANGED: 来源在原句差异读取期间变化，未返回过期对照或标记完成。')
      }
      for (const [id, source] of packetSources) {
        const ids = returnedEvents.get(id) ?? new Set<string>()
        for (const eventId of manuscriptPacketEventIds(source.timeline, source.plans, new Set(source.images.keys()))) ids.add(eventId)
        returnedEvents.set(id, ids)
      }
      remainingBytes -= size
      returnedDocuments += 1
      referenceSent ||= reference !== undefined
      output.push(...content)
    }
    if (deferred) output.push({ type: 'text', text: '另有已保存稿件因本次材料字节上限未附参考材料，可在后续步骤附上；不用等待或确认，继续当前任务。' })
    return output
  }
}
