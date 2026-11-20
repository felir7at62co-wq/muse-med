/** Install the optional production library, settings and project browser beside the local conversation. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { brandString } from '@deepseek-ai/dsh-brand'
import type {} from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { StudioLibraryQuery } from '@deepseek-ai/dsh-jingliu-connection/types'
import remote from '@deepseek-ai/dsh-jingliu-connection/remote'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { Assets, CreditEntry, Environment, ProductionSettings, type ProductionActions } from './Production.tsx'
import { DrawerLibrary } from './DrawerLibrary.tsx'
import { DrawerJingliu } from './DrawerJingliu.tsx'
import { DrawerData } from './DrawerData.tsx'
import { DrawerScripts } from './DrawerScripts.tsx'
import type {} from '@deepseek-ai/dsh-muse-account/remote'
import type { MuseDataPlatform, MuseDataStockRequest } from '@deepseek-ai/dsh-muse-account/types'
import workshopRemote from '@deepseek-ai/dsh-workbench-connection/remote'
import type { ScriptStatus } from '@deepseek-ai/dsh-workbench-connection/types'


/**
 * One read for a resource frame. A read the resource registry stopped (its view went
 * away) ends without a frame; only a live read's failure surfaces.
 * @param signal - The registry's signal for this read.
 * @param read - The Remote call.
 * @returns The read's single frame, or none once stopped.
 */
async function* once<T>(signal: AbortSignal, read: () => Promise<T>): AsyncGenerator<T> {
  try {
    yield await read()
  } catch (error) {
    if (!signal.aborted) throw error
  }
}

/**
 * The value of a settled Remote call.
 * @param result - The call.
 * @returns Its value; a failed call throws its error.
 */
async function settled<T>(result: Promise<{ ok: true; value: T } | { ok: false; error: unknown }>): Promise<T> {
  const outcome = await result
  if (!outcome.ok) throw outcome.error
  return outcome.value
}

/**
 * One query parameter of a resource address.
 * @param address - The resource address.
 * @param name - Parameter name.
 * @returns Its value, or '' when absent.
 */
function param(address: string, name: string): string {
  return new URL(address).searchParams.get(name) ?? ''
}

/**
 * Mount the production catalog, environment and settings in the local client.
 * @param ctx - Client shell and authenticated remote namespaces.
 */
