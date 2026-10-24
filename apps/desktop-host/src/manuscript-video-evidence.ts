/** Version-bound local source materials for saved episode drafts; no semantic verdict or delivery control. */
import { realpath, stat } from 'node:fs/promises'
import { dirname, relative, resolve, sep } from 'node:path'
import { diffLines } from 'diff'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock, ImageBlock, Message, ToolCallBlock } from '@deepseek-ai/dsh-llm'
import { readVideoSourceTimeline, videoReviewSummaries, type VideoSourceTimeline } from '@deepseek-ai/dsh-tool-video-inspect'
import { z } from 'zod'
import type { Config } from './manuscript-revisions.ts'
import { isManuscript, readManuscript } from './manuscript-document.ts'
import { manuscriptScenes, manuscriptTextHash, type ManuscriptScene } from './manuscript-scenes.ts'
import { manuscriptReadText, manuscriptTextReadSnapshots, manuscriptVideoReadCandidates } from './manuscript-video-reads.ts'
import { MANUSCRIPT_VIDEO_PRESENTATION, manuscriptVideoPacketContent, planManuscriptVideoPackets,
  type ManuscriptPacketPlan } from './manuscript-video-packets.ts'

const callArguments = z.object({ file_path: z.string().optional(), draft_path: z.string().optional(),
  action: z.string().optional(), task_key: z.string().optional(), source_paths: z.array(z.string()).optional(),
  candidate_paths: z.array(z.string()).optional() })
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
const receiptSchema = z.object({ path: z.string(), sha256: z.string(), evidence_key: z.string(),
  presentation_version: z.string().optional(),
  source_material_sha256: z.string(),
  source_identity_sha256: z.string().optional(),
  read_source_identity_sha256: z.string().optional(),
  returned_frames: z.array(z.object({ review_id: z.string(), frame_id: z.string() })),
  scene_versions: z.array(z.object({ id: z.string(), sha256: z.string() })) })
type Receipt = z.infer<typeof receiptSchema> & { offloaded_frames?: string[] }

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
  let bound: string[] | undefined
  let sourceBinding: { task_key: string | undefined; paths: string[] } | undefined
  for (const message of messages) {
    if (message.role === 'assistant') for (const block of message.content) {
      if (block.type === 'tool-call') calls.set(block.id, block)
    }
    if (message.role !== 'tool' || message.isError) continue
    const call = calls.get(message.toolCallId)
    if (!call || !['write', 'edit', 'video_inspect', 'manuscript_work'].includes(call.name)) continue
    const args = readArguments(call, cache)
    if (args === undefined) continue
    if (call.name === 'manuscript_work' && args.action === 'bind') {
      bound = args.candidate_paths?.filter(isManuscript).map(path => resolve(cwd, path))
      sourceBinding = { task_key: args.task_key, paths: (args.source_paths ?? []).map(path => resolve(cwd, path)) }
    }
    const selected = call.name === 'manuscript_work' && args.action === 'bind' ? args.candidate_paths ?? []
      : call.name === 'video_inspect' ? args.draft_path === undefined ? [] : [args.draft_path]
        : args.file_path === undefined ? [] : [args.file_path]
    for (const path of selected) if (isManuscript(path)) paths.add(resolve(cwd, path))
  }
  return { paths: bound ?? [...paths], explicitlyBound: bound !== undefined, sourceBinding }
}

function receipts(messages: readonly Message[], cache: MaterialCache): Receipt[] {
  return messages.flatMap(message => message.role !== 'user' || message.source.kind !== 'muse-manuscript' ? []
    : cachedMessage(message, cache).receipts ??= message.content.flatMap((block) => {
      if (block.type !== 'text') return []
      const result = z.object({ manuscript_video_evidence: z.object({ receipt: receiptSchema }) })
        .safeParse(parsedJson(block.text))
      if (!result.success) return []
      const offloaded = new Set<string>()
      let label: string | undefined
      for (const part of message.content) {
        if (part.type === 'text') label = /^VIDEO_FRAME (\S+) /u.exec(part.text)?.[1]
        if (part.type === 'image' && part.offloaded && label) offloaded.add(label)
      }
      const receipt = result.data.manuscript_video_evidence.receipt
      return [{ ...receipt, ...offloaded.size ? { offloaded_frames: [...offloaded] } : {} }]
    }))
}

