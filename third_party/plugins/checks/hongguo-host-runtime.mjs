/** Exercise recovered metadata tools through the current Host registry without network access. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import * as Hongguo from './src/index.js'

const routed = (key, data) => `<script>_ROUTER_DATA = ${JSON.stringify({ loaderData: { [key]: data } })};</script>`
const id = '7687919221593885758'
function response(url) {
  const target = new URL(url)
  assert.equal(target.origin, 'https://hongguoduanju.com')
  let html
  if (target.pathname.startsWith('/search/')) {
    html = routed('search_(keyword)/page', { isSuccess: true, query: decodeURIComponent(target.pathname.slice(8)), totalCount: '100',
      searchList: [{ doc_type: 23, video_data: { series_id: id, series_title: '样例短剧', favorite_text: '120万收藏' } }] })
  } else if (target.pathname === '/detail') {
    html = routed('detail_page', { isSuccess: true, seriesDetail: { series_id: id, series_name: '样例短剧', episode_cnt: 20, tags: [], celebrities: [] },
      seriesSocialInfo: { series_favorite_count: '1200123', series_like_count: '900', hot_score_data: { score: '2001', text: '2001热度' } } })
  } else {
    const board = target.pathname.split('/').at(-1)
    html = routed(`rank_${board}/page`, { pageNum: 1, updatedText: '10月2日已更新', content: { isSuccess: true,
      rankList: [{ seriesId: id, title: '样例短剧', rank: 1, favoriteText: '124.3万收藏', likeText: '10万点赞', heatText: '200万热度', episodeVids: ['1', '2'], tags: ['爱情'], description: '介绍' }],
      pagination: { pageNum: 1, totalPages: 1 } } })
  }
  return new Response(html, { headers: { 'content-type': 'text/html' } })
}

test('current Host validates four canonical results and removes registrations on unload', async () => {
  const ctx = new Context()
  const originalFetch = globalThis.fetch
  let requests = 0
  globalThis.fetch = async url => { requests++; return response(url) }
  try {
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(Tools)
    const handle = await ctx.plugin(Hongguo, { requestIntervalMs: 0 })
    assert.equal(ctx.tools.schemas().length, 4)
    const prompt = await ctx.systemPrompt.assemble()
    assert.equal(prompt.tools.length, 4)
    assert(prompt.tools.every(tool => /红果/u.test(tool.description)))
    for (const [name, args] of [
      ['hongguo_search', { query: '剧' }], ['hongguo_detail', { seriesId: id }],
      ['hongguo_rankings', {}], ['hongguo_collections', {}],
    ]) {
      const result = await ctx.tools.execute({ signal: new AbortController().signal, callId: ToolCallId(name), name, arguments: args })
      assert.equal(result.isError, false, JSON.stringify(result))
      assert.deepEqual(JSON.parse(result.content[0].text), result.value)
    }
    const bad = await ctx.tools.execute({ signal: new AbortController().signal, callId: ToolCallId('invalid'), name: 'hongguo_detail', arguments: { seriesId: 123 } })
    assert.equal(bad.isError, true)
    const beforeAbort = requests
    const controller = new AbortController()
    controller.abort()
    const aborted = await ctx.tools.execute({ signal: controller.signal, callId: ToolCallId('cancelled'), name: 'hongguo_search', arguments: { query: '剧' } })
    assert.equal(aborted.isError, true)
    assert.equal(requests, beforeAbort)
    await handle.dispose()
    assert.equal(ctx.tools.schemas().length, 0)
  } finally {
    await ctx.fiber.dispose()
    globalThis.fetch = originalFetch
  }
})
