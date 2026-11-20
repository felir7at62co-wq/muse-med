/** Install the shipped Bot tool definitions with an in-memory card store for Loader tests. */
import { install } from '../../../../third_party/plugins/ds-bot/src/host/tools.js'

export const name = 'resident-bot-questions-fixture'
export const inject = ['tools', 'agents']

// Every Agent this fixture sees is the chat of one Bot, "fixture-bot". The Bot plugin
// scopes its team tools onto each Bot Session when that Session's Agent is created.
export function apply(ctx) {
  const chatOwners = new Map()
  const own = (agent) => {
    for (const id of [agent?.id, agent?.session?.id]) if (id !== undefined) chatOwners.set(id, 'fixture-bot')
  }
  ctx.on('agent/created', ({ agent }) => { own(agent) })
  install({
    ctx,
    state: { bots: {}, rooms: {}, sections: [], works: {}, questions: {}, views: {}, exchangeTurns: {} },
    teamTools: [],
    groupOwners: new Map(),
    chatOwners,
    live: new Map(),
    load: async () => {},
    save: async () => {},
    isBotSession: id => chatOwners.has(id),
    selfOf: id => chatOwners.get(id),
    botOf: id => id === 'fixture-bot' ? { id, name: 'Fixture', interactionSource: 'bot' } : undefined,
    roomOf: () => undefined,
    isMain: () => false,
    warn: (...args) => { throw new Error(`Unexpected Bot fixture warning: ${args.join(' ')}`) },
  })
}
