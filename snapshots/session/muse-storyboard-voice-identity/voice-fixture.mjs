/** Offline shared voice; every write and unexpected request is rejected. */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
export const name = 'storyboard-voice-identity-fixture'
export function apply(ctx) {
  ctx.effect(() => {
    const original = globalThis.fetch
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
      } else throw new Error('Offline voice identity fixture rejects unexpected reads')
      requests.push({ method: init.method, path: target.pathname })
      mkdirSync(join(process.cwd(), '_probe'), { recursive: true })
      writeFileSync(join(process.cwd(), '_probe', 'voice-identity-fixture.json'), JSON.stringify({ simulated: true, requests, writes: 0 }, null, 2) + '\n')
      return Response.json({ code: 200, data })
    }
    return () => { globalThis.fetch = original }
  })
}
