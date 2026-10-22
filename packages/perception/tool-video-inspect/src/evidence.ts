/** Host-issued inspection records, successful model-image delivery, and log-backed recovery. */
import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { AttachmentId, type ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { FsVersion } from '@deepseek-ai/dsh-fs'
import { expandAssistantStream, isAgentLoopRequest, projectFilesToText, projectToolUpdates,
  type GenerateOptions, type LlmResolvedModelInfo, type RequestMessage, type ToolCallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-query'
import type { ToolExecution, ToolExecutionToken } from '@deepseek-ai/dsh-tools'
import { inspectionContent, type VideoInspection } from './index.ts'

const positive = z.number().positive(), digest = z.string().regex(/^[a-f0-9]{64}$/)
const interval = z.strictObject({ start_seconds: z.number().nonnegative(), end_seconds: positive })
const image = z.strictObject({ attachmentId: z.string().min(1).transform(AttachmentId),
  mediaType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']), bytes: positive.int(), width: positive.int(), height: positive.int(),
  name: z.string().optional(), originalDimensions: z.strictObject({ width: positive.int(), height: positive.int() }).optional() })
  .transform((value): ImageAttachmentRef => ({ attachmentId: value.attachmentId, mediaType: value.mediaType,
    bytes: value.bytes, width: value.width, height: value.height,
    ...value.name === undefined ? {} : { name: value.name },
    ...value.originalDimensions === undefined ? {} : { originalDimensions: value.originalDimensions } }))
const frame = z.strictObject({ requested_seconds: z.number().nonnegative(), timestamp_seconds: z.number().nonnegative(), image })
const binding = z.object({ path: z.string().min(1), source_version: z.string().min(1).transform(FsVersion), duration_seconds: positive,
  inspection: z.literal('sampled_frames'), interval, frames: z.array(frame).min(1), manifest_path: z.string().min(1) })
const observation = z.strictObject({ time: z.number().nonnegative(), reasons: z.array(z.string()),
  utterances: z.array(z.strictObject({ start: z.number().nonnegative(), end: z.number().nonnegative(),
    text: z.string(), text_truncated: z.boolean(), speaker_id: z.string().min(1).optional() })).optional() })
const inspection = binding.omit({ inspection: true, frames: true }).loose().extend({
  inspection: z.enum(['metadata', 'sampled_frames']), frames: z.array(frame), manifest_path: z.string().min(1), verified_readback: z.boolean(),
  width: positive.int(), height: positive.int(), video_codec: z.string(), has_audio: z.boolean(), window_plan: z.array(interval).optional(),
  next_start_seconds: z.number().nonnegative().optional(),
  sampling_plan: z.strictObject({ strategy: z.literal('scene_dialogue'),
    selected: z.array(observation), deferred: z.array(observation) }).optional(),
  transcript_source: z.strictObject({ path: z.string(), version: z.string().transform(FsVersion) }).optional(),
})
const eventRef = z.strictObject({ seq: z.number().int().nonnegative().transform(SessionSeq), sha256: digest })

/** File parser only; parsing a receipt does not establish trust or model observation. */
export const TRUSTED_VIDEO_INSPECTION_RECEIPT = z.strictObject({
  version: z.literal('trusted-video-inspection-v2'), video_path: z.string().min(1), source_version: z.string().min(1).transform(FsVersion),
  duration_seconds: positive, metadata_manifest_path: z.string().min(1), manifest_path: z.string().min(1),
  metadata_manifest_sha256: digest, manifest_sha256: digest, plan: z.array(interval).min(1),
  windows: z.array(interval.extend({ sample_requested_seconds: z.array(z.number().nonnegative()).min(1),
    decoded_pts_seconds: z.array(z.number().nonnegative()).min(1), frames: z.array(frame).min(1) })).min(1),
  model_input_step: z.number().int().nonnegative().transform(SessionSeq),
  unresolved: z.array(z.strictObject({ time: z.number().nonnegative(), reason: z.string().min(1), critical: z.boolean() })),
  evidence: z.strictObject({ session_id: z.string().min(1).transform(SessionId), metadata_result: eventRef,
    metadata_root_result: eventRef, sample_result: eventRef, sample_root_result: eventRef,
    metadata_ancestors: z.array(eventRef), sample_ancestors: z.array(eventRef), model_response: eventRef, model_input_sha256: digest }),
})

/** Host-generated facts about one sampled interval; no continuous-viewing or semantic claim. */
export type TrustedVideoInspectionReceipt = z.infer<typeof TRUSTED_VIDEO_INSPECTION_RECEIPT>

type Ref = z.infer<typeof eventRef>
interface Outcome { call: ToolCallId; contentHash: string; ref?: Ref }
interface Record {
  session: Session
  value: VideoInspection
  manifestHash: string
  step: SessionSeq
  successful: boolean
  invalid: boolean
  root: ToolCallId
  own: Outcome
  ancestors: Outcome[]
  metadata?: Record
  input?: { step: SessionSeq; hash: string; response?: Ref }
}
interface State { session: Session; step?: SessionSeq; records: Record[]; calls: Map<ToolCallId, string> }
interface Ledger {
  states: Map<SessionId, State>
  issue(exec: ToolExecution, value: VideoInspection, serialized: string, metadata?: Record): void
  metadata(exec: ToolExecution, path: string, version: FsVersion, duration: number): Record
}
const ledgers = new WeakMap<Session, Set<Ledger>>()

function hash(value: string | Uint8Array): string { return createHash('sha256').update(value).digest('hex') }
function isInspection(value: unknown): value is VideoInspection { return inspection.safeParse(value).success }
function json(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => item !== null && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item)
}
function ref(event: SessionEvent): Ref { return { seq: event.seq, sha256: hash(json(event)) } }
function hasImages(messages: readonly RequestMessage[], value: VideoInspection): boolean {
  const images = messages.flatMap(message => message.content.flatMap(block =>
    block.type === 'image' && block.offloaded !== true ? [json(block.attachment)] : []))
  return value.frames.length > 0 && value.frames.every(frame => images.includes(json(frame.image)))
}
function modelInput(ctx: Context, messages: readonly RequestMessage[], provider: string, info: LlmResolvedModelInfo,
  tools: GenerateOptions['tools'], history: GenerateOptions['toolHistory']): readonly RequestMessage[] | undefined {
  if (!info.inputModalities?.includes('image') || messages.some(message => message.role === 'assistant'
    && message.source.replayState !== undefined && message.source.provider !== provider)) return undefined
  const files = projectFilesToText(messages, (file) => {
    let path: string | undefined
    try { path = ctx.attachments.fileHostPath(file) } catch (error: unknown) {
      // LLM dispatch also falls back to handle text when a file cannot be mapped.
      void error
      return undefined
    }
    return path === undefined ? undefined : ctx.fs.processPathFromHostPath(path)
  })
  return projectToolUpdates(files, tools, info.toolUpdate, history).messages
}
function committed(record: Record): boolean {
  return !record.invalid && record.successful && record.own.ref !== undefined && record.ancestors.every(row => row.ref !== undefined)
    && (record.ancestors.at(-1)?.call ?? record.own.call) === record.root
}

/**
 * Install creation-only evidence capture beside the existing video tool registration.
 * @param ctx - Tool, Session, and LLM services in the same Host.
 * @returns Private issuance and metadata lookup used only by this tool's implementation.
 */
export function installVideoEvidence(ctx: Context): Ledger {
  const llm = ctx.get('llm')
  if (ctx.get('sessions') === undefined || llm === undefined) throw Error('Trusted video evidence requires Session and LLM services')
  const states = new Map<SessionId, State>(), executions = new Map<ToolExecutionToken, Record[]>()
  const state = (session: Session): State => {
    let result = states.get(session.id)
    if (result === undefined) { result = { session, records: [], calls: new Map() }; states.set(session.id, result) }
    return result
  }
  const ledger: Ledger = { states,
    issue(exec, value, serialized, metadata) {
      if (exec.agent === undefined) throw Error('Trusted video inspection requires an initiating Session')
      const owner = state(exec.agent.session)
      if (owner.step === undefined) throw Error('Trusted video inspection requires a running model step')
      let registrations = ledgers.get(owner.session)
      if (registrations === undefined) { registrations = new Set(); ledgers.set(owner.session, registrations) }
      registrations.add(ledger)
      const record: Record = { session: owner.session, value: structuredClone(value), manifestHash: hash(serialized), step: owner.step,
        successful: false, invalid: false, root: exec.rootCallId,
        own: { call: exec.callId, contentHash: hash(json(inspectionContent(value))) }, ancestors: [],
        ...metadata === undefined ? {} : { metadata } }
      owner.records.push(record)
      executions.set(exec.token, [...executions.get(exec.token) ?? [], record])
    },
    metadata(exec, path, version, duration) {
      if (exec.agent === undefined) throw Error('Trusted sampling requires an initiating Session')
      const record = state(exec.agent.session).records.findLast(row => row.value.inspection === 'metadata' && row.successful && !row.invalid
        && row.value.path === path && row.value.source_version === version && row.value.duration_seconds === duration)
      if (record === undefined) throw Error('Trusted sampling requires a successful metadata inspection of the current video first')
      return record
    },
  }
  ctx.effect(() => () => {
    for (const owner of states.values()) ledgers.get(owner.session)?.delete(ledger)
    states.clear(); executions.clear()
  })
  ctx.on('session/disposed', (session) => { states.delete(session.id); ledgers.get(session)?.delete(ledger) })
  ctx.on('session/event', (session, event) => {
    const owner = state(session)
    if (event.type === 'step/start') owner.step = event.seq
    if (event.type === 'tool/call') owner.calls.set(event.data.callId, event.data.name)
    if (event.type === 'tool/result' || event.type === 'tool/ptc-dispatch') {
      const native = event.type === 'tool/result'
      const call = native ? event.data.message.toolCallId : event.data.subCallId
      const content = native ? event.data.message.content : event.data.content
      const success = native ? event.data.message.isError !== true : !event.data.isError
      const name = native ? owner.calls.get(call) : event.data.name
      for (const record of owner.records) {
        const outcomes = [record.own, ...record.ancestors]
        for (const outcome of outcomes) if (outcome.call === call && success && hash(json(content)) === outcome.contentHash
          && (outcome !== record.own || name === 'video_inspect')) outcome.ref = ref(event)
      }
    }
    if (event.type === 'assistant/message' && event.data.interrupted !== true) for (const record of owner.records) {
      const input = record.input
      if (input !== undefined && input.step === owner.step && input.response === undefined) input.response = ref(event)
    }
  })
  ctx.on('tools/result', (exec, result) => {
    const records = executions.get(exec.token)
    executions.delete(exec.token)
    if (records === undefined) return
    for (const record of records) {
      if (result.isError || exec.signal.aborted) record.invalid = true
      else if (record.own.call === exec.callId) {
        if (json(result.value) !== json(record.value) || hash(json(result.content)) !== record.own.contentHash) record.invalid = true
        else record.successful = true
      } else record.ancestors.push({ call: exec.callId, contentHash: hash(json(result.content)) })
    }
    if (exec.parent !== undefined) executions.set(exec.parent, [...executions.get(exec.parent) ?? [], ...records])
  })
  ctx.on('llm/stream', async function* (options, next) {
    const owner = options.sessionId === undefined ? undefined : states.get(SessionId(options.sessionId))
    const eligible = !isAgentLoopRequest(options) || owner?.step === undefined ? [] : owner.records.filter(record =>
      record.value.inspection === 'sampled_frames' && committed(record) && record.metadata !== undefined && committed(record.metadata)
      && owner.step !== undefined && owner.step > record.step
      && hasImages(options.messages, record.value))
    const messages = eligible.length === 0 ? undefined : modelInput(ctx, options.messages, options.provider,
      await llm.resolveModelInfo(options.provider, options.model, options.signal), options.tools, options.toolHistory)
    let complete = false
    for await (const chunk of next()) {
      if (chunk.type === 'finish') complete = chunk.reason.kind === 'stop' || chunk.reason.kind === 'tool-calls' || chunk.reason.kind === 'max-tokens'
      yield chunk
    }
    if (complete && messages !== undefined && !options.signal?.aborted && owner?.step !== undefined) for (const record of eligible) {
      if (hasImages(messages, record.value)) record.input ??= { step: owner.step, hash: hash(json(messages)) }
    }
  })
  return ledger
}

function issuedReceipt(record: Record): TrustedVideoInspectionReceipt {
  const metadata = record.metadata
  if (metadata === undefined || record.value.window_plan !== undefined || metadata.value.window_plan === undefined || !committed(metadata)
    || !committed(record) || record.input?.response === undefined || record.own.ref === undefined || metadata.own.ref === undefined) {
    throw Error('video_evidence_pending: inspect metadata and frames, then allow a later model-image step to complete')
  }
  const roots = (row: Record): Ref => {
    return (row.ancestors.at(-1)?.ref ?? row.own.ref) as Ref
  }
  return TRUSTED_VIDEO_INSPECTION_RECEIPT.parse({ version: 'trusted-video-inspection-v2', video_path: record.value.path,
    source_version: record.value.source_version, duration_seconds: record.value.duration_seconds,
    metadata_manifest_path: metadata.value.manifest_path, manifest_path: record.value.manifest_path,
    metadata_manifest_sha256: metadata.manifestHash, manifest_sha256: record.manifestHash, plan: metadata.value.window_plan,
    windows: [{ ...record.value.interval, sample_requested_seconds: record.value.frames.map(row => row.requested_seconds),
      decoded_pts_seconds: record.value.frames.map(row => row.timestamp_seconds), frames: record.value.frames }],
    model_input_step: record.input.step, unresolved: [], evidence: { session_id: record.session.id,
      metadata_result: metadata.own.ref, metadata_root_result: roots(metadata), sample_result: record.own.ref,
      sample_root_result: roots(record), metadata_ancestors: metadata.ancestors.map(row => row.ref),
      sample_ancestors: record.ancestors.map(row => row.ref),
      model_response: record.input.response, model_input_sha256: record.input.hash } })
}

function successfulContent(event: SessionEvent): { call: ToolCallId; parent?: ToolCallId; content: RequestMessage['content']; name?: string } {
  if (event.type === 'tool/result' && event.data.message.isError !== true) return { call: event.data.message.toolCallId, content: event.data.message.content }
  if (event.type === 'tool/ptc-dispatch' && !event.data.isError) return {
    call: event.data.subCallId, parent: event.data.parentCallId, content: event.data.content, name: event.data.name }
  throw Error('Video evidence does not reference a successful tool result')
}

async function recover(ctx: Context, receipt: TrustedVideoInspectionReceipt, metadata: VideoInspection,
  sample: VideoInspection, signal: AbortSignal): Promise<void> {
  const query = ctx.get('sessionQuery'), sessions = ctx.get('sessions')
  if (query === undefined || sessions === undefined) throw Error('Accepted video evidence recovery requires Session query access')
  using observation = await query.observeSession(receipt.evidence.session_id, { signal, projectionMode: 'none' })
  const events = observation.events
  const event = (reference: Ref): SessionEvent => {
    const result = events[reference.seq]
    if (result === undefined || hash(json(result)) !== reference.sha256) throw Error('Video evidence Session event is missing or changed')
    return result
  }
  const verifyInspection = (value: VideoInspection, own: Ref, ancestors: Ref[], root: Ref): void => {
    const entry = event(own), result = successfulContent(entry)
    const call = events.find(row => row.type === 'tool/call' && row.data.callId === result.call)
    if ((result.name ?? (call?.type === 'tool/call' ? call.data.name : undefined)) !== 'video_inspect'
      || json(result.content) !== json(inspectionContent(value))) throw Error('Video evidence does not match the original video tool result')
    let previous = result
    for (const reference of ancestors) {
      const ancestor = successfulContent(event(reference))
      if (previous.parent !== ancestor.call || reference.seq <= own.seq) throw Error('Video evidence execution ancestry does not match')
      previous = ancestor
    }
    if (previous.parent !== undefined || json(root) !== json(ancestors.at(-1) ?? own)) throw Error('Video evidence lacks a successful outer result')
  }
  verifyInspection(metadata, receipt.evidence.metadata_result, receipt.evidence.metadata_ancestors, receipt.evidence.metadata_root_result)
  verifyInspection(sample, receipt.evidence.sample_result, receipt.evidence.sample_ancestors, receipt.evidence.sample_root_result)
  if (receipt.evidence.metadata_result.seq >= receipt.evidence.sample_result.seq) throw Error('Video evidence metadata did not precede sampling')
  const response = event(receipt.evidence.model_response), step = events[receipt.model_input_step]
  if (response.type !== 'assistant/message' || response.data.interrupted === true || step?.type !== 'step/start'
    || !expandAssistantStream(response.data.stream).some(({ chunk }) => chunk.type === 'finish'
      && ['stop', 'tool-calls', 'max-tokens'].includes(chunk.reason.kind))
    || response.data.turn !== step.data.turn || response.data.step !== step.data.step
    || receipt.evidence.sample_root_result.seq >= receipt.model_input_step
    || receipt.evidence.metadata_root_result.seq >= receipt.model_input_step
    || receipt.model_input_step >= response.seq) throw Error('Video evidence lacks a later successful model step')
  const llm = ctx.get('llm')
  if (llm === undefined) throw Error('Video evidence recovery requires the original model route')
  const replay = Session.create(receipt.evidence.session_id, events.slice(0, response.seq), observation.header,
    observation.inheritedEventCount, sessions.messageProjections)
  const messages = modelInput(ctx, replay.deriveMessages(), response.data.message.source.provider,
    await llm.resolveModelInfo(response.data.message.source.provider, response.data.message.source.model, signal),
    replay.requestHeader()?.tools, replay.toolHistory())
  if (messages === undefined || hash(json(messages)) !== receipt.evidence.model_input_sha256 || !hasImages(messages, sample)) {
    throw Error('Video evidence images were not in the recorded model input')
  }
}

/**
 * Resolve real tool and model-input evidence, or verify a Host-saved accepted receipt against its original Session log.
 * @param ctx - Host tools, filesystem, attachments, and optional Session query services.
 * @param session - Current initiating Session; required for in-progress work.
 * @param input - Imported manifest fields, used only to match the issued inspection.
 * @param signal - Cancels filesystem, attachment, and log reads.
 * @param persistedReceipt - Host-saved observation receipt; never take this argument from model tool JSON.
 * @returns Source-version-bound actual frame evidence; this does not establish semantic understanding or whole-video coverage.
 */
export async function resolveTrustedVideoEvidence(ctx: Context, session: Session | undefined, input: unknown, signal: AbortSignal,
  persistedReceipt?: unknown): Promise<TrustedVideoInspectionReceipt> {
  signal.throwIfAborted()
  const requested = binding.parse(input)
  let receipt: TrustedVideoInspectionReceipt
  if (persistedReceipt !== undefined) receipt = TRUSTED_VIDEO_INSPECTION_RECEIPT.parse(persistedReceipt)
  else {
    const record = session === undefined ? undefined : [...ledgers.get(session) ?? []]
      .flatMap(ledger => (ledger.states.get(session.id) as State).records)
      .findLast(row => row.session === session && row.value.inspection === 'sampled_frames' && json(binding.parse(row.value)) === json(requested))
    if (record === undefined) throw Error('video_evidence_pending: no live trusted inspection; inspect the current video again')
    receipt = issuedReceipt(record)
  }
  const read = async (path: string, expected: string): Promise<VideoInspection> => {
    const target = await ctx.fs.resolve(path, { signal })
    const text = await ctx.fs.readText(target, signal)
    if (hash(text) !== expected) throw Error('Video inspection manifest is missing or changed')
    const value: unknown = JSON.parse(text)
    if (!isInspection(value)) throw Error('Video inspection manifest fields are invalid')
    return value
  }
  const metadata = await read(receipt.metadata_manifest_path, receipt.metadata_manifest_sha256)
  const sample = await read(receipt.manifest_path, receipt.manifest_sha256)
  if (metadata.inspection !== 'metadata' || metadata.path !== receipt.video_path || metadata.source_version !== receipt.source_version
    || metadata.manifest_path !== receipt.metadata_manifest_path || sample.manifest_path !== receipt.manifest_path
    || metadata.duration_seconds !== receipt.duration_seconds || sample.path !== receipt.video_path
    || sample.source_version !== receipt.source_version
    || sample.duration_seconds !== receipt.duration_seconds || json(binding.parse(sample)) !== json(requested)
    || json(receipt.plan) !== json(metadata.window_plan) || json(receipt.windows) !== json([{ ...sample.interval,
    sample_requested_seconds: sample.frames.map(row => row.requested_seconds),
    decoded_pts_seconds: sample.frames.map(row => row.timestamp_seconds), frames: sample.frames }])) {
    throw Error('Video inspection does not match the trusted source and frames')
  }
  let end = 0
  for (const window of receipt.plan) {
    if (window.start_seconds !== end || window.end_seconds <= end || window.end_seconds > receipt.duration_seconds) throw Error('Video metadata plan has a gap or invalid interval')
    end = window.end_seconds
  }
  if (end !== receipt.duration_seconds) throw Error('Video metadata plan does not cover the probed duration')
  for (const frame of sample.frames) {
    if (frame.requested_seconds < sample.interval.start_seconds || frame.requested_seconds >= sample.interval.end_seconds
      || frame.timestamp_seconds < sample.interval.start_seconds || frame.timestamp_seconds >= sample.interval.end_seconds) throw Error('Video frame lies outside its actual sampled interval')
    const stored = await ctx.attachments.readImage(frame.image, signal)
    if (!stored.data.length || stored.data.length !== frame.image.bytes) throw Error('Video evidence attachment is empty or changed')
  }
  if (persistedReceipt !== undefined) await recover(ctx, receipt, metadata, sample, signal)
  const source = await ctx.fs.resolve(receipt.video_path, { signal })
  if ((await ctx.fs.stat(source, signal))?.version !== receipt.source_version) throw Error('Video evidence source version changed; inspect it again')
  signal.throwIfAborted()
  return receipt
}
