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
      { id: 111, scriptId: 2708, assetId: 11, isUsed: 1, hsAssetStatus: 'Active', hsAssetId: 'asset-11', assetUrl: assets[0].url },
      { id: 112, scriptId: 2708, assetId: 12, isUsed: 1, hsAssetStatus: 'Active', hsAssetId: 'asset-12', assetUrl: assets[1].url },
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
      } else data = assets.find(row => String(row.id) === url.pathname.split('/').at(-1))
      return new Response(JSON.stringify({ code: 200, data }), { status: 200 })
    }
    return () => { globalThis.fetch = original }
  })
}
