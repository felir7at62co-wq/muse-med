/**
 * Per-agent composition baselines, held in module state so the package's
 * invariant companion — a separate build entry point — reads the same records
 * instead of a second copy of the registry.
 *
 * The record set is module state and therefore spans every Cordis runtime in the
 * process, so every read and write is scoped to one runtime root
 * ({@link openRuntime}, `guardState`). A record is owned by the context effect
 * that opened its runtime, so unloading the guard row — including a whole-tree
 * teardown — drops its baselines with it.
 *
 * This module is imported only by the package's own entry points, and its state
 * transition functions are the record's API rather than published surface:
 * `lib/index.js` bundles it, so importing it from `./baseline.ts` inside the
 * package creates no extra published chunk.
 * @module @deepseek-ai/dsh-composition-guard/baseline
 */

import type { Fiber } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'

/** One agent's recorded composition baseline. */
export interface CompositionBaseline {
  /** Tool names the agent's scope resolved when this baseline was recorded, in lexical order. */
  readonly names: readonly string[]
  /** Preset the agent composed then; `undefined` when it had joined none. */
  readonly preset: string | undefined
  /** Baselines this agent has had: `1` for its first, plus one per re-baseline. */
  readonly revision: number
  /**
   * Withdrawn names already announced for the current regression, or `undefined`
   * once the names came back and the announcement re-armed.
   */
  readonly reported: readonly string[] | undefined
}

/** One agent the guard tracks in a runtime. */
export interface GuardedAgent {
  /** The live agent the baseline belongs to. */
  readonly agent: Agent
  /** What the guard last observed for this agent. */
  readonly baseline: CompositionBaseline
  /**
   * Whether the guard adopted this agent rather than observing its creation:
   * it was already live when the guard activated, or a sweep found it live and
   * untracked. An adopted baseline is the guard's first observation, so no
   * earlier observation exists to call a withdrawal a regression.
   */
  readonly adopted: boolean
}

/** The guard's live state in one runtime; the invariant companion's read surface. */
export interface GuardState {
  /** Whether the guard plugin is composed in this runtime and therefore owes coverage. */
  readonly composed: boolean
  /** Every agent the guard holds a baseline for, in the order it started tracking them. */
  readonly tracked: readonly GuardedAgent[]
}

/** Mutable per-agent record owned by one runtime. Package-private: `index.ts` is its only consumer. */
export interface TrackedEntry {
  readonly agent: Agent
  names: readonly string[]
  preset: string | undefined
  revision: number
  reported: readonly string[] | undefined
  readonly adopted: boolean
}

/** One runtime's tracked agents, keyed by the session id the agent is identified by. */
export type TrackedAgents = Map<SessionId, TrackedEntry>

/** This runtime's record plus the exact disposer that removes it. */
export interface RuntimeRecord {
  /** Every agent this runtime tracks. */
  readonly agents: TrackedAgents
  /** Remove this runtime's record; a later record for the same root is left alone. */
  readonly dispose: () => void
}

const runtimes = new Map<Fiber, TrackedAgents>()

/**
 * Reserve one runtime's record, replacing any record already open for the same
 * root. One guard row per runtime is the supported composition; a second
 * instance's baselines would be a second, independent answer to the same
 * question, so the companion reads only the newest.
 * @param root - the runtime root fiber (`ctx.root.fiber` of the guard's context).
 * @returns the runtime's track table and its exact disposer.
 */
export function openRuntime(root: Fiber): RuntimeRecord {
  const agents: TrackedAgents = new Map()
  runtimes.set(root, agents)
  return {
    agents,
    dispose: () => {
      if (runtimes.get(root) === agents) runtimes.delete(root)
    },
  }
}

/**
 * Read the guard's live state in one runtime.
 *
 * The reader is the package's invariant companion, which is a separate build
 * entry point and therefore shares this module state instead of a second copy
 * of the registry. A runtime with no record is one where the guard is not
 * composed — the relation the companion checks is the guard's, so it owes
 * nothing there.
 * @param within - the runtime root fiber to read.
 * @returns whether the guard is composed there and every agent it tracks.
 */
export function guardState(within: Fiber): GuardState {
  const entries = [...runtimes.get(within)?.values() ?? []]
  return {
    composed: runtimes.has(within),
    tracked: entries.map(entry => ({
      agent: entry.agent,
      adopted: entry.adopted,
      baseline: {
        names: [...entry.names],
        preset: entry.preset,
        revision: entry.revision,
        reported: entry.reported === undefined ? undefined : [...entry.reported],
      },
    })),
  }
}

/**
 * One agent's record in a runtime.
 * @param agents - the runtime's track table.
 * @param agent - the agent to look up.
 * @returns its record, or `undefined` when that runtime tracks none for it. Keyed
 *   by session id alone: the agent registry holds at most one live agent per id
 *   and announces every removal, so a record can never outlive its agent or be
 *   inherited by a replacement.
 */
export function trackedEntry(agents: TrackedAgents, agent: Agent): TrackedEntry | undefined {
  return agents.get(agent.id)
}

/**
 * Record one agent's first baseline.
 * @param agents - the runtime's track table.
 * @param agent - the agent to track.
 * @param names - tool names its scope resolves now, in lexical order.
 * @param preset - the preset it composes now.
 * @param adopted - whether the guard adopted a pre-existing agent instead of observing its creation.
 */
export function track(
  agents: TrackedAgents,
  agent: Agent,
  names: readonly string[],
  preset: string | undefined,
  adopted: boolean,
): void {
  agents.set(agent.id, { agent, names, preset, revision: 1, reported: undefined, adopted })
}

/**
 * Replace one agent's baseline after a legitimate re-composition, clearing any
 * announcement so a later withdrawal under the new composition is reported.
 * @param entry - the record to re-baseline.
 * @param names - tool names its scope resolves under the new composition.
 * @param preset - the preset it now composes.
 */
export function rebaseline(entry: TrackedEntry, names: readonly string[], preset: string | undefined): void {
  entry.names = names
  entry.preset = preset
  entry.revision += 1
  entry.reported = undefined
}

/**
 * Record the withdrawn names whose announcement succeeded.
 * @param entry - the record whose regression was delivered.
 * @param missing - the withdrawn names a channel accepted.
 */
export function markReported(entry: TrackedEntry, missing: readonly string[]): void {
  entry.reported = missing
}

/**
 * Re-arm the announcement: the names came back, so a later regression is news again.
 * @param entry - the record whose composition is whole again.
 */
export function rearm(entry: TrackedEntry): void {
  entry.reported = undefined
}
