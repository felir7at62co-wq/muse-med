/** Durable ordinary-Session routing, receipts, cancellation, and recovery. */
import { randomUUID, createHash } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SubagentError } from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-api-workspace-controller'
import type {} from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-working-directory'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from '@deepseek-ai/dsh-jobs'
import type {} from '@deepseek-ai/dsh-tool-present/types'
import type {} from '@deepseek-ai/dsh-tool-jubian'
import { createUserMessage, boundContextSummary } from '@deepseek-ai/dsh-llm'
import type { MessageId, UserMessage } from '@deepseek-ai/dsh-llm'
import { brandString } from '@deepseek-ai/dsh-brand'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import type { ProjectionHandle } from '@deepseek-ai/dsh-session-projection'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { coordinationDomain, latest, reservesWorker, revise } from './ledger.ts'
import type { CoordinationTask, CoordinationTaskId, CoordinationReport, DispatchRequest, ReconcileRequest, WorkerReport } from './types.ts'
import { ToolArgsError, ToolContextUnavailableError } from '@deepseek-ai/dsh-tools'
import type { ToolExecution, ToolGuardDenial } from '@deepseek-ai/dsh-tools'

const reconciliationInputSchema = zod.object({
  humanId: zod.string().nullable(),
  humanSeq: zod.number().int().nonnegative().nullable(),
  brief: zod.object({ id: zod.string(), taskId: zod.string(), revision: zod.number().int().positive() }).nullable(),
})
type ReconciliationInput = zod.infer<typeof reconciliationInputSchema>
const reconciliationReads = new Set(['read', 'read_image', 'glob', 'grep', 'present', 'coordinator_report'])

export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Profile-owner task router; workers remain ordinary Sessions. */
    sessionCoordinator: SessionCoordinator
  }
}

/** Deployment choices for the optional coordination plugin. */
export interface Config {
  /** Routing-only preset id. Defaults to `main-session`. */
  readonly mainPreset?: string
  /** Preset used only for newly created workers. Defaults to `short-drama`. */
  readonly workerPreset?: string
  /** Maximum returned Session search rows or report tasks. Defaults to 30. */
  readonly searchLimit?: number
  /** History-page characters and combined serialized report content/metadata budget. Defaults to 24000. */
  readonly readChars?: number
}

/** Task router whose durable writes precede Session creation and message delivery. */
export class SessionCoordinator extends TypertRemoteService {
  static inject = [
    'agents', 'sessions', 'sessionQuery', 'sessionController', 'workspaceController', 'storageDomain', 'workspaceRegistry', 'jobs', 'typert', 'tools', 'sessionProjections',
  ]
  static Config: z<Config> = z.object({
    mainPreset: z.string().default('main-session'), workerPreset: z.string().default('short-drama'),
    searchLimit: z.natural().min(1).default(30), readChars: z.natural().min(1).default(24000),
  })

  private readonly config: Required<Config>
  private table!: KvTable<CoordinationTaskId, CoordinationTask>
  private entry!: KvTable<'main', SessionId>
  private tail: Promise<void> = Promise.resolve()
  private readonly lifetime = new AbortController()
  private readonly observers = new Set<() => void>()
  private generation = 0
  private readonly treeWaits = new Map<Agent, Promise<void>>()
  private reconciliationInput!: ProjectionHandle<ReconciliationInput>

  /**
   * @param ctx - Profile-owner Host services.
   * @param config - Validated preset ids and retrieval limits.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'sessionCoordinator', { namespace: 'sessionCoordinator' })
    this.config = config as Required<Config>
  }

  protected async [Service.init](): Promise<void> {
    if (this.config.mainPreset === this.config.workerPreset) throw new Error('Coordinator and worker presets must differ')
    const domain = await this.ctx.storageDomain.open(coordinationDomain)
    this.table = domain.table('tasks')
    this.entry = domain.table('entry')
    this.ctx.effect(() => async () => {
      this.lifetime.abort()
      this.changed()
      await this.tail
      await domain.close()
    })
    this.reconciliationInput = await this.ctx.sessionProjections.register({
      key: 'museCoordinationInput', stateVersion: 2, stateSchema: reconciliationInputSchema,
      init: () => ({ humanId: null, humanSeq: null, brief: null }),
      apply: (state, event) => {
        if (event.type !== 'user/message') return state
        if (event.data.source.kind === 'user') return { ...state, humanId: event.data.id, humanSeq: event.seq }
        const source = event.data.source
        return source.kind === 'muse-coordination' && source.purpose === 'assignment'
          ? { ...state, brief: { id: event.data.id, taskId: source.taskId, revision: source.revision } } : state
      },
    })
    this.ctx.effect(() => this.ctx.tools.guard(exec => this.reconciliationGuard(exec)))
    this.ctx.effect(() => this.ctx.sessionController.registerBlankReuseFilter(
      (id, preset) => id !== this.entry.get('main') || preset === this.config.mainPreset,
    ), 'coordination: reserve Main Session identity')
    this.ctx.on('agent/status', ({ agent, status }) => {
      if (status === 'idle') this.background(() => this.settleRelated(agent))
    })
    this.ctx.on('session/event', (session, event) => {
      if (event.type === 'user/message' && event.data.source.kind === 'muse-coordination'
        && event.data.source.purpose === 'assignment') {
        const source = event.data.source
        this.background(async () => {
          const task = this.table.get(source.taskId)
          if (task === undefined || latest(task).revision !== source.revision || latest(task).sessionId !== session.id) return
          if (['accepted', 'dispatching', 'reconciling'].includes(latest(task).status)) await this.save(revise(task, { status: 'running' }))
        })
      }
      if (event.type === 'user/message' && event.data.source.kind === 'user') {
        const input = event.data
        const affected = [...this.table.entries()].flatMap(([id, task]) => {
          const attempt = latest(task)
          return attempt.sessionId === session.id && reservesWorker(attempt) && attempt.status !== 'stopping'
            && attempt.messageId !== input.id && !attempt.forwardedIds.includes(input.id)
            && event.seq > (attempt.reconciliation?.throughSeq ?? -1)
            ? [{ id, revision: attempt.revision }] : []
        })
        this.background(async () => {
          for (const captured of affected) {
            const task = this.table.get(captured.id)
            if (task === undefined) continue
            const attempt = latest(task)
            if (attempt.revision !== captured.revision || attempt.status === 'stopping' || attempt.status === 'stopped') continue
            const log = await this.ctx.sessionQuery.readSession(session.id)
            const anchor = log.events.find(item => item.type === 'user/message' && item.data.id === attempt.messageId)
            if (anchor === undefined || event.seq <= anchor.seq) continue
            await this.publish(revise(task, { status: 'interrupted', report: null, changedInputSeq: event.seq,
              issue: 'Worker received a later direct human request. Inspect its history and reconcile this task before reporting; the new work was not stopped.' }))
          }
        })
      }
    })
    this.ctx.effect(() => this.ctx.jobs.events.subscribe({ owners: 'all' }, (event) => {
      if (event.type === 'settled' && event.job.owner !== undefined) this.background(() => this.settleAllWorkers())
    }), 'coordination: owned Job settlement')
    this.ctx.on('subagent/end', () => { this.background(() => this.settleAllWorkers()) })
    this.background(() => this.recover())
  }

  /**
   * Observe the retained Main Session identity without creating a Session.
   * @param signal - Client cancellation; plugin unload also closes the stream.
   * @returns the initial identity and subsequent changes.
   */
  @Remote({ mode: 'stream' })
  async *watchMain(signal: AbortSignal): AsyncIterable<SessionId | null> {
    const combined = AbortSignal.any([signal, this.lifetime.signal])
    while (!combined.aborted) {
      const generation = this.generation
      yield this.entry.get('main') ?? null
      if (generation !== this.generation) continue
      await new Promise<void>((resolve) => {
        const wake = (): void => { this.observers.delete(wake); combined.removeEventListener('abort', wake); resolve() }
        this.observers.add(wake)
        combined.addEventListener('abort', wake, { once: true })
        if (combined.aborted || generation !== this.generation) wake()
      })
    }
  }

