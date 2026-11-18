/** Left-navigation entry and resource-backed, read-only character library page. */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-resources/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { CharacterLibraryBrowseResult, CharacterLibraryImage, CharacterLibraryStatus } from '@deepseek-ai/dsh-api-character-library/types'
import remote from '@deepseek-ai/dsh-api-character-library/remote'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { IconUsersOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { createElement } from 'react'
import { LibraryShell, type LibraryShellInjected } from './LibraryShell.tsx'
import { de, en, es, fr, ja, pt, ru, zh, type CharacterLibraryKey } from './locales.ts'
import { SETTINGS_NAMESPACE, syncIntervalField } from '../sync-settings.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'character-library.shared': { kind: 'single'; scope: 'root'; owner: Record<never, never> }
  }
  interface LocaleNamespaceMap { characterLibrary: CharacterLibraryKey }
  interface ResourceProtocolMap {
    'character-library-status': CharacterLibraryStatus
    'character-library-catalog': CharacterLibraryBrowseResult
    'character-library-image': CharacterLibraryImage
  }
}

const NS = 'characterLibrary'
const PANEL = 'character-library' as MainPanelId

/** Browser catalog synchronization settings. */
export interface Config {
  /** Delay between a completed catalog read and the next read, in milliseconds. */
  readonly syncIntervalMs: number
}

/** Validated synchronization delay for each subscribed catalog resource. */
export const Config: z<Config> = z.object({
  syncIntervalMs: syncIntervalField,
})

function waitForSync(readDelay: () => number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(finish, readDelay())
    signal.addEventListener('abort', finish, { once: true })
    function finish(): void {
      clearTimeout(timer)
      signal.removeEventListener('abort', finish)
      resolve()
    }
  })
}

function LibraryIcon({ size }: PropsRuntime<'sidebar.panellist'>) {
  return createElement(IconUsersOutlineRegular, { size })
}

/** Browser services needed by the character library contribution. */
export const inject = ['slots', 'locale', 'remote', 'resources', 'configForms']

/**
 * Register read-only resource providers and their left-navigation panel.
 * @param ctx - Browser services used by this independent feature.
 * @returns Disposer for the generated Remote namespace and UI registrations.
 */
export async function apply(ctx: Context): Promise<() => Promise<void>> {
  const form = ctx.configForms.get<Config>(SETTINGS_NAMESPACE)
  const readDelay = (): number => {
    const value = form.getSnapshot().value
    if (value === undefined) throw new Error('character-library: synchronization settings are unavailable')
    return Config(value).syncIntervalMs
  }
  const disposeRemote = await ctx.remote.$mount(remote)
  const section = ctx.inject(['slots', 'locale', 'resources', 'remote.characterLibraryBrowser'], (scope) => {
    scope.effect(() => scope.locale.register(NS, { zh, en, ja, es, fr, de, ru, pt }), 'character-library: dictionaries')
    scope.effect(() => scope.resources.register<'character-library-status'>({
      protocol: 'character-library-status',
      async *open() { yield await scope.remote.characterLibraryBrowser.status() },
    }), 'character-library: status resource')
    scope.effect(() => scope.resources.register<'character-library-catalog'>({
      protocol: 'character-library-catalog',
      async *open(address, { signal }) {
        const params = new URL(address).searchParams
        const collection = params.get('collection')
        const cursor = params.get('cursor')
        const query = params.get('query')
        try {
          await scope.configForms.describe().ensure()
          while (!signal.aborted) {
            readDelay()
            const frame = await scope.remote.characterLibraryBrowser.browse({
              collection: collection === 'ancient' || collection === 'urban' ? collection : 'all',
              limit: 12,
              ...(query == null || query === '' ? {} : { query }),
              ...(cursor === null ? {} : { cursor }),
            }, signal)
            yield frame
            await waitForSync(readDelay, signal)
          }
        } catch (error) {
          if (!signal.aborted) yield {
            ok: false,
            error: new RemoteError('gateway/internal', 'Character library synchronization could not continue', {}, { cause: error }),
          }
        }
      },
    }), 'character-library: catalog resource')
    scope.effect(() => scope.resources.register<'character-library-image'>({
      protocol: 'character-library-image',
      async *open(address, { signal }) {
        const catalogAssetId = decodeURIComponent(new URL(address).pathname.slice(1))
        yield await scope.remote.characterLibraryBrowser.preview({ catalogAssetId }, signal)
      },
    }), 'character-library: image resource')
    const t = scope.locale.bind(NS)
    scope.slots.inject('main', () => scope.slots.register({ name: 'main', key: PANEL, locale: NS,
      children: { 'character-library.shared': { kind: 'single', scope: 'root' } },
      inject: (): LibraryShellInjected => ({ hooks: { sharedLibrary: {
        getSnapshot: () => scope.slots.entries('character-library.shared').length > 0,
        subscribe: listener => scope.slots.subscribe('character-library.shared', listener),
      } } }),
    }, LibraryShell))
    scope.slots.inject('sidebar.panellist', () => {
      const hasShared = () => scope.slots.entries('character-library.shared').length > 0
      let shared = hasShared()
      const register = () => scope.slots.register({ name: 'sidebar.panellist', id: PANEL, order: 21, locale: NS,
        label: () => t(shared ? 'assetLibrary' : 'title') }, LibraryIcon)
      let remove = register()
      const unsubscribe = scope.slots.subscribe('character-library.shared', () => {
        if (hasShared() === shared) return
        shared = hasShared()
        remove()
        remove = register()
      })
      return () => { unsubscribe(); remove() }
    })
  })
  try { await section }
  catch (error) { await section.dispose(); await disposeRemote(); throw error }
  return async () => { await section.dispose(); await disposeRemote() }
}
