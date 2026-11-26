/** Real native watcher ownership and one original-key submission under a queued completion notice. */
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { importSnapshotPackage } from '../muse-fixture-import.mjs'
const { JubianLedger } = await importSnapshotPackage('@deepseek-ai/dsh-jubian',
  new URL('../../../packages/jubian/tool-jubian/package.json', import.meta.url))
export const name = 'generation-watch-submit-fixture'
export const inject = ['tools', 'llm', 'agents', 'workspaceRegistry', 'sessionController', 'generationWorkspaceAuthority']
const image = 'https://jubian-aigc.tos-cn-beijing.volces.com/fixture/existing.png'
const video = 'https://jubian-aigc.tos-cn-beijing.volces.com/fixture/completed.mp4'
const material = { assetId: 'asset-existing', materialAssetId: 11, fileName: 'Existing CG actor', materialKey: 'lead',
  materialType: 'image', materialUrl: image, sortOrder: 1, official: true, asset_status: 'confirmed' }
const model = { standardId: 61, modelId: 'doubao-seedance-2-5-260628', platformId: 'FANG_ZHOU', genType: 3,
  modelGenerationTypeId: 71, videoStandardId: 337, duration: 30, ratio: '16:9', resolution: '480p', genNum: 1,
  prompt: '@[Existing CG actor](lead)', materialList: [material], backupModelList: [] }
const board = { id: 916953, scriptId: 2708, episodeId: 9, isGenerate: 1, storyboardName: 'Offline horizontal test',
  modelConfig: JSON.stringify(model), storyboardMaterialList: [material] }

