/**
 * Short-drama settings, browser half: the Settings page over the `drama` settings
 * namespace the Host half registers.
 *
 * The page registers through `ctx.slots.inject`, which waits for the slot's own
 * declaration — this package does not own the Settings shell — and it leaves with
 * its fiber when the declarer collapses. The per-drama budget is resolved from
 * the same settings namespace and included in save and restore writes.
 *
 * @module @deepseek-ai/dsh-drama-settings/src/client
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: the settings write-operation contract and the browser-safe
// plugin-inventory snapshot types, both re-exported by the Remote assembly.
import type { PluginInventorySnapshot, SettingsPathOpView } from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: the ctx.locale merge (ctx.locale.register / bind).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the SlotRegistry service merge (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: the settings shell's `settings.section` declaration and the
// `ctx.settingsScope` service merge.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import {
  DRAMA_SETTINGS_DEFAULTS, DRAMA_SETTINGS_NAMESPACE, type DramaSettings,
} from '../settings.ts'
import { componentStates, type DramaComponentState } from './components.ts'
import { DramaSettingsSection } from './DramaSettingsSection.tsx'
import type { DramaSettingsSectionInjected } from './DramaSettingsSection.tsx'
import { en, zh, type DramaLocaleKey } from './locales.ts'
import { imageRoutesOf, type DramaImageRoutes, type JubianImageFace } from './routes.ts'
import { defaultOps, draftSection, landed, sectionOps, type DramaWriteOutcome } from './section.ts'

export type { DramaComponent, DramaComponentState, DramaComponentStatus } from './components.ts'
export type { DramaSettingsSectionInjected, DramaSettingsSectionProps } from './DramaSettingsSection.tsx'
export type { DramaLocaleKey } from './locales.ts'
export type {
  DramaImageRoute, DramaImageRoutes, ImageRoutesResult, JubianImageFace,
} from './routes.ts'
export type { DramaSettingsDraft, DramaWriteOutcome } from './section.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Short-drama Settings page copy. */
    'settings.drama': DramaLocaleKey
  }
}

/** Dictionary namespace owned by this plugin. */
export const NS = 'settings.drama'

/** Required services: the slot and locale surfaces plus the settings scope service. */
export const inject = ['slots', 'locale', 'settingsScope']

/**
 * One `pluginInventory.list` answer: the snapshot, or the namespace's refusal.
 * Typed here because the section reads that namespace optionally.
 */
type PluginInventoryRead =
  | { readonly ok: true; readonly value: PluginInventorySnapshot }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }

/** The one Remote method the component list reads. */
interface PluginInventoryFace {
  /** @returns the current Loader and preset inventory. */
  list: () => Promise<PluginInventoryRead>
}

/**
 * Read the composed packages' state from the optional read-only inventory.
 *
 * `remote.pluginInventory` belongs to a deployment that composes the plugin
 * inventory; `ctx.get` is what makes that optional rather than a service this
 * row waits for. With no namespace, or with a failed read, every component is
 * reported unqueryable — the page never infers "loaded" from silence.
 * @param ctx - Client context that may carry the inventory namespace.
 * @returns one state per composed package.
 */
async function componentState(ctx: ClientContext): Promise<DramaComponentState[]> {
  const inventory = ctx.get('remote.pluginInventory') as PluginInventoryFace | undefined
  if (inventory === undefined) return componentStates(undefined)
  try {
    const result = await inventory.list()
    return componentStates(result.ok ? result.value : undefined)
  } catch {
    // A refused or broken read is a fact the page shows, not a crash: the
    // components are still worth naming with an unqueryable status.
    return componentStates(undefined)
  }
}

/**
 * Read the rows the paid asset-image route can buy from.
 *
 * The namespace is looked up per call rather than captured at registration: it
 * belongs to another bundled plugin, which may mount before or after this page,
 * and a page that resolved it once would answer `unavailable` forever on a
 * deployment that composes both.
 * @param ctx - Client context that may carry the Jubian image-route namespace.
 * @returns the payable rows, or why there are none to show.
 */
async function imageRouteState(ctx: ClientContext): Promise<DramaImageRoutes> {
  const face = ctx.get('remote.jubianImage') as JubianImageFace | undefined
  if (face === undefined) return { status: 'unavailable' }
  try {
    return imageRoutesOf(await face.routes())
  } catch (error) {
    // A transport that threw is reported the same way a refusal is: the page
    // shows the reason and keeps whatever row the section already pins.
    return { status: 'failed', message: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Mount the Settings page over the namespace scope.
 * @param ctx - Client context carrying the slot registry, locale, and settings scope.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'drama-settings: dictionaries')
  const t = ctx.locale.bind(NS)
  const scope = ctx.settingsScope.bind<DramaSettings>({ namespace: DRAMA_SETTINGS_NAMESPACE })

  /**
   * Write one section and answer whether it landed.
   *
   * A refusal is not thrown by the settings scope — it recovers the host's
   * current state and settles — so the verdict is read from that state: the
   * snapshot the page renders is also the evidence for what happened.
   * @param ops - the path operations to apply.
   * @param intended - the section those operations ask for.
   * @returns the outcome the page reports.
   */
  const commit = async (
    ops: readonly SettingsPathOpView[],
    intended: DramaSettings,
  ): Promise<DramaWriteOutcome> => {
    await scope.mutate(ops)
    return landed(scope.getSnapshot().value, intended) ? 'saved' : 'rejected'
  }

  const sectionInjected = (): DramaSettingsSectionInjected => ({
    hooks: { drama: scope },
    write: async (draft) => {
      const intended = draftSection(draft)
      if (intended === undefined) return 'invalid'
      return await commit(sectionOps(scope.getSnapshot().value, intended), intended)
    },
    restoreDefaults: async () => await commit(defaultOps(), DRAMA_SETTINGS_DEFAULTS),
    components: async () => await componentState(ctx),
    imageRoutes: async () => await imageRouteState(ctx),
  })

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'drama',
    order: 17,
    label: () => t('nav'),
    locale: NS,
    inject: sectionInjected,
  }, DramaSettingsSection))
}
