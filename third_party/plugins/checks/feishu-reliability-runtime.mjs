/** Delivery acceptance against the compiled reviewed Feishu artifact, without platform requests. */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { StreamingCardManager } from './lib/upstream/cards/streaming.js'
import { StreamingCardController } from './lib/upstream/cards/StreamingCardController.js'
import { SessionMap } from './lib/upstream/session-map.js'

const logger = { debug() {}, info() {}, warn() {}, error() {} }
function fixture(t, { failOpen = false, failPatch = false, throttleMs = 10000 } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'muse-feishu-delivery-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const texts = [], patches = []
  const transport = {
    async sendCard() { if (failOpen) throw new Error('card unavailable'); return { messageId: 'card-1' } },
    async updateCard(id, card) { patches.push({ id, card }); if (failPatch) throw new Error('card rejected') },
    async sendText(chatId, text) { texts.push({ chatId, text }) },
    async addReaction() { return 'reaction' },
    async removeReaction() {},
  }
  const cards = new StreamingCardManager(transport, { throttleMs, logger })
  t.after(() => cards.close('chat'))
  const sessionMap = new SessionMap(join(root, 'sessions.json'))
  sessionMap.set('chat', 'original-session')
  sessionMap.setCwd('chat', root)
  const controller = new StreamingCardController({ cards, transport, sessionMap, defaultCwd: root, logger, textMentionFor: () => '' })
  return { cards, controller, texts, patches, sessionMap, root, transport }
}

test('sends the full final text once when the initial reply card cannot be created', async t => {
  const { controller, texts } = fixture(t, { failOpen: true })
  await controller.beginTurn('chat', 'message', 'test')
  await controller.handleEvent('original-session', { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '最终完整回复' }] } } })
  await controller.handleEvent('original-session', { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  assert.deepEqual(texts, [{ chatId: 'chat', text: '最终完整回复' }])
})

test('falls back when final card patch fails and avoids a duplicate bubble when it succeeds', async t => {
  for (const failPatch of [true, false]) {
    const { controller, texts, patches } = fixture(t, { failPatch })
    await controller.beginTurn('chat', 'message', 'test')
    await controller.handleEvent('original-session', { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '完整结果' }] } } })
    await controller.handleEvent('original-session', { type: 'turn/end', data: { reason: { kind: 'completed' } } })
    assert.equal(texts.length, failPatch ? 1 : 0)
    assert.ok(patches.length > 0)
  }
})

test('awaits the in-flight patch and sends the final snapshot before declaring delivery', { timeout: 5000 }, async t => {
  const { cards, patches, transport } = fixture(t, { throttleMs: 1 })
  let release, entered
  const started = new Promise(resolve => { entered = resolve })
  const blocked = new Promise(resolve => { release = resolve })
  t.after(() => release())
  transport.updateCard = async (id, card) => { patches.push({ id, card }); if (patches.length === 1) { entered(); await blocked } }
  await cards.open('chat', 'test')
  cards.patch('chat', { title: 'test', content: 'working', rows: [], status: 'working' })
  await started
  cards.patch('chat', { title: 'test', content: 'final', rows: [], status: 'done' })
  let settled = false
  const final = cards.finalize('chat', 'done').then(result => { settled = true; return result })
  await Promise.resolve()
  assert.equal(settled, false)
  release()
  assert.equal(await final, true)
  assert.equal(patches.length, 2)
})

test('does not replace a historical session when its log needs repair', async t => {
  const { controller, sessionMap } = fixture(t)
  await controller.beginTurn('chat', 'message', 'test')
  await controller.handleEvent('original-session', { type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'SESSION_INVALID', message: 'corrupt session log' } } } })
  assert.equal(sessionMap.get('chat'), 'original-session')
})
