/**
 * Composition guard: says out loud when a running session silently loses the
 * tools its composition gave it.
 *
 * DSH's profile patch layer can be live-reloaded (`dsh.profile.patchReload: live`).
 * A host-plane row changed while the host runs can withdraw the tools an
 * already-published agent resolves through its scope chain, and the framework
 * does not re-compose a standing mount in process, so the withdrawal is not
 * repaired — a host restart is the recovery, and re-selecting the preset is
 * refused once the session has taken a turn (`agent-preset/locked`).
 *
 * This plugin cannot repair that; it detects it and says it in plain language,
 * on two channels: one log line naming the session, the preset, and the missing
 * tools, and one plugin-sourced notice inside the affected conversation.
 *
 * A full account of what it can and cannot do lives in the package README and
 * the [Agent Note](../../../../.agents/notes/implemented/architecture/2026-09-17-composition-guard-detects-live-tool-withdrawal.md).
 * @module @deepseek-ai/dsh-composition-guard
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, boundContextSummary } from '@deepseek-ai/dsh-llm'
import { scopeOf } from '@deepseek-ai/dsh-scope'
// Type-only: resolves the `agents` and `tools` services this plugin injects, the
// `agentPresets` service it reads, and the `agent/created` / `agent/disposed`
// events it watches.
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-presets'
import type {} from '@deepseek-ai/dsh-tools'
import {
  guardState, markReported, openRuntime, rearm, rebaseline, track, trackedEntry,
} from './baseline.ts'
import type { RuntimeRecord, TrackedAgents } from './baseline.ts'

export { guardState }
export type { CompositionBaseline, GuardState, GuardedAgent } from './baseline.ts'

/** Cordis plugin name used by loader diagnostics and as the notice's `source.plugin`. */
export const name = 'composition-guard'

/**
 * Hard dependencies. `tools` is where a scope's visible names are read and
 * `agents` is the live-agent registry the guard enumerates; without either the
 * guard has nothing to compare. The preset roster is deliberately NOT here: a
 * rosterless deployment — every agent composing no preset — is a supported
 * composition for this guard, so `apply` reads `agentPresets` with `ctx.get` and
 * keeps working when no roster is mounted.
 */
export const inject = ['agents', 'tools']

/** Plugin config, validated by the same-named schemastery schema plus the load-time checks in `apply`. */
export interface Config {
  /**
   * Whether the affected session also receives the notice in its own
   * conversation (default `true`). The log line is always written; this governs
   * only the model-visible message, for a deployment that wants the guard's
   * record without writing into a conversation.
   */
  announceInSession?: boolean
  /**
   * Maximum live agents inspected per loader update (default `64`).
   *
   * One live frame is a full scope-layer traversal per agent, and a patch reload
   * can update many rows at once, so the ceiling bounds a guard's cost in a
   * deployment with very many concurrent sessions. Agents beyond the cap are
   * inspected by the next update; the cap has no effect on ordinary deployments,
   * which run far fewer agents at once.
   */
  maxAgentsPerUpdate?: number
}

export const Config: z<Config> = z.object({
  announceInSession: z.boolean().default(true),
  maxAgentsPerUpdate: z.natural().min(1).default(64),
})

/**
 * The Chinese notice the affected conversation receives. It names the
 * consequence and the recovery in the user's own terms: no file names, no
 * plugin names, no framework vocabulary — the reader is the person whose session
 * just lost its tools, and the only action available to them is a restart.
 * @param missing - the withdrawn tool names, in lexical order.
 * @returns the notice text.
 */
function noticeText(missing: readonly string[]): string {
  return `这个会话的部分工具被一次配置热加载撤掉了（缺少：${missing.join('、')}）。`
    + '**重启一次 DSH 宿主**即可恢复；已经打开的会话不方便重启时，可新开一个会话继续。'
}

/** The collapsed-row account of the same notice, bounded for the durable log. */
function noticeSummary(missing: readonly string[]): string {
  return boundContextSummary(`工具被热加载撤掉：缺少 ${missing.join('、')}`)
}

