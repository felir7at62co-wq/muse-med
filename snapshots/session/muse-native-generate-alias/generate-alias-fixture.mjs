/** Offline model-priority preparation, one native alias submission and original-key reconciliation. */
import assert from 'node:assert/strict'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { importSnapshotPackage } from '../muse-fixture-import.mjs'

const { JubianLedger } = await importSnapshotPackage('@deepseek-ai/dsh-jubian',
  new URL('../../../packages/jubian/tool-jubian/package.json', import.meta.url))
export const name = 'generate-alias-fixture'
export const inject = ['tools', 'llm']
export const legacyKey = 'offline-legacy-unknown-original'
const imageUrl = 'https://jubian-aigc.tos-cn-beijing.volces.com/fixture/existing.png'
export const material = { assetId: 'asset-existing', materialAssetId: 11,
  fileName: 'Existing CG actor', materialKey: 'lead', materialType: 'image', materialUrl: imageUrl,
  sortOrder: 1, official: true, asset_status: 'confirmed' }
export const catalogue = [{ id: 61, modelId: 'doubao-seedance-2-5-260628', platformId: 'FANG_ZHOU',
  genTypes: [{ id: 71, type: 3 }], videoStandards: [{ id: 337, ratio: '16:9', resolution: '480p', genNum: 1 }] }]

