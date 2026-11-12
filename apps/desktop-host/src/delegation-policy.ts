/** Muse execution roots can use official Team tasks; delegated children cannot create schedules. */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-team'
import type {} from '@deepseek-ai/dsh-tools'

/** Product composition identity. */
export const name = 'muse-delegation-policy'
/** Creation is observed before queued Agent work is released. */
export const inject = ['agents', 'tools']

/** Product defaults for roots created with this preset. */
export interface Config {
  /** Enable official Team tasks when a new root has no saved selection. */
  teamByDefault?: boolean
}

/** Deployment choice owned by the product preset composition. */
export const Config: z<Config> = z.object({ teamByDefault: z.boolean().default(false) })

/**
 * Preserve explicit Team selections and exclude scheduling from actual delegated children.
 * @param ctx - Preset owner whose created-agent listener follows inherited composition scopes.
 * @param config - Default Team selection for new roots of this preset.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const teams = config.teamByDefault ? ctx.get('agentTeams') : undefined
  if (config.teamByDefault && teams === undefined) throw new Error('Muse Team defaults require the official Agent Teams service')
  ctx.on('agent/created', async ({ agent, source, signal }) => {
    if (agent.session.header.origin === 'subagent') {
      const tools = agent.ctx.get('tools')
      if (tools === undefined) throw new Error('Muse delegated Agent requires the tool registry')
      tools.restrict({ includeOwn: true, futureDeny: [
        'schedule_create', 'schedule_edit', 'schedule_list', 'schedule_view', 'schedule_delete', 'schedule_update',
      ] })
      return
    }
    if (teams === undefined || source !== 'startup') return
    if (agent.session.ownEvents().some(event => event.type === 'team/mode')) return
    await teams.setEnabled(agent, true, signal)
  })
}
