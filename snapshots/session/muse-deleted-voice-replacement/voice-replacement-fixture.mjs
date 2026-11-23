/** Real shared-slot lifecycle with an offline provider that retains deleted audio rows. */
import assert from 'node:assert/strict'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createVoiceSlots } from '../../../services/muse-accounts/voice-slots.mjs'

export const name = 'voice-replacement-fixture'
export const inject = ['tools']
export const reason = 'Remove the reviewed offline voice before replacing it'
export const authorization = 'User authorized deletion of audio 51 and a new replacement registration'

export async function apply(ctx) {
  assert.ok(process.env.DSH_HOME, 'The Loader must isolate gateway receipts and local claims')
  const assets = [], posts = [], deletes = []
  const slot = { script_id: 2708, character_id: 'zhou', voice_period_id: 'adult' }
  const options = { root: join(process.env.DSH_HOME, 'voice-slots'), now: () => 1795146000000,
    verifyProject: async ({ token, scriptId }) => {
      assert.equal(token, 'offline-voice-replacement'); assert.equal(scriptId, slot.script_id)
    },
    verifyAsset: async ({ assetId }) => assets.find(asset => asset.id === assetId) ?? null }
  const service = createVoiceSlots(options)
  await service.ready()
  ctx.effect(() => ctx.provide('museAccount', { requestVoiceSlot: (request, token) => service.request('offline-alice', token, request) }))
  ctx.effect(() => {
    const original = globalThis.fetch
    globalThis.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString())
      assert.equal(url.origin, 'https://voice-replacement.invalid', 'No production requests are permitted')
      const path = url.pathname.replace('/prod-api', '')
      const answer = data => Response.json({ code: 200, data })
      if (init?.method === 'GET') {
        if (path === '/aigc/asset/list') {
          assert.equal(url.searchParams.get('scriptId'), '2708')
          assert.equal(url.searchParams.get('pageNum'), '1')
          return answer({ total: assets.length, rows: assets })
        }
        if (/^\/aigc\/asset\/(51|52)$/u.test(path)) return answer(assets.find(asset => asset.id === Number(path.split('/').pop())) ?? null)
        if (path === '/aigc/material/selectNoPage') return answer([])
        if (path === '/aigc/storyboard/list') return answer({ total: 0, rows: [] })
      }
      if (init?.method === 'POST' && path === '/aigc/asset') {
        const body = JSON.parse(init.body)
        assert.equal(body.scriptId, 2708); assert.equal(body.assetType, 4)
        assert.ok(posts.length < 2, 'Original registrations may never be sent again')
        posts.push(body)
        const id = 50 + posts.length
        assets.push({ id, scriptId: body.scriptId, assetType: 4, assetName: body.assetName, url: body.url, isLocal: 1, delFlag: '0' })
        return answer(id)
      }
      if (init?.method === 'DELETE' && path === '/aigc/asset/removeAsset/51') {
        assert.equal(url.searchParams.get('scriptId'), '2708')
        assert.deepEqual(deletes, [], 'Deletion replay must stay read-only')
        const asset = assets.find(asset => asset.id === 51)
        assert.ok(asset); asset.delFlag = '1'; deletes.push(51)
        return new Response(null, { status: 200 })
      }
      throw Error(`Unexpected offline voice request ${init?.method} ${path}`)
    }
    return () => { globalThis.fetch = original }
  })
  ctx.on('agent/turn-stopping', async ({ agent }) => {
    const messages = agent.session.snapshotEvents().filter(event => event.type === 'tool/result').map(event => event.data.message)
    const result = id => {
      const message = messages.find(message => message.toolCallId === id)
      assert.ok(message, `Missing actual result ${id}`); assert.equal(message.isError, false)
      return JSON.parse(message.content.filter(block => block.type === 'text').map(block => block.text).join('\n'))
    }
    assert.equal(result('call_voice_original').canonical_voice_asset_id, 51)
    assert.equal(result('call_voice_delete').status, 'deleted')
    assert.equal(result('call_voice_delete').verified_readback, true)
    assert.equal(result('call_voice_delete').response_status, 'unknown')
    for (const id of ['call_voice_replacement', 'call_voice_original_replay', 'call_voice_replacement_replay']) {
      const value = result(id)
      assert.equal(value.canonical_voice_asset_id, 52); assert.equal(value.shared_slot_verified, true)
    }
    assert.equal(result('call_voice_original_replay').replayed, true)
    assert.equal(result('call_voice_replacement_replay').replayed, true)
    assert.equal(result('call_voice_replacement').exclusive_registration, true)
    assert.deepEqual(posts.map(body => body.url), ['https://media.example/original.wav', 'https://media.example/replacement.wav'])
    assert.deepEqual(deletes, [51])
    assert.deepEqual(assets.map(asset => [asset.id, asset.delFlag]), [[51, '1'], [52, '0']])
    const restarted = createVoiceSlots(options); await restarted.ready()
    await assert.rejects(restarted.request('offline-alice', 'offline-voice-replacement', {
      ...slot, action: 'acquire', operation_key: 'offline-original-voice' }), { code: 'operation_retired' })
    const receipts = (await readdir(options.root)).filter(path => path.startsWith('retired-'))
    assert.equal(receipts.length, 1)
    const ledger = join(process.env.DSH_HOME, 'jubian', 'ledger')
    const records = (await Promise.all((await readdir(ledger)).filter(path => path.endsWith('.ndjson'))
      .map(path => readFile(join(ledger, path), 'utf8')))).flatMap(text => text.trim().split('\n').map(JSON.parse))
    assert.equal(records.filter(record => record.phase === 'begin').length, 3)
    await writeFile(join(agent.session.header.cwd, '_probe.json'), JSON.stringify({ registeredAssets: [51, 52], deletedAssets: deletes,
      retiredOperations: 1, originalIntents: 3, oldOperationClosedAfterRestart: true, replaySentNoWrites: true, paidRequests: 0 }, null, 2) + '\n')
  })
  ctx.effect(() => ctx.provide('snapshotVoiceReplacementReady', true))
}
