/** Routing role remains closed to business tools independently of task-service availability. */
import { scopeOf } from '@deepseek-ai/dsh-scope'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from './index.ts'
import type {} from '@deepseek-ai/dsh-session-activity'
import { mainSessionPrompt } from './prompt.ts'

/** Cordis role contribution. */
export const name = 'muse-main-session-policy'
/** Role checks are installed before queued Agent work is released. */
export const inject = ['agents', 'tools', 'systemPrompt']

const names = ['coordinator_sessions', 'coordinator_read', 'coordinator_view_image', 'coordinator_dispatch', 'coordinator_reconcile',
  'coordinator_tasks', 'coordinator_stop', 'coordinator_show_report', 'coordinator_display_skill', 'ask_user_question', 'show_view', 'visualize']

/**
 * Restrict this preset's actual tool subjects to coordination, display and human questions.
 * @param ctx - Routing preset scope, retained independently of the task service.
 */
export function apply(ctx: Context): void {
  const install = (target: Context): void => {
    ctx.effect(() => target.tools.restrict({ futureAllow: names, includeOwn: true }))
    ctx.effect(() => target.tools.guard(exec => names.includes(exec.name)
      ? undefined : 'Main Session only routes tasks; execute business work in another Session'))
  }
  if (scopeOf(ctx) !== undefined) install(ctx)
  else {
    ctx.on('agent/created', ({ agent }) => { install(agent.ctx) })
    for (const agent of ctx.agents.list()) install(agent.ctx)
  }
  ctx.systemPrompt.section({
    name: 'muse:main-session', order: ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'),
    text: () => mainSessionPrompt(ctx.get('sessionCoordinator')?.mode ?? { unattended: false, taskFolders: false }, ctx.get('sessionActivity') !== undefined),
  })
}
