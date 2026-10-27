/** Offline provider for a narration preview without a bound voice reference. */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
export const name = 'duration-fixture'
export function apply(ctx) {
  const ledger = join(process.env.DSH_HOME, 'jubian', 'ledger')
  mkdirSync(ledger, { recursive: true })
  writeFileSync(join(ledger, 'authorization.json'), JSON.stringify({ version: 1,
    projects: { '2708': { limit: '0.5', unit: 'CNY' } } }))
  ctx.effect(() => {
    const original = globalThis.fetch
    const OriginalDate = Date
    class FixtureDate extends OriginalDate {
      constructor(...args) { super(...(args.length === 0 ? [1790682041000] : args)) }
      static now() { return 1790682041000 }
    }
    globalThis.Date = FixtureDate
    const imageUrl = 'https://jubian-aigc.tos-cn-beijing.volces.com/fixture/existing.png'
    let storyboard = { id: 916953, scriptId: 2708, episodeId: 9, isGenerate: 1,
      storyboardName: 'Offline horizontal test', modelConfig: JSON.stringify({
        standardId: 61, modelId: 'doubao-seedance-2-5-260628', platformId: 'FANG_ZHOU',
        genType: 3, modelGenerationTypeId: 71, videoStandardId: 337, duration: '10',
        ratio: '16:9', resolution: '480p', genNum: 1, prompt: '@[Existing CG actor](lead)\n旁白：雨停了。',
      }), storyboardMaterialList: [] }
    let writes = 0
    globalThis.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString())
      if (url.hostname !== 'flat-child.invalid') throw new Error('Offline native fixture refuses external traffic')
      let data
      if (url.pathname.endsWith('/getSelectList') && init?.method === 'GET') {
        data = [{ id: 61, modelId: 'doubao-seedance-2-5-260628', platformId: 'FANG_ZHOU',
          genTypes: [{ id: 71, type: 3 }], videoStandards: [{ id: 337, ratio: '16:9', resolution: '480p', genNum: 1 }] }]
      } else if (url.pathname.endsWith('/aigc/storyboard/916953') && init?.method === 'GET') {
        data = storyboard
      } else if (url.pathname.endsWith('/aigc/storyboard') && init?.method === 'PUT') {
        const payload = JSON.parse(init.body)
        if (payload.isGenerate !== 0 && ++writes !== 1) throw new Error('Offline native fixture rejects a second paid PUT')
        storyboard = { ...payload, isGenerate: 1 }
        data = null
      } else if (url.pathname.endsWith('/aigc/asset/11') && init?.method === 'GET') {
        data = { id: 11, scriptId: 2708, assetType: 1, assetName: 'Existing CG actor',
          hsAssetId: 'asset-existing', hsAssetStatus: 'Active', isUsed: 1, assetUrl: imageUrl }
      } else if (url.pathname.endsWith('/aigc/material/list') && init?.method === 'GET') {
        data = { total: 1, rows: [{ id: 111, assetId: 11, scriptId: 2708, assetName: 'Existing CG actor',
          hsAssetId: 'asset-existing', hsAssetStatus: 'Active', isUsed: 1, materialType: 1, assetUrl: imageUrl }] }
      } else if (url.pathname.endsWith('/admin/aigc/video/task/list') && init?.method === 'GET') {
        data = { total: writes, rows: writes ? [{ id: 335343, scriptId: 2708, episodeId: 9, taskType: 1 }] : [] }
      } else if (url.pathname.endsWith('/admin/aigc/video/task/335343') && init?.method === 'GET') {
        data = { id: 335343, scriptId: 2708, episodeId: 9, taskType: 1, taskStatus: 'succeeded' }
      } else if (url.pathname.endsWith('/admin/aigc/video/task/sub/list') && init?.method === 'POST') {
        const { videoStandardId, ...config } = JSON.parse(storyboard.modelConfig)
        data = { total: 1, rows: [{ id: 972949, aigcVideoTaskId: 335343, storyboardId: 916953,
          taskStatus: 'succeeded', ...config, modelVideoStandardId: videoStandardId,
          imageMaterials: storyboard.storyboardMaterialList }] }
      } else throw new Error('Unexpected offline native request')
      return new Response(JSON.stringify({ code: 200, data }), { status: 200 })
    }
    return () => { globalThis.fetch = original; globalThis.Date = OriginalDate }
  })
}
