/** Offline provider for approved character references and explicit storyboard selection. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const name = 'character-image-continuity-fixture'

export function apply(ctx) {
  const ledger = join(process.env.DSH_HOME, 'jubian', 'ledger')
  mkdirSync(ledger, { recursive: true })
  writeFileSync(join(ledger, 'authorization.json'), JSON.stringify({ version: 1,
    projects: { '2708': { limit: '0.5', unit: 'CNY' } } }))
  const skill = join(process.cwd(), '.dsh', 'skills', 'tweet-drama-shot-asset-match')
  mkdirSync(skill, { recursive: true })
  writeFileSync(join(skill, 'SKILL.md'), readFileSync(new URL(
    '../../../packages/drama/skills/skills/tweet-drama-shot-asset-match/SKILL.md', import.meta.url)))

  ctx.effect(() => {
    const original = globalThis.fetch
    const OriginalDate = Date
    class FixtureDate extends OriginalDate {
      constructor(...args) { super(...(args.length === 0 ? [1790682041000] : args)) }
      static now() { return 1790682041000 }
    }
    globalThis.Date = FixtureDate
    const approvedUrl = 'https://jubian-aigc.tos-cn-beijing.volces.com/fixture/approved.png'
    const staleUrl = 'https://jubian-aigc.tos-cn-beijing.volces.com/fixture/stale.png'
    const generatedUrl = 'https://jubian-aigc.tos-cn-beijing.volces.com/fixture/new-candidate.png'
    const reference = { assetId: 'asset-approved', materialAssetId: 11, fileName: 'Approved actor',
      materialKey: 'lead', materialType: 'image', materialUrl: approvedUrl, sortOrder: 1 }
    const model = { standardId: 61, modelId: 'doubao-seedance-2-5-260628', platformId: 'FANG_ZHOU',
      genType: 3, modelGenerationTypeId: 71, videoStandardId: 337, duration: 4,
      ratio: '16:9', resolution: '480p', genNum: 1, backupModelList: [],
      prompt: '@[Approved actor](lead)', materialList: [{ ...reference, materialUrl: staleUrl }] }
    let storyboard = { id: 916953, scriptId: 2708, episodeId: 9, isGenerate: 1,
      storyboardName: 'Character continuity', modelConfig: JSON.stringify(model), storyboardMaterialList: [reference] }
    const parent = { id: 11, scriptId: 2708, assetType: 1, assetName: 'Approved actor', delFlag: 0,
      hsAssetId: 'asset-approved', hsAssetStatus: 'Active', isUsed: 1, assetUrl: approvedUrl }
    const adopted = { id: 111, assetId: 11, scriptId: 2708, assetName: 'Approved actor',
      hsAssetId: 'asset-approved', hsAssetStatus: 'Active', isUsed: 1, materialType: 1, assetUrl: approvedUrl }
    let imageWrites = 0
    let storyboardWrites = 0
    const receipt = { image_generation: null, confirmation_requests: 0, storyboard_writes: 0,
      selected_model_references: [], selected_storyboard_references: [] }
    const saveReceipt = () => writeFileSync(join(process.cwd(), 'provider-receipt.json'),
      JSON.stringify(receipt, null, 2) + '\n')
    saveReceipt()

    globalThis.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString())
      if (url.hostname !== 'character-continuity.invalid') throw new Error('Continuity fixture refuses external traffic')
      const method = init?.method
      let data
      if (url.pathname.endsWith('/getSelectList') && method === 'GET') {
        data = url.searchParams.get('taskType') === '1'
          ? [{ id: 61, modelId: model.modelId, platformId: model.platformId,
              genTypes: [{ id: 71, type: 3 }], videoStandards: [{ id: 337, ratio: '16:9', resolution: '480p', genNum: 1 }] }]
          : [{ id: 42, modelId: 'gpt-image-2', platformId: 'YU_DIAN', unitPrice: 0.5, unit: '张',
              genTypes: [{ id: 7, type: 3 }],
              videoStandards: [{ id: 91, ratio: '16:9', resolution: '1K', width: 1280, height: 720, genNum: 1 }] }]
      } else if (url.pathname.endsWith('/aigc/asset/list') && method === 'GET') {
        data = { total: 1, rows: [parent] }
      } else if (url.pathname.endsWith('/aigc/asset/11') && method === 'GET') {
        data = parent
      } else if (url.pathname.endsWith('/aigc/material/list') && method === 'GET') {
        data = { total: 1, rows: [adopted] }
      } else if (url.pathname.endsWith('/aigc/asset') && method === 'PUT') {
        const body = JSON.parse(init.body)
        const config = JSON.parse(body.modelConfig)
        if (++imageWrites !== 1 || body.id !== 11 || body.scriptId !== 2708 || body.assetType !== 1
          || config.materialList.length !== 1 || config.materialList[0].materialUrl !== approvedUrl) {
          throw new Error('Regeneration must inherit exactly the approved character reference')
        }
        receipt.image_generation = { method, parent_asset_id: body.id, asset_type: body.assetType,
          reference_materials: config.materialList }
        data = 11
      } else if (url.pathname.endsWith('/getGeneratedImageByAssetId') && method === 'GET'
        && url.searchParams.get('assetId') === '11') {
        data = [{ id: 900, scriptId: 2708, assetId: 11, assetUrl: generatedUrl,
          hsAssetStatus: 'Active', isUsed: 0 }]
      } else if (url.pathname.includes('/aigc/material/confirm/')) {
        receipt.confirmation_requests++
        saveReceipt()
        throw new Error('Candidate generation cannot confirm casting automatically')
      } else if (url.pathname.endsWith('/aigc/storyboard/916953') && method === 'GET') {
        data = storyboard
      } else if (url.pathname.endsWith('/aigc/storyboard/byStoryboard/916953') && method === 'GET') {
        data = []
      } else if (url.pathname.endsWith('/aigc/storyboard') && method === 'PUT') {
        const body = JSON.parse(init.body)
        const config = JSON.parse(body.modelConfig)
        if (++storyboardWrites !== 1 || body.isGenerate !== 0
          || config.materialList.length !== 1 || config.materialList[0].materialUrl !== approvedUrl
          || body.storyboardMaterialList.length !== 1 || body.storyboardMaterialList[0].materialUrl !== approvedUrl) {
          throw new Error('Only explicit selection may synchronize both storyboard reference lists')
        }
        storyboard = { ...storyboard, ...body, isGenerate: 1 }
        receipt.storyboard_writes = storyboardWrites
        receipt.selected_model_references = config.materialList
        receipt.selected_storyboard_references = body.storyboardMaterialList
        data = null
      } else if (url.pathname.endsWith('/admin/aigc/video/task/list') && method === 'GET') {
        data = { total: 0, rows: [] }
      } else throw new Error(`Unexpected continuity fixture request: ${method} ${url.pathname}`)
      saveReceipt()
      return new Response(JSON.stringify({ code: 200, data }), { status: 200 })
    }
    return () => { globalThis.fetch = original; globalThis.Date = OriginalDate }
  })
}