  /**
   * Open the profile's durable Main Session from its dedicated navigation entry.
   * @returns the retained routing Session, initially created in the native default Workspace.
   */
  @Remote
  openMain(): Promise<SessionId> {
    return this.serial(async () => {
      const saved = this.entry.get('main')
      const id = saved ?? SessionId(`session-${randomUUID()}`)
      const exists = (await this.ctx.sessionQuery.listSessions(this.lifetime.signal)).some(row => row.header.id === id)
      if (!exists) {
        const initial = await this.ctx.workspaceController.initializeDefault(this.lifetime.signal)
        if (initial === undefined) throw new Error('The default Workspace is unavailable; restore it before opening Main Session')
        if (saved === undefined) {
          await this.entry.put('main', id)
          this.changed()
        }
        const result = await this.ctx.sessionController.create({
          sessionId: id, workspaceId: initial.workspace.workspaceId, agentPreset: this.config.mainPreset,
        })
        if (result.sessionId !== id) throw new Error('Main Session creation returned another identity')
      }
      if (this.ctx.workspaceRegistry.archivedSessionIds.includes(id)) await this.ctx.workspaceRegistry.unarchiveSession(id)
      const result = await this.ctx.sessionController.resolveAgent(id)
      if ('error' in result) throw result.error
      return id
    })
  }

  /**
   * Assert the exact live caller holds the configured routing role.
   * @param agent - Actual tool subject, never an argument-supplied identity.
   */
  async requireMain(agent: Agent): Promise<void> {
    const registry = this.ctx.get('agentPresets')
    const preset = registry === undefined ? agent.session.header.agentPreset : registry.composedPreset(agent.ctx)
    if (this.ctx.agents.get(agent.id) !== agent || preset !== this.config.mainPreset) {
      throw new ToolContextUnavailableError('Only a live main-session Agent can route work')
    }
    const history = await this.ctx.sessionQuery.readSession(agent.id)
    const input = history.events.findLast(event => event.type === 'user/message' && event.data.source.kind === 'user')
    if (input?.type !== 'user/message') throw new ToolContextUnavailableError('An owner request is required before coordinating work')
    if ('principal' in input.data.source) {
      throw new ToolContextUnavailableError('Cross-session coordination requires the local profile owner')
    }
  }

  /**
   * Search the local profile owner's ordinary Sessions without activating them.
   * @param main - Exact routing Agent.
   * @param query - Literal title or content text; empty lists recent Sessions.
   * @returns bounded candidates with titles, excerpts, workspace, busy and archive facts.
   */
  async search(main: Agent, query: string): Promise<string> {
    await this.requireMain(main)
    const page = query.trim() === '' ? null : await this.ctx.sessionQuery.searchSessions({ query, limit: this.config.searchLimit }, { signal: this.lifetime.signal })
    const rows = page === null ? await this.ctx.sessionQuery.listSessions(this.lifetime.signal) : page.items
    const visible = rows.filter(row => row.header.id !== main.id && row.header.origin !== 'subagent'
      && row.header.agentPreset !== this.config.mainPreset)
    const candidates = []
    for (const row of visible.slice(0, this.config.searchLimit)) {
      const header = row.header
      const title = (await this.ctx.sessionQuery.readTitle(header.id))?.title ?? ''
      candidates.push({ sessionId: header.id, title, cwd: header.cwd ?? null,
        preset: header.agentPreset ?? null, busy: this.busy(header.id),
        archived: this.ctx.workspaceRegistry.archivedSessionIds.includes(header.id),
        excerpt: 'bestMatch' in row ? row.bestMatch.snippet : null })
    }
    return JSON.stringify({ sessions: candidates, limit: this.config.searchLimit,
      guidance: 'Read candidate history before reuse. Archived Sessions are reference-only. Busy Sessions require a fresh worker.' })
  }

  /**
   * Read exact recent input and response excerpts before choosing full history pages.
   * @param main - Actual routing Agent.
   * @param sessionId - Local profile-owner Session.
   * @returns latest input and response with event positions and explicit truncation flags.
   */
  async summary(main: Agent, sessionId: SessionId): Promise<string> {
    await this.requireMain(main)
    const snapshot = await this.ctx.sessionQuery.readSurface(sessionId)
    const input = snapshot.events.findLast(event => event.type === 'user/message'
      && (event.data.source.kind === 'user' || event.data.source.kind === 'muse-coordination'))
    const response = snapshot.events.findLast(event => event.type === 'assistant/message')
    const excerpts = [input, response].flatMap((event) => {
      if (event?.type !== 'user/message' && event?.type !== 'assistant/message') return []
      const content = event.type === 'user/message' ? event.data.content : event.data.message.content
      const text = content.filter(block => block.type === 'text').map(block => block.text).join('\n')
      const limit = Math.floor(this.config.readChars / 2)
      return [{ seq: event.seq, type: event.type, text: text.slice(0, limit), truncated: text.length > limit }]
    })
    return JSON.stringify({ session: snapshot.session, title: (await this.ctx.sessionQuery.readTitle(sessionId))?.title ?? '',
      excerpts, guidance: 'These are source excerpts, not a semantic completeness assessment. Read the cited event positions and earlier requirements before reuse.' })
  }

  /**
   * Read a bounded, cursor-addressed history page for routing and source retrieval.
   * @param main - Exact routing Agent.
   * @param sessionId - Ordinary Session in the same local owner profile.
   * @param fromSeq - Inclusive raw-event position, zero for the first page.
   * @returns JSON events and an explicit next position; no history is activated.
   */
  async read(main: Agent, sessionId: SessionId, fromSeq: number): Promise<string> {
    await this.requireMain(main)
    if (!Number.isSafeInteger(fromSeq) || fromSeq < 0) throw new Error('History cursor must be a nonnegative integer')
    const snapshot = await this.ctx.sessionQuery.readSession(sessionId)
    if (snapshot.session.origin === 'subagent') throw new Error('Read the ordinary parent Session instead')
    const events = []
    let chars = 0
    let nextSeq: number | null = null
    for (const event of snapshot.events) {
      if (event.seq < fromSeq) continue
      const text = JSON.stringify(event)
      if (chars + text.length > this.config.readChars && events.length > 0) { nextSeq = event.seq; break }
      events.push(event)
      chars += text.length
    }
    return JSON.stringify({ session: snapshot.session, events, nextSeq, complete: nextSeq === null })
  }

