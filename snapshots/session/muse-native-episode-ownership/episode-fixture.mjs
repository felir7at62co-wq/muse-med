/** Offline provider evidence for unrelated and same-card historical episode conflicts. */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const name = 'native-episode-ownership-fixture'
const image = 'https://jubian-aigc.tos-cn-beijing.volces.com/fixture/episode-owner.png'
const model = { standardId: 61, modelId: 'doubao-seedance-2-5-260628', platformId: 'FANG_ZHOU',
  genType: 3, modelGenerationTypeId: 71, videoStandardId: 337, duration: 4,
  ratio: '16:9', resolution: '480p', genNum: 1, prompt: '@[Existing CG actor](lead)' }
const material = { assetId: 'asset-existing', materialAssetId: 11, fileName: 'Existing CG actor', materialKey: 'lead',
  materialType: 'image', materialUrl: image, sortOrder: 1 }

export function episodeOwnershipInputs(storyboardId) {
  return { createdAt: '2026-09-29T11:40:41.000Z',
    storyboard: { id: storyboardId, scriptId: 2708, episodeId: 401, episodeCount: storyboardId === 916953 ? 1 : 2,
      isGenerate: 1, storyboardName: `Episode ownership ${storyboardId}`, modelConfig: JSON.stringify(model),
      storyboardMaterialList: [material] },
    assets: [{ id: 11, scriptId: 2708, assetUrl: image, hsAssetId: 'asset-existing', hsAssetStatus: 'Active',
      isUsed: 1, official: true, asset_status: 'confirmed' }],
    models: [{ ...model, id: 61, genTypes: [{ id: 71, type: 3 }],
      videoStandards: [{ id: 337, ratio: '16:9', resolution: '480p', genNum: 1 }] }] }
}

export function createEpisodeOwnershipTransport(root) {
  const storyboards = new Map([916953, 916954].map(id => [id, episodeOwnershipInputs(id).storyboard]))
  const history = [{ id: 100000, scriptId: 2708, taskType: 1, episodeId: 400, episodeCount: 1 },
    { id: 100001, scriptId: 2708, taskType: 1, episodeId: 400, episodeCount: 2, storyboardId: 916954 }]
  const taskOwners = new Map([[100000, 999999], [100001, 916954]])
  const paidPuts = { 916953: 0, 916954: 0 }, detailsRead = new Set()
  const saveProof = () => writeFileSync(join(root, 'submission-proof.json'), JSON.stringify({
    paid_puts: paidPuts, historical_details_read: [...detailsRead].sort(),
  }, null, 2) + '\n')
  saveProof()
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString())
    if (url.hostname !== 'episode-ownership.invalid') throw new Error('Episode ownership fixture refuses external traffic')
    const path = url.pathname.replace('/prod-api', ''), method = init?.method
    let data
    if (path === '/model/charge/getSelectList' && method === 'GET') {
      data = episodeOwnershipInputs(916953).models
    } else if (path.startsWith('/aigc/storyboard/') && method === 'GET') {
      data = storyboards.get(Number(path.split('/').at(-1)))
    } else if (path === '/aigc/storyboard' && method === 'PUT') {
      const payload = JSON.parse(init.body)
      if (payload.isGenerate !== 1 || !Object.hasOwn(paidPuts, payload.id)) throw new Error('Unrecognized episode ownership write')
      paidPuts[payload.id]++
      saveProof()
      if (payload.id !== 916953 || paidPuts[916953] !== 1) {
        throw new Error('Episode ownership fixture refuses unapproved or repeated paid PUTs')
      }
      storyboards.set(916953, payload)
      data = null
    } else if (path === '/aigc/asset/11' && method === 'GET') {
      data = { id: 11, scriptId: 2708, assetType: 1, assetName: 'Existing CG actor', assetUrl: image }
    } else if (path === '/aigc/material/list' && method === 'GET') {
      data = { total: 1, rows: [{ id: 111, assetId: 11, scriptId: 2708, assetName: 'Existing CG actor',
        hsAssetId: 'asset-existing', hsAssetStatus: 'Active', isUsed: 1, materialType: 1, assetUrl: image }] }
    } else if (path === '/admin/aigc/video/task/list' && method === 'GET') {
      const rows = [...history, ...(paidPuts[916953] ? [{ id: 500000, scriptId: 2708,
        episodeId: 401, episodeCount: 1, taskType: 1, storyboardId: 916953 }] : [])]
      data = { total: rows.length, rows }
    } else if (path.startsWith('/admin/aigc/video/task/') && method === 'GET') {
      const id = Number(path.split('/').at(-1))
      if (taskOwners.has(id)) {
        detailsRead.add(id)
        data = { ...history.find(task => task.id === id), storyboardId: taskOwners.get(id) }
      } else if (id === 500000 && paidPuts[916953]) {
        data = { id, scriptId: 2708, episodeId: 401, episodeCount: 1, taskType: 1, storyboardId: 916953 }
      } else throw new Error('Unknown episode ownership task')
    } else if (path === '/admin/aigc/video/task/sub/list' && method === 'POST') {
      const id = Number(JSON.parse(init.body).aigcVideoTaskId)
      if (taskOwners.has(id)) {
        data = { total: 1, rows: [{ id: id + 10, aigcVideoTaskId: id, storyboardId: taskOwners.get(id) }] }
      } else if (id === 500000 && paidPuts[916953]) {
        const board = storyboards.get(916953)
        data = { total: 1, rows: [{ id: 500001, aigcVideoTaskId: id, storyboardId: 916953,
          taskStatus: 'submit', imageMaterials: board.storyboardMaterialList, modelConfig: board.modelConfig }] }
      } else throw new Error('Unknown episode ownership child request')
    } else throw new Error(`Unexpected episode ownership request ${method} ${path}`)
    saveProof()
    return Response.json({ code: 200, data })
  }
}

export function apply(ctx) {
  const ledger = join(process.env.DSH_HOME, 'jubian', 'ledger')
  mkdirSync(ledger, { recursive: true })
  writeFileSync(join(ledger, 'authorization.json'), JSON.stringify({ version: 1,
    projects: { '2708': { limit: '0.5', unit: 'CNY' } } }))
  ctx.effect(() => {
    const originalFetch = globalThis.fetch, OriginalDate = Date
    class FixtureDate extends OriginalDate {
      constructor(...args) { super(...(args.length === 0 ? [1790682041000] : args)) }
      static now() { return 1790682041000 }
    }
    globalThis.Date = FixtureDate
    globalThis.fetch = createEpisodeOwnershipTransport(process.cwd())
    return () => { globalThis.fetch = originalFetch; globalThis.Date = OriginalDate }
  })
}
