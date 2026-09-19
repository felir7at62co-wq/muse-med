/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-composition-guard`.
 *
 * The guard's whole value is that it is not blind. It folds two event streams
 * into per-agent baselines — `agent/created` as agents are published, and its
 * own adoption sweep for the agents that were already live when it activated —
 * and its check compares that folded state against the authoritative registry it
 * enumerates. The companion observes the same relation from outside the plugin:
 * a session about to address a model must be one the guard holds a baseline for,
 * which is exactly the coverage a broken listener, a missed adoption, or an
 * agent published without its creation dispatch would silently destroy.
 *
 * The trigger is `system-prompt/assemble`, the same one the preset roster's
 * companion uses, and for the same ordering reason: an agent that assembles a
 * prompt has been published and its `agent/created` dispatch has settled, so the
 * check cannot race the event that establishes the relation.
 *
 * Nothing is reported when the guard is not composed in this runtime: the
 * relation belongs to the guard, and a deployment that mounts the companion
 * without the guard owes it nothing.
 * @module @deepseek-ai/dsh-composition-guard/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'
// Type-only: resolves the `agent` field `dsh-agent` merges into AssembleContext
// and the `system-prompt/assemble` waterfall this companion joins.
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-system-prompt'
// Imported through the package name, not `./baseline.ts`: a module shared between
// the two build entry points becomes a third chunk that the published `files`
// list does not carry, which `verify-built-package-invariants` rejects.
import { guardState } from '@deepseek-ai/dsh-composition-guard'

const PACKAGE_NAME = '@deepseek-ai/dsh-composition-guard'

/** Cordis companion plugin name. */
export const name = 'composition-guard-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * Fail when a session addresses a model without a composition baseline.
 *
 * A live agent the guard never recorded is a session whose tools can be
 * withdrawn with nothing watching, which is the defect the guard exists to
 * report — so an unguarded agent is a package-level contract violation, not a
 * session-level one.
 */
const install: InvariantInstaller = (ctx, fail) => {
  ctx.on('system-prompt/assemble', (_assembly, context, next) => {
    const agent = context.agent
    if (agent !== undefined) {
      const state = guardState(ctx.root.fiber)
      if (state.composed && !state.tracked.some(tracked => tracked.agent.id === agent.id)) {
        fail(
          `agent "${agent.id}" addressed a model while the composition guard tracked `
          + `${state.tracked.length} other agent(s) in this runtime and none for it; `
          + 'the guard must baseline every agent of the runtime it is composed in (agent/created or activation adoption)',
        )
      }
    }
    return next()
  })
}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
