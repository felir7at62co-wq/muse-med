/** Version-bound local source materials for saved episode drafts; no semantic verdict or delivery control. */
import { realpath, stat } from 'node:fs/promises'
import { dirname, relative, resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock, Message, ToolCallBlock } from '@deepseek-ai/dsh-llm'
import { readVideoSourceTimeline, videoReviewSummaries, type VideoSourceTimeline } from '@deepseek-ai/dsh-tool-video-inspect'
import { z } from 'zod'
import type { Config } from './manuscript-revisions.ts'
import { isManuscript, readManuscript } from './manuscript-document.ts'
import { manuscriptScenes, manuscriptTextHash, type ManuscriptScene } from './manuscript-scenes.ts'

const callArguments = z.object({ file_path: z.string().optional(), draft_path: z.string().optional(),
  action: z.string().optional(), candidate_paths: z.array(z.string()).optional() })
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
  source_material_sha256: z.string(),
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

function registeredPaths(messages: readonly Message[], cwd: string, cache: MaterialCache): { paths: string[]; explicitlyBound: boolean } {
  const calls = new Map<string, ToolCallBlock>(), paths = new Set<string>()
  let bound: string[] | undefined
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
    }
    const selected = call.name === 'manuscript_work' && args.action === 'bind' ? args.candidate_paths ?? []
      : call.name === 'video_inspect' ? args.draft_path === undefined ? [] : [args.draft_path]
        : args.file_path === undefined ? [] : [args.file_path]
    for (const path of selected) if (isManuscript(path)) paths.add(resolve(cwd, path))
  }
  return { paths: bound ?? [...paths], explicitlyBound: bound !== undefined }
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

function sceneSpeech(scene: ManuscriptScene): string[] {
  return scene.text.split('\n').flatMap((line) => {
    if (/^\s*[▲△]/u.test(line)) return []
    const match = /^\s*([^：:\n]+)[：:]\s*(.+)$/u.exec(line)
    if (!match?.[2] || /^(?:人物|地点|场景|时间)$/u.test(match[1]?.trim() ?? '')) return []
    const text = normalizedSpeech(match[2])
    return text ? [text] : []
  })
}

/**
 * Locate exact ASR text candidates inside one current scene, preserving ambiguous matches.
 * @param scene - Complete current scene with actual line locations.
 * @param timeline - Verified current video material and original saved ASR rows.
 * @returns Candidate time windows and source anchors; a match does not verify speaker identity or semantic alignment.
 */
export function manuscriptSourceWindows(scene: ManuscriptScene, timeline: VideoSourceTimeline) {
  const speech = sceneSpeech(scene)
  const segments = timeline.speech?.segments.filter((segment) => {
    const text = normalizedSpeech(segment.text)
    return text.length > 0 && speech.some(line => line.includes(text) || text.includes(line))
  }) ?? []
  const anchors = segments.map(segment => ({ segment_id: segment.segment_id, start_seconds: segment.start_seconds,
    end_seconds: segment.end_seconds, source_text: segment.text }))
  const repeated = segments.filter((segment, index) => segments.some((other, otherIndex) => otherIndex !== index
    && normalizedSpeech(other.text) === normalizedSpeech(segment.text)))
  const start = segments.length ? Math.min(...segments.map(segment => segment.start_seconds)) - timeline.scope.window_seconds : undefined
  const end = segments.length ? Math.max(...segments.map(segment => segment.end_seconds)) + timeline.scope.window_seconds : undefined
  const windows = start === undefined || end === undefined ? timeline.windows
    : timeline.windows.filter(window => window.end_seconds > start && window.start_seconds < end)
  return { basis: segments.length ? 'literal_asr_text_candidates' : 'source_order_not_aligned',
    anchors, windows, repeated_source_text_segment_ids: repeated.map(segment => segment.segment_id),
    notice: '字面对应仅为定位候选；保留锚之间的连续画面和前后时间窗，包含无对白段，不把ASR当画面筛选条件。短句、语气词及重复台词保留全部命中，不作精确场景对齐或角色识别。未自动判断动作遗漏、前后衔接或剧情通过。' }
}

