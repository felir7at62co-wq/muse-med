/** Feedback calls use the production account plugin and a private loopback inbox. */
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyLoopbackServerEffect } from '../loopback-fixture-server.mjs'
import { importSnapshotModule } from '../muse-fixture-import.mjs'

const account = await importSnapshotModule(new URL('../../../packages/host/muse-account/src/index.ts', import.meta.url),
  new URL('../../../packages/host/muse-account/lib/index.js', import.meta.url))
const { writeMuseSession } = await importSnapshotModule(new URL('../../../packages/host/muse-account/src/session.ts', import.meta.url),
  new URL('../../../packages/host/muse-account/lib/types/session.js', import.meta.url))
const cookie = '__Host-muse=feedback-snapshot-only'
const username = 'feedback-fixture'
const receiptId = '81000000000040008000000000000001'
const lostReceiptId = '81000000000040008000000000000002'

/** Loader identity for the recorded feedback-tool conversation. */
export const name = 'snapshot-muse-feedback-tools'
/** Profile services used by the production account plugin and transcript assertions. */
export const inject = ['llm', 'tools', 'sessions', 'sessionProjections', 'agentDefaultModel']

/**
 * Keep authentication, tools and session intake real; replace only the external gateway.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Isolated Headless Loader context.
 * @returns {Promise<void>} Completion after the account plugin and local gateway are ready.
 */
export async function apply(ctx) {
  const home = await mkdtemp(join(tmpdir(), 'muse-feedback-snapshot-'))
  ctx.effect(() => () => rm(home, { recursive: true, force: true }))
  let baseUrl, rejected, active
  const writes = [], reads = [], records = new Map(), visibleResults = new Set()
  await applyLoopbackServerEffect(ctx, { label: 'snapshot-muse-feedback-gateway', onCleanup() {},
    onListening: address => { baseUrl = `http://127.0.0.1:${address.port}` },
    requestListener: (request, response) => {
      let body = ''
      request.on('data', chunk => { body += chunk.toString('utf8') })
      request.once('end', () => {
        const send = (status, value) => {
          response.writeHead(status, { 'content-type': 'application/json' })
          response.end(JSON.stringify(value))
        }
        try {
          if (request.url === '/api/desktop-models/providers') {
            assert.equal(request.headers.cookie, cookie)
            send(200, { providers: [] }); return
          }
          if (request.url === '/api/muse.account') {
            assert.equal(request.headers.cookie, cookie)
            send(200, { username }); return
          }
          if (request.url === '/api/muse.activity') {
            response.writeHead(204); response.end(); return
          }
          assert.equal(request.headers.cookie, cookie)
          if (request.url === '/api/muse.feedback' && request.method === 'POST') {
            assert.equal(request.headers.origin, baseUrl)
            assert.ok(active)
            const input = JSON.parse(body)
            assert.equal(input.category, 'suggestion')
            assert.ok(input.requestId)
            assert.ok(input.body.includes(active.session.id))
            assert.ok(!input.body.includes('Related user request'))
            assert.ok(!input.body.includes('Related assistant answer'))
            assert.ok(!body.includes(cookie))
            writes.push(input)
            const lost = input.title === '测试回执丢失'
            let record = records.get(input.requestId)
            if (!record) {
              record = { ...input, id: lost ? lostReceiptId : receiptId, username, status: 'new', reply: '', revision: 1,
                createdAt: '2026-11-05T00:00:00.000Z', updatedAt: '2026-11-05T00:00:00.000Z', attachments: [],
                history: [{ at: '2026-11-05T00:00:00.000Z', by: username, status: 'new', reply: '' }] }
              records.set(input.requestId, record)
            }
            if (lost) { response.destroy(); return }
            send(201, record); return
          }
          if (request.url === `/api/muse.feedback/${receiptId}` && request.method === 'GET') {
            const record = [...records.values()].find(item => item.id === receiptId)
            assert.ok(record)
            reads.push(receiptId)
            send(200, { ...record, revision: 2, status: 'reviewing', reply: '已复现，正在处理' }); return
          }
          throw Error(`Unexpected feedback snapshot request: ${request.method} ${request.url}`)
        } catch (error) {
          rejected = error
          if (!response.headersSent) send(500, { error: 'Feedback fixture mismatch' })
          else response.end()
        }
      })
    },
  })
  await writeMuseSession(join(home, 'session.json'), { baseUrl, username, cookie })
  await ctx.plugin(account, account.Config({ baseUrl, accountHome: home, feedbackTools: true })).await()
  ctx.on('agent/created', ({ agent }) => { active = agent })
  ctx.on('llm/stream', async function* (options, next) {
    const names = options.tools.map(tool => tool.name)
    assert.ok(names.includes('muse_feedback_submit'), 'The feedback submit tool must reach the model')
    assert.ok(names.includes('muse_feedback_status'), 'The feedback status tool must reach the model')
    assert.ok(!JSON.stringify(options.messages).includes(cookie))
    for (const message of options.messages) {
      if (message.role !== 'tool') continue
      const text = message.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
      if (message.toolCallId === 'call_feedback_1' || message.toolCallId === 'call_feedback_2') {
        assert.ok(text.includes(receiptId), 'A confirmed inbox receipt must reach the model')
        visibleResults.add(message.toolCallId)
      } else if (message.toolCallId === 'call_feedback_3') {
        assert.ok(text.includes('reviewing'))
        assert.ok(text.includes('已复现，正在处理'))
        visibleResults.add(message.toolCallId)
      } else if (message.toolCallId === 'call_feedback_4') {
        assert.ok(text.includes('unconfirmed'))
        assert.ok(!text.includes(lostReceiptId), 'A lost response cannot expose an invented confirmed receipt')
        visibleResults.add(message.toolCallId)
      }
    }
    yield* next()
  })
  ctx.on('agent/turn-stopping', async ({ agent }) => {
    if (rejected) throw rejected
    const events = agent.session.snapshotEvents()
    const calls = events.filter(event => event.type === 'tool/call')
    assert.deepEqual(calls.map(event => event.data.name), [
      'muse_feedback_submit', 'muse_feedback_submit', 'muse_feedback_status', 'muse_feedback_submit',
    ])
    assert.equal(writes.length, 3)
    assert.equal(reads.length, 1)
    assert.equal(records.size, 2)
    assert.equal(visibleResults.size, 4)
    assert.deepEqual(writes[0], writes[1])
    assert.equal(writes[2].title, '测试回执丢失')
    assert.ok(!JSON.stringify(events).includes(cookie))
    await writeFile(join(process.cwd(), 'feedback-proof.json'), JSON.stringify({
      submissions: writes.length, records: records.size, statusReads: reads.length,
      duplicateReused: writes[0].requestId === writes[1].requestId,
      lostResponseSavedOnce: [...records.values()].filter(item => item.id === lostReceiptId).length === 1,
      diagnosticsIncluded: false, credentialsLogged: false,
    }, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  })
}
