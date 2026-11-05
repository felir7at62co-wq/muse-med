import assert from 'node:assert/strict'
import { test } from 'node:test'
import { JSDOM } from 'jsdom'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLSelectElement', 'SVGElement', 'Element', 'Node', 'MutationObserver', 'getComputedStyle', 'CustomEvent', 'Event', 'KeyboardEvent', 'MouseEvent']) {
  if (dom.window[key] === undefined) continue
  Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true, writable: true })
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const { createElement: h, act, Fragment } = await import('react')
const { createRoot } = await import('react-dom/client')
const { WidgetCard, ViewUi, useOptionKeys } = await import('../src/react/index.js')
const { ViewsTail } = await import('../src/client/tail.js')
const { ViewReplyNode, viewReplyDefinition } = await import('../src/client/reply-node.js')
const { viewsDefinition } = await import('../src/client/views-definition.js')

const t = (key, data) => (data?.n !== undefined ? `${key} ${data.n}` : key)
const ui = { t, Markdown: ({ text }) => h('span', { className: 'md' }, String(text ?? '')) }

const METER = { type: 'metric', label: 'Progress', value: '70%' }
const CHOICES = { type: 'options', id: 'pick', options: [{ label: 'A' }, { label: 'B' }] }
const REPLY = (callId, selected = ['A']) => JSON.stringify({
  kind: 'answer_to_pending_view', tool: 'show_view', callId,
  views: [{ id: 'v1', title: 'Pick', view: CHOICES }],
  answers: [{ id: 'v1', action: 'pick', values: { selected } }],
})

async function render(node) {
  const box = document.createElement('div')
  document.body.appendChild(box)
  const root = createRoot(box)
  await act(async () => { root.render(h(ViewUi.Provider, { value: ui }, node)) })
  return { box, root, unmount: () => act(async () => { root.unmount(); box.remove() }) }
}

// A TurnLocation carrying the given folded views, the way the Definition publishes them.
const makeTurn = (views) => {
  const data = { views }
  return {
    data: {
      get: key => (key === 'deep-view-views' ? data : undefined),
      source: () => ({ getSnapshot: () => data, subscribe: () => () => {} }),
    },
  }
}

// A ConversationSnapshot with `count` chat nodes, plus an optional reply text node.
const convOf = (count = 0, replyText) => ({
  views: new Map([['chat', {
    order: replyText === undefined ? [...Array(count).keys()].map(index => `n${index}`) : [...Array(count).keys()].map(index => `n${index}`).concat('reply'),
    nodes: new Map(replyText === undefined ? [] : [['reply', { data: { text: replyText } }]]),
  }]]),
})
const useConversationOf = snapshot => selector => selector(snapshot)

const recordCalls = (record) => {
  const calls = []
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options?.body ?? '{}')
    calls.push(body)
    if (body.op === 'pending') return new Response(JSON.stringify({ ok: true, value: record }))
    return new Response(JSON.stringify({ ok: true, value: true }))
  }
  return calls
}

test('display-only call renders the card from its arguments, without asking for a record', async () => {
  const calls = recordCalls(null)
  const turn = makeTurn([{ callId: 'c1', args: { title: 'Stats', view: METER } }])
  const { box, unmount } = await render(h(ViewsTail, { turn, sessionId: 's1', useConversation: useConversationOf(convOf(1)) }))
  assert.ok(box.querySelector('.dv-view-bare'), 'bare card')
  assert.equal(box.querySelector('.dv-widget-metric-label')?.textContent, 'Progress')
  assert.equal(calls.filter(body => body.op === 'pending').length, 0, 'display views never query pending')
  await unmount()
})

test('interactive call renders the live card while the record names it', async () => {
  recordCalls({ id: 'v1', callId: 'c2', title: 'Pick', view: CHOICES, askedAt: 1 })
  const turn = makeTurn([{ callId: 'c2', args: { title: 'Pick', view: CHOICES } }])
  const { box, unmount } = await render(h(ViewsTail, { turn, sessionId: 's1', useConversation: useConversationOf(convOf(2)) }))
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
  assert.ok(box.querySelector('.dv-q'), 'interactive card')
  assert.ok(box.querySelector('.dv-q-opt'), 'option rows')
  await unmount()
})

test('interactive call without a matching record renders nothing', async () => {
  recordCalls({ id: 'v1', callId: 'other', title: 'Pick', view: CHOICES, askedAt: 1 })
  const turn = makeTurn([{ callId: 'c3', args: { view: CHOICES } }])
  const { box, unmount } = await render(h(ViewsTail, { turn, sessionId: 's1', useConversation: useConversationOf(convOf(2)) }))
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
  assert.equal(box.querySelector('.dv-q'), null)
  await unmount()
})

