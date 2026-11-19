/** Read-only audio preparation diagnostics through the shipped Loader and model transcript. */
import assert from 'node:assert/strict'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { applyLoopbackServerEffect } from '../loopback-fixture-server.mjs'

export const name = 'audio-preview-diagnostics-fixture'
export const inject = ['tools', 'credentials', 'loader']
const image = { materialType: 'image', materialKey: 'lead', materialAssetId: 142, assetId: 'actor-zhou',
  materialUrl: 'https://media.example/zhou.jpg', fileName: '周海生', sortOrder: 1 }
const audio = { materialType: 'audio', materialKey: 'voice', sortOrder: 2,
  materialUrl: 'https://media.example/voice.wav?token=private-fixture-token' }
const model = { platformId: 'YU_DIAN', modelId: 'doubao-seedance-2-5-260628', standardId: 11,
  genType: 3, modelGenerationTypeId: 7, videoStandardId: 91, duration: 8,
  ratio: '9:16', resolution: '480p', genNum: 1,
  prompt: '@[周海生](lead)说话，声线参考@[周海生](voice)', materialList: [image, audio] }
const expected = 'prepare_video stage=preview_validation; paid_request_sent=false; '
  + 'Audio reference sortOrder must match its consecutive group position and prompt key order'

/** Mount one malformed saved audio reference and verify the next model request receives its local constraint. @param ctx - Headless services. */
export async function apply(ctx) {
  const cwd = process.cwd(), project = join(cwd, '.dsh/audio-project'), ledgerRoot = join(cwd, '.dsh/audio-ledger')
  await mkdir(project, { recursive: true })
  const projectBytes = '{"jubian_script_id":2708}\n'
  await writeFile(join(project, 'project_config.json'), projectBytes)
  let baseUrl, entry, failure, observed = false
  const requests = []
  await applyLoopbackServerEffect(ctx, { label: 'audio-preview-diagnostics-loopback', onCleanup() {},
    onListening(address) { baseUrl = `http://127.0.0.1:${address.port}/prod-api` },
    async requestListener(request, response) {
      try {
        assert.equal(request.headers.authorization, 'Bearer offline-audio-preview-fixture')
        const path = new URL(request.url, 'http://127.0.0.1').pathname
        requests.push(`${request.method} ${path}`)
        assert.equal(request.method, 'GET')
        let data
        if (path === '/prod-api/aigc/storyboard/1745324') {
          data = { id: 1745324, scriptId: 2708, episodeId: 13, isGenerate: 0,
            modelConfig: JSON.stringify(model), storyboardMaterialList: [image, audio] }
        } else if (path === '/prod-api/aigc/asset/142') {
          data = { id: 142, scriptId: 2708, assetUrl: image.materialUrl }
        } else if (path === '/prod-api/aigc/material/list') {
          data = { total: 1, rows: [{ id: 12, assetId: 142, scriptId: 2708, assetName: '周海生',
            hsAssetId: 'actor-zhou', assetUrl: image.materialUrl, hsAssetStatus: 'Active', isUsed: 1 }] }
        } else if (path === '/prod-api/model/charge/getSelectList') {
          data = [{ id: 11, modelId: model.modelId, platformId: model.platformId,
            genTypes: [{ id: 7, type: 3 }], videoStandards: [{ id: 91, ratio: '9:16', resolution: '480p', genNum: 1 }] }]
        } else throw new Error(`Unexpected audio preview request ${path}`)
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
    config: { baseUrl, ledgerRoot, workspaceSecrets: false } })
  entry = ctx.loader.resolve(id)
  await entry.fiber.await()
  assert.ok(ctx.tools.get('jubian_storyboard'))
  ctx.on('llm/stream', async function* (options, next) {
    const message = options.messages.find(message => message.role === 'tool' && message.toolCallId === 'call_prepare_audio')
    if (message !== undefined) {
      assert.equal(observed, false)
      assert.equal(failure, undefined, failure?.stack)
      assert.equal(message.isError, true)
      const text = message.content.filter(block => block.type === 'text').map(block => block.text).join('')
      assert.ok(text.includes(expected), text)
      assert.doesNotMatch(text, /private-fixture-token|offline-audio-preview-fixture|https:\/\/media\.example/)
      assert.deepEqual(requests, ['GET /prod-api/aigc/storyboard/1745324', 'GET /prod-api/aigc/asset/142',
        'GET /prod-api/aigc/material/list', 'GET /prod-api/model/charge/getSelectList'])
      assert.equal(await readFile(join(project, 'project_config.json'), 'utf8'), projectBytes)
      assert.deepEqual(await readdir(project), ['project_config.json'])
      const ledgerFiles = await readdir(ledgerRoot).catch(error => {
        if (error.code === 'ENOENT') return []
        throw error
      })
      assert.equal(ledgerFiles.some(name => name.endsWith('.ndjson')), false)
      await writeFile(join(cwd, 'audio-preview-proof.json'), JSON.stringify({
        diagnostic: expected, modelObservedError: true, providerReads: requests.length,
        paidRequests: 0, previewFiles: 0, ledgerRecords: 0, sourceProjectUnchanged: true,
        privateSourceUrlOmitted: true,
      }, null, 2) + '\n', { flag: 'wx' })
      observed = true
    }
    yield* next()
  })
  ctx.on('agent/turn-stopping', () => { assert.equal(failure, undefined, failure?.stack); assert.equal(observed, true) })
}
