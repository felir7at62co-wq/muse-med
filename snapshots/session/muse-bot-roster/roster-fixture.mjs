/** Exercise native Main Bot identity and roster output through the Headless Session runner. */
import { install as installPrompt } from '../../../third_party/plugins/ds-bot/src/host/prompt.js'
import { install as installTools } from '../../../third_party/plugins/ds-bot/src/host/tools.js'

/** The fixture registers only the real roster tool, without starting the browser-only Bot Host. */
export const name = 'snapshot-muse-bot-roster'
/** The shipped Headless profile provides the actual tool registry and prompt service. */
export const inject = ['tools', 'systemPrompt']

/**
 * Install native identity and list_bots with one fixed Main Bot in an isolated roster.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Snapshot process context.
 * @returns {void}
 */
export function apply(ctx) {
  const mainBot = { id: 'muse-main', name: 'Muse Bot', role: '主理人', instructions: '', model: 'deepseek-official/deepseek-v4-flash' }
  const rt = {
    ctx: {
      systemPrompt: ctx.systemPrompt,
      effect: (execute, label) => ctx.effect(execute, label),
      tools: {
        register: tool => tool.name === 'list_bots' ? ctx.effect(() => ctx.tools.register(tool)) : () => {},
        guard: () => () => {},
      },
      on: () => () => {},
    },
    config: { goals: 'host' },
    state: { bots: { [mainBot.id]: mainBot }, rooms: {} },
    load: async () => {},
    selfOf: id => id === undefined ? undefined : mainBot.id,
    botOf: id => id === mainBot.id ? mainBot : undefined,
    isMain: id => id === mainBot.id,
    modelView: bot => ({ model: bot.model }),
    roomOf: () => undefined,
    isBotSession: id => id !== undefined,
  }
  installPrompt(rt)
  installTools(rt)
}