test('refused call (invalid blueprint) renders nothing', async () => {
  recordCalls(null)
  const turn = makeTurn([{ callId: 'c4', args: { view: { type: 'nope' } } }])
  const { box, unmount } = await render(h(ViewsTail, { turn, sessionId: 's1', useConversation: useConversationOf(convOf(1)) }))
  assert.equal(box.querySelector('.dv-view'), null)
  await unmount()
})

test('submitting an options card posts a reply and settles the card', async () => {
  const calls = recordCalls({ id: 'v1', callId: 'c5', view: CHOICES, askedAt: 1 })
  const turn = makeTurn([{ callId: 'c5', args: { view: CHOICES } }])
  const { box, unmount } = await render(h(ViewsTail, { turn, sessionId: 's1', useConversation: useConversationOf(convOf(2)) }))
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
  const option = box.querySelector('.dv-q-opt')
  assert.ok(option, 'option row present')
  // A single-select options card answers on the pick itself, no submit step.
  await act(async () => { option.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
  const reply = calls.find(body => body.op === 'reply')
  assert.ok(reply, 'reply op posted')
  assert.equal(reply.viewId, 'v1')
  assert.equal(reply.action, 'pick')
  assert.deepEqual(reply.values.selected, ['A'])
  assert.ok(box.querySelector('.dv-q-settled'), 'confirmed answer stays visible until the transcript arrives')
  assert.equal(box.querySelector('button.dv-q-opt'), null, 'the submitted card cannot be answered again')
  await unmount()
})

test('a failed pending query shows a retry action and can recover without a new answer', async () => {
  let attempts = 0
  globalThis.fetch = async () => {
    if (++attempts === 1) throw new Error('PRIVATE_TRANSPORT_DETAILS')
    return Response.json({ ok: true, value: { id: 'v1', callId: 'recover', view: CHOICES } })
  }
  const turn = makeTurn([{ callId: 'recover', args: { view: CHOICES } }])
  const { box, unmount } = await render(h(ViewsTail, { turn, sessionId: 's1', useConversation: useConversationOf(convOf(2)) }))
  assert.match(box.querySelector('[role=alert]')?.textContent ?? '', /Could not load/)
  assert.doesNotMatch(box.textContent, /PRIVATE_TRANSPORT/)
  await act(async () => { box.querySelector('button').click() })
  assert.ok(box.querySelector('.dv-q-opt'), 'a successful status retry restores the live card')
  assert.equal(box.querySelector('[role=alert]'), null)
  assert.equal(attempts, 2)
  await unmount()
})

test('pending refresh failure keeps selected inputs visible and disabled until status is confirmed', async () => {
  const multi = { ...CHOICES, multi: true }
  let attempts = 0
  globalThis.fetch = async () => {
    if (++attempts === 2) throw new Error('offline')
    return Response.json({ ok: true, value: { id: 'v1', callId: 'retain', view: multi } })
  }
  const turn = makeTurn([{ callId: 'retain', args: { view: multi } }])
  const { box, root, unmount } = await render(h(ViewsTail, { turn, sessionId: 's1', useConversation: useConversationOf(convOf(2)) }))
  await act(async () => { box.querySelector('.dv-q-opt').click() })
  assert.equal(box.querySelector('.dv-q-opt').getAttribute('aria-pressed'), 'true')
  await act(async () => { root.render(h(ViewUi.Provider, { value: ui }, h(ViewsTail, { turn, sessionId: 's1', useConversation: useConversationOf(convOf(3)) }))) })
  assert.ok(box.querySelector('[role=alert]'))
  assert.equal(box.querySelector('.dv-q-opt').getAttribute('aria-pressed'), 'true', 'selection survives the failed query')
  assert.equal(box.querySelector('.dv-q-submit').disabled, true)
  await act(async () => { box.querySelector('[role=alert] button').click() })
  assert.equal(box.querySelector('.dv-q-opt').getAttribute('aria-pressed'), 'true', 'retry does not remount the input')
  assert.equal(box.querySelector('.dv-q-submit').disabled, false)
  await unmount()
})

test('a rejected reply retains the card and requires status refresh before another answer', async () => {
  const calls = []
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body)
    calls.push(body)
    if (body.op === 'reply') return Response.json({ ok: false, error: { code: 'deep-view/unconfirmed', message: 'PRIVATE_SERVER_ERROR' } })
    return Response.json({ ok: true, value: { id: 'v1', callId: 'failed-reply', view: CHOICES } })
  }
  const turn = makeTurn([{ callId: 'failed-reply', args: { view: CHOICES } }])
  const { box, unmount } = await render(h(ViewsTail, { turn, sessionId: 's1', useConversation: useConversationOf(convOf(2)) }))
  await act(async () => { box.querySelector('.dv-q-opt').click() })
  assert.match(box.querySelector('[role=alert]')?.textContent ?? '', /Could not confirm/)
  assert.doesNotMatch(box.textContent, /PRIVATE_SERVER_ERROR/)
  assert.ok(box.querySelector('.dv-q'), 'card stays visible')
  assert.equal(box.querySelector('.dv-q-opt').disabled, true)
  assert.equal(calls.filter(body => body.op === 'reply').length, 1)
  await act(async () => { box.querySelector('[role=alert] button').click() })
  assert.equal(box.querySelector('.dv-q-opt').disabled, false)
  assert.equal(calls.filter(body => body.op === 'reply').length, 1, 'status refresh never resubmits')
  await unmount()
})

