/** Offline reconciliation of an unknown images-then-audio submission with no current task row or old file. */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

const face = process.env.DSH_EXAMPLE_MODE === 'lib' ? 'lib/index.js' : 'src/index.ts'
const { buildNativeVideoPreview, stableSha256, submissionSemantics } = await import(
  new URL(`../../../packages/jubian/jubian-api/${face}`, import.meta.url).href)

export const name = 'legacy-key-fixture'
const origin = 'https://jubian-aigc.tos-cn-beijing.volces.com/fixture/'
const models = [{ id: 61, modelId: 'doubao-seedance-2-5-260628', platformId: 'FANG_ZHOU',
  genTypes: [{ id: 71, type: 3 }], videoStandards: [{ id: 337, ratio: '16:9', resolution: '480p', genNum: 1 }] }]
const assets = [
  { id: 11, scriptId: 2708, assetType: 1, assetName: 'Existing CG actor', assetUrl: origin + 'lead.png', hsAssetId: 'asset-lead',
    hsAssetStatus: 'Active', isUsed: 1, official: true, asset_status: 'confirmed' },
  { id: 12, scriptId: 2708, assetType: 1, assetName: 'Existing CG guest', assetUrl: origin + 'guest.png', hsAssetId: 'asset-guest',
    hsAssetStatus: 'Active', isUsed: 1, official: true, asset_status: 'confirmed' },
]
const storyboard = { id: 916953, scriptId: 2708, isGenerate: 1, storyboardName: 'Offline legacy-key reconciliation',
  modelConfig: JSON.stringify({ standardId: 61, modelId: 'doubao-seedance-2-5-260628', platformId: 'FANG_ZHOU',
    genType: 3, modelGenerationTypeId: 71, videoStandardId: 337, duration: 4, ratio: '16:9', resolution: '480p', genNum: 1,
    prompt: '@[Existing CG actor](lead) @[声线](voice) @[Existing CG guest](guest)' }),
  storyboardMaterialList: [
    { assetId: 'asset-lead', materialAssetId: 11, fileName: 'Existing CG actor', materialKey: 'lead',
      materialType: 'image', materialUrl: origin + 'lead.png', sortOrder: 1 },
    { assetId: 'asset-guest', materialAssetId: 12, fileName: 'Existing CG guest', materialKey: 'guest',
      materialType: 'image', materialUrl: origin + 'guest.png', sortOrder: 2 },
    { materialType: 'audio', materialKey: 'voice', fileName: 'lead voice', materialUrl: origin + 'voice.wav',
      sortOrder: 1, audioDuration: 2 },
  ] }
storyboard.modelConfig = JSON.stringify({ ...JSON.parse(storyboard.modelConfig), materialList: storyboard.storyboardMaterialList })
export const inputs = { storyboard, assets, models, createdAt: '2026-09-29T11:40:41.000Z' }

export function apply(ctx) {
  const root = join(process.env.DSH_HOME, 'jubian', 'ledger')
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'authorization.json'), JSON.stringify({ version: 1,
    projects: { '2708': { limit: '5.00', unit: 'CNY' } } }))
  const preview = buildNativeVideoPreview(inputs)
  const materials = preview.payload.storyboardMaterialList
  const grouped = [...materials.filter(row => row.materialType === 'image'), ...materials.filter(row => row.materialType === 'audio')]
  const payload = { ...preview.payload, storyboardMaterialList: grouped,
    modelConfig: JSON.stringify({ ...JSON.parse(preview.payload.modelConfig), materialList: grouped }) }
  const key = stableSha256(submissionSemantics(payload))
  const at = '2026-09-29T11:40:41.000Z'
  const records = [
    { phase: 'begin', record_id: 'offline-legacy-intent', idempotency_key: key, method: 'storyboard_native_submit',
      script_id: 2708, at, request_sha256: 'sha256:' + createHash('sha256').update(JSON.stringify(payload)).digest('hex'),
      quoted_amount: '0.50', quote_unit: 'CNY', quote_standard_id: null, quote_observed_at: null,
      http_status: null, application_code: null, response_sha256: null, outcome: null },
    { phase: 'settle', idempotency_key: key, settled_at: at, http_status: null, application_code: null,
      response_sha256: null, outcome: 'unknown' },
  ]
  writeFileSync(join(root, '2026-09-29.ndjson'), records.map(record => JSON.stringify(record) + '\n').join(''))
  ctx.effect(() => {
    const original = globalThis.fetch
    const OriginalDate = Date
    class FixtureDate extends OriginalDate {
      constructor(...args) { super(...(args.length === 0 ? [1790682041000] : args)) }
      static now() { return 1790682041000 }
    }
    globalThis.Date = FixtureDate
    let writes = 0
    globalThis.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString())
      if (url.hostname !== 'native-legacy.invalid') throw new Error('Offline legacy fixture refuses external traffic')
      if (init?.method === 'PUT') { writes += 1; throw new Error('An unknown original key cannot authorize another PUT') }
      let data
      if (url.pathname.endsWith('/getSelectList')) data = models
      else if (url.pathname.endsWith('/aigc/storyboard/916953')) data = storyboard
      else if (/\/aigc\/asset\/(11|12)$/.test(url.pathname)) data = assets.find(row => row.id === Number(url.pathname.split('/').pop()))
      else if (url.pathname.endsWith('/aigc/material/list')) data = { total: 2,
        rows: assets.map(row => ({ ...row, id: row.id + 100, assetId: row.id })) }
      else if (url.pathname.endsWith('/admin/aigc/video/task/list')) data = { total: 0, rows: [] }
      else throw new Error('Unexpected offline legacy request')
      return new Response(JSON.stringify({ code: 200, data }), { status: 200 })
    }
    return () => {
      globalThis.fetch = original
      globalThis.Date = OriginalDate
      if (writes !== 0) throw new Error('Offline legacy fixture observed an extra PUT')
    }
  })
}
