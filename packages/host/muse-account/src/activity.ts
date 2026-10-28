/** Best-effort account usage reports from committed human input, without conversation content. */

import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { museGatewayOrigin } from './gateway.ts'
import { readMuseSession, type MuseStoredSession } from './session.ts'

/** Gateway destination and bounded reporting frequency and lifetime. */
export interface MuseActivityOptions {
  readonly baseUrl: string
  readonly sessionFile: string
  readonly reportIntervalMs: number
  readonly requestTimeoutMs: number
  readonly fetcher?: typeof fetch
}

/** Coalesce root turns into one pending account capture and one pending request; failures never reject a user turn. */
export class MuseActivityReporter {
  private readonly origin: string
  private readonly turns = new WeakMap<Session, boolean>()
  private readonly abort = new AbortController()
  private capture: Promise<void> | undefined
  private sending: Promise<void> | undefined
  private queued: MuseStoredSession | undefined
  private lastAttempt: { revision: string; at: number } | undefined
  private closed = false

  constructor(private readonly options: MuseActivityOptions) {
    this.origin = museGatewayOrigin(options.baseUrl)
  }

  /**
   * Observe live committed events; each root human turn reports at most once.
   * @param session - Session receiving the committed event.
   * @param event - Newly appended event, never a history replay.
   */
  observe(session: Session, event: SessionEvent): void {
    if (this.closed || session.header.origin === 'subagent' || (session.header.delegationDepth ?? 0) > 0) return
    if (event.type === 'turn/start') { this.turns.set(session, false); return }
    if (event.type === 'turn/end') { this.turns.delete(session); return }
    if (event.type !== 'user/message' || event.data.source.kind !== 'user' || this.turns.get(session) !== false) return
    this.turns.set(session, true)
    if (this.capture !== undefined) return
    const capture = this.captureAccount()
    this.capture = capture
    void capture.finally(() => { this.capture = undefined })
  }

  private async captureAccount(): Promise<void> {
    try {
      const session = await readMuseSession(this.options.sessionFile, this.origin)
      if (this.closed || session === null) return
      this.queued = session
      this.pump()
    } catch (_error) {
      // Missing, unreadable or concurrently replaced login files cannot affect task execution.
    }
  }

  private pump(): void {
    if (this.closed || this.sending !== undefined || this.queued === undefined) return
    const session = this.queued
    this.queued = undefined
    const sending = this.send(session)
    this.sending = sending
    void sending.finally(() => {
      this.sending = undefined
      this.pump()
    })
  }

  private async send(session: MuseStoredSession): Promise<void> {
    try {
      const now = Date.now()
      const age = this.lastAttempt === undefined ? undefined : now - this.lastAttempt.at
      if (this.lastAttempt?.revision === session.revision && age !== undefined
        && age >= 0 && age < this.options.reportIntervalMs) return
      const current = await readMuseSession(this.options.sessionFile, this.origin)
      if (this.closed || current?.revision !== session.revision) return
      this.lastAttempt = { revision: session.revision, at: now }
      const response = await (this.options.fetcher ?? fetch)(new URL('/api/muse.activity', this.origin), {
        method: 'POST', redirect: 'manual',
        headers: { 'content-type': 'application/json', origin: this.origin, cookie: session.cookie },
        body: JSON.stringify({ activity: 'task-start' }),
        signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(this.options.requestTimeoutMs)]),
      })
      await response.body?.cancel()
    } catch (_error) {
      // Usage is best effort; neither rejected writes nor unknown network outcomes are retried.
    }
  }

  /** Abort reporting and await account reads and network teardown before plugin unload completes. */
  async dispose(): Promise<void> {
    this.closed = true
    this.queued = undefined
    this.abort.abort()
    await this.capture
    await this.sending
  }
}

/**
 * Register the live usage observer and its owned request cleanup.
 * @param ctx - Muse Host plugin context.
 * @param options - Account session location, destination and reporting limits.
 */
export function mountMuseActivity(ctx: Context, options: MuseActivityOptions): void {
  const reporter = new MuseActivityReporter(options)
  ctx.effect(() => () => reporter.dispose(), 'muse-account: usage reporting')
  ctx.on('session/event', (session, event) => { reporter.observe(session, event) })
}
