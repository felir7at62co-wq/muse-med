import { expect, it } from 'vitest'
import { runInNewContext } from 'node:vm'
import { JSDOM } from 'jsdom'
import type { DouyinDataSnapshot, DouyinVideoId } from '@deepseek-ai/dsh-client-ui-sidebar-browser/types'
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
    metadata: { description: null, authorName: null, publishedAt: null },
    counts: { play_count: { value: 8675309, precision: 'exact' },
      digg_count: { value: 12, precision: 'exact' }, comment_count: { value: 0, precision: 'exact' },
      share_count: { value: 2, precision: 'exact' }, collect_count: { value: 3, precision: 'exact' } }, comments })
  expect(JSON.stringify(result)).not.toMatch(/private|play_addr|sec_uid|token/)
})

it('returns bounded public metadata from the exact work even without statistics', () => {
  const value = JSON.stringify({ aweme_detail: { aweme_id: target, desc: '第一集', create_time: 1790000000,
    author: { nickname: '短剧作者', sec_uid: 'PRIVATE' }, video: { url: 'PRIVATE' } } })
  const result = publicData(value, target, observedAt, comments)
  expect(result?.metadata).toEqual({ description: '第一集', authorName: '短剧作者', publishedAt: 1790000000 })
  expect(result?.counts.digg_count).toEqual({ value: null, precision: 'unavailable', reason: 'missing' })
  expect(JSON.stringify(result)).not.toContain('PRIVATE')
  expect(publicData(value, '7692443246022167852' as DouyinVideoId, observedAt, comments)).toBeUndefined()
})

it('refuses oversized and control-bearing fields rather than forwarding them', () => {
  const value = JSON.stringify({ aweme_detail: { aweme_id: target, statistics: stats,
    desc: 'x'.repeat(5001), author: { nickname: 'bad\u0000name' }, create_time: -1 } })
  expect(publicData(value, target, observedAt, comments)?.metadata)
    .toEqual({ description: null, authorName: null, publishedAt: null })
})

it('projects only bounded selected initial metadata, preserving unavailable fields', () => {
  const data = { document: { readyState: 'complete' }, window: { _ROUTER_DATA: { loaderData: { video: { videoInfoRes: { item_list: [
    { aweme_id: '7692443246022167852', desc: 'OTHER', author: { nickname: 'OTHER' } },
    { aweme_id: target, desc: '作品文案', author: { nickname: '作者', sec_uid: 'PRIVATE' }, create_time: 1790000000 },
  ] } } } } } }
  const projected = String(runInNewContext(publicDataProbe(target), data))
  expect(publicData(projected, target, observedAt, comments)?.metadata)
    .toEqual({ description: '作品文案', authorName: '作者', publishedAt: 1790000000 })
  expect(projected).not.toMatch(/OTHER|PRIVATE/)
})

it('refuses an oversized initial-data scan and duplicate creator rows', () => {
  const rows = [{ aweme_id: target, statistics: stats }, ...Array.from({ length: 16 }, () => ({}))]
  expect(runInNewContext(publicDataProbe(target), { document: { readyState: 'complete' },
    window: { _ROUTER_DATA: { loaderData: { video: { videoInfoRes: { item_list: rows } } } } } })).toBeNull()
  const row = { aweme_id: target, statistics: { ...stats, aweme_id: target } }
  const duplicate = JSON.stringify({ status_code: 0, aweme_list: [row, row], can_modify: [true, true] })
  expect(creatorData(duplicate, target, observedAt, comments).data).toBeUndefined()
  expect(publicData(JSON.stringify({ aweme_detail: { aweme_id: target, desc: '错误统计目标',
    statistics: { aweme_id: '7692443246022167852', digg_count: 1 } } }), target, observedAt, comments)).toBeUndefined()
})

function seriesPage(markup = `<section><h2>短剧 · 重生换亲娶千金</h2><ul>
  <li><a href="/video/${target}" aria-label="短剧 · 重生换亲娶千金第1集 播放中">第1集</a></li>
  <li><a href="/video/7692443246022167852">第2集</a></li></ul></section>`): JSDOM {
  const dom = new JSDOM(markup, { url: `https://www.douyin.com/video/${target}` })
  Object.defineProperty(dom.window.document, 'readyState', { value: 'complete' })
  dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
    const visible = !this.closest('[data-hidden]')
    return { x: 0, y: 0, top: 0, left: 0, bottom: 20, right: 20, width: visible ? 20 : 0,
      height: visible ? 20 : 0, toJSON: () => ({}) }
  }
  return dom
}

