/** Session-local screenplay delivery declarations, verified file versions and bounded reminders. */
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { FiberState, type Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type ContentBlock } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition, ProjectionHandle } from '@deepseek-ai/dsh-session-projection'
import type { PreToolDecision, ToolExecution, ToolDispatchExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-tool-present/types'
import type {} from '@deepseek-ai/dsh-tool-executor-ptc/types'
import type {} from '@deepseek-ai/dsh-tool-executor-ptc'
import { z } from 'zod'
import { continuityFilesUnchanged, manuscriptReviewNotesUnchanged, CONTINUITY_REVIEW_PRESET } from './manuscript-continuity.ts'
import { isManuscript, readManuscript, type DocumentLimits, type ManuscriptDocument } from './manuscript-document.ts'
import { manuscriptDeliveryIntent, manuscriptTaskRequest, ManuscriptTaskContextLimitError,
  type ManuscriptTaskRequest } from './manuscript-task-intent.ts'
import type {} from './manuscript-revisions.ts'
import type { ManuscriptNoteLimits } from './manuscript-notes.ts'
import { videoSourceInputsSchema, videoSourceManifestSchema, type VideoSourceManifest }
  from './manuscript-video-source-review.ts'
import { screenplayFacts, type ScreenplayFormatLimits } from './screenplay-episode-facts.ts'
import type { VideoEpisodeFrames } from './video-episode-frames.ts'

export { manuscriptDeliveryIntent } from './manuscript-task-intent.ts'

/** Deployment limits; completed deliveries never become a global adopted-manuscript selection. */
export interface ManuscriptDeliveryConfig extends DocumentLimits, ManuscriptNoteLimits, ScreenplayFormatLimits {
  maxDocuments: number
  continuityDeliveryChecks: boolean
  continuityMaxDeliveryCorrections: number
}

/** Optional source readers; absent verification preserves text delivery and refuses reviewed video delivery. */
export interface ManuscriptDeliveryOptions {
  /** Re-read the exact source, ASR and cached image versions for this Session; false denies reviewed delivery. */
  verifyVideoSource?: (session: Session, manifest: VideoSourceManifest, signal: AbortSignal) => Promise<boolean>
  /** Per-episode frame-observation states of one source folder; absent leaves every episode `unchecked`. */
  episodeFrames?: (session: Session, videoDir: string, episodes: readonly number[], signal: AbortSignal) => Promise<VideoEpisodeFrames>
}

const rangeSchema = z.object({ start: z.number().int().positive(), end: z.number().int().positive() })
const selectionSchema = z.discriminatedUnion('kind', [z.object({ kind: z.literal('full') }),
  z.object({ kind: z.literal('lines'), start: z.number().int().positive(), end: z.number().int().positive() }),
  z.object({ kind: z.literal('episodes'), requested: z.array(z.number().int()), included: z.array(z.number().int()), adjacent: z.array(z.number().int()) })])
const coverageSchema = z.object({ basis: z.literal('returned_text_lines'), read_ranges: z.array(rangeSchema),
  unread_ranges: z.array(rangeSchema), full_document: z.boolean() })
const identitySchema = z.object({ role: z.enum(['current', 'reference', 'candidate']), path: z.string(),
  file_sha256: z.string().regex(/^[a-f0-9]{64}$/u), text_sha256: z.string().regex(/^[a-f0-9]{64}$/u) })
const documentSchema = identitySchema.extend({ line_count: z.number().int(), selection: selectionSchema, coverage: coverageSchema })
const scopeSchema = z.object({ selection: selectionSchema, coverage: coverageSchema })
const episodePlanSchema = z.object({ checks: z.array(z.object({ from_episode: z.number().int().positive(),
  to_episode: z.number().int().positive() })) })
const reviewSchema = z.object({ state: z.literal('continuity'), status: z.enum(['consistent', 'issues', 'unknown']),
  reason: z.string(), target: identitySchema, documents: z.array(documentSchema),
  findings: z.array(z.object({ evidence: z.array(identitySchema.extend({ line: z.number().int().positive() })) })),
  unknowns: z.array(z.string()), file_verification: z.enum(['verified', 'changed', 'unavailable']),
  notes_sha256: z.string().regex(/^[a-f0-9]{64}$/u).optional(), episode_plan: episodePlanSchema.optional(),
  repetition_review: z.literal(true).optional() })
const sourceReviewSchema = z.object({ state: z.literal('video_source_review'), status: z.enum(['consistent', 'issues', 'unknown']),
  reason: z.string(), target: identitySchema, documents: z.array(documentSchema), findings: z.array(z.never()),
  unknowns: z.array(z.string()), file_verification: z.enum(['verified', 'changed', 'unavailable']),
  source_verification: z.enum(['verified', 'changed', 'unavailable']), source_manifest: videoSourceManifestSchema.optional(),
  notes_sha256: z.string().regex(/^[a-f0-9]{64}$/u).optional() })
const sourceBindingSchema = z.object({ source_manifest: videoSourceManifestSchema, dependencies: z.array(documentSchema),
  notes_sha256: z.string().regex(/^[a-f0-9]{64}$/u).optional() })
const frameStateSchema = z.enum(['complete', 'incomplete', 'stale', 'not_viewed', 'no_video', 'ambiguous_video', 'unchecked'])
const videoEpisodeSchema = z.object({ episode: z.number().int().positive(), frames: frameStateSchema,
  frame_count: z.number().int().nonnegative().optional(), recorded: z.number().int().nonnegative().optional(),
  scenes: z.number().int().nonnegative(), action_lines: z.number().int().nonnegative(),
  dialogue_lines: z.number().int().nonnegative(), format_errors: z.number().int().nonnegative(),
  warnings: z.number().int().nonnegative() })
const videoCheckSchema = z.object({ video_dir: z.string().nullable(), videos: z.number().int().nonnegative().nullable(),
  episodes: z.array(videoEpisodeSchema), format_errors: z.array(z.string()), format_error_count: z.number().int().nonnegative(),
  warnings: z.array(z.string()), warning_count: z.number().int().nonnegative() })
const fileSchema = z.object({ path: z.string(), file_sha256: z.string(), aliases: z.array(z.string()),
  label: z.string(), review_scope: scopeSchema.nullable(), dependencies: z.array(documentSchema),
  notes_sha256: z.string().regex(/^[a-f0-9]{64}$/u).optional(), source_reviews: z.array(sourceBindingSchema).optional(),
  video_check: videoCheckSchema.optional() })
const declarationSchema = z.object({ state: z.literal('delivery'), mode: z.enum(['reviewed', 'draft']), advisory: z.literal(true),
  task_id: z.string(), files: z.array(fileSchema), note: z.string().optional(), source_mode: z.literal('video').optional() })
const factSchema = z.union([reviewSchema, sourceReviewSchema, declarationSchema.omit({ note: true })])
const metadataFactSchema = z.object({ manuscript_delivery_fact: factSchema })
const metadataJsonSchema = z.json()
/** Exact selected text ranges displayed beside a reviewed file; null means explicit draft. */
export type ManuscriptDeliveryScope = z.infer<typeof scopeSchema>
/** Host-verified declaration; the caller must still successfully invoke present. */
export type ManuscriptDeliveryResult = z.infer<typeof declarationSchema>
type Review = z.infer<typeof reviewSchema>
type SourceReview = z.infer<typeof sourceReviewSchema>
const sourceRecordSchema = z.object({ review: sourceReviewSchema, inputs: videoSourceInputsSchema.optional() })
type SourceRecord = z.infer<typeof sourceRecordSchema>
type SourceBinding = z.infer<typeof sourceBindingSchema>
type DeliveryFile = z.infer<typeof fileSchema>
type Range = z.infer<typeof rangeSchema>
const blockSchema = identitySchema.extend({ ranges: z.array(rangeSchema), repetition: z.boolean() })
type ReviewBlock = z.infer<typeof blockSchema>
const rowSchema = z.object({ path: z.string(), sha: z.string(), review: reviewSchema.nullable(),
  unresolved: z.array(blockSchema), unresolved_overflow: z.boolean(),
  source_reviews: z.array(sourceRecordSchema), source_overflow: z.boolean(),
  declaration: declarationSchema.nullable(), presented: z.boolean() })
type Row = z.infer<typeof rowSchema>
const callSchema = z.object({ id: z.string(), turn: z.number(), name: z.string(), args: z.string() })
const receiptSchema = z.object({ call_id: z.string(), task_id: z.string(), files: z.array(fileSchema), mode: z.enum(['reviewed', 'draft']) })
const coverageFactSchema = z.object({ path: z.string(), file_sha256: z.string(), episodes: z.array(z.number().int().positive()) })
const coverageResultSchema = z.object({ state: z.literal('transcript_coverage'), episodes: z.array(z.object({
  label: z.string(), draft: z.object({ path: z.string(), file_sha256: z.string() }).nullish() })) })
const stateSchema = z.object({ task_id: z.string(), writing: z.boolean(), file_request: z.boolean(), cwd: z.string(),
  source_required: z.boolean(),
  turn: z.number(), corrections: z.number(), fingerprint: z.string(), overflow: z.boolean(),
  rows: z.array(rowSchema), outputs: z.array(z.string()), calls: z.array(callSchema),
  packets: z.array(receiptSchema.extend({ turn: z.number() })), presented: z.array(z.object({ turn: z.number(), id: z.string() })),
  coverage: z.array(coverageFactSchema) })
type DeliveryState = z.infer<typeof stateSchema>
type CoverageFact = z.infer<typeof coverageFactSchema>
type VideoCheck = z.infer<typeof videoCheckSchema>
const presentSchema = z.object({ files: z.array(z.object({ path: z.string(), description: z.string().optional() })) })
const deliveryNoticeSchema = z.object({ manuscript_delivery_notice: z.object({
  task_id: z.string(), fingerprint: z.string(), attempt: z.number(),
}) })

function textOf(content: readonly ContentBlock[]): string {
  return content.filter(block => block.type === 'text').map(block => block.text).join('\n')
}
function json(text: string): unknown {
  try { return JSON.parse(text) }
  catch (error) { if (error instanceof SyntaxError) return undefined; throw error }
}
function parseBlocks<T>(content: readonly ContentBlock[], schema: z.ZodType<T>): T | undefined {
  for (const block of content) {
    if (block.type !== 'text') continue
    const value = schema.safeParse(json(block.text))
    if (value.success) return value.data
  }
  return undefined
}

/** Preserve compact Host-issued facts when a PTC log policy replaces its content with a preview.
 * @param value - Actual successful manuscript_revision canonical string value.
 * @returns Parsed versions, ranges and judgment flags; freeform draft notes never become verification facts.
 */
export function manuscriptDeliveryMetadata(value: string): z.infer<typeof metadataJsonSchema> | null {
  const parsed = factSchema.safeParse(json(value))
  return parsed.success ? metadataJsonSchema.parse({ manuscript_delivery_fact: parsed.data }) : null
}

/** Recognize screenplay body structure only after an actual writing request identified a path.
 * @param text - Extracted final document body; it never supplies executable instructions.
 * @returns Whether scene headings and dramatic action/dialogue are present together.
 */
export function hasManuscriptDeliveryStructure(text: string): boolean {
  const scene = /^\s*(?:#{1,6}\s*)?(?:\d+[—－\-]\d+[^\n]*|(?:场景|场次)[：:\s].+|(?:INT|EXT|INT\/EXT)\.[^\n]*)$/imu.test(text)
  const dramatic = /^\s*(?:[▲△]|[\p{Script=Han}A-Za-z][\p{Script=Han}A-Za-z0-9·]{0,15}(?:（[^\n）]*）|\([^\n)]*\))?[：:]).+/mu.test(text)
  return scene && dramatic
}

function mergeRanges(ranges: Range[]): Range[] {
  const ordered = ranges.toSorted((a, b) => a.start - b.start), merged: Range[] = []
  for (const range of ordered) {
    const last = merged.at(-1)
    if (last !== undefined && range.start <= last.end + 1) last.end = Math.max(last.end, range.end)
    else merged.push({ ...range })
  }
  return merged
}
function sameIdentity(a: z.infer<typeof identitySchema>, b: z.infer<typeof identitySchema>): boolean {
  return a.path === b.path && a.file_sha256 === b.file_sha256 && a.text_sha256 === b.text_sha256
}

type SourceScope = { review_id: string; seconds: Range; draft: Range; frames: string[] } & (
  { kind: 'source'; path: string; version: string } | { kind: 'selector' })

function sourceScopes(record: SourceRecord): SourceScope[] {
  return record.review.source_manifest?.sources.map(source => ({ kind: 'source' as const, path: source.path,
    version: source.source_version, review_id: source.review_id,
    seconds: { start: source.start_seconds, end: source.end_seconds }, draft: source.draft_lines,
    frames: source.frames.map(frame => frame.frame_id) }))
    ?? record.inputs?.map(input => ({ kind: 'selector' as const, review_id: input.review_id,
      seconds: { start: input.start_seconds, end: input.end_seconds }, draft: input.draft_lines, frames: input.frame_ids })) ?? []
}

function sourcePassing(review: SourceReview): review is SourceReview & { source_manifest: VideoSourceManifest } {
  return review.status === 'consistent' && review.reason === 'reviewed' && review.file_verification === 'verified'
    && review.source_verification === 'verified' && review.unknowns.length === 0
    && review.source_manifest !== undefined && review.source_manifest.sources.length > 0
    && review.source_manifest.unmapped_lines.length === 0
}

function rangeCovered(range: Range, inputs: readonly Range[], adjacent: number): boolean {
  const merged: Range[] = []
  for (const input of inputs.toSorted((a, b) => a.start - b.start)) {
    const last = merged.at(-1)
    if (last !== undefined && input.start <= last.end + adjacent) last.end = Math.max(last.end, input.end)
    else merged.push({ ...input })
  }
  return merged.some(input => input.start <= range.start && input.end >= range.end)
}

function sourceCoveredBy(passing: readonly SourceRecord[], previous: SourceRecord): boolean {
  const target = previous.review.documents.find(document => sameIdentity(document, previous.review.target))
  const relevant = passing.filter(record => sourcePassing(record.review) && sameIdentity(record.review.target, previous.review.target))
  const draftRanges = relevant.flatMap(record => record.review.documents
    .filter(document => sameIdentity(document, record.review.target)).flatMap(document => document.coverage.read_ranges))
  if (target === undefined || !target.coverage.read_ranges.every(range => rangeCovered(range, draftRanges, 1))) return false
  const previousScopes = sourceScopes(previous), nextScopes = relevant.flatMap(sourceScopes)
  if (previousScopes.length === 0) return false
  return previousScopes.every((old) => {
    const matches = nextScopes.filter(scope => old.kind === 'source'
      ? scope.kind === 'source' && scope.path === old.path : scope.review_id === old.review_id)
    const coversScope = (scopes: readonly SourceScope[]): boolean => rangeCovered(old.seconds, scopes.map(scope => scope.seconds), 0)
      && rangeCovered(old.draft, scopes.map(scope => scope.draft), 1)
    if (old.kind === 'selector') return coversScope(matches)
    const versions = new Set(matches.flatMap(scope => scope.kind === 'source' ? [scope.version] : []))
    return [...versions].some((version) => {
      const scopes = matches.filter(scope => scope.kind === 'source' && scope.version === version)
      return coversScope(scopes)
        && (version !== old.version || old.frames.every(frame => scopes.some(scope => scope.frames.includes(frame))))
    })
  })
}

function rememberSourceReview(state: DeliveryState, review: SourceReview, inputs: SourceRecord['inputs'], max: number): DeliveryState {
  const previous = state.rows.find(row => row.path === review.target.path)
  const same = previous?.sha === review.target.file_sha256
  const incoming: SourceRecord = { review, ...inputs === undefined ? {} : { inputs } }
  const old = same ? previous.source_reviews : []
  const signature = (record: SourceRecord): string => JSON.stringify([sourceScopes(record), record.review.documents
    .find(document => sameIdentity(document, record.review.target))?.coverage.read_ranges])
  const retained = sourcePassing(review) ? old.filter((record, index) =>
    !sourceCoveredBy(sourcePassing(record.review) ? [incoming]
      : [...old.slice(index + 1).filter(later => sourcePassing(later.review)), incoming], record))
    : old.filter(record => signature(record) !== signature(incoming))
  const records = [...retained, incoming]
  return upsert(state, { path: review.target.path, sha: review.target.file_sha256,
    review: same ? previous.review : null, unresolved: same ? previous.unresolved : [],
    unresolved_overflow: same && previous.unresolved_overflow,
    source_reviews: records.slice(0, max), source_overflow: same && previous.source_overflow || records.length > max,
    declaration: same ? previous.declaration : null, presented: false }, max)
}
function blocksOf(review: Review): ReviewBlock[] {
  return review.documents.map((document) => {
    const lines = review.findings.flatMap(finding => finding.evidence
      .filter(evidence => sameIdentity(evidence, document)).map(evidence => evidence.line))
    const ranges = review.status === 'unknown' || lines.length === 0 ? document.coverage.read_ranges
      : lines.map(line => ({ start: line, end: line }))
    return { role: document.role, path: document.path, file_sha256: document.file_sha256,
      text_sha256: document.text_sha256, ranges: mergeRanges(ranges), repetition: review.repetition_review === true }
  })
}
function combineBlocks(a: ReviewBlock[], b: ReviewBlock[]): ReviewBlock[] {
  const result = a.map(block => ({ ...block, ranges: [...block.ranges] }))
  for (const block of b) {
    const previous = result.find(item => sameIdentity(item, block) && item.repetition === block.repetition)
    if (previous === undefined) result.push(block)
    else {
      const ranges = [...previous.ranges, ...block.ranges]
      previous.ranges = ranges.length === 0 ? [] : [{
        start: Math.min(...ranges.map(range => range.start)), end: Math.max(...ranges.map(range => range.end)),
      }]
    }
  }
  return result
}
function covers(review: Review, block: ReviewBlock): boolean {
  const wrongPurpose = block.repetition ? review.repetition_review !== true
    : review.episode_plan !== undefined || review.repetition_review === true
  if (wrongPurpose) return false
  const document = review.documents.find(item => sameIdentity(item, block))
  return document !== undefined && block.ranges.every(range => document.coverage.read_ranges
    .some(covered => covered.start <= range.start && covered.end >= range.end))
}
function upsert(state: DeliveryState, row: Row, max: number): DeliveryState {
  const rows = state.rows.filter(item => item.path !== row.path)
  if (rows.length >= max) {
    const index = rows.findIndex(item => item.presented)
    if (index < 0) return { ...state, overflow: true }
    rows.splice(index, 1)
  }
  return { ...state, rows: [...rows, row] }
}
function rememberReview(state: DeliveryState, review: Review, max: number): DeliveryState {
  const previous = state.rows.find(row => row.path === review.target.path)
  const old = previous?.sha === review.target.file_sha256 ? previous.unresolved : []
  const passing = review.status === 'consistent' && review.reason === 'reviewed' && review.file_verification === 'verified'
    && review.findings.length === 0 && review.unknowns.length === 0
  const unresolved = passing ? old.filter(block => !covers(review, block)) : combineBlocks(old, blocksOf(review))
  const unresolvedOverflow = previous?.sha === review.target.file_sha256 && previous.unresolved_overflow || unresolved.length > max
  return upsert(state, { path: review.target.path, sha: review.target.file_sha256, review,
    unresolved: unresolved.slice(0, max), unresolved_overflow: unresolvedOverflow,
    source_reviews: previous?.sha === review.target.file_sha256 ? previous.source_reviews : [],
    source_overflow: previous?.sha === review.target.file_sha256 && previous.source_overflow,
    declaration: previous?.declaration ?? null, presented: false }, max)
}
function joinPresented(state: DeliveryState): DeliveryState {
  const matched = state.packets.filter(packet => state.presented.some(item => item.turn === packet.turn && item.id === packet.call_id))
  if (matched.length === 0) return state
  const files = matched.flatMap(packet => packet.files)
  return { ...state, rows: state.rows.map(row => files.some(file => file.path === row.path && file.file_sha256 === row.sha)
    ? { ...row, presented: true } : row),
  outputs: state.outputs.filter(path => !files.some(file => file.path === path || file.aliases.includes(path))),
  packets: state.packets.filter(packet => !matched.includes(packet)),
  presented: state.presented.filter(item => !matched.some(packet => packet.turn === item.turn && packet.call_id === item.id)) }
}

/** Build the private, bounded recovery fold; filesystem facts enter only through actual tool results.
 * @param maxDocuments - Maximum currently relevant output paths and review targets per task.
 * @returns Host-only projection definition; no client or Session event vocabulary is added.
 */
function manuscriptDeliveryProjection(maxDocuments: number): ProjectionDefinition<'muse.manuscript-delivery', DeliveryState> {
  return { key: 'muse.manuscript-delivery', stateVersion: 10, stateSchema,
    init: header => ({ task_id: '', writing: false, file_request: false, cwd: header.cwd ?? '', turn: 0, corrections: 0,
      source_required: false, fingerprint: '', overflow: false, rows: [], outputs: [], calls: [], packets: [],
      presented: [], coverage: [] }),
    apply(state, event) { return foldDelivery(state, event, maxDocuments) } }
}

function coverageEpisode(label: string): number | undefined {
  const digits = /^第\s*(\d+)\s*集/u.exec(label.normalize('NFKC').trim())?.[1]
  return digits === undefined ? undefined : Number(digits)
}

/** Keep the newest measured episode set per exact file version; versions of other files stay until the bound evicts the oldest. */
function rememberCoverage(state: DeliveryState, value: z.infer<typeof coverageResultSchema>, max: number): DeliveryState {
  const measured = new Map<string, CoverageFact>()
  for (const episode of value.episodes) {
    const number = coverageEpisode(episode.label)
    if (number === undefined || episode.draft === undefined || episode.draft === null) continue
    const key = JSON.stringify([episode.draft.path, episode.draft.file_sha256])
    const fact = measured.get(key) ?? { path: episode.draft.path, file_sha256: episode.draft.file_sha256, episodes: [] }
    if (!fact.episodes.includes(number)) fact.episodes.push(number)
    measured.set(key, fact)
  }
  if (measured.size === 0) return state
  const merged = [...state.coverage]
  for (const fact of measured.values()) {
    const index = merged.findIndex(item => item.path === fact.path && item.file_sha256 === fact.file_sha256)
    const previous = index < 0 ? undefined : merged.splice(index, 1)[0]
    merged.push({ ...fact, episodes: [...new Set([...previous?.episodes ?? [], ...fact.episodes])].toSorted((a, b) => a - b) })
  }
  return { ...state, coverage: merged.slice(-max * 4) }
}
function foldDelivery(state: DeliveryState, event: SessionEvent, max: number): DeliveryState {
  if ('surfaceOp' in event && event.surfaceOp !== 'append') return state
  if (event.type === 'user/message') {
    if (event.data.source.kind === 'muse-manuscript') {
      const notice = parseBlocks(event.data.content, deliveryNoticeSchema)?.manuscript_delivery_notice
      return notice?.task_id === state.task_id
        ? { ...state, corrections: Math.max(state.corrections, notice.attempt), fingerprint: notice.fingerprint } : state
    }
    if (event.data.source.kind !== 'user') return state
    const intent = manuscriptDeliveryIntent(textOf(event.data.content))
    if (intent.continuation && state.writing) return intent.file && !state.file_request ? { ...state, file_request: true } : state
    return { ...state, task_id: String(event.seq), writing: intent.writing, file_request: intent.writing && intent.file,
      source_required: false, corrections: 0, fingerprint: '', overflow: false, rows: [], outputs: [], calls: [],
      packets: [], presented: [] }
  }
  if (event.type === 'turn/start') return { ...state, turn: event.data.turn,
    corrections: 0, fingerprint: '', calls: [], packets: [], presented: [] }
  const start = event.type === 'tool/call'
    ? { id: event.data.callId, turn: event.data.turn, name: event.data.name, args: event.data.arguments }
    : event.type === 'tool/ptc-dispatch-start'
      ? { id: event.data.subCallId, turn: state.turn, name: event.data.name, args: JSON.stringify(event.data.arguments) } : undefined
  if (start !== undefined) {
    if (!['manuscript_revision', 'present', 'write', 'edit', 'screenplay_export_docx', 'skill'].includes(start.name)) return state
    const args = start.name === 'manuscript_revision'
      ? z.object({ action: z.string(), source_mode: z.literal('video').optional() }).safeParse(json(start.args)) : undefined
    const sourceRequired = args?.success && (args.data.action === 'source_fidelity'
      || args.data.action === 'delivery' && args.data.source_mode === 'video')
    const calls = [...state.calls.filter(call => call.id !== start.id || call.turn !== start.turn), start]
    return { ...state, source_required: state.source_required || sourceRequired === true,
      overflow: state.overflow || calls.length > max * 4, calls: calls.slice(-max * 4),
      packets: state.packets.filter(packet => packet.call_id !== start.id || packet.turn !== start.turn),
      presented: state.presented.filter(item => item.id !== start.id || item.turn !== start.turn) }
  }
  if (event.type === 'deliverables/presented') {
    if (!state.calls.some(call => call.id === event.data.callId && call.turn === event.data.turn && call.name === 'present')
      && !state.packets.some(packet => packet.call_id === event.data.callId && packet.turn === event.data.turn)) return state
    return joinPresented({ ...state, presented: [...state.presented, { turn: event.data.turn, id: event.data.callId }].slice(-max * 4) })
  }
  const result = event.type === 'tool/result'
    ? { id: event.data.message.toolCallId, turn: event.data.turn,
      content: event.data.message.content, error: event.data.message.isError, meta: event.data.meta }
    : event.type === 'tool/ptc-dispatch'
      ? { id: event.data.subCallId, turn: state.turn,
        content: event.data.content, error: event.data.isError, meta: event.data.meta } : undefined
  if (result === undefined) return state
  const call = state.calls.find(item => item.id === result.id && item.turn === result.turn)
  if (call === undefined) return state
  let next = { ...state, calls: state.calls.filter(item => item !== call) }
  if (result.error) return next
  if (call.name === 'skill') {
    const args = z.object({ name: z.literal('video-to-screenplay') }).safeParse(json(call.args))
    return args.success ? { ...next, source_required: true } : next
  }
  if (call.name === 'manuscript_revision') {
    const args = z.object({ action: z.string() }).safeParse(json(call.args))
    if (!args.success) return next
    const metadata = metadataFactSchema.safeParse(result.meta)
    const fact = metadata.success ? metadata.data.manuscript_delivery_fact : undefined
    if (args.data.action === 'transcript_coverage') {
      const coverage = parseBlocks(result.content, coverageResultSchema)
      return coverage === undefined ? next : rememberCoverage(next, coverage, max)
    }
    if (['continuity', 'cross_episode', 'repetitions'].includes(args.data.action)) {
      const review = fact?.state === 'continuity' ? fact : parseBlocks(result.content, reviewSchema)
      return review === undefined ? next : rememberReview(next, review, max)
    }
    if (args.data.action === 'source_fidelity') {
      const review = fact?.state === 'video_source_review' ? fact : parseBlocks(result.content, sourceReviewSchema)
      if (review === undefined) return next
      const sources = z.object({ video_sources: videoSourceInputsSchema }).safeParse(json(call.args))
      return rememberSourceReview(next, review, sources.success ? sources.data.video_sources : review.source_manifest?.inputs, max)
    }
    if (args.data.action === 'delivery') {
      const declaration = fact?.state === 'delivery' ? fact : parseBlocks(result.content, declarationSchema)
      if (declaration === undefined || declaration.task_id !== state.task_id) return next
      for (const file of declaration.files) {
        const old = next.rows.find(row => row.path === file.path)
        next = upsert(next, { path: file.path, sha: file.file_sha256, review: old?.sha === file.file_sha256 ? old.review : null,
          unresolved: old?.sha === file.file_sha256 ? old.unresolved : [],
          unresolved_overflow: old?.sha === file.file_sha256 ? old.unresolved_overflow : false,
          source_reviews: old?.sha === file.file_sha256 ? old.source_reviews : [],
          source_overflow: old?.sha === file.file_sha256 && old.source_overflow, declaration, presented: false }, max)
      }
      return declaration.source_mode === 'video' ? { ...next, source_required: true } : next
    }
  }
  if (call.name === 'present') {
    const packet = parseBlocks(result.content, z.object({ manuscript_delivery_receipt: receiptSchema }))
      ?.manuscript_delivery_receipt
    if (packet === undefined || packet.call_id !== call.id || packet.task_id !== state.task_id) return next
    return joinPresented({ ...next, packets: [...next.packets, { ...packet, turn: call.turn }].slice(-max * 4) })
  }
  if (state.writing) {
    const args = z.object({ file_path: z.string().optional(), output: z.string().optional() }).safeParse(json(call.args))
    const path = args.success ? args.data.file_path ?? args.data.output : undefined
    if (path !== undefined && isManuscript(path)) {
      const paths = [...new Set([...state.outputs, resolve(state.cwd, path)])]
      return { ...next, outputs: paths.slice(0, max), overflow: state.overflow || paths.length > max }
    }
  }
  return next
}

function labelOf(review: Review): string {
  const target = review.documents.find(document => sameIdentity(document, review.target))
  if (target === undefined) throw failure('MANUSCRIPT_DELIVERY_REVIEW_REQUIRED', '审校结果缺少目标文件范围。')
  if (review.episode_plan !== undefined) {
    const pairs = review.episode_plan.checks.map(pair => `${pair.from_episode}→${pair.to_episode}`).join('、')
    return `已复核跨集接缝${pairs}（仅此范围）`
  }
  if (target.coverage.full_document) return review.repetition_review === true
    ? '已复核本文件重复情节（仅当前提取正文与版本）' : '已复核本文件全部提取正文（仅当前版本）'
  if (target.selection.kind === 'episodes') {
    const numbers = target.selection.included.toSorted((a, b) => a - b)
    const consecutive = numbers.every((number, index) => index === 0 || number - 1 === numbers[index - 1])
    const episodes = consecutive && numbers.length > 1 ? `${numbers[0]}–${numbers.at(-1)}` : numbers.join('、')
    return `已复核第${episodes}集${review.repetition_review === true ? '重复情节' : ''}（仅此范围）`
  }
  const ranges = target.coverage.read_ranges.map(range => range.start === range.end ? String(range.start) : `${range.start}–${range.end}`).join('、')
  return `已复核正文第${ranges}行${review.repetition_review === true ? '重复情节' : ''}（仅此范围）`
}

function sourceLabel(bindings: readonly SourceBinding[]): string {
  const scopes = bindings.flatMap(binding => binding.source_manifest.sources.map(source =>
    `${source.path} ${source.start_seconds}–${source.end_seconds}秒内${source.frames.length}个原帧及保存ASR→正文第${source.draft_lines.start}–${source.draft_lines.end}行`))
  return `；来源仅核对抽样范围：${scopes.join('；')}（未校听原音，未核验全片）`
}

function sourceCoverageProblem(bindings: readonly SourceBinding[], scope: ManuscriptDeliveryScope | null,
  document: ManuscriptDocument): Error | undefined {
  const textHash = createHash('sha256').update(document.text).digest('hex')
  if (scope === null || bindings.some(binding => binding.source_manifest.target.path !== document.path
    || binding.source_manifest.target.file_sha256 !== document.sha256 || binding.source_manifest.target.text_sha256 !== textHash)) {
    return failure('MANUSCRIPT_DELIVERY_SOURCE_REQUIRED', '来源核对没有绑定当前最终稿路径及正文版本，请重新核对。')
  }
  const mapped = bindings.flatMap(binding => binding.source_manifest.mapped_ranges)
  const missing = document.text.split(/\r\n|\r|\n/u).flatMap((text, index) => text.trim().length > 0
    && scope.coverage.read_ranges.some(range => range.start <= index + 1 && range.end >= index + 1)
    && !mapped.some(range => range.start <= index + 1 && range.end >= index + 1) ? [index + 1] : [])
  return missing.length === 0 ? undefined : failure('MANUSCRIPT_DELIVERY_SOURCE_REQUIRED',
    `已审正文仍有非空行缺少来源对应：${missing.join('、')}。请补充来源核对，或缩小正文审校范围后以局部范围交付。`)
}
function failure(code: string, reason: string): Error {
  return Object.assign(new Error(`${code}: ${reason}`), { code })
}

function episodeRanges(episodes: readonly number[]): string {
  const ranges: { start: number; end: number }[] = []
  for (const episode of [...new Set(episodes)].toSorted((a, b) => a - b)) {
    const last = ranges.at(-1)
    if (last !== undefined && last.end + 1 === episode) last.end = episode
    else ranges.push({ start: episode, end: episode })
  }
  return ranges.map(range => range.start === range.end ? String(range.start) : `${range.start}–${range.end}`).join('、')
}

const FRAME_STATE_TEXT: Record<z.infer<typeof frameStateSchema>, string> = {
  complete: '已逐帧看完并记录', incomplete: '有帧未看或未记录', stale: '看帧记录对应的是旧版原片', not_viewed: '没有看帧记录',
  no_video: '原片目录里找不到这一集', ambiguous_video: '原片目录里这一集有多个文件', unchecked: '未核对画面',
}

function frameGaps(check: VideoCheck): string[] {
  if (check.video_dir === null) return ['交付登记没有给出 video_dir（本剧原片目录），画面未核对']
  const states = Object.keys(FRAME_STATE_TEXT).filter((state): state is z.infer<typeof frameStateSchema> => state !== 'complete')
  return states.flatMap((state) => {
    const episodes = check.episodes.filter(episode => episode.frames === state).map(episode => episode.episode)
    return episodes.length === 0 ? [] : [`第${episodeRanges(episodes)}集${FRAME_STATE_TEXT[state]}`]
  })
}

function formatGaps(check: VideoCheck): string[] {
  const episodes = check.episodes.filter(episode => episode.format_errors > 0).map(episode => episode.episode)
  if (check.format_error_count === 0) return []
  return [`${episodes.length > 0 ? `第${episodeRanges(episodes)}集` : '全文'}有${check.format_error_count}处格式问题（见 video_check.format_errors）`]
}

function videoLabel(check: VideoCheck): string {
  const gaps = [...formatGaps(check), ...frameGaps(check)]
  return gaps.length > 0 ? gaps.join('，') : `第${episodeRanges(check.episodes.map(episode => episode.episode))}集画面已逐帧记录`
}
function denial(error: Error & { code?: string }): PreToolDecision {
  return { kind: 'deny', reason: error.message, info: { name: 'ManuscriptDeliveryError', code: error.code ?? 'MANUSCRIPT_DELIVERY_REVIEW_REQUIRED' } }
}
interface ActiveOperation { controller: AbortController; done: Promise<void>; finish(): void }
interface PendingCommit { done: Promise<void>; finish(): void }

/** Owns asynchronous file checks while all recoverable facts remain in the private Session projection. */
export class ManuscriptDelivery {
  private accepting = true
  private active = new Set<ActiveOperation>()
  private cleanup: (() => Promise<void>) | undefined
  private disposal: Promise<void> | undefined
  private commits = new Map<Session, Map<string, PendingCommit>>()
  private pending = new WeakMap<ToolExecution, {
    files: DeliveryFile[]
    reviewedFiles: string[]
    mode: 'reviewed' | 'draft'
    task: string
    lease: ActiveOperation
  }>()
  constructor(private readonly config: ManuscriptDeliveryConfig, private readonly handle: ProjectionHandle<DeliveryState>,
    private readonly reportReadFailure: (path: string, error: unknown) => void,
    private readonly options: ManuscriptDeliveryOptions = {}) {}

  /** Attach the composite effect after all hooks are installed.
   * @param cleanup - Effect disposer that drains operations before releasing hooks and projection.
   */
  attach(cleanup: () => Promise<void>): void { this.cleanup = cleanup }

  private async operate<T>(signal: AbortSignal, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (!this.accepting) throw Error('Manuscript delivery owner was disposed')
    const controller = new AbortController()
    let finish!: () => void
    const done = new Promise<void>((resolveDone) => { finish = resolveDone })
    const operation = { controller, done, finish }
    this.active.add(operation)
    const combined = AbortSignal.any([signal, controller.signal])
    try { combined.throwIfAborted(); return await run(combined) }
    finally { this.active.delete(operation); finish() }
  }

  /** Stop new checks and await every owned filesystem operation before unregistering hooks.
   * @returns Completion of the same idempotent teardown operation.
   */
  dispose(): Promise<void> {
    this.accepting = false
    for (const operation of this.active) operation.controller.abort(Error('Manuscript delivery owner was disposed'))
    return this.disposal ??= this.cleanup?.() ?? this.drain()
  }

  /** Drain checks; retained as the final child effect so it runs before hook release.
   * @returns Completion after admission closes and active checks settle.
   */
  async drain(): Promise<void> {
    this.accepting = false
    for (const operation of this.active) operation.controller.abort(Error('Manuscript delivery owner was disposed'))
    for (const session of this.commits.values()) for (const commit of session.values()) commit.finish()
    this.commits.clear()
    await Promise.allSettled([...this.active].map(operation => operation.done))
  }

  private async awaitCommitted(agent: Agent, signal: AbortSignal): Promise<void> {
    while ((this.commits.get(agent.session)?.size ?? 0) > 0) {
      signal.throwIfAborted()
      const commits = [...this.commits.get(agent.session)?.values() ?? []]
      await new Promise<void>((resolveDone, reject) => {
        const abort = (): void => { reject(signal.reason instanceof Error ? signal.reason : new Error('Delivery check was cancelled')) }
        signal.addEventListener('abort', abort, { once: true })
        void Promise.all(commits.map(commit => commit.done)).then(() => {
          signal.removeEventListener('abort', abort)
          resolveDone()
        })
      })
    }
    signal.throwIfAborted()
  }

  /** Wait for the durable PTC dispatch record before a following subcall consumes its fact.
   * @param execution - Finalized nested call; only correlation promises are retained.
   * @param result - Authoritative tool result, before its separate PTC log commit.
   */
  pendingCommit(execution: ToolExecution, result: Readonly<ToolExecutionResult>): void {
    if (!this.accepting || execution.parent === undefined || execution.agent === undefined || result.isError) return
    const action = z.object({ action: z.enum(['continuity', 'cross_episode', 'repetitions', 'source_fidelity', 'delivery']) }).safeParse(execution.arguments)
    const sourceSkill = execution.name === 'skill' && z.object({ name: z.literal('video-to-screenplay') }).safeParse(execution.arguments).success
    if (!(execution.name === 'manuscript_revision' && action.success)
      && !sourceSkill
      && !(execution.name === 'present' && this.pending.has(execution))) return
    let session = this.commits.get(execution.agent.session)
    if (session === undefined) { session = new Map(); this.commits.set(execution.agent.session, session) }
    let finish!: () => void
    const done = new Promise<void>((resolveDone) => { finish = resolveDone })
    session.set(execution.callId, { done, finish })
  }

  /** Resolve PTC commit admission after its actual Session event has been appended.
   * @param session - Exact owning Session, never a same-directory neighbor.
   * @param event - Committed event; no model facts are kept outside the projection.
   */
  committed(session: Session, event: SessionEvent): void {
    if (event.type !== 'tool/ptc-dispatch') return
    const pending = this.commits.get(session)
    pending?.get(event.data.subCallId)?.finish()
    pending?.delete(event.data.subCallId)
    if (pending?.size === 0) this.commits.delete(session)
  }

  private reviewBasisProblem(review: Review | null | undefined, agent: Agent): Error | undefined {
    let task: ManuscriptTaskRequest
    try { task = manuscriptTaskRequest(agent.session.deriveMessages(), this.config.maxTextChars) }
    catch (error) {
      if (!(error instanceof ManuscriptTaskContextLimitError)) throw error
      return failure('MANUSCRIPT_DELIVERY_BASELINE_REQUIRED', '完整真人任务要求超过核对预算，不能声明已复核；请缩小本轮要求或明确交付草稿。')
    }
    if (task.request === null && task.continuations.length > 0) {
      return failure('MANUSCRIPT_DELIVERY_BASELINE_REQUIRED', '无法恢复续接所指的原真人任务要求，不能将内部自审声明为已复核；请补充本轮要求或明确交付草稿。')
    }
    if (!task.revision) return undefined
    if (review?.target.role === 'candidate' && review.documents.some(document => document.role === 'current'
      && document.path !== review.target.path)) return undefined
    return failure('MANUSCRIPT_DELIVERY_BASELINE_REQUIRED', '本轮是修订已有剧本。只审最终稿不足以交付为已复核；请用 continuity 同时明确所选原稿 current 和不同路径的最终稿 candidate，核对原要求及改动后再声明。也可明确标为草稿。')
  }

  private sourceProblem(row: Row | undefined, required: boolean, overflow: boolean): Error | undefined {
    if (!required) return undefined
    if (overflow || row?.source_overflow || row === undefined || row.source_reviews.length === 0
      || row.source_reviews.some(record => !sourcePassing(record.review))) {
      return failure('MANUSCRIPT_DELIVERY_SOURCE_REQUIRED', '视频转剧本缺少有效来源核对，或仍有来源遗漏、未知项及超限记录；请对照同一原片重新核对。记录超限时在新任务分批重新核对，或明确交付草稿。')
    }
    return undefined
  }

  private async videoCheck(current: ManuscriptDocument, agent: Agent, videoDir: string | undefined,
    signal: AbortSignal): Promise<VideoCheck> {
    const facts = screenplayFacts(current.text, this.config)
    const frames = videoDir === undefined || this.options.episodeFrames === undefined ? undefined
      : await this.options.episodeFrames(agent.session, videoDir, facts.episodes.map(episode => episode.episode), signal)
    return { video_dir: frames?.video_dir ?? videoDir ?? null, videos: frames?.videos ?? null,
      episodes: facts.episodes.map((episode) => {
        const status = frames?.episodes.find(item => item.episode === episode.episode)
        return { episode: episode.episode, frames: status?.state ?? 'unchecked',
          ...status?.frames === undefined ? {} : { frame_count: status.frames },
          ...status?.recorded === undefined ? {} : { recorded: status.recorded },
          scenes: episode.scenes, action_lines: episode.action_lines, dialogue_lines: episode.dialogue_lines,
          format_errors: episode.error_count, warnings: episode.warning_count }
      }),
      format_errors: [...facts.errors, ...facts.episodes.flatMap(episode => episode.errors)].slice(0, this.config.formatMaxMessages),
      format_error_count: facts.error_count,
      warnings: [...facts.warnings, ...facts.episodes.flatMap(episode => episode.warnings)].slice(0, this.config.formatMaxMessages),
      warning_count: facts.warning_count }
  }

  private async sourceBindingsUnchanged(bindings: readonly SourceBinding[], agent: Agent, signal: AbortSignal): Promise<boolean> {
    const verify = this.options.verifyVideoSource
    if (verify === undefined || bindings.length === 0) return false
    for (const binding of bindings) {
      if (!await continuityFilesUnchanged(binding.dependencies, this.config, signal)
        || !await manuscriptReviewNotesUnchanged({ notes_sha256: binding.notes_sha256, documents: binding.dependencies },
          agent, this.config, signal) || !await verify(agent.session, binding.source_manifest, signal)) return false
    }
    return true
  }

  /** Bind an explicit final output version and its honest reviewed range or draft label.
   * @param candidatePaths - Explicit final file paths, relative to the owning Session workspace.
   * @param mode - Reviewed revisions require a consistent comparison of selected original and final files; draft is explicitly unreviewed.
   * @param note - Required nonblank explanation for draft delivery, separate from the mandatory label.
   * @param agent - Owning Session; no other Session's receipts are consulted.
   * @param signal - Caller cancellation.
   * @param sourceMode - Video requires independent source review in addition to text review; absence preserves any known task requirement.
   * @param videoDir - Video-sourced deliveries: this drama's source folder, whose file names carry episode numbers;
   * absent leaves frames unchecked.
   * @returns File hashes and exact descriptions required by present; this does not present a file. Video-sourced files
   * also carry per-episode format and frame facts, which their labels state without refusing the declaration.
   */
  declare(candidatePaths: readonly string[], mode: 'reviewed' | 'draft', note: string | undefined,
    agent: Agent, signal: AbortSignal, sourceMode?: 'video', videoDir?: string): Promise<ManuscriptDeliveryResult> {
    return this.operate(signal, async (checkSignal) => {
      await this.awaitCommitted(agent, checkSignal)
      const cwd = agent.session.header.cwd
      if (cwd === undefined) throw failure('MANUSCRIPT_DELIVERY_REVIEW_REQUIRED', '交付需要工作区。')
      if (candidatePaths.length === 0 || candidatePaths.length > this.config.maxDocuments) throw failure('MANUSCRIPT_DELIVERY_REVIEW_REQUIRED', '请按文稿数量限制分批交付。')
      if (mode === 'draft' && (note === undefined || note.trim().length === 0)) throw failure('MANUSCRIPT_DELIVERY_REVIEW_REQUIRED', '草稿交付必须说明尚未核实的范围或待解决问题。')
      const state = this.handle.stateOf(agent.session), files: DeliveryFile[] = []
      const sourceRequired = state.source_required || sourceMode === 'video'
      for (const path of candidatePaths) {
        const current = await readManuscript(path, cwd, this.config, checkSignal)
        if (files.some(file => file.path === current.path)) throw failure('MANUSCRIPT_DELIVERY_REVIEW_REQUIRED', '同一规范路径不能重复声明。')
        const row = state.rows.find(item => item.path === current.path)
        const review = row?.sha === current.sha256 ? row.review : null
        const videoCheck = sourceRequired ? await this.videoCheck(current, agent, videoDir, checkSignal) : undefined
        let label = videoCheck !== undefined ? `草稿：${videoLabel(videoCheck)}；当前版本尚未完成来源与语义复核`
          : sourceRequired ? '草稿：当前版本尚未完成来源与语义复核' : '草稿：当前版本未完成语义复核'
        let reviewScope: ManuscriptDeliveryScope | null = null
        let dependencies: DeliveryFile['dependencies'] = []
        let sourceBindings: SourceBinding[] | undefined
        if (mode === 'reviewed') {
          if (row === undefined || review === null || review.status !== 'consistent' || review.reason !== 'reviewed'
            || review.file_verification !== 'verified' || review.findings.length > 0 || review.unknowns.length > 0
            || row.unresolved.length > 0 || row.unresolved_overflow
            || !await continuityFilesUnchanged(review.documents, this.config, checkSignal)
            || !await manuscriptReviewNotesUnchanged(review, agent, this.config, checkSignal)) {
            throw failure('MANUSCRIPT_DELIVERY_REVIEW_REQUIRED', '最终文件缺少有效的一致性审校，或仍有未解决的问题；请重新审校或明确标为草稿。')
          }
          const basisProblem = this.reviewBasisProblem(review, agent)
          if (basisProblem !== undefined) throw basisProblem
          const target = review.documents.find(document => sameIdentity(document, review.target))
          if (target === undefined) throw failure('MANUSCRIPT_DELIVERY_REVIEW_REQUIRED', '审校结果缺少目标文件范围。')
          label = labelOf(review)
          reviewScope = { selection: target.selection, coverage: target.coverage }
          dependencies = review.documents
          const sourceProblem = this.sourceProblem(row, sourceRequired, state.overflow)
          if (sourceProblem !== undefined) throw sourceProblem
          if (sourceRequired) {
            const bindings: SourceBinding[] = row.source_reviews.flatMap(record => sourcePassing(record.review) ? [{
              source_manifest: record.review.source_manifest, dependencies: record.review.documents,
              ...record.review.notes_sha256 === undefined ? {} : { notes_sha256: record.review.notes_sha256 },
            }] : [])
            const coverageProblem = sourceCoverageProblem(bindings, reviewScope, current)
            if (coverageProblem !== undefined) throw coverageProblem
            if (!await this.sourceBindingsUnchanged(bindings, agent, checkSignal)) {
              throw failure('MANUSCRIPT_DELIVERY_SOURCE_STALE', '来源视频、保存ASR、缓存原帧、稿件或批注已变化，或来源读取器不可用；请重新核对或明确交付草稿。')
            }
            sourceBindings = bindings
            label += sourceLabel(bindings)
          }
          if (videoCheck !== undefined) label += `；${videoLabel(videoCheck)}`
        }
        files.push({ path: current.path, file_sha256: current.sha256, aliases: [resolve(cwd, path)],
          label, review_scope: reviewScope, dependencies,
          ...sourceBindings === undefined ? {} : { source_reviews: sourceBindings },
          ...videoCheck === undefined ? {} : { video_check: videoCheck },
          ...(mode === 'reviewed' && review?.notes_sha256 !== undefined ? { notes_sha256: review.notes_sha256 } : {}) })
      }
      const activePaths = new Set([...state.rows.filter(row => !row.presented).map(row => row.path), ...files.map(file => file.path)])
      if (activePaths.size > this.config.maxDocuments) throw failure('MANUSCRIPT_DELIVERY_REVIEW_REQUIRED', '当前待交付路径超过文稿数量限制，请先交付已声明批次，再处理下一批。')
      checkSignal.throwIfAborted()
      if (state.task_id !== this.handle.stateOf(agent.session).task_id) throw failure('MANUSCRIPT_DELIVERY_REVIEW_REQUIRED', '用户任务已变化，请在当前任务中重新声明。')
      return { state: 'delivery', advisory: true, mode, task_id: state.task_id, files,
        ...sourceRequired ? { source_mode: 'video' as const } : {}, ...(note === undefined ? {} : { note }) }
    })
  }

  /** Verify protected present arguments before dispatch.
   * @param execution - Exact tool execution used again by the post-dispatch verification.
   * @returns An explicit denial or undefined when downstream policy should decide.
   */
  async checkPresent(execution: ToolExecution): Promise<PreToolDecision | undefined> {
    if (execution.name !== 'present' || execution.agent === undefined || !this.config.continuityDeliveryChecks
      || execution.agent.session.header.agentPreset === CONTINUITY_REVIEW_PRESET) return undefined
    const agent = execution.agent, cwd = agent.session.header.cwd
    if (cwd === undefined) return undefined
    const args = presentSchema.safeParse(execution.arguments)
    if (!args.success) return undefined
    return this.operate(execution.signal, async (signal) => {
      await this.awaitCommitted(agent, signal)
      const state = this.handle.stateOf(agent.session), files: DeliveryFile[] = [], reviewedFiles: string[] = []
      let mode: 'draft' | 'reviewed' = 'reviewed'
      for (const file of args.data.files) {
        if (!isManuscript(file.path)) continue
        const lexical = resolve(cwd, file.path)
        const declared = state.rows.some(row => row.declaration?.files
          .some(item => item.path === lexical || item.aliases.includes(lexical)))
        if (!state.writing && !state.source_required && !declared && state.rows.every(row => row.declaration === null)) continue
        const current = await readManuscript(file.path, cwd, this.config, signal)
        const row = state.rows.find(item => item.path === current.path)
        const hasDeclaration = declared || row?.declaration !== undefined && row.declaration !== null
        if (!hasDeclaration && (!(state.writing || state.source_required) || !hasManuscriptDeliveryStructure(current.text))) continue
        const declaration = row?.declaration, bound = declaration?.files.find(item => item.path === current.path)
        if (bound === undefined || declaration === null || declaration === undefined || row === undefined) {
          return denial(failure('MANUSCRIPT_DELIVERY_REQUIRED', '请先通过 manuscript_revision delivery 声明已复核范围或草稿，再交付此剧本文件。'))
        }
        if (bound.file_sha256 !== current.sha256) return denial(failure('MANUSCRIPT_DELIVERY_STALE', '文件字节已变化，旧交付声明失效；请重新核对最终文件或声明草稿。'))
        if (declaration.mode === 'reviewed' && (!await continuityFilesUnchanged(bound.dependencies, this.config, signal)
          || row.unresolved.length > 0 || row.unresolved_overflow || row.review?.status !== 'consistent'
          || !await manuscriptReviewNotesUnchanged({ notes_sha256: bound.notes_sha256, documents: bound.dependencies },
            agent, this.config, signal))) {
          return denial(failure('MANUSCRIPT_DELIVERY_REVIEW_REQUIRED', '审校材料已变化或仍有待解决问题，请重新审校或声明草稿。'))
        }
        if (declaration.mode === 'reviewed') {
          const basisProblem = this.reviewBasisProblem(row.review, agent)
          if (basisProblem !== undefined) return denial(basisProblem)
          const sourceRequired = state.source_required || declaration.source_mode === 'video' || bound.source_reviews !== undefined
          const sourceProblem = this.sourceProblem(row.sha === current.sha256 ? row : undefined, sourceRequired, state.overflow)
          if (sourceProblem !== undefined) return denial(sourceProblem)
          if (sourceRequired) {
            const coverageProblem = sourceCoverageProblem(bound.source_reviews ?? [], bound.review_scope, current)
            if (coverageProblem !== undefined) return denial(coverageProblem)
          }
          if (sourceRequired && !await this.sourceBindingsUnchanged(bound.source_reviews ?? [], agent, signal)) {
            return denial(failure('MANUSCRIPT_DELIVERY_SOURCE_STALE', '来源视频、保存ASR、缓存原帧或来源审校依赖已变化；请重新核对后声明交付，或明确交付草稿。'))
          }
          reviewedFiles.push(current.path)
        }
        if (file.description !== bound.label) return denial(failure('MANUSCRIPT_DELIVERY_LABEL_REQUIRED', `present.description 必须逐字使用服务返回的标签：${bound.label}`))
        if (declaration.mode === 'draft') mode = 'draft'
        files.push({ ...bound, aliases: [...new Set([...bound.aliases, lexical])] })
      }
      signal.throwIfAborted()
      if (files.length > 0) {
        const controller = new AbortController()
        let finish!: () => void
        const done = new Promise<void>((resolveDone) => { finish = resolveDone })
        const lease = { controller, done, finish }
        this.active.add(lease)
        this.pending.set(execution, { files, reviewedFiles, mode, task: state.task_id, lease })
      }
      return undefined
    })
  }

  /** List what a video-transcription task still lacks when its goal is marked complete; the completion itself proceeds.
   * @param execution - Exact successful tool execution; other tools and other goal actions yield nothing.
   * @returns Guidance text naming each remaining gap, or undefined when none remain or no video task is active.
   */
  async goalCompletionNotice(execution: ToolExecution): Promise<string | undefined> {
    if (execution.name !== 'update_goal' || execution.agent === undefined || !this.config.continuityDeliveryChecks
      || execution.agent.session.header.agentPreset === CONTINUITY_REVIEW_PRESET
      || !z.object({ action: z.literal('complete') }).safeParse(execution.arguments).success) return undefined
    const agent = execution.agent
    return this.operate(execution.signal, async (signal) => {
      await this.awaitCommitted(agent, signal)
      const state = this.handle.stateOf(agent.session)
      if (!state.source_required) return undefined
      const problems = await this.acceptanceProblems(state, signal)
      return problems.length === 0 ? undefined : `程序核对：这个视频转剧本任务仍有缺口：\n- ${problems.join('\n- ')}\n`
        + '收尾汇报里逐条如实写明这些缺口，不要写成已全部核对；能补的部分先补，补不了的说明原因。'
    })
  }

  private async currentSha(path: string, cwd: string, signal: AbortSignal): Promise<string | undefined> {
    try { return (await readManuscript(path, cwd, this.config, signal)).sha256 }
    catch (error) {
      // A missing or unreadable file is reported as not current; cancellation and non-Error throws propagate.
      signal.throwIfAborted()
      if (!(error instanceof Error)) throw error
      return undefined
    }
  }

  private async acceptanceProblems(state: DeliveryState, signal: AbortSignal): Promise<string[]> {
    const video = state.rows.filter(row => row.declaration?.source_mode === 'video')
    const checkOf = (row: Row): VideoCheck | undefined => row.declaration?.files
      .find(file => file.path === row.path && file.file_sha256 === row.sha)?.video_check
    const words = video.filter(row => row.presented && row.path.toLowerCase().endsWith('.docx'))
    const fresh: Row[] = []
    for (const row of words) if (await this.currentSha(row.path, state.cwd, signal) === row.sha) fresh.push(row)
    if (fresh.length === 0) {
      return [words.length > 0 ? '已交付的 Word 在交付后被改动；重新登记并 present 当前版本'
        : '还没有交付整剧 Word：用 screenplay_export_docx 从最终 Markdown 导出 .docx，再用 manuscript_revision delivery（source_mode: video，并给出 video_dir）登记，按返回标签 present']
    }
    const checks = fresh.flatMap(row => checkOf(row) ?? [])
    if (checks.length === 0) return ['交付的 Word 没有逐集核对结果；用 source_mode: video 并给出 video_dir 重新登记']
    const problems: string[] = []
    const episodes = [...new Set(checks.flatMap(check => check.episodes.map(episode => episode.episode)))].toSorted((a, b) => a - b)
    const first = episodes[0] ?? 1, last = episodes.at(-1) ?? 0
    const gaps = Array.from({ length: Math.max(0, last - first + 1) }, (_, index) => first + index)
      .filter(episode => !episodes.includes(episode))
    if (gaps.length > 0) problems.push(`Word 里缺第${episodeRanges(gaps)}集`)
    const separate = video.flatMap(row => checkOf(row)?.episodes.map(episode => episode.episode) ?? [])
      .filter(episode => !episodes.includes(episode))
    if (separate.length > 0) problems.push(`第${episodeRanges(separate)}集已单独交付，但不在交付的 Word 里`)
    for (const check of checks) problems.push(...frameGaps(check))
    const covered = new Set<number>()
    for (const fact of state.coverage) {
      if (await this.currentSha(fact.path, state.cwd, signal) !== fact.file_sha256) continue
      for (const episode of fact.episodes) covered.add(episode)
    }
    const uncovered = episodes.filter(episode => !covered.has(episode))
    if (uncovered.length > 0) problems.push(`第${episodeRanges(uncovered)}集还没有对当前稿运行 manuscript_revision transcript_coverage`)
    return [...new Set(problems)]
  }

  /** Recheck bytes after dispatch and produce the private packet paired with actual presented events.
   * @param execution - Tool execution previously admitted by checkPresent.
   * @returns Logged packet text, or undefined for an unprotected present call.
   */
  finishPresent(execution: ToolExecution): Promise<string | undefined> {
    const pending = this.pending.get(execution)
    if (pending === undefined) return Promise.resolve(undefined)
    return this.operate(execution.signal, async (signal) => {
      if (execution.agent === undefined) throw failure('MANUSCRIPT_DELIVERY_STALE', '交付缺少所属会话。')
      await this.awaitCommitted(execution.agent, signal)
      const state = this.handle.stateOf(execution.agent.session)
      if (state.task_id !== pending.task) {
        throw failure('MANUSCRIPT_DELIVERY_STALE', '交付期间用户任务已变化。')
      }
      if (!await continuityFilesUnchanged(pending.files, this.config, signal)) throw failure('MANUSCRIPT_DELIVERY_STALE', '交付期间文件字节已变化。')
      for (const file of pending.files) if (!await continuityFilesUnchanged(file.dependencies, this.config, signal)) {
        throw failure('MANUSCRIPT_DELIVERY_STALE', '交付期间审校材料已变化。')
      }
      for (const file of pending.files.filter(file => pending.reviewedFiles.includes(file.path))) {
        if (!await manuscriptReviewNotesUnchanged({ notes_sha256: file.notes_sha256, documents: file.dependencies },
          execution.agent, this.config, signal)) {
          throw failure('MANUSCRIPT_DELIVERY_STALE', '交付期间批注或修改要求已变化，请重新核对。')
        }
        const sourceRequired = state.source_required || file.source_reviews !== undefined
        const row = state.rows.find(row => row.path === file.path && row.sha === file.file_sha256)
        const sourceProblem = this.sourceProblem(row, sourceRequired, state.overflow)
        if (sourceProblem !== undefined) throw sourceProblem
        if (sourceRequired) {
          const current = await readManuscript(file.path, state.cwd, this.config, signal)
          const coverageProblem = sourceCoverageProblem(file.source_reviews ?? [], file.review_scope, current)
          if (coverageProblem !== undefined) throw coverageProblem
        }
        if (sourceRequired && !await this.sourceBindingsUnchanged(file.source_reviews ?? [], execution.agent, signal)) {
          throw failure('MANUSCRIPT_DELIVERY_SOURCE_STALE', '交付期间来源视频、保存ASR、缓存原帧或来源审校依赖已变化，请重新核对。')
        }
      }
      return JSON.stringify({ manuscript_delivery_receipt: {
        call_id: execution.callId, task_id: pending.task, mode: pending.mode, files: pending.files,
      } })
    })
  }

  /** Retain owner cancellation throughout an admitted present body.
   * @param execution - Mutable dispatch view of the exact admitted execution.
   * @param next - Remaining tool body wrappers and the actual present implementation.
   * @returns Body outcome after it has settled; the lease remains until the authoritative final result.
   */
  async dispatchPresent(execution: ToolDispatchExecution, next: () => Promise<ToolExecutionResult>): Promise<ToolExecutionResult> {
    const pending = this.pending.get(execution)
    if (pending === undefined) return next()
    const original = execution.signal
    execution.signal = AbortSignal.any([original, pending.lease.controller.signal])
    try { return await next() }
    finally { execution.signal = original }
  }

  /** Release an admitted execution only after the complete policy pipeline has finalized it.
   * @param execution - Exact successful, failed, blocked or cancelled invocation.
   */
  completePresent(execution: ToolExecution): void {
    const pending = this.pending.get(execution)
    if (pending === undefined) return
    this.pending.delete(execution)
    this.active.delete(pending.lease)
    pending.lease.finish()
  }

  /** Continue an explicit screenplay file request within the configured reminder budget.
   * @param agent - Owning Agent, whose inbox gives newer human input priority.
   * @param signal - Stopping-turn cancellation.
   */
  async remind(agent: Agent, signal: AbortSignal): Promise<void> {
    if (!this.accepting || !this.config.continuityDeliveryChecks || agent.session.header.agentPreset === CONTINUITY_REVIEW_PRESET
      || signal.aborted || agent.inbox.nextStep.length > 0 || agent.inbox.nextTurn.length > 0) return
    await this.operate(signal, async (checkSignal) => {
      await this.awaitCommitted(agent, checkSignal)
      const state = this.handle.stateOf(agent.session)
      if (state.corrections >= this.config.continuityMaxDeliveryCorrections) return
      const paths = [...new Set([...state.outputs, ...state.rows
        .filter(row => row.declaration !== null).map(row => row.path)])]
      const pending: string[] = [], versions: string[] = []
      for (const path of paths) {
        try {
          const current = await readManuscript(path, state.cwd, this.config, checkSignal)
          const row = state.rows.find(item => item.path === current.path)
          const declared = row?.declaration !== null && row?.declaration !== undefined
          const delivered = row?.presented === true && row.sha === current.sha256
          if (!delivered && (declared || state.writing && hasManuscriptDeliveryStructure(current.text))) {
            pending.push(current.path)
            versions.push(JSON.stringify([current.path, current.sha256]))
          }
        } catch (error) {
          checkSignal.throwIfAborted()
          const code: unknown = error instanceof Error ? Reflect.get(error, 'code') : undefined
          if (code !== 'ENOENT') this.reportReadFailure(path, error)
        }
      }
      const missingReceipt = pending.length === 0 && state.writing && state.file_request
        && !state.rows.some(row => row.presented)
      if (pending.length === 0 && !missingReceipt) return
      const fingerprint = missingReceipt ? 'no_verified_screenplay_delivery' : JSON.stringify(versions.toSorted())
      if (fingerprint === state.fingerprint || this.handle.stateOf(agent.session).task_id !== state.task_id
        || agent.inbox.nextStep.length > 0 || agent.inbox.nextTurn.length > 0) return
      const instruction = missingReceipt
        ? '本轮用户要求实际剧本文件，但当前没有已核实的本机文件交付回执。请先确认已有执行或任务的结果，再实际生成、回读并交付文件；不要重复启动已有任务。代码块、外部执行标签和文本链接不代表 Muse 已在本机执行或生成文件。文件不存在时如实说明，不猜测路径或声称文件已完成；能够继续时完成真实工具调用，核对最终版本或明确登记为草稿，再使用返回标签 present。'
        : `以下明确输出的剧本文件尚未成功 present：${pending.join('、')}。请核对最终文件并调用 manuscript_revision delivery（视频转写设 source_mode: video 并给出 video_dir），选择 reviewed 或明确标为 draft，再用返回的逐字 label 作为 present.description。标签由程序按实际核对结果生成；局部审校只能注明实际范围，不需逐项请用户批准。不要凭回复文字声称文件已完成交付。`
      agent.inject(createUserMessage({ source: { kind: 'muse-manuscript', form: 'notice', summary: '剧本文件尚无有效交付回执' },
        content: [{ type: 'text', text: instruction },
          { type: 'text', text: JSON.stringify({ manuscript_delivery_notice: { task_id: state.task_id, fingerprint, attempt: state.corrections + 1 } }) }] }))
    })
  }
}

/** Install one effect-owned private projection and async policy hooks.
 * @param ctx - Host context declaring tools and sessionProjections services.
 * @param config - Bounded delivery checks and correction policy.
 * @param options - Optional source freshness callback; without it, reviewed video delivery fails while text delivery is unchanged.
 * @returns Service whose disposer drains in-flight checks before releasing callbacks and recovery state.
 */
export async function createManuscriptDelivery(ctx: Context, config: ManuscriptDeliveryConfig,
  options: ManuscriptDeliveryOptions = {}): Promise<ManuscriptDelivery> {
  let handle: ProjectionHandle<DeliveryState> | undefined
  const projectionOwner = await ctx.plugin(Object.assign(async (owner: Context) => {
    handle = await owner.sessionProjections.register(manuscriptDeliveryProjection(config.maxDocuments))
  }, { inject: ['sessionProjections'] }))
  if (handle === undefined) throw Error('Manuscript delivery projection did not initialize')
  if ([FiberState.UNLOADING, FiberState.DISPOSED, FiberState.FAILED].includes(ctx.fiber.state)) {
    await projectionOwner.dispose()
    throw Error('Manuscript delivery owner was disposed during projection registration')
  }
  const logger = ctx.logger('manuscript-delivery')
  const service = new ManuscriptDelivery(config, handle, (path, error) => {
    const code: unknown = error instanceof Error ? Reflect.get(error, 'code') : undefined
    logger.warn('Manuscript delivery output could not be verified', { path,
      error_type: error instanceof Error ? error.constructor.name : 'NonError',
      error_code: typeof code === 'string' && /^[A-Z_]{1,40}$/u.test(code) ? code : null })
  }, options)
  const pre = ctx.on('tools/pre-execute', async (execution, next) => {
    const decision = await next()
    if (decision.kind !== 'allow') return decision
    return await service.checkPresent(execution) ?? decision
  })
  const post = ctx.on('tools/post-execute', async (execution, result, next) => {
    const decision = await next()
    if (execution.name === 'update_goal' && !result.isError && decision.kind === 'accept' && !('value' in decision)) {
      const notice = await service.goalCompletionNotice(execution)
      return notice === undefined ? decision : { ...decision, content: [...decision.content ?? result.content, { type: 'text', text: notice }] }
    }
    if (execution.name !== 'present' || result.isError || decision.kind !== 'accept') return decision
    try {
      const packet = await service.finishPresent(execution)
      if (packet === undefined) return decision
      if ('value' in decision) return { kind: 'block', feedback: [{ type: 'text', text: 'MANUSCRIPT_DELIVERY_STALE: 交付结果被其他策略替换，请重新交付。' }] }
      return { kind: 'accept', content: [...decision.content ?? result.content, { type: 'text', text: packet }],
        ...(decision.additionalContexts === undefined ? {} : { additionalContexts: decision.additionalContexts }) }
    } catch (error) {
      execution.signal.throwIfAborted()
      if (!(error instanceof Error)) throw error
      return { kind: 'block', feedback: [{ type: 'text', text: error.message }] }
    }
  }, { prepend: true })
  const around = ctx.on('tools/execute', (execution, next) => service.dispatchPresent(execution, next))
  const final = ctx.on('tools/result', (execution, result) => {
    service.pendingCommit(execution, result)
    service.completePresent(execution)
  })
  const committed = ctx.on('session/event', (session, event) => { service.committed(session, event) })
  const log = ctx.on('tools/ptc-dispatch-log', async (dispatch, next) => {
    const content = await next()
    if (dispatch.name !== 'present' || dispatch.isError) return content
    const packet = parseBlocks(dispatch.content, z.object({ manuscript_delivery_receipt: receiptSchema }))
    if (packet === undefined || parseBlocks(content, z.object({ manuscript_delivery_receipt: receiptSchema })) !== undefined) return content
    return [...content, { type: 'text', text: JSON.stringify(packet) }]
  }, { prepend: true })
  const stop = ctx.on('agent/turn-stopping', async ({ agent, signal }) => {
    if (ctx.fiber.state !== FiberState.ACTIVE) return
    await service.remind(agent, signal)
  })
  const cleanup = ctx.effect(function* () {
    yield projectionOwner.dispose
    yield pre
    yield post
    yield around
    yield final
    yield committed
    yield log
    yield stop
    yield async () => service.drain()
  })
  service.attach(cleanup)
  return service
}
