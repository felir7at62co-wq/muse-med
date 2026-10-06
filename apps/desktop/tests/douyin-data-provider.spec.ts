import { expect, it } from 'vitest'
import { runInNewContext } from 'node:vm'
import { JSDOM } from 'jsdom'
import type { DouyinVideoId } from '@deepseek-ai/dsh-client-ui-sidebar-browser/types'
import { creatorData, providerCount, publicData, publicDataProbe } from '../src/douyin-data-provider.ts'
import { PROVIDER_MAX_BYTES } from '../src/douyin-provider.ts'

const target = '7692443246022167851' as DouyinVideoId
const observedAt = '2026-10-06T12:00:00.000Z'
const comments = { status: 'not-requested' as const, items: [], cursor: null, hasMore: null }
const stats = { play_count: 8675309, digg_count: 12, comment_count: 0, share_count: 2, collect_count: 3 }
const body = (statistics: object = stats, aweme_id: string = target) => JSON.stringify({
  status_code: 0, aweme_detail: { aweme_id, statistics, video: { play_addr: { url_list: ['https://invalid.test/private'] } },
    author: { sec_uid: 'private-fixture-id' }, extra: { token: 'private-fixture-token' } },
})

it('returns the exposed exact work counters without author, authentication or media fields', () => {
  const result = publicData(body(), target, observedAt, comments)
  expect(result).toEqual({ status: 'ok', source: 'public-page', targetVideoId: target, observedAt,
    counts: { play_count: { value: 8675309, precision: 'exact' },
      digg_count: { value: 12, precision: 'exact' }, comment_count: { value: 0, precision: 'exact' },
      share_count: { value: 2, precision: 'exact' }, collect_count: { value: 3, precision: 'exact' } }, comments })
  expect(JSON.stringify(result)).not.toMatch(/private|play_addr|sec_uid|token/)
})

it('reports the public zero play placeholder as unavailable without inferring a value', () => {
  expect(publicData(body({ ...stats, play_count: 0 }), target, observedAt, comments)?.counts.play_count)
    .toEqual({ value: null, precision: 'unavailable', reason: 'not-exposed' })
  expect(publicData(body({ digg_count: 12 }), target, observedAt, comments)?.counts.play_count)
    .toEqual({ value: null, precision: 'unavailable', reason: 'missing' })
})

it('projects only the selected public initial-data row when no later detail GET occurs', () => {
  const projected: unknown = runInNewContext(publicDataProbe(target), {
    document: { readyState: 'complete' }, window: { _ROUTER_DATA: { loaderData: { video: { videoInfoRes: { item_list: [
      { aweme_id: '7692443246022167852', statistics: { digg_count: 999 } },
      { aweme_id: target, statistics: stats, author: { uid: 'PRIVATE' }, token: 'PRIVATE' },
    ] } } } } },
  })
  expect(typeof projected).toBe('string')
  expect(JSON.stringify(projected)).not.toMatch(/PRIVATE|999/)
  expect(publicData(String(projected), target, observedAt, comments)?.counts.digg_count).toEqual({ value: 12, precision: 'exact' })
})

function actionPage(extra = ''): JSDOM {
  const dom = new JSDOM(`<video></video><div>
    <div><svg></svg><span>13</span></div><div><svg></svg><span>4</span></div>
    <div><svg></svg><span>1</span></div><div data-e2e="video-share-icon-container"><svg></svg><span>3</span></div>
  </div>${extra}`)
  Object.defineProperty(dom.window.document, 'readyState', { value: 'complete' })
  Object.defineProperty(dom.window.document.querySelector('video'), 'readyState', { value: 2 })
  dom.window.HTMLElement.prototype.getBoundingClientRect = () => ({
    x: 0, y: 0, top: 0, left: 0, bottom: 20, right: 20, width: 20, height: 20, toJSON: () => ({}),
  })
  return dom
}

it('reads the normal visible action strip without inferring unavailable public views', () => {
  const dom = actionPage('<aside><span>999</span></aside>')
  try {
    const projected: unknown = runInNewContext(publicDataProbe(target), { document: dom.window.document, window: dom.window })
    expect(typeof projected).toBe('string')
    const result = publicData(String(projected), target, observedAt, comments)
    expect(result?.counts).toEqual({ play_count: { value: null, precision: 'unavailable', reason: 'not-exposed' },
      digg_count: { value: 13, precision: 'exact' }, comment_count: { value: 4, precision: 'exact' },
      collect_count: { value: 1, precision: 'exact' }, share_count: { value: 3, precision: 'exact' } })
    expect(String(projected)).not.toContain('999')
  } finally { dom.window.close() }
})

it.each([
  '<video></video>', '<div data-e2e="video-share-icon-container"><svg></svg><span>99</span></div>',
])('refuses multiple players or multiple visible share anchors %#', (extra) => {
  const dom = actionPage(extra)
  try { expect(runInNewContext(publicDataProbe(target), { document: dom.window.document, window: dom.window })).toBeNull() }
  finally { dom.window.close() }
})

