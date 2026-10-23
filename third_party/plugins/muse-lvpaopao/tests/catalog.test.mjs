/** Synthetic native catalog responses only; these checks perform no search, media request or download. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveSeriesCatalog } from '../src/catalog.ts'
import { BridgeError } from '../src/port.ts'

const SOURCE = 'wx0000000000000001'
const OTHER_SOURCE = 'wx0000000000000002'
const DRAMA = 'synthetic-drama-001'
const TITLE = 'Synthetic Drama'
const LIMITS = { maxQueryChars: 80, maxEpisodeCount: 2, maxResultItems: 20, maxSeriesEpisodes: 10 }
const selectedInput = { srcAppId: SOURCE, dramaId: DRAMA }
const candidate = (patch = {}) => ({ title: TITLE, srcAppId: SOURCE, originDramaId: DRAMA, ...patch })
const search = (candidates, patch = {}) => ({ operation: 'search', status: 'search-returned', identityMatched: true,
  partial: false, candidates, ...patch })
const detail = (patch = {}) => ({ operation: 'detail', status: 'detail-returned', identityMatched: true,
  ...selectedInput, title: TITLE, episodeCount: 5, ...patch })
const episodes = (params, patch = {}) => ({ operation: 'episodes', status: 'episodes-returned', identityMatched: true,
  ...selectedInput, episodeCount: 5, requestedStart: params.start, requestedEndExclusive: params.start + params.count,
  episodeNumbers: Array.from({ length: params.count }, (_, index) => params.start + index), partial: false, ...patch })

function nativePort(respond) {
  const calls = []
  return { calls, async request(action, params, signal) {
    signal.throwIfAborted()
    calls.push({ action, params: structuredClone(params) })
    assert.ok(['search', 'detail', 'episodes'].includes(action), 'Catalog resolution must not request media')
    return respond(action, params)
  }, async dispose() { throw Error('Catalog resolution must not dispose the borrowed native connection') } }
}
function ordinaryPort(searchResponse = search([candidate()]), pageResponse = episodes) {
  return nativePort((action, params) => action === 'search' ? searchResponse : action === 'detail' ? detail() : pageResponse(params))
}
const resolve = (port, input, signal = new AbortController().signal) => resolveSeriesCatalog(port, input, LIMITS, signal)
const code = expected => error => error instanceof BridgeError && error.code === expected

test('one exact normalized title selects its actual source instead of a near match', async () => {
  const port = ordinaryPort(search([candidate({ title: 'Synthetic Drama 2', originDramaId: 'near-match' }), candidate()]))
  const result = await resolve(port, { query: '  ＳＹＮＴＨＥＴＩＣ　ＤＲＡＭＡ  ' })
  assert.equal(result.kind, 'selected')
  assert.deepEqual(result.selection, { ...selectedInput, title: TITLE, episodeCount: 5,
    actualEpisodeNumbers: [1, 2, 3, 4, 5], catalogComplete: true })
  assert.deepEqual(port.calls[1], { action: 'detail', params: selectedInput })
})

test('multiple exact titles require source selection without fetching a catalog', async () => {
  const candidates = [candidate(), candidate({ srcAppId: OTHER_SOURCE, originDramaId: 'other-source' })]
  const port = ordinaryPort(search(candidates))
  assert.deepEqual(await resolve(port, { query: TITLE }), { kind: 'selection-required', candidates })
  assert.deepEqual(port.calls.map(call => call.action), ['search'])
})

test('partial search still requires selection even when its visible exact title is unique', async () => {
  const candidates = [candidate()]
  const port = ordinaryPort(search(candidates, { partial: true }))
  assert.deepEqual(await resolve(port, { query: TITLE }), { kind: 'selection-required', candidates })
  assert.equal(port.calls.length, 1)
})

test('a near title or an empty search result never becomes an automatic source choice', async () => {
  for (const candidates of [[candidate({ title: 'Synthetic Drama 2' })], []]) {
    const port = ordinaryPort(search(candidates))
    assert.deepEqual(await resolve(port, { query: TITLE }), { kind: 'selection-required', candidates })
    assert.equal(port.calls.length, 1)
  }
})

test('explicit selection reads each actual page from 1 through N with a bounded final window', async () => {
  const port = ordinaryPort(undefined, params => episodes(params, {
    episodeNumbers: Array.from({ length: params.count }, (_, index) => params.start + index).reverse(),
  }))
  const result = await resolve(port, selectedInput)
  assert.equal(result.kind, 'selected')
  assert.deepEqual(result.selection.actualEpisodeNumbers, [1, 2, 3, 4, 5])
  assert.equal(result.selection.catalogComplete, true)
  assert.deepEqual(port.calls, [
    { action: 'detail', params: selectedInput },
    { action: 'episodes', params: { ...selectedInput, start: 1, count: 2 } },
    { action: 'episodes', params: { ...selectedInput, start: 3, count: 2 } },
    { action: 'episodes', params: { ...selectedInput, start: 5, count: 1 } },
  ])
})

test('missing numbers remain missing even if the native page fails to mark itself partial', async () => {
  const port = ordinaryPort(undefined, params => episodes(params, params.start === 1 ? { episodeNumbers: [1] } : {}))
  const result = await resolve(port, selectedInput)
  assert.equal(result.kind, 'selected')
  assert.deepEqual(result.selection.actualEpisodeNumbers, [1, 3, 4, 5])
  assert.equal(result.selection.catalogComplete, false)
  assert.equal(port.calls.filter(call => call.action === 'episodes').length, 3)
})

test('an explicitly partial page cannot make the directory complete despite containing its full window', async () => {
  const port = ordinaryPort(undefined, params => episodes(params, { partial: params.start === 3 }))
  const result = await resolve(port, selectedInput)
  assert.deepEqual(result.selection.actualEpisodeNumbers, [1, 2, 3, 4, 5])
  assert.equal(result.selection.catalogComplete, false)
})

test('detail identity mismatch stops before any episode page is requested', async () => {
  for (const patch of [{ srcAppId: OTHER_SOURCE }, { dramaId: 'different-drama' }]) {
    const port = nativePort(() => detail(patch))
    await assert.rejects(resolve(port, selectedInput), code('response-identity-mismatch'))
    assert.equal(port.calls.length, 1)
  }
})

test('a page with changed source, total count or requested window is rejected immediately', async () => {
  for (const patch of [{ srcAppId: OTHER_SOURCE }, { dramaId: 'different-drama' }, { episodeCount: 6 },
    { requestedStart: 2 }, { requestedEndExclusive: 4 }, { requestedStart: undefined }]) {
    const port = ordinaryPort(undefined, params => episodes(params, patch))
    await assert.rejects(resolve(port, selectedInput), code('catalog-identity-unconfirmed'))
    assert.equal(port.calls.length, 2)
  }
})

test('a page cannot supply an episode outside the requested window', async () => {
  const port = ordinaryPort(undefined, params => episodes(params, { episodeNumbers: [1, 3] }))
  await assert.rejects(resolve(port, selectedInput), code('catalog-window-unconfirmed'))
  assert.equal(port.calls.length, 2)
})

test('unconfirmed native identity or duplicate episode numbers cannot produce a selected catalog', async () => {
  const rejected = ordinaryPort(search([candidate()], { identityMatched: false }))
  await assert.rejects(resolve(rejected, { query: TITLE }), error => error instanceof BridgeError)
  assert.equal(rejected.calls.length, 1)
  const duplicates = ordinaryPort(undefined, params => episodes(params, { episodeNumbers: [1, 1] }))
  await assert.rejects(resolve(duplicates, selectedInput), code('invalid-response'))
  assert.equal(duplicates.calls.length, 2)
})

test('an absent, empty or excessive episode count stops before paging', async () => {
  for (const patch of [{ episodeCount: undefined }, { episodeCount: 0 }, { episodeCount: 11 }]) {
    const port = nativePort(() => detail(patch))
    await assert.rejects(resolve(port, selectedInput), code('catalog-count-unconfirmed'))
    assert.equal(port.calls.length, 1)
  }
})

test('invalid source fields fail before the borrowed connection is used', async () => {
  for (const input of [{ srcAppId: 'wx-invalid', dramaId: DRAMA }, { srcAppId: SOURCE }, { dramaId: DRAMA },
    { ...selectedInput, query: TITLE }, { srcAppId: SOURCE, dramaId: 'unsafe/id' }]) {
    const port = ordinaryPort()
    await assert.rejects(resolve(port, input), code('invalid-arguments'))
    assert.equal(port.calls.length, 0)
  }
})

test('download-incompatible source identities are rejected equally after automatic or explicit selection', async () => {
  for (const dramaId of ['synthetic.source:001', 'a'.repeat(65)]) {
    const automatic = ordinaryPort(search([candidate({ originDramaId: dramaId })]))
    await assert.rejects(resolve(automatic, { query: TITLE }), code('invalid-arguments'))
    assert.deepEqual(automatic.calls.map(call => call.action), ['search'])
    const explicit = ordinaryPort()
    await assert.rejects(resolve(explicit, { srcAppId: SOURCE, dramaId }), code('invalid-arguments'))
    assert.equal(explicit.calls.length, 0)
  }
})

test('malformed native search candidates fail before detail or paging', async () => {
  for (const patch of [{ srcAppId: 'wx-invalid' }, { originDramaId: 'unsafe/id' }]) {
    const port = ordinaryPort(search([candidate(patch)]))
    await assert.rejects(resolve(port, { query: TITLE }), code('invalid-response'))
    assert.equal(port.calls.length, 1)
  }
})

test('cancellation before catalog resolution performs no native operation', async () => {
  const controller = new AbortController()
  const reason = Error('Synthetic caller cancellation')
  controller.abort(reason)
  const port = ordinaryPort()
  await assert.rejects(resolve(port, selectedInput, controller.signal), error => error === reason)
  assert.equal(port.calls.length, 0)
})