function videoTaskSourcePaths(messages: readonly Message[], cwd: string, boundary: number, cache: MaterialCache) {
  const firstUser = messages.findIndex(message => message.role === 'user' && message.source.kind === 'user')
  const start = boundary < 0 ? firstUser : boundary
  const calls = new Map<string, string>(), paths = new Set<string>()
  for (const message of messages.slice(Math.max(0, start))) {
    if (message.role === 'assistant') for (const block of message.content) {
      if (block.type !== 'tool-call' || block.name !== 'video_inspect') continue
      const args = readArguments(block, cache)
      if (args?.file_path !== undefined) calls.set(block.id, resolve(cwd, args.file_path))
    }
    if (message.role === 'tool' && !message.isError) {
      const path = calls.get(message.toolCallId)
      if (path !== undefined) paths.add(path)
    }
  }
  return { paths, requireCurrentSource: boundary > firstUser }
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
  scenes: readonly ManuscriptScene[], binding: ReturnType<typeof registeredPaths>['sourceBinding'], config: Config, signal: AbortSignal) {
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
    const boundTextPaths = (binding?.paths ?? []).filter(path => /\.(?:md|txt)$/iu.test(path))
    const explicitlyBound = sameEpisode.filter(read => boundTextPaths.includes(resolve(cwd, read.path)))
    const preferred = boundTextPaths.length ? explicitlyBound : sameEpisode
    const candidates = await Promise.all(preferred.map(async (read) => {
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
    reports.push({ episode, relationship: boundTextPaths.length ? 'explicit_work_source_path' : 'current_task_read_source_candidate',
      adopted_authorization: 'not_inferred', source_truth: 'read_text_not_verified_video_facts',
      status: selected !== undefined ? changes === undefined ? 'diff_budget_exceeded' : 'compared'
        : candidates.length > 1 ? 'ambiguous' : candidates[0]?.current_status ?? 'no_matching_read_snapshot',
      candidates: candidates.map(({ snapshot: _snapshot, ...candidate }) => candidate),
      bound_text_paths_without_matching_snapshot: (binding?.paths ?? []).filter(path => /\.(?:md|txt)$/iu.test(path)
        && !(snapshots?.reads ?? []).some(read => resolve(cwd, read.path) === path
          && read.episodeLabels.some(label => manuscriptEpisodeNumber(label) === episode))),
      omitted_read_snapshots: snapshots?.omitted ?? 0,
      current_document: { path: document.path, file_sha256: document.sha256 },
      normalization: 'native_read_line_text_crlf_normalized_final_newline_omitted_not_file_bytes',
      ...selected === undefined ? {} : { comparison_source: { path: selected.path,
        read_text_sha256: selected.read_text_sha256, read_call_id: selected.read_call_id, read_result_seq: selected.read_result_seq,
        source_line_numbers: before.map(line => line.number) } },
      hunks: changes ?? [], semantic_assessment: 'not_performed' })
  }
  const identity = { binding: binding === undefined ? null : { task_key: binding.task_key, paths: binding.paths.map(identityPath) },
    reports: reports.map(report => ({ episode: report.episode, relationship: report.relationship, status: report.status,
      omitted_read_snapshots: report.omitted_read_snapshots,
      bound_text_paths_without_matching_snapshot: report.bound_text_paths_without_matching_snapshot.map(identityPath),
      candidates: report.candidates.map(candidate => ({ path: identityPath(candidate.path),
        read_text_sha256: candidate.read_text_sha256, read_window_sha256: candidate.read_window_sha256,
        read_scope: candidate.read_scope, current_status: candidate.current_status,
        current_source_file_sha256: candidate.current_source_file_sha256,
        current_read_text_sha256: candidate.current_read_text_sha256 })) })) }
  return { reports, identity: manuscriptTextHash(JSON.stringify(identity)) }
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
 * Locate actual manuscript lines against saved ASR, retaining silent spans and every literal ambiguity.
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
    const previous = lineCandidates.findLast(line => line.line < query.line)
    const next = lineCandidates.find(line => line.line > query.line)
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

/**
 * Connect successfully saved manuscript paths to current Session-local video sources and logged source receipts.
 * @param config - Deployment-controlled scene, image and source-read budgets.
 */
export class ManuscriptVideoEvidence {
  private readonly saved = new WeakMap<Agent, Set<string>>()
  private readonly parsed = new WeakMap<Agent, MaterialCache>()

  constructor(private readonly config: Config) {}

  /**
   * Retain a successful tool result's actual path, including nested dispatches whose arguments are not top-level messages.
   * @param agent - Owning author Session.
   * @param path - Actual successful write/edit result path.
   */
  remember(agent: Agent, path: string): void {
    if (!isManuscript(path)) return
    const paths = this.saved.get(agent) ?? new Set<string>()
    paths.add(path)
    this.saved.set(agent, paths)
  }

  /**
   * Return local current-draft/source materials once per exact saved draft and source-material identity.
   * @param ctx - Current video provider and filesystem scope.
   * @param agent - Author Session supplying logged tool results and prior material receipts.
   * @param signal - Cancels source and manuscript reads.
   * @param pendingMessages - Current admitted inputs, which enter the log with this request.
   * @returns Logged-message-ready blocks; no input is rewritten, approved or required for delivery.
   */
  async refresh(ctx: Context, agent: Agent, signal: AbortSignal, pendingMessages: readonly Message[] = []): Promise<ContentBlock[]> {
    const cwd = agent.session.header.cwd
    if (!cwd || ctx.get('sessionProjections') === undefined) return []
    const sources = videoReviewSummaries(ctx, agent.session)
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
    const prior = receipts(messages, cache)
    const outputBoundary = messages.findLastIndex(message => message.role === 'user' && message.source.kind === 'user'
      && declaredOutputs(message, cwd, cache).length > 0)
    const sourceScope = videoTaskSourcePaths(messages, cwd, outputBoundary, cache)
    const transcriptCandidates = manuscriptVideoReadCandidates(ctx, agent.session)
    const registered = registeredPaths(outputBoundary < 0 ? messages : messages.slice(outputBoundary), cwd, cache)
    if (!sources.length && !manuscriptTextReadSnapshots(ctx, agent.session)?.reads.length
      && registered.sourceBinding === undefined) return []
    const output: ContentBlock[] = [], declarations = new Map<string, { literal: string; basis: string; candidates: string[] }>()
    const offloaded = [...new Set(prior.flatMap(receipt => receipt.offloaded_frames ?? []))]
    if (offloaded.length) {
      const text = JSON.stringify({ manuscript_video_image_delivery: { offloaded_frames: offloaded,
        status: 'returned_blocks_offloaded_not_confirmed_admitted', automatic_retry: 'not_required',
        notice: '这些重显原图已被上下文卸载，不计为本次实际看图；保留曾返回事实，不为重显自动加轮或反复重发。需要时可读取对应缓存。' } })
      if (!messages.some(message => message.source.kind === 'muse-manuscript'
        && message.content.some(block => block.type === 'text' && block.text === text))) output.push({ type: 'text', text })
    }
    const ambiguities = new Set<string>()
    const outputMessage = messages[outputBoundary]
    const declared = outputMessage === undefined ? [] : declaredOutputs(outputMessage, cwd, cache)
    if (!registered.explicitlyBound) for (const declaration of declared) {
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
    const paths = registered.explicitlyBound ? [...registered.paths] : [...new Set([...registered.paths,
      ...declarations.keys(), ...outputBoundary < 0 ? this.saved.get(agent) ?? [] : []])].filter(path => !ambiguities.has(path))
    if (paths.length > this.config.maxDocuments) throw Error('MANUSCRIPT_VIDEO_DOCUMENT_LIMIT: 已保存文稿路径超出配置，未扫描其他文件。')
    paths.sort((a, b) => (prior.findLast(entry => entry.path === a)?.returned_frames.length ?? 0)
      - (prior.findLast(entry => entry.path === b)?.returned_frames.length ?? 0))
    let remainingFrames = this.config.videoEvidenceMaxFrames
    for (const path of paths) {
      let document
      try { document = await readManuscript(path, cwd, this.config, signal) }
      catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') continue
        throw error
      }
      const scenes = manuscriptScenes(document.text)
      if (scenes.every(scene => scene.episode === 'unassigned')) continue
      const readRevisions = await readSourceRevisions(ctx, agent, document, scenes, registered.sourceBinding, this.config, signal)
      const episodeLabels = new Set(scenes.map(scene => manuscriptEpisodeNumber(scene.episode)).filter(label => label !== undefined))
      const currentSources = sources.filter(source => sourceScope.paths.has(source.path))
      const singleCurrent = episodeLabels.size === 1 && sourceScope.paths.size === 1 && currentSources.length === 1
        && manuscriptEpisodeNumber(currentSources[0]?.episode ?? '') === undefined
        ? currentSources[0] : undefined
      const matching = scenes.map(scene => ({ scene, singleCurrentCandidate: singleCurrent !== undefined
        && manuscriptEpisodeNumber(scene.episode) !== undefined
        && manuscriptEpisodeNumber(scene.episode) !== manuscriptEpisodeNumber(singleCurrent.episode),
      sources: singleCurrent !== undefined && manuscriptEpisodeNumber(scene.episode) !== undefined ? [singleCurrent]
        : sources.filter((source) => {
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
        }, signal)
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
      const changed = locations
        .filter(entry => !deliveredScenes.some(old => old.id === entry.scene.id && old.sha256 === entry.scene.sha256))
      const invalidatedFrames = new Set(carried?.sha256 === document.sha256 ? [] : changed.flatMap(entry => entry.location?.windows
        .flatMap(window => window.frames.map(frame => `${entry.sources[0]?.review_id}/${frame.frame_id}`)) ?? []))
      const carriedFrames = carried?.returned_frames.filter(frame => !invalidatedFrames.has(`${frame.review_id}/${frame.frame_id}`)) ?? []
      const selected = changed.slice(0, this.config.videoEvidenceMaxScenes)
      if (!selected.length) continue
      const reports = []
      const returnedReadEpisodes = new Set<string>()
      const packetSources = new Map<string, {
        timeline: VideoSourceTimeline
        plans: ManuscriptPacketPlan[]
        images: Map<string, ImageBlock>
      }>()
      const returnedFrames = [...carriedFrames]
      for (const entry of selected) {
        const index = scenes.indexOf(entry.scene)
        const manuscript = { current: entry.scene, previous: scenes[index - 1] ?? null, next: scenes[index + 1] ?? null }
        const episode = manuscriptEpisodeNumber(entry.scene.episode)
        const readRevision = episode === undefined ? undefined : readRevisions.reports.find(report => report.episode === episode)
        const readMaterial = episode === undefined || returnedReadEpisodes.has(episode) ? { read_source_revision_ref: episode }
          : { read_source_revision: readRevision }
        if (episode !== undefined) returnedReadEpisodes.add(episode)
        const source = entry.sources.length === 1 ? entry.sources[0] : undefined
        const timeline = entry.timeline
        if (source === undefined || timeline === undefined) {
          reports.push({ manuscript, ...readMaterial, source_alignment: entry.sources.length ? 'ambiguous_episode_sources'
            : sourceScope.requireCurrentSource ? 'no_current_task_video_source' : 'no_matching_episode_source',
          source_candidates: entry.sources.length ? entry.sources : sources, semantic_assessment: 'not_performed' })
          continue
        }
        const location = entry.location ?? manuscriptSourceWindows(entry.scene, timeline)
        const allowance = imageCapable
          ? Math.min(remainingFrames, Math.max(1, Math.floor(this.config.videoEvidenceMaxFrames / (selected.length * paths.length)))) : 0
        const alreadyReturned = new Set(returnedFrames.filter(frame => frame.review_id === source.review_id).map(frame => frame.frame_id))
        const plan = planManuscriptVideoPackets(entry.scene, location, allowance, alreadyReturned)
        const frameIds = plan.selected.flatMap(packet => packet.images.map(frame => frame.frame_id))
        const selectedMaterial = frameIds.length ? await readVideoSourceTimeline(ctx, agent.session, source.review_id, {
          windowSeconds: this.config.videoEvidenceWindowSeconds, maxFrames: this.config.videoEvidenceMaxFrames,
          maxBytes: this.config.videoEvidenceMaxBytes, maxTranscriptBytes: this.config.videoEvidenceMaxTranscriptBytes,
          ...transcriptCandidates === undefined ? {} : { transcriptCandidates },
          frameIds,
        }, signal) : undefined
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
        reports.push({ manuscript, ...readMaterial, source_alignment: location.basis,
          source_association: entry.singleCurrentCandidate ? 'single_current_task_video_candidate'
            : sourceScope.paths.has(source.path) ? 'logged_current_task_video_call' : 'episode_label_candidate',
          source: timeline.source, source_material_sha256: timeline.material_sha256,
          source_packet_review_id: source.review_id, automatic_images: sourceFirst ? 'bounded_source_timeline_samples' : location.automatic_images,
          image_selection_scope: sourceFirst ? 'source_timeline_samples_not_draft_alignment' : location.image_selection_scope,
          transcript_resolution: timeline.transcript_resolution,
          speech_unavailable: timeline.speech_unavailable,
          images: { returned_frame_ids: actualFrames, returned: actualFrames.length,
            requested_frame_ids: frameIds, unavailable_frame_ids: frameIds.filter(id => !packetSource.images.has(id)),
            available_in_selected_windows: availableFrames.length,
            not_returned_from_selected_windows: availableFrames
              .filter(frame => !alreadyReturned.has(frame.frame_id) && !frameIds.includes(frame.frame_id)).length },
          notice: location.notice })
      }
      const receipt: Receipt = { path: document.path, sha256: document.sha256, evidence_key: evidenceKey,
        presentation_version: MANUSCRIPT_VIDEO_PRESENTATION,
        read_source_identity_sha256: readRevisions.identity,
        source_material_sha256: sourceMaterialHash, source_identity_sha256: sourceIdentityHash, returned_frames: returnedFrames,
        scene_versions: [...deliveredScenes.filter(old => !selected.some(entry => entry.scene.id === old.id)),
          ...selected.map(entry => ({ id: entry.scene.id, sha256: entry.scene.sha256 }))] }
      const remainingImages = locations.filter(entry => entry.location !== undefined && entry.sources[0] !== undefined
        && manuscriptEvidenceFrames(entry.scene, entry.location, 1, new Set(returnedFrames
          .filter(frame => frame.review_id === entry.sources[0]?.review_id).map(frame => frame.frame_id))).length > 0)
      const text = JSON.stringify({ manuscript_video_evidence: { advisory: true, semantic_assessment: 'not_performed', receipt,
        presentation_version: MANUSCRIPT_VIDEO_PRESENTATION,
        output_association: declarations.get(document.path) ?? { basis: registered.explicitlyBound
          ? 'explicit_manuscript_work_binding' : 'successful_tool_path' },
        image_delivery: 'cached_blocks_returned_not_admission_or_understanding',
        image_route: imageCapable ? 'image_capable' : 'text_only_or_unknown_no_images_returned',
        changed_scenes: changed.length, returned_scenes: reports.length,
        not_returned_scenes: changed.filter(entry => !selected.includes(entry)).length,
        remaining_image_scenes: remainingImages.length,
        scope: 'saved_draft_changed_scenes_with_source_candidates', scenes: reports,
        notice: '这是保存后回读的当前稿、前后场和来源定位候选；模型观察不是独立事实，图片与ASR原段供当前Muse判断。未返回场景和原图不算已核对；未返回原图只是范围说明，不要求消成零或重跑整集，可选revisit读取其他缓存图。没有审批、动作行配额或交付限制。' } })
      const sourceContent = (includeIndexes: boolean) => [...packetSources.values()].flatMap(packetSource =>
        manuscriptVideoPacketContent({ ...packetSource, documentSha256: document.sha256,
          indexRows: includeIndexes ? packetSource.timeline.windows.reduce((total, window) => total + window.frames.length, 0) : 0 }))
      let content: ContentBlock[] = [{ type: 'text', text }, ...sourceContent(true)]
      if (Buffer.byteLength(JSON.stringify(content)) > this.config.videoEvidenceMaxBytes) {
        content = [{ type: 'text', text }, ...sourceContent(false)]
      }
      if (Buffer.byteLength(JSON.stringify(content)) > this.config.videoEvidenceMaxBytes) {
        throw Error('MANUSCRIPT_VIDEO_RESULT_SIZE: 局部材料超出配置，未截断原句或声明核对完成。')
      }
      const current = await readManuscript(path, cwd, this.config, signal)
      if (current.sha256 !== document.sha256) throw Error('MANUSCRIPT_VIDEO_DRAFT_CHANGED: 文稿在局部证据读取期间变化，请以新版本为准。')
      const currentReadRevisions = await readSourceRevisions(ctx, agent, current, scenes, registered.sourceBinding, this.config, signal)
      if (currentReadRevisions.identity !== readRevisions.identity) {
        throw Error('MANUSCRIPT_READ_SOURCE_CHANGED: 来源在原句差异读取期间变化，未返回过期对照或标记完成。')
      }
      output.push(...content)
    }
    return output
  }
}
