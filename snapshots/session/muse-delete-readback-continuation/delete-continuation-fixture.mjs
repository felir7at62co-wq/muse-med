/** Offline provider mutations and independent readback evidence for reviewed deletion batches. */
import assert from 'node:assert/strict'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const name = 'delete-continuation-fixture'
export const inject = ['tools']
export const boards = [701, 702].map(id => ({ id, scriptId: 2708, episodeId: 35,
  storyboardName: `Offline target ${id}`, isGenerate: 1, modelConfig: null, storyboardMaterialList: [] }))
export const authorization = 'User authorized deletion of exactly offline cards 701 and 702'
export const reason = 'Remove the two reviewed offline cards'

export function apply(ctx) {
  let remaining = [...boards]
  const deleted = []
  ctx.effect(() => {
    const original = globalThis.fetch
    globalThis.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString())
      assert.equal(url.origin, 'https://delete-readback.invalid', 'No external traffic is permitted')
      const path = url.pathname.replace('/prod-api', '')
      const method = String(init?.method)
      const answer = data => new Response(JSON.stringify({ code: 200, data }))
      if (method === 'GET' && /^\/aigc\/storyboard\/(701|702)$/u.test(path)) {
        return answer(remaining.find(board => board.id === Number(path.split('/').pop())) ?? null)
      }
      if (method === 'GET' && path.includes('/byStoryboard/')) return answer([])
      if (method === 'GET' && path === '/admin/aigc/video/task/list') {
        assert.equal(url.searchParams.get('scriptId'), '2708')
        return answer({ total: 0, rows: [] })
      }
      if (method === 'DELETE') {
        const id = Number(path.split('/').pop())
        assert.ok(remaining.some(board => board.id === id), 'An original deletion must never be resent')
        assert.equal(path, `/aigc/storyboard/${id}`)
        deleted.push(id)
        remaining = remaining.filter(board => board.id !== id)
        return id === 701 ? new Response(null, { status: 200 }) : answer(null)
      }
      throw Error(`Unexpected fixture request ${method} ${path}`)
    }
    return () => { globalThis.fetch = original }
  })
  ctx.on('agent/turn-stopping', async ({ agent }) => {
    const events = agent.session.snapshotEvents()
    const messages = events.filter(event => event.type === 'tool/result').map(event => event.data.message)
    const result = id => {
      const message = messages.find(message => message.toolCallId === id)
      assert.ok(message, `Missing actual tool result ${id}`)
      assert.equal(message.isError, false)
      return JSON.parse(message.content.filter(block => block.type === 'text').map(block => block.text).join('\n'))
    }
    const preview = result('call_delete_preview')
    assert.deepEqual(preview.targets.map(target => target.storyboard_id), [701, 702])
    const applied = result('call_delete_apply'), replay = result('call_delete_replay')
    assert.equal(applied.status, 'deleted')
    assert.equal(replay.replayed, true)
    for (const value of [applied, replay]) {
      assert.deepEqual(value.items.map(item => [item.storyboard_id, item.status, item.response_status, item.verified_readback]),
        [[701, 'deleted', 'unknown', true], [702, 'deleted', 'accepted', true]])
    }
    assert.deepEqual(deleted, [701, 702])
    assert.deepEqual(remaining, [])
    const work = agent.session.header.cwd
    assert.ok(process.env.DSH_HOME, 'The Loader must provide its isolated Harness home')
    const ledger = join(process.env.DSH_HOME, 'jubian', 'ledger')
    const paths = (await readdir(ledger)).filter(path => path.endsWith('.ndjson'))
    const records = (await Promise.all(paths.map(path => readFile(join(ledger, path), 'utf8'))))
      .flatMap(text => text.trim().split('\n').map(line => JSON.parse(line)))
    assert.equal(records.filter(record => record.phase === 'begin').length, 3)
    await writeFile(join(work, '_probe.json'), JSON.stringify({ remoteDeletes: deleted, remainingCards: remaining,
      originalIntents: 3, unknownResponseReconciled: true, replaySentNoDeletes: true, paidRequests: 0 }, null, 2) + '\n')
  })
}