test('a failed form submission keeps the edited text after a status refresh', async () => {
  const form = { type: 'form', id: 'note', fields: [{ id: 'description', label: 'Description', value: 'Initial' }] }
  globalThis.fetch = async (_url, options) => JSON.parse(options.body).op === 'pending'
    ? Response.json({ ok: true, value: { id: 'v1', callId: 'form-failure', view: form } })
    : Response.json({ ok: false, error: { code: 'deep-view/internal', message: 'offline' } })
  const turn = makeTurn([{ callId: 'form-failure', args: { view: form } }])
  const { box, unmount } = await render(h(ViewsTail, { turn, sessionId: 's1', useConversation: useConversationOf(convOf(2)) }))
  const input = box.querySelector('input.dv-q-input')
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set.call(input, 'My retained draft')
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  })
  assert.equal(input.value, 'My retained draft')
  await act(async () => { box.querySelector('form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })) })
  assert.equal(input.value, 'My retained draft')
  assert.equal(input.readOnly, true)
  await act(async () => { box.querySelector('[role=alert] button').click() })
  assert.equal(input.value, 'My retained draft')
  assert.equal(input.readOnly, false)
  await unmount()
})

test('same-frame double clicks issue one reply and dismissal carries the exact view id', async () => {
  const calls = []
  let release
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body)
    calls.push(body)
    if (body.op === 'pending') return Response.json({ ok: true, value: { id: 'v1', callId: 'double', view: CHOICES } })
    await new Promise(resolve => { release = resolve })
    return Response.json({ ok: true, value: true })
  }
  const turn = makeTurn([{ callId: 'double', args: { view: CHOICES } }])
  const { box, unmount } = await render(h(ViewsTail, { turn, sessionId: 's1', useConversation: useConversationOf(convOf(2)) }))
  await act(async () => {
    const button = box.querySelector('.dv-q-opt')
    button.click()
    button.click()
  })
  assert.equal(calls.filter(body => body.op === 'reply').length, 1)
  await act(async () => { release() })
  await unmount()
  const dismissCalls = recordCalls({ id: 'original-view', callId: 'dismiss', view: CHOICES })
  const second = await render(h(ViewsTail, { turn: makeTurn([{ callId: 'dismiss', args: { view: CHOICES } }]), sessionId: 's1', useConversation: useConversationOf(convOf(2)) }))
  await act(async () => { second.box.querySelector('.dv-q-x').click() })
  assert.deepEqual(dismissCalls.find(body => body.op === 'dismiss'), { op: 'dismiss', sessionId: 's1', viewId: 'original-view' })
  assert.equal(second.box.querySelector('.dv-q'), null)
  await second.unmount()
})

test('a persisted unconfirmed answer locks controls and refresh never resubmits it', async () => {
  const calls = recordCalls({ id: 'v1', callId: 'uncertain', view: CHOICES, answerPending: true })
  const turn = makeTurn([{ callId: 'uncertain', args: { view: CHOICES } }])
  const { box, unmount } = await render(h(ViewsTail, { turn, sessionId: 's1', useConversation: useConversationOf(convOf(2)) }))
  assert.equal(box.querySelector('.dv-q-opt').disabled, true)
  assert.equal(box.querySelector('.dv-q-x').disabled, true)
  assert.match(box.querySelector('[role=status]')?.textContent ?? '', /awaiting confirmation/)
  await act(async () => { box.querySelector('[role=status] button').click() })
  assert.equal(calls.filter(body => body.op === 'pending').length, 2)
  assert.equal(calls.filter(body => body.op === 'reply').length, 0)
  await unmount()
})

