/** Read-only proof of an original video submitter from durable Host records. */
import { realpath } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type { JubianLedger } from '@deepseek-ai/dsh-jubian'
import type { ModelSelection } from '@deepseek-ai/dsh-agent'
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-working-directory'
import { TOOL_BODY_META_KEY } from '@deepseek-ai/dsh-tools'
import { z } from 'zod'
import type { GenerationWatchOwnerAttestor, GenerationWatchStore, GenerationWatchVerifiedOwner } from './generation-watch-store.ts'
import { recordedVideoPreview, recoveryProject } from './video-recovery-project.ts'
import { generationSessionBindingSchema } from './generation-binding.ts'
import type { GenerationSessionBinding } from './generation-binding.ts'

/** Read-only persistence methods required by the Host attestor. */
export interface GenerationWatchSessionReader {
  /** Observe the backend revision before and after reading evidence.
   * @param id - Original Session identifier.
   * @returns Stored revision, or undefined when the Session is unavailable.
   */
  stat(id: SessionId): Promise<{ readonly revision: unknown } | undefined>
  /** Open a durable Session without resuming an Agent or taking its write ownership.
   * @param id - Original Session identifier.
   * @param access - Read-only access.
   * @returns A handle to the stored Session.
   */
  open(id: SessionId, access: 'read'): Promise<{
    readonly header: SessionHeader
    readonly inheritedEventCount: number
    read(): Promise<{ readonly events: readonly SessionEvent[] }>
    close(): Promise<void>
  }>
}

/** Host proof that the current native runtime and exact workspace own this Session. */
export type GenerationWatchHostVerifier = (id: SessionId, header: SessionHeader, projectDir: string, workDir: string) => Promise<boolean>

const fields = z.object({ method: z.string(), preview_path: z.string().optional(), idempotency_key: z.string().optional(),
  video_previews: z.array(z.object({ preview_path: z.string(), idempotency_key: z.string() })).optional() })
const nested = z.object({ type: z.enum(['tool/ptc-dispatch-start', 'tool/ptc-dispatch']),
  data: z.object({ subCallId: z.string(), name: z.string(), arguments: z.unknown(),
    isError: z.boolean().optional(), meta: z.unknown().optional() }) })

function matches(value: unknown, owner: GenerationWatchVerifiedOwner): boolean {
  const parsed = fields.safeParse(value)
  if (!parsed.success) return false
  const args = parsed.data
  if (args.method === 'submit_video_batch') return args.video_previews?.some(item =>
    item.idempotency_key === owner.key && item.preview_path === owner.previewPath) === true
  return (args.method === 'submit_video' || args.method === 'generate')
    && args.idempotency_key === owner.key && args.preview_path === owner.previewPath
}

function namesRun(meta: unknown, owner: GenerationWatchVerifiedOwner): boolean {
  const envelope = z.object({ [TOOL_BODY_META_KEY]: z.object({ generationWatchId: z.string(), submission: fields }) }).safeParse(meta)
  return envelope.success && envelope.data[TOOL_BODY_META_KEY].generationWatchId === owner.runId
    && matches(envelope.data[TOOL_BODY_META_KEY].submission, owner)
}

