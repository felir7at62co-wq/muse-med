import assert from 'node:assert/strict'
import { test } from 'node:test'
import { install } from '../src/host/models.js'

const PROVIDERS = {
  deepseek: [{ id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash' }, { id: 'deepseek-v4-pro' }],
  ollama: [{ id: 'kimi-k3' }, { id: 'deepseek-v4-pro' }],
}

function runtime(defaultSelection) {
  const ctx = {
    llm: {
      listProviders: () => Object.keys(PROVIDERS).map(id => ({ id })),
      listModels: async id => PROVIDERS[id],
    },
    get: name => (name === 'agentDefaultModel' && defaultSelection ? { currentSelection: () => defaultSelection } : undefined),
  }
  const rt = { ctx, state: { bots: {} } }
  install(rt)
  return rt
}

test('the default model is the DSH default when served, else the first served model', async () => {
  assert.equal(await runtime({ provider: 'ollama', model: 'kimi-k3' }).defaultModel(), 'ollama/kimi-k3')
  assert.equal(await runtime({ provider: 'gone', model: 'x' }).defaultModel(), 'deepseek/deepseek-v4.1-flash')
  assert.equal(await runtime(undefined).defaultModel(), 'deepseek/deepseek-v4.1-flash')
})

test('a model is named by its ref, or by an id or name only one provider serves', async () => {
  const rt = runtime(undefined)
  assert.equal(await rt.resolveModel('ollama/kimi-k3'), 'ollama/kimi-k3')
  assert.equal(await rt.resolveModel(' Kimi-K3 '), 'ollama/kimi-k3')
  assert.equal(await rt.resolveModel('DeepSeek V4.1 Flash'), 'deepseek/deepseek-v4.1-flash')
  await assert.rejects(rt.resolveModel('deepseek-v4-pro'), /more than one provider.*deepseek\/deepseek-v4-pro, ollama\/deepseek-v4-pro/)
  await assert.rejects(rt.resolveModel('kimi'), /not available\. Available models: deepseek\/deepseek-v4\.1-flash/)
})

test('a Bot runs on its own model, else the one it last ran on, else the default', async () => {
  const rt = runtime({ provider: 'ollama', model: 'kimi-k3' })
  assert.equal(await rt.desiredModel({ model: 'deepseek/deepseek-v4-pro', appliedModel: 'ollama/kimi-k3' }), 'deepseek/deepseek-v4-pro')
  assert.equal(await rt.desiredModel({ model: 'gone/model', appliedModel: 'deepseek/deepseek-v4-pro' }), 'deepseek/deepseek-v4-pro')
  assert.equal(await rt.desiredModel({ model: 'gone/model' }), 'ollama/kimi-k3')
})

test('choosing a Bot model leaves the user\'s DSH default model as it was', async () => {
  const writes = []
  let current = { provider: 'ollama', model: 'kimi-k3' }
  const defaults = {
    currentSelection: () => ({ ...current }),
    saveSelection: async (next) => { writes.push(`${next.provider}/${next.model}`); current = { ...next } },
  }
  const ctx = {
    llm: { listProviders: () => [], listModels: async () => [] },
    get: name => (name === 'agentDefaultModel' ? defaults : undefined),
    sessionController: { selectModel: async ({ provider, model, saveDefault }) => {
      if (saveDefault !== false) await defaults.saveSelection({ provider, model })
    } },
  }
  const rt = { ctx, state: { bots: {} }, warn() {} }
  install(rt)
  await Promise.all([
    rt.selectSessionModel('s1', { provider: 'deepseek', model: 'deepseek-v4-pro' }),
    rt.selectSessionModel('s2', { provider: 'deepseek', model: 'deepseek-v4.1-flash' }),
    rt.selectSessionModel('s3', { provider: 'ollama', model: 'kimi-k3' }),
  ])
  assert.deepEqual(current, { provider: 'ollama', model: 'kimi-k3' })
  assert.deepEqual(writes, [])
})

test('a native default changed during a Bot model selection remains the default', async () => {
  const initial = { provider: 'native', model: 'A', reasoningEffort: 'off' }
  const newer = { provider: 'native', model: 'C', reasoningEffort: 'high' }
  let current = initial
  const entered = Promise.withResolvers()
  const release = Promise.withResolvers()
  const writes = []
  const defaults = {
    currentSelection: () => ({ ...current }),
    saveSelection: async selection => { current = { ...selection }; writes.push(selection) },
  }
  const ctx = {
    get: name => name === 'agentDefaultModel' ? defaults : undefined,
    sessionController: { selectModel: async ({ sessionId, saveDefault, ...selection }) => {
      entered.resolve()
      await release.promise
      if (saveDefault !== false) await defaults.saveSelection(selection)
      return { selected: selection }
    } },
  }
  const rt = { ctx, state: { bots: {} }, warn() {} }
  install(rt)
  const selecting = rt.selectSessionModel('bot-session', { provider: 'native', model: 'B', reasoningEffort: 'max' })
  await entered.promise
  await defaults.saveSelection(newer)
  release.resolve()
  assert.deepEqual(await selecting, { selected: { provider: 'native', model: 'B', reasoningEffort: 'max' } })
  assert.deepEqual(current, newer)
  assert.deepEqual(writes, [newer])
})

test('a Bot with no model yet changes nothing until the user picks one', async () => {
  const rt = runtime({ provider: 'ollama', model: 'kimi-k3' })
  assert.equal(await rt.desiredModel({ appliedModel: 'deepseek/deepseek-v4-pro' }), undefined)
  assert.equal(await rt.desiredModel({}), undefined)
  await rt.catalog()
  assert.equal(rt.cachedDefault(), 'ollama/kimi-k3')
})

// A runtime with two providers, a DSH default, and a session controller that, like
// DSH, saves every Session selection as the default.
function bench({ providers = { deepseek: ['v4-flash'], stepfun: ['step-5'] }, fallback = { provider: 'stepfun', model: 'step-5' }, reasoning = {} } = {}) {
  let current = { ...fallback }
  const selected = []
  const saved = []
  const listeners = new Map()
  const ctx = {
    on(name, listener) { listeners.set(name, listener); return () => listeners.delete(name) },
    get: name => (name === 'agentDefaultModel'
      ? { currentSelection: () => ({ ...current }), saveSelection: async (next) => { saved.push(next); current = { ...next } } }
      : undefined),
    llm: {
      listProviders: () => Object.keys(providers).map(id => ({ id, name: id.toUpperCase() })),
      listModels: async id => providers[id].map(model => ({ id: model, name: model, inputModalities: ['text'] })),
      resolveModelInfo: async (provider, model) => reasoning[`${provider}/${model}`] ?? {},
    },
    sessionController: {
      selectModel: async ({ sessionId, provider, model, reasoningEffort, saveDefault }) => {
        selected.push(`${sessionId}:${provider}/${model}${reasoningEffort === undefined ? '' : `:${reasoningEffort}`}`)
        if (saveDefault !== false) current = { provider, model }
      },
    },
  }
  const rt = { ctx, state: { bots: {} }, chatOf: id => id, groupSessionsOf: () => [], save: async () => {}, warn: () => {} }
  install(rt)
  return { rt, selected, saved, providers, listeners, current: () => current }
}

test('the catalog is every model DSH serves, with no lab', async () => {
  const { rt } = bench()
  assert.deepEqual((await rt.catalog()).map(entry => [entry.ref, entry.providerName, 'lab' in entry]), [
    ['deepseek/v4-flash', 'DEEPSEEK', false],
    ['stepfun/step-5', 'STEPFUN', false],
  ])
})

test('a fresh catalog sees a model list changed in DSH settings at once', async () => {
  const { rt, providers } = bench()
  await rt.catalog()
  providers.deepseek = ['deepseek-flash', 'deepseek-v4-pro']
  assert.ok((await rt.catalog()).some(entry => entry.ref === 'deepseek/v4-flash'))
  assert.deepEqual((await rt.catalog({ fresh: true })).filter(entry => entry.provider === 'deepseek').map(entry => entry.id), ['deepseek-flash', 'deepseek-v4-pro'])
})

test('applying a Bot model leaves the DSH default as the user set it', async () => {
  const { rt, selected, current } = bench()
  const bot = { id: 'b1', model: 'deepseek/v4-flash' }
  assert.equal(await rt.applyModel(bot), 'deepseek/v4-flash')
  assert.deepEqual(selected, ['b1:deepseek/v4-flash'])
  assert.deepEqual(current(), { provider: 'stepfun', model: 'step-5' })
  assert.equal(bot.appliedModel, 'deepseek/v4-flash')
})

test('a Bot model applies its thinking level, and only re-selects on a change', async () => {
  const { rt, selected } = bench({ reasoning: { 'deepseek/v4-flash': { reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'high' } } } })
  const bot = { id: 'b1', model: 'deepseek/v4-flash', effort: 'low' }
  await rt.applyModel(bot)
  assert.deepEqual(selected, ['b1:deepseek/v4-flash:low'])
  assert.equal(bot.appliedEffort, 'low')
  await rt.applyModel(bot)
  assert.equal(selected.length, 1)

  // A level the model does not serve is never sent: the model's default applies.
  bot.effort = 'max'
  await rt.applyModel(bot)
  assert.deepEqual(selected.at(-1), 'b1:deepseek/v4-flash')
  assert.equal(bot.appliedEffort, undefined)
})

test('resolveEffort takes an id or a name, and refuses what the model has not', async () => {
  const { rt } = bench({ reasoning: {
    'deepseek/v4-flash': { reasoning: { efforts: [{ id: 'off', name: 'Off' }, { id: 'high', name: 'High' }] } },
    'stepfun/step-5': {},
  } })
  assert.equal(await rt.resolveEffort('deepseek/v4-flash', 'high'), 'high')
  assert.equal(await rt.resolveEffort('deepseek/v4-flash', ' Off '), 'off')
  assert.equal(await rt.resolveEffort('deepseek/v4-flash', ''), undefined)
  await assert.rejects(rt.resolveEffort('stepfun/step-5', 'high'), /no thinking levels/)
  await assert.rejects(rt.resolveEffort('deepseek/v4-flash', 'max'), /not available for deepseek\/v4-flash\. Available: Off, High/)
})

test('the catalog attaches thinking levels to models a Bot uses', async () => {
  const { rt } = bench({ reasoning: { 'deepseek/v4-flash': { reasoning: { efforts: [{ id: 'high', name: 'High' }], defaultEffort: 'high' } } } })
  rt.state.bots.b1 = { id: 'b1', model: 'deepseek/v4-flash' }
  const entries = await rt.catalog()
  assert.deepEqual(entries.find(entry => entry.ref === 'deepseek/v4-flash')?.reasoning, { efforts: [{ id: 'high', name: 'High' }], defaultEffort: 'high' })
  assert.equal(entries.find(entry => entry.ref === 'stepfun/step-5')?.reasoning, undefined)
})

test('a greeting waits for the provider of its Bot model to register', async () => {
  const { rt, providers, listeners } = bench({ providers: {} })
  const waiting = rt.waitForModel({ model: 'stepfun/step-5' }, 5000)
  setTimeout(() => {
    providers.stepfun = ['step-5']
    listeners.get('llm/adapters-updated')?.()
  }, 20)
  assert.equal(await waiting, 'stepfun/step-5')
  assert.equal(await rt.waitForModel({}, 5000), undefined)
})

test('a Bot on the default model with its own thinking level leaves the default level as it was', async () => {
  const fallback = { provider: 'deepseek', model: 'v4-flash', reasoningEffort: 'high' }
  const { rt, current } = bench({ fallback, reasoning: { 'deepseek/v4-flash': { reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'high' } } } })
  rt.ctx.sessionController.selectModel = async ({ provider, model, reasoningEffort, saveDefault }) => {
    const selected = { provider, model, ...(reasoningEffort === undefined ? {} : { reasoningEffort }) }
    if (saveDefault !== false) await rt.ctx.get('agentDefaultModel').saveSelection(selected)
    return { selected }
  }
  await rt.applyModel({ id: 'b1', model: 'deepseek/v4-flash', effort: 'low' })
  assert.deepEqual(current(), fallback)
})

