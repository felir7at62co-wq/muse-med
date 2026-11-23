import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createFeishuTurn } from '../src/host/im/feishu-turn.js'

const tick = () => new Promise(resolve => setImmediate(resolve))

test('Feishu stages update one progress card and speech waits for a confirmed text answer', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const stages = []
  const spoken = []
  const turn = createFeishuTurn({
    mode: 'streaming_card',
    voice: { reply: async body => spoken.push(body) },
    isCurrent: () => true,
    sendProgress: async (text, options) => { stages.push({ text, ...options }); return 'om_progress' },
    t: (key, values) => values ? [key, values.active, values.completed] : key,
    warn: () => { throw new Error('Unexpected delivery warning') },
  })
  turn.observe({ type: 'tool/call', data: { callId: 'step' } })
  t.mock.timers.tick(1)
  await tick()
  turn.observe({ type: 'tool/result', data: { callId: 'step' } })
  t.mock.timers.tick(3_000)
  await tick()
  const delivered = turn.reply('Finished')
  turn.finish('success')
  t.mock.timers.tick(1)
  await tick()
  assert.deepEqual(stages, [
    { text: ['feishuWorking', 1, 0], messageId: undefined, mode: 'streaming_card' },
    { text: ['feishuWorking', 0, 1], messageId: 'om_progress', mode: 'streaming_card' },
    { text: 'feishuDone', messageId: 'om_progress', mode: 'streaming_card' },
  ])
  assert.deepEqual(spoken, [])
  delivered({ messageId: 'om_answer' })
  assert.deepEqual(spoken, ['Finished'])
})

test('routing loss during a Feishu turn suppresses progress and speech', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const sendProgress = t.mock.fn()
  const speak = t.mock.fn()
  const turn = createFeishuTurn({
    mode: 'post', voice: { reply: speak }, isCurrent: () => false,
    sendProgress, t: key => key, warn: () => {},
  })
  const delivered = turn.reply('Private results')
  turn.observe({ type: 'tool/call', data: { callId: 'step' } })
  t.mock.timers.tick(5_000)
  turn.finish('success')
  delivered({ messageId: 'answered' })
  assert.equal(sendProgress.mock.callCount(), 0)
  assert.equal(speak.mock.callCount(), 0)
})

test('a progress transport failure leaves the confirmed text and voice delivery independent', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const warned = t.mock.fn()
  const spoken = []
  const sendProgress = t.mock.fn(async () => { throw new Error('progress card unavailable') })
  const turn = createFeishuTurn({
    mode: 'streaming_card',
    voice: { reply: async body => spoken.push(body) },
    isCurrent: () => true, sendProgress, t: key => key, warn: warned,
  })
  turn.observe({ type: 'tool/call', data: { callId: 'step' } })
  t.mock.timers.tick(1)
  await tick()
  const confirmed = turn.reply('Answer')
  confirmed({ messageId: 'om_answer' })
  turn.finish('success')
  t.mock.timers.tick(6_000)
  assert.equal(sendProgress.mock.callCount(), 1)
  assert.equal(warned.mock.callCount(), 1)
  assert.deepEqual(spoken, ['Answer'])
})
