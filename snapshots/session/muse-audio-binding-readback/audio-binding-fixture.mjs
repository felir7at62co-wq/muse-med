/** Free audio-name persistence and original-key reconciliation through the real tools. */
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const name = 'audio-binding-fixture'
export const inject = ['tools', 'llm']
export const image = { assetId: 'lead-identity', materialAssetId: 11, materialType: 'image',
  materialKey: 'lead', materialUrl: 'https://media.example/lead.png', fileName: '秦铭形象', sortOrder: 1 }
export const voices = [
  { materialType: 'audio', materialKey: 'audio-31', materialUrl: 'https://media.example/qin.wav',
    materialName: '秦铭', sortOrder: 1, audioDuration: 2, audio_asset_id: 31 },
  { materialType: 'audio', materialKey: 'audio-32', materialUrl: 'https://media.example/su.wav',
    materialName: '苏浩', sortOrder: 2, audioDuration: 2, audio_asset_id: 32 },
]
export const prompt = '@[秦铭形象](lead)与苏浩交谈。秦铭声音参照@[秦铭](audio-31)，苏浩声音参照@[苏浩](audio-32)。'
export const initialConfig = { modelId: 'doubao-seedance-2-5-260628', platformId: 'FANG_ZHOU',
  duration: 20, ratio: '9:16', resolution: '480p', prompt: '@[秦铭形象](lead)与苏浩交谈。', materialList: [image] }

/** @param {import('@deepseek-ai/cordis').Context} ctx - Shipped Headless composition. */
export async function apply(ctx) {
  let board = { id: 916953, scriptId: 2708, episodeId: 9, episodeCount: 157,
    storyboardName: 'EP157-P6', sortOrder: 6, isGenerate: 0,
    modelConfig: JSON.stringify(initialConfig), storyboardMaterialList: [image] }
  let putCount = 0, applyCalls = 0, canonicalPreviewReachedModel = false, verifiedResultReachedModel = false
  ctx.effect(() => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString())
      assert.equal(url.origin, 'https://audio-binding.invalid', 'Audio binding fixture refuses real provider requests')
      const path = url.pathname.replace('/prod-api', ''), method = String(init?.method)
      let data
      if (method === 'GET' && path === '/aigc/storyboard/916953') data = board
      else if (method === 'GET' && /^\/aigc\/asset\/(31|32)$/.test(path)) {
        const id = Number(path.split('/').pop()), voice = voices.find(row => row.audio_asset_id === id)
        data = { id, scriptId: 2708, assetType: 4, assetName: voice.materialName,
          assetUrl: voice.materialUrl, isLocal: 1, delFlag: '0' }
      } else if (method === 'PUT' && path === '/aigc/storyboard') {
        const payload = JSON.parse(init.body)
        assert.equal(++putCount, 1, 'Original-key reconciliation must not submit another PUT')
        assert.equal(payload.isGenerate, 0, 'Audio edits never generate paid media')
        assert.equal(payload.id, 916953)
        const config = JSON.parse(payload.modelConfig)
        assert.deepEqual(config.materialList.map(row => row.fileName), ['秦铭形象', '秦铭', '苏浩'])
        assert.deepEqual(config.materialList.slice(1).map(row => row.materialName), ['秦铭', '苏浩'])
        assert.equal(config.prompt, prompt)
        assert.deepEqual(payload.storyboardMaterialList.map(row => row.fileName), ['秦铭形象', '秦铭', '苏浩'])
        assert.ok(payload.storyboardMaterialList.slice(1).every(row => !Object.hasOwn(row, 'materialName')))
        board = payload
        // The provider persists relationship fileName, not the model's materialName alias.
        board.storyboardMaterialList = board.storyboardMaterialList.map(row => {
          const { materialName: _unused, ...saved } = row
          return saved
        })
        data = null
      } else throw new Error(`Unexpected offline audio request ${method} ${path}`)
      return new Response(JSON.stringify({ code: 200, data }))
    }
    return () => { globalThis.fetch = originalFetch }
  })
  ctx.on('tools/pre-execute', (exec, next) => {
    if (exec.name === 'jubian_storyboard' && exec.arguments?.method === 'audio_apply') {
      applyCalls++
      if (applyCalls === 2) {
        // Simulate a later external name change; the same key may only read it back.
        board.storyboardMaterialList = board.storyboardMaterialList.map(row => row.materialKey === 'audio-32'
          ? { ...row, fileName: '另一角色声音' } : row)
      }
    }
    return next()
  })
  ctx.on('llm/stream', async function* (options, next) {
    for (const message of options.messages) {
      if (message.role !== 'tool') continue
      for (const block of message.content) {
        if (block.type !== 'text') continue
        let value
        try { value = JSON.parse(block.text) } catch { continue }
        if (value.operation === 'storyboard_audio') {
          assert.deepEqual(value.audio_references.map(row => row.fileName), ['秦铭', '苏浩'])
          canonicalPreviewReachedModel = true
        }
        if (value.status === 'applied' && value.verified_readback === true) verifiedResultReachedModel = true
      }
    }
    yield* next()
  })
  ctx.on('agent/turn-stopping', async ({ agent }) => {
    const events = agent.session.snapshotEvents()
    const result = (id, error = false) => {
      const message = events.find(event => event.type === 'tool/result' && event.data.message.toolCallId === id)?.data.message
      assert.ok(message, `Missing actual audio result ${id}`)
      assert.equal(message.isError, error, JSON.stringify(message.content))
      const text = message.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
      return error ? text : JSON.parse(text)
    }
    const refused = result('call_refuse_blank_audio', true)
    assert.match(refused, /audio|label|marker/i)
    const preview = result('call_preview_audio'), applied = result('call_apply_audio'), changed = result('call_reconcile_audio')
    assert.deepEqual(preview.audio_references.map(row => row.fileName), ['秦铭', '苏浩'])
    assert.equal(applied.status, 'applied'); assert.equal(applied.verified_readback, true)
    assert.equal(changed.status, 'readback_mismatch'); assert.equal(changed.verified_readback, false)
    assert.equal(changed.replayed, true)
    assert.deepEqual(changed.mismatched_fields, ['storyboardMaterialList'])
    assert.match(changed.next, /original|key|reconcil/i)
    assert.equal(canonicalPreviewReachedModel, true); assert.equal(verifiedResultReachedModel, true)
    assert.equal(putCount, 1); assert.equal(applyCalls, 2)
    const plan = JSON.parse(await readFile(preview.preview_path, 'utf8'))
    assert.deepEqual(plan.audio_references, preview.audio_references)
    assert.deepEqual(plan.after_snapshot.modelConfig.materialList.map(row => row.fileName), ['秦铭形象', '秦铭', '苏浩'])
    const proof = { canonicalAudioNames: preview.audio_references.map(row => row.fileName),
      canonicalPreviewReachedModel, verifiedResultReachedModel, initialBindingVerified: applied.verified_readback,
      laterNameChangeVerified: changed.verified_readback, mismatchedFields: changed.mismatched_fields,
      reconciliationReplayed: changed.replayed, freeProviderPuts: putCount, paidProviderRequests: 0 }
    await writeFile(join(agent.session.header.cwd, 'audio-binding-proof.json'), `${JSON.stringify(proof, null, 2)}\n`)
  })
  ctx.provide('snapshotAudioBindingReady', true)
}
