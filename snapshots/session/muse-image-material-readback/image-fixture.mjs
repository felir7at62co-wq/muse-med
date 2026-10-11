/** Offline generation provider with one image write and an ambiguous video PUT. */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
export const name = 'image-material-fixture'
export function apply(ctx) {
  const ledger = join(process.env.DSH_HOME, 'jubian', 'ledger')
  mkdirSync(ledger, { recursive: true })
  writeFileSync(join(ledger, 'authorization.json'), JSON.stringify({ version: 1,
    projects: { '2708': { limit: '1', unit: 'CNY' } } }))
  ctx.effect(() => {
    const original = globalThis.fetch
    const OriginalDate = Date
    class FixtureDate extends OriginalDate {
      constructor(...args) { super(...(args.length === 0 ? [1790682041000] : args)) }
      static now() { return 1790682041000 }
    }
    globalThis.Date = FixtureDate
    let writes = 0
    let videoWrites = 0
    const existingUrl = 'https://jubian-aigc.tos-cn-beijing.volces.com/fixture/existing.png'
    let storyboard = { id: 916953, scriptId: 2708, episodeId: 9, isGenerate: 1,
      storyboardName: 'Offline horizontal test', modelConfig: JSON.stringify({
        standardId: 61, modelId: 'doubao-seedance-2-5-260628', platformId: 'FANG_ZHOU',
        genType: 3, modelGenerationTypeId: 71, videoStandardId: 337, duration: 4,
        ratio: '16:9', resolution: '480p', genNum: 1, prompt: '@[Existing CG actor](lead)',
      }), storyboardMaterialList: [] }
    globalThis.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString())
      if (url.href === 'https://jubian-aigc.tos-cn-beijing.volces.com/fixture/generated.jpg' && init?.method === 'GET') {
        return new Response(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64'))
      }
      if (url.hostname !== 'image-material.invalid') throw new Error('Offline image fixture refuses external traffic')
      let data
      if (url.pathname.endsWith('/getSelectList') && init?.method === 'GET') {
        data = url.searchParams.get('taskType') === '1'
          ? [{ id: 61, modelId: 'doubao-seedance-2-5-260628', platformId: 'FANG_ZHOU',
              genTypes: [{ id: 71, type: 3 }], videoStandards: [{ id: 337, ratio: '16:9', resolution: '480p', genNum: 1 }] }]
          : [{ id: 42, modelId: 'gpt-image-2', platformId: 'YU_DIAN', unitPrice: 0.5, unit: '张',
          genTypes: [{ id: 7, type: 3 }],
          videoStandards: [{ id: 91, ratio: '16:9', resolution: '1K', width: 1280, height: 720, genNum: 1 }] }]
      } else if (url.pathname.endsWith('/aigc/storyboard/916953') && init?.method === 'GET') {
        data = storyboard
      } else if (url.pathname.endsWith('/aigc/storyboard') && init?.method === 'PUT') {
        const payload = JSON.parse(init.body)
        if (payload.isGenerate === 0) {
          storyboard = { ...payload, isGenerate: 1 }
          data = null
        } else {
          if (++videoWrites !== 1) throw new Error('Offline fixture rejects repeated video PUTs')
          throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } })
        }
      } else if (url.pathname.endsWith('/aigc/asset/11') && init?.method === 'GET') {
        data = { id: 11, scriptId: 2708, assetType: 1, assetName: 'Existing CG actor',
          hsAssetId: 'asset-existing', hsAssetStatus: 'Active', isUsed: 1, assetUrl: existingUrl }
      } else if (url.pathname.endsWith('/aigc/material/list') && init?.method === 'GET') {
        data = { total: 1, rows: [{ id: 111, assetId: 11, scriptId: 2708, assetName: 'Existing CG actor',
          hsAssetId: 'asset-existing', hsAssetStatus: 'Active', isUsed: 1, materialType: 1, assetUrl: existingUrl }] }
      } else if (url.pathname.endsWith('/admin/aigc/video/task/335343') && init?.method === 'GET') {
        data = { id: 335343, scriptId: 9000, taskType: 1, taskStatus: 'succeeded',
          realCost: 3.3906, estimatedCost: 3.52, discountCost: 0, taskName: 'Historical reference task' }
      } else if (url.pathname.endsWith('/admin/aigc/video/task/list') && init?.method === 'GET') {
        data = { total: 0, rows: [] }
      } else if (url.pathname.endsWith('/aigc/asset') && init?.method === 'POST') {
        if (++writes !== 1) throw new Error('Offline image fixture rejects repeated paid writes')
        data = 83749
      } else if (url.pathname.endsWith('/aigc/asset/83749') && init?.method === 'GET') {
        data = { id: 83749, scriptId: 2708, assetType: 1, assetName: '横屏CG测试角色', hsAssetStatus: null }
      } else if (url.pathname.endsWith('/getGeneratedImageByAssetId') && url.searchParams.get('assetId') === '83749'
        && init?.method === 'GET') {
        data = [{ id: 900, scriptId: 2708, assetId: 83749,
          assetUrl: 'https://jubian-aigc.tos-cn-beijing.volces.com/fixture/generated.jpg',
          hsAssetStatus: 'Active', isUsed: 0 }]
      } else throw new Error('Unexpected offline image request')
      return new Response(JSON.stringify({ code: 200, data }), { status: 200 })
    }
    return () => { globalThis.fetch = original; globalThis.Date = OriginalDate }
  })
}
