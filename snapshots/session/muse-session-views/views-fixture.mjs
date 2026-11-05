/** Native Session views use the real authenticated HTTP reply route. */
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import { readViewReply } from '../../../third_party/plugins/deep-view/src/core/reply.js'
import { importSnapshotModule } from '../muse-fixture-import.mjs'

const Discovery = await importSnapshotModule(new URL('../../../packages/core/tool-discovery/src/index.ts', import.meta.url),
  new URL('../../../packages/core/tool-discovery/lib/index.js', import.meta.url))

/** Loader identity for ordinary Session card acceptance. */
export const name = 'snapshot-muse-session-views'
/** Real transport and Session services composed by this scenario's shipped-profile patch. */
export const inject = ['connection', 'webServer', 'agents', 'sessions', 'tools']

/**
 * Answer the pending view through the owner HTTP transport before the next turn.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Isolated Headless Loader context.
 * @returns {Promise<void>} Completion after production tool residency is active.
 */
export async function apply(ctx) {
  const row = loadOverlayPatches('native-view-residency', fileURLToPath(new URL(
    '../../../apps/desktop-host/config/desktop.cordis.patch.yml', import.meta.url,
  ))).flatMap(patch => patch.insert ?? []).find(entry => entry.id === 'tool-discovery')
  assert.ok(row)
  assert.ok(row.config.alwaysLoad.includes('show_view'))
  assert.ok(row.config.alwaysLoad.includes('ask_user_question'))
  assert.ok(row.config.excludeFromSearch.includes('show_view'))
  assert.ok(row.config.excludeFromSearch.includes('ask_user_question'))
  await ctx.plugin(Discovery, Discovery.Config(row.config))
  let replied = false, observed = false, replyRequests = 0, unauthenticatedRejected = false
  const selection = '先优化反馈工具'
  ctx.on('llm/stream', async function* (options, next) {
    assert.ok(options.tools.some(tool => tool.name === 'show_view'))
    assert.ok(options.tools.some(tool => tool.name === 'ask_user_question'))
    assert.ok(options.tools.some(tool => tool.name === 'tool_search'))
    assert.ok(options.tools.some(tool => tool.name === 'tool_context'))
    assert.ok(!options.tools.some(tool => tool.name === 'create_bot'))
    for (const message of options.messages) {
      if (message.role !== 'user') continue
      const text = message.content.filter(block => block.type === 'text').map(block => block.text).join('')
      const answer = readViewReply(text)
      if (answer === undefined) continue
      assert.deepEqual(answer.answers[0].values, { selected: [selection] })
      assert.equal(answer.views[0].title, '选择下一步')
      observed = true
    }
    yield* next()
  })
  ctx.on('agent/turn-stopping', async ({ agent }) => {
    const calls = agent.session.snapshotEvents().filter(event => event.type === 'tool/call')
    if (!replied) {
      assert.equal(calls.length, 2)
      const origin = `http://127.0.0.1:${ctx.webServer.port}`
      const endpoint = `${origin}/api/deep-view`
      const pendingRequest = { op: 'pending', sessionId: agent.session.id }
      const unauthenticated = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', origin },
        body: JSON.stringify(pendingRequest), redirect: 'manual' })
      await unauthenticated.body?.cancel()
      assert.equal(unauthenticated.status, 401)
      unauthenticatedRejected = true
      const connect = await fetch(ctx.connection.authenticatedUrl(`${origin}/connect?interactions=answer`), { redirect: 'manual' })
      await connect.body?.cancel()
      assert.equal(connect.status, 302)
      const cookie = connect.headers.getSetCookie().map(value => value.split(';', 1)[0]).join('; ')
      assert.ok(cookie)
      const send = async body => {
        const response = await fetch(endpoint, { method: 'POST', headers: { cookie, origin, 'content-type': 'application/json' },
          body: JSON.stringify(body), redirect: 'manual' })
        assert.equal(response.status, 200)
        return response.json()
      }
      const pending = await send(pendingRequest)
      assert.equal(pending.ok, true)
      assert.equal(pending.value.id, 'call_view_options')
      assert.equal(pending.value.title, '选择下一步')
      const answer = { op: 'reply', sessionId: agent.session.id, viewId: pending.value.id,
        action: 'next', values: { selected: [selection] } }
      assert.deepEqual(await send(answer), { ok: true, value: true })
      replyRequests++
      assert.deepEqual(await send(answer), { ok: true, value: true })
      replyRequests++
      assert.deepEqual(await send(pendingRequest), { ok: true, value: null })
      replied = true
      return
    }
    assert.equal(observed, true)
    const events = agent.session.snapshotEvents()
    const answers = events.filter(event => event.type === 'user/message' && event.data.source.kind === 'deep-view-reply')
    const firstHeader = events.find(event => event.type === 'request/header')
    assert.ok(firstHeader.data.header.tools.some(tool => tool.name === 'show_view'))
    assert.equal(answers.length, 1)
    assert.deepEqual(calls.map(event => event.data.name), ['show_view', 'show_view'])
    const results = events.filter(event => event.type === 'tool/result')
    assert.equal(results.length, 2)
    for (const result of results) {
      assert.equal(result.data.message.isError, false)
      assert.equal(result.data.meta.owner, 'deep-view')
    }
    await writeFile(join(process.cwd(), 'view-proof.json'), JSON.stringify({
      calls: calls.map(event => event.data.callId), answerMessages: answers.length, selection,
      authenticatedReplyRequests: replyRequests, unauthenticatedRejected, pendingClosed: true, modelReadAnswer: observed,
      botToolsUsed: false,
      firstRequestIncludesView: true, discoveryCalls: calls.filter(event => ['tool_search', 'tool_context'].includes(event.data.name)).length,
    }, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  })
}