function readPage(dom: JSDOM): DouyinDataSnapshot | undefined {
  const body: unknown = runInNewContext(publicDataProbe(target), { document: dom.window.document, window: dom.window, URL })
  return typeof body === 'string' ? publicData(body, target, observedAt, comments, true) : undefined
}

it('reads an exactly bound visible series even before counters are ready', () => {
  const dom = seriesPage()
  try {
    const value = readPage(dom)
    expect(value?.metadata).toMatchObject({ seriesTitle: '重生换亲娶千金', seriesSource: 'visible-series-list' })
    expect(value?.counts.digg_count).toEqual({ value: null, precision: 'unavailable', reason: 'missing' })
  } finally { dom.window.close() }
})

it('reads visible text fragments in one DIV while excluding hidden descendants', () => {
  const dom = seriesPage(`<div><h2>短剧 · My Life</h2><ul><li><a href="/video/${target}">
    <span>短剧 · My Life</span><span data-hidden>无关隐藏文字</span><span>第1集 播放中</span>
    </a></li></ul></div>`)
  try {
    expect(readPage(dom)?.metadata).toMatchObject({ seriesTitle: 'My Life', seriesSource: 'visible-series-list' })
  } finally { dom.window.close() }
})

it.each(['播放中', '第1集 播放中', '短剧 · 甲第1集 播放中'])(
  'binds a selected playing entry with the supported label %s', (active) => {
    const dom = seriesPage(`<div><h2>短剧 · 甲</h2><ul><li><a href="/video/${target}">${active}</a>
      <h3><a href="/video/${target}">第1集 | #AI短剧</a></h3></li></ul></div>`)
    try { expect(readPage(dom)?.metadata?.seriesTitle).toBe('甲') } finally { dom.window.close() }
  },
)

it('ignores an explicitly hidden conflicting episode in the selected entry', () => {
  const dom = seriesPage(`<div><h2>短剧 · 甲</h2><ul><li><a href="/video/${target}">播放中</a>
    <a href="/video/${target}"><span>第1集</span><span data-hidden>第2集</span></a></li></ul></div>`)
  try { expect(readPage(dom)?.metadata?.seriesTitle).toBe('甲') } finally { dom.window.close() }
})

it('accepts an explicit episode in a visible non-link sibling of the selected link', () => {
  const dom = seriesPage(`<div><h2>短剧 · 甲</h2><ul><li><a href="/video/${target}">播放中</a><span>第1集</span></li></ul></div>`)
  try { expect(readPage(dom)?.metadata?.seriesTitle).toBe('甲') } finally { dom.window.close() }
})

it('accepts a matching series label split across visible text nodes', () => {
  const dom = seriesPage(`<div><h2>短剧 · 甲</h2><ul><li><a href="/video/${target}">播放中</a>
    <span>短剧</span><span> · 甲第1集</span></li></ul></div>`)
  try { expect(readPage(dom)?.metadata?.seriesTitle).toBe('甲') } finally { dom.window.close() }
})

it('refuses visible text when its bounded node scan overflows', () => {
  const markup = `<div><h2>短剧 · 甲</h2><ul><li><a href="/video/${target}">
    <span>短剧 · 甲第1集 播放中</span>${'<span></span>'.repeat(128)}</a></li></ul></div>`
  const dom = seriesPage(markup)
  try { expect(readPage(dom)).toBeUndefined() } finally { dom.window.close() }
})

it('combines the bound series with the visible target action strip', () => {
  const dom = seriesPage(`<section><h2>短剧 · 重生换亲娶千金</h2><ul><li><a href="/video/${target}"
    aria-label="短剧 · 重生换亲娶千金第1集 播放中">第1集</a></li></ul></section><video></video><div>
    <div><svg></svg><span>13</span></div><div><svg></svg><span>4</span></div>
    <div><svg></svg><span>1</span></div><div data-e2e="video-share-icon-container"><svg></svg><span>3</span></div></div>`)
  Object.defineProperty(dom.window.document.querySelector('video'), 'readyState', { value: 2 })
  try {
    const value = readPage(dom)
    expect(value?.metadata?.seriesTitle).toBe('重生换亲娶千金')
    expect(value?.counts.digg_count).toEqual({ value: 13, precision: 'exact' })
  } finally { dom.window.close() }
})