const yunyingModels = ['gpt-6.1-sol', 'gemini-3.1-pro']
const commonYunyingEfforts = [{ id: 'low', name: 'Low' }, { id: 'medium', name: 'Medium' }, { id: 'high', name: 'High' }]
const yunyingReasoningByModel = {
  'gpt-6.1-sol': {
    efforts: [...commonYunyingEfforts, { id: 'xhigh', name: 'Extra high' }, { id: 'max', name: 'Max' }],
    defaultEffort: 'high',
  },
  'gemini-3.1-pro': { efforts: commonYunyingEfforts, defaultEffort: 'high' },
}

for (const model of yunyingModels) {
  test(`Yunying ${model} saves each Bot thinking level without changing another Bot or the default`, async () => {
    const provider = 'muse-cloud-yunying'
    const fallback = { provider, model: 'gpt-6.1-sol', reasoningEffort: 'high' }
    const { rt, selected, current } = bench({
      providers: { [provider]: yunyingModels },
      fallback,
      reasoning: Object.fromEntries(yunyingModels.map(id => [`${provider}/${id}`, { reasoning: yunyingReasoningByModel[id] }])),
    })
    const bot = { id: 'selected-bot', model: `${provider}/${model}` }
    const other = { id: 'other-bot', model: `${provider}/${yunyingModels.find(id => id !== model)}`, effort: 'medium' }
    const otherBefore = structuredClone(other)
    rt.state.bots = { [bot.id]: bot, [other.id]: other }
    const saved = []
    rt.save = async () => { saved.push(structuredClone(rt.state.bots)) }

    for (const { id: effort } of yunyingReasoningByModel[model].efforts) {
      bot.effort = await rt.resolveEffort(bot.model, effort)
      await rt.applyModel(bot)
      assert.equal(selected.at(-1), `${bot.id}:${provider}/${model}:${effort}`)
      assert.equal(saved.at(-1)[bot.id].effort, effort)
      assert.equal(saved.at(-1)[bot.id].appliedEffort, effort)
      assert.deepEqual(other, otherBefore)
      assert.deepEqual(saved.at(-1)[other.id], otherBefore)
      assert.deepEqual(current(), fallback)
    }
    assert.equal(saved.length, yunyingReasoningByModel[model].efforts.length)
  })

  test(`switching a Bot to Yunying ${model} never sends the previous model's unsupported thinking level`, async () => {
    const provider = 'muse-cloud-yunying'
    const { rt, selected } = bench({
      providers: { [provider]: yunyingModels },
      reasoning: Object.fromEntries(yunyingModels.map(id => [`${provider}/${id}`, { reasoning: yunyingReasoningByModel[id] }])),
    })
    const unsupportedEffort = model === 'gpt-6.1-sol' ? 'minimal' : 'max'
    const bot = { id: 'switched-bot', model: `${provider}/${model}`, effort: unsupportedEffort, appliedModel: 'legacy/reasoner', appliedEffort: unsupportedEffort }
    await rt.applyModel(bot)
    assert.deepEqual(selected, [`${bot.id}:${provider}/${model}`])
    assert.equal(bot.appliedEffort, undefined)
    await assert.rejects(rt.resolveEffort(bot.model, unsupportedEffort), /not available/)
  })
}


