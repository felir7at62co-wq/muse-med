/** Mount the product editing preset on the headless snapshot agent. */
import { fileURLToPath } from 'node:url'
import { PERSONA_SUFFIX_SECTION } from '@deepseek-ai/dsh-system-prompt'
import NativePreset from '../../../apps/desktop-host/src/native-preset.ts'

export const name = 'snapshot-editing-preset'
export const inject = ['agentPresets', 'tools', 'systemPrompt']

/** @param {import('@deepseek-ai/cordis').Context} ctx - snapshot composition. */
export async function apply(ctx, config) {
  await ctx.plugin(NativePreset, {
    id: 'editing',
    directory: fileURLToPath(new URL('../../../apps/desktop-host/presets/editing/', import.meta.url)),
  })
  ctx.on('agent/created', async ({ agent }) => {
    await ctx.agentPresets.mount(agent.ctx, 'editing')
    // The product suffix puts Chinese punctuation directly after {{cwd}};
    // this snapshot-only shadow keeps the same meaning with a path boundary.
    agent.ctx.effect(() => agent.ctx.systemPrompt.section({
      name: PERSONA_SUFFIX_SECTION,
      order: agent.ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_SUFFIX'),
      text: '当前工作目录是 {{cwd}} 。',
    }))
    if (config.hidePlatformShellTools === true) {
      agent.ctx.effect(() => agent.ctx.tools.restrict({ futureDeny: ['bash', 'pwsh'] }))
      for (const [name, order] of [
        ['tool:bash', 'TOOL_BASH'],
        ['tool:pwsh', 'TOOL_PWSH'],
      ]) {
        agent.ctx.effect(() => agent.ctx.systemPrompt.section({
          name,
          order: agent.ctx.systemPrompt.getSectionOrder(order),
          text: '',
        }))
      }
    }
  })
}