it('preserves rounded display precision, zero counters and missing labels from the action strip', () => {
  const result = publicData(JSON.stringify({ kind: 'public-action-strip', targetVideoId: target,
    displays: ['8.14万', '0', '收藏', '1.2亿'] }), target, observedAt, comments)
  expect(result?.counts).toMatchObject({ digg_count: { value: 81400, precision: 'rounded', display: '8.14万' },
    comment_count: { value: 0, precision: 'exact' }, collect_count: { value: null, precision: 'unavailable' },
    share_count: { value: 120000000, precision: 'rounded', display: '1.2亿' } })
  expect(publicData(JSON.stringify({ kind: 'public-action-strip', targetVideoId: '7692443246022167852',
    displays: ['13', '4', '1', '3'] }), target, observedAt, comments)).toBeUndefined()
})

it.each([
  { document: { readyState: 'loading' }, window: {} },
  { document: { readyState: 'complete', querySelectorAll: () => [] }, window: {} },
  { document: { readyState: 'complete' }, window: { _ROUTER_DATA: { loaderData: { video: { videoInfoRes: { item_list: [
    { aweme_id: target, statistics: stats }, { aweme_id: target, statistics: stats },
  ] } } } } } },
])('rejects loading, missing and ambiguous initial public data %#', (value) => {
  expect(runInNewContext(publicDataProbe(target), value)).toBeNull()
})

it.each([undefined, null])('reports a missing counter for %s', (value) => {
  expect(providerCount(value)).toEqual({ value: null, precision: 'unavailable', reason: 'missing' })
})

it.each([-1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1, '12', true, [], {}])(
  'reports an invalid counter for %s without coercing it', (value) => {
    expect(providerCount(value)).toEqual({ value: null, precision: 'unavailable', reason: 'invalid' })
  },
)

it.each([0, 1, Number.MAX_SAFE_INTEGER])('retains an exact nonnegative safe integer %s', (value) => {
  expect(providerCount(value)).toEqual({ value, precision: 'exact' })
})

it.each([
  '{', 'null', '[]', '{}', body(stats, '7692443246022167852'),
  JSON.stringify({ status_code: 1, aweme_detail: { aweme_id: target, statistics: stats } }),
  JSON.stringify({ aweme_detail: { aweme_id: target } }),
  JSON.stringify({ aweme_detail: { aweme_id: target, statistics: [] } }),
])('refuses malformed, blocked or differently associated detail data', (value) => {
  expect(publicData(value, target, observedAt, comments)).toBeUndefined()
})

it('refuses an oversized detail response before JSON parsing', () => {
  expect(publicData(' '.repeat(PROVIDER_MAX_BYTES + 1), target, observedAt, comments)).toBeUndefined()
})

it('keeps total comment count separate from retrieved comment items', () => {
  const result = publicData(body({ ...stats, comment_count: 500 }), target, observedAt,
    { status: 'blocked', items: [], cursor: null, hasMore: null, code: 'COMMENTS_UNAVAILABLE' })
  expect(result?.counts.comment_count).toEqual({ value: 500, precision: 'exact' })
  expect(result?.comments).toEqual({ status: 'blocked', items: [], cursor: null, hasMore: null,
    code: 'COMMENTS_UNAVAILABLE' })
})

it('reads the exact permitted own-work list row, retaining a real zero view count', () => {
  const own = { aweme_id: target, statistics: { ...stats, aweme_id: target, play_count: 0 }, author: { uid: 'PRIVATE' } }
  const response = JSON.stringify({ status_code: 0, aweme_list: [{ aweme_id: '7692443246022167852' }, own], can_modify: [false, true], has_more: true })
  const result = creatorData(response, target, observedAt, comments)
  expect(result).toMatchObject({ ownList: true, hasMore: true, data: { source: 'creator-page', targetVideoId: target,
    counts: { play_count: { value: 0, precision: 'exact' }, digg_count: { value: 12, precision: 'exact' } } } })
  expect(JSON.stringify(result)).not.toContain('PRIVATE')
})

it.each([
  { status_code: 1, aweme_list: [], can_modify: [] },
  { status_code: 0, aweme_list: [], can_modify: [true] },
  { status_code: 0, aweme_list: [], can_modify: 'true' },
  { status_code: 0, aweme_list: [1], can_modify: [1] },
])('refuses unverified Creator permissions and malformed lists %#', (value) => {
  expect(creatorData(JSON.stringify(value), target, observedAt, comments)).toEqual({ ownList: false, hasMore: false })
})

it.each([
  { aweme_list: [{ aweme_id: target, statistics: { ...stats, aweme_id: target } }], can_modify: [false] },
  { aweme_list: [{ aweme_id: target, statistics: { ...stats, aweme_id: '7692443246022167852' } }], can_modify: [true] },
  { aweme_list: [{ aweme_id: Number(target), statistics: { ...stats, aweme_id: target } }], can_modify: [true] },
])('never substitutes an unowned, mismatched or rounded numeric work identity %#', (value) => {
  expect(creatorData(JSON.stringify({ status_code: 0, has_more: false, ...value }), target, observedAt, comments))
    .toEqual({ ownList: true, hasMore: false })
})
