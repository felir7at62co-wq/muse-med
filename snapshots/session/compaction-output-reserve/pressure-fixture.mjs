/** Verify pressure compaction occurs between the marker result and final answer. */
import assert from 'node:assert/strict'
export const name = 'snapshot-pressure-compaction'
export const inject = ['agents', 'llm', 'tokenMeter']
/** Assert the measured request crosses the configured threshold only after the marker. */
export function apply(ctx) {
  let agent
  const requests = []
  ctx.on('agent/created', event => { agent = event.agent })
  ctx.on('llm/stream', async function* (options, next) {
    const last = options.messages.at(-1)
    const summary = last?.content.some(block => block.type === 'text'
      && block.text.includes('You are now acting as a compaction engine')) === true
    const tokens = ctx.tokenMeter.measure(agent.session).totalTokens
    assert.ok(summary ? tokens >= 6370 : tokens < 6370, `Pressure request ${requests.length}: ${tokens}`)
    requests.push({ summary, tokens })
    yield* next()
  })
  ctx.on('agent/turn-stopping', ({ agent: stopping }) => {
    assert.deepEqual(requests.map(request => request.summary), [false, true, false])
    const events = stopping.session.snapshotEvents()
    const summaries = events.filter(event => event.type === 'compaction/summary')
    assert.equal(summaries.length, 1)
    assert.ok(summaries[0].data.shadowedTokenCount > 0)
    const results = events.filter(event => event.type === 'tool/result')
    assert.equal(results.length, 1)
    assert.deepEqual(results[0].data.message.content, [{ type: 'text', text: 'alpha\n' }])
    assert.ok(summaries[0].data.shadowedRange.end < events.indexOf(results[0]))
    const final = events.filter(event => event.type === 'assistant/message').at(-1)
    assert.deepEqual(final.data.message.content, [{ type: 'text', text: 'PROACTIVE COMPACTION COMPLETE' }])
  })
}