  /**
   * Record and deliver one new goal or an explicit revision, reusing an identical key.
   * @param main - Exact routing Agent.
   * @param request - Agent-selected existing or fresh ordinary worker and original requirements.
   * @returns authoritative task; acceptance is not execution completion.
   */
  async dispatch(main: Agent, request: DispatchRequest): Promise<CoordinationTask> {
    await this.requireMain(main)
    return this.serial(async () => {
      if ([request.key, request.title, request.instructions, request.reason].some(value => value.trim() === '')) throw new Error('Dispatch key, title, instructions and reason must be nonempty')
      if ((request.taskId === undefined) !== (request.expectedRevision === undefined)) throw new Error('Continuations require both task id and expected revision')
      const requestHash = createHash('sha256').update(JSON.stringify({
        key: request.key, title: request.title, instructions: request.instructions, reason: request.reason,
        sessionId: request.sessionId ?? null, cwd: request.cwd ?? null, taskId: request.taskId ?? null,
        expectedRevision: request.expectedRevision ?? null,
      })).digest('hex')
      const existing = [...this.table.entries()].map(([, task]) => task)
        .find(task => task.owner === main.id && task.attempts.some(attempt => attempt.key === request.key))
      if (existing !== undefined) {
        const attempt = existing.attempts.find(item => item.key === request.key)
        if (attempt === undefined) throw new Error('Dispatch key has no matching assignment')
        if (attempt.requestHash !== requestHash) throw new Error('Dispatch key already names different work')
        return latest(existing).status === 'dispatching' ? this.deliver(existing) : existing
      }
      const source = (await this.ctx.sessionQuery.readSession(main.id)).events.findLast(event => event.type === 'user/message' && event.data.source.kind === 'user')
      if (source === undefined) throw new Error('A human request is required before dispatch')
      const previous = request.taskId === undefined ? undefined : this.owned(main.id, request.taskId)
      if (previous !== undefined && latest(previous).revision !== request.expectedRevision) throw new Error('Task revision changed; read tasks again')
      if (previous !== undefined && reservesWorker(latest(previous))) throw new Error('Stop or settle the current assignment before revising it')
      const target = request.sessionId ?? SessionId(`session-${randomUUID()}`)
      const createSession = request.sessionId === undefined
      const targetHeader = createSession ? undefined : await this.requireReusable(target, main.id)
      const cwd = targetHeader?.cwd ?? request.cwd ?? main.session.header.cwd
      if (targetHeader !== undefined && request.cwd !== undefined && request.cwd !== targetHeader.cwd) throw new Error('Existing worker directory cannot be changed by dispatch')
      if (cwd === undefined) throw new Error('A worker requires an explicit working directory')
      if ([...this.table.entries()].some(([, task]) => latest(task).sessionId === target && reservesWorker(latest(task)))) {
        throw new Error('Worker already has an unsettled task; create a fresh Session')
      }
      const video = (await this.ctx.sessionQuery.readSession(main.id)).events.findLast(event => event.type === 'jubian/video-selection')
      const messageId = createUserMessage({ content: [], source: { kind: 'user' } }).id
      let task: CoordinationTask = {
        id: previous?.id ?? brandString<CoordinationTaskId>(`task-${randomUUID()}`), owner: main.id,
        title: previous?.title ?? request.title, createdAt: previous?.createdAt ?? Date.now(),
        attempts: [...previous?.attempts ?? [], {
          revision: (previous === undefined ? 0 : latest(previous).revision) + 1,
          key: request.key, requestHash, instructions: request.instructions, reason: request.reason, sourceSeq: source.seq,
          messageId, forwardedIds: [], briefId: createUserMessage({ content: [], source: { kind: 'user' } }).id,
          noticeId: createUserMessage({ content: [], source: { kind: 'user' } }).id,
          sessionId: target, createSession, cwd, sourceCwd: main.session.header.cwd ?? null, videoKey: video?.type === 'jubian/video-selection' ? video.data.selection.key : null,
          status: 'dispatching', report: null, issue: null, notifiedStatus: null,
        }],
      }
      const originals = await this.humanInputs(task)
      task = revise(task, { forwardedIds: originals.map((_input, index) => index === originals.length - 1
        ? messageId : createUserMessage({ content: [], source: { kind: 'user' } }).id) })
      await this.save(task)
      try { return await this.deliver(task) }
      catch (error) {
        await this.save(revise(task, { status: 'interrupted', issue: String(error) }))
        throw error
      }
    })
  }

  /**
   * Ask an inspected original worker to verify existing results without replaying human business commands.
   * @param main - Exact live owner Main Agent.
   * @param request - Idempotent recovery request with task and complete worker-history revisions.
   * @returns retained successor assignment; an uncertain delivery remains interrupted for inspection.
   */
  async reconcile(main: Agent, request: ReconcileRequest): Promise<CoordinationTask> {
    await this.requireMain(main)
    return this.serial(async () => {
      if ([request.key, request.instructions, request.reason].some(value => value.trim() === '')
        || !Number.isSafeInteger(request.expectedWorkerSeq) || request.expectedWorkerSeq < 0
        || !Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 1) {
        throw new ToolArgsError(['Reconciliation needs a nonempty key, instructions, reason, and valid expected revisions'])
      }
      const requestHash = createHash('sha256').update(JSON.stringify({ kind: 'reconcile', key: request.key,
        taskId: request.taskId, expectedRevision: request.expectedRevision, expectedWorkerSeq: request.expectedWorkerSeq,
        instructions: request.instructions, reason: request.reason })).digest('hex')
      const existing = this.list(main.id).find(task => task.attempts.some(attempt => attempt.key === request.key))
      if (existing !== undefined) {
        if (existing.attempts.find(attempt => attempt.key === request.key)?.requestHash !== requestHash) {
          throw new ToolArgsError(['Request key already names different work'])
        }
        return latest(existing).status === 'reconciling' ? this.deliverReconciliation(existing) : existing
      }
      const previous = this.owned(main.id, request.taskId)
      const attempt = latest(previous)
      if (attempt.revision !== request.expectedRevision) throw new ToolArgsError(['Task revision changed; read tasks again'])
      if (!['needs-report', 'interrupted'].includes(attempt.status)) {
        throw new ToolArgsError(['Only needs-report or interrupted assignments can be reconciled'])
      }
      await this.requireReusable(attempt.sessionId, main.id)
      const resolved = await this.ctx.sessionController.resolveAgent(attempt.sessionId)
      if ('error' in resolved) throw resolved.error
      await this.ctx.sessions.flush(resolved.agent.session)
      const log = await this.ctx.sessionQuery.readSession(attempt.sessionId)
      if (log.events.at(-1)?.seq !== request.expectedWorkerSeq) throw new ToolArgsError(['Worker history changed; read its complete history again'])
      const human = log.events.findLast(event => event.type === 'user/message' && event.data.source.kind === 'user')
      if (human?.type !== 'user/message' || human.data.source.kind !== 'user' || 'principal' in human.data.source) {
        throw new ToolContextUnavailableError('Reconciliation requires a retained local owner input in the original worker')
      }
      const source = (await this.ctx.sessionQuery.readSession(main.id)).events.findLast(event => event.type === 'user/message' && event.data.source.kind === 'user')
      if (source === undefined) throw new ToolContextUnavailableError('A retained Main owner request is required')
      let task: CoordinationTask = { ...previous, attempts: [...previous.attempts, {
        revision: attempt.revision + 1, key: request.key, requestHash, instructions: request.instructions, reason: request.reason,
        sourceSeq: source.seq, messageId: human.data.id, forwardedIds: [],
        briefId: createUserMessage({ content: [], source: { kind: 'user' } }).id,
        noticeId: createUserMessage({ content: [], source: { kind: 'user' } }).id,
        sessionId: attempt.sessionId, createSession: false, cwd: attempt.cwd, sourceCwd: main.session.header.cwd ?? null,
        videoKey: attempt.videoKey, status: 'reconciling', report: null, issue: null, notifiedStatus: null,
        reconciliation: { throughSeq: request.expectedWorkerSeq, humanSeq: human.seq, humanMessageId: human.data.id },
      }] }
      await this.humanInputs(task)
      await this.save(task)
      try { task = await this.deliverReconciliation(task) }
      catch (error) {
        await this.save(revise(task, { status: 'interrupted', issue: String(error) }))
        throw error
      }
      return task
    })
  }

