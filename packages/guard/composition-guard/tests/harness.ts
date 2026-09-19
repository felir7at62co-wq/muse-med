/**
 * Shared fixtures for the composition-guard suites: the tools a fabricated
 * preset contributes, one fabricated agent, and its publication through the real
 * agent registry.
 *
 * The agent is fabricated because no agent factory is involved in what this
 * package reads — `agents.list()`, the session id, the scope context, and the
 * `inject` delivery — while everything the guard actually consults (the tool
 * registry's scope view, the agent registry's live set, the `internal/update`
 * waterfall) stays real.
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import { Session } from '@deepseek-ai/dsh-session'
import type { SessionId, UserMessage } from '@deepseek-ai/dsh-session'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'

/** The tools a fabricated preset contributes, in the lexical order the guard records them. */
export const PRESET_TOOLS = ['edit', 'read', 'write'] as const

/** A registrable tool definition; the guard only reads names, so the body is inert. */
export function toolFixture(toolName: string) {
  return defineContentToolFixture({
    name: toolName,
    description: `${toolName} fixture`,
    parameters: {},
    async execute() { return [{ type: 'text' as const, text: 'ok' }] },
  })
}

/**
 * Build one fabricated agent whose scope views resolve through `agentCtx`.
 * @param id - shared agent and session identity.
 * @param agentCtx - the agent's scoped context; its scope key is what the guard reads.
 * @param injected - receives every message delivered through `agent.inject`.
 * @returns an agent that satisfies the registry and runtime contracts the guard uses.
 */
export function stubAgent(id: SessionId, agentCtx: Context, injected: UserMessage[]): Agent {
  return {
    id,
    options: {},
    session: Session.create(id),
    inbox: { nextTurn: [], nextStep: [] } as never,
    status: 'idle',
    ctx: agentCtx,
    send: () => {},
    followup: () => {},
    steer: () => ({ outcome: Promise.resolve({ status: 'rejected' as const }) }),
    inject: (message: UserMessage) => { injected.push(message) },
    cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
}

/**
 * Publish one fabricated agent through the real registry lifecycle, so the
 * `agent/created` dispatch the guard listens on is the production one.
 * @param ctx - context carrying the live agent registry.
 * @param agent - the prepared, unpublished agent.
 * @returns the idempotent detach closure that removes this exact entry.
 */
export async function publishAgent(ctx: Context, agent: Agent): Promise<() => void> {
  const detach = ctx.agents.enter(agent, undefined)
  await ctx.agents.announce(agent, 'startup')
  return detach
}