function submitted(events: readonly SessionEvent[], inherited: number, header: SessionHeader,
  owner: GenerationWatchVerifiedOwner): string | undefined {
  if (header.origin === 'subagent' || header.id !== owner.sessionId) return undefined
  let cwd = header.cwd
  const direct = new Map<string, string>(), starts = new Map<string, string>(), found = new Set<string>()
  let recordedModel = false
  for (const event of events) {
    if (event.type === 'working-directory/change') cwd = event.data.cwd
    if (event.type === 'model/selection' || event.type === 'request/header') recordedModel = true
    if (event.seq < inherited) continue
    if (event.type === 'tool/call' && event.data.name === 'jubian_storyboard') {
      try { if (cwd !== undefined && matches(JSON.parse(event.data.arguments), owner)) direct.set(event.data.callId, cwd) }
      catch { direct.delete(event.data.callId) }
    }
    if (event.type === 'tool/result' && cwd !== undefined && direct.get(event.data.message.toolCallId) === cwd
      && event.data.message.isError !== true && namesRun(event.data.meta, owner)) found.add(cwd)
    const ptc = nested.safeParse(event)
    if (!ptc.success || ptc.data.data.name !== 'jubian_storyboard') continue
    const { data } = ptc.data
    if (ptc.data.type === 'tool/ptc-dispatch-start' && cwd !== undefined && matches(data.arguments, owner)) starts.set(data.subCallId, cwd)
    else if (cwd !== undefined && starts.get(data.subCallId) === cwd && matches(data.arguments, owner)
      && data.isError === false && namesRun(data.meta, owner)) found.add(cwd)
  }
  return recordedModel && cwd !== undefined && found.size === 1 && found.has(cwd) ? cwd : undefined
}

/**
 * Recover the model that produced the exact authenticated submission call.
 * Missing headers, mismatched assistant routes, repeated matching calls, and
 * inherited submission events do not identify one execution.
 * @param events - Original Session log in sequence order.
 * @param inherited - Number of events inherited from a parent Session.
 * @param owner - Host-verified original watch identity.
 * @returns The actual routed model and its explicitly selected effort, if uniquely established.
 */