/**
 * Resolve the config's agent cap, failing loud. The schema already defaults it;
 * this re-checks the value because direct (non-Loader) construction bypasses the
 * schema, the same boundary `resolveMaxParallelSubCalls` guards in `dsh-tools`.
 */
function resolveMaxAgentsPerUpdate(value: number | undefined): number {
  const maxAgentsPerUpdate = value ?? 64
  if (!Number.isInteger(maxAgentsPerUpdate) || maxAgentsPerUpdate < 1) {
    throw new Error('composition-guard: maxAgentsPerUpdate must be a positive integer')
  }
  return maxAgentsPerUpdate
}

/**
 * Install the guard's listeners.
 * @param ctx - plugin context; listeners and the baseline record are scoped to it.
 * @param config - validated {@link Config}; `maxAgentsPerUpdate` is re-checked fail-loud here.
 */
export function apply(ctx: Context, config: Config): void {
  const announceInSession = config.announceInSession as boolean
  const maxAgentsPerUpdate = resolveMaxAgentsPerUpdate(config.maxAgentsPerUpdate)

  const runtime: RuntimeRecord = openRuntime(ctx.root.fiber)
  const agents: TrackedAgents = runtime.agents
  // The record is owned by this fiber, so unloading the guard row (HMR, a
  // composition change) drops every baseline with it instead of leaving a
  // half-installed guard whose records no instance maintains.
  ctx.effect(() => runtime.dispose, 'composition-guard.baselines()')

  /** Agents whose own failure was already logged; a broken check must not repeat itself per update. */
  const failuresReported = new WeakSet<Agent>()
  /** Whether the sweep's own failure was already logged. */
  let sweepFailureReported = false

  /**
   * Report one contained failure once per agent. The guard is a diagnostic: a
   * failure inside it must cost a log line, never the host.
   */
  function reportFailure(agent: Agent, error: unknown): void {
    if (failuresReported.has(agent)) return
    failuresReported.add(agent)
    try {
      ctx.logger.warn(`composition-guard: the composition check failed for session "${agent.id}": ${String(error)}`)
    } catch {
      // A logger that throws must not make the guard itself a failure source.
    }
  }

  /**
   * The tool names one agent's scope resolves right now, in lexical order, or
   * `undefined` when the agent carries no scope to read.
   *
   * `schemas()` is the registry's documented enumeration of a scope's visible
   * tools (one schema per visible name, after restrictions, scoped shadowing,
   * and the PTC transport), so it is what the model would be offered. Its
   * argument is a `ScopeKey`, not an Agent: `scopeOf(agent.ctx)` supplies the
   * agent's own key, which is the scope whose view the agent sees.
   */
  function visibleToolNames(agent: Agent): string[] | undefined {
    const scope = scopeOf(agent.ctx)
    if (scope === undefined) return undefined
    return ctx.tools.schemas(scope).map(schema => schema.name).sort()
  }

  /**
   * The preset one agent composes now. Read through `ctx.get` rather than the
   * declared-property proxy: the roster is absent in a rosterless deployment,
   * and an undeclared property read would wait for a service that never comes.
   */
  function composedPreset(agent: Agent): string | undefined {
    return ctx.get('agentPresets')?.composedPreset(agent.ctx)
  }

  /**
   * Announce one regression on both channels and report whether anything was
   * delivered, so the caller marks the regression reported only after a channel
   * accepted it. Each channel contains its own failure: a session that has gone
   * away is not a reason to lose the log line, and a logger that throws is not a
   * reason to lose the notice.
   */
  function announce(agent: Agent, preset: string | undefined, missing: readonly string[]): boolean {
    let delivered = false
    try {
      ctx.logger.warn(
        `composition-guard: session "${agent.id}" (preset ${preset ?? '(none)'}) lost ${missing.length} `
        + `visible tool(s) [${missing.join(', ')}] without its preset changing; a live composition reload `
        + 'withdrew them and only a host restart restores them',
      )
      delivered = true
    } catch (error: unknown) {
      reportFailure(agent, error)
    }
    if (!announceInSession) return delivered
    try {
      agent.inject(createUserMessage({
        content: [{ type: 'text', text: noticeText(missing) }],
        source: {
          kind: 'plugin',
          plugin: name,
          form: 'notice',
          summary: noticeSummary(missing),
        },
      }))
      delivered = true
    } catch (error: unknown) {
      reportFailure(agent, error)
    }
    return delivered
  }

  /**
   * Compare one live agent against its baseline and report a withdrawal.
   *
   * Three outcomes are deliberately silent. An untracked agent is adopted from
   * what it looks like now — with no earlier observation there is no regression
   * to attribute, and inventing one would fire on every start. A changed preset
   * is a legitimate re-composition, so the new composition becomes the baseline.
   * A repeated regression is reported once, until the names come back.
   */
  function inspect(agent: Agent): void {
    try {
      const names = visibleToolNames(agent)
      // An agent with no scope has no agent view to compare; the global view
      // would answer for the wrong surface entirely.
      if (names === undefined) return
      const preset = composedPreset(agent)
      const entry = trackedEntry(agents, agent)
      if (entry === undefined) {
        // Adopted, not born under this plugin: the guard activated with this
        // agent already live, or a sweep found it untracked. Recorded as seen.
        track(agents, agent, names, preset, true)
        return
      }
      if (preset !== entry.preset) {
        rebaseline(entry, names, preset)
        return
      }
      const missing = entry.names.filter(tool => !names.includes(tool))
      if (missing.length === 0) {
        rearm(entry)
        return
      }
      if (entry.reported !== undefined) return
      if (announce(agent, entry.preset, missing)) markReported(entry, missing)
    } catch (error: unknown) {
      reportFailure(agent, error)
    }
  }

  /** Inspect every live agent, bounded by the configured cap. */
  function sweep(): void {
    try {
      for (const agent of ctx.agents.list().slice(0, maxAgentsPerUpdate)) inspect(agent)
    } catch (error: unknown) {
      if (sweepFailureReported) return
      sweepFailureReported = true
      try {
        ctx.logger.warn(`composition-guard: the composition sweep failed: ${String(error)}`)
      } catch {
        // See `reportFailure`: the guard never becomes the failure it reports.
      }
    }
  }

  // The baseline is recorded from the creation dispatch, where setup has already
  // composed the agent and nothing has started it: the recorded names are the
  // composition the agent's history will be produced under.
  ctx.on('agent/created', ({ agent }) => {
    try {
      const names = visibleToolNames(agent)
      if (names === undefined) return
      track(agents, agent, names, composedPreset(agent), false)
    } catch (error: unknown) {
      reportFailure(agent, error)
    }
  })

  // Records die with their agents; the registry's own teardown announces this
  // for every removal path, and one live agent owns a session id at a time.
  ctx.on('agent/disposed', ({ agent }) => { agents.delete(agent.id) })

  // The loader's config update: the same waterfall `dsh-app-boot` and the Loader
  // observe, and the point at which a live patch reload has been reconciled.
  // Registered global because the row that changed need not be this plugin's
  // ancestor, and NOT prepended, so this listener sits downstream of Cordis's
  // own `internal/update` chain driver: `next()` therefore returns the restart
  // the update runs behind, and the sweep observes the post-reload state rather
  // than the state the reload is about to replace.
  //
  // Both outcomes sweep. A reload that FAILED also leaves rows withdrawn, and
  // the recovery a reader needs is the same one.
  ctx.on('internal/update', (_config: unknown, _noSave: boolean, next: () => unknown): unknown => {
    const settled = next()
    void Promise.resolve(settled).then(() => { sweep() }, () => { sweep() })
    return settled
  }, { global: true })

  // Adoption runs at activation, not only on later creation: this guard is
  // composed into a RUNNING host, so the sessions that already exist — including
  // a long-lived one that lost tools before the guard was there — are exactly
  // the ones `agent/created` can never describe.
  sweep()
}
