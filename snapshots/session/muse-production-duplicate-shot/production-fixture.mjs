/** Real production preview with a deterministic read-only catalogue and inventory. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { importSnapshotModule, importSnapshotPackage } from '../muse-fixture-import.mjs'

const owner = new URL('../../../packages/drama/tool-shot-script/package.json', import.meta.url)
const { JubianClient, JubianLedger } = await importSnapshotPackage('@deepseek-ai/dsh-jubian', owner)
const { JubianVideoSelection } = await importSnapshotPackage('@deepseek-ai/dsh-tool-jubian', owner)
const compiler = await importSnapshotModule(new URL('./src/index.ts', owner), new URL('./lib/index.js', owner))
const catalogue = JSON.parse(await readFile(new URL('../../../packages/jubian/jubian-api/tests/fixtures/catalogue-20261016.json', import.meta.url), 'utf8'))
const baseUrl = 'https://production.invalid'
const inventory = new Map([
  ['/model/charge/getSelectList?taskType=1', catalogue['1']],
  ['/aigc/script/4908', { id: 4908, scriptName: 'Production fixture' }],
  ['/aigc/episode/list', { total: 1, rows: [{ id: 102505, scriptId: 4908, episodeCount: 1 }] }],
  ['/aigc/asset/list', { total: 0, rows: [] }],
  ['/aigc/material/list', { total: 0, rows: [] }],
  ['/aigc/storyboard/list', { total: 0, rows: [] }],
])

async function productionFetch(input, init) {
  const url = new URL(input instanceof Request ? input.url : String(input))
  const path = url.pathname === '/model/charge/getSelectList' ? url.pathname + url.search : url.pathname
  if (url.origin !== baseUrl || init?.method !== 'GET' || !inventory.has(path)) {
    throw new Error('Unexpected request from read-only production preview')
  }
  return new Response(JSON.stringify({ code: 200, data: inventory.get(path) }))
}

/** Mount actual production tool and video-selection services in the CLI profile. */
export function apply(ctx) {
  ctx.effect(() => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = productionFetch
    return () => { globalThis.fetch = originalFetch }
  })
  const client = new JubianClient({ baseUrl, credential: async () => 'offline-production', fetch: productionFetch })
  const ledger = new JubianLedger({ root: join(process.env.DSH_HOME, 'production-ledger') })
  ctx.plugin(JubianVideoSelection, { client, ledger, enabled: true,
    defaultModel: { modelId: 'doubao-seedance-2-5-260628', platformId: 'FANG_ZHOU', resolution: '480p' } })
  ctx.plugin(compiler, { reviewMode: 'advisory', productionPackaging: true, production: { baseUrl, workspaceSecrets: false } })
}
