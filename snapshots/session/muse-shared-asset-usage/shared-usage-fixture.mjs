/** Offline shared project; unexpected traffic and all writes are rejected. */
export const name = 'shared-usage-http-fixture'
export function apply(ctx) {
  ctx.effect(() => {
    const original = globalThis.fetch
    const tag = period => `⟦muse-voice:v1:${Buffer.from(JSON.stringify([2708, 'lu', period])).toString('base64url')}⟧`
    const inventory = {
      asset: [
        { id: 13, scriptId: 2708, assetType: 4, assetName: `Child A ${tag('child')}`, delFlag: '0', assetUrl: 'https://example.invalid/lu-child.wav' },
        { id: 14, scriptId: 2708, assetType: 4, assetName: `Child B ${tag('child')}`, delFlag: '0', assetUrl: 'https://example.invalid/lu-child-b.wav' },
        { id: 15, scriptId: 2708, assetType: 4, assetName: `Adult ${tag('adult')}`, delFlag: '0', assetUrl: 'https://example.invalid/lu-adult.wav' },
      ],
      material: [],
      episode: [
        { id: 501, scriptId: 2708, episodeCount: 54, episodeName: 'Episode 54' },
        { id: 502, scriptId: 2708, episodeCount: 83, episodeName: 'Episode 83' },
      ],
      storyboard: [
        { id: 901, scriptId: 2708, episodeId: 501, storyboardName: 'EP54-P01',
          storyboardMaterialList: [{ materialType: 'audio', materialUrl: 'https://example.invalid/lu-child.wav' }],
          modelConfig: { materialList: [{ materialType: 'audio', materialUrl: 'https://example.invalid/lu-child.wav' }] } },
        { id: 902, scriptId: 2708, episodeId: 502, storyboardName: 'EP83-P01',
          storyboardMaterialList: [{ materialType: 'audio', materialUrl: 'https://example.invalid/lu-child-b.wav' }] },
        { id: 903, scriptId: 2708, episodeId: 502, storyboardName: 'EP83-P02',
          storyboardMaterialList: [{ materialType: 'audio', materialUrl: 'https://example.invalid/lu-child.wav' }] },
      ],
    }
    globalThis.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString())
      if (url.hostname !== 'match-preview.invalid' || init?.method !== 'GET' || url.searchParams.get('scriptId') !== '2708') {
        throw new Error('Offline shared usage rejects unexpected traffic and writes')
      }
      const kind = url.pathname.split('/').at(-2), rows = inventory[kind]
      if (!rows || !url.pathname.endsWith('/list')) throw new Error('Unexpected shared inventory')
      const page = Number(url.searchParams.get('pageNum')), size = Number(url.searchParams.get('pageSize'))
      return new Response(JSON.stringify({ code: 200, data: { total: rows.length, rows: rows.slice((page - 1) * size, page * size) } }))
    }
    return () => { globalThis.fetch = original }
  })
}
