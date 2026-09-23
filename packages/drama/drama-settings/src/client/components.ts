/**
 * The packages the short-drama pipeline is composed from, and the fold that
 * turns one read-only plugin-inventory answer into what the page shows for each.
 *
 * The composition list is a static fact: which packages a short-drama session is
 * built from, in pipeline order, including the BGM mood matcher, which is an
 * independent plugin rather than part of the drama packages. The status is the
 * only runtime fact here, and it comes from the read-only `pluginInventory`
 * namespace — a deployment that composes no inventory yields
 * {@link UNQUERIED}, which the page renders as "could not be queried" instead of
 * as a package that is loaded.
 */

import type { PluginInventorySnapshot } from '@deepseek-ai/dsh-api-remotes/client'
import type { DramaLocaleKey } from './locales.ts'

/** One package the short-drama pipeline is composed from. */
export interface DramaComponent {
  /** Module specifier the Loader composes. */
  readonly pkg: string
  /** Locale key of this package's one-line role. */
  readonly role: DramaLocaleKey
}

/** The composition, in pipeline order. */
export const DRAMA_COMPONENTS: readonly DramaComponent[] = [
  { pkg: '@deepseek-ai/dsh-guard-drama', role: 'component.guard.role' },
  { pkg: '@deepseek-ai/dsh-tool-drama-assets', role: 'component.assets.role' },
  { pkg: '@deepseek-ai/dsh-tool-shot-script', role: 'component.shot.role' },
  { pkg: '@deepseek-ai/dsh-perception-bgm', role: 'component.bgm.role' },
  { pkg: '@deepseek-ai/dsh-tool-bgm-compose', role: 'component.bgmCompose.role' },
  { pkg: '@deepseek-ai/dsh-tool-episode-render', role: 'component.render.role' },
]

/** What the last inventory read says about one component. */
export type DramaComponentStatus =
  /** Listed with a live, active root fiber. */
  | 'loaded'
  /** Listed and enabled, with its fiber still coming up. */
  | 'starting'
  /** Listed with a failed fiber. */
  | 'failed'
  /** Declared with a load condition only a Loader context can decide. */
  | 'conditional'
  /** Listed but disabled, unloading, or holding no live fiber. */
  | 'inactive'
  /** The inventory answered and names no row for this package. */
  | 'absent'
  /** No inventory to read, or the read failed. */
  | 'unknown'

/** One component with the state the inventory reported for it. */
export interface DramaComponentState {
  /** The composed package. */
  readonly component: DramaComponent
  /** What the last read established about it. */
  readonly status: DramaComponentStatus
  /** The row's own load condition, when it declares one. */
  readonly condition?: string
}

/** The one Loader/preset row shape this fold reads. */
interface InventoryRow {
  readonly enabled: boolean | 'conditional'
  readonly fiberPhase: 'pending' | 'loading' | 'active' | 'failed' | 'unloading' | null
  readonly condition?: string
}

/**
 * Fold one row into the status the page shows.
 *
 * A disabled row is inactive whatever its fiber says, and a conditional row
 * stays conditional: the Loader decides that condition, so this page cannot
 * report it as either loaded or absent.
 * @param row - one preset or Loader row.
 * @returns the status for that row.
 */
function statusOf(row: InventoryRow): DramaComponentStatus {
  if (row.enabled === false) return 'inactive'
  if (row.enabled === 'conditional') return 'conditional'
  switch (row.fiberPhase) {
    case 'active': return 'loaded'
    case 'pending':
    case 'loading': return 'starting'
    case 'failed': return 'failed'
    case 'unloading':
    case null: return 'inactive'
  }
}

/**
 * The state of every composed component.
 *
 * A mounted row answers for its package: presets and the host Loader can both
 * compose one package, and a row with no fiber phase — a preset nothing
 * composed — would otherwise report a loaded package as inactive. Between two
 * mounted rows the first wins, because the short-drama session is composed by
 * the preset and its row is what decides whether that session gets the package.
 * An absent snapshot means no inventory was read, which is not the same as an
 * inventory that answered without naming a package.
 * @param snapshot - the last inventory answer, or undefined when none was read.
 * @returns one entry per composed package, in composition order.
 */
export function componentStates(snapshot: PluginInventorySnapshot | undefined): DramaComponentState[] {
  const rows = new Map<string, InventoryRow>()
  const keep = (moduleName: string, row: InventoryRow): void => {
    const kept = rows.get(moduleName)
    // A row carrying a fiber phase is the composition that is actually mounted,
    // so it answers for the package even when another row named that package
    // first: presets and the host Loader can both compose one package, and only
    // a mounted row says whether a session has it.
    if (kept === undefined || (kept.fiberPhase === null && row.fiberPhase !== null)) {
      rows.set(moduleName, row)
    }
  }
  for (const preset of snapshot?.agentPresets ?? []) {
    for (const row of preset.rows) keep(row.moduleName, row)
  }
  for (const entry of snapshot?.entries ?? []) keep(entry.moduleName, entry)
  return DRAMA_COMPONENTS.map((component) => {
    const row = rows.get(component.pkg)
    if (row === undefined) {
      return { component, status: snapshot === undefined ? 'unknown' : 'absent' }
    }
    return {
      component,
      status: statusOf(row),
      ...row.condition === undefined ? {} : { condition: row.condition },
    }
  })
}
