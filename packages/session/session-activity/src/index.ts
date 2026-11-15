/**
 * Watched-Session activity digests: a host-only `sessionActivity` projection folds each Session's
 * calls, failures, image inputs, deliverables, jobs and token use, and the `sessionActivity` service
 * delivers one coalesced, replaceable notice to each parent whose watched Sessions changed.
 *
 * @module @deepseek-ai/dsh-session-activity
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { MessageId } from '@deepseek-ai/dsh-llm'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { ProjectionHandle } from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-agent'
import { renderDigest, type DigestEntry } from './digest.ts'
import { sessionActivityProjectionDefinition, type SessionActivityState } from './projection.ts'
import type { SessionActivityWatcher } from './types.ts'

export type * from './types.ts'

/** Deployment choices for activity digests. */
export interface Config {
  /** Tool names whose new calls in a watched Session wake the parent. Defaults to `ask_user_question`. */
  readonly wakeTools?: string[]
  /** Maximum Session lines in one digest. Defaults to 8. */
  readonly maxLines?: number
  /** Maximum characters of one digest. Defaults to 1200. */
  readonly maxChars?: number
  /** Running time without a new event after which a watched Session wakes its parent once; 0 disables. Defaults to 600000. */
  readonly stallMs?: number
  /** Delay that merges a burst of events into one digest evaluation. Defaults to 1000. */
  readonly coalesceMs?: number
}

type ResolvedConfig = Required<Config>

/** One watched child of a parent. */
interface ChildWatch {
  label: string
  references: number
  /** State included in the digest the parent last logged. */
  delivered: SessionActivityState | null
  /** State included in the digest last sent, logged or still pending; wake reasons are judged against it. */
  notified: SessionActivityState | null
  lastEventAt: number
  stallTimer: ReturnType<typeof setTimeout> | undefined
  stalledMs: number | undefined
}

/** Digest still waiting in a parent's inbox. */
interface PendingDigest {
  readonly id: MessageId
  readonly states: ReadonlyMap<SessionId, SessionActivityState>
}

/** Watches of one parent. */
interface ParentWatch {
  readonly children: Map<SessionId, ChildWatch>
  pending: PendingDigest | undefined
  evaluation: ReturnType<typeof setTimeout> | undefined
}

/** Coalescing digest delivery from watched Sessions to their parents. */
export class SessionActivityDigests extends Service implements SessionActivityWatcher {
  static inject = ['sessions', 'sessionProjections', 'agents']
  static Config: z<Config> = z.object({
    wakeTools: z.array(z.string()).default(['ask_user_question']),
    maxLines: z.natural().min(1).default(8),
    maxChars: z.natural().min(200).default(1200),
    stallMs: z.natural().default(600_000),
    coalesceMs: z.natural().default(1000),
  })

  private readonly config: ResolvedConfig
  private handle!: ProjectionHandle<SessionActivityState>
  private readonly parents = new Map<SessionId, ParentWatch>()
  private disposed = false