export function installNative(ctx: Context): void {
  const epoch = createSnapshotStore(0)
  ctx.slots.inject('character-library.shared', () => ctx.slots.register({
    name: 'character-library.shared', locale: 'jingliuStudio', inject: () => ({ hooks: { accountEpoch: epoch } }),
  }, Assets))
  // The Bot team's details drawer shows the same library in its asset tab.
  ctx.slots.inject('bot.drawer.assets', () => ctx.slots.register({
    name: 'bot.drawer.assets', locale: 'jingliuStudio', inject: () => ({ hooks: { accountEpoch: epoch } }),
  }, DrawerLibrary))
  // The data tab reads the data station as the signed-in member through the account Host.
  // `remote` is named too: the callback reads the namespace through `host.remote`, and the Client's Remote service
  // is not readable in a scope that did not name it (the tab then never registers, with no error on the console).
  ctx.inject(['remote', 'remote.museAccount', 'resources'], (host) => {
    const api = host.remote.museAccount
    const reset = () => { epoch.set(epoch.getSnapshot() + 1) }
    host.effect(() => host.remote.$on('muse-account/session-changed', reset), 'data: signed-in station')
    const platformOf = (address: string): MuseDataPlatform => {
      const platform = param(address, 'platform')
      if (platform === 'hongguo' || platform === 'lvpaopao' || platform === 'douyin' || platform === 'fanqie' || platform === 'qimao') return platform
      throw new Error('Unknown data platform')
    }
    const filterOf = (address: string): MuseDataStockRequest['filter'] => {
      const filter = param(address, 'filter')
      return filter === 'script' || filter === 'active' || filter === 'queued' || filter === 'failed' || filter === 'rejected' ? filter : 'all'
    }
    host.effect(() => host.resources.register<'muse-data-boards'>({ protocol: 'muse-data-boards',
      open: (address, { signal }) => once(signal, () => api.dataBoards(platformOf(address))) }))
    host.effect(() => host.resources.register<'muse-data-period'>({ protocol: 'muse-data-period',
      open: (address, { signal }) => once(signal, () => {
        const period = param(address, 'period')
        return api.dataPeriod({ platform: platformOf(address), board: param(address, 'board'), period: period === 'day' || period === 'month' ? period : 'week' })
      }) }))
    host.effect(() => host.resources.register<'muse-data-stock'>({ protocol: 'muse-data-stock',
      open: (address, { signal }) => once(signal, () => api.dataStock({
        filter: filterOf(address), q: param(address, 'q'), page: Math.max(1, Number(param(address, 'page')) || 1), limit: Math.min(100, Math.max(1, Number(param(address, 'limit')) || 50)),
      })) }))
    host.effect(() => host.resources.register<'muse-data-collector'>({ protocol: 'muse-data-collector',
      open: (_address, { signal }) => once(signal, () => api.dataCollector()) }))
    // A finalized script's original novel or drama, as the 剧本 tab shows it.
    host.effect(() => host.resources.register<'muse-data-work'>({ protocol: 'muse-data-work',
      open: (address, { signal }) => once(signal, () => api.dataWork(param(address, 'id'))) }))
    // The whole collection (全收录) of one platform, or a search of it.
    host.effect(() => host.resources.register<'muse-data-works'>({ protocol: 'muse-data-works',
      open: (address, { signal }) => once(signal, () => api.dataWorks({
        platform: platformOf(address), q: param(address, 'q'), page: Math.max(1, Number(param(address, 'page')) || 1), limit: Math.min(100, Math.max(1, Number(param(address, 'limit')) || 20)),
      })) }))
    const rush = async (workId: string): Promise<void> => { await settled(api.dataRush(workId)) }
    host.slots.inject('bot.drawer.data', () => host.slots.register({
      name: 'bot.drawer.data', locale: 'jingliuStudio', inject: () => ({ hooks: { accountEpoch: epoch }, rush }),
    }, DrawerData))
  })
  // The 剧本 tab reads Script Workshop's finalized-script library as the signed-in member.
  ctx.inject(['remote', 'resources'], async (scope) => {
    const unmount = await scope.remote.$mount(workshopRemote)
    scope.effect(() => unmount, 'workshop: script library remote')
    scope.inject(['remote', 'remote.workshopConnection'], (host) => {
      const api = host.remote.workshopConnection
      const statusOf = (address: string): ScriptStatus | undefined => {
        const status = param(address, 'status')
        return status === 'waiting' || status === 'picked' || status === 'in_production' ? status : undefined
      }
      host.effect(() => host.resources.register<'workshop-scripts'>({ protocol: 'workshop-scripts',
        open: (address, { signal }) => once(signal, () => {
          const status = statusOf(address)
          return api.scripts({
            ...(status === undefined ? {} : { status }), q: param(address, 'q'), mine: param(address, 'mine') === '1',
            page: Math.max(1, Number(param(address, 'page')) || 1), limit: Math.min(100, Math.max(1, Number(param(address, 'limit')) || 50)),
          })
        }) }))
      host.effect(() => host.resources.register<'workshop-script'>({ protocol: 'workshop-script',
        open: (address, { signal }) => once(signal, () => {
          const version = Number(param(address, 'version'))
          return api.script({ id: Number(param(address, 'id')), ...(Number.isSafeInteger(version) && version > 0 ? { version } : {}) })
        }) }))
      const inject = () => ({
        hooks: { accountEpoch: epoch },
        pick: async (request: { id: number; version: number }) => { await settled(api.pickScript(request)) },
        link: async (request: { id: number; projectId: string; projectTitle: string }) => { await settled(api.scriptProduction(request)) },
      })
      host.slots.inject('bot.drawer.scripts', () => host.slots.register({ name: 'bot.drawer.scripts', locale: 'jingliuStudio', inject }, DrawerScripts))
    })
  })
  ctx.inject(['remote', 'layout', 'resources', 'uiWorkspace', 'sessions', 'conversation', 'workspaces'], async (scope) => {
    const unmount = await scope.remote.$mount(remote)
    scope.effect(() => unmount, 'jingliu: studio remote')
    scope.inject(['remote.jingliuConnection'], (host) => {
      const reset = () => { epoch.set(epoch.getSnapshot() + 1) }
      host.effect(() => host.remote.$on('muse-account/session-changed', reset), 'jingliu: signed-in library')
      host.on('connection/reset', reset)
      const api = host.remote.jingliuConnection
      host.effect(() => host.resources.register<'jingliu-projects'>({ protocol: 'jingliu-projects',
        open: (_address, { signal }) => once(signal, () => api.listProjects(signal)) }))
      host.effect(() => host.resources.register<'jingliu-credit'>({ protocol: 'jingliu-credit',
        open: (_address, { signal }) => once(signal, () => api.balance(signal)) }))
      host.effect(() => host.resources.register<'jingliu-library'>({ protocol: 'jingliu-library',
        async *open(address, { signal }) {
          const p = new URL(address).searchParams
          const k = p.get('kind')
          const kind: StudioLibraryQuery['kind'] = k === 'character' || k === 'location' || k === 'prop' ? k : 'all'
          yield* once(signal, () => api.sharedAssets({ kind, query: p.get('query') ?? '', offset: Number(p.get('offset') ?? 0) }, signal))
        } }))
      host.effect(() => host.resources.register<'jingliu-options'>({ protocol: 'jingliu-options',
        open: (address, { signal }) => once(signal, () => api.projectOptions(new URL(address).searchParams.get('id') ?? '', signal)) }))
      host.effect(() => host.resources.register<'jingliu-prefs'>({ protocol: 'jingliu-prefs',
        open: (address, { signal }) => once(signal, () => api.preferences(new URL(address).searchParams.get('id') ?? '', signal)) }))
      host.effect(() => host.resources.register<'jingliu-image'>({ protocol: 'jingliu-image',
        open: (address, { signal }) => once(signal, () => api.thumbnail(new URL(address).searchParams.get('path') ?? '', signal)) }))
      host.effect(() => host.resources.register<'jingliu-config'>({ protocol: 'jingliu-config',
        open: (address, { signal }) => once(signal, () => api.projectConfig(param(address, 'id'), signal)) }))
      host.effect(() => host.resources.register<'jingliu-episodes'>({ protocol: 'jingliu-episodes',
        open: (address, { signal }) => once(signal, () => api.episodeList(param(address, 'id'), signal)) }))
      host.effect(() => host.resources.register<'jingliu-shots'>({ protocol: 'jingliu-shots',
        open: (address, { signal }) => once(signal, () => api.episodeShots(param(address, 'id'), Number(param(address, 'episode')), signal)) }))
      host.effect(() => host.resources.register<'jingliu-shot-media'>({ protocol: 'jingliu-shot-media',
        open: (address, { signal }) => once(signal, () => api.shotMedia(param(address, 'id'), param(address, 'shot'), signal)) }))
      host.effect(() => host.resources.register<'jingliu-catalog'>({ protocol: 'jingliu-catalog',
        open: (_address, { signal }) => once(signal, () => api.catalog(signal)) }))
      host.effect(() => host.resources.register<'jingliu-project-assets'>({ protocol: 'jingliu-project-assets',
        open: (address, { signal }) => once(signal, () => api.projectAssets(param(address, 'id'), signal)) }))
      host.effect(() => host.resources.register<'jingliu-selected'>({ protocol: 'jingliu-selected',
        async *open(address, { signal }) {
          const id = brandString<SessionId>(new URL(address).searchParams.get('id') ?? '')
          try {
            for await (const value of api.watchProject(id, signal)) yield { ok: true, value }
          } catch (error) {
            // A watch the registry stopped ends quietly; a live watch's failure surfaces.
            if (!signal.aborted) throw error
          }
        } }))
      const locale = 'jingliuStudio'
      const t = host.locale.bind(locale)
      const actions: ProductionActions = {
        hooks: { accountEpoch: epoch, workspaceList: host.workspaces.list },
        addWorkspace: async (path) => {
          const workspace = await host.workspaces.create({ path })
          await host.uiWorkspace.openWorkspace(workspace.workspaceId)
        },
        chooseProject: async (sessionId, project) => {
          const signedIn = epoch.getSnapshot()
          const selection = await api.selectProject(sessionId, project.id, new AbortController().signal)
          if (!selection.ok) throw selection.error
          if (epoch.getSnapshot() !== signedIn) throw new Error('Studio account changed')
        },
        createProject: async (sessionId, input) => {
          const signedIn = epoch.getSnapshot()
          const created = await api.createProject(input, new AbortController().signal)
          if (!created.ok) throw created.error
          if (epoch.getSnapshot() !== signedIn) throw new Error('Studio account changed')
          // The new production becomes the one this conversation works on.
          const selection = await api.selectProject(sessionId, created.value.id, new AbortController().signal)
          if (!selection.ok) throw selection.error
          return created.value
        },
        renameProject: async (projectId, title) => {
          const result = await api.renameProject(projectId, title, new AbortController().signal)
          if (!result.ok) throw result.error
        },
        deleteShot: async (projectId, shotId) => {
          const result = await api.deleteShot(projectId, shotId, new AbortController().signal)
          if (!result.ok) throw result.error
        },
        loadVideo: async (path, signal) => {
          let type = ''
          const parts: Uint8Array<ArrayBuffer>[] = []
          for await (const chunk of api.video(path, signal)) {
            if (!type) { type = chunk; continue }
            const binary = atob(chunk)
            const bytes = new Uint8Array(new ArrayBuffer(binary.length))
            for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
            parts.push(bytes)
          }
          if (!type) throw new Error('Studio video was empty')
          return URL.createObjectURL(new Blob(parts, { type }))
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
      host.slots.inject('bot.drawer.jingliu', () => host.slots.register({ name: 'bot.drawer.jingliu', locale, inject }, DrawerJingliu))
      host.slots.inject('settings.section', () => host.slots.register({ name: 'settings.section', id: 'jingliu', order: 24, locale, label: () => t('studioSettings'), inject }, ProductionSettings))
      host.slots.inject('sidebar.footer.action', () => host.slots.register({ name: 'sidebar.footer.action', id: 'jingliu-credit', order: 30, locale, inject }, CreditEntry))
    })
  })
}
