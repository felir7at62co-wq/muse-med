/** Read-only offline account with a saved main-model card and a Flash session default. */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const name = 'storyboard-model-readback-fixture'

/** @param {import('@deepseek-ai/cordis').Context} ctx - owning snapshot context. */
export function apply(ctx) {
  const image = 'https://jubian-aigc.tos-cn-beijing.volces.com/fixture/approved.png'
  const material = { assetId: 'approved-actor', materialAssetId: 11, fileName: 'Approved actor',
    materialKey: 'lead', materialType: 'image', materialUrl: image, sortOrder: 1 }
  const storyboard = { id: 916953, scriptId: 2708, episodeId: 9, isGenerate: 1,
    storyboardName: 'EP09-P1', storyboardMaterialList: [material], modelConfig: JSON.stringify({
      modelId: 'doubao-seedance-2.5', platformId: 'YU_DIAN', standardId: '93', resolution: '720p',
      genType: 3, modelGenerationTypeId: 71, videoStandardId: 91, duration: 8, ratio: '9:16', genNum: 1,
      prompt: '@[Approved actor](lead) enters an empty room', materialList: [material],
    }) }
  const catalogue = [
    { id: 101, modelId: 'doubao-seedance-2.5-flash', modelName: 'Seedance 2.5 Flash',
      platformId: 'YU_DIAN', genTypes: [{ id: 171, type: 3 }],
      videoStandards: [{ id: 191, ratio: '9:16', resolution: '720p', genNum: 1 }] },
    { id: 93, modelId: 'doubao-seedance-2.5', modelName: 'Seedance 2.5',
      platformId: 'YU_DIAN', genTypes: [{ id: 71, type: 3 }],
      videoStandards: [{ id: 91, ratio: '9:16', resolution: '720p', genNum: 1 }] },
  ]
  const receipt = { catalogue_reads: 0, storyboard_reads: 0, subject_reads: 0, parent_reads: 0,
    mutation_requests: 0, generation_requests: 0 }
  const save = () => { writeFileSync(join(process.cwd(), 'provider-receipt.json'), JSON.stringify(receipt, null, 2) + '\n') }
  save()
  ctx.effect(() => {
    const original = globalThis.fetch
    /** @type {typeof globalThis.fetch} */
    const fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString())
      const method = init?.method ?? (input instanceof Request ? input.method : 'GET')
      if (url.origin !== 'https://storyboard-model-readback.invalid') throw new Error('Model-readback fixture refuses external traffic')
      if (method !== 'GET') receipt.mutation_requests++
      if (/generate|submit|task/iu.test(url.pathname)) receipt.generation_requests++
      save()
      if (method !== 'GET') throw new Error('This model-readback fixture permits no provider writes')
      /** @type {unknown} */
      let data
      if (url.pathname.endsWith('/model/charge/getSelectList') && url.search === '?taskType=1') {
        receipt.catalogue_reads++; data = catalogue
      } else if (url.pathname.endsWith('/aigc/storyboard/916953')) {
        receipt.storyboard_reads++; data = storyboard
      } else if (url.pathname.endsWith('/aigc/material/list')) {
        receipt.subject_reads++; data = { total: 1, rows: [{ id: 111, scriptId: 2708, assetId: 11,
          hsAssetId: 'approved-actor', hsAssetStatus: 'Active', isUsed: 1, assetType: 1,
          assetName: 'Approved actor', assetUrl: image }] }
      } else if (url.pathname.endsWith('/aigc/asset/11')) {
        receipt.parent_reads++; data = { id: 11, scriptId: 2708, assetType: 1,
          assetName: 'Approved actor', assetUrl: image, delFlag: 0 }
      } else throw new Error(`Unexpected read-only model fixture route: ${url.pathname}`)
      save()
      return new Response(JSON.stringify({ code: 200, data }))
    }
    globalThis.fetch = fetch
    return () => { globalThis.fetch = original }
  })
}
