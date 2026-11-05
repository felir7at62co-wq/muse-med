import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { JSDOM } from 'jsdom'

const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/' })
const descriptors = new Map(['window', 'document', 'HTMLElement', 'IS_REACT_ACT_ENVIRONMENT'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })
after(() => {
  dom.window.close()
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor)
    else delete globalThis[key]
  }
})
const require = createRequire(new URL('../../../../packages/client/ui-primitives/package.json', import.meta.url))
const { createElement: h, act, useSyncExternalStore } = require('react')
const { createRoot } = require('react-dom/client')
const bundle = await build({
  stdin: { contents: "export { LearningDock, LearningTurnTail } from './src/client/learning-card.js'; export { createSource } from './src/client/sources.js'; export { createLearningRecovery } from './src/client/learning-recovery.js'; export { apply } from './src/client/index.js'", resolveDir: fileURLToPath(new URL('../', import.meta.url)) },
  bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const module = { exports: {} }
const requests = []
const refused = () => ({ ok: true, json: async () => ({ ok: false, error: { code: 'bot/refused', message: 'Controlled write failure' } }) })
let responseFor = refused
runInNewContext(bundle.outputFiles[0].text, { module, exports: module.exports, require: name => name === '@deepseek-ai/dsh-client-ui-primitives' ? { MarkdownText: () => null } : require(name), AbortController, console, setTimeout, clearTimeout, window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage, MutationObserver: dom.window.MutationObserver,
  fetch: async (url, options) => {
    assert.equal(url, 'api/bot')
    requests.push({ body: JSON.parse(options.body), signal: options.signal })
    return responseFor(options)
  },
})
const { LearningDock, LearningTurnTail, createSource, createLearningRecovery, apply } = module.exports
const proposal = { id: 'learn-recovery', botId: 'writer', at: 100, kind: 'skill', action: 'create', name: 'Dialogue notes', description: 'Keep character voices distinct.', content: 'Preserve the established voice.\n' }
const useSource = source => select => useSyncExternalStore(source.subscribe, () => select(source.getSnapshot()))
const facts = { turns: new Map() }
const bot = { id: 'writer', sessionId: 'writer-current' }
const rosterOf = proposals => createSource({ byId: { 'writer-current': bot }, learning: { writer: proposals } })
const plain = value => JSON.parse(JSON.stringify(value))
function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
async function mount(t, roster, recovery, turnFacts = facts) {
  const container = document.createElement('div')
  document.body.append(container)
  let app
  const actions = { learningAnswer: (value, approve) => recovery.answer(value, approve), turnFacts: () => turnFacts, watchTurns: () => () => {} }
  const render = async (component = LearningDock, extra = {}) => {
    app = createRoot(container)
    await act(async () => app.render(h(component, { ...extra, sessionId: 'writer-current', useRoster: useSource(roster), useLearningRecovery: useSource(recovery.state), actions })))
  }
  const unmount = async () => { if (app) { await act(() => app.unmount()); app = undefined } }
  t.after(async () => { await unmount(); container.remove(); await recovery.dispose() })
  await render()
  return { container, remount: async () => { await unmount(); await render() }, moveToTail: async turn => { await unmount(); await render(LearningTurnTail, { turn: { turn } }) } }
}
const click = async (view, kind = 'approve') => act(async () => view.container.querySelector(`.bt-learning-${kind}`).click())
const visible = view => [...view.container.querySelectorAll('.bt-learning-card')].map(card => ({
  role: card.getAttribute('role'),
  title: card.querySelector('.bt-q-title').textContent,
  kind: card.querySelector('.bt-q-detail')?.textContent,
  detail: card.querySelector('.bt-learning-description')?.textContent,
  file: card.querySelector('.bt-learning-name').textContent,
  path: card.querySelector('.bt-learning-path').textContent,
  lines: [...card.querySelectorAll('.bt-learning-text')].map(line => line.textContent),
  error: card.querySelector('[role="alert"]')?.textContent ?? null,
  busy: card.getAttribute('aria-busy'),
  buttons: [...card.querySelectorAll('.bt-learning-foot button')].map(button => ({ label: button.textContent, disabled: button.disabled })),
}))

void test('a proposal closed by the Host is not resurrected as an actionable failed card', async t => {
  const roster = rosterOf([proposal])
  const recovery = createLearningRecovery(async () => { throw Object.assign(new Error('This proposal is no longer open'), { code: 'bot/stale' }) })
  const view = await mount(t, roster, recovery)
  await click(view)
  assert.equal(view.container.querySelectorAll('.bt-learning-card').length, 0, 'stale acknowledgement closes an old roster entry immediately')
  await act(async () => roster.set({ byId: { 'writer-current': bot }, learning: { writer: [] } }))
  await view.remount()
  assert.equal(view.container.querySelectorAll('.bt-learning-card').length, 0)
  assert.deepEqual(plain(recovery.state.getSnapshot()), { [proposal.id]: { status: 'closed' } })
})

void test('a retryable failure keeps review content and error across a same-owner remount and can be declined', async t => {
  const calls = []
  const recovery = createLearningRecovery(async (id, approve) => {
    calls.push({ id, approve })
    if (approve) throw new Error('Could not write SKILL.md')
  })
  const view = await mount(t, rosterOf([proposal]), recovery)
  await click(view)
  assert.equal(view.container.querySelector('[role="alert"]').textContent, 'Could not write SKILL.md')
  await view.remount()
  assert.equal(view.container.querySelector('[role="alert"]').textContent, 'Could not write SKILL.md')
  assert.match(view.container.textContent, /Preserve the established voice/)
  await click(view, 'decline')
  assert.equal(view.container.querySelectorAll('.bt-learning-card').length, 0)
  assert.deepEqual(calls, [{ id: proposal.id, approve: true }, { id: proposal.id, approve: false }])
  assert.deepEqual(plain(recovery.state.getSnapshot()), { [proposal.id]: { status: 'closed' } })
})

void test('failed answers cannot cross client plugin owners with the same Bot and proposal ids', async t => {
  const first = createLearningRecovery(async () => { throw new Error('Private write failure') })
  const view = await mount(t, rosterOf([proposal]), first)
  await click(view)
  await act(async () => first.dispose())
  assert.deepEqual(plain(first.state.getSnapshot()), {})
  const next = createLearningRecovery(async () => {})
  const nextView = await mount(t, rosterOf([]), next)
  assert.deepEqual(visible(nextView), [])
  assert.deepEqual(plain(next.state.getSnapshot()), {})
})

void test('an AGENTS.md failure follows its proposal from the composer dock into a closed turn', async t => {
  const agents = { id: 'learn-agents', botId: 'writer', at: 100, kind: 'agents', folder: '/workspace/project', exists: true,
    edits: [{ op: 'replace', old: 'Keep answers brief.', text: 'Keep answers concrete.', why: 'User requested concrete detail.' }] }
  const turnFacts = { turns: new Map() }
  const recovery = createLearningRecovery(async () => { throw new Error('Could not write AGENTS.md') })
  const view = await mount(t, rosterOf([agents]), recovery, turnFacts)
  await click(view)
  turnFacts.turns = new Map([[7, { turn: 7, status: 'closed', end: { time: 90 } }]])
  await view.moveToTail(7)
  assert.equal(view.container.querySelector('[role="alert"]').textContent, 'Could not write AGENTS.md')
  assert.match(view.container.textContent, /Keep answers brief/)
  assert.match(view.container.textContent, /Keep answers concrete/)
  assert.match(view.container.textContent, /User requested concrete detail/)
  assert.equal(view.container.querySelector('.bt-learning-decline').disabled, false)
})

void test('one admitted answer stays busy across remounts and duplicate clicks share its result', async t => {
  const gate = deferred()
  const calls = []
  const recovery = createLearningRecovery((...args) => { calls.push(args); return gate.promise })
  const view = await mount(t, rosterOf([proposal]), recovery)
  try {
    await click(view)
    const existing = recovery.answer(proposal, false)
    await view.remount()
    assert.equal(view.container.querySelector('.bt-learning-approve').disabled, true)
    assert.equal(view.container.querySelector('.bt-learning-decline').disabled, true)
    assert.equal(calls.length, 1)
    await act(async () => { gate.resolve(); await existing })
    assert.deepEqual(visible(view), [])
  } finally {
    await act(async () => gate.resolve())
  }
})

void test('dispose aborts and drains admitted work without retaining late failures or admitting new answers', async () => {
  const gate = deferred()
  let signal, calls = 0
  const recovery = createLearningRecovery((_id, _approve, value) => { calls++; signal = value; return gate.promise })
  const answer = recovery.answer(proposal, true)
  await Promise.resolve()
  let disposed = false
  const disposal = recovery.dispose().then(() => { disposed = true })
  try {
    assert.equal(signal.aborted, true)
    assert.deepEqual(plain(recovery.state.getSnapshot()), {})
    await recovery.answer(proposal, false)
    assert.equal(calls, 1)
    assert.equal(disposed, false, 'disposal waits for an already admitted callback')
    gate.reject(new Error('Late failure'))
    await Promise.all([answer, disposal])
    assert.equal(disposed, true)
    assert.deepEqual(plain(recovery.state.getSnapshot()), {})
  } finally {
    gate.resolve()
    await Promise.all([answer, disposal])
  }
})

void test('dispose before dispatch does not call the Host', async () => {
  let calls = 0
  const recovery = createLearningRecovery(async () => { calls++ })
  const answer = recovery.answer(proposal, true)
  const disposal = recovery.dispose()
  await Promise.all([answer, disposal])
  assert.equal(calls, 0)
  assert.deepEqual(plain(recovery.state.getSnapshot()), {})
})

function pluginOwner() {
  const effects = new Map(), declarations = [], registered = []
  const ctx = {
    effect: (setup, label) => effects.set(label, setup), get: () => undefined,
    inject: () => ({ dispose() {} }), sessions: { list: { getSnapshot: () => ({ byId: {} }) } },
    uiWorkspace: { registerBlankSessionFilter: () => () => {} }, uiConversation: {},
    theme: { overrideTokens: () => () => {} }, layout: { retainSidebarRail: () => () => {} },
    slots: { inject: (name, setup) => { declarations.push({ name, setup }); return () => {} }, register: (options, component) => { registered.push({ options, component }); return () => {} }, entries: () => [] },
  }
  apply(ctx)
  declarations.find(entry => entry.name === 'sidebar.footer.action').setup()
  const face = registered[0].options.inject()
  assert.equal(registered[0].options.inject().hooks.learningRecovery, face.hooks.learningRecovery)
  return { face, dispose: effects.get('ds-bot: learning answer recovery')() }
  }

void test('apply injects the same recovery into its slots and disposes only its own owner', async t => {
  const first = pluginOwner(), second = pluginOwner()
  t.after(async () => { await first.dispose(); await second.dispose() })
  assert.notEqual(first.face.hooks.learningRecovery, second.face.hooks.learningRecovery)
  await first.face.actions.learningAnswer(proposal, true)
  assert.deepEqual(requests.at(-1).body, { endpoint: 'learning-answer', payload: { id: proposal.id, approve: true } })
  assert.equal(first.face.hooks.learningRecovery.getSnapshot()[proposal.id].error, 'Controlled write failure')
  assert.deepEqual(plain(second.face.hooks.learningRecovery.getSnapshot()), {})
  await first.dispose()
  assert.equal(requests.at(-1).signal.aborted, true)
  assert.deepEqual(plain(first.face.hooks.learningRecovery.getSnapshot()), {})
})

void test('a successful approval refresh stays cancellable and cannot apply roster data after client disposal', async t => {
  const refresh = deferred()
  const started = deferred()
  const owner = pluginOwner()
  t.after(async () => { await owner.dispose() })
  const before = owner.face.hooks.roster.getSnapshot()
  responseFor = async options => {
    if (JSON.parse(options.body).endpoint === 'learning-answer') return { ok: true, json: async () => ({ ok: true, value: {} }) }
    started.resolve()
    return refresh.promise
  }
  const answer = owner.face.actions.learningAnswer(proposal, true)
  try {
    await started.promise
    assert.equal(requests.at(-1).body.endpoint, 'state')
    assert.equal(owner.face.hooks.learningRecovery.getSnapshot()[proposal.id].status, 'answering')
    let disposed = false
    const disposal = owner.dispose().then(() => { disposed = true })
    assert.equal(requests.at(-1).signal.aborted, true)
    await Promise.resolve()
    assert.equal(disposed, false)
    refresh.resolve({ ok: true, json: async () => ({ ok: true, value: { unchanged: true, learning: { writer: [proposal] } } }) })
    await Promise.all([answer, disposal])
    assert.equal(owner.face.hooks.roster.getSnapshot(), before)
    assert.deepEqual(plain(owner.face.hooks.learningRecovery.getSnapshot()), {})
  } finally {
    responseFor = refused
    refresh.resolve({ ok: true, json: async () => ({ ok: true, value: { unchanged: true } }) })
    await answer
  }
})

void test('learning approval DOM keeps retryable review details and closes terminal proposals', async t => {
  const expected = JSON.parse(readFileSync(new URL('./fixtures/learning-recovery.expected.json', import.meta.url), 'utf8'))
  const gate = deferred()
  let attempt = 0
  const recovery = createLearningRecovery(async () => {
    if (attempt++ === 0) return gate.promise
    throw Object.assign(new Error('This proposal is no longer open'), { code: 'bot/stale' })
  })
  const view = await mount(t, rosterOf([proposal]), recovery)
  try {
    const states = { open: visible(view) }
    await click(view)
    states.answering = visible(view)
    await act(async () => gate.reject(new Error('Could not write SKILL.md')))
    states.failed = visible(view)
    await view.remount()
    states.remounted = visible(view)
    await click(view, 'decline')
    states.closed = visible(view)
    assert.deepEqual(states, expected)
  } finally {
    await act(async () => gate.resolve())
  }
})
