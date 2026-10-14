/** External skill discovery outcomes for the shipped headless profile. */
import assert from 'node:assert/strict'
export const name = 'snapshot-skill-preparation'
export const inject = ['skills']
/** @param {import('@deepseek-ai/cordis').Context} ctx - Real Loader context. */
export function apply(ctx) {
  const mode = process.env.DSH_SKILL_PREPARATION_FIXTURE ?? 'catalog'
  assert.ok(['catalog', 'incomplete', 'cancel'].includes(mode))
  let agent
  ctx.on('agent/pre-step', (payload, next) => { agent = payload.agent; return next() })
  ctx.effect(() => ctx.skills.registerProvider(() => ({
    name: 'snapshot-preparation',
    async list(options) {
      if (mode === 'incomplete') throw new Error('External skill discovery unavailable')
      if (mode === 'cancel') {
        assert.ok(agent)
        assert.ok(options.signal)
        agent.cancel({ kind: 'user' })
        options.signal.throwIfAborted()
      }
      return [{ name: 'sample-skill', description: 'Use for the sample task.',
        invocation: { modelInvocable: true, userInvocable: true },
        provider: 'snapshot-preparation', source: 'custom', rank: 100, locator: 'sample' }]
    },
    async get() { throw new Error('This scenario only prepares the skill catalog') },
  })))
  ctx.on('llm/stream', async function* (options, next) {
    assert.equal(mode, 'catalog', 'Incomplete or cancelled preparation never calls the model')
    const catalog = options.messages.find(message => message.content.some(block =>
      block.type === 'text' && block.text.includes('`sample-skill`: Use for the sample task.')))
    assert.ok(catalog, 'The prepared catalog is in the model request')
    yield* next()
  })
}
