import assert from 'node:assert/strict'
import { webcrypto } from 'node:crypto'
import { test } from 'node:test'
import { createWebTaskSender } from '../src/client/web-submissions.js'

function memoryStorage() {
  const items = new Map()
  return { items, getItem: key => items.get(key) ?? null, setItem: (key, value) => items.set(key, value), removeItem: key => items.delete(key) }
}
const accepted = payload => ({ accepted: true, status: 'accepted', clientRequestId: payload.clientRequestId, sessionId: payload.sessionId })
const networkError = () => Object.assign(new Error('Network unavailable'), { code: 'NETWORK' })
const sender = (call, storage, scope = '/desktop/one/') => createWebTaskSender(call, { storage, scope, crypto: webcrypto })

test('a lost accepted response is reconciled without delivering another task', async () => {
  const storage = memoryStorage(), calls = []
  const send = sender(async (name, payload) => {
    calls.push({ name, payload })
    if (name === 'send') throw networkError()
    return accepted(payload)
  }, storage)
  assert.equal((await send('chat', 'write a report')).accepted, true)
  assert.deepEqual(calls.map(item => item.name), ['send', 'submission'])
  assert.equal(calls[0].payload.clientRequestId, calls[1].payload.clientRequestId)
  assert.equal(storage.items.size, 0)
})

test('a manual retry after reload checks the original receipt and retains its request identity', async () => {
  const storage = memoryStorage(), calls = []
  const first = sender(async (name, payload) => { calls.push({ name, payload }); throw networkError() }, storage)
  await assert.rejects(first('chat', 'write a report'), { code: 'bot/submission-unknown' })
  assert.equal(storage.items.size, 1)
  const original = calls[0].payload.clientRequestId
  const resumed = sender(async (name, payload) => { calls.push({ name, payload }); return accepted(payload) }, storage)
  assert.equal((await resumed('chat', 'write a report')).accepted, true)
  assert.deepEqual(calls.map(item => item.name), ['send', 'submission', 'submission'])
  assert.equal(calls.at(-1).payload.clientRequestId, original)
})

test('a definitively missing receipt permits a manual retry using the same identity', async () => {
  const storage = memoryStorage(), calls = []
  const first = sender(async (name, payload) => {
    calls.push({ name, payload })
    if (name === 'send') throw networkError()
    return { status: 'missing', accepted: false, clientRequestId: payload.clientRequestId }
  }, storage)
  await assert.rejects(first('chat', 'task'), { code: 'bot/submission-unknown' })
  const resumed = sender(async (name, payload) => {
    calls.push({ name, payload })
    return name === 'submission' ? { status: 'missing', accepted: false, clientRequestId: payload.clientRequestId } : accepted(payload)
  }, storage)
  await resumed('chat', 'task')
  assert.deepEqual(calls.map(item => item.name), ['send', 'submission', 'submission', 'send'])
  assert.equal(new Set(calls.map(item => item.payload.clientRequestId)).size, 1)
})

test('an unknown outcome remains pending and is never sent again', async () => {
  const storage = memoryStorage(), calls = []
  const first = sender(async (name, payload) => { calls.push({ name, payload }); throw networkError() }, storage)
  await assert.rejects(first('chat', 'task'))
  const resumed = sender(async (name, payload) => {
    calls.push({ name, payload })
    return { status: 'unknown', accepted: false, clientRequestId: payload.clientRequestId }
  }, storage)
  await assert.rejects(resumed('chat', 'task'), { code: 'bot/submission-unknown' })
  assert.equal(calls.filter(item => item.name === 'send').length, 1)
  assert.equal(storage.items.size, 1)
})

test('simultaneous taps share the in-flight admission', async () => {
  const storage = memoryStorage(), calls = []
  let release, started
  const ready = new Promise(resolve => { started = resolve })
  const gate = new Promise(resolve => { release = resolve })
  const send = sender(async (name, payload) => {
    calls.push({ name, payload }); started()
    await gate
    return accepted(payload)
  }, storage)
  const one = send('chat', 'task')
  await ready
  const two = send('chat', 'task')
  release()
  await Promise.all([one, two])
  assert.equal(calls.length, 1)
})

