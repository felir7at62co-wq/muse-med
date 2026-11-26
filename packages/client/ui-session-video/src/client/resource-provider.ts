/** Resource-owned inventory refreshes follow durable changes in one retained conversation. */
import type { ResourceProvider } from '@deepseek-ai/dsh-client-resources/client'
import type { SessionEventSource } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionVideoInventory } from '@deepseek-ai/dsh-session-video/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { RemoteError, type RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { parseVideoWorkspaceAddress } from './target-selection.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface ResourceProtocolMap {
    /** Current inventory from the Session encoded in the video workspace address. */
    'session-video': SessionVideoInventory
  }
}

/** Held conversation events remain valid until release. */
export interface RetainedVideoSession {
  readonly ready: Promise<SessionEventSource>
  readonly release: () => void
}

/** Resource provider and explicit invalidation owned by one plugin application. */
export interface VideoResources {
  readonly provider: ResourceProvider<'session-video'>
  readonly refresh: (sessionId: SessionId) => void
  readonly settle: () => Promise<void>
}

/** Create an inventory stream which releases its Session after cancellation settles.
 * @param retain - Acquire the conversation generation for one resource lifetime.
 * @param list - Read the inventory through the generated Remote method.
 * @returns Provider, manual retry, and a teardown completion signal.
 */
export function createVideoResources(
  retain: (sessionId: SessionId, signal: AbortSignal) => RetainedVideoSession,
  list: (sessionId: SessionId, signal: AbortSignal) => Promise<RemoteResult<SessionVideoInventory>>,
): VideoResources {
  const readers = new Map<SessionId, Set<() => void>>()
  const active = new Set<Promise<void>>()
  return {
    provider: {
      protocol: 'session-video',
      async *open(address, { signal }) {
        const navigation = parseVideoWorkspaceAddress(address)
        if (navigation === null) {
          yield { ok: false, error: new RemoteError('gateway/bad-request', 'Invalid Session video resource address', {}) }
          return
        }
        if (signal.aborted) return
        const finished = Promise.withResolvers<void>()
        active.add(finished.promise)
        const { sessionId } = navigation
        let held: RetainedVideoSession | undefined
        let unsubscribe: (() => void) | undefined
        let wake: (() => void) | undefined
        let dirty = true
        const refresh = (): void => { dirty = true; wake?.() }
        const aborted = (): boolean => signal.aborted
        const abort = (): void => { wake?.() }
        let group = readers.get(sessionId)
        if (group === undefined) { group = new Set(); readers.set(sessionId, group) }
        group.add(refresh)
        signal.addEventListener('abort', abort, { once: true })
        try {
          while (!aborted()) {
            if (!dirty) await new Promise<void>((resolve) => { wake = resolve })
            wake = undefined
            if (aborted()) return
            dirty = false
            if (held === undefined) {
              let events: SessionEventSource
              try {
                held = retain(sessionId, signal)
                events = await held.ready
              } catch (error: unknown) {
                held?.release(); held = undefined
                if (!aborted()) yield { ok: false, error: new RemoteError('gateway/internal',
                  error instanceof Error ? error.message : 'Session video conversation could not be opened', {}) }
                continue
              }
              if (aborted()) return
              unsubscribe = events.subscribe(() => {
                const change = events.getSnapshot().change
                if (change.kind === 'replace' || change.kind === 'settle-assistant'
                  || change.entries.some(entry => entry.type === 'event')) refresh()
              })
            }
            let result: RemoteResult<SessionVideoInventory>
            try { result = await list(sessionId, signal) } catch (error: unknown) {
              result = { ok: false, error: new RemoteError('gateway/internal',
                error instanceof Error ? error.message : 'Session video inventory request failed', {}) }
            }
            if (!aborted()) yield result
          }
        } finally {
          signal.removeEventListener('abort', abort)
          unsubscribe?.()
          held?.release()
          group.delete(refresh)
          if (group.size === 0) readers.delete(sessionId)
          active.delete(finished.promise)
          finished.resolve()
        }
      },
    },
    refresh: (sessionId) => { for (const refresh of readers.get(sessionId) ?? []) refresh() },
    settle: async () => { await Promise.all([...active]) },
  }
}
