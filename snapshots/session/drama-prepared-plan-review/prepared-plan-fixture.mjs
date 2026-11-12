/** Offline native preparation exercises the real compiler post-review without media generation. */
import assert from 'node:assert/strict'
import { importSnapshotModule } from '../muse-fixture-import.mjs'

const compiler = await importSnapshotModule(new URL('../../../packages/drama/tool-shot-script/src/index.ts', import.meta.url),
  new URL('../../../packages/drama/tool-shot-script/lib/index.js', import.meta.url))

export const name = 'prepared-plan-fixture'
export const inject = ['tools']

/** @param {import('@deepseek-ai/cordis').Context} ctx - Shipped-profile owner. */
export function apply(ctx) {
  ctx.plugin(compiler, { reviewMode: 'advisory', emptyShotMaxSeconds: 2, repetitiveShotThreshold: 3 })
  const imageUrl = 'https://cdn.example.test/courtyard.png'
  const asset = { id: 11, scriptId: 2708, assetType: 2, assetName: '院落', hsAssetId: 'asset-courtyard',
    hsAssetStatus: 'Active', isUsed: 1, assetUrl: imageUrl }
  const material = { assetId: 'asset-courtyard', materialAssetId: 11, fileName: '院落', materialKey: 'scene',
    materialType: 'image', materialUrl: imageUrl, sortOrder: 1, official: true, asset_status: 'confirmed' }
  const prompt = '@[院落](scene)\n' + [1, 2, 3].map(number => ['真人短剧写实风格', `【镜头${number}】`, '核心场景：院落', '场景时段：清晨',
    '镜头类型：【纯环境空镜】；', '景别：【特写】；', '主运镜：【固定机位】；', '空镜用途：交代场景',
    '视线目标：未知', '情绪触发：未知', '发声类型：action', '时长：3秒',
    ...(number === 3 ? ['四层朝向链：瞳孔自发光', '眼部特效依据：原文：待定'] : []),
    '无噪点，无跳帧，五官稳定不变形'].join('\n')).join('\n\n')
  let storyboard = { id: 916953, scriptId: 2708, episodeId: 9, isGenerate: 0, storyboardName: 'Offline declared plan',
    modelConfig: JSON.stringify({ standardId: 61, modelId: 'doubao-seedance-2-5-260628', platformId: 'FANG_ZHOU',
      genType: 3, modelGenerationTypeId: 71, videoStandardId: 337, duration: 12, ratio: '16:9', resolution: '480p',
      genNum: 1, prompt, materialList: [material], backupModelList: [] }), storyboardMaterialList: [material] }
  ctx.effect(() => {
    const fetch = globalThis.fetch, OriginalDate = Date
    class FixtureDate extends OriginalDate {
      constructor(...args) { super(...(args.length ? args : [1790682041000])) }
      static now() { return 1790682041000 }
    }
    globalThis.Date = FixtureDate
    globalThis.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString())
      assert.equal(url.hostname, 'prepared-plan.invalid', 'fixture permits no external provider traffic')
      const method = init?.method ?? 'GET'
      let data
      if (url.pathname === '/model/charge/getSelectList' && method === 'GET') {
        data = [{ id: 61, modelId: 'doubao-seedance-2-5-260628', platformId: 'FANG_ZHOU',
          genTypes: [{ id: 71, type: 3 }], videoStandards: [{ id: 337, ratio: '16:9', resolution: '480p', genNum: 1 }] }]
      } else if (url.pathname === '/aigc/storyboard/916953' && method === 'GET') data = storyboard
      else if (url.pathname === '/aigc/asset/11' && method === 'GET') data = asset
      else if (url.pathname === '/aigc/asset/list' && method === 'GET') data = { total: 1, rows: [asset] }
      else if (url.pathname === '/aigc/material/list' && method === 'GET') data = { total: 1, rows: [
        { id: 111, assetId: 11, scriptId: 2708, materialType: 1, ...asset },
      ] }
      else if (url.pathname === '/aigc/storyboard' && method === 'PUT') {
        const payload = JSON.parse(init.body)
        assert.equal(payload.isGenerate, 0, 'fixture forbids paid submissions')
        storyboard = payload; data = 916953
      } else throw Error(`Unexpected offline native preparation: ${method} ${url.pathname}`)
      return new Response(JSON.stringify({ code: 200, data }), { status: 200 })
    }
    return () => { globalThis.fetch = fetch; globalThis.Date = OriginalDate }
  })
}
