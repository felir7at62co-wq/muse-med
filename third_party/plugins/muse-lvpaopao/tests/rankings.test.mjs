/** Execute the owned ranking expression and public tool without a live WeChat account. */
import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'
import { readFile } from 'node:fs/promises'
import { Context } from '@deepseek-ai/cordis'
import Tools from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { registerLvpaopao } from '../src/index.ts'
import { projectResult } from '../src/result.ts'

const limits = { maxQueryChars: 80, maxResultItems: 50, maxEpisodeCount: 20, maxSeriesEpisodes: 400 }
const params = { boardType: 6, pageIndex: 1, count: 2, coldStartTime: 1792530000 }
const source = { title: '合成榜单剧', srcAppId: 'wx6522458df7ed3af2', originDramaId: '00123' }
const script = await readFile(new URL('../native/passive-probe/next-stage/operations/fixed-operation.js', import.meta.url), 'utf8')

async function evaluate(parameters, response) {
  const requests = []
  const biz = { getIsLoggedIn: () => true, bizRequest: async (action, data) => { requests.push({ action, data }); return response } }
  const modules = { 'utils/index.js': { APP_ID: 'wx404dde55fb12df78', AppBaseInfo: {}, DeviceInfo: {} },
    'utils/biz-request.js': biz, 'utils/operate-wx-data.js': { default() { throw Error('Player calls are not ranking reads') } } }
  const context = vm.createContext({ setTimeout, clearTimeout, wx: { getAccountInfoSync: () => ({ miniProgram: { appId: 'wx404dde55fb12df78', version: '108', envVersion: 'release' } }) },
    require: name => modules[name], requirePlugin: () => ({ getPluginVersion: () => '1.15.14' }) })
  const result = await new vm.Script(script.replace('@@PARAMS@@', JSON.stringify({ operation: 'rankings', ...parameters }))).runInContext(context)
  return { result: JSON.parse(JSON.stringify(result)), requests: JSON.parse(JSON.stringify(requests)) }
}

test('ranking pages retain source positions, board labels, source identities and paging timestamp', async () => {
  const { result, requests } = await evaluate(params, { total: 5, label_list: [{ type: 6, name: '口碑榜' }, { type: 9, name: '合成热榜' }],
    list: [{ drama_name: source.title, src_appid: source.srcAppId, origin_dramaid: source.originDramaId }, { drama_name: '无来源身份' }] })
  assert.deepEqual(requests, [{ action: 'getpopularlist', data: { source: 4, page_index: 1, page_size: 2, popular_type: 6, cold_start_time: params.coldStartTime, busi_version: 1 } }])
  assert.equal(result.privateResult, null)
  const visible = projectResult('rankings', result.publicResult, limits)
  assert.equal(visible.ok, true)
  assert.deepEqual(visible.data.entries, [{ ...source, rank: 3 }])
  assert.equal(visible.data.partial, true)
  assert.equal(visible.data.total, 5)
  assert.equal(visible.data.hasMore, true)
  assert.equal(visible.data.coldStartTime, params.coldStartTime)
  assert.deepEqual(visible.data.boards, [{ type: 6, name: '口碑榜' }, { type: 9, name: '合成热榜' }])
})

test('ranking errors remain explicit and invalid pagination never invokes native business code', async () => {
  for (const patch of [{ pageIndex: -1 }, { count: 21 }, { coldStartTime: 0 }, { boardType: true }, { query: 'not-allowed' }]) {
    const { requests, result } = await evaluate({ ...params, ...patch }, {})
    assert.deepEqual(requests, [])
    assert.equal(result.publicResult.status, 'parameters-invalid')
  }
  for (const response of [{ total: 2, label_list: [], list: [] , base_resp: { ret: -1 } }, { total: '2', label_list: [], list: [] }]) {
    const { result } = await evaluate(params, response)
    assert.equal(projectResult('rankings', result.publicResult, limits).ok, false)
  }
})

test('real tool defaults to reputation board and refuses mismatched pages without retrying', async () => {
  const ctx = new Context(), calls = []
  try {
    await ctx.plugin(SystemPrompt); await ctx.plugin(Tools)
    registerLvpaopao(ctx, { async request(action, input) {
      calls.push({ action, input })
      return { operation: 'rankings', status: 'rankings-returned', identityMatched: true, boards: [], entries: [],
        boardType: input.boardType, pageIndex: input.pageIndex === 0 ? 0 : 7, pageSize: input.count, coldStartTime: input.coldStartTime, total: 0, hasMore: false }
    }, async dispose() {} }, limits)
    const run = async args => JSON.parse((await ctx.tools.execute({ callId: 'rank-test', name: 'lvpaopao', arguments: { action: 'rankings', ...args }, signal: new AbortController().signal })).content[0].text)
    assert.equal((await run({})).ok, true)
    assert.equal(calls[0].input.boardType, 6)
    assert.equal(calls[0].input.count, 20)
    assert.equal((await run({ ...params, query: 'invalid' })).status, 'invalid-arguments')
    assert.equal(calls.length, 1)
    assert.equal((await run(params)).status, 'response-identity-mismatch')
    assert.equal(calls.length, 2)
  } finally { await ctx.fiber.dispose() }
})


test('current ranking drama_id is usable while explicit origin identity remains authoritative', async () => {
  const {result}=await evaluate(params,{total:4,label_list:[{type:8,name:'漫剧榜',wording:'榜单'}],list:[
    {drama_name:'当前榜单剧',src_appid:source.srcAppId,drama_id:12345},
    {drama_name:'已有来源剧',src_appid:source.srcAppId,drama_id:98765,origin_dramaid:'00123'}]})
  assert.equal(result.publicResult.partial,false)
  assert.deepEqual(result.publicResult.entries.map(v=>v.originDramaId),['12345','00123'])
  assert.equal(projectResult('rankings',result.publicResult,limits).ok,true)
})