test('a fresh deliberate message after acceptance gets its own identity', async () => {
  const storage = memoryStorage(), identities = []
  const send = sender(async (_name, payload) => { identities.push(payload.clientRequestId); return accepted(payload) }, storage)
  await send('chat', 'task')
  await send('chat', 'task')
  assert.equal(new Set(identities).size, 2)
})

test('storage refusal prevents transmission and corrupt saved receipts fail closed', async () => {
  let calls = 0
  const storage = memoryStorage()
  storage.setItem = () => { throw new Error('Quota exceeded') }
  await assert.rejects(sender(async () => { calls++ }, storage)('chat', 'task'), { code: 'bot/submission-storage' })
  assert.equal(calls, 0)
  const corrupt = { getItem: () => '{not json', setItem() {}, removeItem() {} }
  await assert.rejects(sender(async () => { calls++ }, corrupt)('chat', 'task'), { code: 'bot/submission-storage' })
  assert.equal(calls, 0)
})

test('pending receipts are isolated by computer and cannot replace request content', async () => {
  const storage = memoryStorage(), calls = []
  await assert.rejects(sender(async () => { throw networkError() }, storage)('chat', 'task'))
  const savedKey = [...storage.items.keys()][0]
  const saved = JSON.parse(storage.getItem(savedKey))
  storage.setItem(savedKey, JSON.stringify({ ...saved, text: 'changed' }))
  const send = sender(async (name, payload) => { calls.push({ name, payload }); return accepted(payload) }, storage)
  await send('chat', 'task')
  assert.equal(calls[0].payload.sessionId, 'chat')
  assert.equal(calls[0].payload.text, 'task')
  await assert.rejects(sender(async () => { throw networkError() }, storage)('chat', 'task'))
  const other = sender(async (name, payload) => { calls.push({ name, payload }); return accepted(payload) }, storage, '/desktop/two/')
  await other('chat', 'task')
  assert.equal(calls.at(-1).name, 'send')
})

test('an authoritative refusal retains its user-facing error', async () => {
  const refusal = Object.assign(new Error('This chat no longer exists'), { code: 'bot/not-found' })
  const send = sender(async () => { throw refusal }, memoryStorage())
  await assert.rejects(send('chat', 'task'), error => error === refusal)
})

test('a Bot moving to a new chat part keeps the first target and receipt on retry', async () => {
  const storage = memoryStorage(), calls = []
  const first = sender(async (name, payload) => { calls.push({ name, payload }); throw networkError() }, storage)
  await assert.rejects(first('bot', 'task', 'part-one'))
  const resumed = sender(async (name, payload) => { calls.push({ name, payload }); return accepted(payload) }, storage)
  await resumed('bot', 'task', 'part-two')
  assert.deepEqual(calls.map(item => item.name), ['send', 'submission', 'submission'])
  assert.ok(calls.every(item => item.payload.sessionId === 'part-one'))
  assert.equal(new Set(calls.map(item => item.payload.clientRequestId)).size, 1)
})

test('an unrelated or malformed receipt never confirms delivery or authorizes a replay', async () => {
  for (const response of [null, { status: 'accepted', accepted: true, clientRequestId: 'other' }]) {
    const storage = memoryStorage(), calls = []
    const send = sender(async (name, payload) => { calls.push({ name, payload }); return response }, storage)
    await assert.rejects(send('chat', 'task'), { code: 'bot/submission-unknown' })
    assert.equal(storage.items.size, 1)
    await assert.rejects(send('chat', 'task'), { code: 'bot/submission-unknown' })
    assert.deepEqual(calls.map(item => item.name), ['send', 'submission'])
  }
})
