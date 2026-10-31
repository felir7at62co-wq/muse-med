import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { JSDOM } from 'jsdom'
import { install as installModels } from '../src/host/models.js'
import { install as installRoster } from '../src/host/roster.js'

const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/', pretendToBeVisual: true })
const ownedGlobals = ['window', 'document', 'HTMLElement', 'IS_REACT_ACT_ENVIRONMENT']
const descriptors = new Map(ownedGlobals.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
Object.assign(globalThis, { window: dom.window, document: dom.window.document,
  HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })
after(() => {
  dom.window.close()
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor)
    else delete globalThis[key]
  }
})

const require = createRequire(new URL('../../../../packages/client/ui-primitives/package.json', import.meta.url))
const { createElement: h, act } = require('react')
const { createRoot } = require('react-dom/client')
const projection = fileURLToPath(new URL('../../../../packages/client/ui-chat/src/client/conversation-nodes/assistant.ts', import.meta.url))
const bundle = await build({
  stdin: { contents: [
    "export { ModelMenu } from './src/client/model-menu.js'",
    "export { AssistantCell, ToolCell } from './src/client/cells.js'",
    `export { assistantDefinition } from ${JSON.stringify(projection)}`,
  ].join('\n'), resolveDir: fileURLToPath(new URL('../', import.meta.url)) },
  bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const network = []
const module = { exports: {} }
runInNewContext(bundle.outputFiles[0].text, {
  module, exports: module.exports, window: dom.window, document: dom.window.document,
  Element: dom.window.Element, TextEncoder, AbortController, console, setTimeout, clearTimeout,
  requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
  cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
  fetch: async (url, options) => {
    network.push({ url, endpoint: JSON.parse(options.body).endpoint })
    assert.equal(url, 'api/bot')
    assert.equal(JSON.parse(options.body).endpoint, 'thinking')
    return { ok: true, json: async () => ({ ok: true, value: { ms: 1 } }) }
  },
  require: name => name === '@deepseek-ai/dsh-client-ui-primitives'
    ? { MarkdownText: ({ text }) => h('span', { 'data-reply': '' }, text), FishLogo: () => h('span') }
    : require(name),
})
const { ModelMenu, AssistantCell, ToolCell, assistantDefinition } = module.exports
const levels = {
  'gpt-6.1-sol': ['low', 'medium', 'high', 'xhigh', 'max'],
  'gemini-3.1-pro': ['low', 'medium', 'high'],
}
const route = model => `muse-cloud-yunying/${model}`

function runtime(model) {
  const bot = { id: 'selected', name: 'Selected', model: route(model), color: 'blue' }
  const other = { id: 'other', name: 'Other', model: route('gpt-6.1-sol'), effort: 'medium' }
  const defaults = Object.freeze({ provider: 'deepseek', model: 'flash', reasoningEffort: 'low' })
  const selected = []
  const saved = []
  const state = { bots: { selected: bot, other }, rooms: {}, mainBotIds: [] }
  const rt = { state, defaults: {}, botOf: id => state.bots[id], chatOf: id => id,
    groupSessionsOf: () => [], warn() {}, save: async () => saved.push(structuredClone(state)) }
  rt.ctx = {
    on() {},
    get: name => name === 'agentDefaultModel' ? { currentSelection: () => defaults,
      saveSelection: () => { throw new Error('A Bot selection must not save the profile default') } } : undefined,
    llm: {
      listProviders: () => [{ id: 'muse-cloud-yunying', name: 'Muse · 云映' }],
      listModels: async () => Object.keys(levels).map(id => ({ id, name: id })),
      resolveModelInfo: async (_provider, id) => ({ reasoning: {
        efforts: levels[id].map(value => ({ id: value, name: value })),
      } }),
    },
    sessionController: { selectModel: async request => {
      assert.equal(request.saveDefault, false)
      selected.push({ ...request })
      return { selected: request }
    } },
  }
  installModels(rt)
  installRoster(rt)
  return { rt, bot, other, selected, saved, defaults }
}

async function mount(t) {
  const container = document.createElement('div')
  document.body.append(container)
  const app = createRoot(container)
  t.after(async () => { await act(() => app.unmount()); container.remove() })
  return { container, render: async element => act(async () => app.render(element)) }
}

for (const model of Object.keys(levels)) {
  void test(`Yunying ${model} Bot menu clicks persist each offered effort through the real roster and model selector`, async t => {
    const { rt, bot, other, selected, saved, defaults } = runtime(model)
    const originalOther = structuredClone(other)
    const originalDefaults = { ...defaults }
    const view = await mount(t)
    const pending = []
    const actions = { updateBot: (id, patch) => {
      const work = rt.updateBot(id, patch)
      pending.push(work)
      return work
    } }
    const draw = async () => view.render(h(ModelMenu, { bot,
      roster: { models: await rt.catalog({ fresh: true }), defaultModel: 'deepseek/flash' },
      actions, run: promise => promise }))
    for (const effort of levels[model]) {
      await draw()
      await act(() => view.container.querySelector('.bt-model-trigger').click())
      const menu = document.querySelector('.bt-model-menu')
      assert.ok(menu, 'the actual anchored menu opens')
      const offered = [...menu.querySelectorAll('[role="menuitemradio"]')]
      const choices = offered.filter(button => levels[model].includes(button.textContent))
      assert.deepEqual(choices.map(button => button.textContent), levels[model])
      await act(async () => {
        choices.find(button => button.textContent === effort).click()
        await Promise.all(pending.splice(0))
      })
      assert.equal(bot.effort, effort)
      assert.equal(bot.appliedEffort, effort)
      assert.deepEqual(selected.at(-1), { sessionId: bot.id, provider: 'muse-cloud-yunying', model,
        reasoningEffort: effort, saveDefault: false })
      assert.equal(saved.at(-1).bots.selected.effort, effort)
      assert.deepEqual(other, originalOther)
      assert.deepEqual(defaults, originalDefaults)
    }
    await draw()
    await act(() => view.container.querySelector('.bt-model-trigger').click())
    const reset = [...document.querySelectorAll('.bt-model-menu [role="menuitemradio"]')]
      .find(button => button.textContent === 'Default')
    await act(async () => { reset.click(); await Promise.all(pending.splice(0)) })
    assert.equal(bot.effort, undefined)
    assert.equal(Object.hasOwn(selected.at(-1), 'reasoningEffort'), false)
  })
}

void test('changing a Bot from Sol Max to Gemini never submits an unsupported old effort', async t => {
  const { rt, bot, other, selected } = runtime('gpt-6.1-sol')
  bot.effort = 'max'
  const originalOther = structuredClone(other)
  await rt.applyModel(bot)
  const view = await mount(t)
  const pending = []
  const actions = { updateBot: (id, patch) => {
    const work = rt.updateBot(id, patch)
    pending.push(work)
    return work
  } }
  const draw = async () => view.render(h(ModelMenu, { bot,
    roster: { models: await rt.catalog({ fresh: true }), defaultModel: 'deepseek/flash' },
    actions, run: promise => promise }))
  await draw()
  await act(() => view.container.querySelector('.bt-model-trigger').click())
  const gemini = document.querySelector(`[role="menuitemradio"][title="${route('gemini-3.1-pro')}"]`)
  assert.ok(gemini)
  await act(async () => { gemini.click(); await Promise.all(pending.splice(0)) })
  assert.equal(bot.model, route('gemini-3.1-pro'))
  assert.equal(bot.appliedEffort, undefined)
  assert.equal(Object.hasOwn(selected.at(-1), 'reasoningEffort'), false)
  await draw()
  assert.match(view.container.querySelector('.bt-model-provider').textContent, /Default$/)
  await act(() => view.container.querySelector('.bt-model-trigger').click())
  const labels = [...document.querySelectorAll('.bt-model-menu [role="menuitemradio"]')]
    .map(button => button.textContent)
  assert.ok(!labels.includes('max'))
  assert.ok(!labels.includes('xhigh'))
  assert.deepEqual(other, originalOther)
})

// Synthetic text travels through the same projected chunk types returned by the
// verified provider adapter; no supplier request or model-text fixture is loaded.
function streamedStep(turn, step, chunks, status = 'running') {
  let state = assistantDefinition.start({}, { event: { type: 'step/start', data: { turn, step } } })
  chunks.forEach((chunk, index) => {
    state = assistantDefinition.update({ state }, { event: {
      type: 'assistant/live-chunk', seq: index + 1, time: 1000 + index, data: { turn, step, chunk },
    } })
  })
  return { turn, step, status, blocks: state.blocks.filter(Boolean), time: state.firstVisibleTime }
}

function presentation(bot, prefs, steps, tool, actions) {
  const roster = { bots: [bot], byId: { [bot.id]: bot }, rooms: [], roomsById: {}, exchangeTurns: {}, prefs }
  const common = { sessionId: bot.id, useRoster: select => select(roster), actions }
  return h('div', null,
    steps.map(data => h(AssistantCell, { ...common, key: data.step,
      node: { key: `step-${data.step}`, data }, useTurnSteps: () => steps, useTurnContext: () => [],
      useUi: select => select({}) })),
    tool ? h(ToolCell, { ...common, node: { key: tool.callId, data: { root: tool } },
      useUi: select => select({}), useWork: select => select({}) }) : null)
}

for (const prefs of [{}, { thinking: true }, { thinking: false }]) {
  void test(`Bot real assistant projection respects thinking preference ${JSON.stringify(prefs)} without inventing summaries`, async t => {
    const { bot } = runtime('gemini-3.1-pro')
    const view = await mount(t)
    const notes = new Map()
    const actions = { noteLive: (_id, key, value) => value === null ? notes.delete(key) : notes.set(key, value),
      quote() {}, openSession() {}, toggleReaction() {} }
    let steps = [streamedStep(1, 1, [])]
    await view.render(presentation(bot, prefs, steps, undefined, actions))
    assert.equal(view.container.querySelector('.bt-think-text'), null)
    const summary = 'Check the inputs before using the lookup result.'
    steps = [streamedStep(1, 1, [
      { type: 'block-start', index: 0, blockType: 'reasoning' },
      { type: 'reasoning-delta', index: 0, text: summary },
    ])]
    await view.render(presentation(bot, prefs, steps, undefined, actions))
    const expected = prefs.thinking !== false
    assert.equal(view.container.textContent.includes(summary), expected)
    assert.equal(view.container.querySelectorAll('details.bt-think').length, expected ? 1 : 0)
    steps[0] = { ...steps[0], status: 'settled' }
    const pendingTool = { phase: 'start', turn: 1, name: 'probe_value', callId: 'probe-1', argsRaw: '{"value":17}', subCalls: [] }
    await view.render(presentation(bot, prefs, steps, pendingTool, actions))
    assert.match(view.container.querySelector('[data-tool-activity]').textContent, /probe_value.*Result pending/)
    assert.equal(view.container.textContent.includes('{"value":17}'), false)
    const returnedTool = { kind: 'tool-result', turn: 1, name: 'probe_value', callId: 'probe-1',
      call: { name: 'probe_value', argsRaw: '{"value":17}' }, content: [{ type: 'text', text: '17' }], isError: false }
    steps.push(streamedStep(1, 2, [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'The value is 17.' },
    ]))
    await view.render(presentation(bot, prefs, steps, returnedTool, actions))
    assert.match(view.container.querySelector('[data-tool-activity]').textContent, /probe_value.*Result returned/)
    assert.equal(view.container.querySelector('[data-reply]').textContent, 'The value is 17.')
    assert.equal(view.container.textContent.split(summary).length - 1, expected ? 1 : 0)
    assert.ok([...notes.values()].some(value => value.text === true))
    assert.equal(view.container.textContent.includes('Weighing the options'), false)
  })
}