it('preserves spaces in the original visible series title', () => {
  const dom = seriesPage(`<section><h2>短剧 · My Life</h2><ul><li><a href="/video/${target}"
    aria-label="短剧 · My Life 第1集 播放中">第1集</a></li></ul></section>`)
  try { expect(readPage(dom)?.metadata?.seriesTitle).toBe('My Life') } finally { dom.window.close() }
})

it('ignores a regular episode caption when the complete series label identifies the target', () => {
  const dom = seriesPage(`<section><h2>短剧 · My Life</h2><ul><li><a href="/video/${target}"
    aria-label="短剧 · My Life 第1集 播放中">第1集 | #AI短剧</a></li></ul></section>`)
  try { expect(readPage(dom)?.metadata?.seriesTitle).toBe('My Life') } finally { dom.window.close() }
})

it.each([
  `<section><h2>短剧 · 错误标题</h2><ul><li><a href="/video/${target}" aria-label="短剧 · 重生换亲娶千金第1集 播放中">第1集</a></li></ul></section>`,
  '<section><h2>短剧 · 重生换亲娶千金</h2><ul><li><a href="/video/7692443246022167852" aria-label="短剧 · 重生换亲娶千金第1集 播放中">第1集</a></li></ul></section>',
  `<section><h2 data-hidden>短剧 · 重生换亲娶千金</h2><ul><li><a href="/video/${target}" aria-label="短剧 · 重生换亲娶千金第1集 播放中">第1集</a></li></ul></section>`,
  `<section><h2>短剧 · 重生换亲娶千金</h2><h2>短剧 · 另一部</h2><ul><li><a href="/video/${target}" aria-label="短剧 · 重生换亲娶千金第1集 播放中">第1集</a></li></ul></section>`,
  `<section><h2>短剧 · 重生换亲娶千金</h2><ul>${Array.from({ length: 2 }, () => `<li><a href="/video/${target}" aria-label="短剧 · 重生换亲娶千金第1集 播放中">第1集</a></li>`).join('')}</ul></section>`,
  `<section><h2>短剧 · 重生换亲娶千金</h2><ul><li><a href="/video/${target}" aria-label="短剧 · 重生换亲娶千金第1集 播放中" title="短剧 · 另一部第1集 播放中">第1集</a></li></ul></section>`,
  `<section><h2>短剧 · 重生换亲娶千金</h2><ul><li><a href="/video/${target}" aria-label="短剧 · 重生换亲娶千金第1集 播放中">第1集</a></li>${'<li><a href="/video/1">推荐</a></li>'.repeat(64)}</ul></section>`,
  `<section><h2>短剧 · 重生换亲娶千金</h2><ul><li><a href="https://name@www.douyin.com/video/${target}" aria-label="短剧 · 重生换亲娶千金第1集 播放中">第1集</a></li></ul></section>`,
  `<section><h2>短剧 · 重生换亲娶千金</h2><ul><li><a href="https://www.douyin.com:8443/video/${target}" aria-label="短剧 · 重生换亲娶千金第1集 播放中">第1集</a></li></ul></section>`,
  `<section><h2>短剧 · 重生换亲娶千金</h2><ul><li><a href="/video/${target}?modal_id=7692443246022167852" aria-label="短剧 · 重生换亲娶千金第1集 播放中">第1集</a></li></ul></section>`,
  `<section><h2>短剧 · 重生换亲娶千金</h2><ul><li><a href="/video/${target}"><span data-hidden>短剧 · 重生换亲娶千金第1集 播放中</span></a></li></ul></section>`,
  `<section><h2 style="visibility:hidden">短剧 · 重生换亲娶千金</h2><ul><li><a href="/video/${target}" aria-label="短剧 · 重生换亲娶千金第1集 播放中">第1集</a></li></ul></section>`,
  `<div style="visibility:hidden"><section><h2>短剧 · 重生换亲娶千金</h2><ul><li><a href="/video/${target}" aria-label="短剧 · 重生换亲娶千金第1集 播放中">第1集</a></li></ul></section></div>`,
  `<section><h2 style="clip-path:inset(100%)">短剧 · 重生换亲娶千金</h2><ul><li><a href="/video/${target}" aria-label="短剧 · 重生换亲娶千金第1集 播放中">第1集</a></li></ul></section>`,
  `<section><h2 style="color:transparent">短剧 · 重生换亲娶千金</h2><ul><li><a href="/video/${target}" aria-label="短剧 · 重生换亲娶千金第1集 播放中">第1集</a></li></ul></section>`,
  `<section><h2>短剧 · My Life</h2><ul><li><a href="/video/${target}" aria-label="短剧 · MyLife第1集 播放中">第1集</a></li></ul></section>`,
  `<section><h2>短剧 · 甲</h2><ul><li><a href="/video/${target}" aria-label="短剧 · 甲第1集 播放中">短剧 · 乙第1集</a></li></ul></section>`,
  `<section><h2>短剧 · 甲</h2><ul><li><a href="/video/${target}" aria-label="短剧 · 甲第1集 播放中">短剧 · 甲第2集</a></li></ul></section>`,
  `<section><aside><h2>短剧 · 甲</h2><ul><li>另一列表</li></ul></aside><ul><li><a href="/video/${target}" aria-label="短剧 · 甲第1集 播放中">第1集</a></li></ul></section>`,
  `<section><aside><h2>短剧 · 甲</h2></aside><ul><li><a href="/video/${target}" aria-label="短剧 · 甲第1集 播放中">第1集</a></li></ul></section>`,
  `<div><h2>短剧 · 甲</h2><ul><li><a href="/video/${target}"><span>短剧 · 甲第1集</span><span data-hidden> 播放中</span></a></li></ul></div>`,
  `<div><h2>短剧 · 甲</h2><ul><li><a href="/video/${target}" aria-label="短剧 · 甲第1集 播放中">第1集</a></li></ul><ul><li>其他列表</li></ul></div>`,
  `<div><aside><h2>短剧 · 甲</h2></aside><ul><li><a href="/video/${target}" aria-label="短剧 · 甲第1集 播放中">第1集</a></li></ul></div>`,
  `<div><section><h2>短剧 · 甲</h2></section><ul><li><a href="/video/${target}" aria-label="短剧 · 甲第1集 播放中">第1集</a></li></ul></div>`,
  `<div><div role="region"><h2>短剧 · 甲</h2></div><ul><li><a href="/video/${target}" aria-label="短剧 · 甲第1集 播放中">第1集</a></li></ul></div>`,
  `<div><div role="navigation"><h2>短剧 · 甲</h2></div><ul><li><a href="/video/${target}" aria-label="短剧 · 甲第1集 播放中">第1集</a></li></ul></div>`,
  `<div><div role="complementary"><h2>短剧 · 甲</h2></div><ul><li><a href="/video/${target}" aria-label="短剧 · 甲第1集 播放中">第1集</a></li></ul></div>`,
  `<div><div role="group"><h2>短剧 · 甲</h2></div><ul><li><a href="/video/${target}" aria-label="短剧 · 甲第1集 播放中">第1集</a></li></ul></div>`,
  `<div><div role="article"><h2>短剧 · 甲</h2></div><ul><li><a href="/video/${target}" aria-label="短剧 · 甲第1集 播放中">第1集</a></li></ul></div>`,
  `<div><div role="presentation navigation"><h2>短剧 · 甲</h2></div><ul><li><a href="/video/${target}" aria-label="短剧 · 甲第1集 播放中">第1集</a></li></ul></div>`,
  `<div><div role="region complementary"><h2>短剧 · 甲</h2></div><ul><li><a href="/video/${target}" aria-label="短剧 · 甲第1集 播放中">第1集</a></li></ul></div>`,
  `<div><h2>短剧 · My Life</h2><ul><li><a href="/video/${target}" aria-label="短剧 · MyLife第1集 播放中">第1集</a></li></ul></div>`,
  `<div><h2>短剧 · 甲</h2><ul><li><a href="/video/${target}">播放中</a><a href="/video/${target}">短剧 · 乙第1集</a></li></ul></div>`,
  `<div><h2>短剧 · 甲</h2><ul><li><a href="/video/${target}">第1集 播放中</a><a href="/video/${target}">第2集 | #AI短剧</a></li></ul></div>`,
  `<div><h2>短剧 · 甲</h2><ul><li><a href="/video/${target}">播放中</a></li><li><a href="/video/7692443246022167852">播放中</a></li></ul></div>`,
  `<div><h2>短剧 · 甲</h2><ul><li><a href="/video/${target}">播放中 <span>推荐</span></a></li></ul></div>`,
  `<div><h2>短剧 · 甲</h2><ul><li><a href="/video/${target}">播放中</a><a href="/video/7692443246022167852">第2集</a></li></ul></div>`,
  `<div><h2>短剧 · 甲</h2><ul><li><a href="/video/${target}">播放中</a><span>短剧 · 乙第1集</span></li></ul></div>`,
  `<div><h2>短剧 · 甲</h2><ul><li><a href="/video/${target}">第1集 播放中</a><span>第2集</span></li></ul></div>`,
  `<div><h2>短剧 · 甲</h2><ul><li><a href="/video/${target}">播放中</a><span>短剧</span><span> · 乙第1集</span></li></ul></div>`,
  `<div><h2>短剧 · 甲</h2><ul><li><a href="/video/${target}">播放中</a><span>短剧</span><span> · 甲乙第1集</span></li></ul></div>`,
])('refuses ambiguous or unrelated visible series evidence %#', (markup) => {
  const dom = seriesPage(markup)
  try { expect(readPage(dom)).toBeUndefined() } finally { dom.window.close() }
})