test('the picker respects selectable metadata without replacing existing hidden Bot models', async () => {
  const providers = [
    { id: 'muse-cloud-yunying', name: 'Muse · 云映' },
    { id: 'chatgpt-subscription', name: 'ChatGPT subscription' },
    { id: 'hidden-provider', selectable: false },
  ]
  const lists = {
    'muse-cloud-yunying': [{ id: 'gpt-6.1-sol' }, { id: 'gemini-3.1-pro' }, { id: 'hidden', selectable: false }],
    'chatgpt-subscription': [{ id: 'gpt-6.1-sol' }],
    'hidden-provider': [{ id: 'legacy' }],
  }
  const ctx = { llm: { listProviders: () => providers, listModels: async id => lists[id] } }
  const rt = { ctx, state: { bots: {} } }
  install(rt)
  assert.deepEqual((await rt.catalog()).map(entry => entry.ref), [
    'muse-cloud-yunying/gpt-6.1-sol', 'muse-cloud-yunying/gemini-3.1-pro', 'chatgpt-subscription/gpt-6.1-sol',
  ])
  await assert.rejects(rt.resolveModel('gpt-6.1-sol'), /more than one provider/)
  assert.equal(await rt.resolveModel('muse-cloud-yunying/gpt-6.1-sol'), 'muse-cloud-yunying/gpt-6.1-sol')
  assert.equal(await rt.desiredModel({ model: 'muse-cloud-yunying/hidden' }), 'muse-cloud-yunying/hidden')
  assert.equal(await rt.desiredModel({ model: 'hidden-provider/legacy' }), 'hidden-provider/legacy')
  assert.equal(await rt.desiredModel({ model: 'missing/model' }), 'muse-cloud-yunying/gpt-6.1-sol')
})
