/** Offline shared voice; every write and unexpected request is rejected. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const voiceover = readFileSync(new URL('../../../packages/jubian/tool-jubian/tests/fixtures/ep50-voiceover.txt', import.meta.url), 'utf8')
const assets = [
  { id: 11, scriptId: 2708, assetType: 2, assetName: '二十楼落地窗前', hsAssetId: 'asset-window',
    hsAssetStatus: 'Active', isUsed: 1, assetUrl: 'https://cdn.example.test/window.png' },
  { id: 12, scriptId: 2708, assetType: 1, assetName: '乔麦', hsAssetId: 'asset-qiaomai',
    hsAssetStatus: 'Active', isUsed: 1, assetUrl: 'https://cdn.example.test/qiaomai.png' },
]
const images = assets.map((asset, index) => ({ assetId: asset.hsAssetId, materialAssetId: asset.id,
  fileName: asset.assetName, materialKey: index === 0 ? 'lead' : 'guest', materialType: 'image',
  materialUrl: asset.assetUrl, sortOrder: index + 1, official: true, asset_status: 'confirmed' }))
const audio = { materialKey: 'voice-lead', materialType: 'audio',
  materialUrl: 'https://cdn.example.test/qiaomai.wav', sortOrder: 1, audioDuration: 2 }
const models = [{ id: 61, modelId: 'doubao-seedance-2-5-260628', platformId: 'FANG_ZHOU',
  genTypes: [{ id: 71, type: 3 }], videoStandards: [{ id: 338, ratio: '9:16', resolution: '480p', genNum: 1 }] }]
const storyboards = [true, false].map((hasAudio, index) => {
  const materialList = hasAudio ? [...images, audio] : images
  return { id: 916953 + index, scriptId: 2708, episodeId: 9, isGenerate: 0,
    storyboardName: hasAudio ? 'EP50 voiceover with reference' : 'EP50 voiceover without reference',
    modelConfig: JSON.stringify({ standardId: 61, modelId: 'doubao-seedance-2-5-260628', platformId: 'FANG_ZHOU',
      genType: 3, modelGenerationTypeId: 71, videoStandardId: 338, duration: 26, ratio: '9:16', resolution: '480p',
      genNum: 1, prompt: hasAudio ? voiceover : voiceover.replace(/本段乔麦的心声与台词声音参考为[^。]+。/u, ''),
      materialList, backupModelList: [] }), storyboardMaterialList: materialList }
})
export const name = 'storyboard-voice-identity-fixture'
export function apply(ctx) {
  ctx.effect(() => {
    const original = globalThis.fetch, OriginalDate = Date
    class FixtureDate extends OriginalDate {
      constructor(...args) { super(...(args.length ? args : [1790682041000])) }
      static now() { return 1790682041000 }
    }
    globalThis.Date = FixtureDate
    const requests = []
    const url = 'https://example.invalid/adult.wav'
    const image = { materialType: 'image', materialKey: 'actor', materialUrl: 'https://example.invalid/actor.jpg', sortOrder: 1 }
    const board = { id: 901, scriptId: 2708, episodeId: 9, storyboardName: 'EP09-P1', isGenerate: 0,
      modelConfig: JSON.stringify({ duration: 8, prompt: '@[Actor](actor)', materialList: [image] }), storyboardMaterialList: [image] }
    globalThis.fetch = async (input, init) => {
      const target = new URL(input instanceof Request ? input.url : input.toString())
      if (target.origin !== 'https://voice-identity.invalid' || init?.method !== 'GET') {
        throw new Error('Offline voice identity fixture rejects writes and external traffic')
      }
      let data
      if (target.pathname === '/prod-api/aigc/storyboard/901') data = board
      else if (target.pathname === '/prod-api/aigc/asset/77') {
        data = { id: 77, scriptId: 2708, assetType: 4,
          assetName: `Adult ⟦muse-voice:v1:${Buffer.from(JSON.stringify([2708, 'zhou', 'adult'])).toString('base64url')}⟧`,
          assetUrl: url, isLocal: 1, delFlag: '0' }
      } else if (target.pathname === '/prod-api/model/charge/getSelectList') data = models
      else if (target.pathname === '/prod-api/aigc/storyboard/916953') data = storyboards[0]
      else if (target.pathname === '/prod-api/aigc/storyboard/916954') data = storyboards[1]
      else if (target.pathname === '/prod-api/aigc/asset/11') data = assets[0]
      else if (target.pathname === '/prod-api/aigc/asset/12') data = assets[1]
      else if (target.pathname === '/prod-api/aigc/asset/list') data = { total: 2, rows: assets }
      else if (target.pathname === '/prod-api/aigc/storyboard/byStoryboard/916953'
        || target.pathname === '/prod-api/aigc/storyboard/byStoryboard/916954') data = { total: 0, rows: [] }
      else if (target.pathname === '/prod-api/aigc/material/list') data = { total: 2, rows: assets.map((asset, index) =>
        ({ ...asset, id: 111 + index, assetId: asset.id, materialType: 1 })) }
      else if (target.pathname === '/prod-api/admin/aigc/video/task/list') data = { total: 0, rows: [] }
      else throw new Error('Offline voice identity fixture rejects unexpected reads')
      requests.push({ method: init.method, path: target.pathname })
      mkdirSync(join(process.cwd(), '_probe'), { recursive: true })
      writeFileSync(join(process.cwd(), '_probe', 'voice-identity-fixture.json'), JSON.stringify({ simulated: true, requests, writes: 0 }, null, 2) + '\n')
      return Response.json({ code: 200, data })
    }
    return () => { globalThis.fetch = original; globalThis.Date = OriginalDate }
  })
}