function framesFor(location: ReturnType<typeof manuscriptSourceWindows>, count: number, excluded: ReadonlySet<string>): string[] {
  const frames = [...new Map(location.windows.flatMap(window => window.frames).filter(frame => frame.image_available
    && frame.observation_source === 'model_authored_observation')
    .map(frame => [frame.frame_id, frame])).values()]
  const eventBoundaries = new Set(location.windows.flatMap(window => window.event_notes.flatMap(note =>
    [note.frame_ids[0], note.frame_ids.at(-1)].filter((id): id is string => id !== undefined))))
  const speechNeighbors = new Set(location.anchors.flatMap(anchor => [anchor.start_seconds, anchor.end_seconds]
    .flatMap((time) => {
      const before = frames.findLast(frame => frame.time <= time), after = frames.find(frame => frame.time >= time)
      return [before?.frame_id, after?.frame_id].filter((id): id is string => id !== undefined)
    })))
  const priority = (frame: typeof frames[number]) => [
    frame.observation?.uncertainty.trim() && !/^(?:无|无疑点|none|n\s*\/\s*a)[。.!！]?$/iu.test(frame.observation.uncertainty.trim()) ? 1 : 0,
    eventBoundaries.has(frame.frame_id) ? 1 : 0,
    speechNeighbors.has(frame.frame_id) ? 1 : 0,
    frame.observation?.change && frame.reasons.some(reason => /cut|change/u.test(reason)) ? 1 : 0,
  ]
  return frames.filter(frame => !excluded.has(frame.frame_id)).sort((a, b) => {
    const left = priority(a), right = priority(b)
    for (let index = 0; index < left.length; index++) {
      const difference = (right[index] ?? 0) - (left[index] ?? 0)
      if (difference) return difference
    }
    return a.time - b.time || a.frame_id.localeCompare(b.frame_id)
  }).slice(0, count).map(frame => frame.frame_id)
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
    if (!sources.length) return []
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
    const registered = registeredPaths(outputBoundary < 0 ? messages : messages.slice(outputBoundary), cwd, cache)
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
      const matching = scenes.map(scene => ({ scene, sources: sources.filter((source) => {
        const episode = manuscriptEpisodeNumber(scene.episode)
        return episode !== undefined && episode === manuscriptEpisodeNumber(source.episode)
          && (!sourceScope.requireCurrentSource || sourceScope.paths.has(source.path))
      }) }))
      const materials = await Promise.all([...new Set(matching.flatMap(entry => entry.sources.length === 1
        ? entry.sources.map(source => source.review_id) : []))].map(async (id) => {
        const material = await readVideoSourceTimeline(ctx, agent.session, id, {
          windowSeconds: this.config.videoEvidenceWindowSeconds, maxFrames: this.config.videoEvidenceMaxFrames,
          maxBytes: this.config.videoEvidenceMaxBytes, maxTranscriptBytes: this.config.videoEvidenceMaxTranscriptBytes,
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
      const evidenceKey = manuscriptTextHash(JSON.stringify({
        path: identityPath(document.path), sha256: document.sha256, sourceMaterialHash,
      }))
      const previousReceipt = prior.findLast(entry => entry.path === document.path && entry.evidence_key === evidenceKey)
        ?? prior.findLast(entry => entry.path === document.path)
      const carried = previousReceipt?.source_material_sha256 === sourceMaterialHash ? previousReceipt : undefined
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
      const reports = [], images: ContentBlock[] = []
      const returnedFrames = [...carriedFrames]
      for (const entry of selected) {
        const index = scenes.indexOf(entry.scene)
        const manuscript = { current: entry.scene, previous: scenes[index - 1] ?? null, next: scenes[index + 1] ?? null }
        const source = entry.sources.length === 1 ? entry.sources[0] : undefined
        const timeline = entry.timeline
        if (source === undefined || timeline === undefined) {
          reports.push({ manuscript, source_alignment: entry.sources.length ? 'ambiguous_episode_sources'
            : sourceScope.requireCurrentSource ? 'no_current_task_video_source' : 'no_matching_episode_source',
          source_candidates: entry.sources.length ? entry.sources : sources, semantic_assessment: 'not_performed' })
          continue
        }
        const location = entry.location ?? manuscriptSourceWindows(entry.scene, timeline)
        const allowance = imageCapable
          ? Math.min(remainingFrames, Math.max(1, Math.floor(this.config.videoEvidenceMaxFrames / (selected.length * paths.length)))) : 0
        const alreadyReturned = new Set(returnedFrames.filter(frame => frame.review_id === source.review_id).map(frame => frame.frame_id))
        const frameIds = framesFor(location, allowance, alreadyReturned)
        const selectedMaterial = frameIds.length ? await readVideoSourceTimeline(ctx, agent.session, source.review_id, {
          windowSeconds: this.config.videoEvidenceWindowSeconds, maxFrames: this.config.videoEvidenceMaxFrames,
          maxBytes: this.config.videoEvidenceMaxBytes, maxTranscriptBytes: this.config.videoEvidenceMaxTranscriptBytes,
          frameIds,
        }, signal) : undefined
        if (selectedMaterial && selectedMaterial.timeline.material_sha256 !== timeline.material_sha256) {
          throw Error('MANUSCRIPT_VIDEO_SOURCE_CHANGED: 来源在局部证据读取期间变化，未将材料标记为已核对。')
        }
        if (selectedMaterial) images.push(...selectedMaterial.content.filter(block => block.type !== 'text'
          || block.text.startsWith('VIDEO_FRAME ')))
        remainingFrames -= frameIds.length
        returnedFrames.push(...frameIds.map(frame_id => ({ review_id: source.review_id, frame_id })))
        const availableFrames = location.windows.flatMap(window => window.frames).filter(frame => frame.image_available)
        reports.push({ manuscript, source_alignment: location.basis, anchors: location.anchors,
          source_association: sourceScope.paths.has(source.path) ? 'logged_current_task_video_call' : 'episode_label_candidate',
          source: timeline.source, source_material_sha256: timeline.material_sha256,
          repeated_source_text_segment_ids: location.repeated_source_text_segment_ids,
          selected_windows: location.windows, speech: timeline.speech, speech_unavailable: timeline.speech_unavailable,
          images: { returned_frame_ids: frameIds, returned: frameIds.length,
            available_in_selected_windows: availableFrames.length,
            not_returned_from_selected_windows: availableFrames
              .filter(frame => !alreadyReturned.has(frame.frame_id) && !frameIds.includes(frame.frame_id)).length },
          notice: location.notice })
      }
      const receipt: Receipt = { path: document.path, sha256: document.sha256, evidence_key: evidenceKey,
        source_material_sha256: sourceMaterialHash, returned_frames: returnedFrames,
        scene_versions: [...deliveredScenes.filter(old => !selected.some(entry => entry.scene.id === old.id)),
          ...selected.map(entry => ({ id: entry.scene.id, sha256: entry.scene.sha256 }))] }
      const remainingImages = locations.filter(entry => entry.location !== undefined && entry.sources[0] !== undefined
        && framesFor(entry.location, 1, new Set(returnedFrames.filter(frame => frame.review_id === entry.sources[0]?.review_id)
          .map(frame => frame.frame_id))).length > 0)
      const text = JSON.stringify({ manuscript_video_evidence: { advisory: true, semantic_assessment: 'not_performed', receipt,
        output_association: declarations.get(document.path) ?? { basis: registered.explicitlyBound
          ? 'explicit_manuscript_work_binding' : 'successful_tool_path' },
        image_delivery: 'cached_blocks_returned_not_admission_or_understanding',
        image_route: imageCapable ? 'image_capable' : 'text_only_or_unknown_no_images_returned',
        changed_scenes: changed.length, returned_scenes: reports.length,
        not_returned_scenes: changed.filter(entry => !selected.includes(entry)).length,
        remaining_image_scenes: remainingImages.length,
        scope: 'saved_draft_changed_scenes_with_source_candidates', scenes: reports,
        notice: '这是保存后回读的当前稿、前后场和来源定位候选；模型观察不是独立事实，图片与ASR原段供当前Muse判断。未返回场景和原图不算已核对；未返回原图只是范围说明，不要求消成零或重跑整集，可选revisit读取其他缓存图。没有审批、动作行配额或交付限制。' } })
      if (Buffer.byteLength(text) > this.config.videoEvidenceMaxBytes) {
        throw Error('MANUSCRIPT_VIDEO_RESULT_SIZE: 局部材料超出配置，未截断原句或声明核对完成。')
      }
      const current = await readManuscript(path, cwd, this.config, signal)
      if (current.sha256 !== document.sha256) throw Error('MANUSCRIPT_VIDEO_DRAFT_CHANGED: 文稿在局部证据读取期间变化，请以新版本为准。')
      output.push({ type: 'text', text }, ...images)
    }
    return output
  }
}