  /**
   * List the local owner's task records without activating their Agents. This Remote surface requires global owner access.
   * @param sessionId - Main Session whose assignments to read.
   * @returns current and previous revisions, including exact worker and artifact references.
   */
  @Remote
  list(sessionId: SessionId): CoordinationTask[] {
    return [...this.table.entries()].map(([, task]) => task).filter(task => task.owner === sessionId)
  }

  /**
   * Capture an owner-verified report without accepting model-authored status or files.
   * @param main - Actual live Main Agent with a local owner request.
   * @param taskIds - Exact owned goals; omission or an empty list selects recent goals.
   * @returns Complete task facts bounded by searchLimit and the combined readChars model-result/metadata budget.
   */
  async displayReport(main: Agent, taskIds: readonly CoordinationTaskId[] = []): Promise<CoordinationReport> {
    await this.requireMain(main)
    if (taskIds.length > this.config.searchLimit) throw new ToolArgsError(['task_ids exceeds the configured report limit'])
    if (new Set(taskIds).size !== taskIds.length) throw new ToolArgsError(['task_ids must be unique'])
    const selected = taskIds.length === 0
      ? this.list(main.id).sort((a, b) => b.createdAt - a.createdAt)
      : taskIds.map(id => this.owned(main.id, id))
    let report: CoordinationReport = { version: 1, owner: main.id, total: selected.length, truncated: selected.length > 0, tasks: [] }
    const fits = (value: CoordinationReport): boolean => JSON.stringify(value).length
      + JSON.stringify({ museCoordinationReport: value }).length <= this.config.readChars
    if (!fits(report)) throw new ToolArgsError(['The empty report exceeds the configured readChars budget'])
    for (const task of selected.slice(0, this.config.searchLimit)) {
      const attempt = latest(task)
      const item = { id: task.id, title: task.title, revision: attempt.revision, sessionId: attempt.sessionId,
        cwd: attempt.cwd, status: attempt.status, issue: attempt.issue,
        report: attempt.report === null ? null : { ...attempt.report, files: attempt.report.files.map(file => ({
          path: file.path, ...(file.description === undefined ? {} : { description: file.description }),
        })) } }
      const next = { ...report, tasks: [...report.tasks, item], truncated: report.tasks.length + 1 < selected.length }
      if (!fits(next)) {
        if (report.tasks.length === 0) throw new ToolArgsError(['The task report exceeds the configured readChars budget; inspect its source through coordinator_read'])
        break
      }
      report = next
    }
    return report
  }

  /**
   * Observe complete owner-only task snapshots; no model polling or wake loop.
   * @param sessionId - Main Session selecting the task directory.
   * @param signal - Client cancellation; plugin unload also closes the stream.
   * @returns initial and changed task sets.
   */
  @Remote({ mode: 'stream' })
  async *watch(sessionId: SessionId, signal: AbortSignal): AsyncIterable<CoordinationTask[]> {
    const combined = AbortSignal.any([signal, this.lifetime.signal])
    while (!combined.aborted) {
      const generation = this.generation
      yield this.list(sessionId)
      if (generation !== this.generation) continue
      await new Promise<void>((resolve) => {
        const wake = (): void => { this.observers.delete(wake); combined.removeEventListener('abort', wake); resolve() }
        this.observers.add(wake)
        combined.addEventListener('abort', wake, { once: true })
        if (combined.aborted || generation !== this.generation) wake()
      })
    }
  }

  /**
   * Request one task's cancellation, retaining stopping until its Agent and jobs settle.
   * This owner-only Remote operation never cancels an unrelated worker assignment.
   * @param sessionId - Owning Main Session.
   * @param taskId - Exact owned goal.
   * @param revision - Assignment revision shown to the user.
   * @returns durable stopping or stopped receipt.
   */
  @Remote
  stop(sessionId: SessionId, taskId: CoordinationTaskId, revision: number): Promise<CoordinationTask> {
    return this.serial(async () => {
      let task = this.owned(sessionId, taskId)
      const attempt = latest(task)
      if (attempt.revision !== revision) throw new Error('Task revision changed; read tasks again')
      if (!reservesWorker(attempt)) return task
      task = revise(task, { status: 'stopping', issue: null })
      await this.save(task)
      const exists = (await this.ctx.sessionQuery.listSessions(this.lifetime.signal)).some(row => row.header.id === attempt.sessionId)
      if (!exists) {
        await this.publish(revise(task, { status: 'stopped' }))
        return this.owned(sessionId, taskId)
      }
      const resolved = await this.ctx.sessionController.resolveAgent(attempt.sessionId)
      if ('error' in resolved) throw resolved.error
      const worker = resolved.agent
      for (const id of [attempt.briefId, ...attempt.forwardedIds]) worker.inbox.remove(id)
      const lastInput = (await this.ctx.sessionQuery.readSession(worker.id)).events.findLast(event => event.type === 'user/message')
      const hasActivity = this.busy(worker.id)
      if (hasActivity && lastInput?.type === 'user/message'
        && ![attempt.briefId, ...attempt.forwardedIds].includes(lastInput.data.id)) {
        return this.save(revise(task, { status: 'interrupted', issue: 'Worker is processing another input; it was not cancelled' }))
      }
      const descendants = await this.descendantIds(worker)
      worker.cancel({ kind: 'user' }, { keepInbox: true })
      const subagents = this.ctx.get('subagents')
      subagents?.interruptTree(worker)
      for (const id of [worker.id, ...descendants]) {
        for (const job of this.liveJobs(id)) this.ctx.jobs.kill(job.id, id, 'Main Session stopped this task')
      }
      await this.ctx.sessions.flush(worker.session)
      await this.settleWorker(worker)
      return this.owned(sessionId, task.id)
    })
  }

