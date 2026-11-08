/** Actual Loader and authenticated loopback audio binding with original-key recovery. */
import assert from 'node:assert/strict'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { applyLoopbackServerEffect } from '../loopback-fixture-server.mjs'

export const name = 'audio-binding-readback-fixture'
export const inject = ['tools', 'credentials', 'loader']
const image = { id: 42, assetId: 'character-zhou', materialAssetId: 142, materialType: 'image',
  materialUrl: 'https://media.example/zhou.jpg', fileName: '周海生', materialKey: 'zhou', sortOrder: 1 }
const originalModel = { platformId: 'YU_DIAN', modelId: 'doubao-seedance-2-5-260628', standardId: 11,
  genType: 3, modelGenerationTypeId: 7, videoStandardId: 91, duration: 29,
  ratio: '9:16', resolution: '480p', genNum: 1, seed: 12, prompt: '@[周海生](zhou)走到门口', materialList: [image] }
const originalBoard = { id: 1745324, scriptId: 2708, episodeId: 13, episodeCount: 2, scriptName: '原项目',
  storyboardName: 'EP02-P01', sortOrder: 1, isGenerate: 1, modelConfig: JSON.stringify(originalModel),
  storyboardMaterialList: [image], custom: 'preserve' }
const prompt = '@[周海生](zhou)走到门口，先参照@[周海生声线](voice-a)，再参照@[周海生声线](voice-b)'
const expectedAudio = [
  { materialType: 'audio', materialKey: 'voice-a', materialUrl: 'https://media.example/zhou-a.wav',
    materialName: '周海生声线', sortOrder: 1, audioDuration: 2, fileName: '周海生声线' },
  { materialType: 'audio', materialKey: 'voice-b', materialUrl: 'https://media.example/zhou-b.wav',
    materialName: '周海生声线', fileName: '周海生-v2.wav', sortOrder: 2, audioDuration: 2 },
]
const relationAudio = expectedAudio.map(({ materialName: _name, ...row }) => row)
const expectedBody = { ...originalBoard, isGenerate: 0,
  modelConfig: JSON.stringify({ ...originalModel, prompt, materialList: [image, ...expectedAudio] }),
  storyboardMaterialList: [image, ...relationAudio] }

/**
 * Mount the production tool and observe all five full results without changing them.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Shipped Headless context.
 * @param {{executor: 'native'|'ptc'}} config - Fixture executor.
 */
