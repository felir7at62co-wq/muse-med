/** Durable ordinary-Session routing, receipts, cancellation, and recovery. */
import { randomUUID, createHash } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import type {} from '@deepseek-ai/dsh-muse-account'
import type {} from '@deepseek-ai/dsh-jingliu-connection'
import { greetRouter, routerProfile, type RouterProfile } from './opening.ts'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SubagentError } from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-api-workspace-controller'
import type {} from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-working-directory'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import { JobId } from '@deepseek-ai/dsh-jobs'
import type { JobView } from '@deepseek-ai/dsh-jobs'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-tool-present/types'
import type {} from '@deepseek-ai/dsh-tool-jubian'
import type {} from '@deepseek-ai/dsh-session-activity'
import { createUserMessage, boundContextSummary } from '@deepseek-ai/dsh-llm'
import type { MessageId, UserMessage } from '@deepseek-ai/dsh-llm'
import { brandString } from '@deepseek-ai/dsh-brand'
import { SessionId, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import type { ProjectionHandle } from '@deepseek-ai/dsh-session-projection'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { coordinationDomain, latest, reportTask, reservesWorker, revise, routingTask } from './ledger.ts'
import { imageAt, outlineTurns, scanSteps, stepItems } from './history-views.ts'
import { SessionQueryError } from '@deepseek-ai/dsh-session-query'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { Assignment, AssignmentStatus, CoordinationTask, CoordinationTaskId, CoordinationReport, DispatchRequest, ReconcileRequest, RoutingMode, RoutingTaskList, WorkerReport } from './types.ts'
import { ToolArgsError, ToolContextUnavailableError } from '@deepseek-ai/dsh-tools'
import type { ToolExecution, ToolGuardDenial } from '@deepseek-ai/dsh-tools'

const reconciliationInputSchema = zod.object({
  humanId: zod.string().nullable(),
  humanSeq: zod.number().int().nonnegative().nullable(),
  brief: zod.object({ id: zod.string(), taskId: zod.string(), revision: zod.number().int().positive() }).nullable(),
})
type ReconciliationInput = zod.infer<typeof reconciliationInputSchema>
const reconciliationReads = new Set(['read', 'read_image', 'glob', 'grep', 'present', 'coordinator_report'])
/** Latest statuses that count toward `maxWorkers`. */
const slotStatuses: ReadonlySet<AssignmentStatus> = new Set(['reconciling', 'accepted', 'running', 'finishing', 'stopping'])
/** Attribution of `dsh-schedule` reminders, compared as text so the coordinator does not depend on that plugin. */
const scheduleSource: string = 'schedule'
/** Latest statuses that the unattended policy resolves without a human. */
const unresolvedStatuses: ReadonlySet<AssignmentStatus> = new Set(['needs-report', 'interrupted', 'blocked', 'needs-input', 'failed'])

/** Worker input and log position recorded by a reconciliation revision. */
type Reconciliation = NonNullable<Assignment['reconciliation']>

/** Unattended decision for one task's latest revision. */
type FollowUp = { readonly kind: 'none' | 'redispatch' } | { readonly kind: 'attention'; readonly reason: string }

/**
 * Find human-authored worker input consumed after an assignment's own input.
 * @param attempt - Assignment whose anchor message and forwarded deliveries belong to the task.
 * @param events - Worker Session log.
 * @returns the first later human message, or undefined when the anchor is not consumed or no human input follows it.
 */
function laterHumanInput(attempt: Assignment, events: readonly SessionEvent[]): SessionEvent | undefined {
  const anchor = events.find(event => event.type === 'user/message' && event.data.id === attempt.messageId)
  if (anchor === undefined) return undefined
  return events.find(event => event.seq > anchor.seq && event.type === 'user/message' && event.data.source.kind === 'user'
    && !attempt.forwardedIds.includes(event.data.id))
}

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
  /**
   * Capture Main's Jubian video selection on dispatch. Defaults to true.
   * When disabled, new tasks have no key and revisions retain the task's recorded key.
   */
  readonly inheritJubianVideoSelection?: boolean
  /** Maximum returned Session search rows or report tasks. Defaults to 30. */
  readonly searchLimit?: number
  /**
   * History-page characters, serialized task-list characters, and combined
   * serialized report content/metadata budget. Defaults to 24000.
   */
  readonly readChars?: number
  /** Maximum characters in each routing note (`instructions`, `reason`) Main writes for dispatch or reconciliation. Defaults to 120. */
  readonly noteChars?: number
  /** Maximum characters in a worker report summary. Defaults to 2000. */
  readonly summaryChars?: number
  /**
   * Maximum coordinator assignments executing at once (reconciling, accepted, running, finishing or stopping).
   * While the limit is reached, a dispatch that creates a new worker waits as `dispatching` and starts in
   * creation order when an assignment leaves those states. Dispatches to existing Sessions and reconciliations
   * start at once and count toward the limit. Defaults to 3.
   */
  readonly maxWorkers?: number
  /**
   * Run without a human. Main and assigned workers cannot call `humanTools`, Main may dispatch from a schedule
   * reminder, and a task whose latest revision ends `needs-report`, `failed`, `blocked` or `needs-input`, or
   * `interrupted` once its worker is quiescent, is re-dispatched to a fresh worker up to `redispatchLimit` times
   * and then marked for attention. Defaults to false.
   */
  readonly unattended?: boolean
  /** Start a new attended Router conversation with the signed-in user's profile. */
  readonly greetOnOpen?: boolean
  /** Consecutive automatic re-dispatches of one task before it is marked for attention; 0 marks it at once. Defaults to 1. */
  readonly redispatchLimit?: number
  /** Tools that wait for a human answer, denied when `unattended` is set. Defaults to `ask_user_question` and `exit_plan_mode`. */
  readonly humanTools?: string[]
  /**
   * Absolute directory under which every assignment of a task runs in `<taskRoot>/<task id>`, created before
   * its first fresh worker starts. Dispatch then rejects another `cwd` and reuse of a Session in another
   * directory. Omitted, fresh workers use Main's directory unless Main passes `cwd`.
   */
  readonly taskRoot?: string
}

/** Validated configuration; only `taskRoot` has no default. */
type ResolvedConfig = Required<Omit<Config, 'taskRoot'>> & Pick<Config, 'taskRoot'>

/** Task router whose durable writes precede Session creation and message delivery. */
export class SessionCoordinator extends TypertRemoteService {
  static inject = [
    'agents', 'sessions', 'sessionQuery', 'sessionController', 'workspaceController', 'storageDomain', 'workspaceRegistry', 'jobs', 'typert', 'tools', 'sessionProjections',
  ]
  static Config: z<Config> = z.object({
    mainPreset: z.string().default('main-session'), workerPreset: z.string().default('short-drama'),
    inheritJubianVideoSelection: z.boolean().default(true),
    searchLimit: z.natural().min(1).default(30), readChars: z.natural().min(1).default(24000),
    noteChars: z.natural().min(1).default(120), summaryChars: z.natural().min(1).default(2000),
    maxWorkers: z.natural().min(1).default(3),
    greetOnOpen: z.boolean().default(false), unattended: z.boolean().default(false), redispatchLimit: z.natural().default(1),
    humanTools: z.array(z.string()).default(['ask_user_question', 'exit_plan_mode']),
    taskRoot: z.string(),
  })