test('unmount cancels the pending query and an in-flight answer', async () => {
  const signals = []
  globalThis.fetch = (_url, options) => {
    signals.push(options.signal)
    return new Promise((_resolve, reject) => { options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }) })
  }
  const turn = makeTurn([{ callId: 'cancel', args: { view: CHOICES } }])
  const first = await render(h(ViewsTail, { turn, sessionId: 's1', useConversation: useConversationOf(convOf(2)) }))
  await first.unmount()
  assert.equal(signals[0].aborted, true)
  globalThis.fetch = async (_url, options) => {
    if (JSON.parse(options.body).op === 'pending') return Response.json({ ok: true, value: { id: 'v1', callId: 'cancel', view: CHOICES } })
    signals.push(options.signal)
    return new Promise((_resolve, reject) => { options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }) })
  }
  const second = await render(h(ViewsTail, { turn, sessionId: 's1', useConversation: useConversationOf(convOf(2)) }))
  await act(async () => { second.box.querySelector('.dv-q-opt').click() })
  await second.unmount()
  assert.equal(signals[1].aborted, true)
})

test('an answered view renders the settled card from the reply in the chat, no pending fetch', async () => {
  const calls = recordCalls(null)
  const replyText = REPLY('c6', ['B'])
  const turn = makeTurn([{ callId: 'c6', args: { title: 'Pick', view: CHOICES } }])
  const { box, unmount } = await render(h(ViewsTail, { turn, sessionId: 's1', useConversation: useConversationOf(convOf(3, replyText)) }))
  assert.ok(box.querySelector('.dv-q-settled'), 'settled card')
  assert.equal(box.querySelector('.dv-q-submit'), null, 'no live controls')
  assert.equal(calls.filter(body => body.op === 'pending').length, 0, 'answered views never query pending')
  await unmount()
})

test('the reply chat row shows a compact answer summary, not the JSON', async () => {
  const replyText = REPLY('c7', ['B'])
  const event = {
    type: 'user/message', seq: 9, time: 100, surfaceOp: 'append',
    data: {
      id: 'm1',
      source: { kind: 'deep-view-reply', callId: 'c7', outcome: 'answered' },
      content: [{ type: 'text', text: replyText }],
    },
  }
  const matched = viewReplyDefinition.match(event)
  assert.ok(matched, 'definition claims the reply event')
  assert.equal(viewReplyDefinition.match({ ...event, data: { ...event.data, source: { kind: 'user' } } }), null, 'plain user message untouched')
  const state = viewReplyDefinition.start({}, { event, role: 'start' })
  const chatNode = viewReplyDefinition.buildViewNode({ state, key: 'k', id: 'm1', start: { event, location: { kind: 'unresolved' } } })
  assert.equal(chatNode.kind, 'deep-view-reply')
  const { box, unmount } = await render(h(ViewReplyNode, { node: chatNode }))
  assert.equal(box.textContent.trim(), 'B', 'compact inline answer')
  assert.equal(box.querySelector('.dv-ububble, .dv-urow'), null, 'no own bubble styling')
  await unmount()
})

test('the Definition folds only successful show_view calls into turn data', () => {
  const events = [
    { type: 'turn/start', seq: 1, data: { turn: 1 } },
    { type: 'tool/call', seq: 2, data: { turn: 1, step: 1, callId: 'c1', name: 'show_view', arguments: JSON.stringify({ title: 'Stats', view: METER }) } },
    { type: 'tool/call', seq: 3, data: { turn: 1, step: 1, callId: 'c2', name: 'pwsh', arguments: '{"cmd":"x"}' } },
    { type: 'tool/result', seq: 4, data: { turn: 1, step: 1, meta: { owner: 'deep-view' }, message: { source: { callId: 'c1' } } } },
    { type: 'tool/call', seq: 5, data: { turn: 1, step: 1, callId: 'c3', name: 'show_view', arguments: JSON.stringify({ view: CHOICES }) } },
    { type: 'tool/result', seq: 6, data: { turn: 1, step: 1, meta: { owner: 'deep-view' }, message: { source: { callId: 'c3' }, isError: true } } },
    // A show_view another plugin answered carries no marker: its call stays undrawn.
    { type: 'tool/call', seq: 7, data: { turn: 1, step: 2, callId: 'c4', name: 'show_view', arguments: JSON.stringify({ view: METER }) } },
    { type: 'tool/result', seq: 8, data: { turn: 1, step: 2, message: { source: { callId: 'c4' } } } },
  ]
  let context = { state: undefined }
  let state
  for (const event of events) {
    const matched = viewsDefinition.match(event)
    if (matched === null) { assert.equal(event.data.name, 'pwsh'); continue }
    if (matched.role === 'start') state = viewsDefinition.start(context, { event, role: 'start' })
    else state = viewsDefinition.update({ ...context, state }, { event, role: 'update' })
  }
  const data = viewsDefinition.buildLocationData({ ...context, state }, 'turn', null)
  assert.equal(data.key, 'deep-view-views')
  assert.equal(data.value.views.length, 1, 'one successful call')
  assert.equal(data.value.views[0].callId, 'c1')
  assert.deepEqual(data.value.views[0].args, { title: 'Stats', view: METER })
})

