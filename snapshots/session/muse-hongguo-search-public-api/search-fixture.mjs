/** Public JSON search and restricted pages run through the registered tool without network access. */
import assert from 'node:assert/strict'
import { isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { importSnapshotPackage } from '../muse-fixture-import.mjs'

const owner = new URL('../../../apps/desktop-host/package.json', import.meta.url)
const { LlmAdapter, ToolCallId } = await importSnapshotPackage('@deepseek-ai/dsh-llm', owner)
const pluginRoot = process.env.HONGGUO_PLUGIN_ROOT
if (pluginRoot !== undefined) {
  assert.equal(process.env.DSH_EXAMPLE_MODE, 'lib')
  assert.ok(isAbsolute(pluginRoot))
}
const hongguo = await import(pluginRoot === undefined
  ? new URL('../../../third_party/plugins/muse-hongguo-search/src/index.js', import.meta.url).href
  : pathToFileURL(join(pluginRoot, 'src/index.js')).href)
const provider = 'hongguo-public-search-fixture'
const stamp = Date.parse('2026-11-10T03:00:00Z')
const origin = 'https://hongguoduanju.com'
const keyword = '二嫁样本'
const privateMarker = 'fixture_private_response_must_not_leak'
const items = Array.from({ length: 10 }, (_, index) => ({ doc_type: 23,
  video_data: { series_id: (7700000000000000001n + BigInt(index)).toString(),
    series_title: `红果搜索修复样本${index + 1}`, episode_cnt: 12, episode_right_text: '12集全',
    favorite_text: index === 0 ? '120万收藏' : '0收藏', like_text: '2万点赞',
    hot_score_data: { score: 2000000, text: '200万热度' }, category_list: [{ category_id: '1', name: '测试' }] } }))
const steps = [
  { id: 'search-public-json', query: keyword, offset: 0, limit: 2, kind: 'success' },
  { id: 'search-cached-window', query: keyword, offset: 1, limit: 1, kind: 'success' },
  { id: 'search-verified-empty', query: '空窗口样本', offset: 0, limit: 2, kind: 'empty' },
  { id: 'search-json-error', query: 'JSON错误样本', offset: 0, limit: 2, kind: 'json-error' },
  { id: 'search-html-shell', query: '受限壳页样本', offset: 0, limit: 2, kind: 'html-shell' },
]
const sourceUrl = query => `${origin}/api/search/result?query=${encodeURIComponent(query)}`

function verifyResult(message, step) {
  assert.equal(message.toolCallId, step.id)
  const text = message.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
  if (step.kind === 'json-error' || step.kind === 'html-shell') {
    assert.equal(message.isError, true, 'A restricted/error response must not become an empty successful search')
    assert.match(text, /HONGGUO_SEARCH_UNAVAILABLE/u)
    assert.ok(!text.includes(privateMarker), 'Raw restricted responses must not enter model-visible errors')
    return
  }
  assert.equal(message.isError, false)
  const value = JSON.parse(text)
  assert.equal(value.scope, 'public_keyword_search_initial_window')
  assert.equal(value.query, step.query)
  assert.equal(value.sourceUrl, sourceUrl(step.query))
  assert.equal(value.fetchedAt, '2026-11-10T03:00:00.000Z')
  assert.equal(value.complete, false, 'One returned window must not claim whole-library coverage')
  assert.equal(value.fromCache, step.id === 'search-cached-window')
  if (step.kind === 'empty') {
    assert.deepEqual(value.items, [])
    assert.equal(value.availableInWindow, 0)
    assert.equal(value.sourceReportedTotal, '0')
    assert.equal(value.truncated, false)
    return
  }
  assert.equal(value.availableInWindow, 10)
  assert.equal(value.sourceReportedTotal, '204')
  assert.equal(value.truncated, true)
  assert.equal(value.offset, step.offset)
  assert.equal(value.limit, step.limit)
  assert.equal(value.items.length, step.limit)
  assert.deepEqual(value.items.map(item => item.seriesId), items.slice(step.offset, step.offset + step.limit)
    .map(item => item.video_data.series_id))
  assert.deepEqual(value.items.map(item => item.title), items.slice(step.offset, step.offset + step.limit)
    .map(item => item.video_data.series_title))
  assert.equal(value.items[0].episodeCount, 12)
  assert.equal(value.items[0].collection.value, step.offset === 0 ? 1200000 : 0)
}

function* response(step) {
  if (step === undefined) {
    const text = '已读取红果公开搜索首屏；分页仅切分已返回窗口。已区分合法空窗口与JSON错误、受限壳页，错误不当作没有搜索结果。'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
    return
  }
  const args = JSON.stringify({ query: step.query, offset: step.offset, limit: step.limit })
  yield { type: 'block-start', index: 0, blockType: 'tool-call' }
  yield { type: 'tool-call-delta', index: 0, id: ToolCallId(step.id), name: 'hongguo_search', argumentsDelta: args }
  yield { type: 'block-end', index: 0,
    block: { type: 'tool-call', id: ToolCallId(step.id), name: 'hongguo_search', arguments: args } }
  yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
  yield { type: 'finish', reason: { kind: 'tool-calls' } }
}
class SearchAdapter extends LlmAdapter {
  constructor(state) { super(); this.state = state }
  async *stream() { yield* response(steps[this.state.results.length]) }
}

/** Loader identity for public JSON and explicit error-window cases. */
export const name = 'snapshot-hongguo-search-public-api'
/** The shipped profile owns model requests and registered tool execution. */
export const inject = ['llm', 'tools']

/** Install exact public responses and verify the next model request receives the actual tool outcome.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Isolated Headless services.
 * @returns {Promise<void>} Fixture readiness; unload restores all process-global replacements.
 */
export async function apply(ctx) {
  const state = { requests: [], results: [] }
  ctx.effect(() => {
    const priorFetch = globalThis.fetch, priorNow = Date.now
    globalThis.fetch = async (input, options) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
      assert.equal(url.origin, origin, 'No unrelated or external network request is allowed')
      assert.equal(url.pathname, '/api/search/result', 'Search must use the current public JSON endpoint')
      assert.deepEqual([...url.searchParams.keys()], ['query'])
      options?.signal?.throwIfAborted()
      const query = url.searchParams.get('query')
      assert.ok(steps.some(step => step.query === query), 'Only declared public search fixtures are available')
      state.requests.push(query)
      if (query === '受限壳页样本') return new Response(`<html><body>请完成验证 ${privateMarker}</body></html>`,
        { headers: { 'content-type': 'text/html; charset=utf-8' } })
      const body = query === 'JSON错误样本' ? { code: 1, message: privateMarker }
        : query === '空窗口样本' ? { searchList: [], totalCount: '0', pageNum: 1, totalPages: 0, hasMore: false }
          : { searchList: items, totalCount: '204', pageNum: 1, totalPages: 21, hasMore: true, accessibleEpisodeCnt: 5 }
      return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json; charset=utf-8' } })
    }
    Date.now = () => stamp
    return () => { globalThis.fetch = priorFetch; Date.now = priorNow }
  })
  await ctx.plugin(hongguo, { requestIntervalMs: 0, incompletePageRetries: 0 })
  ctx.on('llm/stream', async function* (options, next) {
    if (options.provider !== provider || options.purpose !== undefined) { yield* next(); return }
    assert.ok(options.tools.some(tool => tool.name === 'hongguo_search'))
    const result = options.messages.findLast(message => message.role === 'tool')
    if (result && result.toolCallId !== state.results.at(-1)) {
      const step = steps[state.results.length]
      assert.ok(step, 'No extra model-visible tool result was expected')
      verifyResult(result, step)
      state.results.push(result.toolCallId)
    }
    yield* next()
  })
  ctx.on('agent/turn-stopping', ({ agent }) => {
    assert.deepEqual(state.requests, [keyword, '空窗口样本', 'JSON错误样本', '受限壳页样本'])
    assert.deepEqual(state.results, steps.map(step => step.id))
    const events = agent.session.snapshotEvents()
    assert.deepEqual(events.filter(event => event.type === 'tool/call').map(event => event.data.name),
      steps.map(() => 'hongguo_search'))
    const results = events.filter(event => event.type === 'tool/result')
    assert.equal(results.length, steps.length)
    results.forEach((event, index) => verifyResult(event.data.message, steps[index]))
  })
  if (!process.env.DSH_SNAPSHOT || process.env.DSH_SNAPSHOT === 'record') {
    ctx.effect(() => ctx.llm.registerAdapter([provider], new SearchAdapter(state)))
  }
}
