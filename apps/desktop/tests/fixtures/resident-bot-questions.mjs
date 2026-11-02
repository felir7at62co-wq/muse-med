/** Install the shipped Bot tool definitions with an in-memory card store for Loader tests. */
import { install } from '../../../../third_party/plugins/ds-bot/src/host/tools.js'

export const name = 'resident-bot-questions-fixture'
export const inject = ['tools', 'agents']

export function apply(ctx) {
  const chatOwners = new Map()
  ctx.on('agent/created', ({ agent }) => { chatOwners.set(agent.id, 'fixture-bot') })
  install({
    ctx,
    config: { goals: 'enabled' },
    state: { questions: {}, exchangeTurns: {} },
    groupOwners: new Map(),
    chatOwners,
    live: new Map(),
    load: async () => {},
    save: async () => {},
    isBotSession: id => chatOwners.has(id),
    selfOf: id => chatOwners.get(id),
    botOf: id => id === 'fixture-bot' ? { id, interactionSource: 'bot' } : undefined,
    warn: (...args) => { throw new Error(`Unexpected Bot fixture warning: ${args.join(' ')}`) },
  })
}
