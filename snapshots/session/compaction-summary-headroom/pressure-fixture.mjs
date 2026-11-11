/** Check that inherited summary headroom compacts between the marker and final answer. */
import assert from 'node:assert/strict'

export const name = 'snapshot-summary-headroom-pressure'
export const inject = ['agents', 'llm', 'tokenMeter']

/** Observe actual request pressure without changing the request or compaction policy. */
export function apply(ctx) {
  let agent
  const requests = []
  ctx.on('agent/created', event => { agent = event.agent })
  ctx.on('llm/stream', async function* (options, next) {
    const summary = options.messages.at(-1)?.content.some(block => block.type === 'text'
      && block.text.includes('You are now acting as a compaction engine')) === true
    requests.push({ summary, maxTokens: options.maxTokens,
      tokens: ctx.tokenMeter.measureWorkingContext(agent.session).totalTokens })
    yield* next()
  })
  ctx.on('agent/turn-stopping', ({ agent: stopping }) => {
    const detail = `Observed summary-headroom requests: ${JSON.stringify(requests)}`
    assert.deepEqual(requests.map(request => request.summary), [false, true, false], detail)
    assert.deepEqual(requests.map(request => request.maxTokens), [1000, 1800, 1000], detail)
    const events = stopping.session.snapshotEvents()
    const summaries = events.filter(event => event.type === 'compaction/summary')
    assert.equal(summaries.length, 1)
    assert.ok(summaries[0].data.shadowedTokenCount > 0)
    const results = events.filter(event => event.type === 'tool/result')
    assert.equal(results.length, 1)
    assert.deepEqual(results[0].data.message.content, [{ type: 'text', text: 'alpha\n' }])
    const final = events.filter(event => event.type === 'assistant/message').at(-1)
    assert.deepEqual(final.data.message.content, [{ type: 'text', text: 'PROACTIVE COMPACTION COMPLETE' }])
  })
}
