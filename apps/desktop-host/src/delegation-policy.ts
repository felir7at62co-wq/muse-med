/** Muse delegated children retain their composition without creating independent schedules. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-tools'

/** Product composition identity. */
export const name = 'muse-delegation-policy'
/** Creation is observed before queued Agent work is released. */
export const inject = ['agents', 'tools']

/**
 * Exclude scheduling from actual live children while preserving root-session capabilities.
 * @param ctx - Preset owner whose created-agent listener follows inherited composition scopes.
 */
export function apply(ctx: Context): void {
  ctx.on('agent/created', ({ agent }) => {
    if (ctx.agents.roots().includes(agent)) return
    const tools = agent.ctx.get('tools')
    if (tools === undefined) throw new Error('Muse delegated Agent requires the tool registry')
    tools.restrict({ includeOwn: true, futureDeny: [
      'schedule_create', 'schedule_edit', 'schedule_list', 'schedule_view', 'schedule_delete', 'schedule_update',
    ] })
  })
}
