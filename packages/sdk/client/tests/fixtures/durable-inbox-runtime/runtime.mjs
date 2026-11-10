/** One real human receipt and a separately filtered runtime input through SDK step admission. */
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

/** Loader fixture identity. */
export const name = 'sdk-durable-inbox-runtime'
/** The ordinary SDK profile supplies these services; the overlay configures its actual loop. */
export const inject = ['agentLoop', 'llm']

/**
 * Add one disposable input without replacing the SDK-created human message.
 * @param {import('@deepseek-ai/cordis').Context} ctx - isolated SDK Loader scope.
 */
export function apply(ctx) {
  assert.equal(ctx.agentLoop.config.durableInboxClaims, true)
  const states = new Map()
  ctx.effect(() => () => states.clear())
  ctx.on('agent/inbox/inserted', ({ agent, message }) => {
    if (message.content.length !== 1 || message.content[0].type !== 'text'
      || message.content[0].text !== 'Keep this original SDK input and reply once.') return
    assert.equal(states.has(agent.id), false)
    const filtered = createUserMessage({ content: [{ type: 'text', text: 'Discard only this runtime fixture input.' }], source: { kind: 'user' } })
    states.set(agent.id, { human: message, filtered, requests: 0, modelMessageIds: [] })
    agent.inject(filtered)
  })
  ctx.on('agent/pre-step', async ({ agent }, next) => {
    const decision = await next()
    const state = states.get(agent.id)
    if (state === undefined || decision.kind !== 'enter') return decision
    assert.equal(decision.messages.filter(message => message.id === state.human.id).length, 1)
    return { ...decision, messages: decision.messages.filter(message => message.id !== state.filtered.id) }
  })
  ctx.on('llm/stream', async function* (options, next) {
    const state = states.get(options.sessionId)
    assert.ok(state)
    assert.equal(options.provider, 'sdk-claim-replay')
    assert.equal(options.model, 'claim-model')
    const ids = options.messages.map(message => message.id)
    assert.equal(ids.filter(id => id === state.human.id).length, 1)
    assert.equal(ids.includes(state.filtered.id), false)
    state.requests++
    state.modelMessageIds = ids
    yield* next()
  })
  ctx.on('agent/turn-stopping', ({ agent }) => {
    const state = states.get(agent.id)
    if (state === undefined) return
    assert.equal(state.requests, 1)
    writeFileSync(join(agent.session.header.cwd, 'sdk-durable-inbox-proof.json'), JSON.stringify({
      sessionId: agent.id, humanMessageId: state.human.id, filteredMessageId: state.filtered.id,
      requests: state.requests, modelMessageIds: state.modelMessageIds,
    }, null, 2) + '\n')
  })
}
