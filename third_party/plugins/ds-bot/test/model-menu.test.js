import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const bundle = await build({
  entryPoints: [fileURLToPath(new URL('../src/client/model-menu.js', import.meta.url))],
  bundle: true, format: 'cjs', platform: 'node', write: false,
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const module = { exports: {} }
let menuOpen = false
runInNewContext(bundle.outputFiles[0].text, {
  module, exports: module.exports,
  document: { body: {} },
  require: name => {
    const platform = {
      react: {
        createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
        useState: initial => [menuOpen && initial === null ? { left: 0, top: 0 } : initial, () => {}],
        useEffect: () => {},
        useLayoutEffect: () => {},
        useRef: initial => ({ current: initial }),
      },
      'react-dom': { createPortal: tree => tree },
      '@deepseek-ai/dsh-client-ui-primitives': {},
    }
    if (!(name in platform)) throw new Error(`no platform module ${name}`)
    return platform[name]
  },
})
const { groupModels, ModelChoiceDock, ModelMenu, effortRows } = module.exports

function nodes(tree, match) {
  if (!tree || typeof tree !== 'object') return []
  return [...(match(tree) ? [tree] : []), ...(tree.children ?? []).flatMap(child => nodes(child, match))]
}

// `harness`: the window has DSH's own settings to send the user to, as the plugin does.
function dock(models, { model, ready = true, harness = true } = {}) {
  const picked = []
  const bot = { id: 'chief', name: 'Chief', model }
  const roster = { ready, byId: { chief: bot }, models, defaultModel: models[0]?.ref }
  const tree = ModelChoiceDock({
    sessionId: bot.id, useRoster: select => select(roster),
    actions: {
      updateBot: (id, patch) => { picked.push([id, patch.model]); return Promise.resolve() },
      ...(harness ? { openHarnessSettings: () => {}, openHarnessOnboarding: () => {} } : {}),
    },
  })
  return { tree, picked }
}

const models = [
  { ref: 'official/flash', provider: 'official', providerName: 'DeepSeek', name: 'DeepSeek Flash' },
  { ref: 'local/flash', provider: 'local', providerName: 'Ollama', name: 'DeepSeek Flash' },
  { ref: 'official/pro', provider: 'official', providerName: 'DeepSeek', name: 'DeepSeek Pro' },
]

test('the first model choice shows provider groups and keeps each model route', () => {
  const { tree, picked } = dock(models)
  const groups = nodes(tree, node => node.props.className === 'bt-model-choice-group')
  assert.deepEqual(groups.map(group => group.props['aria-label']), ['DeepSeek', 'Ollama'])
  assert.deepEqual(groups.map(group => nodes(group, node => node.props.className === 'bt-model-choice-provider')[0].children[0]), ['DeepSeek', 'Ollama'])
  const buttons = groups.map(group => nodes(group, node => node.type === 'button'))
  assert.deepEqual(buttons.map(list => list.map(button => button.children[0])), [['DeepSeek Flash', 'DeepSeek Pro'], ['DeepSeek Flash']])
  assert.match(buttons[0][0].props.title, /official\/flash.*Muse default/)
  buttons[1][0].props.onClick()
  buttons[0][0].props.onClick()
  assert.deepEqual(picked, [['chief', 'local/flash'], ['chief', 'official/flash']])
  assert.equal(nodes(tree, node => node.type === 'button' && node.children.includes('Manage models')).length, 1)
})

test('providers with the same display name stay distinct, and unnamed providers use their id', () => {
  const entries = [
    { ...models[0], providerName: 'Cloud' },
    { ...models[1], providerName: 'Cloud' },
    { ref: 'custom/flash', provider: 'custom', name: 'Flash' },
  ]
  const groups = groupModels(entries)
  assert.deepEqual(Array.from(groups, ([label, list]) => [label, Array.from(list, model => model.ref)]), [
    ['Cloud (official)', ['official/flash']],
    ['Cloud (local)', ['local/flash']],
    ['custom', ['custom/flash']],
  ])
})

test('an unavailable model offers the same provider groups', () => {
  const { tree } = dock(models, { model: 'gone/flash' })
  assert.deepEqual(nodes(tree, node => node.props.className === 'bt-model-choice-group').map(group => group.props['aria-label']), ['DeepSeek', 'Ollama'])
  assert.ok(nodes(tree, node => node.props.className === 'bt-bubble')[0].children[0].includes('not available anymore'))
})

test('an empty catalog offers setup choices, and a ready model needs no choice dock', () => {
  const { tree } = dock([])
  assert.deepEqual(nodes(tree, node => node.type === 'button').map(button => button.children[0]), [
    'Manage models',
  ])
  assert.equal(dock(models, { model: models[0].ref }).tree, null)
  assert.equal(dock(models, { ready: false }).tree, null)
})

test('without DSH\'s own settings, the choice offers no way into them', () => {
  const buttons = tree => nodes(tree, node => node.type === 'button').map(button => button.children[0])
  assert.deepEqual(buttons(dock(models, { harness: false }).tree), ['DeepSeek Flash', 'DeepSeek Pro', 'DeepSeek Flash'])
  assert.deepEqual(buttons(dock([], { harness: false }).tree), [])
})

test('the Thinking section always offers Default, so a picked level can be cleared', () => {
  const efforts = [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }]
  // Array.from: the rows come from the bundle's realm, whose arrays are not this one's.
  assert.deepEqual(Array.from(effortRows({ efforts, defaultEffort: 'high' }), row => row.effort), [undefined, 'low', 'high'])
  assert.deepEqual(Array.from(effortRows({ efforts }), row => row.effort), [undefined, 'low', 'high'])
  assert.equal(effortRows({ efforts: [] }).length, 0)
})

for (const model of ['gpt-6.1-sol', 'gemini-3.1-pro']) {
  test(`the Yunying ${model} menu offers and submits each thinking level for its own Bot`, () => {
    const efforts = [{ id: 'low', name: 'Low' }, { id: 'medium', name: 'Medium' }, { id: 'high', name: 'High' }]
    if (model === 'gpt-6.1-sol') efforts.push({ id: 'xhigh', name: 'Extra high' }, { id: 'max', name: 'Max' })
    const reasoning = {
      efforts,
      defaultEffort: 'high',
    }
    const bot = { id: 'selected-bot', name: 'Selected', model: `muse-cloud-yunying/${model}`, effort: model === 'gpt-6.1-sol' ? 'minimal' : 'max' }
    const other = { id: 'other-bot', model: 'muse-cloud-yunying/gpt-6.1-sol', effort: 'medium' }
    const roster = {
      byId: { [bot.id]: bot, [other.id]: other },
      models: [{ ref: bot.model, provider: 'muse-cloud-yunying', providerName: 'Muse · 云映', name: model, reasoning }],
      defaultModel: 'muse-cloud-yunying/gpt-6.1-sol',
    }
    const before = structuredClone(roster)
    const updates = []
    let tree
    menuOpen = true
    try {
      tree = ModelMenu({ bot, roster, actions: { updateBot: (id, patch) => { updates.push([id, patch]); return Promise.resolve() } }, run: promise => promise })
    } finally {
      menuOpen = false
    }
    const section = nodes(tree, node => node.props.reasoning === reasoning)[0]
    const rows = nodes(section.type(section.props), node => node.type === 'button')
    assert.deepEqual(rows.map(row => nodes(row, node => node.props.className === 'bt-menu-label')[0].children[0]), ['Default', ...efforts.map(effort => effort.name)])
    assert.deepEqual(rows.map(row => row.props['aria-checked']), [true, ...efforts.map(() => false)])
    assert.match(nodes(tree, node => node.props.className === 'bt-model-provider')[0].children[0], /High$/)
    for (const row of rows.slice(1)) row.props.onClick()
    assert.deepEqual(JSON.parse(JSON.stringify(updates)), efforts.map(effort => [bot.id, { effort: effort.id }]))
    assert.deepEqual(roster, before)
  })
}

const keyless = [
  { ref: 'official/flash', provider: 'official', providerName: 'DeepSeek', name: 'DeepSeek Flash', needsKey: true },
  { ref: 'official/pro', provider: 'official', providerName: 'DeepSeek', name: 'DeepSeek Pro', needsKey: true },
]

test('models that need an API key are no choice', () => {
  const buttons = tree => nodes(tree, node => node.type === 'button').map(button => button.children[0])
  assert.deepEqual(buttons(dock([...keyless, models[1]], { harness: false }).tree), ['DeepSeek Flash'])
  // Where DSH's own settings are, they take the key.
  assert.deepEqual(buttons(dock(keyless).tree), ['Manage models'])
})

test('a window without DSH settings asks for the missing API key in the first choice', () => {
  const saved = []
  const bot = { id: 'chief', name: 'Chief' }
  const tree = ModelChoiceDock({
    sessionId: bot.id,
    useRoster: select => select({ ready: true, byId: { chief: bot }, models: keyless }),
    actions: { setProviderKey: (provider, value) => { saved.push([provider, value]) } },
  })
  assert.match(nodes(tree, node => node.props.className === 'bt-bubble')[0].children[0], /need a DeepSeek API key/)
  const [card] = nodes(tree, node => node.props.model !== undefined)
  assert.equal(card.props.model.provider, 'official')
  assert.equal(nodes(tree, node => node.props.className === 'bt-model-chips').length, 0)
})