function recordedSubmission(events: readonly SessionEvent[], inherited: number,
  owner: Readonly<GenerationWatchVerifiedOwner>): { model: Readonly<ModelSelection>; binding?: GenerationSessionBinding } | undefined {
  type Route = { selection: Readonly<ModelSelection>; turn: number; step: number; name: string; arguments: string }
  let header: Extract<SessionEvent, { type: 'request/header' }>['data']['header'] | undefined
  let position: { turn: number; step: number } | undefined
  const roots = new Map<string, Route | null>()
  type DispatchStart = {
    route: Route
    rootKey: string
    parentId: string
    parentKey?: string
    subId: string
    arguments: unknown
    name: string
  }
  const direct = new Map<string, Route>(), ptc = new Map<string, DispatchStart>(), rootCalls = new Set<string>()
  const found: { route: Route; rootKey: string; rootId: string; subKey?: string; subId?: string; binding?: GenerationSessionBinding }[] = []
  const unscopedRootIds = new Set<string>(), unscopedSubIds = new Set<string>(), invalidDispatches = new Set<string>()
  const advertised = new Map<string, number>(), calls = new Map<string, number>(), results = new Map<string, number>()
  const starts = new Map<string, number>(), ends = new Map<string, number>()
  const scoped = (turn: number, step: number, id: string): string => JSON.stringify([turn, step, id])
  const count = (values: Map<string, number>, id: string): void => { values.set(id, (values.get(id) ?? 0) + 1) }
  const nestedWithRoot = z.object({ type: z.enum(['tool/ptc-dispatch-start', 'tool/ptc-dispatch']),
    data: z.object({ rootCallId: z.string(), parentCallId: z.string(), subCallId: z.string(), name: z.string(), arguments: z.unknown(),
      isError: z.boolean().optional(), meta: z.unknown().optional() }) })
  for (const event of events) {
    if (event.type === 'request/header') { header = event.data.header; continue }
    if (event.seq < inherited) continue
    if (event.type === 'step/start') { position = event.data; continue }
    if (event.type === 'step/end' || event.type === 'turn/end' || event.type === 'turn/start') { position = undefined; continue }
    if (event.type === 'assistant/message') {
      const { message, turn, step } = event.data
      if (position?.turn !== turn || position.step !== step) {
        for (const block of message.content) if (block.type === 'tool-call') unscopedRootIds.add(block.id)
        continue
      }
      for (const block of message.content) if (block.type === 'tool-call') count(advertised, scoped(turn, step, block.id))
      if (header === undefined) continue
      const { provider, model, reasoningEffort } = header.config
      if (!provider || !model || message.source.provider !== provider || message.source.model !== model) continue
      const selection: ModelSelection = { provider, model,
        ...(header.adapterDefaults?.reasoningEffort === true || reasoningEffort === undefined ? {} : { reasoningEffort }) }
      for (const block of message.content) {
        if (block.type !== 'tool-call') continue
        const key = scoped(turn, step, block.id)
        if (roots.has(key)) {
          roots.set(key, null)
          direct.delete(key)
          rootCalls.delete(key)
        } else roots.set(key, { selection, turn, step, name: block.name, arguments: block.arguments })
      }
    }
    if (event.type === 'tool/call') {
      if (position?.turn !== event.data.turn || position.step !== event.data.step) { unscopedRootIds.add(event.data.callId); continue }
      const key = scoped(event.data.turn, event.data.step, event.data.callId)
      count(calls, key)
      const route = roots.get(key)
      if (!route || route.name !== event.data.name || route.arguments !== event.data.arguments) continue
      rootCalls.add(key)
      if (event.data.name === 'jubian_storyboard') {
        try { if (matches(JSON.parse(event.data.arguments), owner)) direct.set(key, route) }
        catch { direct.delete(key) }
      }
    }
    if (event.type === 'tool/result') {
      if (position?.turn !== event.data.turn || position.step !== event.data.step) {
        unscopedRootIds.add(event.data.message.toolCallId)
        continue
      }
      const key = scoped(event.data.turn, event.data.step, event.data.message.toolCallId)
      count(results, key)
      const route = direct.get(key)
      if (route && event.data.message.isError !== true && namesRun(event.data.meta, owner)) {
        found.push({ route, rootKey: key, rootId: event.data.message.toolCallId, ...bodyBinding(event.data.meta) })
      }
    }
    const nestedEvent = nestedWithRoot.safeParse(event)
    if (!nestedEvent.success) continue
    const { data } = nestedEvent.data
    if (position === undefined) { unscopedSubIds.add(data.subCallId); continue }
    const rootKey = scoped(position.turn, position.step, data.rootCallId)
    const subKey = scoped(position.turn, position.step, data.subCallId)
    count(nestedEvent.data.type === 'tool/ptc-dispatch-start' ? starts : ends, subKey)
    if (nestedEvent.data.type === 'tool/ptc-dispatch-start') {
      const route = roots.get(rootKey)
      const parentKey = data.parentCallId === data.rootCallId ? undefined : scoped(position.turn, position.step, data.parentCallId)
      const parent = parentKey === undefined ? undefined : ptc.get(parentKey)
      if (route && rootCalls.has(rootKey) && subKey !== rootKey
        && (parentKey === undefined || (parent !== undefined && parent.rootKey === rootKey))) {
        ptc.set(subKey, { route, rootKey, parentId: data.parentCallId, ...parentKey === undefined ? {} : { parentKey },
          subId: data.subCallId, arguments: data.arguments, name: data.name })
      }
    } else {
      const start = ptc.get(subKey)
      const valid = start !== undefined && start.rootKey === rootKey && start.parentId === data.parentCallId
        && start.name === data.name && isDeepStrictEqual(start.arguments, data.arguments)
        && roots.get(rootKey) === start.route && rootCalls.has(rootKey)
      if (!valid) invalidDispatches.add(subKey)
      if (valid && data.name === 'jubian_storyboard' && matches(data.arguments, owner)
        && data.isError === false && namesRun(data.meta, owner)) {
        found.push({ route: start.route, rootKey, rootId: data.rootCallId, subKey, subId: data.subCallId, ...bodyBinding(data.meta) })
      }
    }
  }
  const candidate = found.length === 1 ? found[0] : undefined
  if (candidate === undefined) return undefined
  if (advertised.get(candidate.rootKey) !== 1 || calls.get(candidate.rootKey) !== 1
    || unscopedRootIds.has(candidate.rootId)) return undefined
  if (candidate.subKey === undefined) {
    if (results.get(candidate.rootKey) !== 1) return undefined
  } else {
    if (ends.get(candidate.subKey) !== 1) return undefined
    let current: string | undefined = candidate.subKey
    while (current !== undefined) {
      // A unique dispatch start can reference only an earlier registered parent.
      const start: DispatchStart = ptc.get(current) as DispatchStart
      if (starts.get(current) !== 1
        || (ends.get(current) ?? 0) > 1 || invalidDispatches.has(current) || unscopedSubIds.has(start.subId)) return undefined
      current = start.parentKey
    }
  }
  return { model: candidate.route.selection, ...candidate.binding === undefined ? {} : { binding: candidate.binding } }
}