  private readonly config: ResolvedConfig
  private table!: KvTable<CoordinationTaskId, CoordinationTask>
  private entry!: KvTable<string, SessionId>
  private entryKey = 'main'
  private tail: Promise<void> = Promise.resolve()
  private readonly lifetime = new AbortController()
  private readonly observers = new Set<() => void>()
  private generation = 0
  private readonly treeWaits = new Map<Agent, Promise<void>>()
  private reconciliationInput!: ProjectionHandle<ReconciliationInput>
  /** Activity digests of executing workers, keyed by task; present only while `sessionActivity` is mounted. */
  private readonly activityWatches = new Map<CoordinationTaskId, { readonly worker: SessionId; readonly release: () => void }>()

  /**
   * @param ctx - Profile-owner Host services.
   * @param config - Validated preset ids and retrieval limits.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'sessionCoordinator', { namespace: 'sessionCoordinator' })
    this.config = config as ResolvedConfig
  }

  /** Deployment facts that change Main's routing instructions and tool list. */
  get mode(): RoutingMode {
    return { unattended: this.config.unattended, taskFolders: this.config.taskRoot !== undefined, humanTools: this.config.humanTools }
  }

  protected async [Service.init](): Promise<void> {
    if (this.config.mainPreset === this.config.workerPreset) throw new Error('Coordinator and worker presets must differ')
    if (this.config.taskRoot !== undefined && !isAbsolute(this.config.taskRoot)) throw new Error('Coordinator taskRoot must be an absolute directory')
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
    this.ctx.effect(() => this.ctx.tools.guard(exec => this.reconciliationGuard(exec) ?? this.unattendedGuard(exec)))
    this.ctx.effect(() => this.ctx.sessionController.registerBlankReuseFilter(
      (id, preset) => id !== this.entry.get(this.entryKey) || preset === this.config.mainPreset,
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
            ? [{ id, owner: task.owner, revision: attempt.revision }] : []
        })
        this.background(async () => {
          for (const captured of affected) {
            const task = this.owned(captured.owner, captured.id)
            const attempt = latest(task)
            if (attempt.revision !== captured.revision || attempt.status === 'stopping' || attempt.status === 'stopped') continue
            const log = await this.ctx.sessionQuery.readSession(session.id)
            const anchor = log.events.find(item => item.type === 'user/message' && item.data.id === attempt.messageId)
            if (anchor === undefined || event.seq <= anchor.seq) continue
            await this.publish(revise(task, { status: 'interrupted', report: null, changedInputSeq: event.seq,
              issue: 'Worker received a later direct human request; the new work was not stopped. Wait for the next receipt before calling coordinator_reconcile.' }))
          }
        })
      }
    })
    this.ctx.effect(() => this.ctx.jobs.events.subscribe({ owners: 'all' }, (event) => {
      if (event.type === 'settled' && event.job.owner !== undefined) this.background(() => this.settleAllWorkers())
    }), 'coordination: owned Job settlement')
    this.ctx.on('subagent/end', () => { this.background(() => this.settleAllWorkers()) })
    // A replaced activity service holds none of the previous watches.
    this.ctx.on('internal/service', (name) => {
      if (name !== 'sessionActivity') return
      for (const watch of this.activityWatches.values()) watch.release()
      this.activityWatches.clear()
      this.syncActivity()
    })
    this.background(() => this.recover())
  }

  /**
   * Observe the retained Main Session identity without creating a Session.
   * @param signal - Client cancellation; plugin unload also closes the stream.
   * @returns the initial identity and subsequent changes.
   */
  @Remote({ mode: 'stream' })
  async *watchMain(signal: AbortSignal): AsyncIterable<SessionId | null> {
    yield* this.observe(signal, () => this.entry.get(this.entryKey) ?? null)
  }

  /**
   * Open the profile's durable Main Session from its dedicated navigation entry.
   * @returns the retained routing Session, initially created in the native default Workspace.
   */
  @Remote
  openMain(): Promise<SessionId> {
    return this.serial(async () => {
      const greet = this.config.greetOnOpen && !this.config.unattended
      let person: RouterProfile | null = null
      const account = this.ctx.get('museAccount')
      let ticket: string | undefined
      if (greet) {
        if (account) {
          if ((await account.status({})).state === 'signed-in') {
            ticket = 'login-' + await account.workbenchIdentity()
            try { person = routerProfile(await account.details({ limit: 1 })) }
            catch (error) { this.ctx.logger.debug('Router profile unavailable: %s', error instanceof Error ? error.name : 'gateway') }
            if (ticket !== 'login-' + await account.workbenchIdentity()) throw new Error('Muse account changed while opening its conversation')
          }
        }
        this.entryKey = person ? 'account-' + person.id : ticket ?? 'guest'
      }
      const saved = this.entry.get(this.entryKey)
      const id = saved ?? SessionId(`session-${randomUUID()}`)
      const exists = (await this.ctx.sessionQuery.listSessions(this.lifetime.signal)).some(row => row.header.id === id)
      if (!exists) {
        const initial = greet ? await this.ctx.workspaceController.useComputer(this.lifetime.signal)
          : await this.ctx.workspaceController.initializeDefault(this.lifetime.signal)
        if (initial === undefined) throw new Error('The default Workspace is unavailable; restore it before opening Main Session')
        if (saved === undefined) {
          await this.entry.put(this.entryKey, id)
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
      const seq = result.agent.session.seq
      const history = greet ? (await this.ctx.sessionQuery.readSession(id)).events : undefined
      if (ticket && account) {
        if (ticket !== 'login-' + await account.workbenchIdentity()) throw new Error('Muse account changed while opening its conversation')
        if (this.entry.get(ticket) !== id) await this.entry.put(ticket, id)
      }
      if (history !== undefined && result.agent.session.seq === seq && greetRouter(result.agent, person, history)) {
        await this.ctx.sessions.flush(result.agent.session)
      }
      this.changed()
      return id
    })
  }

  /**
   * Assert the exact live caller holds the configured routing role.
   * @param agent - Actual tool subject, never an argument-supplied identity.
   */
  async requireMain(agent: Agent): Promise<void> {
    if (this.ctx.agents.get(agent.id) !== agent || this.presetOf(agent) !== this.config.mainPreset) {
      throw new ToolContextUnavailableError('Only a live main-session Agent can route work')
    }
    const history = await this.ctx.sessionQuery.readSession(agent.id)
    const input = history.events.findLast(event => this.dispatchSource(event))
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
    const activity = this.ctx.get('sessionActivity')
    for (const row of visible.slice(0, this.config.searchLimit)) {
      const header = row.header
      const title = (await this.ctx.sessionQuery.readTitle(header.id))?.title ?? ''
      candidates.push({ sessionId: header.id, title, cwd: header.cwd ?? null,
        preset: header.agentPreset ?? null, busy: this.busy(header.id),
        ...activity === undefined ? {} : { status: await activity.describe(header.id) },
        archived: this.ctx.workspaceRegistry.archivedSessionIds.includes(header.id),
        excerpt: 'bestMatch' in row ? row.bestMatch.snippet : null })
    }
    return JSON.stringify({ sessions: candidates, limit: this.config.searchLimit,
      guidance: 'Check a candidate summary before reuse. Archived Sessions are reference-only. Busy Sessions require a fresh worker.' })
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
      excerpts, guidance: 'These are truncated source excerpts, not complete requirements; dispatch forwards the human messages verbatim.' })
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
   * List every turn of a Session or subagent in one line each; the newest turns are kept within `readChars`.
   * @param main - Exact routing Agent.
   * @param sessionId - Session or subagent in the same local owner profile.
   * @returns JSON turn outlines, oldest first, with the count of earlier turns left out.
   */
  async outline(main: Agent, sessionId: SessionId): Promise<string> {
    await this.requireMain(main)
    const snapshot = await this.ctx.sessionQuery.readSession(sessionId)
    const turns = outlineTurns(snapshot.events)
    const kept = []
    let chars = 0
    for (const turn of turns.toReversed()) {
      const length = JSON.stringify(turn).length
      if (chars + length > this.config.readChars && kept.length > 0) break
      kept.push(turn)
      chars += length
    }
    return JSON.stringify({ session: snapshot.session, turns: kept.toReversed(), omittedEarlier: turns.length - kept.length,
      guidance: 'Read one turn with view=steps and from_seq set to its startSeq.' })
  }

  /**
   * Page compact task inputs, replies, tool calls, results and turn boundaries of a Session or subagent.
   * @param main - Exact routing Agent.
   * @param sessionId - Session or subagent in the same local owner profile.
   * @param fromSeq - Inclusive first sequence, such as a turn's `startSeq`.
   * @returns JSON step items within `readChars` and the next position, or null when complete.
   */
  async steps(main: Agent, sessionId: SessionId, fromSeq: number): Promise<string> {
    await this.requireMain(main)
    if (!Number.isSafeInteger(fromSeq) || fromSeq < 0) throw new Error('History cursor must be a nonnegative integer')
    const snapshot = await this.ctx.sessionQuery.readSession(sessionId)
    const items = []
    let chars = 0
    let nextSeq: number | null = null
    for (const item of stepItems(snapshot.events, fromSeq)) {
      const length = JSON.stringify(item).length
      if (chars + length > this.config.readChars && items.length > 0) { nextSeq = item.seq; break }
      items.push(item)
      chars += length
    }
    return JSON.stringify({ session: snapshot.session, items, nextSeq, complete: nextSeq === null })
  }

  /**
   * Find events of one Session that match a query: full-text search when the deployment has an index,
   * otherwise a case-insensitive scan of the Session's step items.
   * @param main - Exact routing Agent.
   * @param sessionId - Session or subagent in the same local owner profile.
   * @param query - Full-text query, or plain text for the scan.
   * @returns JSON hits with sequence, event or step type and snippet, at most `searchLimit` within `readChars`.
   */
  async searchEvents(main: Agent, sessionId: SessionId, query: string): Promise<string> {
    await this.requireMain(main)
    if (query.trim() === '') throw new ToolArgsError(['view=search requires a nonempty query'])
    const request = { sessionId, query, limit: this.config.searchLimit }
    let found: { session: SessionHeader; items: readonly { seq: number; type: string; snippet: string }[]; more: boolean }
    try {
      const page = await this.ctx.sessionQuery.searchEvents(request, { signal: this.lifetime.signal })
      found = { session: page.session, items: page.items, more: page.nextCursor !== undefined }
    } catch (error) {
      if (!(error instanceof SessionQueryError) || error.code !== 'SESSION_QUERY_SEARCH_DISABLED') throw error
      const snapshot = await this.ctx.sessionQuery.readSession(sessionId)
      const items = scanSteps(snapshot.events, query, this.config.searchLimit + 1)
      found = { session: snapshot.session, items: items.slice(0, this.config.searchLimit), more: items.length > this.config.searchLimit }
    }
    const hits = []
    let chars = 0
    for (const hit of found.items) {
      const row = { seq: hit.seq, type: hit.type, snippet: hit.snippet }
      const length = JSON.stringify(row).length
      if (chars + length > this.config.readChars && hits.length > 0) break
      hits.push(row)
      chars += length
    }
    return JSON.stringify({ session: found.session, hits, more: hits.length < found.items.length || found.more,
      guidance: 'Read around a hit with view=steps and from_seq at or before its seq.' })
  }

  /**
   * List one Session's background jobs, or read one job's output without consuming the Session's own unread output.
   * @param main - Exact routing Agent.
   * @param sessionId - Owner Session of the jobs.
   * @param jobId - Job to read; omitted lists the Session's jobs.
   * @param from - Byte offset to read from; omitted reads the last `readChars` bytes.
   * @returns JSON job rows, or one job row with its output text, resume offset and loss flag.
   */
  async jobs(main: Agent, sessionId: SessionId, jobId?: string, from?: number): Promise<string> {
    await this.requireMain(main)
    const row = (job: JobView) => ({ id: job.id, kind: job.kind, label: job.label.replace(/\s+/g, ' ').slice(0, 120), status: job.status,
      ...job.progress === undefined ? {} : { progress: job.progress }, ...job.detail === undefined ? {} : { detail: job.detail },
      startedAt: job.startedAt, ...job.finishedAt === undefined ? {} : { finishedAt: job.finishedAt }, outputBytes: job.output.total })
    if (jobId === undefined) {
      const jobs = this.ctx.jobs.list(sessionId).map(row)
      const kept = []
      let chars = 0
      for (const job of jobs.toReversed()) {
        const length = JSON.stringify(job).length
        if (chars + length > this.config.readChars && kept.length > 0) break
        kept.push(job)
        chars += length
      }
      return JSON.stringify({ sessionId, jobs: kept.toReversed(), omittedEarlier: jobs.length - kept.length })
    }
    if (from !== undefined && (!Number.isSafeInteger(from) || from < 0)) throw new ToolArgsError(['from must be a nonnegative integer'])
    const id = JobId(jobId)
    const view = this.ctx.jobs.get(id, sessionId)
    const read = this.ctx.jobs.readAt(id, from ?? Math.max(view.output.earliest, view.output.total - this.config.readChars), sessionId)
    const text = read.chunks.map(chunk => chunk.text).join('')
    return JSON.stringify({ job: row(view), text: text.length > this.config.readChars ? text.slice(-this.config.readChars) : text,
      next: read.next, lossy: read.lossy || text.length > this.config.readChars })
  }

  /**
   * Read the current settings with secrets redacted.
   * @param main - Exact routing Agent.
   * @param namespace - Namespace to read; omitted reads every namespace that fits `readChars`.
   * @returns JSON effective values per namespace, or the namespace names when all values do not fit.
   */
  async settings(main: Agent, namespace?: string): Promise<string> {
    await this.requireMain(main)
    const settings = this.ctx.get('settings')
    if (settings === undefined) throw new Error('Settings are not available in this deployment')
    const all = settings.describe({ redactSecrets: true }).map(item => ({ namespace: String(item.ns), value: item.value }))
    if (namespace === undefined) {
      const text = JSON.stringify({ namespaces: all })
      return text.length <= this.config.readChars ? text
        : JSON.stringify({ names: all.map(item => item.namespace), guidance: 'Pass namespace to read one namespace.' })
    }
    const selected = all.find(item => item.namespace === namespace)
    if (selected === undefined) throw new ToolArgsError([`Unknown settings namespace ${namespace}`])
    const text = JSON.stringify(selected.value)
    return text.length <= this.config.readChars ? JSON.stringify(selected)
      : JSON.stringify({ namespace, value: text.slice(0, this.config.readChars), truncated: true })
  }

  /**
   * Return one image a Session or subagent's model received, for Main to view.
   * @param main - Exact routing Agent.
   * @param sessionId - Session or subagent in the same local owner profile.
   * @param seq - Sequence of the `user/message` or `tool/result` event holding the image.
   * @param index - Zero-based position among that event's images.
   * @returns A caption and the stored image reference.
   */
  async image(main: Agent, sessionId: SessionId, seq: number, index: number): Promise<{ text: string; attachment: ImageAttachmentRef }> {
    await this.requireMain(main)
    const snapshot = await this.ctx.sessionQuery.readSession(sessionId)
    const block = imageAt(snapshot.events, seq, index)
    if (block === undefined) throw new ToolArgsError([`Event ${seq} of Session ${sessionId} has no image ${index}`])
    return { text: `Image ${index} of event ${seq} in Session ${sessionId}.`, attachment: block.attachment }
  }

  /**
   * Record and deliver one new goal or an explicit revision, reusing an identical key.
   * A new key whose `instructions` or `reason` exceeds `noteChars` fails before any intent is recorded.
   * A fresh worker is created only when `maxWorkers` permits and no older fresh-worker dispatch is waiting;
   * otherwise the recorded intent waits as `dispatching` and starts automatically. With `taskRoot`, every
   * revision runs in the task's folder; another `cwd` or a reused Session in another directory fails before
   * any intent is recorded. The request source is Main's latest human message, or schedule reminder when unattended.
   * @param main - Exact routing Agent.
   * @param request - Agent-selected existing or fresh ordinary worker and bounded routing notes.
   * @returns authoritative task; `dispatching` for a waiting fresh worker; acceptance is not execution completion.
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
      const existing = [...this.table.entries()].flatMap(([, task]) => task.attempts
        .filter(attempt => task.owner === main.id && attempt.key === request.key).map(attempt => ({ task, attempt }))).at(0)
      if (existing !== undefined) {
        if (existing.attempt.requestHash !== requestHash) throw new Error('Dispatch key already names different work')
        const current = latest(existing.task)
        if (current.status !== 'dispatching' || (current.createSession && !this.startsNow(existing.task))) return existing.task
        return this.deliver(existing.task)
      }
      this.requireNotes(request)
      const source = (await this.ctx.sessionQuery.readSession(main.id)).events.findLast(event => this.dispatchSource(event))
      if (source === undefined) throw new Error('A human request is required before dispatch')
      const previous = request.taskId === undefined ? undefined : this.owned(main.id, request.taskId)
      if (previous !== undefined && latest(previous).revision !== request.expectedRevision) throw new Error('Task revision changed; read tasks again')
      if (previous !== undefined && reservesWorker(latest(previous))) throw new Error('Stop or settle the current assignment before revising it')
      const id = previous?.id ?? brandString<CoordinationTaskId>(`task-${randomUUID()}`)
      const folder = this.taskFolder(id)
      if (folder !== undefined && request.cwd !== undefined && request.cwd !== folder) {
        throw new ToolArgsError(['Each task works in its own folder; omit cwd'])
      }
      const target = request.sessionId ?? SessionId(`session-${randomUUID()}`)
      const createSession = request.sessionId === undefined
      const targetHeader = createSession ? undefined : await this.requireReusable(target, main.id, 'Target is busy; create a fresh Session instead')
      if (folder !== undefined && targetHeader !== undefined && targetHeader.cwd !== folder) {
        throw new ToolArgsError(['Each task works in its own folder; reuse only a worker of this task, or omit session_id'])
      }
      const cwd = targetHeader?.cwd ?? folder ?? request.cwd ?? main.session.header.cwd
      if (targetHeader !== undefined && request.cwd !== undefined && request.cwd !== targetHeader.cwd) throw new Error('Existing worker directory cannot be changed by dispatch')
      if (cwd === undefined) throw new Error('A worker requires an explicit working directory')
      if ([...this.table.entries()].some(([, task]) => latest(task).sessionId === target && reservesWorker(latest(task)))) {
        throw new Error('Worker already has an unsettled task; create a fresh Session')
      }
      const studio = this.ctx.get('jingliuConnection')
      const project = await studio?.assignmentProject(main.id)
      if (studio && targetHeader) {
        const existingProject = await studio.assignmentProject(target)
        if (existingProject && (project == null || existingProject.owner !== project.owner || existingProject.id !== project.id)) {
          throw new ToolArgsError(['Choose a worker for the current production or create a new Session'])
        }
      }
      let videoKey = previous === undefined ? null : latest(previous).videoKey
      if (this.config.inheritJubianVideoSelection) {
        const video = (await this.ctx.sessionQuery.readSession(main.id)).events.findLast(event => event.type === 'jubian/video-selection')
        videoKey = video?.type === 'jubian/video-selection' ? video.data.selection.key : null
      }
      const messageId = createUserMessage({ content: [], source: { kind: 'user' } }).id
      let task: CoordinationTask = {
        id, owner: main.id,
        title: previous?.title ?? request.title, createdAt: previous?.createdAt ?? Date.now(),
        attempts: [...previous?.attempts ?? [], {
          revision: (previous === undefined ? 0 : latest(previous).revision) + 1,
          key: request.key, requestHash, instructions: request.instructions, reason: request.reason, sourceSeq: source.seq,
          messageId, forwardedIds: [], briefId: createUserMessage({ content: [], source: { kind: 'user' } }).id,
          noticeId: createUserMessage({ content: [], source: { kind: 'user' } }).id,
          sessionId: target, createSession, cwd, sourceCwd: main.session.header.cwd ?? null, videoKey,
          ...(project && { studioProject: project }),
          status: 'dispatching', report: null, issue: null, notifiedStatus: null,
        }],
      }
      const originals = await this.humanInputs(task)
      task = revise(task, { forwardedIds: originals.map((_input, index) => index === originals.length - 1
        ? messageId : createUserMessage({ content: [], source: { kind: 'user' } }).id) })
      await this.save(task)
      if (createSession && !this.startsNow(task)) {
        this.background(() => this.startNext())
        return task
      }
      try { return await this.deliver(task) }
      catch (error) {
        await this.save(revise(task, { status: 'interrupted', issue: String(error) }))
        throw error
      }
    })
  }

  /**
   * Ask the original quiescent worker to verify existing results without replaying human business commands.
   * The coordinator records the worker's current log position; a supplied `expectedWorkerSeq` must equal it.
   * A new key whose `instructions` or `reason` exceeds `noteChars` fails before any intent is recorded.
   * @param main - Exact live owner Main Agent.
   * @param request - Idempotent recovery request with the expected task revision and bounded routing notes.
   * @returns retained successor assignment; an uncertain delivery remains interrupted.
   */
  async reconcile(main: Agent, request: ReconcileRequest): Promise<CoordinationTask> {
    await this.requireMain(main)
    return this.serial(async () => {
      if ([request.key, request.instructions, request.reason].some(value => value.trim() === '')
        || (request.expectedWorkerSeq !== undefined && (!Number.isSafeInteger(request.expectedWorkerSeq) || request.expectedWorkerSeq < 0))
        || !Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 1) {
        throw new ToolArgsError(['Reconciliation needs a nonempty key, instructions, reason, and valid expected revisions'])
      }
      const requestHash = createHash('sha256').update(JSON.stringify({ kind: 'reconcile', key: request.key,
        taskId: request.taskId, expectedRevision: request.expectedRevision, expectedWorkerSeq: request.expectedWorkerSeq ?? null,
        instructions: request.instructions, reason: request.reason })).digest('hex')
      const existing = this.list(main.id).find(task => task.attempts.some(attempt => attempt.key === request.key))
      if (existing !== undefined) {
        if (existing.attempts.find(attempt => attempt.key === request.key)?.requestHash !== requestHash) {
          throw new ToolArgsError(['Request key already names different work'])
        }
        const pending = latest(existing)
        return pending.status === 'reconciling' && pending.reconciliation !== undefined
          ? this.deliverReconciliation(existing, pending.reconciliation) : existing
      }
      this.requireNotes(request)
      const previous = this.owned(main.id, request.taskId)
      const attempt = latest(previous)
      if (attempt.revision !== request.expectedRevision) throw new ToolArgsError(['Task revision changed; read tasks again'])
      if (!['needs-report', 'interrupted'].includes(attempt.status)) {
        throw new ToolArgsError(['Only needs-report or interrupted assignments can be reconciled'])
      }
      await this.requireReusable(attempt.sessionId, main.id, 'Worker is still busy; wait for the next receipt and do not dispatch this work again')
      const resolved = await this.ctx.sessionController.resolveAgent(attempt.sessionId)
      if ('error' in resolved) throw resolved.error
      await this.ctx.sessions.flush(resolved.agent.session)
      const log = await this.ctx.sessionQuery.readSession(attempt.sessionId)
      const throughSeq = log.events.at(-1)?.seq
      if (throughSeq === undefined) throw new ToolContextUnavailableError('Worker history is unavailable')
      if (request.expectedWorkerSeq !== undefined && throughSeq !== request.expectedWorkerSeq) {
        throw new ToolArgsError(['Worker history advanced past expected_worker_seq; retry without it once the worker is idle'])
      }
      const human = log.events.findLast(event => event.type === 'user/message' && event.data.source.kind === 'user')
      if (human?.type !== 'user/message' || human.data.source.kind !== 'user' || 'principal' in human.data.source) {
        throw new ToolContextUnavailableError('Reconciliation requires a retained local owner input in the original worker')
      }
      const source = (await this.ctx.sessionQuery.readSession(main.id)).events.findLast(event => this.dispatchSource(event))
      if (source === undefined) throw new ToolContextUnavailableError('A retained Main owner request is required')
      const reconciliation = { throughSeq, humanSeq: human.seq, humanMessageId: human.data.id }
      let task: CoordinationTask = { ...previous, attempts: [...previous.attempts, {
        revision: attempt.revision + 1, key: request.key, requestHash, instructions: request.instructions, reason: request.reason,
        sourceSeq: source.seq, messageId: human.data.id, forwardedIds: [],
        briefId: createUserMessage({ content: [], source: { kind: 'user' } }).id,
        noticeId: createUserMessage({ content: [], source: { kind: 'user' } }).id,
        sessionId: attempt.sessionId, createSession: false, cwd: attempt.cwd, sourceCwd: main.session.header.cwd ?? null,
        videoKey: attempt.videoKey, ...(attempt.studioProject && { studioProject: attempt.studioProject }), status: 'reconciling', report: null, issue: null, notifiedStatus: null, reconciliation,
      }] }
      await this.humanInputs(task)
      await this.save(task)
      try { task = await this.deliverReconciliation(task, reconciliation) }
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
   * @param taskIds - Exact owned goals; omission or an empty list selects unsettled goals first, then recent ones.
   * @returns Complete task facts bounded by searchLimit and the combined readChars model-result/metadata budget.
   */
  async displayReport(main: Agent, taskIds: readonly CoordinationTaskId[] = []): Promise<CoordinationReport> {
    await this.requireMain(main)
    if (taskIds.length > this.config.searchLimit) throw new ToolArgsError(['task_ids exceeds the configured report limit'])
    if (new Set(taskIds).size !== taskIds.length) throw new ToolArgsError(['task_ids must be unique'])
    const selected = taskIds.length === 0 ? this.routingOrder(main.id) : taskIds.map(id => this.owned(main.id, id))
    let report: CoordinationReport = { version: 1, owner: main.id, total: selected.length, truncated: selected.length > 0, tasks: [] }
    const fits = (value: CoordinationReport): boolean => JSON.stringify(value).length
      + JSON.stringify({ museCoordinationReport: value }).length <= this.config.readChars
    if (!fits(report)) throw new ToolArgsError(['The empty report exceeds the configured readChars budget'])
    for (const task of selected.slice(0, this.config.searchLimit)) {
      const next = { ...report, tasks: [...report.tasks, reportTask(task)], truncated: report.tasks.length + 1 < selected.length }
      if (!fits(next)) {
        if (report.tasks.length === 0) throw new ToolArgsError(['The task report exceeds the configured readChars budget'])
        break
      }
      report = next
    }
    return report
  }

  /**
   * List Main's tasks for routing, unsettled first and then newest, one latest-revision row each.
   * Rows count presented files instead of listing them; a row that does not fit the remaining `readChars` budget is omitted.
   * @param main - Actual live Main Agent with a local owner request.
   * @returns at most `searchLimit` rows whose serialized list fits `readChars`, with the owned task total and an omission flag.
   */
  async tasks(main: Agent): Promise<RoutingTaskList> {
    await this.requireMain(main)
    const selected = this.routingOrder(main.id)
    let list: RoutingTaskList = { tasks: [], total: selected.length, truncated: selected.length > this.config.searchLimit }
    if (JSON.stringify(list).length > this.config.readChars) throw new ToolArgsError(['The empty task list exceeds the configured readChars budget'])
    for (const task of selected.slice(0, this.config.searchLimit)) {
      const next = { ...list, tasks: [...list.tasks, routingTask(task)] }
      list = JSON.stringify(next).length <= this.config.readChars ? next : { ...list, truncated: true }
    }
    return list
  }

  private routingOrder(owner: SessionId): CoordinationTask[] {
    return this.list(owner).sort((a, b) =>
      Number(reservesWorker(latest(b))) - Number(reservesWorker(latest(a))) || b.createdAt - a.createdAt)
  }

  /**
   * Observe complete owner-only task snapshots; no model polling or wake loop.
   * @param sessionId - Main Session selecting the task directory.
   * @param signal - Client cancellation; plugin unload also closes the stream.
   * @returns initial and changed task sets.
   */
  @Remote({ mode: 'stream' })
  async *watch(sessionId: SessionId, signal: AbortSignal): AsyncIterable<CoordinationTask[]> {
    yield* this.observe(signal, () => this.list(sessionId))
  }

  /**
   * Yield a fresh read now and after every coordinator state change, until the client or plugin unload aborts.
   * @param signal - Client cancellation.
   * @param read - Reads the current value.
   * @returns the initial value and one value per observed generation.
   */
  private async *observe<T>(signal: AbortSignal, read: () => T): AsyncGenerator<T> {
    const combined = AbortSignal.any([signal, this.lifetime.signal])
    while (!combined.aborted) {
      const generation = this.generation
      yield read()
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
   * This owner-only Remote operation never cancels an unrelated worker assignment: a busy worker that consumed
   * a later human-authored message keeps running and the task becomes interrupted. Runtime continuations of the
   * assignment, such as subagent settlement messages, are cancelled with it.
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
      const log = await this.ctx.sessionQuery.readSession(worker.id)
      if (this.busy(worker.id) && laterHumanInput(attempt, log.events) !== undefined) {
        return this.save(revise(task, { status: 'interrupted', issue: 'Worker is processing a later direct human request; it was not cancelled' }))
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
   * @param summary - Worker account supported by its native tool log, at most
   * `summaryChars` characters; for `needs-input`, the question for the user.
   * @returns task in finishing state; completion is published after quiescence.
   */
  report(worker: Agent, taskId: CoordinationTaskId, revision: number, outcome: WorkerReport['outcome'], summary: string): Promise<CoordinationTask> {
    return this.serial(async () => {
      if (this.ctx.agents.get(worker.id) !== worker) throw new ToolContextUnavailableError('Report requires the current live worker instance')
      if (summary.length > this.config.summaryChars) {
        throw new ToolArgsError([`summary exceeds ${this.config.summaryChars} characters; keep it short and put long content in presented files`])
      }
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
      if (laterHumanInput(latest(task), events) !== undefined) {
        throw new ToolArgsError(['Worker input changed; inspect and reconcile this task from Main before reporting it'])
      }
      const files = events.flatMap(event => event.seq > input.seq && event.type === 'deliverables/presented' ? event.data.files : [])
      await this.ctx.sessions.flush(worker.session)
      return this.save(revise(task, { status: 'finishing', issue: null, report: {
        outcome, summary, files, throughSeq: events.reduce((_seq, event) => event.seq, input.seq),
      } }))
    })
  }

  private presetOf(agent: Agent): string | undefined {
    const registry = this.ctx.get('agentPresets')
    return registry === undefined ? agent.session.header.agentPreset : registry.composedPreset(agent.ctx)
  }

  /** A Main input that can authorize dispatch: a human message, or a schedule reminder when unattended. */
  private dispatchSource(event: SessionEvent): boolean {
    return event.type === 'user/message'
      && (event.data.source.kind === 'user' || (this.config.unattended && event.data.source.kind === scheduleSource))
  }

  private taskFolder(id: CoordinationTaskId): string | undefined {
    return this.config.taskRoot === undefined ? undefined : join(this.config.taskRoot, id)
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
    const seen = new Set<Agent>()
    for (const [, task] of this.table.entries()) {
      if (!reservesWorker(latest(task))) continue
      const worker = this.ctx.agents.get(latest(task).sessionId)
      if (worker === undefined || seen.has(worker)) continue
      seen.add(worker)
      if (this.executionTree(worker).includes(agent)) await this.settleWorker(worker)
    }
  }

  /** @param busyMessage - Caller-specific next step reported when the Session or its execution tree is busy. */
  private async requireReusable(id: SessionId, mainId: SessionId, busyMessage: string) {
    const snapshot = await this.ctx.sessionQuery.readSession(id)
    const selected = snapshot.events.findLast(event => event.type === 'agent-preset/selected')
    const preset = selected?.type === 'agent-preset/selected' ? selected.data.agentPreset : snapshot.session.agentPreset
    if (id === mainId || preset === this.config.mainPreset || snapshot.session.origin === 'subagent'
      || this.ctx.workspaceRegistry.archivedSessionIds.includes(id)) throw new ToolArgsError(['Target is not an available ordinary execution Session'])
    if (!(await this.quiescent(id))) throw new ToolArgsError([busyMessage])
    return snapshot.session
  }

  /**
   * Whether a Session's execution tree has no running turn, pending input or live job, including jobs of
   * runtime descendants that are no longer live.
   * @throws when its subagent descendants cannot be listed.
   */
  private async quiescent(id: SessionId): Promise<boolean> {
    const worker = this.ctx.agents.get(id)
    return !this.busy(id) && (worker === undefined || !(await this.descendantIds(worker)).some(child => this.liveJobs(child).length > 0))
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
      // An automatic re-dispatch repeats its predecessors' inputs and adds none.
      if (attempt.redispatch !== undefined) continue
      const source = owner.events.find(event => event.seq === attempt.sourceSeq)
      if (source?.type !== 'user/message' || (source.data.source.kind !== 'user' && source.data.source.kind !== scheduleSource)
        || 'principal' in source.data.source) {
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

  private requireNotes(request: { readonly instructions: string; readonly reason: string }): void {
    if ([request.instructions, request.reason].some(value => value.length > this.config.noteChars)) {
      throw new ToolArgsError([`instructions and reason are routing notes of at most ${this.config.noteChars} characters each; the human messages are already forwarded verbatim`])
    }
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

  /** Deny `humanTools` to every member of an assigned worker's execution tree while unattended; the Main role denies its own. */
  private unattendedGuard(exec: Readonly<ToolExecution>): ToolGuardDenial | undefined {
    const agent = exec.agent
    if (!this.config.unattended || agent === undefined || !this.config.humanTools.includes(exec.name)) return undefined
    let root = agent
    const subagents = agent.session.header.origin === 'subagent' ? this.ctx.get('subagents') : undefined
    try { if (subagents !== undefined) root = subagents.rootOf(agent) }
    catch (error) {
      // A delegated Agent whose runtime owner is gone belongs to no assigned tree; it is checked as its own root.
      if (!(error instanceof SubagentError && error.code === 'UNAUTHORIZED')) throw error
    }
    if (![...this.table.entries()].some(([, task]) => latest(task).sessionId === root.id && reservesWorker(latest(task)))) return undefined
    const error = new ToolContextUnavailableError('This run is unattended and nobody answers questions. Decide from the request, or call coordinator_report with outcome blocked or needs-input and the question in summary.')
    return { reason: error.message, info: { name: error.name, code: error.code } }
  }

  /** @param reconciliation - The latest revision's recorded worker input and log position. */
  private async deliverReconciliation(task: CoordinationTask, reconciliation: Reconciliation): Promise<CoordinationTask> {
    const attempt = latest(task)
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
      content: [{ type: 'text', text: `Main Session reconciliation ${task.id}, revision ${attempt.revision}.\nGoal: ${task.title}\nReason: ${attempt.reason}\nInspection note: ${attempt.instructions}\nVerified existing human input: message ${reconciliation.humanMessageId}, seq ${reconciliation.humanSeq}; history recorded through seq ${reconciliation.throughSeq}. The human message remains in this original Session and is not being resent.\nOnly inspect the existing work and report its actual state. Do not repeat downloads, generation, writing or any other business action. Do not broaden the human request. Judge whether human messages after the original assignment belong to this goal; work for an unrelated request is not this task's delivery. Missing work must be reported as blocked or needs-input; Main routes any further work. Use present only to declare already existing final files, then call coordinator_report with this exact task id and revision. Completion is not human acceptance.\n` }],
    }), id: attempt.briefId })
    await this.ctx.sessions.flush(worker.session)
    return this.save(revise(task, { status: 'accepted', issue: null }))
  }

  private async deliver(task: CoordinationTask): Promise<CoordinationTask> {
    const attempt = latest(task)
    let worker = this.ctx.agents.get(attempt.sessionId)
    if (worker === undefined && attempt.createSession) {
      if (attempt.cwd === this.taskFolder(task.id)) await mkdir(attempt.cwd, { recursive: true })
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
    if (attempt.studioProject) {
      const studio = this.ctx.get('jingliuConnection')
      if (!studio) throw new Error('The assigned production requires the Jingliu connection')
      await studio.inheritProject(worker.id, attempt.studioProject)
    }
    if (attempt.videoKey !== null) {
      const video = worker.ctx.get('jubianVideoSelection')
      if (video === undefined) throw new Error('Worker cannot preserve the selected video model. This recorded task requires the Jubian video-selection service.')
      await video.select(worker, attempt.videoKey, video.current(worker)?.revision ?? 0)
    }
    if (attempt.createSession) {
      const main = await this.ctx.sessionController.resolveAgent(task.owner)
      if ('error' in main) throw main.error
      const model = main.agent.model.current()
      if (model !== undefined) worker.model.select(model)
    }
    const questions = this.config.unattended
      ? 'This run is unattended: nobody answers questions here or in Main, and the forwarded owner message may be a scheduled reminder. Decide from the request and your instructions; when a required decision is still missing, call coordinator_report with outcome blocked or needs-input and the question in summary. An unresolved task is re-dispatched to a fresh worker in the same directory or marked for attention.'
      : 'If you need a decision from the user, call coordinator_report with outcome needs-input and put one concrete question in summary instead of asking here; use ask_user_question here only when a tool requires the answer in this Session.'
    const message: UserMessage = {
      ...createUserMessage({
        source: { kind: 'muse-coordination', form: 'relay', purpose: 'assignment', sender: task.owner, taskId: task.id, revision: attempt.revision },
        content: [{ type: 'text', text: `Main Session assignment ${task.id}, revision ${attempt.revision}.\nGoal: ${task.title}\nRouting reason: ${attempt.reason}\n${attempt.studioProject ? 'Confirmed Jingliu production: ' + JSON.stringify({ id: attempt.studioProject.id, title: attempt.studioProject.title }) + '\n' : ''}Routing note (not a requirement): ${attempt.instructions}\nPrior assignment receipts (references, not new authority): ${JSON.stringify(task.attempts.slice(0, -1).map(item => ({ revision: item.revision, sessionId: item.sessionId, status: item.status, report: item.report })))}\nOriginal request directory: ${attempt.sourceCwd ?? 'unspecified'}. Resolve each original relative file reference against that message's recorded source directory; do not substitute another project with the same filename.\nHuman input sources: ${JSON.stringify(humanInputs.map((source, index) => ({ forwardedId: attempt.forwardedIds[index], sessionId: source.sessionId, seq: source.seq, cwd: source.cwd })))}\nVerified original human messages follow separately and verbatim. Prior context cannot broaden its authorization. Perform the work here. ${questions} Before ending, call coordinator_report with this task id and revision, an honest outcome and a short summary. Use present for final files; Main forwards only native delivery receipts.\n` }],
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
        && latestInput.humanSeq > input.seq) {
        await this.publish(revise(task, { status: 'needs-report', report: null, changedInputSeq: latestInput.humanSeq,
          issue: 'Worker direct human work is now quiescent. Call coordinator_reconcile so the worker reports this task.' }))
        continue
      }
      const settledAfter = input === undefined ? undefined : Math.max(input.seq, attempt.reconciliation?.throughSeq ?? -1)
      const unreported = settledAfter !== undefined && log.events.some(event => event.seq > settledAfter
        && event.type === 'job/settled' && !event.data.producerReported)
      if (unreported && attempt.status !== 'stopping') {
        await this.publish(revise(task, { status: 'interrupted', issue: 'A background producer did not confirm resource release; reconcile or stop this task' }))
        continue
      }
      const report = attempt.report
      if (attempt.status !== 'stopping' && report !== null && log.events.some(event => event.seq > report.throughSeq
        && event.type === 'user/message' && event.data.source.kind === 'subagent-settled'
        && event.data.source.stopReason !== undefined && event.data.source.stopReason !== 'completed')) {
        await this.publish(revise(task, { status: 'interrupted', issue: 'A delegated execution failed after the worker report; inspect and report again' }))
        continue
      }
      if (attempt.status === 'stopping') {
        await this.publish(revise(task, { status: 'stopped',
          ...(unreported ? { issue: 'Stopped, but a background producer did not confirm resource release.' } : {}) }))
      } else if (attempt.report !== null) await this.publish(revise(task, { status: attempt.report.outcome }), signal)
      else if (![...worker.inbox.nextTurn, ...worker.inbox.nextStep].some(message => message.id === attempt.briefId
        || message.id === attempt.messageId || attempt.forwardedIds.includes(message.id))) {
        await this.publish(revise(task, { status: 'needs-report', issue: attempt.reconciliation === undefined
          ? 'Worker is idle without a structured task report; completion is unconfirmed'
          : 'Worker is idle without a structured task report after reconciliation; tell the user and do not reconcile again automatically' }))
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
    // The report was accepted with no human input after the assignment input, through `report.throughSeq`.
    if (state.humanSeq === null || state.humanSeq <= attempt.report.throughSeq) return task
    const busy = this.busy(worker.id)
    return revise(task, { status: busy ? 'interrupted' : 'needs-report', report: null,
      changedInputSeq: state.humanSeq,
      issue: busy ? 'Worker input changed before report publication and the worker is still busy; wait for the next receipt.'
        : 'Worker input changed before report publication; call coordinator_reconcile so the worker reports this task.' })
  }

  /** Persist a receipt, record an unattended attention mark before Main hears of it, and notify Main. */
  private async publish(task: CoordinationTask, signal?: AbortSignal): Promise<void> {
    const checked = this.invalidatedReport(task, signal)
    await this.save(checked)
    let current = this.invalidatedReport(checked, signal)
    if (current !== checked) await this.save(current)
    // An attended receipt follows the status write with no extra await; an unattended attention mark is written first.
    const next = this.awaitsFollowUp(latest(current)) ? await this.followUpOf(current) : undefined
    if (next?.kind === 'attention') {
      current = revise(current, { attention: { reason: next.reason, at: Date.now() } })
      await this.save(current)
    }
    await this.notify(current, true, signal)
  }

  /**
   * Decide how the unattended policy resolves a task's latest revision. An interrupted revision whose worker
   * is busy waits for the receipt published after quiescence; one whose execution tree cannot be verified
   * needs attention instead of a second worker in the same directory.
   */
  private async followUpOf(task: CoordinationTask): Promise<FollowUp> {
    const attempt = latest(task)
    if (!this.awaitsFollowUp(attempt)) return { kind: 'none' }
    const reason = (detail: string): string => `${attempt.status}: ${detail}`.slice(0, this.config.summaryChars)
    if (attempt.status === 'interrupted') {
      let idle: boolean
      try { idle = await this.quiescent(attempt.sessionId) }
      catch (error) { return { kind: 'attention', reason: reason(`the execution subtree could not be verified: ${String(error)}`) } }
      if (!idle) return { kind: 'none' }
    }
    let automatic = 0
    for (let index = task.attempts.length - 1; index >= 0 && task.attempts[index]?.redispatch !== undefined; index--) automatic++
    return automatic < this.config.redispatchLimit ? { kind: 'redispatch' }
      : { kind: 'attention', reason: reason(String(attempt.issue ?? attempt.report?.summary)) }
  }

  private awaitsFollowUp(attempt: Assignment): boolean {
    return this.config.unattended && attempt.attention === undefined && unresolvedStatuses.has(attempt.status)
  }

  /** Re-decide from stored state, so repeated scheduling for one receipt acts once. */
  private async followUp(owner: SessionId, id: CoordinationTaskId): Promise<void> {
    const task = this.owned(owner, id)
    const next = await this.followUpOf(task)
    if (next.kind === 'attention') await this.publish(task)
    else if (next.kind === 'redispatch') {
      let successor: CoordinationTask
      try { successor = await this.recordRedispatch(task) }
      catch (error) {
        await this.publish(revise(task, { attention: { at: Date.now(),
          reason: `${latest(task).status}: the automatic re-dispatch could not be recorded: ${String(error)}`.slice(0, this.config.summaryChars) } }))
        return
      }
      if (!this.startsNow(successor)) {
        this.background(() => this.startNext())
        return
      }
      try { await this.deliver(successor) }
      catch (error) {
        await this.publish(revise(successor, { status: 'interrupted', issue: `The automatic re-dispatch could not start: ${String(error)}` }))
      }
    }
  }

  /**
   * Record a Host-authored revision that forwards the task's earlier inputs to a fresh worker in the same
   * directory; it starts under `maxWorkers` like any fresh-worker dispatch.
   * @returns the stored successor; nothing is stored when this throws.
   */
  private async recordRedispatch(task: CoordinationTask): Promise<CoordinationTask> {
    const previous = latest(task)
    const revision = previous.revision + 1
    const fresh = (): MessageId => createUserMessage({ content: [], source: { kind: 'user' } }).id
    const messageId = fresh()
    let next: CoordinationTask = { ...task, attempts: [...task.attempts, {
      revision, key: `redispatch:${task.id}:${revision}`,
      requestHash: createHash('sha256').update(JSON.stringify({ kind: 'redispatch', taskId: task.id, revision })).digest('hex'),
      instructions: 'Automatic unattended re-dispatch of this task.',
      reason: `Revision ${previous.revision} ended ${previous.status} without a human to answer.`,
      sourceSeq: previous.sourceSeq, messageId, forwardedIds: [], briefId: fresh(), noticeId: fresh(),
      sessionId: SessionId(`session-${randomUUID()}`), createSession: true, cwd: previous.cwd, sourceCwd: previous.sourceCwd,
      videoKey: previous.videoKey, ...(previous.studioProject && { studioProject: previous.studioProject }), status: 'dispatching', report: null, issue: null, notifiedStatus: null,
      redispatch: { after: previous.status },
    }] }
    const originals = await this.humanInputs(next)
    next = revise(next, { forwardedIds: originals.map((_input, index) => index === originals.length - 1 ? messageId : fresh()) })
    return this.save(next)
  }

  private async notify(task: CoordinationTask, verifyInput = false, signal?: AbortSignal): Promise<void> {
    if (this.unloading()) return
    const attempt = latest(task)
    if (attempt.notifiedStatus === attempt.status && attempt.notifiedInputSeq === attempt.changedInputSeq) return
    const resolution = await this.optional(this.ctx.sessionController.resolveAgent(task.owner))
    if (resolution.kind === 'aborted') return
    const resolved = resolution.value
    if ('error' in resolved) throw resolved.error
    const owner = resolved.agent
    const noticeId = brandString<MessageId>(`${attempt.noticeId}-${attempt.status}${attempt.changedInputSeq === undefined ? '' : `-${attempt.changedInputSeq}`}`)
    const pending = [...owner.inbox.nextTurn, ...owner.inbox.nextStep].some(message => message.id === noticeId)
    const history = await this.optional(this.ctx.sessionQuery.readSession(owner.id))
    if (history.kind === 'aborted') return
    const logged = history.value.events.some(event => (event.type === 'user/message' && event.data.id === noticeId) || (event.type === 'agent/inbox/spliced' && event.data.inserted.some(message => message.id === noticeId)))
    if (verifyInput) {
      const current = this.invalidatedReport(task, signal)
      if (current !== task) {
        await this.publish(current, signal)
        return
      }
    }
    let durable = true
    if (!pending && !logged) {
      owner.followup({ ...createUserMessage({
        source: { kind: 'muse-coordination', form: 'notice', summary: boundContextSummary(`${task.title}: ${attempt.status}`),
          purpose: 'receipt', sender: attempt.sessionId, taskId: task.id, revision: attempt.revision },
        content: [{ type: 'text', text: JSON.stringify({ taskId: task.id, title: task.title, revision: attempt.revision, workerSessionId: attempt.sessionId, status: attempt.status, report: attempt.report, issue: attempt.issue,
          ...(attempt.attention === undefined ? {} : { attention: attempt.attention }),
          instruction: this.config.unattended
            ? 'Unattended run: nobody answers questions. Record the outcome, files or attention reason in brief text and ask nothing. The coordinator re-dispatches unresolved tasks itself and marks the rest for attention; do not dispatch, reconcile or stop this task for that. Worker completion is not human acceptance.'
            : 'Relay the verified outcome and files to the user. For needs-input, relay the summary question verbatim as plain text, not a card, and dispatch the revision after the user replies. Worker completion is not human acceptance. Route further work to execution Sessions.' }) }],
      }), id: noticeId })
      const checkpoint = await this.optional(this.ctx.sessions.flush(owner.session))
      durable = checkpoint.kind === 'value' && checkpoint.value
    }
    if (!durable || this.unloading()) return
    await this.save(revise(task, { notifiedStatus: attempt.status,
      ...(attempt.changedInputSeq === undefined ? {} : { notifiedInputSeq: attempt.changedInputSeq }) }))
  }

  /** Count assignments of every owner whose latest status holds a `maxWorkers` slot. */
  private occupied(): number {
    return [...this.table.entries()].filter(([, task]) => slotStatuses.has(latest(task).status)).length
  }

  /** Fresh-worker dispatch intents not yet delivered, oldest first. */
  private waiting(): CoordinationTask[] {
    return [...this.table.entries()].map(([, task]) => task)
      .filter(task => latest(task).status === 'dispatching' && latest(task).createSession)
      .sort((a, b) => a.createdAt - b.createdAt || Number(a.id > b.id) - Number(a.id < b.id))
  }

  private startsNow(task: CoordinationTask): boolean {
    return this.waiting()[0]?.id === task.id && this.occupied() < this.config.maxWorkers
  }

  /**
   * Deliver the oldest waiting fresh worker when a slot is free; a delivery failure publishes interrupted with
   * the stop-then-dispatch step.
   */
  private async startNext(): Promise<void> {
    const head = this.waiting()[0]
    if (head === undefined || this.occupied() >= this.config.maxWorkers) return
    try { await this.deliver(head) }
    catch (error) {
      await this.publish(revise(head, { status: 'interrupted',
        issue: `The waiting task could not start: ${String(error)}. Do not reconcile; stop this task, then dispatch it again.` }))
    }
    this.background(() => this.startNext())
  }

  /**
   * Each task recovers independently; a failure is logged and leaves that task's stored status unchanged.
   * Waiting fresh workers start afterwards within `maxWorkers`, and unresolved unattended revisions are followed up.
   */
  private async recover(): Promise<void> {
    this.syncActivity()
    for (const [id, task] of this.table.entries()) {
      try { await this.recoverTask(task) }
      catch (error) { this.ctx.logger.error('session-coordinator: recovery of %s failed: %s', id, String(error)) }
    }
    // A revision published before an unload, or before unattended mode was enabled, still needs its follow-up.
    for (const [id, task] of this.table.entries()) {
      if (this.awaitsFollowUp(latest(task))) this.background(() => this.followUp(task.owner, id))
    }
    try { await this.startNext() }
    catch (error) { this.ctx.logger.error('session-coordinator: starting a waiting task after recovery failed: %s', String(error)) }
  }

  private async recoverTask(task: CoordinationTask): Promise<void> {
    const attempt = latest(task)
    if (attempt.status === 'dispatching' && attempt.createSession
      && !(await this.ctx.sessionQuery.listSessions(this.lifetime.signal)).some(row => row.header.id === attempt.sessionId)) return
    if (attempt.status === 'dispatching' || attempt.status === 'reconciling') {
      try {
        const delivered = await (attempt.reconciliation === undefined
          ? this.deliver(task) : this.deliverReconciliation(task, attempt.reconciliation))
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

  /**
   * Persist a task; leaving a slot status schedules the next waiting fresh worker, and an unresolved
   * unattended revision schedules its follow-up after the current operation.
   */
  private async save(task: CoordinationTask): Promise<CoordinationTask> {
    const before = this.table.get(task.id)
    await this.table.put(task.id, task)
    this.changed()
    if (before !== undefined && slotStatuses.has(latest(before).status) && !slotStatuses.has(latest(task).status)
      && !this.unloading() && this.waiting().length > 0) this.background(() => this.startNext())
    if (this.awaitsFollowUp(latest(task)) && !this.unloading()) this.background(() => this.followUp(task.owner, task.id))
    return task
  }

  private changed(): void {
    this.generation++
    this.syncActivity()
    for (const notify of [...this.observers]) notify()
  }

  /** Watch the worker of every executing assignment for Main's activity digests; release the rest. */
  private syncActivity(): void {
    const activity = this.ctx.get('sessionActivity')
    const executing = new Map<CoordinationTaskId, CoordinationTask>()
    if (activity !== undefined && !this.unloading()) {
      for (const [id, task] of this.table.entries()) if (slotStatuses.has(latest(task).status)) executing.set(id, task)
    }
    for (const [id, watch] of this.activityWatches) {
      const task = executing.get(id)
      if (task !== undefined && latest(task).sessionId === watch.worker) continue
      watch.release()
      this.activityWatches.delete(id)
    }
    if (activity === undefined) return
    for (const [id, task] of executing) {
      if (this.activityWatches.has(id)) continue
      const worker = latest(task).sessionId
      this.activityWatches.set(id, { worker, release: activity.watch(task.owner, worker, task.title) })
    }
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
