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
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import remote from '@deepseek-ai/dsh-session-coordinator/remote'
import { MainEntry } from './MainEntry.tsx'
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
export const inject = ['slots', 'locale', 'remote', 'resources', 'uiWorkspace']

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
      inject: () => ({ openMain: async (): Promise<void> => {
        const result = await scope.remote.sessionCoordinator.openMain()
        if (result.ok) scope.uiWorkspace.openSession(result.value)
        else showNotice('failedMain', false)
      } }),
    }, MainEntry))
    scope.slots.inject('conversation.content.overlay', () => scope.slots.register({
      name: 'conversation.content.overlay', id: 'muse-coordination', locale: NS, order: -10, inject: () => actions,
    }, TaskCards))
  })
  try { await fiber.await() } catch (error) { await fiber.dispose(); await disposeRemote(); throw error }
  return async () => { await fiber.dispose(); await disposeRemote() }
}
