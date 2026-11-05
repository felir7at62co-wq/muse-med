/** Verify output-reserved pressure compaction between the alpha marker and final answer. */
import assert from 'node:assert/strict'
export const name = 'snapshot-pressure-compaction'
export const inject = ['agents', 'llm', 'tokenMeter', 'compaction']
/** Assert the real request crosses its reserved budget but not its unreserved budget. */
export function apply(ctx) {
  let agent
  const requests = []
  ctx.on('agent/created', event => { agent = event.agent })
  ctx.on('llm/stream', async function* (options, next) {
    const last = options.messages.at(-1)
    const summary = last?.content.some(block => block.type === 'text'
      && block.text.includes('You are now acting as a compaction engine')) === true
    const measurement = ctx.tokenMeter.measure(agent.session)
    const info = await ctx.llm.resolveModelInfo(options.provider, options.model)
    assert.ok(info.context)
    const reservation = agent.session.requestHeader().config.maxTokens
    assert.equal(reservation, 1000)
    const { thresholdRatio, headroomTokens, maxTokens } = ctx.compaction.config
    const capacity = info.context.contextWindow
    const unreserved = Math.floor(Math.min(capacity * thresholdRatio, capacity - headroomTokens))
    const threshold = Math.floor(Math.min(capacity * thresholdRatio, capacity - headroomTokens - reservation))
    const tokens = measurement.totalTokens
    assert.ok(summary ? tokens >= threshold : tokens < threshold, `Pressure request ${requests.length}: ${tokens}, threshold ${threshold}`)
    assert.ok(tokens < unreserved, 'The same history must remain below pressure without output reservation')
    assert.equal(options.maxTokens, summary ? maxTokens : reservation)
    requests.push({ summary, tokens })
    yield* next()
  })
  ctx.on('agent/turn-stopping', ({ agent: stopping }) => {
    assert.deepEqual(requests.map(request => request.summary), [false, true, false])
    const events = stopping.session.snapshotEvents()
    const summaries = events.filter(event => event.type === 'compaction/summary')
    assert.equal(summaries.length, 1)
    assert.ok(summaries[0].data.shadowedTokenCount > 0)
    assert.equal(summaries[0].data.maxTokens, ctx.compaction.config.maxTokens)
    const results = events.filter(event => event.type === 'tool/result')
    assert.equal(results.length, 1)
    assert.equal(results[0].data.message.isError, false)
    assert.deepEqual(results[0].data.message.content, [{ type: 'text', text: 'alpha\n' }])
    assert.ok(summaries[0].data.shadowedRange.end < events.indexOf(results[0]))
    const final = events.filter(event => event.type === 'assistant/message').at(-1)
    assert.deepEqual(final.data.message.content, [{ type: 'text', text: 'PROACTIVE COMPACTION COMPLETE' }])
  })
}