function bodyBinding(meta: unknown): { binding?: GenerationSessionBinding } {
  const parsed = z.object({ [TOOL_BODY_META_KEY]: z.object({ binding: generationSessionBindingSchema }) }).safeParse(meta)
  return parsed.success ? { binding: parsed.data[TOOL_BODY_META_KEY].binding } : {}
}

/**
 * Recover the routed model from the uniquely authenticated original submission.
 * @param events - Original Session events.
 * @param inherited - Inherited event count excluded from submission ownership.
 * @param owner - Exact original watch, key and preview identity.
 * @returns The recorded provider/model and explicit effort, if uniquely matched.
 */
export function recordedSubmissionModel(events: readonly SessionEvent[], inherited: number,
  owner: Readonly<GenerationWatchVerifiedOwner>): Readonly<ModelSelection> | undefined {
  return recordedSubmission(events, inherited, owner)?.model
}

/**
 * Read the bound execution identity from the same successful tool body as its model.
 * @param events - Original Session events, including body metadata.
 * @param inherited - Inherited events excluded from submission ownership.
 * @param owner - Exact original watch, key and preview identity.
 * @returns Authenticated original binding, or undefined for old or inconsistent evidence.
 */
export function recordedSubmissionBinding(events: readonly SessionEvent[], inherited: number,
  owner: Readonly<GenerationWatchVerifiedOwner>): GenerationSessionBinding | undefined {
  const evidence = recordedSubmission(events, inherited, owner)
  if (evidence?.binding === undefined || evidence.binding.sessionId !== owner.sessionId
    || !isDeepStrictEqual(evidence.model, evidence.binding.model)) return undefined
  return evidence.binding
}

type SubmissionModelReader = (owner: Readonly<GenerationWatchVerifiedOwner>, projectDir: string)
=> Promise<Readonly<ModelSelection> | undefined>

/**
 * Attest the owner and recover the model from a stable Session revision.
 * @param persistence - Host Session reader.
 * @param ledger - Original provider ledger.
 * @param verifyHost - Host-owned Session and workspace verifier.
 * @returns A reader that fails closed when model or ownership evidence is incomplete.
 */
export function createGenerationWatchSubmissionModelReader(persistence: GenerationWatchSessionReader,
  ledger: JubianLedger, verifyHost: GenerationWatchHostVerifier): SubmissionModelReader {
  const attest = createGenerationWatchOwnerAttestor(persistence, ledger, verifyHost)
  return async (owner, projectDir) => {
    const before = await persistence.stat(owner.sessionId)
    if (before === undefined) return undefined
    const handle = await persistence.open(owner.sessionId, 'read')
    try {
      if (handle.header.id !== owner.sessionId || handle.header.origin === 'subagent') return undefined
      const { events } = await handle.read()
      const model = recordedSubmissionModel(events, handle.inheritedEventCount, owner)
      if (model === undefined || !await attest(owner, projectDir)) return undefined
      const after = await persistence.stat(owner.sessionId)
      return after !== undefined && before.revision === after.revision ? model : undefined
    } finally { await handle.close() }
  }
}