/** @param {import('@deepseek-ai/cordis').Context} ctx - Isolated shipped Headless composition. */
export async function apply(ctx) {
  const ledgerRoot = join(process.env.DSH_HOME, 'jubian', 'ledger')
  const calls = []
  let freePuts = 0, paidPuts = 0, preparedInModelRequest = false
  let legacyStartedAt = null, legacyRequestCount = null
  let storyboard = { id: 916953, scriptId: 2708, episodeId: 9, isGenerate: 1,
    storyboardName: 'Offline horizontal test', modelConfig: JSON.stringify({
      standardId: 11, modelId: 'doubao-seedance-2-0-260128', platformId: 'YU_DIAN',
      genType: 3, modelGenerationTypeId: 12, videoStandardId: 13, duration: 30,
      ratio: '16:9', resolution: '720p', genNum: 1, prompt: '@[Existing CG actor](lead)',
    }), storyboardMaterialList: [material] }
  ctx.effect(() => {
    const originalFetch = globalThis.fetch, OriginalDate = Date
    class FixtureDate extends OriginalDate {
      constructor(...args) { super(...(args.length === 0 ? [1790682041000] : args)) }
      static now() { return 1790682041000 }
    }
    globalThis.Date = FixtureDate
    globalThis.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString())
      assert.equal(url.origin, 'https://generate-alias.invalid', 'Offline alias fixture refuses external traffic')
      assert.equal(legacyStartedAt, null, 'A recorded legacy unknown key cannot make any HTTP request')
      const path = url.pathname.replace('/prod-api', ''), method = String(init?.method)
      calls.push({ method, path })
      let data
      if (path === '/model/charge/getSelectList' && method === 'GET') {
        assert.equal(url.searchParams.get('taskType'), '1'); data = catalogue
      } else if (path === '/aigc/storyboard/916953' && method === 'GET') {
        data = storyboard
      } else if (path === '/aigc/storyboard' && method === 'PUT') {
        const payload = JSON.parse(init.body), model = JSON.parse(payload.modelConfig)
        assert.equal(payload.id, 916953); assert.equal(payload.scriptId, 2708)
        assert.equal(model.modelId, 'doubao-seedance-2-5-260628')
        assert.equal(model.platformId, 'FANG_ZHOU'); assert.equal(model.resolution, '480p')
        assert.equal(model.duration, 30); assert.equal(model.ratio, '16:9')
        assert.equal(model.prompt, '@[Existing CG actor](lead)')
        assert.deepEqual(payload.storyboardMaterialList, [material])
        if (payload.isGenerate === 0) assert.equal(++freePuts, 1, 'Only one free model synchronization is expected')
        else {
          assert.equal(payload.isGenerate, 1)
          assert.equal(preparedInModelRequest, true, 'The real preview must reach the next model request before billing')
          assert.equal(++paidPuts, 1, 'The alias and its replay may send only one paid mock PUT')
        }
        storyboard = payload; data = null
      } else if (path === '/aigc/asset/11' && method === 'GET') {
        data = { id: 11, scriptId: 2708, assetType: 1, assetName: 'Existing CG actor',
          hsAssetId: 'asset-existing', hsAssetStatus: 'Active', isUsed: 1, assetUrl: imageUrl }
      } else if (path === '/aigc/material/list' && method === 'GET') {
        assert.equal(url.searchParams.get('scriptId'), '2708')
        data = { total: 1, rows: [{ id: 111, assetId: 11, scriptId: 2708, assetName: 'Existing CG actor',
          hsAssetId: 'asset-existing', hsAssetStatus: 'Active', isUsed: 1, materialType: 1, assetUrl: imageUrl }] }
      } else if (path === '/admin/aigc/video/task/list' && method === 'GET') {
        assert.equal(url.searchParams.get('scriptId'), '2708')
        data = { total: paidPuts, rows: paidPuts ? [{ id: 335343, scriptId: 2708, episodeId: 9, taskType: 1 }] : [] }
      } else if (path === '/admin/aigc/video/task/335343' && method === 'GET') {
        data = { id: 335343, scriptId: 2708, episodeId: 9, taskType: 1, taskStatus: 'succeeded' }
      } else if (path === '/admin/aigc/video/task/sub/list' && method === 'POST') {
        assert.deepEqual(JSON.parse(init.body), { aigcVideoTaskId: '335343' })
        const { videoStandardId, ...config } = JSON.parse(storyboard.modelConfig)
        data = { total: 1, rows: [{ id: 972949, aigcVideoTaskId: 335343, storyboardId: 916953,
          taskStatus: 'succeeded', ...config, modelVideoStandardId: videoStandardId,
          imageMaterials: storyboard.storyboardMaterialList }] }
      } else throw Error(`Unexpected offline alias request ${method} ${path}`)
      return new Response(JSON.stringify({ code: 200, data }), { status: 200 })
    }
    return () => { globalThis.fetch = originalFetch; globalThis.Date = OriginalDate }
  })
  await mkdir(ledgerRoot, { recursive: true })
  await writeFile(join(ledgerRoot, 'authorization.json'), JSON.stringify({ version: 1,
    projects: { '2708': { limit: '1.00', unit: 'CNY' } } }))
  const ledger = new JubianLedger({ root: ledgerRoot })
  await ledger.begin({ idempotencyKey: legacyKey, method: 'storyboard_generate', scriptId: 2708,
    requestSha256: 'sha256:offline-legacy-original', quotedAmount: '0.25', quoteUnit: 'CNY' })
  await ledger.settle(legacyKey, { httpStatus: null, applicationCode: null, responseSha256: null, outcome: 'unknown' })
  ctx.on('llm/stream', async function* (options, next) {
    for (const message of options.messages) {
      if (message.role !== 'tool') continue
      for (const block of message.content) {
        if (block.type !== 'text') continue
        let data
        try { data = JSON.parse(block.text) } catch { continue }
        if (data.operation !== 'prepare_storyboard_native_video') continue
        assert.equal(data.storyboardId, 916953)
        const model = JSON.parse(data.payload.modelConfig)
        assert.equal(model.duration, 30); assert.equal(model.modelId, 'doubao-seedance-2-5-260628')
        assert.equal(model.resolution, '480p')
        preparedInModelRequest = true
      }
    }
    yield* next()
  })
  ctx.on('tools/pre-execute', (exec, next) => {
    if (exec.name === 'jubian_storyboard' && exec.arguments?.idempotency_key === legacyKey) legacyStartedAt = calls.length
    return next()
  })
  ctx.on('tools/result', (exec) => {
    if (exec.name === 'jubian_storyboard' && exec.arguments?.idempotency_key === legacyKey) {
      legacyRequestCount = calls.length - legacyStartedAt
      legacyStartedAt = null
      assert.equal(legacyRequestCount, 0)
    }
  })
  ctx.on('agent/turn-stopping', async ({ agent }) => {
    const events = agent.session.snapshotEvents()
    const result = id => {
      const message = events.find(event => event.type === 'tool/result' && event.data.message.toolCallId === id)?.data.message
      assert.ok(message, `Missing actual alias result ${id}`)
      assert.equal(message.isError, false, JSON.stringify(message.content))
      return JSON.parse(message.content.filter(block => block.type === 'text').map(block => block.text).join('\n'))
    }
    const prepared = result('call_prepare_alias'), submitted = result('call_submit_alias')
    const replayed = result('call_reconcile_alias'), legacy = result('call_replay_legacy')
    assert.equal(prepared.operation, 'prepare_storyboard_native_video')
    assert.equal(prepared.status, 'prepared')
    assert.equal(submitted.status, 'submitted'); assert.equal(submitted.task_id, '335343')
    assert.equal(replayed.replayed, true); assert.equal(replayed.status, 'submitted')
    assert.equal(legacy.replayed, true); assert.equal(legacy.outcome, 'unknown')
    assert.equal(freePuts, 1); assert.equal(paidPuts, 1)
    assert.equal(preparedInModelRequest, true); assert.equal(legacyRequestCount, 0)
    const snapshot = JSON.parse(await readFile(prepared.preview_path, 'utf8'))
    assert.equal(snapshot.idempotencyKey, prepared.idempotencyKey)
    assert.deepEqual(snapshot.payload, prepared.payload)
    const records = await ledger.records()
    assert.equal(records.filter(record => record.method === 'storyboard_native_submit').length, 1)
    assert.equal((await ledger.find(legacyKey)).outcome, 'unknown')
    const directory = join(agent.session.header.cwd, 'project', 'video_tasks')
    const files = (await readdir(directory)).sort()
    assert.equal(files.filter(file => file.endsWith('.storyboard-native.prepared.json')).length, 1)
    const proof = { preparedInNextModelRequest: preparedInModelRequest,
      initialSavedModel: { modelId: 'doubao-seedance-2-0-260128', platformId: 'YU_DIAN', resolution: '720p' },
      submittedModel: { modelId: 'doubao-seedance-2-5-260628', platformId: 'FANG_ZHOU', resolution: '480p', duration: 30, ratio: '16:9' },
      freeModelSyncPuts: freePuts, paidMockPuts: paidPuts, legacyUnknownReplayHttpCalls: legacyRequestCount,
      matchedTaskId: submitted.task_id, nativeReplay: replayed.replayed, originalLegacyOutcome: legacy.outcome,
      nativeLedgerRecords: 1, preparedFiles: files, realProviderRequests: 0 }
    await writeFile(join(agent.session.header.cwd, 'alias-proof.json'), `${JSON.stringify(proof, null, 2)}\n`)
  })
  ctx.provide('snapshotGenerateAliasReady', true)
}
