/** Assert failed auxiliary summaries preserve an admissible complete request. */
import assert from 'node:assert/strict'
import { createSystemMessage, createUserMessage, LlmError } from '@deepseek-ai/dsh-llm'

/** Loader identity for this scenario's local failure provider. */
export const name = 'snapshot-summary-failure-recovery'
/** Services used to observe the actual request and retained Session. */
export const inject = ['agents', 'llm', 'tokenMeter']

const premise = 'Recorded project evidence remains available after a temporary summary failure. '.repeat(320)
const task = '继续下一段内容。'

/** Add logged context during the real step and reject only auxiliary summaries.
 * @param ctx - Scenario plugin context owned by the Headless Loader.
 */
export function apply(ctx) {
  let owner
  let seeded = false
  let summaries = 0
  let ordinary = 0
  ctx.on('agent/created', ({ agent }) => { owner = agent })
  ctx.on('agent/request', ({ agent, turn, step }, next) => {
    if (seeded) return next()
    seeded = true
    agent.session.append('system/message', {
      turn, step,
      message: createSystemMessage(''),
    }, { surfaceOp: 'append' })
    agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: premise }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    return next()
  }, { prepend: true })
  ctx.on('llm/stream', async function* (options, next) {
    if (options.purpose === 'compaction') {
      summaries++
      throw new LlmError('Synthetic summary service is temporarily unavailable', 'SERVER')
    }
    const measured = ctx.tokenMeter.measureWorkingContext(owner.session).totalTokens
    assert.ok(measured >= 7500 && measured < 17200, `Admissible over-target context: ${measured}`)
    assert.ok(options.messages.some(message => message.content.some(block => block.type === 'text' && block.text === premise)))
    assert.ok(options.messages.some(message => message.content.some(block => block.type === 'text' && block.text === task)))
    ordinary++
    yield* next()
  })
  ctx.on('agent/turn-stopping', ({ agent }) => {
    assert.equal(agent, owner)
    assert.ok(summaries >= 1 && summaries <= 2, `Bounded summary attempts: ${summaries}`)
    assert.equal(ordinary, 1)
    const events = agent.session.snapshotEvents()
    assert.ok(events.some(event => event.type === 'user/message'
      && event.data.content.some(block => block.type === 'text' && block.text === premise)))
    assert.ok(events.some(event => event.type === 'user/message'
      && event.data.source.kind === 'user'
      && event.data.content.some(block => block.type === 'text' && block.text === task)))
    assert.equal(events.filter(event => event.type === 'compaction/summary').length, 0)
    assert.ok(events.some(event => event.type === 'compaction/end' && event.data.error !== undefined))
    const final = events.filter(event => event.type === 'assistant/message').at(-1)
    assert.deepEqual(final.data.message.content, [{ type: 'text', text: 'CONTEXT RECOVERY COMPLETE' }])
  })
}
