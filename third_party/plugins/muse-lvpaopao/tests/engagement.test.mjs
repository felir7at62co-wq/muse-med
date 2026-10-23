import assert from 'node:assert/strict'
import test from 'node:test'
import { readEngagement } from '../src/engagement.ts'
const source = { srcAppId: 'wx0000000000000001', dramaId: 'synthetic-drama' }
const limits = { maxQueryChars: 80, maxEpisodeCount: 2, maxResultItems: 20, maxSeriesEpisodes: 10 }
const counts = { likes: 0, comments: 2, recommendations: 3, shares: 4 }
function fixture(options = {}) {
  const calls = []
  return { calls, async dispose() { throw Error('Borrowed connection must stay open') }, async request(action, params, signal) {
    signal.throwIfAborted(); calls.push({ action, params })
    if (action === 'search') return { operation: action, status: 'search-returned', identityMatched: true, partial: false,
      candidates: [{ title: 'Fixture', srcAppId: source.srcAppId, originDramaId: source.dramaId }, ...(options.ambiguous ? [{ title: 'Fixture', srcAppId: source.srcAppId, originDramaId: 'other' }] : [])] }
    if (action === 'detail') return { operation: action, status: 'detail-returned', identityMatched: true, ...source, title: 'Fixture', episodeCount: 3 }
    if (action === 'episodes') return { operation: action, status: 'episodes-returned', identityMatched: true, ...source, episodeCount: 3,
      requestedStart: params.start, requestedEndExclusive: params.start + params.count, partial: !!options.missing,
      episodeNumbers: Array.from({ length: params.count }, (_, i) => params.start + i).filter(i => !options.missing || i !== 2) }
    assert.equal(action, 'engagement')
    options.onRead?.(params)
    return { operation: action, status: 'engagement-returned', identityMatched: true, ...source, episodeNo: params.episodeNo, observedAtMs: Date.now(), counts, ...options.response?.(params) }
  } }
}
const read = (port, input = source, signal = new AbortController().signal) => readEngagement(port, input, limits, signal)
test('a full series sums each actual episode once and retains zero counts and observations', async () => {
  const port = fixture(); const result = await read(port, { query: 'Fixture' }); const report = result.data.engagement
  assert.equal(result.ok, true); assert.equal(report.complete, true)
  assert.deepEqual(report.totals, { likes: 0, comments: 6, recommendations: 9, shares: 12 })
  assert.deepEqual(report.coveredEpisodes, { likes: 3, comments: 3, recommendations: 3, shares: 3 })
  assert.deepEqual(report.episodes.map(row => row.episodeNo), [1, 2, 3]); assert.equal(report.aggregation, 'episode-sum')
  assert.ok(port.calls.every(call => ['search', 'detail', 'episodes', 'engagement'].includes(call.action)))
})
test('one missing field leaves only that series total null and retains known sum', async () => {
  const result = await read(fixture({ response: p => p.episodeNo === 2 ? { counts: { ...counts, comments: null } } : {} }))
  assert.equal(result.status, 'engagement-partial'); assert.equal(result.data.engagement.totals.comments, null)
  assert.equal(result.data.engagement.knownTotals.comments, 4); assert.equal(result.data.engagement.coveredEpisodes.comments, 2)
  assert.equal(result.data.engagement.totals.shares, 12)
})
test('an incomplete directory cannot be labeled a complete series total', async () => {
  const report = (await read(fixture({ missing: true }))).data.engagement
  assert.equal(report.complete, false); assert.deepEqual(report.missingEpisodeNumbers, [2]); assert.equal(report.totals.shares, null)
  assert.equal(report.knownTotals.shares, 8)
})
test('an explicitly selected episode returns that episode only', async () => {
  const port = fixture(); const report = (await read(port, { ...source, episodeNo: 2 })).data.engagement
  assert.equal(report.scope, 'episode'); assert.deepEqual(report.totals, counts)
  assert.deepEqual(port.calls.filter(call => call.action === 'engagement').map(call => call.params.episodeNo), [2])
})
test('ambiguous titles do not start episode reads', async () => {
  const port = fixture({ ambiguous: true }); assert.equal((await read(port, { query: 'Fixture' })).status, 'selection-required')
  assert.deepEqual(port.calls.map(call => call.action), ['search'])
})
test('source mismatch and unknown episode numbers reject rather than mixing data', async () => {
  await assert.rejects(read(fixture({ response: () => ({ dramaId: 'other' }) })), /response-identity-mismatch/)
  await assert.rejects(read(fixture(), { ...source, episodeNo: 4 }), /episode-not-in-catalog/)
})
test('a rejected read stops subsequent admission without retry and reports partial coverage', async () => {
  const port = fixture({ response: p => p.episodeNo === 2 ? { status: 'business-error', counts: { likes: null, comments: null, recommendations: null, shares: null } } : {} })
  const result = await read(port); assert.equal(result.status, 'engagement-partial')
  assert.deepEqual(port.calls.filter(call => call.action === 'engagement').map(call => call.params.episodeNo), [1, 2])
  assert.deepEqual(result.data.engagement.missingEpisodeNumbers, [2, 3])
})
test('cancellation prevents the next episode call and overflow cannot produce a rounded total', async () => {
  const controller = new AbortController(); const port = fixture({ onRead: () => controller.abort() })
  await assert.rejects(read(port, source, controller.signal), /abort/i)
  assert.equal(port.calls.filter(call => call.action === 'engagement').length, 1)
  const report = (await read(fixture({ response: () => ({ counts: { ...counts, shares: Number.MAX_SAFE_INTEGER } }) }))).data.engagement
  assert.equal(report.totals.shares, null); assert.equal(report.knownTotals.shares, null)
})

test('a transport failure retains previously observed counts and stops without replay', async () => {
  const port = fixture({ onRead: p => { if (p.episodeNo === 2) throw Error('private transport detail') } })
  const result = await read(port); const report = result.data.engagement
  assert.equal(result.status, 'engagement-partial'); assert.equal(report.knownTotals.shares, 4)
  assert.equal(report.episodes[1].status, 'transport-error'); assert.equal(report.totals.shares, null)
  assert.ok(!JSON.stringify(result).includes('private transport detail'))
  assert.equal(port.calls.filter(call => call.action === 'engagement').length, 2)
})
