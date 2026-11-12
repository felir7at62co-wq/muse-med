/** Reversible task resource, overlay and owner-only Remote registrations. */
import { RemoteError, remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { TaskToast, type TaskNotice, type TaskToastInjected } from './TaskToast.tsx'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type { CoordinationTask } from '@deepseek-ai/dsh-session-coordinator/types'
import type { ResourceProvider } from '@deepseek-ai/dsh-client-resources/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-api-remote-access/client'
import remote from '@deepseek-ai/dsh-session-coordinator/remote'
import { MainEntry } from './MainEntry.tsx'
import { openRetainedMain } from './open-main.ts'
import { followInitialMain } from './initial-main.ts'
import { TaskCards, type TaskActions } from './TaskCards.tsx'
import { NS, zh, en, type CoordinationKey } from './locales.ts'

export type { TaskActions, TaskCardsProps } from './TaskCards.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface ResourceProtocolMap {
    /** Owner-only task records streamed by the coordinator service. */
    'muse-tasks': CoordinationTask[]
  }
}

/** Browser prerequisites before mounting the generated coordinator Remote. */
export const inject = ['slots', 'locale', 'remote', 'resources', 'uiWorkspace', 'remoteAccess', 'conversation']

/**
 * Mount the task cards; disabling the plugin releases subscriptions and removes its overlay.
 * @param ctx - Browser feature context.
 * @returns disposer for Remote bindings and all child registrations.
 */
export async function apply(ctx: Context): Promise<() => Promise<void>> {
  const disposeRemote = await ctx.remote.$mount(remote)
  const fiber = ctx.inject(['remote.sessionCoordinator', 'remote.session'], (scope) => {
    scope.effect(() => scope.locale.register(NS, { zh, en, ja: en, es: en, fr: en, de: en, ru: en, pt: en }), 'coordination: dictionaries')
    const lifetime = new AbortController()
    scope.effect(() => () => { lifetime.abort() })
    let mainId: SessionId | null = null
    let mainIdKnown = false
    let identityEpoch = 0
    let unhide: (() => void) | undefined
    scope.effect(() => () => { unhide?.(); unhide = undefined })
    const rememberMain = (id: SessionId): void => {
      if (mainId === id) return
      unhide?.()
      mainId = id
      unhide = scope.uiWorkspace.hideSession(id)
    }
    const provider: ResourceProvider<'muse-tasks'> = {
      protocol: 'muse-tasks',
      async *open(address, { signal }) {
        try {
          const id = SessionId(decodeURIComponent(new URL(address).pathname.slice(1)))
          for await (const value of scope.remote.sessionCoordinator.watch(id, signal)) yield { ok: true, value }
        } catch (error) {
          if (!signal.aborted) yield { ok: false, error: remoteErrorOf(error) ?? new RemoteError('gateway/internal', 'Task status is unavailable', {}) }
        }
      },
    }
    scope.effect(() => scope.resources.register(provider), 'coordination: task resources')
    const notice = createSnapshotStore<TaskNotice | null>(null)
    let noticeSeq = 0
    const showNotice = (key: CoordinationKey, success: boolean): void => { notice.set({ seq: ++noticeSeq, key, success }) }
    scope.remoteAccess.whenAccess('sessionCoordinator/openMain', () => followInitialMain(
      lifetime.signal,
      follow => scope.on('connection/reset', follow),
      signal => scope.uiWorkspace.openInitialSession(async (navigation) => {
        const result = await scope.remote.sessionCoordinator.openMain()
        if (navigation.aborted) return undefined
        if (!result.ok) { showNotice('failedMain', false); return undefined }
        identityEpoch++
        rememberMain(result.value)
        mainIdKnown = true
        return result.value
      }, signal),
      (error) => { console.warn('Initial Main Session unavailable:', error); showNotice('failedMain', false) },
    ))
    scope.remoteAccess.whenAccess('sessionCoordinator/watchMain', () => {
      let reader: AbortController | undefined
      const removeFilter = scope.uiWorkspace.registerBlankSessionFilter(id => mainIdKnown && id !== mainId)
      const follow = (): void => {
        reader?.abort()
        reader = new AbortController()
        const signal = AbortSignal.any([reader.signal, lifetime.signal])
        const startingEpoch = identityEpoch
        mainIdKnown = false
        void (async () => {
          try {
            for await (const id of scope.remote.sessionCoordinator.watchMain(signal)) {
              if (signal.aborted) break
              if (id !== null) rememberMain(id)
              else if (startingEpoch === identityEpoch) { unhide?.(); unhide = undefined; mainId = null }
              mainIdKnown = true
            }
          } catch (error) {
            if (!signal.aborted) {
              console.warn('Main Session identity unavailable:', error)
              showNotice('failedMain', false)
            }
          }
        })()
      }
      follow()
      const stopReset = scope.on('connection/reset', follow)
      return () => { stopReset(); reader?.abort(); removeFilter(); unhide?.(); unhide = undefined; mainId = null; mainIdKnown = false }
    })
    scope.slots.inject('shell.overlay', () => scope.slots.register({
      name: 'shell.overlay', id: 'muse-coordination-toast', locale: NS,
      inject: (): TaskToastInjected => ({ hooks: { taskNotice: notice }, dismiss: () => { notice.set(null) } }),
    }, TaskToast))
    const actions: TaskActions = {
      openSession: (id) => { scope.uiWorkspace.openSession(id) },
      async stop(owner, taskId, revision) {
        const result = await scope.remote.sessionCoordinator.stop(owner, taskId, revision)
        showNotice(result.ok ? 'stopRequested' : 'failedStop', result.ok)
      },
      async openFile(path) {
        const result = await scope.remote.session.openWorkspacePath({ path }, lifetime.signal)
        if (!result.ok) showNotice('failedOpen', false)
      },
    }
    scope.slots.inject('sidebar.session.entry', () => scope.slots.register({
      name: 'sidebar.session.entry', id: 'muse-main-session', locale: NS,
      inject: () => ({ openMain: (): Promise<void> => openRetainedMain(
        lifetime.signal,
        () => scope.remote.sessionCoordinator.openMain(),
        (id) => {
          identityEpoch++
          rememberMain(id)
          mainIdKnown = true
          scope.uiWorkspace.openSession(id)
        },
        () => { showNotice('failedMain', false) },
      ) }),
    }, MainEntry))
    scope.slots.inject('conversation.content.overlay', () => scope.slots.register({
      name: 'conversation.content.overlay', id: 'muse-coordination', locale: NS, order: -10, inject: () => actions,
    }, TaskCards))
  })
  try { await fiber.await() } catch (error) { await fiber.dispose(); await disposeRemote(); throw error }
  return async () => { await fiber.dispose(); await disposeRemote() }
}
