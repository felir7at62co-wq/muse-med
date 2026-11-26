/** Real free publication and strict renderer tools with an offline provider transport. */
import { readFile, writeFile } from 'node:fs/promises'
import { JubianClient, JubianLedger } from '@deepseek-ai/dsh-jubian'
import { JubianVideoSelection } from '@deepseek-ai/dsh-tool-jubian'

const artifact = process.env.DSH_EXAMPLE_MODE === 'lib'
const compiler = await import(new URL(artifact ? '../lib/index.js' : '../src/index.ts', import.meta.url))
const catalogue = JSON.parse(await readFile(new URL('../../../jubian/jubian-api/tests/fixtures/catalogue-20261016.json',
  import.meta.url), 'utf8'))['1']

export const Config = compiler.Config
export const inject = ['credentials']

/** Mount real producers and consumers; only the remote provider is simulated. */
export function apply(ctx, config) {
  // Shipped headless already owns its credential service. Replace only the external-provider
  // boundary for this isolated child process, then restore the exact method on disposal.
  ctx.effect(() => {
    const credentials = ctx.credentials, previous = credentials.resolve
    credentials.resolve = function (ref) {
      if (ref !== 'JUBIANAI_ADMIN_TOKEN') return previous.call(this, ref)
      return Promise.resolve({ value: 'offline-production-fixture', source: 'fixture' })
    }
    return () => { credentials.resolve = previous }
  })
  const cards = new Map()
  let freeCardWrites = 0, paidGenerationRequests = 0
  let callCount = 0, failedOperation
  const assets = [
    { id: 177496, scriptId: 4908, assetType: 1, assetName: '全剧｜角色｜秦明枝（大红婚服）',
      assetUrl: 'https://cdn.example.test/red.png', delFlag: '0' },
    { id: 177517, scriptId: 4908, assetType: 1, assetName: '全剧｜角色｜秦明枝（素白中衣）',
      assetUrl: 'https://cdn.example.test/white.png', delFlag: '0' },
    { id: 175841, scriptId: 4908, assetType: 2, assetName: '萧家后院走廊',
      assetUrl: 'https://cdn.example.test/corridor.png', delFlag: '0' },
  ]
  const materials = assets.map((asset, index) => ({ id: asset.id + 1000, scriptId: 4908, assetId: asset.id,
    hsAssetId: ['image-red', 'image-white', 'image-corridor'][index], assetName: asset.assetName,
    assetUrl: asset.assetUrl, isUsed: 1, hsAssetStatus: 'Active' }))
  const transport = async (input, init) => {
    const address = new URL(input instanceof Request ? input.url : String(input))
    if (address.hostname !== 'production.invalid') throw new Error('Unexpected production fixture provider')
    const method = init?.method ?? 'GET'
    callCount++
    const fail = () => { failedOperation = { method, path: address.pathname, call_count: callCount } }
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
    let data
    if (method === 'GET' && address.pathname === '/model/charge/getSelectList') data = catalogue
    else if (method === 'GET' && address.pathname === '/aigc/script/4908') data = { id: 4908, scriptName: 'Muse production replay' }
    else if (method === 'GET' && address.pathname === '/aigc/episode/list') data = {
      total: 1, rows: [{ id: 102505, scriptId: 4908, episodeCount: 1 }],
    }
    else if (method === 'GET' && address.pathname === '/aigc/asset/list') data = { total: assets.length, rows: assets }
    else if (method === 'GET' && address.pathname === '/aigc/material/list') data = { total: materials.length, rows: materials }
    else if (method === 'GET' && /^\/aigc\/asset\/\d+$/u.test(address.pathname)) {
      data = assets.find(row => row.id === Number(address.pathname.split('/').at(-1)))
    }
    else if (method === 'GET' && address.pathname === '/aigc/storyboard/list') data = { total: cards.size, rows: [...cards.values()] }
    else if (method === 'GET' && /^\/aigc\/storyboard\/\d+$/u.test(address.pathname)) {
      data = cards.get(Number(address.pathname.split('/').at(-1)))
    }
    else if (method === 'GET' && address.pathname.includes('/video/task')) data = { total: 0, rows: [] }
    else if (address.pathname === '/aigc/storyboard' && body && method === 'POST') {
      if (body.isGenerate !== 0) {
        paidGenerationRequests++
        fail()
        throw new Error('The production snapshot forbids paid generation')
      }
      freeCardWrites++
      const id = 10000 + cards.size
      const model = JSON.parse(String(body.modelConfig))
      cards.set(id, { ...body, id, storyboardMaterialList: [], modelConfig: JSON.stringify({ ...model, materialList: [] }) })
      data = { id }
    }
    else if (address.pathname === '/aigc/storyboard' && body && method === 'PUT') {
      if (body.isGenerate !== 0) {
        paidGenerationRequests++
        fail()
        throw new Error('The production snapshot forbids paid generation')
      }
      freeCardWrites++
      cards.set(Number(body.id), structuredClone(body))
      data = body.id
    }
    else {
      fail()
      throw new Error(`Unexpected fixture provider operation: ${method} ${address.pathname}`)
    }
    return new Response(JSON.stringify({ code: 200, data }))
  }
  // Each recorded scenario owns a child process. Restore its exact transport at teardown.
  ctx.effect(() => {
    const previous = globalThis.fetch
    const intercepted = (input, init) => {
      const address = new URL(input instanceof Request ? input.url : String(input))
      return address.hostname === 'production.invalid' ? transport(input, init) : previous(input, init)
    }
    globalThis.fetch = intercepted
    return async () => {
      globalThis.fetch = previous
      await writeFile(`${process.cwd()}/provider-receipt.json`, JSON.stringify({
        storyboards: cards.size, free_card_writes: freeCardWrites, paid_generation_requests: paidGenerationRequests,
        ...(failedOperation === undefined ? {} : { fixture_failure: failedOperation }),
      }, null, 2) + '\n')
    }
  })
  ctx.plugin(JubianVideoSelection, { enabled: true,
    client: new JubianClient({ baseUrl: 'https://production.invalid', credential: async () => 'offline-production-fixture', fetch: transport }),
    ledger: new JubianLedger({ root: `${process.cwd()}/.dsh/production-video-ledger` }),
    defaultModel: { modelId: 'doubao-seedance-2-5-260628', platformId: 'FANG_ZHOU', resolution: '480p' } })
  ctx.plugin(compiler, { ...config, productionPackaging: true, sessionVideoSelection: true,
    production: { baseUrl: 'https://production.invalid', workspaceSecrets: false,
      ledgerRoot: `${process.cwd()}/.dsh/production-publication-ledger` } })
}
