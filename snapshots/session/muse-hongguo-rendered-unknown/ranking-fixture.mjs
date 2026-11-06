/** Preserve unsupported displayed metrics through the real ranking tool and canonical model replay. */
import assert from 'node:assert/strict'
import { isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const pluginRoot = process.env.HONGGUO_PLUGIN_ROOT
if (pluginRoot !== undefined) {
  assert.equal(process.env.DSH_EXAMPLE_MODE, 'lib', 'The owned plugin copy requires the built lane')
  assert.ok(isAbsolute(pluginRoot), 'The owned plugin override must be an absolute local directory')
}
const hongguo = await import(pluginRoot === undefined
  ? new URL('../../../third_party/plugins/muse-hongguo-search/src/index.js', import.meta.url).href
  : pathToFileURL(join(pluginRoot, 'src/index.js')).href)
const stamp = Date.parse('2026-11-04T12:00:00.000Z')
const sourceUrl = 'https://hongguoduanju.com/rank/hot-comic-drama'
const route = 'rank_hot-comic-drama/page'
const pending = JSON.stringify([route, [{ key: 'content', routerDataFnName: 's', routerDataFnArgs: ['"pending"', '"content"'] }]])
  .replaceAll('&', '&amp;').replaceAll('"', '&quot;')
const samples = [
  { id: '7100000000000000021', rank: 1, title: '未解析数值样本', collection: ['-12收藏', null, false, null], likes: ['1e3点赞', null, false, null], heat: ['约200万热度', null, false, null] },
  { id: '7100000000000000022', rank: 2, title: '暂无与零值样本', collection: ['暂无收藏', null, false, null], likes: ['0点赞', 0, false, 1], heat: ['1.2万热度', 12000, true, 1000] },
  { id: '7100000000000000023', rank: 3, title: '有效单位样本', collection: ['0收藏', 0, false, 1], likes: ['1.2万点赞', 12000, true, 1000], heat: ['2亿热度', 200000000, true, 100000000] },
]
const cards = samples.map(sample => `<article aria-labelledby="rank-title-${sample.id}">
<span class="pc-badge-number-fixture">${sample.rank}</span><h2 id="rank-title-${sample.id}">${sample.title}</h2>
<p class="pc-description-fixture">合成指标样本</p><p class="pc-categories-fixture"><span>测试</span></p>
<ul aria-label="作品互动数据"><li>${sample.collection[0]}</li><li>${sample.likes[0]}</li></ul>
<p class="pc-metrics-fixture">${sample.heat[0]}</p></article>`).join('\n')
const html = `<script>_ROUTER_DATA=${JSON.stringify({ loaderData: { [route]: { pageNum: 1, canonicalUrl: sourceUrl, updatedText: '11月4日已更新' } } })};</script>
<script data-fn-name="mergeLoaderData" data-fn-args="${pending}"></script>
${cards}
<nav aria-label="榜单分页"><a href="/rank/hot-comic-drama">1</a></nav>`

/** Loader name for controlled public HTML with unsupported displayed counts. */
export const name = 'snapshot-hongguo-rendered-unknown'
/** Real model stream, tool registry and canonical replay are provided by Headless. */
export const inject = ['llm', 'tools']

function verify(value) {
  assert.equal(value.items.length, samples.length)
  assert.equal(value.coverage.complete, true)
  assert.equal(value.coverage.metrics.complete, false)
  assert.equal(value.coverage.metrics.observations, 3)
  for (const [index, sample] of samples.entries()) {
    const item = value.items[index]
    assert.equal(item.seriesId, sample.id); assert.equal(item.title, sample.title)
    assert.equal(item.observations.length, 1)
    const observation = item.observations[0]
    assert.equal(observation.rank, sample.rank)
    assert.equal(observation.sourceFormat, 'rendered_html')
    assert.equal(observation.sourceUrl, sourceUrl)
    const missing = []
    for (const field of ['collection', 'likes', 'heat']) {
      const [raw, count, approximate, precisionStep] = sample[field]
      const expected = { raw, value: count, approximate, precisionStep }
      assert.deepEqual(item[field], expected, `${sample.id}.${field}: displayed raw count must survive intact`)
      assert.deepEqual(observation[field], expected)
      if (count === null) missing.push({ field, reason: 'unparseable' })
    }
    assert.deepEqual(observation.missingMetrics, missing)
  }
  assert.deepEqual(value.coverage.metrics.fields, {
    collection: { known: 1, missing: 2, complete: false },
    likes: { known: 2, missing: 1, complete: false },
    heat: { known: 2, missing: 1, complete: false },
  })
}

/** @param {import('@deepseek-ai/cordis').Context} ctx - Isolated shipped Headless services. */
export async function apply(ctx) {
  let pageRequests = 0, modelRequests = 0, resultSeenByModel = false
  ctx.effect(() => {
    const originalFetch = globalThis.fetch
    const originalNow = Date.now
    globalThis.fetch = async (input, options) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
      assert.equal(url.href, sourceUrl, 'This keyless fixture refuses every unrelated network request')
      options?.signal?.throwIfAborted()
      pageRequests++
      return new Response(html, { headers: { 'content-type': 'text/html' } })
    }
    Date.now = () => stamp
    return () => { globalThis.fetch = originalFetch; Date.now = originalNow }
  })
  await ctx.plugin(hongguo, { requestIntervalMs: 0 })
  ctx.on('llm/stream', async function* (options, next) {
    modelRequests++
    assert.ok((options.tools ?? []).some(tool => tool.name === 'hongguo_rankings'))
    const result = options.messages.find(message => message.role === 'tool' && message.toolCallId === 'rendered-unsupported-metrics')
    if (result !== undefined) {
      assert.equal(result.isError, false)
      const block = result.content.find(item => item.type === 'text')
      assert.ok(block)
      verify(JSON.parse(block.text))
      resultSeenByModel = true
    }
    yield* next()
  })
  ctx.on('agent/turn-stopping', ({ agent }) => {
    assert.equal(pageRequests, 1)
    assert.equal(modelRequests, 2)
    assert.equal(resultSeenByModel, true)
    const events = agent.session.snapshotEvents()
    const calls = events.filter(event => event.type === 'tool/call')
    assert.deepEqual(calls.map(event => [event.data.name, JSON.parse(event.data.arguments)]), [
      ['hongguo_rankings', { boards: ['hot-comic-drama'], refresh: true }],
    ])
    const results = events.filter(event => event.type === 'tool/result')
    assert.equal(results.length, 1)
    const block = results[0].data.message.content.find(item => item.type === 'text')
    assert.ok(block); verify(JSON.parse(block.text))
    const last = events.filter(event => event.type === 'assistant/message').at(-1)
    assert.ok(last?.data.message.content.some(item => item.type === 'text' && item.text.includes('未知')))
  })
}