  /**
   * Accept a report only from the exact worker that consumed this revision's input.
   * @param worker - Actual live reporting tool subject.
   * @param taskId - Goal named in its assignment.
   * @param revision - Consumed revision.
   * @param outcome - Explicit business result, not inferred from idle.
   * @param summary - Worker account supported by its native tool log.
   * @returns task in finishing state; completion is published after quiescence.
   */
  report(worker: Agent, taskId: CoordinationTaskId, revision: number, outcome: WorkerReport['outcome'], summary: string): Promise<CoordinationTask> {
    return this.serial(async () => {
      if (this.ctx.agents.get(worker.id) !== worker) throw new ToolContextUnavailableError('Report requires the current live worker instance')
      const task = this.table.get(taskId)
      if (task === undefined || latest(task).sessionId !== worker.id || latest(task).revision !== revision
        || !reservesWorker(latest(task)) || latest(task).status === 'stopping') throw new ToolArgsError(['No current assignment belongs to this worker'])
      const events = (await this.ctx.sessionQuery.readSession(worker.id)).events
      const input = events.find(event => event.type === 'user/message' && event.data.id === latest(task).messageId)
      if (input === undefined) throw new ToolArgsError(['Assignment input has not been consumed'])
      const brief = events.find(event => event.type === 'user/message' && event.data.id === latest(task).briefId
        && event.data.source.kind === 'muse-coordination' && event.data.source.purpose === 'assignment'
        && event.data.source.taskId === task.id && event.data.source.revision === revision)
      if (brief === undefined) throw new ToolArgsError(['The current revision coordination brief has not been consumed'])
      const latestHuman = events.findLast(event => event.type === 'user/message' && event.data.source.kind === 'user')
      if (latestHuman?.type !== 'user/message' || latestHuman.data.id !== latest(task).messageId) {
        throw new ToolArgsError(['Worker input changed; inspect and reconcile this task from Main before reporting it'])
      }
      const files = events.flatMap(event => event.seq > input.seq && event.type === 'deliverables/presented' ? event.data.files : [])
      await this.ctx.sessions.flush(worker.session)
      return this.save(revise(task, { status: 'finishing', report: {
        outcome, summary, files, throughSeq: events.reduce((_seq, event) => event.seq, input.seq),
      } }))
    })
  }

  private owned(owner: SessionId, id: CoordinationTaskId): CoordinationTask {
    const task = this.table.get(id)
    if (task === undefined || task.owner !== owner) throw new ToolArgsError(['Task does not belong to this Main Session'])
    return task
  }

  private liveJobs(owner: SessionId) {
    return this.ctx.jobs.list(owner).filter(job => job.owner === owner && ['running', 'stopping'].includes(job.status))
  }

  private executionTree(root: Agent): Agent[] {
    const subagents = this.ctx.get('subagents')
    if (subagents === undefined) return [root]
    return this.ctx.agents.list().filter((candidate) => {
      if (candidate === root) return true
      try { return subagents.rootOf(candidate) === root }
      catch (error) {
        if (error instanceof SubagentError && error.code === 'UNAUTHORIZED') return false
        throw error
      }
    })
  }

  private async descendantIds(root: Agent): Promise<SessionId[]> {
    const subagents = this.ctx.get('subagents')
    if (subagents === undefined) return []
    const descendants = await subagents.listDescendants(root.id, this.lifetime.signal)
    if (descendants.some(entry => entry.kind === 'diagnostic')) throw new Error('Execution subtree is unavailable; inspect before completing or reusing it')
    return descendants.map(entry => entry.id)
  }

  private treeBusy(worker: Agent): boolean {
    return this.executionTree(worker).some(member => member.status !== 'idle' || this.liveJobs(member.id).length > 0)
      || (this.ctx.get('subagents')?.hasTreeWork(worker) ?? false)
  }

  private followTree(worker: Agent): void {
    const subagents = this.ctx.get('subagents')
    if (subagents === undefined || this.treeWaits.has(worker) || !subagents.hasTreeWork(worker)) return
    const waiting = this.optional(subagents.waitForTreeWork(worker)).then((result) => {
      this.treeWaits.delete(worker)
      if (result.kind === 'value') this.background(() => this.settleWorker(worker))
    }, (error: unknown) => {
      this.treeWaits.delete(worker)
      this.background(async () => {
        for (const [, task] of this.table.entries()) {
          if (latest(task).sessionId === worker.id && reservesWorker(latest(task))) {
            await this.publish(revise(task, { status: 'interrupted', issue: `Execution subtree settlement failed: ${String(error)}` }))
          }
        }
      })
    })
    this.treeWaits.set(worker, waiting)
  }

  private async settleAllWorkers(): Promise<void> {
    for (const [, task] of this.table.entries()) {
      if (!reservesWorker(latest(task))) continue
      const worker = this.ctx.agents.get(latest(task).sessionId)
      if (worker !== undefined) await this.settleWorker(worker)
    }
  }

  private busy(sessionId: SessionId): boolean {
    const agent = this.ctx.agents.get(sessionId)
    const members = agent === undefined ? [] : this.executionTree(agent)
    return (agent !== undefined && (this.ctx.get('subagents')?.hasTreeWork(agent) ?? false))
      || members.some(member => member.status === 'running' || member.inbox.nextTurn.length > 0 || member.inbox.nextStep.length > 0
      || this.liveJobs(member.id).length > 0) || this.liveJobs(sessionId).length > 0
  }

  private async settleRelated(agent: Agent): Promise<void> {
    for (const [, task] of this.table.entries()) {
      const worker = this.ctx.agents.get(latest(task).sessionId)
      if (worker !== undefined && this.executionTree(worker).includes(agent)) await this.settleWorker(worker)
    }
  }

  private async requireReusable(id: SessionId, mainId: SessionId) {
    const snapshot = await this.ctx.sessionQuery.readSession(id)
    const selected = snapshot.events.findLast(event => event.type === 'agent-preset/selected')
    const preset = selected?.type === 'agent-preset/selected' ? selected.data.agentPreset : snapshot.session.agentPreset
    if (id === mainId || preset === this.config.mainPreset || snapshot.session.origin === 'subagent'
      || this.ctx.workspaceRegistry.archivedSessionIds.includes(id)) throw new ToolArgsError(['Target is not an available ordinary execution Session'])
    const worker = this.ctx.agents.get(id)
    if (this.busy(id) || worker !== undefined && (await this.descendantIds(worker)).some(child => this.liveJobs(child).length > 0)) {
      throw new ToolArgsError(['Target is busy; create a fresh Session instead'])
    }
    return snapshot.session
  }