/** Create a Host-only attestor backed by durable Session and ledger reads.
 * @param persistence - Read-only Session persistence service.
 * @param ledger - Host-owned durable provider ledger.
 * @param verifyHost - Host-owned proof of native runtime and exact workspace ownership.
 * @returns Verifier for original submitter, project, key and preview evidence.
 */
export function createGenerationWatchOwnerAttestor(persistence: GenerationWatchSessionReader,
  ledger: JubianLedger, verifyHost: GenerationWatchHostVerifier): GenerationWatchOwnerAttestor {
  return async (owner, projectDir) => {
    if (!isAbsolute(owner.previewPath) || !isAbsolute(projectDir)) return false
    const project = await recoveryProject(projectDir)
    const record = await ledger.find(owner.key)
    const preview = await recordedVideoPreview(record, project)
    if (preview === undefined || preview !== await realpath(owner.previewPath)) return false
    const before = await persistence.stat(owner.sessionId)
    if (before === undefined) return false
    const handle = await persistence.open(owner.sessionId, 'read')
    try {
      const { events } = await handle.read()
      const workDir = submitted(events, handle.inheritedEventCount, handle.header, owner)
      if (workDir === undefined || !await verifyHost(owner.sessionId, handle.header, project.directory, workDir)) return false
      const current = await recoveryProject(projectDir)
      const nextRecord = await ledger.find(owner.key)
      const nextPreview = await recordedVideoPreview(nextRecord, current)
      const hostStillMatches = await verifyHost(owner.sessionId, handle.header, current.directory, workDir)
      const after = await persistence.stat(owner.sessionId)
      return hostStillMatches && after !== undefined && before.revision === after.revision
        && current.directory === project.directory && current.scriptId === project.scriptId
        && current.configSha256 === project.configSha256
        && JSON.stringify(nextRecord) === JSON.stringify(record) && nextPreview === preview
    } finally { await handle.close() }
  }
}

/** Host-private original submitter lookup; it does not identify an approving reviewer. */
export interface GenerationWatchOwnerResolver {
  /** Resolve the original submitting identity against current durable evidence.
   * @param key - Original idempotency key.
   * @param previewPath - Original absolute preview path.
   * @param projectDir - Selected absolute project directory.
   * @returns The unique submitting identity, or undefined when evidence is insufficient.
   */
  resolve(key: string, previewPath: string, projectDir: string): Promise<GenerationWatchVerifiedOwner | undefined>
  /** Refuse new lookups and wait for admitted reads to finish. */
  close(): Promise<void>
}

/** Bind one resolver to the Host's actual Session and ledger services.
 * @param store - Host-private watch records.
 * @param persistence - Host Session persistence, opened read-only for attestations.
 * @param ledger - Original generation ledger.
 * @param verifyHost - Host-owned proof of native runtime and exact workspace ownership.
 * @returns A disposable resolver that never accepts a caller-supplied attestor.
 */
export function createGenerationWatchOwnerResolver(store: GenerationWatchStore, persistence: GenerationWatchSessionReader,
  ledger: JubianLedger, verifyHost: GenerationWatchHostVerifier): GenerationWatchOwnerResolver {
  const attest = createGenerationWatchOwnerAttestor(persistence, ledger, verifyHost)
  const operations = new Set<Promise<unknown>>()
  let closing = false
  return {
    resolve(key, previewPath, projectDir) {
      if (closing) return Promise.reject(new Error('Generation watch owner resolver is closed'))
      const operation = (async () => {
        const value = await store.resolveVerifiedOwner(key, previewPath, projectDir, attest)
        // oxlint-disable-next-line typescript/no-unnecessary-condition -- close can run while the read is awaited.
        if (closing) throw new Error('Generation watch owner resolver is closed')
        return value
      })()
      operations.add(operation)
      void operation.then(() => { operations.delete(operation) }, () => { operations.delete(operation) })
      return operation
    },
    async close() {
      closing = true
      await Promise.allSettled([...operations])
    },
  }
}