it.each([
  { rows: Array.from({ length: 17 }, () => ({})) },
  { rows: [{ aweme_id: target, statistics: stats }, { aweme_id: target, statistics: stats }] },
  { rows: [{ aweme_id: target, statistics: { ...stats, aweme_id: '7692443246022167852' } }] },
])('keeps the separately verified series while refusing ambiguous initial data %#', ({ rows }) => {
  const dom = seriesPage()
  Object.defineProperty(dom.window, '_ROUTER_DATA', { value: { loaderData: { page: { videoInfoRes: { item_list: rows } } } } })
  try {
    const result = readPage(dom)
    expect(result?.metadata?.seriesTitle).toBe('重生换亲娶千金')
    expect(result?.counts.digg_count).toEqual({ value: null, precision: 'unavailable', reason: 'missing' })
  } finally { dom.window.close() }
})

it('keeps a verified series when the action-strip candidate budget is exceeded', () => {
  const dom = seriesPage(`<section><h2>短剧 · 重生换亲娶千金</h2><ul><li><a href="/video/${target}"
    aria-label="短剧 · 重生换亲娶千金第1集 播放中">第1集</a></li></ul></section><video></video>
    ${'<div data-e2e="video-share-icon-container"></div>'.repeat(17)}`)
  Object.defineProperty(dom.window.document.querySelector('video'), 'readyState', { value: 2 })
  try {
    const result = readPage(dom)
    expect(result?.metadata?.seriesTitle).toBe('重生换亲娶千金')
    expect(result?.counts.digg_count).toEqual({ value: null, precision: 'unavailable', reason: 'missing' })
  } finally { dom.window.close() }
})

it('refuses a current document with a conflicting modal target', () => {
  const dom = seriesPage()
  dom.reconfigure({ url: `https://www.douyin.com/video/${target}?modal_id=7692443246022167852` })
  try { expect(readPage(dom)).toBeUndefined() } finally { dom.window.close() }
})

it('does not trust a claimed visible series in a network response', () => {
  const response = JSON.stringify({ aweme_detail: { aweme_id: target, statistics: stats },
    visibleSeries: { title: '未验证', source: 'visible-series-list' } })
  expect(publicData(response, target, observedAt, comments)?.metadata?.seriesTitle).toBeUndefined()
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

it('keeps the existing action-strip observation when series visibility rules do not apply', () => {
  const dom = actionPage()
  const share = dom.window.document.querySelector<HTMLElement>('[data-e2e="video-share-icon-container"]')
  if (share === null) throw new Error('Missing fixture share icon')
  share.style.clipPath = 'inset(100%)'
  try {
    const body: unknown = runInNewContext(publicDataProbe(target), { document: dom.window.document, window: dom.window })
    expect(typeof body).toBe('string')
    expect(publicData(String(body), target, observedAt, comments)?.counts.digg_count)
      .toEqual({ value: 13, precision: 'exact' })
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
