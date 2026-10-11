/** Offline provider fixture; unexpected traffic and every write are rejected. */
export const name = 'match-preview-http-fixture'
export function apply(ctx) {
  ctx.effect(() => {
    const original = globalThis.fetch
    const assets = [
      { id: 11, scriptId: 2708, assetType: 1, assetName: '陆沉舟（职场装）', delFlag: '0', url: 'https://example.invalid/lu.png' },
      { id: 12, scriptId: 2708, assetType: 2, assetName: '大厅', delFlag: '0', url: 'https://example.invalid/lobby.png' },
      { id: 13, scriptId: 2708, assetType: 4, assetName: '阿舟声线v1', delFlag: '0', assetUrl: 'https://example.invalid/lu.wav' },
    ]
    const materials = [
      { id: 111, scriptId: 2708, assetId: 11, assetName: '陆沉舟（职场装）', isUsed: 1, hsAssetStatus: 'Active', hsAssetId: 'asset-11', assetUrl: assets[0].url },
      { id: 112, scriptId: 2708, assetId: 12, assetName: '大厅', isUsed: 1, hsAssetStatus: 'Active', hsAssetId: 'asset-12', assetUrl: assets[1].url },
    ]
    globalThis.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString())
      if (url.hostname !== 'match-preview.invalid' || init?.method !== 'GET') throw new Error('Offline matching fixture rejects all unexpected or write requests')
      let data
      if (url.pathname.endsWith('/list')) {
        if (url.searchParams.get('scriptId') !== '2708') throw new Error('Unexpected project')
        const rows = url.pathname.includes('/material/') ? materials : assets
        const page = Number(url.searchParams.get('pageNum')), size = Number(url.searchParams.get('pageSize'))
        data = { total: rows.length, rows: rows.slice((page - 1) * size, page * size) }
      } else if (url.pathname.includes('/aigc/storyboard/')) {
        const id = Number(url.pathname.split('/').at(-1))
        if (![901, 902].includes(id)) throw new Error('Unexpected storyboard')
        data = { id, scriptId: 2708, episodeId: 91, duration: 5000,
          modelConfig: { prompt: '@[阿舟](lead)走进@[大厅](bg)，@[阿舟](lead)停下。@[声线](voice)', resolution: '720p' },
          storyboardMaterialList: [
            { materialKey: 'lead', materialAssetId: 99, assetId: 'asset-99', fileName: '旧选择', materialType: 'image', materialUrl: 'https://example.invalid/old.png', sortOrder: 1 },
            { materialKey: 'bg', materialAssetId: 12, assetId: 'asset-12', fileName: '大厅', materialType: 'image', materialUrl: 'https://example.invalid/lobby.png', sortOrder: 2 },
            { materialKey: 'voice', materialType: 'audio', materialUrl: 'https://example.invalid/lu.wav', sortOrder: 1 },
          ] }
      } else data = assets.find(row => String(row.id) === url.pathname.split('/').at(-1))
      return new Response(JSON.stringify({ code: 200, data }), { status: 200 })
    }
    return () => { globalThis.fetch = original }
  })
}