  private async humanInputs(task: CoordinationTask): Promise<{
    message: UserMessage
    sessionId: SessionId
    seq: number
    cwd: string | null
  }[]> {
    const owner = await this.ctx.sessionQuery.readSession(task.owner)
    const result: { message: UserMessage; sessionId: SessionId; seq: number; cwd: string | null }[] = []
    for (const [index, attempt] of task.attempts.entries()) {
      const source = owner.events.find(event => event.seq === attempt.sourceSeq)
      if (source?.type !== 'user/message' || source.data.source.kind !== 'user' || 'principal' in source.data.source) {
        throw new ToolContextUnavailableError('Original verified Main human request is unavailable')
      }
      result.push({ message: source.data, sessionId: task.owner, seq: source.seq,
        cwd: this.inputDirectory(owner.session.cwd ?? attempt.sourceCwd, owner.events, source.seq) })
      const reconciliation = attempt.reconciliation
      if (reconciliation === undefined) continue
      const previous = task.attempts[index - 1]
      if (previous === undefined || previous.sessionId !== attempt.sessionId) throw new ToolContextUnavailableError('Reconciled worker history has no matching predecessor')
      const worker = await this.ctx.sessionQuery.readSession(attempt.sessionId)
      const start = worker.events.find(event => event.type === 'user/message' && event.data.id === previous.messageId)
      const end = worker.events.find(event => event.type === 'user/message' && event.seq === reconciliation.humanSeq
        && event.data.id === reconciliation.humanMessageId && event.data.source.kind === 'user')
      if (start === undefined || end === undefined || end.seq > reconciliation.throughSeq) {
        throw new ToolContextUnavailableError('Original reconciled worker human input is unavailable')
      }
      for (const event of worker.events) {
        if (event.type === 'user/message' && event.data.source.kind === 'user'
          && event.seq > start.seq && event.seq <= reconciliation.humanSeq) {
          if ('principal' in event.data.source) throw new ToolContextUnavailableError('Cross-owner worker input cannot be reconciled into a local owner task')
          result.push({ message: event.data, sessionId: attempt.sessionId, seq: event.seq,
            cwd: this.inputDirectory(worker.session.cwd ?? attempt.cwd, worker.events, event.seq) })
        }
      }
    }
    return result
  }

  private inputDirectory(initial: string | null, events: readonly SessionEvent[], throughSeq: number): string | null {
    let directory = initial
    for (const event of events) {
      if (event.seq > throughSeq) break
      if (event.type === 'working-directory/change') directory = event.data.cwd
    }
    return directory
  }

  private reconciliationGuard(exec: Readonly<ToolExecution>): ToolGuardDenial | undefined {
    const worker = exec.agent
    if (worker === undefined || reconciliationReads.has(exec.name)) return undefined
    const state = this.reconciliationInput.stateOf(worker.session)
    for (const [, task] of this.table.entries()) {
      const attempt = latest(task)
      if (attempt.sessionId !== worker.id || attempt.reconciliation === undefined || !reservesWorker(attempt)
        || state.humanId !== attempt.messageId || state.brief?.id !== attempt.briefId
        || state.brief.taskId !== task.id || state.brief.revision !== attempt.revision) continue
      const error = new ToolContextUnavailableError('Task reconciliation permits only local file reads, existing-file presentation, and coordinator_report. Report missing work to Main; do not repeat business actions.')
      return { reason: error.message, info: { name: error.name, code: error.code } }
    }
    return undefined
  }

  private async deliverReconciliation(task: CoordinationTask): Promise<CoordinationTask> {
    const attempt = latest(task)
    const reconciliation = attempt.reconciliation
    if (reconciliation === undefined) throw new ToolContextUnavailableError('Reconciliation input metadata is unavailable')
    const resolved = await this.ctx.sessionController.resolveAgent(attempt.sessionId)
    if ('error' in resolved) throw resolved.error
    const worker = resolved.agent
    const log = await this.ctx.sessionQuery.readSession(worker.id)
    const pending = [...worker.inbox.nextTurn, ...worker.inbox.nextStep].some(message => message.id === attempt.briefId)
    const consumed = log.events.some(event => event.type === 'user/message' && event.data.id === attempt.briefId)
    const received = pending || consumed || log.events.some(event => event.type === 'agent/inbox/spliced'
      && event.data.inserted.some(message => message.id === attempt.briefId))
    if (received) {
      if (this.reconciliationInput.stateOf(worker.session).humanId !== reconciliation.humanMessageId) {
        if (pending) worker.inbox.remove(attempt.briefId)
        await this.ctx.sessions.flush(worker.session)
        const interrupted = revise(task, { status: 'interrupted', report: null,
          issue: 'Worker human input changed after the retained reconciliation. Its old pending brief was removed without waking it; unrelated work was preserved.' })
        await this.publish(interrupted)
        return interrupted
      }
      if (pending) worker.wakePending?.(attempt.briefId)
      return this.save(revise(task, { status: consumed ? 'running' : pending ? 'accepted' : 'interrupted',
        issue: pending || consumed ? null : 'A durable reconciliation receipt exists but is not pending or consumed; nothing was resent.' }))
    }
    const descendants = await this.descendantIds(worker)
    const current = await this.ctx.sessionQuery.readSession(worker.id)
    if (current.events.at(-1)?.seq !== reconciliation.throughSeq || worker.session.seq - 1 !== reconciliation.throughSeq
      || this.busy(worker.id) || this.treeBusy(worker)
      || descendants.some(id => this.liveJobs(id).length > 0)) {
      throw new ToolArgsError(['Worker changed or became busy after reconciliation intent was saved; inspect it before continuing'])
    }
    const anchor = current.events.findLast(event => event.type === 'user/message' && event.data.source.kind === 'user')
    if (anchor?.type !== 'user/message' || anchor.data.id !== reconciliation.humanMessageId || anchor.seq !== reconciliation.humanSeq) {
      throw new ToolArgsError(['Worker human input changed; read its history again'])
    }
    worker.followup({ ...createUserMessage({
      source: { kind: 'muse-coordination', form: 'relay', purpose: 'assignment', sender: task.owner, taskId: task.id, revision: attempt.revision },
      content: [{ type: 'text', text: `Main Session reconciliation ${task.id}, revision ${attempt.revision}.\nGoal: ${task.title}\nReason: ${attempt.reason}\nInspection instructions: ${attempt.instructions}\nVerified existing human input: message ${reconciliation.humanMessageId}, seq ${reconciliation.humanSeq}; inspected history through seq ${reconciliation.throughSeq}. The human message remains in this original Session and is not being resent.\nOnly inspect the existing work and report its actual state. Do not repeat downloads, generation, writing or any other business action. Do not broaden the human request. Missing work must be reported as blocked or needs-input for Main to plan explicitly. Use present only to declare already existing final files, then call coordinator_report with this exact task id and revision. Completion is not human acceptance.\n` }],
    }), id: attempt.briefId })
    await this.ctx.sessions.flush(worker.session)
    return this.save(revise(task, { status: 'accepted', issue: null }))
  }