/** @param {import('@deepseek-ai/cordis').Context} ctx - Shipped Headless with real native ownership services. */
export async function apply(ctx) {
  const ledgerRoot = join(process.env.DSH_HOME, 'jubian', 'ledger')
  await mkdir(ledgerRoot, { recursive: true })
  await writeFile(join(ledgerRoot, 'authorization.json'), JSON.stringify({ version: 1,
    projects: { '2708': { limit: '1.00', unit: 'CNY' } } }))
  const ledger = new JubianLedger({ root: ledgerRoot })
  let paidPuts = 0, finished = false, noticeQueued = false, replayedUnderGuard = false
  const queued = Promise.withResolvers()
  ctx.effect(() => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString())
      assert.equal(url.origin, 'https://generation-watch.invalid', 'Offline watcher fixture rejects external traffic')
      const path = url.pathname.replace('/prod-api', ''), method = String(init?.method)
      const status = finished ? 'succeeded' : 'submit'
      const task = { id: 335343, scriptId: 2708, storyboardId: 916953, episodeId: 9, taskType: 1, taskStatus: status }
      let data
      if (method === 'PUT' && path === '/aigc/storyboard') {
        assert.equal(++paidPuts, 1, 'Original-key reconciliation cannot send another paid PUT')
        const payload = JSON.parse(init.body)
        assert.equal(payload.id, 916953); assert.equal(payload.isGenerate, 1)
        data = null
      } else if (method === 'GET' && path === '/aigc/storyboard/916953') data = board
      else if (method === 'GET' && path === '/aigc/asset/11') data = { id: 11, scriptId: 2708, assetType: 1,
        assetName: 'Existing CG actor', hsAssetId: 'asset-existing', hsAssetStatus: 'Active', isUsed: 1, assetUrl: image }
      else if (method === 'GET' && path === '/aigc/material/list') data = { total: 1, rows: [{ id: 111, assetId: 11,
        scriptId: 2708, hsAssetId: 'asset-existing', hsAssetStatus: 'Active', isUsed: 1, assetName: 'Existing CG actor', assetUrl: image }] }
      else if (method === 'GET' && path === '/model/charge/getSelectList') data = [{ id: 61, modelId: model.modelId,
        platformId: model.platformId, genTypes: [{ id: 71, type: 3 }], videoStandards: [{ id: 337, ratio: '16:9', resolution: '480p', genNum: 1 }] }]
      else if (method === 'GET' && path === '/admin/aigc/video/task/list') data = { total: paidPuts, rows: paidPuts ? [task] : [] }
      else if (method === 'GET' && path === '/admin/aigc/video/task/335343') data = task
      else if (method === 'POST' && path === '/admin/aigc/video/task/sub/list') data = { total: 1, rows: [{ id: 972949,
        aigcVideoTaskId: 335343, storyboardId: 916953, taskStatus: status, modelConfig: board.modelConfig,
        imageMaterials: board.storyboardMaterialList, resultList: finished ? [{ tosVideoUrl: video, firstResultId: 61 }] : [] }] }
      else throw new Error(`Unexpected offline generation-watch request ${method} ${path}`)
      return Response.json({ code: 200, data })
    }
    return () => { globalThis.fetch = originalFetch }
  })
  ctx.on('agent/created', async ({ agent }) => {
    await (await ctx.workspaceRegistry.create(process.cwd(), 'Offline native generation')).attachSession(agent.id)
  })
  ctx.on('session/event', (_session, event) => {
    if (event.type === 'agent/inbox/spliced' && event.data.inserted.some(message => message.source.kind === 'jubian-generation-watch')) {
      noticeQueued = true; queued.resolve()
    }
  })
  ctx.on('llm/stream', async function* (options, next) {
    if (!finished && options.messages.some(message => message.role === 'tool' && message.toolCallId === 'call_submit_watch')) {
      const submitted = options.messages.find(message => message.role === 'tool' && message.toolCallId === 'call_submit_watch')
      assert.equal(submitted.isError, false, JSON.stringify(submitted.content))
      finished = true
      await queued.promise
    }
    const prepared = options.messages.find(message => message.role === 'tool' && message.toolCallId === 'call_prepare_watch')
    const previewPath = prepared === undefined ? undefined
      : JSON.parse(prepared.content.find(block => block.type === 'text').text).preview_path
    // Replay submits the actual preview path returned by the native tool on each platform.
    let pending
    for await (const chunk of next()) {
      if (chunk.type === 'block-start' && chunk.blockType === 'tool-call') { pending = { start: chunk }; continue }
      if (pending !== undefined && chunk.type === 'tool-call-delta') continue
      if (pending !== undefined && chunk.type === 'block-end' && chunk.block.type === 'tool-call') {
        const block = chunk.block, args = JSON.parse(block.arguments)
        if (block.id === 'call_submit_watch' || block.id === 'call_reconcile_watch') {
          assert.equal(typeof previewPath, 'string')
          args.preview_path = previewPath
        }
        const argumentsJson = JSON.stringify(args)
        yield pending.start
        yield { type: 'tool-call-delta', index: chunk.index, id: block.id, name: block.name, argumentsDelta: argumentsJson }
        yield { ...chunk, block: { ...block, arguments: argumentsJson } }
        pending = undefined
        continue
      }
      yield chunk
    }
  })
  ctx.on('tools/pre-execute', async (exec, next) => {
    if (exec.callId === 'call_reconcile_watch') {
      assert.equal(noticeQueued, true)
      const identity = await ctx.generationWorkspaceAuthority.capture(exec.agent.session.id, exec.signal)
      assert.ok(identity)
      await assert.rejects(ctx.generationWorkspaceAuthority.acquire(identity, exec.signal), /active continuation/u)
      replayedUnderGuard = true
    }
    return next()
  })
  ctx.on('agent/turn-stopping', async ({ agent }) => {
    const events = agent.session.snapshotEvents()
    if (!events.some(event => event.type === 'user/message' && event.data.source.kind === 'jubian-generation-watch')) return
    const result = events.find(event => event.type === 'tool/result' && event.data.message.toolCallId === 'call_reconcile_watch')
    assert.ok(result); assert.equal(result.data.message.isError, false, JSON.stringify(result.data.message.content))
    const readback = JSON.parse(result.data.message.content.find(block => block.type === 'text').text)
    assert.equal(readback.status, 'submitted')
    assert.equal(readback.replayed, true)
    assert.equal(readback.task_id, '335343')
    assert.equal(paidPuts, 1); assert.equal(replayedUnderGuard, true)
    assert.equal((await ledger.records()).length, 1)
    const proof = { completionNoticeQueuedDuringOriginalTurn: noticeQueued, reconciledWhileNativeGuardHeld: replayedUnderGuard,
      confirmedOriginalTask: readback.task_id, paidMockPuts: paidPuts, nativeLedgerRecords: 1, realProviderRequests: 0 }
    await writeFile(join(agent.session.header.cwd, 'watch-proof.json'), `${JSON.stringify(proof, null, 2)}\n`)
  })
  ctx.provide('snapshotWatchReady', true)
}
