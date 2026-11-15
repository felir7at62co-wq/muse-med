/**
 * Session status lines as the session list shows them, and watched-Session status digests: the
 * `sessionActivity` service reads live Agent state, pending questions and approvals, and running
 * jobs and subagents, and delivers one coalesced, replaceable notice to each parent whose watched
 * Sessions changed status.
 *
 * @module @deepseek-ai/dsh-session-activity
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { MessageId } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ProjectionHandle } from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-api-gateway/types'
import { renderDigest, statusKey, statusText } from './digest.ts'
import type { DigestEntry, SessionStatus, SessionStatusKind } from './digest.ts'
import { initialActivity, sessionActivityProjectionDefinition, type SessionActivityState } from './projection.ts'
import type { SessionActivityWatcher } from './types.ts'

export type * from './types.ts'

/** Deployment choices for status digests. */
export interface Config {
  /** Maximum Session lines in one digest. Defaults to 8. */
  readonly maxLines?: number
  /** Maximum characters of one digest. Defaults to 1200. */
  readonly maxChars?: number
  /** Running time without a new event after which a watched Session wakes its parent once; 0 disables. Defaults to 600000. */
  readonly stallMs?: number
  /** Delay that merges a burst of events into one status evaluation. Defaults to 1000. */
  readonly coalesceMs?: number
}

type ResolvedConfig = Required<Config>

/** One watched child of a parent. */
interface ChildWatch {
  label: string
  references: number
  /** Status key in the digest the parent last logged. */
  delivered: string | null
  /** State kind in the digest last sent, logged or still pending; wake reasons are judged against it. */
  notified: SessionStatusKind | null
  lastEventAt: number
  stallTimer: ReturnType<typeof setTimeout> | undefined
  stalledMs: number | undefined
}

/** Digest still waiting in a parent's inbox. */
interface PendingDigest {
  readonly id: MessageId
  readonly keys: ReadonlyMap<SessionId, string>
}

/** Watches of one parent. */
interface ParentWatch {
  readonly children: Map<SessionId, ChildWatch>
  pending: PendingDigest | undefined
  evaluation: ReturnType<typeof setTimeout> | undefined
  /** Serializes this parent's evaluations and releases. */
  chain: Promise<void>
}

/** Session status lines and coalescing status digests from watched Sessions to their parents. */
export class SessionActivityDigests extends Service implements SessionActivityWatcher {
  static inject = ['sessions', 'sessionProjections', 'agents']
  static Config: z<Config> = z.object({
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
        for (const [id, key] of parent.pending.keys) {
          const child = parent.children.get(id)
          if (child !== undefined) child.delivered = key
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
      watch = { children: new Map(), pending: undefined, evaluation: undefined, chain: Promise.resolve() }
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
      this.schedule(parent, watch)
    }
    let released = false
    return () => {
      if (released) return
      released = true
      this.release(parent, child)
    }
  }

  async describe(sessionId: SessionId): Promise<string> {
    return statusText(await this.status(sessionId), Date.now())
  }

  private release(parentId: SessionId, childId: SessionId): void {
    const parent = this.parents.get(parentId)
    const child = parent?.children.get(childId)
    if (parent === undefined || child === undefined) return
    if (--child.references > 0) return
    clearTimeout(child.stallTimer)
    child.stallTimer = undefined
    // One last evaluation reports a change the coalescing delay has not reached yet.
    this.enqueue(parentId, parent, async () => {
      await this.deliver(parentId, parent)
      if (child.references > 0) return
      parent.children.delete(childId)
      if (parent.children.size > 0) return
      clearTimeout(parent.evaluation)
      parent.evaluation = undefined
      if (parent.pending === undefined) this.parents.delete(parentId)
    })
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
      this.enqueue(parentId, watch, () => this.deliver(parentId, watch))
    }, this.config.coalesceMs)
  }

  /** Run one evaluation or release after the parent's earlier ones; a failure is logged and skipped. */
  private enqueue(parentId: SessionId, watch: ParentWatch, task: () => Promise<void>): void {
    watch.chain = watch.chain.then(async () => { if (!this.disposed) await task() }).catch((error: unknown) => {
      this.ctx.logger.warn('session-activity: status digest for %s failed: %s', parentId, String(error))
    })
  }

  /**
   * Read one Session's status from live Agent state, pending forwarded requests, running work and its log.
   * @param sessionId - Any local Session.
   * @returns The status behind its line.
   */
  private async status(sessionId: SessionId): Promise<SessionStatus> {
    const session = this.ctx.sessions.get(sessionId)
    const state = session === undefined ? initialActivity() : this.handle.stateOf(session)
    const agent = this.ctx.agents.get(sessionId)
    const pending = new Set((this.ctx.get('typertGateway')?.getPendingRemoteEvents() ?? [])
      .filter(item => String(item.agentId) === sessionId).map(item => item.event))
    const families = await this.ctx.waterfall('workspace/session-activity', { sessionId }, () => Promise.resolve([]))
    const kind: SessionStatusKind = pending.has('user-questions/request') ? 'question'
      : pending.has('approval/request') ? 'approval'
        : agent?.status === 'running' ? 'running'
          : agent === undefined ? 'not-open'
            : state.lastTurnEnd?.kind === 'error' ? 'failed' : 'idle'
    const active = kind === 'running' || kind === 'question' || kind === 'approval'
    return {
      kind,
      since: active ? state.turnStartedAt : state.lastTurnEnd?.time ?? null,
      lastTool: state.lastTool,
      activity: families.flatMap((family) => {
        const familyKind: string = family.kind
        // The turn family repeats the running state itself.
        return familyKind === 'turn' ? [] : [{ kind: familyKind, labels: (family.items ?? []).map(item => item.label ?? item.id) }]
      }),
      error: state.lastTurnEnd?.kind === 'error' && kind === 'failed' ? state.lastTurnEnd.text : '',
    }
  }

  /** Render the parent's changed children and queue, replace, or wake with one digest. */
  private async deliver(parentId: SessionId, watch: ParentWatch): Promise<void> {
    const agent = this.ctx.agents.get(parentId)
    if (agent === undefined) return
    const entries: DigestEntry[] = []
    const sent: [ChildWatch, SessionStatusKind][] = []
    const keys = new Map<SessionId, string>()
    for (const [id, child] of watch.children) {
      const status = await this.status(id)
      keys.set(id, statusKey(status))
      sent.push([child, status.kind])
      entries.push({
        label: child.label, sessionId: id, status, delivered: child.delivered, notified: child.notified, stalledMs: child.stalledMs,
      })
    }
    const digest = renderDigest(entries, this.config, Date.now())
    if (digest === undefined) return
    const message = createUserMessage({
      content: [{ type: 'text', text: digest.text }],
      source: { kind: 'session-activity', form: 'notice', summary: boundContextSummary(digest.summary) },
    })
    const replaced = watch.pending !== undefined && agent.inbox.replace(watch.pending.id, message)
    watch.pending = { id: message.id, keys }
    for (const [child, kind] of sent) {
      child.notified = kind
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
