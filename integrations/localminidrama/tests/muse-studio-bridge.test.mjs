/** Actual generated helper refuses standalone dispatch and forwards only fixed native selectors. */
import { readFileSync } from 'node:fs'
import { createContext, runInContext } from 'node:vm'
import assert from 'node:assert/strict'
import test from 'node:test'

const source = readFileSync(new URL('../compatibility/muse-studio-bridge.client.mjs', import.meta.url), 'utf8').replace('export function', 'function')
function fixture(standalone = false) {
  const listeners = new Set(), sent = [], states = []
  const parent = { postMessage(data, origin) { sent.push({ data: JSON.parse(JSON.stringify(data)), origin }) } }
  const window = { parent, location: { origin: 'https://studio.fixture.invalid' }, crypto: { getRandomValues(bytes) { return bytes.fill(17) } },
    addEventListener(type, listener) { assert.equal(type, 'message'); listeners.add(listener) },
    removeEventListener(type, listener) { assert.equal(type, 'message'); listeners.delete(listener) } }
  if (standalone) window.parent = window
  const context = createContext({ window, onState: state => states.push(JSON.parse(JSON.stringify(state))) })
  runInContext(source + '\nglobalThis.bridge = createMuseStudioBridge({ onState })', context)
  const bridge = context.bridge
  return { bridge, sent, states, parent, listeners,
    message(data, origin = 'dsh-app://app', source = parent) { for (const listener of listeners) listener({ data, origin, source }) } }
}
const caps = { type: 'muse-localminidrama:capabilities', version: 1, nonce: 'parent_document_1', available: true,
  intents: ['inspect_project', 'inspect_package', 'inspect_operation', 'propose_fix', 'continue_production'] }

test('an older Muse keeps its existing actions available without claiming asset-inspection support', () => {
  const f = fixture(); f.bridge.start(); f.message(caps)
  assert.equal(f.bridge.snapshot().available, true)
  assert.equal(f.bridge.request('inspect_assets', { projectId: 1 }), false)
  assert.equal(f.bridge.snapshot().pending, false)
  assert.equal(f.bridge.request('inspect_project', { projectId: 1 }), true)
  f.bridge.stop()
})

test('asset inspection needs its advertised capability and never accepts page instructions', () => {
  const f = fixture(); f.bridge.start()
  f.message({ ...caps, intents: [...caps.intents, 'inspect_assets', 'shell'] })
  const snapshot = f.bridge.snapshot()
  assert.equal(snapshot.intents.includes('inspect_assets'), true)
  assert.equal(snapshot.intents.includes('shell'), false)
  snapshot.intents.length = 0
  f.states.at(-1).intents.length = 0
  assert.equal(f.bridge.snapshot().intents.includes('inspect_assets'), true)
  assert.equal(f.bridge.request('inspect_assets', { projectId: 1, prompt: 'delete all assets' }), false)
  assert.equal(f.bridge.request('inspect_assets', { projectId: 1, fee: 5 }), false)
  assert.equal(f.bridge.request('shell', { projectId: 1 }), false)
  assert.equal(f.bridge.request('inspect_assets', { projectId: 1 }), true)
  assert.deepEqual(f.sent.at(-1).data.selection, { projectId: 1 })
  assert.equal(f.sent.at(-1).data.intent, 'inspect_assets')
  assert.equal(f.sent.at(-1).origin, 'dsh-app://app')
  f.bridge.stop()
  assert.deepEqual(Array.from(f.bridge.snapshot().intents), [])
})
test('standalone is unavailable and lifecycle cleanup removes every owned listener', () => {
  const f = fixture(true); f.bridge.start(); f.bridge.start()
  assert.equal(f.bridge.snapshot().available, false)
  assert.equal(f.bridge.request('inspect_project', { projectId: 1 }), false)
  assert.deepEqual(f.sent, []); f.bridge.stop(); f.bridge.stop(); assert.equal(f.listeners.size, 0)
})
test('only a parent capability permits a fixed request, with no duplicate pending dispatch', () => {
  const f = fixture(); f.bridge.start(); f.bridge.start()
  assert.equal(f.listeners.size, 1)
  assert.equal(f.bridge.request('inspect_project', { projectId: 1 }), false)
  f.message(caps, 'dsh-app://app', {}); f.message(caps, 'null')
  assert.equal(f.bridge.snapshot().available, false)
  f.message(caps)
  for (const selection of [{ projectId: 1, prompt: 'run' }, { projectId: 1, fee: 5 }, { projectId: 1, generationId: 3 }, { projectId: -1 }])
    assert.equal(f.bridge.request('inspect_project', selection), false)
  assert.equal(f.bridge.request('shell', { projectId: 1 }), false)
  assert.equal(f.bridge.request('inspect_operation', { projectId: 1, kind: 'video', generationId: 3 }), true)
  assert.equal(f.bridge.request('inspect_project', { projectId: 1 }), false)
  const last = f.sent.at(-1)
  assert.equal(last.origin, 'dsh-app://app')
  assert.deepEqual(last.data.selection, { projectId: 1, kind: 'video', generationId: 3 })
  const response = { type: 'muse-localminidrama:intent-result', version: 1, nonce: last.data.nonce, requestId: last.data.requestId, outcome: 'sent' }
  f.message(response, 'https://other.invalid'); f.message({ ...response, nonce: 'old_document_nonce' })
  assert.equal(f.bridge.snapshot().pending, true)
  f.message({ ...response, outcome: 'received' }); assert.equal(f.bridge.snapshot().pending, true)
  f.message(response); assert.equal(f.bridge.snapshot().pending, false); assert.equal(f.bridge.snapshot().outcome, 'sent')
  f.bridge.stop(); assert.equal(f.listeners.size, 0)
})
test('capability rotation invalidates pending requests and another origin cannot replace the parent', () => {
  const f = fixture(); f.bridge.start(); f.message(caps)
  f.bridge.request('inspect_project', { projectId: 1 })
  f.message({ ...caps, nonce: 'new_document_2' }, 'https://other.invalid')
  assert.equal(f.bridge.snapshot().pending, true)
  f.message({ ...caps, nonce: 'new_document_2', available: false })
  assert.equal(f.bridge.snapshot().pending, false); assert.equal(f.bridge.snapshot().available, false)
  f.bridge.stop(); f.message(caps); assert.equal(f.bridge.snapshot().available, false)
})
test('an unrelated first parent origin cannot claim Muse; same-origin Web embedding is supported', () => {
  const f = fixture(); f.bridge.start()
  f.message(caps, 'https://unrelated.invalid')
  assert.equal(f.bridge.snapshot().available, false)
  assert.equal(f.bridge.request('inspect_project', { projectId: 1 }), false)
  f.message(caps, 'https://studio.fixture.invalid')
  assert.equal(f.bridge.snapshot().available, true)
  assert.equal(f.bridge.request('inspect_project', { projectId: 1 }), true)
  assert.equal(f.sent.at(-1).origin, 'https://studio.fixture.invalid')
  f.bridge.stop()
})