  private async deliver(task: CoordinationTask): Promise<CoordinationTask> {
    const attempt = latest(task)
    let worker = this.ctx.agents.get(attempt.sessionId)
    if (worker === undefined && attempt.createSession) {
      const workspace = this.ctx.workspaceRegistry.list().find(candidate => candidate.path === attempt.cwd)
      const created = await this.ctx.sessionController.create({ sessionId: attempt.sessionId,
        ...(workspace === undefined ? { cwd: attempt.cwd } : { workspaceId: workspace.id }), agentPreset: this.config.workerPreset })
      if (created.sessionId !== attempt.sessionId) throw new Error('Worker creation returned another Session')
    }
    const resolved = await this.ctx.sessionController.resolveAgent(attempt.sessionId)
    if ('error' in resolved) throw resolved.error
    worker = resolved.agent
    const events = (await this.ctx.sessionQuery.readSession(worker.id)).events
    const pending = [...worker.inbox.nextTurn, ...worker.inbox.nextStep].some(message => message.id === attempt.messageId)
    const ids = new Set([attempt.briefId, ...attempt.forwardedIds])
    const received = events.some(event => (event.type === 'user/message' && ids.has(event.data.id))
      || (event.type === 'agent/inbox/spliced' && event.data.inserted.some(message => ids.has(message.id))))
    if (received) return this.save(revise(task, { status: pending ? 'accepted' : 'interrupted',
      issue: pending ? null : 'A durable input receipt exists; inspect the worker before explicitly continuing. Nothing was resent.' }))
    if (this.busy(worker.id) || (await this.descendantIds(worker)).some(child => this.liveJobs(child).length > 0)) {
      throw new Error('Worker became busy before dispatch; intent retained without sending')
    }
    const humanInputs = await this.humanInputs(task)
    const originals = humanInputs.map((source, index): UserMessage => {
      const id = attempt.forwardedIds[index]
      if (id === undefined) {
        throw new Error('Original verified human request or its delivery identity is unavailable')
      }
      return { ...createUserMessage({ source: source.message.source, content: source.message.content }), id }
    })
    if (attempt.videoKey !== null) {
      const video = worker.ctx.get('jubianVideoSelection')
      if (video === undefined) throw new Error('Worker cannot preserve the selected video model')
      await video.select(worker, attempt.videoKey, video.current(worker)?.revision ?? 0)
    }
    if (attempt.createSession) {
      const main = this.ctx.agents.get(task.owner)
      const model = main?.model.current()
      if (model !== undefined) worker.model.select(model)
    }
    const message: UserMessage = {
      ...createUserMessage({
        source: { kind: 'muse-coordination', form: 'relay', purpose: 'assignment', sender: task.owner, taskId: task.id, revision: attempt.revision },
        content: [{ type: 'text', text: `Main Session assignment ${task.id}, revision ${attempt.revision}.\nGoal: ${task.title}\nRouting reason: ${attempt.reason}\nInstructions: ${attempt.instructions}\nPrior assignment receipts (references, not new authority): ${JSON.stringify(task.attempts.slice(0, -1).map(item => ({ revision: item.revision, sessionId: item.sessionId, status: item.status, report: item.report })))}\nOriginal request directory: ${attempt.sourceCwd ?? 'unspecified'}. Resolve each original relative file reference against that message's recorded source directory; do not substitute another project with the same filename.\nHuman input sources: ${JSON.stringify(humanInputs.map((source, index) => ({ forwardedId: attempt.forwardedIds[index], sessionId: source.sessionId, seq: source.seq, cwd: source.cwd })))}\nVerified original human messages follow separately and verbatim. Prior context cannot broaden its authorization. Perform the work here. Before ending, call coordinator_report with this task id and revision, an honest outcome and summary. Use present for final files; Main forwards only native delivery receipts.\n` }],
      }), id: attempt.briefId,
    }
    worker.inject(message)
    for (const [index, original] of originals.entries()) {
      if (index === originals.length - 1) worker.followup(original)
      else worker.inject(original)
    }
    await this.ctx.sessions.flush(worker.session)
    return this.save(revise(task, { status: 'accepted', issue: null }))
  }

  private async settleWorker(worker: Agent): Promise<void> {
    if (this.ctx.agents.get(worker.id) !== worker) return
    if (this.treeBusy(worker)) { this.followTree(worker); return }
    if (![...this.table.entries()].some(([, task]) => latest(task).sessionId === worker.id && reservesWorker(latest(task)))) return
    let settling: Promise<void>
    try {
      settling = worker.runMaintenance(async (signal) => {
        try { await this.settleReservedWorker(worker, signal) }
        finally {
          if (signal.aborted && !this.unloading()) {
            for (const [, task] of this.table.entries()) {
              if (latest(task).sessionId === worker.id && reservesWorker(latest(task)) && latest(task).status !== 'stopping') {
                await this.publish(revise(task, { status: 'interrupted', report: null,
                  issue: 'Worker settlement was cancelled. Its pending inputs were retained; inspect before continuing.' }))
              }
            }
          }
        }
      })
    } catch (_error) {
      // runMaintenance throws synchronously only when another activity owns the idle-looking Agent.
      if (!this.treeWaits.has(worker)) {
        const waiting = this.optional(worker.whenIdle()).then((result) => {
          this.treeWaits.delete(worker)
          if (result.kind === 'value') this.background(() => this.settleWorker(worker))
        })
        this.treeWaits.set(worker, waiting)
      }
      return
    }
    await settling
  }

  private async settleReservedWorker(worker: Agent, signal: AbortSignal): Promise<void> {
    let descendants: SessionId[]
    try { descendants = await this.descendantIds(worker) }
    catch (error) {
      if (this.unloading()) return
      for (const [, task] of this.table.entries()) {
        if (latest(task).sessionId === worker.id && reservesWorker(latest(task))) {
          await this.publish(revise(task, { status: 'interrupted', issue: `Execution subtree could not be verified: ${String(error)}` }))
        }
      }
      return
    }
    if (descendants.some(id => this.liveJobs(id).length > 0)) return
    for (const [, task] of this.table.entries()) {
      const attempt = latest(task)
      if (attempt.sessionId !== worker.id || !reservesWorker(attempt)) continue
      const checkpoint = await this.optional(this.ctx.sessions.flush(worker.session))
      if (checkpoint.kind === 'aborted' || !checkpoint.value) return
      const observed = await this.optional(this.ctx.sessionQuery.readSession(worker.id))
      if (observed.kind === 'aborted') return
      if (this.treeBusy(worker)) { this.followTree(worker); return }
      if (descendants.some(id => this.liveJobs(id).length > 0)) return
      const log = observed.value
      const input = log.events.find(event => event.type === 'user/message' && event.data.id === attempt.messageId)
      const latestInput = this.reconciliationInput.stateOf(worker.session)
      if (attempt.status !== 'stopping' && input !== undefined && latestInput.humanSeq !== null
        && latestInput.humanId !== attempt.messageId) {
        await this.publish(revise(task, { status: 'needs-report', report: null, changedInputSeq: latestInput.humanSeq,
          issue: 'Worker direct human work is now quiescent. Inspect its latest history and reconcile the task before accepting a report.' }))
        continue
      }
      if (input !== undefined && log.events.some(event => event.seq > input.seq
        && event.type === 'job/settled' && !event.data.producerReported)) {
        await this.publish(revise(task, { status: 'interrupted', issue: 'A background producer did not confirm resource release; stopping is unconfirmed' }))
        continue
      }
      const report = attempt.report
      if (attempt.status !== 'stopping' && report !== null && log.events.some(event => event.seq > report.throughSeq
        && event.type === 'user/message' && event.data.source.kind === 'subagent-settled'
        && event.data.source.stopReason !== undefined && event.data.source.stopReason !== 'completed')) {
        await this.publish(revise(task, { status: 'interrupted', issue: 'A delegated execution failed after the worker report; inspect and report again' }))
        continue
      }
      if (attempt.status === 'stopping') await this.publish(revise(task, { status: 'stopped' }))
      else if (attempt.report !== null) await this.publish(revise(task, { status: attempt.report.outcome }), signal)
      else if (!worker.inbox.nextTurn.some(message => message.id === attempt.messageId)) {
        await this.publish(revise(task, { status: 'needs-report', issue: 'Worker is idle without a structured task report; completion is unconfirmed' }))
      }
    }
  }