  /**
   * @param ctx - Host services.
   * @param config - Validated digest bounds.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'sessionActivity')
    this.config = config as ResolvedConfig
  }

  protected async [Service.init](): Promise<void> {
    this.handle = await this.ctx.sessionProjections.register(sessionActivityProjectionDefinition)
    this.ctx.effect(() => () => {
      this.disposed = true
      for (const parent of this.parents.values()) {
        clearTimeout(parent.evaluation)
        for (const child of parent.children.values()) clearTimeout(child.stallTimer)
      }
      this.parents.clear()
    }, 'session-activity: watches')
    this.ctx.on('session/event', (session, event) => {
      const parent = this.parents.get(session.id)
      if (parent?.pending !== undefined && event.type === 'user/message' && event.data.id === parent.pending.id) {
        for (const [id, state] of parent.pending.states) {
          const child = parent.children.get(id)
          if (child !== undefined) { child.delivered = state; child.stalledMs = undefined }
        }
        parent.pending = undefined
        if (parent.children.size === 0) this.parents.delete(session.id)
      }
      for (const [parentId, watch] of this.parents) {
        const child = watch.children.get(session.id)
        if (child === undefined) continue
        child.lastEventAt = event.time
        this.armStall(parentId, watch, session.id, child)
        this.schedule(parentId, watch)
      }
    }, { global: true })
  }

  watch(parent: SessionId, child: SessionId, label: string): () => void {
    if (this.disposed) return () => {}
    let watch = this.parents.get(parent)
    if (watch === undefined) {
      watch = { children: new Map(), pending: undefined, evaluation: undefined }
      this.parents.set(parent, watch)
    }
    const existing = watch.children.get(child)
    if (existing !== undefined) {
      existing.label = label
      existing.references++
    } else {
      const entry: ChildWatch = {
        label, references: 1, delivered: null, notified: null, lastEventAt: Date.now(), stallTimer: undefined, stalledMs: undefined,
      }
      watch.children.set(child, entry)
      this.armStall(parent, watch, child, entry)
    }
    let released = false
    return () => {
      if (released) return
      released = true
      this.release(parent, child)
    }
  }

  private release(parentId: SessionId, childId: SessionId): void {
    const parent = this.parents.get(parentId)
    const child = parent?.children.get(childId)
    if (parent === undefined || child === undefined) return
    if (--child.references > 0) return
    clearTimeout(child.stallTimer)
    // Changes committed since the last evaluation would otherwise never reach the parent.
    this.deliver(parentId, parent)
    parent.children.delete(childId)
    if (parent.children.size > 0) return
    clearTimeout(parent.evaluation)
    parent.evaluation = undefined
    if (parent.pending === undefined) this.parents.delete(parentId)
  }

  /** Restart the stall timer of a running child; release and unload clear it. */
  private armStall(parentId: SessionId, watch: ParentWatch, childId: SessionId, child: ChildWatch): void {
    clearTimeout(child.stallTimer)
    child.stallTimer = undefined
    const session = this.ctx.sessions.get(childId)
    if (this.config.stallMs === 0 || session === undefined || this.handle.stateOf(session).openTurn === null) return
    child.stallTimer = setTimeout(() => {
      child.stallTimer = undefined
      child.stalledMs = Date.now() - child.lastEventAt
      this.schedule(parentId, watch)
    }, this.config.stallMs)
  }

  /** Evaluate the parent once after `coalesceMs`; releasing its last child and unload clear the timer. */
  private schedule(parentId: SessionId, watch: ParentWatch): void {
    if (watch.evaluation !== undefined) return
    watch.evaluation = setTimeout(() => {
      watch.evaluation = undefined
      this.deliver(parentId, watch)
    }, this.config.coalesceMs)
  }

  /** Render the parent's changed children and queue, replace, or wake with one digest. */
  private deliver(parentId: SessionId, watch: ParentWatch): void {
    const agent = this.ctx.agents.get(parentId)
    if (agent === undefined) return
    const entries: DigestEntry[] = []
    const sent: [ChildWatch, SessionActivityState][] = []
    const states = new Map<SessionId, SessionActivityState>()
    for (const [id, child] of watch.children) {
      const session: Session | undefined = this.ctx.sessions.get(id)
      if (session === undefined) continue
      const state = this.handle.stateOf(session)
      states.set(id, state)
      sent.push([child, state])
      entries.push({
        label: child.label, sessionId: id, state, delivered: child.delivered, notified: child.notified, stalledMs: child.stalledMs,
      })
    }
    const digest = renderDigest(entries, this.config)
    if (digest === undefined) return
    const message = createUserMessage({
      content: [{ type: 'text', text: digest.text }],
      source: { kind: 'session-activity', form: 'notice', summary: boundContextSummary(digest.summary) },
    })
    const replaced = watch.pending !== undefined && agent.inbox.replace(watch.pending.id, message)
    watch.pending = { id: message.id, states }
    for (const [child, state] of sent) {
      child.notified = state
      child.stalledMs = undefined
    }
    if (!digest.wake || agent.status !== 'idle') {
      if (!replaced) agent.inject(message)
      return
    }
    // A waking digest opens its own turn; the injected copy would only wait for a later step.
    if (replaced) agent.inbox.remove(message.id)
    agent.followup(message)
  }
}

export default SessionActivityDigests
