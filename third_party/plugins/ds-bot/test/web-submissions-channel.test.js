import assert from 'node:assert/strict'
import test from 'node:test'
import { install as installChannel } from '../src/host/channel.js'
import { install as installRequests } from '../src/host/requests.js'
import { fakeContext } from './fake-ctx.js'

function channel(t) {
  const ctx = fakeContext()
  const prompts = []
  const agents = new Map()
  let route
  let readOnly
  let flushes = 0
  ctx.connection.fetch.register = value => { route = value; return () => {} }
  const rt = {
    ctx, state: { bots: {} }, pastOwners: new Map(),
    own: (object, key) => Object.hasOwn(object, key) ? object[key] : undefined,
    save: async () => {}, refresh: async () => {}, load: async () => {},
    readOnly: () => readOnly,
    warn() {}, noteFailure() {},
    botOf: id => id === 'writer' ? { id } : undefined,
    chatOf: () => 'writer-chat',
    ensureCapabilities: async () => {},
    resolveAgent: async id => {
      if (!agents.has(id)) agents.set(id, { session: { id }, inbox: { nextStep: [], nextTurn: [] } })
      return agents.get(id)
    },
    eventsBackwards: async function* () {},
  }
  ctx.sessionController = { prompt: async request => { prompts.push(request); return { accepted: true } } }
  ctx.sessions = { flush: async () => { flushes++ } }
  installRequests(rt)
  installChannel(rt)
  t.after(() => ctx.dispose())
  return {
    prompts, flushes: () => flushes,
    readOnly: value => { readOnly = value },
    call: async (endpoint, payload) => {
      const response = await route.fetch(new Request('http://localhost/api/bot', {
        method: 'POST', body: JSON.stringify({ endpoint, payload }),
      }))
      return response.json()
    },
  }
}

test('the Bot route retains legacy send acknowledgements and adds stable mobile receipts', async t => {
  const f = channel(t)
  assert.deepEqual(await f.call('send', { sessionId: 'writer', text: 'Old desktop input' }), { ok: true, value: true })
  const payload = { clientRequestId: 'phone-1', sessionId: 'writer', text: ' Mobile input ' }
  const sent = await f.call('send', payload)
  assert.deepEqual(sent, { ok: true, value: { accepted: true, status: 'accepted', clientRequestId: 'phone-1', sessionId: 'writer-chat' } })
  assert.deepEqual(await f.call('send', payload), sent)
  assert.deepEqual(await f.call('submission', payload), sent)
  assert.equal(f.prompts.length, 2)
  assert.equal(f.prompts[1].requestId, 'muse-web:phone-1')
  assert.equal(f.prompts[1].content[0].text, 'Mobile input')
  assert.equal(f.flushes(), 1)
})

test('a mobile receipt lookup remains available while this Host cannot write the team', async t => {
  const f = channel(t)
  const payload = { clientRequestId: 'phone-2', sessionId: 'writer', text: 'One task' }
  const sent = await f.call('send', payload)
  f.readOnly('Another Host owns the Bot team')
  assert.deepEqual(await f.call('submission', payload), sent)
  assert.equal((await f.call('send', payload)).error.code, 'bot/read-only')
  assert.equal(f.prompts.length, 1)
})

test('the route returns a conflict for changed mobile content without submitting it', async t => {
  const f = channel(t)
  const payload = { clientRequestId: 'phone-3', sessionId: 'writer', text: 'First task' }
  await f.call('send', payload)
  const conflict = await f.call('send', { ...payload, text: 'Another task' })
  assert.equal(conflict.ok, false)
  assert.equal(conflict.error.code, 'bot/submission-conflict')
  assert.equal(f.prompts.length, 1)
})