export async function apply(ctx, config) {
  const cwd = process.cwd(), project = join(cwd, '.dsh/audio-project'), ledgerRoot = join(cwd, '.dsh/audio-ledger')
  await mkdir(project, { recursive: true })
  const projectBytes = '{"jubian_script_id":2708}\n'
  await writeFile(join(project, 'project_config.json'), projectBytes)
  let board = structuredClone(originalBoard), mode = 'normal', baseUrl, failure, entry
  let calls = 0, puts = 0, capturedLedger, preview, requestHash
  const results = [], observed = new Set(), requests = [], dispatches = []
  const ledgerBytes = async () => {
    const names = (await readdir(ledgerRoot)).filter(name => name.endsWith('.ndjson')).sort()
    assert.equal(names.length, 1)
    return readFile(join(ledgerRoot, names[0]))
  }
  await applyLoopbackServerEffect(ctx, { label: 'audio-name-readback-loopback', onCleanup() {},
    onListening(address) { baseUrl = `http://127.0.0.1:${address.port}/prod-api` },
    async requestListener(request, response) {
      try {
        assert.equal(request.headers.authorization, 'Bearer offline-audio-name-fixture')
        const path = new URL(request.url, 'http://127.0.0.1').pathname
        let body = Buffer.alloc(0)
        for await (const chunk of request) { body = Buffer.concat([body, chunk]); assert.ok(body.length < 65536) }
        requests.push({ method: request.method, path, phase: calls + 1 })
        let data
        if (request.method === 'GET' && path === '/prod-api/aigc/storyboard/1745324') {
          if (mode === 'failure') { response.writeHead(500); response.end('{"code":500}'); return }
          data = board
        } else if (request.method === 'GET' && /^\/prod-api\/aigc\/asset\/(77|78)$/.test(path)) {
          const id = Number(path.split('/').at(-1))
          data = { id, scriptId: 2708, assetType: 4, assetName: '周海生声线', isLocal: 1, delFlag: '0',
            assetUrl: id === 77 ? expectedAudio[0].materialUrl : expectedAudio[1].materialUrl }
        } else if (request.method === 'PUT' && path === '/prod-api/aigc/storyboard') {
          assert.equal(++puts, 1)
          const payload = JSON.parse(body.toString('utf8'))
          assert.deepEqual(payload, expectedBody)
          board = structuredClone(payload)
          data = null
        } else throw new Error(`Unexpected local audio request ${request.method} ${path}`)
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ code: 200, data }))
      } catch (error) {
        failure = error
        response.writeHead(500); response.end('{"code":500}')
      }
    },
  })
  ctx.effect(() => async () => {
    if (entry !== undefined) { await entry.fiber?.dispose(); ctx.loader.remove(entry.id) }
  })
  const id = await ctx.loader.create({ name: new URL('../../../packages/jubian/tool-jubian/tests/snapshot-plugin.mjs', import.meta.url).href,
    config: { baseUrl, ledgerRoot, workspaceSecrets: false, timeoutMs: 3000 } })
  entry = ctx.loader.resolve(id)
  await entry.fiber.await()
  assert.ok(ctx.tools.get('jubian_storyboard'))
  ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    if (exec.name !== 'jubian_storyboard') return decision
    assert.equal(failure, undefined, failure?.stack)
    assert.equal(decision.kind, 'accept')
    assert.equal(decision.content, undefined)
    assert.equal(result.isError, false, JSON.stringify(result.content))
    const value = JSON.parse(result.content[0].text)
    calls++
    assert.equal(exec.arguments.method, ['audio_preview', 'audio_apply', 'get', 'audio_apply', 'audio_apply'][calls - 1])
    results.push(value)
    assert.equal(await readFile(join(project, 'project_config.json'), 'utf8'), projectBytes)
    if (calls === 1) {
      preview = value; requestHash = value.request_hash
      assert.equal(value.status, 'ready')
      assert.deepEqual(value.audio_references, expectedAudio)
      assert.deepEqual(value.audio_asset_bindings.map(row => [row.asset_id, row.material_key, row.url]),
        [[77, 'voice-a', expectedAudio[0].materialUrl], [78, 'voice-b', expectedAudio[1].materialUrl]])
    } else {
      assert.equal(puts, 1)
      if (calls === 2) {
        assert.equal(value.status, 'applied'); assert.equal(value.verified_readback, true)
        assert.deepEqual(value.mismatched_fields, [])
        capturedLedger = await ledgerBytes()
        const records = capturedLedger.toString('utf8').trim().split('\n').map(line => JSON.parse(line))
        const begin = records.find(record => record.phase === 'begin')
        assert.equal(begin.idempotency_key, preview.fingerprint)
        assert.equal(begin.method, 'storyboard_save'); assert.equal(begin.script_id, 2708)
        assert.equal(begin.request_sha256, requestHash)
      } else {
        assert.deepEqual(await ledgerBytes(), capturedLedger)
        if (calls === 3) {
          assert.deepEqual(value.storyboard.snapshot, expectedBody)
          board.storyboardMaterialList[2].fileName = 'provider changed the displayed name'
        } else if (calls === 4) {
          assert.equal(value.status, 'readback_mismatch'); assert.equal(value.verified_readback, false)
          assert.equal(value.replayed, true); assert.deepEqual(value.mismatched_fields, ['storyboardMaterialList'])
          assert.match(value.next, /original preview and key/)
          mode = 'failure'
        } else {
          assert.equal(calls, 5); assert.equal(value.status, 'unknown'); assert.equal(value.verified_readback, false)
          assert.equal(value.replayed, true); assert.match(value.next, /original preview and key/)
        }
      }
    }
    return decision
  })
  ctx.on('session/event', (session, event) => {
    if (event.type === 'tool/ptc-dispatch' && event.data.name === 'jubian_storyboard') dispatches.push(event.data)
  })
  ctx.on('llm/stream', async function* (options, next) {
    for (const message of options.messages) {
      if (message.role !== 'tool' || !/^call_audio_[1-5]$/.test(message.toolCallId)) continue
      const index = Number(message.toolCallId.at(-1)) - 1
      assert.deepEqual(JSON.parse(message.content[0].text), results[index])
      observed.add(index)
    }
    if (observed.size === 5) {
      assert.equal(puts, 1); assert.deepEqual(await ledgerBytes(), capturedLedger)
      const expectedPhases = [1, 2, 3, 4, 5]
      assert.deepEqual([...new Set(requests.filter(row => row.path.endsWith('/storyboard/1745324')).map(row => row.phase))], expectedPhases)
      if (config.executor === 'ptc') assert.equal(dispatches.length, 5)
      await writeFile(join(cwd, 'audio-binding-proof.json'), JSON.stringify({
        resultsObserved: 5, statuses: ['ready', 'applied', 'get', 'readback_mismatch', 'unknown'],
        providerPutCount: puts, paidRequests: 0, isGenerate: 0, independentGetPhases: expectedPhases,
        sameHumanNameDistinctKeys: true, relationFileNames: relationAudio.map(row => row.fileName),
        modelMaterialNames: expectedAudio.map(row => row.materialName), originalImageAndCardModelPreserved: true,
        sameOriginalKey: preview.fingerprint, ledgerRequestHash: requestHash, ledgerBytesUnchangedAfterFirstApply: true,
        fullResultsObservedInNextModelRequests: true, ptcDispatches: config.executor === 'ptc' ? dispatches.length : 0,
      }, null, 2) + '\n', { flag: 'wx' })
    }
    yield* next()
  })
  ctx.on('agent/turn-stopping', () => {
    assert.equal(failure, undefined, failure?.stack)
    assert.equal(calls, 5); assert.equal(observed.size, calls)
    assert.equal(puts, 1)
  })
}
