/** Authored offline selection fixture; every request is simulated and all paid paths are rejected. */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
export const name = 'match-preview-http-fixture'
const assets = [
  { id: 11, scriptId: 2708, assetType: 1, assetName: '陆沉舟（职场装）', delFlag: '0', url: 'https://example.invalid/lu.png' },
  { id: 12, scriptId: 2708, assetType: 2, assetName: '大厅', delFlag: '0', url: 'https://example.invalid/lobby.png' },
  { id: 13, scriptId: 2708, assetType: 4, assetName: '阿舟声线v1', delFlag: '0', assetUrl: 'https://example.invalid/lu.wav' },
]
const materials = assets.slice(0, 2).map((asset, index) => ({ id: 111 + index, scriptId: 2708,
  assetId: asset.id, assetName: asset.assetName, isUsed: 1, hsAssetStatus: 'Active',
  hsAssetId: 'asset-' + asset.id, assetUrl: asset.url }))
function card(id) {
  return { id, scriptId: 2708, episodeId: 91, duration: 5000, privateProviderField: { retained: true },
    modelConfig: { prompt: '@[阿舟](lead)走进@[大厅](bg)，@[阿舟](lead)停下。@[声线](voice)', resolution: '720p' },
    storyboardMaterialList: [
      { materialKey: 'lead', materialAssetId: 99, assetId: 'asset-99', fileName: '旧选择', materialType: 'image', materialUrl: 'https://example.invalid/old.png', sortOrder: 1 },
      { materialKey: 'bg', materialAssetId: 12, assetId: 'asset-12', fileName: '大厅', materialType: 'image', materialUrl: 'https://example.invalid/lobby.png', sortOrder: 2 },
      { materialKey: 'voice', materialType: 'audio', materialUrl: 'https://example.invalid/lu.wav', sortOrder: 1 },
    ] }
}
export function apply(ctx) {
  ctx.effect(() => {
    const original = globalThis.fetch
    const boards = new Map([901, 902].map(id => [id, card(id)]))
    const writes = []
    globalThis.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString())
      const method = init?.method ?? 'GET'
      if (url.hostname !== 'match-preview.invalid') throw new Error('External origin denied')
      let data
      if (method === 'PUT' && url.pathname === '/prod-api/aigc/storyboard') {
        const body = JSON.parse(init.body)
        if (body.isGenerate !== 0 || body.scriptId !== 2708 || !boards.has(body.id)) throw new Error('Only exact free fixture saves allowed')
        if (writes.some(row => row.storyboard_id === body.id)) throw new Error('Duplicate write')
        boards.set(body.id, body)
        writes.push({ storyboard_id: body.id, isGenerate: body.isGenerate, selections: body.storyboardMaterialList })
        await mkdir(join(process.cwd(), '_probe'), { recursive: true })
        await writeFile(join(process.cwd(), '_probe', 'handoff-fixture.json'), JSON.stringify({ simulated: true, paid_requests: 0,
          writes, boards: [...boards.values()] }, null, 2) + '\n')
        data = body.id
      } else if (method !== 'GET') throw new Error('Paid or unsupported write denied')
      else if (url.pathname === '/prod-api/admin/aigc/video/task/list') data = { total: 0, rows: [] }
      else if (url.pathname.startsWith('/prod-api/aigc/storyboard/')) data = boards.get(Number(url.pathname.split('/').at(-1)))
      else if (url.pathname === '/prod-api/aigc/asset/list' || url.pathname === '/prod-api/aigc/material/list') {
        if (url.searchParams.get('scriptId') !== '2708') throw new Error('Unexpected project')
        const rows = url.pathname.includes('/material/') ? materials : assets
        const page = Number(url.searchParams.get('pageNum')), size = Number(url.searchParams.get('pageSize'))
        data = { total: rows.length, rows: rows.slice((page - 1) * size, page * size) }
      } else if (url.pathname.startsWith('/prod-api/aigc/asset/')) data = assets.find(row => String(row.id) === url.pathname.split('/').at(-1))
      else throw new Error('Unsupported fixture route')
      return new Response(JSON.stringify({ code: 200, data }), { status: 200 })
    }
    return () => { globalThis.fetch = original }
  })
}
