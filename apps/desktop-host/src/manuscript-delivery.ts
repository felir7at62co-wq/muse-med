/** Session-local screenplay delivery declarations, verified file versions and bounded reminders. */
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
import { continuityFilesUnchanged, CONTINUITY_REVIEW_PRESET } from './manuscript-continuity.ts'
import { isManuscript, readManuscript, type DocumentLimits } from './manuscript-document.ts'
import type {} from './manuscript-revisions.ts'

/** Deployment limits; completed deliveries never become a global adopted-manuscript selection. */
export interface ManuscriptDeliveryConfig extends DocumentLimits {
  maxDocuments: number
  continuityDeliveryChecks: boolean
  continuityMaxDeliveryCorrections: number
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
const reviewSchema = z.object({ state: z.literal('continuity'), status: z.enum(['consistent', 'issues', 'unknown']),
  reason: z.string(), target: identitySchema, documents: z.array(documentSchema),
  findings: z.array(z.object({ evidence: z.array(identitySchema.extend({ line: z.number().int().positive() })) })),
  unknowns: z.array(z.string()), file_verification: z.enum(['verified', 'changed', 'unavailable']) })
const fileSchema = z.object({ path: z.string(), file_sha256: z.string(), aliases: z.array(z.string()),
  label: z.string(), review_scope: scopeSchema.nullable(), dependencies: z.array(documentSchema) })
const declarationSchema = z.object({ state: z.literal('delivery'), mode: z.enum(['reviewed', 'draft']), advisory: z.literal(true),
  task_id: z.string(), files: z.array(fileSchema), note: z.string().optional() })
const metadataFactSchema = z.object({ manuscript_delivery_fact: z.union([reviewSchema, declarationSchema.omit({ note: true })]) })
/** Exact selected text ranges displayed beside a reviewed file; null means explicit draft. */
export type ManuscriptDeliveryScope = z.infer<typeof scopeSchema>
/** Host-verified declaration; the caller must still successfully invoke present. */
export type ManuscriptDeliveryResult = z.infer<typeof declarationSchema>
type Review = z.infer<typeof reviewSchema>
type DeliveryFile = z.infer<typeof fileSchema>
type Range = z.infer<typeof rangeSchema>
const blockSchema = identitySchema.extend({ ranges: z.array(rangeSchema) })
type ReviewBlock = z.infer<typeof blockSchema>
const rowSchema = z.object({ path: z.string(), sha: z.string(), review: reviewSchema.nullable(),
  unresolved: z.array(blockSchema), unresolved_overflow: z.boolean(), declaration: declarationSchema.nullable(), presented: z.boolean() })
type Row = z.infer<typeof rowSchema>
const callSchema = z.object({ id: z.string(), turn: z.number(), name: z.string(), args: z.string() })
const receiptSchema = z.object({ call_id: z.string(), task_id: z.string(), files: z.array(fileSchema), mode: z.enum(['reviewed', 'draft']) })
const stateSchema = z.object({ task_id: z.string(), writing: z.boolean(), file_request: z.boolean(), cwd: z.string(),
  turn: z.number(), corrections: z.number(), fingerprint: z.string(), overflow: z.boolean(),
  rows: z.array(rowSchema), outputs: z.array(z.string()), calls: z.array(callSchema),
  packets: z.array(receiptSchema.extend({ turn: z.number() })), presented: z.array(z.object({ turn: z.number(), id: z.string() })) })
type DeliveryState = z.infer<typeof stateSchema>
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
export function manuscriptDeliveryMetadata(value: string): z.infer<typeof metadataFactSchema> | null {
  const parsed = z.union([reviewSchema, declarationSchema.omit({ note: true })]).safeParse(json(value))
  return parsed.success ? { manuscript_delivery_fact: parsed.data } : null
}

/** Classify actual user requests, preserving short continuations and excluding negated editing or screenplay creation.
 * @param text - Human-authored request, never manuscript contents or model prose.
 * @returns Writing, continuation, file requirement, or a new unrelated task.
 */
export function manuscriptDeliveryIntent(text: string): { writing: boolean; continuation: boolean; file: boolean } {
  const positive = text.replace(/(?:不需要|不|勿|无需|不要|不必)(?:再)?(?:进行|涉及|做)?(?:剧本|短剧|分集|分场|剧情|台词|对白)?(?:新增|改写|重写|修改|改稿|改变|续写|润色|创作|写作|修订)(?:\s*[\/、和或]\s*(?:新增|改写|重写|修改|改稿|改变|续写|润色|创作|修订))*(?:剧情|内容|稿件|剧本)?/gu, '')
  const subject = /剧本|短剧|分集|分场|剧情|台词|对白|screenplay|short drama/iu.test(positive)
  const action = /重写|改写|创作|写作|编写|续写|改稿|润色|精修|写|修改|修订|rewrite|write|revise/iu.test(positive)
    || /(?:生成|generate).{0,12}(?:剧本|短剧|分集|分场|screenplay)/iu.test(positive)
  const fileRequest = text.replace(/(?:不需要|不必|不要|不用|无需|勿|不)(?:再|另外|额外)?(?:(?:生成|导出|保存|交付|提供|输出)(?:\s*[或和、/]\s*(?:生成|导出|保存|交付|提供|输出))*)?\s*(?:文件|文档|Word|DOCX|Markdown)(?:\s*(?:格式)?(?:文件|文档))?/giu, '')
  const file = /(?:交付|生成|导出|保存|提供|给我?|发送|发我|输出|做成|转成).{0,24}(?:文件|文档|\bword\b|\bdocx\b|\bmarkdown\b)/iu.test(fileRequest)
    || /(?:文件|文档|\bword\b|\bdocx\b|\bmarkdown\b).{0,12}(?:交付|导出|保存|给我|发我)/iu.test(fileRequest)
  const instructionOnly = /^(?:请)?(?:解释|讲解|介绍|说明|演示|如何|怎么|怎样|explain|how to)/iu.test(text.trim())
    && !/(?:然后|同时|另外|并且|并|再)(?:帮我|实际|直接|现在|请你)(?:重写|改写|编写|修改|生成|导出|交付)/u.test(text)
  return { writing: subject && action,
    continuation: /^\s*(?:继续|接着|然后继续|给我文件|把.{0,12}(?:文件|Word|文档)给我|继续改|continue)[。！!\s]*$/iu.test(text),
    file: file && !instructionOnly }
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
function blocksOf(review: Review): ReviewBlock[] {
  return review.documents.map((document) => {
    const lines = review.findings.flatMap(finding => finding.evidence
      .filter(evidence => sameIdentity(evidence, document)).map(evidence => evidence.line))
    const ranges = review.status === 'unknown' || lines.length === 0 ? document.coverage.read_ranges
      : lines.map(line => ({ start: line, end: line }))
    return { role: document.role, path: document.path, file_sha256: document.file_sha256,
      text_sha256: document.text_sha256, ranges: mergeRanges(ranges) }
  })
}
function combineBlocks(a: ReviewBlock[], b: ReviewBlock[]): ReviewBlock[] {
  const result = a.map(block => ({ ...block, ranges: [...block.ranges] }))
  for (const block of b) {
    const previous = result.find(item => sameIdentity(item, block))
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
  return { key: 'muse.manuscript-delivery', stateVersion: 3, stateSchema,
    init: header => ({ task_id: '', writing: false, file_request: false, cwd: header.cwd ?? '', turn: 0, corrections: 0,
      fingerprint: '', overflow: false, rows: [], outputs: [], calls: [], packets: [], presented: [] }),
    apply(state, event) { return foldDelivery(state, event, maxDocuments) } }
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
      corrections: 0, fingerprint: '', overflow: false, rows: [], outputs: [], calls: [], packets: [], presented: [] }
  }
  if (event.type === 'turn/start') return { ...state, turn: event.data.turn,
    corrections: 0, fingerprint: '', calls: [], packets: [], presented: [] }
  const start = event.type === 'tool/call'
    ? { id: event.data.callId, turn: event.data.turn, name: event.data.name, args: event.data.arguments }
    : event.type === 'tool/ptc-dispatch-start'
      ? { id: event.data.subCallId, turn: state.turn, name: event.data.name, args: JSON.stringify(event.data.arguments) } : undefined
  if (start !== undefined) {
    if (!['manuscript_revision', 'present', 'write', 'edit', 'screenplay_export_docx'].includes(start.name)) return state
    return { ...state, calls: [...state.calls.filter(call => call.id !== start.id || call.turn !== start.turn), start].slice(-max * 4),
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
  if (call.name === 'manuscript_revision') {
    const args = z.object({ action: z.string() }).safeParse(json(call.args))
    if (!args.success) return next
    const metadata = metadataFactSchema.safeParse(result.meta)
    const fact = metadata.success ? metadata.data.manuscript_delivery_fact : undefined
    if (args.data.action === 'continuity') {
      const review = fact?.state === 'continuity' ? fact : parseBlocks(result.content, reviewSchema)
      return review === undefined ? next : rememberReview(next, review, max)
    }
    if (args.data.action === 'delivery') {
      const declaration = fact?.state === 'delivery' ? fact : parseBlocks(result.content, declarationSchema)
      if (declaration === undefined || declaration.task_id !== state.task_id) return next
      for (const file of declaration.files) {
        const old = next.rows.find(row => row.path === file.path)
        next = upsert(next, { path: file.path, sha: file.file_sha256, review: old?.review ?? null,
          unresolved: old?.sha === file.file_sha256 ? old.unresolved : [],
          unresolved_overflow: old?.sha === file.file_sha256 ? old.unresolved_overflow : false, declaration, presented: false }, max)
      }
      return next
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
  if (target.coverage.full_document) return '已复核本文件全部提取正文（仅当前版本）'
  if (target.selection.kind === 'episodes') {
    const numbers = target.selection.included.toSorted((a, b) => a - b)
    const consecutive = numbers.every((number, index) => index === 0 || number - 1 === numbers[index - 1])
    const episodes = consecutive && numbers.length > 1 ? `${numbers[0]}–${numbers.at(-1)}` : numbers.join('、')
    return `已复核第${episodes}集（仅此范围）`
  }
  const ranges = target.coverage.read_ranges.map(range => range.start === range.end ? String(range.start) : `${range.start}–${range.end}`).join('、')
  return `已复核正文第${ranges}行（仅此范围）`
}
function failure(code: string, reason: string): Error {
  return Object.assign(new Error(`${code}: ${reason}`), { code })
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
    mode: 'reviewed' | 'draft'
    task: string
    lease: ActiveOperation
  }>()
  constructor(private readonly config: ManuscriptDeliveryConfig, private readonly handle: ProjectionHandle<DeliveryState>,
    private readonly reportReadFailure: (path: string, error: unknown) => void) {}

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
    const action = z.object({ action: z.enum(['continuity', 'delivery']) }).safeParse(execution.arguments)
    if (!(execution.name === 'manuscript_revision' && action.success)
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

  /** Bind an explicit final output version and its honest reviewed range or draft label.
   * @param candidatePaths - Explicit final file paths, relative to the owning Session workspace.
   * @param mode - Reviewed versions require a fresh consistent receipt; draft is explicitly unreviewed.
   * @param note - Required nonblank explanation for draft delivery, separate from the mandatory label.
   * @param agent - Owning Session; no other Session's receipts are consulted.
   * @param signal - Caller cancellation.
   * @returns File hashes and exact descriptions required by present; this does not present a file.
   */
  declare(candidatePaths: readonly string[], mode: 'reviewed' | 'draft', note: string | undefined,
    agent: Agent, signal: AbortSignal): Promise<ManuscriptDeliveryResult> {
    return this.operate(signal, async (checkSignal) => {
      await this.awaitCommitted(agent, checkSignal)
      const cwd = agent.session.header.cwd
      if (cwd === undefined) throw failure('MANUSCRIPT_DELIVERY_REVIEW_REQUIRED', '交付需要工作区。')
      if (candidatePaths.length === 0 || candidatePaths.length > this.config.maxDocuments) throw failure('MANUSCRIPT_DELIVERY_REVIEW_REQUIRED', '请按文稿数量限制分批交付。')
      if (mode === 'draft' && (note === undefined || note.trim().length === 0)) throw failure('MANUSCRIPT_DELIVERY_REVIEW_REQUIRED', '草稿交付必须说明尚未核实的范围或待解决问题。')
      const state = this.handle.stateOf(agent.session), files: DeliveryFile[] = []
      for (const path of candidatePaths) {
        const current = await readManuscript(path, cwd, this.config, checkSignal)
        if (files.some(file => file.path === current.path)) throw failure('MANUSCRIPT_DELIVERY_REVIEW_REQUIRED', '同一规范路径不能重复声明。')
        const row = state.rows.find(item => item.path === current.path)
        const review = row?.sha === current.sha256 ? row.review : null
        let label = '草稿：当前版本未完成语义复核'
        let reviewScope: ManuscriptDeliveryScope | null = null
        let dependencies: DeliveryFile['dependencies'] = []
        if (mode === 'reviewed') {
          if (row === undefined || review === null || review.status !== 'consistent' || review.reason !== 'reviewed'
            || review.file_verification !== 'verified' || review.findings.length > 0 || review.unknowns.length > 0
            || row.unresolved.length > 0 || row.unresolved_overflow
            || !await continuityFilesUnchanged(review.documents, this.config, checkSignal)) {
            throw failure('MANUSCRIPT_DELIVERY_REVIEW_REQUIRED', '最终文件缺少有效的一致性审校，或仍有未解决的问题；请重新审校或明确标为草稿。')
          }
          const target = review.documents.find(document => sameIdentity(document, review.target))
          if (target === undefined) throw failure('MANUSCRIPT_DELIVERY_REVIEW_REQUIRED', '审校结果缺少目标文件范围。')
          label = labelOf(review)
          reviewScope = { selection: target.selection, coverage: target.coverage }
          dependencies = review.documents
        }
        files.push({ path: current.path, file_sha256: current.sha256, aliases: [resolve(cwd, path)],
          label, review_scope: reviewScope, dependencies })
      }
      const activePaths = new Set([...state.rows.filter(row => !row.presented).map(row => row.path), ...files.map(file => file.path)])
      if (activePaths.size > this.config.maxDocuments) throw failure('MANUSCRIPT_DELIVERY_REVIEW_REQUIRED', '当前待交付路径超过文稿数量限制，请先交付已声明批次，再处理下一批。')
      checkSignal.throwIfAborted()
      if (state.task_id !== this.handle.stateOf(agent.session).task_id) throw failure('MANUSCRIPT_DELIVERY_REVIEW_REQUIRED', '用户任务已变化，请在当前任务中重新声明。')
      return { state: 'delivery', advisory: true, mode, task_id: state.task_id, files, ...(note === undefined ? {} : { note }) }
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
      const state = this.handle.stateOf(agent.session), files: DeliveryFile[] = []
      let mode: 'draft' | 'reviewed' = 'reviewed'
      for (const file of args.data.files) {
        if (!isManuscript(file.path)) continue
        const lexical = resolve(cwd, file.path)
        const declared = state.rows.some(row => row.declaration?.files
          .some(item => item.path === lexical || item.aliases.includes(lexical)))
        if (!state.writing && !declared && state.rows.every(row => row.declaration === null)) continue
        const current = await readManuscript(file.path, cwd, this.config, signal)
        const row = state.rows.find(item => item.path === current.path)
        const hasDeclaration = declared || row?.declaration !== undefined && row.declaration !== null
        if (!hasDeclaration && (!state.writing || !hasManuscriptDeliveryStructure(current.text))) continue
        const declaration = row?.declaration, bound = declaration?.files.find(item => item.path === current.path)
        if (bound === undefined || declaration === null || declaration === undefined || row === undefined) {
          return denial(failure('MANUSCRIPT_DELIVERY_REQUIRED', '请先通过 manuscript_revision delivery 声明已复核范围或草稿，再交付此剧本文件。'))
        }
        if (bound.file_sha256 !== current.sha256) return denial(failure('MANUSCRIPT_DELIVERY_STALE', '文件字节已变化，旧交付声明失效；请重新核对最终文件或声明草稿。'))
        if (declaration.mode === 'reviewed' && (!await continuityFilesUnchanged(bound.dependencies, this.config, signal)
          || row.unresolved.length > 0 || row.unresolved_overflow || row.review?.status !== 'consistent')) {
          return denial(failure('MANUSCRIPT_DELIVERY_REVIEW_REQUIRED', '审校材料已变化或仍有待解决问题，请重新审校或声明草稿。'))
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
        this.pending.set(execution, { files, mode, task: state.task_id, lease })
      }
      return undefined
    })
  }

  /** Recheck bytes after dispatch and produce the private packet paired with actual presented events.
   * @param execution - Tool execution previously admitted by checkPresent.
   * @returns Logged packet text, or undefined for an unprotected present call.
   */
  finishPresent(execution: ToolExecution): Promise<string | undefined> {
    const pending = this.pending.get(execution)
    if (pending === undefined) return Promise.resolve(undefined)
    return this.operate(execution.signal, async (signal) => {
      if (execution.agent === undefined || this.handle.stateOf(execution.agent.session).task_id !== pending.task) {
        throw failure('MANUSCRIPT_DELIVERY_STALE', '交付期间用户任务已变化。')
      }
      if (!await continuityFilesUnchanged(pending.files, this.config, signal)) throw failure('MANUSCRIPT_DELIVERY_STALE', '交付期间文件字节已变化。')
      for (const file of pending.files) if (!await continuityFilesUnchanged(file.dependencies, this.config, signal)) {
        throw failure('MANUSCRIPT_DELIVERY_STALE', '交付期间审校材料已变化。')
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
        : `以下明确输出的剧本文件尚未成功 present：${pending.join('、')}。请核对最终文件并调用 manuscript_revision delivery，选择 reviewed 或明确标为 draft，再用返回的逐字 label 作为 present.description。局部审校只能注明实际范围；有未解问题可交付明确草稿，不需逐项请用户批准。不要凭回复文字声称文件已完成交付。`
      agent.inject(createUserMessage({ source: { kind: 'muse-manuscript', form: 'notice', summary: '剧本文件尚无有效交付回执' },
        content: [{ type: 'text', text: instruction },
          { type: 'text', text: JSON.stringify({ manuscript_delivery_notice: { task_id: state.task_id, fingerprint, attempt: state.corrections + 1 } }) }] }))
    })
  }
}

/** Install one effect-owned private projection and async policy hooks.
 * @param ctx - Host context declaring tools and sessionProjections services.
 * @param config - Bounded delivery checks and correction policy.
 * @returns Service whose disposer drains in-flight checks before releasing callbacks and recovery state.
 */
export async function createManuscriptDelivery(ctx: Context, config: ManuscriptDeliveryConfig): Promise<ManuscriptDelivery> {
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
  })
  const pre = ctx.on('tools/pre-execute', async (execution, next) => {
    const decision = await next()
    if (decision.kind !== 'allow') return decision
    return await service.checkPresent(execution) ?? decision
  })
  const post = ctx.on('tools/post-execute', async (execution, result, next) => {
    const decision = await next()
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