test('a WidgetCard uses the dv- class names', async () => {
  const { box, unmount } = await render(h(WidgetCard, { title: 'T', view: METER, settled: true }))
  assert.ok(box.querySelector('.dv-view'))
  assert.ok(box.querySelector('.dv-widget-metric'))
  await unmount()
})

test('a form card renders prefilled, readOnly, and multiline fields, footStart, and cancelLabel', async () => {
  const draft = {
    type: 'form', id: 'mail', submitLabel: 'Send', cancelLabel: 'Discard',
    fields: [
      { id: 'subject', label: '', value: 'Hello team', placeholder: 'Subject' },
      { id: 'from', label: 'From', value: 'me@example.com', readOnly: true },
      { id: 'to', label: 'To', value: 'you@example.com' },
      { id: 'body', label: '', value: 'Line 1\nLine 2', multiline: true },
    ],
  }
  const submitted = []
  const { box, unmount } = await render(h(WidgetCard, {
    title: 'Mail',
    icon: h('svg', { className: 'mail-ic' }),
    footStart: h('span', { className: 'rule-pick' }, 'Require approval'),
    view: draft,
    onSubmit: (action, values) => submitted.push([action, values]),
  }))
  assert.ok(box.querySelector('.dv-view-icon .mail-ic'), 'header icon rendered')
  assert.equal(box.querySelector('.dv-q-foot-start .rule-pick')?.textContent, 'Require approval')
  const inputs = [...box.querySelectorAll('input.dv-q-input')]
  assert.equal(inputs.length, 3)
  assert.equal(inputs[0].value, 'Hello team')
  assert.equal(inputs[1].value, 'me@example.com')
  assert.equal(inputs[1].readOnly, true)
  assert.equal(inputs[2].value, 'you@example.com')
  const area = box.querySelector('textarea.dv-q-textarea')
  assert.ok(area, 'multiline textarea rendered')
  assert.equal(area.value, 'Line 1\nLine 2')
  await act(async () => {
    box.querySelector('button.dv-q-submit').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  })
  assert.deepEqual(submitted, [['mail', { fields: { subject: 'Hello team', from: 'me@example.com', to: 'you@example.com', body: 'Line 1\nLine 2' } }]])
  await act(async () => {
    box.querySelector('button.dv-q-btn').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  })
  assert.deepEqual(submitted[1], ['mail', { canceled: true }])
  await unmount()
})

// The exported key-card counter is shared, so a question card and a view card
// using it at once both stay quiet instead of answering the same letter key.
test('two cards sharing useOptionKeys listen only while one is open', async (t) => {
  const picks = []
  const ownRef = { current: null }
  const Card = ({ tag }) => {
    const hints = useOptionKeys(2, index => picks.push(`${tag}${index}`), ownRef)
    return h('span', { className: `key-${tag}` }, hints ? 'on' : 'off')
  }
  const box = document.createElement('div')
  document.body.appendChild(box)
  const root = createRoot(box)
  t.after(() => act(async () => { root.unmount(); box.remove() }))
  const two = h(Fragment, null, h(Card, { tag: 'a' }), h(Card, { tag: 'b' }))
  await act(async () => { root.render(h(ViewUi.Provider, { value: ui }, two)) })
  assert.equal(box.querySelector('.key-a').textContent, 'off')
  assert.equal(box.querySelector('.key-b').textContent, 'off')
  const press = key => act(async () => { document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, bubbles: true })) })
  await press('A')
  assert.deepEqual(picks, [])
  await act(async () => { root.render(h(ViewUi.Provider, { value: ui }, h(Card, { tag: 'a' }))) })
  assert.equal(box.querySelector('.key-a').textContent, 'on')
  await press('A')
  assert.deepEqual(picks, ['a0'])
})