  private invalidatedReport(task: CoordinationTask, signal?: AbortSignal): CoordinationTask {
    const attempt = latest(task)
    if (attempt.report === null || attempt.status !== attempt.report.outcome) return task
    if (signal?.aborted) return revise(task, { status: 'interrupted', report: null,
      issue: 'Worker settlement was cancelled before report publication; inspect before continuing.' })
    const worker = this.ctx.agents.get(attempt.sessionId)
    if (worker === undefined) return revise(task, { status: 'interrupted', report: null,
      issue: 'Worker became unavailable before its report was published; inspect before continuing.' })
    const state = this.reconciliationInput.stateOf(worker.session)
    if (state.humanId === attempt.messageId) return task
    return revise(task, { status: this.busy(worker.id) ? 'interrupted' : 'needs-report', report: null,
      ...(state.humanSeq === null ? {} : { changedInputSeq: state.humanSeq }),
      issue: 'Worker input changed before report publication. Inspect its latest history and reconcile this task.' })
  }

  private async publish(task: CoordinationTask, signal?: AbortSignal): Promise<void> {
    const checked = this.invalidatedReport(task, signal)
    await this.save(checked)
    const current = this.invalidatedReport(checked, signal)
    if (current !== checked) await this.save(current)
    await this.notify(current, true, signal)
  }

  private async notify(task: CoordinationTask, verifyInput = false, signal?: AbortSignal): Promise<void> {
    if (this.unloading()) return
    const attempt = latest(task)
    if (attempt.notifiedStatus === attempt.status && attempt.notifiedInputSeq === attempt.changedInputSeq) return
    const resolution = await this.optional(this.ctx.sessionController.resolveAgent(task.owner))
    if (resolution.kind === 'aborted') return
    const resolved = resolution.value
    if ('error' in resolved) throw resolved.error
    if (this.unloading()) return
    const owner = resolved.agent
    const noticeId = brandString<MessageId>(`${attempt.noticeId}-${attempt.status}${attempt.changedInputSeq === undefined ? '' : `-${attempt.changedInputSeq}`}`)
    const pending = [...owner.inbox.nextTurn, ...owner.inbox.nextStep].some(message => message.id === noticeId)
    const history = await this.optional(this.ctx.sessionQuery.readSession(owner.id))
    if (history.kind === 'aborted') return
    const logged = history.value.events.some(event => (event.type === 'user/message' && event.data.id === noticeId) || (event.type === 'agent/inbox/spliced' && event.data.inserted.some(message => message.id === noticeId)))
    if (verifyInput) {
      const current = this.invalidatedReport(task, signal)
      if (current !== task) {
        await this.save(current)
        await this.notify(current)
        return
      }
    }
    if (!pending && !logged) {
      owner.followup({ ...createUserMessage({
        source: { kind: 'muse-coordination', form: 'notice', summary: boundContextSummary(`${task.title}: ${attempt.status}`),
          purpose: 'receipt', sender: attempt.sessionId, taskId: task.id, revision: attempt.revision },
        content: [{ type: 'text', text: JSON.stringify({ taskId: task.id, title: task.title, revision: attempt.revision, workerSessionId: attempt.sessionId, status: attempt.status, report: attempt.report, issue: attempt.issue,
          instruction: 'Relay the verified outcome and files to the user. Worker completion is not human acceptance. Route further work to execution Sessions.' }) }],
      }), id: noticeId })
      const checkpoint = await this.optional(this.ctx.sessions.flush(owner.session))
      if (checkpoint.kind === 'aborted' || !checkpoint.value) return
    }
    if (this.unloading()) return
    await this.save(revise(task, { notifiedStatus: attempt.status,
      ...(attempt.changedInputSeq === undefined ? {} : { notifiedInputSeq: attempt.changedInputSeq }) }))
  }

  private async recover(): Promise<void> {
    for (const [, task] of this.table.entries()) {
      const attempt = latest(task)
      if (attempt.status === 'dispatching' || attempt.status === 'reconciling') {
        try {
          const delivered = attempt.status === 'reconciling' ? await this.deliverReconciliation(task) : await this.deliver(task)
          const worker = this.ctx.agents.get(latest(delivered).sessionId)
          if (worker !== undefined) await this.settleWorker(worker)
        }
        catch (error) { await this.save(revise(task, { status: 'interrupted', issue: String(error) })) }
      } else if (reservesWorker(attempt)) {
        const worker = this.ctx.agents.get(attempt.sessionId)
        if (worker !== undefined) await this.settleWorker(worker)
        else await this.publish(revise(task, { status: 'interrupted', issue: 'App restarted. Inspect the retained worker receipts before continuing; no generation was resubmitted.' }))
      } else await this.notify(task)
    }
  }

  private unloading(): boolean { return this.lifetime.signal.aborted }

  /** Notifications may stop on unload; Session services own and drain their underlying reads and checkpoints. */
  private optional<T>(operation: Promise<T>): Promise<{ kind: 'value'; value: T } | { kind: 'aborted' }> {
    const signal = this.lifetime.signal
    return new Promise((resolve, reject) => {
      const abort = (): void => { resolve({ kind: 'aborted' }) }
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
      void operation.then((value) => {
        signal.removeEventListener('abort', abort)
        resolve({ kind: 'value', value })
      }, (error: unknown) => {
        signal.removeEventListener('abort', abort)
        if (signal.aborted) resolve({ kind: 'aborted' })
        else reject(error instanceof Error ? error : new Error(String(error)))
      })
    })
  }

  private async save(task: CoordinationTask): Promise<CoordinationTask> {
    await this.table.put(task.id, task)
    this.changed()
    return task
  }

  private changed(): void {
    this.generation++
    for (const notify of [...this.observers]) notify()
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    if (this.unloading()) return Promise.reject(new Error('Coordinator is unloading'))
    const result = this.tail.then(operation)
    this.tail = result.then(() => {}, () => {})
    return result
  }

  private background(operation: () => Promise<void>): void {
    void this.serial(async () => { if (!this.lifetime.signal.aborted) await operation() }).catch((error: unknown) => { this.ctx.logger.error('session-coordinator: %s', String(error)) })
  }
}

export default SessionCoordinator
