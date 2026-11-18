/** Install the optional production library, settings and project browser beside the local Router conversation. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-session-coordinator/remote'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { brandString } from '@deepseek-ai/dsh-brand'
import type {} from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { StudioLibraryQuery } from '@deepseek-ai/dsh-jingliu-connection/types'
import remote from '@deepseek-ai/dsh-jingliu-connection/remote'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { Assets, CreditEntry, Environment, ProjectEntry, Projects, ProductionSettings, type ProductionActions } from './Production.tsx'

const panel = 'jingliu-projects' as MainPanelId

/**
 * Mount the production catalog, environment and settings in the local client.
 * @param ctx - Client shell and authenticated remote namespaces.
 */
export function installNative(ctx: Context): void {
  ctx.inject(['remote', 'layout', 'resources', 'uiWorkspace', 'sessions', 'conversation', 'workspaces'], async (scope) => {
    const unmount = await scope.remote.$mount(remote)
    scope.effect(() => unmount, 'jingliu: studio remote')
    scope.inject(['remote.jingliuConnection'], (host) => {
      const epoch = createSnapshotStore(0)
      const reset = () => epoch.set(epoch.getSnapshot() + 1)
      host.effect(() => host.remote.$on('muse-account/session-changed', reset), 'jingliu: signed-in library')
      host.on('connection/reset', reset)
      const api = host.remote.jingliuConnection
      host.effect(() => host.resources.register<'jingliu-projects'>({ protocol: 'jingliu-projects',
        async *open(_address, { signal }) { yield await api.listProjects(signal) } }))
      host.effect(() => host.resources.register<'jingliu-credit'>({ protocol: 'jingliu-credit',
        async *open(_address, { signal }) { yield await api.balance(signal) } }))
      host.effect(() => host.resources.register<'jingliu-library'>({ protocol: 'jingliu-library',
        async *open(address, { signal }) {
          const p = new URL(address).searchParams
          const k = p.get('kind')
          const kind: StudioLibraryQuery['kind'] = k === 'character' || k === 'location' || k === 'prop' ? k : 'all'
          yield await api.sharedAssets({ kind, query: p.get('query') ?? '', offset: Number(p.get('offset') ?? 0) }, signal)
        } }))
      host.effect(() => host.resources.register<'jingliu-options'>({ protocol: 'jingliu-options',
        async *open(address, { signal }) { yield await api.projectOptions(new URL(address).searchParams.get('id') ?? '', signal) } }))
      host.effect(() => host.resources.register<'jingliu-prefs'>({ protocol: 'jingliu-prefs',
        async *open(address, { signal }) { yield await api.preferences(new URL(address).searchParams.get('id') ?? '', signal) } }))
      host.effect(() => host.resources.register<'jingliu-image'>({ protocol: 'jingliu-image',
        async *open(address, { signal }) { yield await api.thumbnail(new URL(address).searchParams.get('path') ?? '', signal) } }))
      host.effect(() => host.resources.register<'jingliu-selected'>({ protocol: 'jingliu-selected',
        async *open(address, { signal }) {
          const id = brandString<SessionId>(new URL(address).searchParams.get('id') ?? '')
          for await (const value of api.watchProject(id, signal)) yield { ok: true, value }
        } }))
      let target: SessionId | undefined
      const locale = 'jingliuStudio'
      const t = host.locale.bind(locale)
      const actions: ProductionActions = {
        hooks: { accountEpoch: epoch, workspaceList: host.workspaces.list },
        openProjects: (id) => {
          const list = host.sessions.list.getSnapshot()
          target = id ?? list.ids.find(key => !!list.byId[key]?.retainedBy.mainView)
          host.layout.selectPanel(panel)
        },
        addWorkspace: async (path) => {
          const workspace = await host.workspaces.create({ path })
          await host.uiWorkspace.openWorkspace(workspace.workspaceId)
        },
        openProject: async (project) => {
          const signal = host.layout.beginNavigation()
          const signedIn = epoch.getSnapshot()
          let id = target
          if (!id) {
            const main = await host.remote.sessionCoordinator.openMain()
            if (!main.ok) throw main.error
            id = main.value
          }
          signal.throwIfAborted()
          if (epoch.getSnapshot() !== signedIn) throw new Error('Studio account changed')
          const selection = await api.selectProject(id, project.id, signal)
          if (!selection.ok) throw selection.error
          signal.throwIfAborted()
          if (epoch.getSnapshot() === signedIn) host.uiWorkspace.openSession(id)
        },
        saveOption: async (id, key, value) => {
          const result = await api.saveOption(id, key, value)
          if (!result.ok) throw result.error
        },
        savePreferences: async (value) => {
          const result = await api.savePreferences(value)
          if (!result.ok) throw result.error
          if (result.value.hidePromptChips !== value.hidePromptChips) throw new Error('Studio preference was not saved')
        },
      }
      const inject = () => actions
      host.slots.inject('sidebar.right.environment', () => host.slots.register({ name: 'sidebar.right.environment', locale, inject,
        children: { 'workspace.environment.directoryFlow': { kind: 'single', scope: 'root' } } }, Environment))
      host.slots.inject('main', () => host.slots.register({ name: 'main', key: panel, locale, inject }, Projects))
      host.slots.inject('sidebar.workspaces.entry', () => host.slots.register({ name: 'sidebar.workspaces.entry', id: 'jingliu-projects', order: 30, locale, inject }, ProjectEntry))
      host.slots.inject('character-library.shared', () => host.slots.register({ name: 'character-library.shared', locale, inject }, Assets))
      host.slots.inject('settings.section', () => host.slots.register({ name: 'settings.section', id: 'jingliu', order: 24, locale, label: () => t('studioSettings'), inject }, ProductionSettings))
      host.slots.inject('sidebar.footer.action', () => host.slots.register({ name: 'sidebar.footer.action', id: 'jingliu-credit', order: 30, locale, inject }, CreditEntry))
    })
  })
}
