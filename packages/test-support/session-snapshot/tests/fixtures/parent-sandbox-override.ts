import type { Context } from '@deepseek-ai/cordis'
import { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-agent'

export const name = 'parent-sandbox-override'

/**
 * Snapshot-only overlay: switch each ROOT session to `read-only` at creation —
 * the UI "Access" switch equivalent (one runtime `sandbox/mode` event on the
 * session log) — so the scenario proves a continuable background child
 * inherits the parent's explicit override as a `source: 'delegation'` event
 * instead of falling back to the deployment default. The child starts its
 * first step after the parent's spawn turn closes, preserving the recorded
 * next-turn settlement without relying on relative subprocess speed.
 */
export function apply(ctx: Context): void {
  const parentClosed = Promise.withResolvers<undefined>()
  ctx.effect(() => () => { parentClosed.resolve(undefined) })
  ctx.on('session/event', (session, event) => {
    if (session.header.parentSession === undefined && event.type === 'turn/end' && event.data.turn === 1) {
      parentClosed.resolve(undefined)
    }
  })
  ctx.on('agent/pre-step', async ({ agent }, next) => {
    if (agent.session.header.parentSession !== undefined) await parentClosed.promise
    return next()
  })
  ctx.on('agent/created', ({ agent }) => {
    if (agent.session.header.parentSession !== undefined) return
    setSandboxMode(agent.session, 'read-only')
  })
}
