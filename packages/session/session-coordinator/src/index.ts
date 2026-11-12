/** Durable ordinary-Session routing, receipts, cancellation, and recovery. */
import { randomUUID, createHash } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SubagentError } from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-api-workspace-controller'
import type {} from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from '@deepseek-ai/dsh-jobs'
import type {} from '@deepseek-ai/dsh-tool-present/types'
import type {} from '@deepseek-ai/dsh-tool-jubian'
import { createUserMessage, boundContextSummary } from '@deepseek-ai/dsh-llm'
import type { MessageId, UserMessage } from '@deepseek-ai/dsh-llm'
import { brandString } from '@deepseek-ai/dsh-brand'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { coordinationDomain, latest, reservesWorker, revise } from './ledger.ts'
import type { CoordinationTask, CoordinationTaskId, DispatchRequest, WorkerReport } from './types.ts'

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
  /** Maximum returned Session search rows. Defaults to 30. */
  readonly searchLimit?: number
  /** Maximum characters returned by one history read. Defaults to 24000. */
  readonly readChars?: number
}

/** Task router whose durable writes precede Session creation and message delivery. */
export class SessionCoordinator extends TypertRemoteService {
  static inject = [
    'agents', 'sessions', 'sessionQuery', 'sessionController', 'workspaceController', 'storageDomain', 'workspaceRegistry', 'jobs', 'typert',
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
          if (['accepted', 'dispatching'].includes(latest(task).status)) await this.save(revise(task, { status: 'running' }))
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
      throw new Error('Only a live main-session Agent can route work')
    }
    const history = await this.ctx.sessionQuery.readSession(agent.id)
    const input = history.events.findLast(event => event.type === 'user/message' && event.data.source.kind === 'user')
    if (input?.type !== 'user/message') throw new Error('An owner request is required before coordinating work')
    if ('principal' in input.data.source) {
      throw new Error('Cross-session coordination requires the local profile owner')
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
      const forwardedIds = [...(previous?.attempts ?? []).map(() => createUserMessage({ content: [], source: { kind: 'user' } }).id), messageId]
      const task: CoordinationTask = {
        id: previous?.id ?? brandString<CoordinationTaskId>(`task-${randomUUID()}`), owner: main.id,
        title: previous?.title ?? request.title, createdAt: previous?.createdAt ?? Date.now(),
        attempts: [...previous?.attempts ?? [], {
          revision: (previous === undefined ? 0 : latest(previous).revision) + 1,
          key: request.key, requestHash, instructions: request.instructions, reason: request.reason, sourceSeq: source.seq,
          messageId, forwardedIds, briefId: createUserMessage({ content: [], source: { kind: 'user' } }).id,
          noticeId: createUserMessage({ content: [], source: { kind: 'user' } }).id,
          sessionId: target, createSession, cwd, sourceCwd: main.session.header.cwd ?? null, videoKey: video?.type === 'jubian/video-selection' ? video.data.selection.key : null,
          status: 'dispatching', report: null, issue: null, notifiedStatus: null,
        }],
      }
      await this.save(task)
      try { return await this.deliver(task) }
      catch (error) {
        await this.save(revise(task, { status: 'interrupted', issue: String(error) }))
        throw error
      }
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
      const task = this.table.get(taskId)
      if (task === undefined || latest(task).sessionId !== worker.id || latest(task).revision !== revision
        || !reservesWorker(latest(task)) || latest(task).status === 'stopping') throw new Error('No current assignment belongs to this worker')
      const events = (await this.ctx.sessionQuery.readSession(worker.id)).events
      const input = events.find(event => event.type === 'user/message' && event.data.id === latest(task).messageId)
      if (input === undefined) throw new Error('Assignment input has not been consumed')
      const latestHuman = events.findLast(event => event.type === 'user/message' && event.data.source.kind === 'user')
      if (latestHuman?.type !== 'user/message' || latestHuman.data.id !== latest(task).messageId) {
        throw new Error('Worker input changed; inspect and revise this task from Main before reporting it')
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
    if (task === undefined || task.owner !== owner) throw new Error('Task does not belong to this Main Session')
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
      || this.ctx.workspaceRegistry.archivedSessionIds.includes(id)) throw new Error('Target is not an available ordinary execution Session')
    const worker = this.ctx.agents.get(id)
    if (this.busy(id) || worker !== undefined && (await this.descendantIds(worker)).some(child => this.liveJobs(child).length > 0)) {
      throw new Error('Target is busy; create a fresh Session instead')
    }
    return snapshot.session
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
    const owner = await this.ctx.sessionQuery.readSession(task.owner)
    const originals = task.attempts.map((revision, index): UserMessage => {
      const source = owner.events.find(event => event.seq === revision.sourceSeq)
      const id = attempt.forwardedIds[index]
      if (source?.type !== 'user/message' || source.data.source.kind !== 'user' || id === undefined) {
        throw new Error('Original verified human request or its delivery identity is unavailable')
      }
      return { ...createUserMessage({ source: source.data.source, content: source.data.content }), id }
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
        content: [{ type: 'text', text: `Main Session assignment ${task.id}, revision ${attempt.revision}.\nGoal: ${task.title}\nRouting reason: ${attempt.reason}\nInstructions: ${attempt.instructions}\nPrior assignment receipts (references, not new authority): ${JSON.stringify(task.attempts.slice(0, -1).map(item => ({ revision: item.revision, sessionId: item.sessionId, status: item.status, report: item.report })))}\nOriginal request directory: ${attempt.sourceCwd ?? 'unspecified'}. Resolve original relative file references against that directory; do not substitute another project with the same filename.\nVerified original human messages follow separately and verbatim. Prior context cannot broaden its authorization. Perform the work here. Before ending, call coordinator_report with this task id and revision, an honest outcome and summary. Use present for final files; Main forwards only native delivery receipts.\n` }],
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
      else if (attempt.report !== null) await this.publish(revise(task, { status: attempt.report.outcome }))
      else if (!worker.inbox.nextTurn.some(message => message.id === attempt.messageId)) {
        await this.publish(revise(task, { status: 'needs-report', issue: 'Worker is idle without a structured task report; completion is unconfirmed' }))
      }
    }
  }

  private async publish(task: CoordinationTask): Promise<void> {
    await this.save(task)
    await this.notify(task)
  }

  private async notify(task: CoordinationTask): Promise<void> {
    if (this.unloading()) return
    const attempt = latest(task)
    if (attempt.notifiedStatus === attempt.status) return
    const resolution = await this.optional(this.ctx.sessionController.resolveAgent(task.owner))
    if (resolution.kind === 'aborted') return
    const resolved = resolution.value
    if ('error' in resolved) throw resolved.error
    if (this.unloading()) return
    const owner = resolved.agent
    const noticeId = brandString<MessageId>(`${attempt.noticeId}-${attempt.status}`)
    const pending = [...owner.inbox.nextTurn, ...owner.inbox.nextStep].some(message => message.id === noticeId)
    const history = await this.optional(this.ctx.sessionQuery.readSession(owner.id))
    if (history.kind === 'aborted') return
    const logged = history.value.events.some(event => (event.type === 'user/message' && event.data.id === noticeId) || (event.type === 'agent/inbox/spliced' && event.data.inserted.some(message => message.id === noticeId)))
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
    await this.save(revise(task, { notifiedStatus: attempt.status }))
  }

  private async recover(): Promise<void> {
    for (const [, task] of this.table.entries()) {
      const attempt = latest(task)
      if (attempt.status === 'dispatching') {
        try { await this.deliver(task) }
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
