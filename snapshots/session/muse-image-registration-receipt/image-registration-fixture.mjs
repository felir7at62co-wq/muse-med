/** Offline registration records provider writes independently of model prose and tool receipt rendering. */
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const name = 'image-registration-fixture'
export const inject = ['llm']

/** @param {import('@deepseek-ai/cordis').Context} ctx - Shipped Headless composition. */
export function apply(ctx) {
  const assets = [], posts = []
  ctx.effect(() => {
    const originalFetch = globalThis.fetch, OriginalDate = Date
    class FixtureDate extends OriginalDate {
      constructor(...args) { super(...(args.length ? args : [1790682041000])) }
      static now() { return 1790682041000 }
    }
    globalThis.Date = FixtureDate
    globalThis.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString())
      assert.equal(url.origin, 'https://image-registration.invalid', 'Offline fixture rejects external traffic')
      const path = url.pathname.replace('/prod-api', '')
      if (init?.method === 'POST' && path === '/aigc/asset') {
        assert.equal(posts.length, 0, 'Only the original registration can send a POST')
        const body = JSON.parse(init.body)
        assert.deepEqual(body, { scriptId: 2708, assetName: 'lead coat', assetType: 3, isLocal: 1,
          url: 'https://media.example/coat.png' })
        posts.push(body)
        assets.push({ id: 501, scriptId: 2708, assetType: 3, assetName: body.assetName, assetUrl: body.url },
          { id: 502, scriptId: 2708, assetType: 3, assetName: 'other coat', assetUrl: 'https://media.example/other.png' })
        return Response.json({ code: 200, data: null })
      }
      assert.equal(init?.method, 'GET', 'All other provider calls must be read-only')
      let data
      if (path === '/aigc/asset/list') {
        assert.equal(url.searchParams.get('scriptId'), '2708')
        assert.equal(url.searchParams.get('assetType'), '3')
        data = { total: assets.length, rows: assets }
      } else {
        const asset = assets.find(row => path === `/aigc/asset/${row.id}`)
        assert.ok(asset, `Unexpected offline asset read ${path}`)
        data = asset
      }
      return Response.json({ code: 200, data })
    }
    return () => { globalThis.fetch = originalFetch; globalThis.Date = OriginalDate }
  })
  ctx.on('agent/turn-stopping', async ({ agent }) => {
    const events = agent.session.snapshotEvents()
    const message = id => {
      const found = events.find(event => event.type === 'tool/result' && event.data.message.toolCallId === id)?.data.message
      assert.ok(found, `Missing persisted result ${id}`)
      return found
    }
    const value = id => {
      const result = message(id)
      assert.equal(result.isError, false)
      return JSON.parse(result.content.filter(block => block.type === 'text').map(block => block.text).join('\n'))
    }
    const first = value('call_asset_register'), replay = value('call_asset_replay')
    for (const result of [first, replay]) {
      assert.equal(result.created_asset_id, 501, 'The requested image must be the only assigned asset')
      assert.equal(result.verified_readback, true)
      assert.equal(result.matching_assets[0].name, posts[0].assetName)
      assert.equal(result.matching_assets[0].url, posts[0].url)
    }
    assert.equal(first.replayed, false); assert.deepEqual(first.new_asset_ids, [501])
    assert.equal(replay.replayed, true); assert.deepEqual(replay.new_asset_ids, [])
    assert.equal(message('call_asset_rebind').isError, true)
    assert.ok(!JSON.stringify(events).includes('offline-image-registration'), 'Credentials remain outside the Session')
    await writeFile(join(process.cwd(), 'image-registration-proof.json'), JSON.stringify({
      post_count: posts.length,
      submitted_images: posts.map(body => ({ name: body.assetName, url: body.url })),
      provider_asset_ids: assets.map(asset => asset.id),
      returned_asset_ids: [first.created_asset_id, replay.created_asset_id],
      changed_request_rejected: message('call_asset_rebind').isError,
    }, null, 2) + '\n')
  })
}
