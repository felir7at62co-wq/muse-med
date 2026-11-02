// Muse workspace settings navigation and section spacing on real React components.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { after, test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { JSDOM } from 'jsdom'

const dom = new JSDOM('<body></body>', { url: 'http://127.0.0.1:3397/', pretendToBeVisual: true })
dom.window.Element.prototype.getAnimations = () => []
globalThis.window = dom.window
globalThis.document = dom.window.document
globalThis.HTMLElement = dom.window.HTMLElement
globalThis.IS_REACT_ACT_ENVIRONMENT = true
after(() => dom.window.close())
const require = createRequire(new URL('../../../../packages/client/ui-primitives/package.json', import.meta.url))
const { createElement: h, act } = require('react')
const { createRoot } = require('react-dom/client')
const root = fileURLToPath(new URL('../', import.meta.url))
const bundle = await build({
  stdin: { contents: "export { SettingsDialog } from './src/client/settings.js'; export { CapabilitiesPage } from './src/client/capability-settings.js'; export { SHELL_CSS } from './src/client/styles.js'; export { installLocale } from './src/client/i18n.js'", resolveDir: root },
  bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const module = { exports: {} }
const preferenceTimers = new Map()
const deferPreference = (callback, delay) => {
  if (delay !== 350) return setTimeout(callback, delay)
  const timer = {}
  preferenceTimers.set(timer, callback)
  return timer
}
const clearPreference = timer => {
  if (!preferenceTimers.delete(timer)) clearTimeout(timer)
}
runInNewContext(bundle.outputFiles[0].text, { module, exports: module.exports, window: dom.window, document: dom.window.document,
  performance: dom.window.performance,
  requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
  require: name => name === '@deepseek-ai/dsh-client-ui-primitives' ? {} : require(name), setTimeout: deferPreference, clearTimeout: clearPreference })
const { SettingsDialog, CapabilitiesPage, SHELL_CSS, installLocale } = module.exports
const roster = { prefs: {}, bots: [], byId: {}, rooms: [], roomsById: {}, connectors: [], capabilities: [] }
async function mount(t, { page = 'general', connectors = [], capabilities = [], prefs = {}, bots = [], browserAutomation, overrides = {} } = {}) {
  const container = document.createElement('div')
  document.body.append(container)
  const app = createRoot(container)
  const opened = []
  const saved = []
  const actions = { closeSettings: () => {}, openSettings: page => opened.push(page), folders: async () => ({}), setSurface: () => {},
    setPrefs: async patch => saved.push(structuredClone(patch)), ...overrides }
  let state = { page, connectors, capabilities, prefs, bots, browserAutomation }
  const render = async next => {
    state = { ...state, ...next }
    await act(async () => app.render(h(SettingsDialog, { page: state.page, roster: { ...roster, prefs: state.prefs, bots: state.bots,
      byId: Object.fromEntries(state.bots.map(bot => [bot.id, bot])), browserAutomation: state.browserAutomation,
      connectors: state.connectors, capabilities: state.capabilities }, actions, useUpdate: read => read({}) })))
  }
  await render()
  let closed = false
  const close = async () => {
    if (closed) return
    closed = true
    await act(() => app.unmount())
    container.remove()
  }
  t.after(close)
  return { container, opened, render, saved, close }
}
const nav = container => [...container.querySelectorAll('nav button')]
const namedButton = (container, label) => [...container.querySelectorAll('button')].find(button => button.textContent.trim() === label)
async function changeField(field, value) {
  assert.ok(field)
  await act(() => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set.call(field, value)
    field.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  })
}
async function flushPreferences() {
  await act(() => {
    const callbacks = [...preferenceTimers.values()]
    preferenceTimers.clear()
    callbacks.forEach(callback => callback())
  })
}

test('workspace settings expose capabilities while omitting empty connectors', async t => {
  const { container } = await mount(t)
  const labels = nav(container).map(button => button.textContent)
  assert.ok(labels.includes('Capabilities'))
  assert.ok(!labels.includes('Connectors'))
  for (const label of ['General', 'Bots', 'Group chats', 'Browser', 'Scheduled tasks', 'Secrets']) assert.ok(labels.includes(label), label)
})

test('a capabilities page request renders its editor and selected navigation entry', async t => {
  const { container } = await mount(t, { page: 'capabilities' })
  assert.equal(container.querySelector('h2').textContent, 'Capabilities')
  assert.equal(container.querySelector('nav button[aria-current="page"]').textContent, 'Capabilities')
  assert.ok(container.textContent.includes('Add capability'))
  assert.ok(container.textContent.includes('Shared capabilities'))
})

test('the capabilities entry navigates and keeps its open form across roster updates', async t => {
  const app = await mount(t)
  const entry = nav(app.container).find(button => button.textContent === 'Capabilities')
  await act(() => entry.click())
  assert.deepEqual(app.opened, ['capabilities'])
  await app.render({ page: app.opened[0] })
  const add = [...app.container.querySelectorAll('button')].find(button => button.textContent === 'Add capability')
  await act(() => add.click())
  const form = app.container.querySelector('form')
  assert.ok(form)
  await app.render({ capabilities: [{ name: 'saved-skill', kind: 'skill', content: 'Keep continuity.' }] })
  assert.equal(app.container.querySelector('h2').textContent, 'Capabilities')
  assert.equal(app.container.querySelector('nav button[aria-current="page"]').textContent, 'Capabilities')
  assert.equal(app.container.querySelector('form'), form)
  assert.ok(app.container.textContent.includes('saved-skill'))
})

test('an unavailable connectors request falls back, while configured connectors remain reachable', async t => {
  const empty = await mount(t, { page: 'connectors' })
  assert.equal(empty.container.querySelector('h2').textContent, 'General')
  const available = await mount(t, { connectors: [{ id: 'github', name: 'GitHub', state: 'ready' }] })
  const entry = nav(available.container).find(button => button.textContent === 'Connectors')
  assert.ok(entry)
  await act(() => entry.click())
  assert.deepEqual(available.opened, ['connectors'])
})

test('closing settings saves the final custom accent before its debounce fires', async t => {
  const app = await mount(t)
  await changeField(app.container.querySelector('input[aria-label="Custom accent"]'), '#123456')
  assert.deepEqual(app.saved, [])
  await app.close()
  assert.deepEqual(app.saved, [{ accent: '#123456' }])
  await flushPreferences()
  assert.equal(app.saved.length, 1)
})

for (const [label, accent] of [['Muse blue', '#4D6BFE'], ['Theme accent', null]]) {
  test(`choosing ${label} replaces a pending custom accent`, async t => {
    const app = await mount(t)
    await changeField(app.container.querySelector('input[aria-label="Custom accent"]'), '#123456')
    await act(() => app.container.querySelector(`button[aria-label="${label}"]`).click())
    await flushPreferences()
    assert.deepEqual(app.saved, [{ accent }])
    await app.close()
    assert.equal(app.saved.length, 1)
  })
}

test('the custom color input follows accepted roster preferences while idle', async t => {
  const app = await mount(t, { prefs: { accent: '#123456' } })
  assert.equal(app.container.querySelector('input[aria-label="Custom accent"]').value, '#123456')
  await app.render({ prefs: { accent: '#654321' } })
  assert.equal(app.container.querySelector('input[aria-label="Custom accent"]').value, '#654321')
  assert.deepEqual(app.saved, [])
})

test('closing settings retains width flushing and an explicit thinking off choice', async t => {
  const app = await mount(t, { prefs: { thinking: true } })
  const thinking = () => app.container.querySelector('[role="switch"][aria-label="Show thinking"]')
  await act(() => thinking().click())
  assert.deepEqual(app.saved, [{ thinking: false }])
  await app.render({ prefs: { thinking: false } })
  assert.equal(thinking().getAttribute('aria-checked'), 'false')
  await changeField(app.container.querySelector('input[aria-label="Bubble width"]'), '95')
  await app.close()
  assert.deepEqual(app.saved, [{ thinking: false }, { width: 95 }])
})

test('enabled browser automation keeps grants per Bot and removal clears the final grant', async t => {
  const updates = []
  const bot = { id: 'fixture-bot', name: 'Fixture Bot' }
  const app = await mount(t, { page: 'browser', browserAutomation: true, bots: [bot], overrides: {
    updateBot: async (...args) => updates.push(structuredClone(args)),
  } })
  await changeField(app.container.querySelector('input.bt-browser-site'), 'https://Example.test/path')
  await act(() => namedButton(app.container, 'Permanent').click())
  await act(() => app.container.querySelector('form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })))
  const grant = { site: 'example.test', kinds: ['post'] }
  assert.deepEqual(updates, [[bot.id, { browserGrants: [grant] }]])
  await app.render({ bots: [{ ...bot, browserGrants: [grant] }] })
  assert.equal(app.container.querySelector('.bt-browser-grant-site').textContent, grant.site)
  await act(() => namedButton(app.container, 'Remove grant').click())
  assert.deepEqual(updates.at(-1), [bot.id, { browserGrants: null }])
})

for (const browserAutomation of [false, undefined]) {
  for (const language of ['en', 'zh']) {
    test(`browser automation ${String(browserAutomation)} keeps grants visible and blocks additions in ${language}`, async t => {
      const dictionaries = new Map()
      const off = installLocale({
        register: (namespace, locale, dictionary) => {
          dictionaries.set(`${namespace}:${locale}`, dictionary)
          return () => dictionaries.delete(`${namespace}:${locale}`)
        },
        bind: namespace => key => (language === 'zh' ? dictionaries.get(`${namespace}:zh`)?.[key] : undefined) ?? key,
        getLocale: () => ({ active: language }),
      })
      t.after(off)
      const updates = []
      const grant = { site: 'fixture.example', kinds: ['post'] }
      const bot = { id: 'fixture-bot', name: 'Fixture Bot', browserGrants: [grant] }
      const original = structuredClone(bot)
      const app = await mount(t, { page: 'browser', bots: [bot], browserAutomation, overrides: {
        updateBot: async (...args) => updates.push(structuredClone(args)),
      } })
      const notice = language === 'zh'
        ? '独立浏览器自动化未启用；已有授权仍保留，不影响其他浏览器工具的权限'
        : 'Bot browser automation is not enabled. Saved grants are kept; permissions for other browser tools are unchanged.'
      assert.equal(app.container.querySelector('.bt-browser-note').textContent, notice)
      assert.equal(app.container.querySelector('.bt-browser-grant-site').textContent, grant.site)
      assert.deepEqual(updates, [])
      const controls = [...app.container.querySelectorAll('.bt-browser-form input, .bt-browser-form select, .bt-browser-form button')]
      assert.ok(controls.length > 0)
      assert.ok(controls.every(control => control.disabled))
      await act(() => app.container.querySelector('form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })))
      assert.deepEqual(updates, [], 'even a dispatched form submit cannot add a disabled grant')
      assert.deepEqual(bot, original)
      const remove = app.container.querySelector('.bt-browser-grant button')
      assert.equal(remove.disabled, false)
      await act(() => remove.click())
      assert.deepEqual(updates, [[bot.id, { browserGrants: null }]])
      assert.deepEqual(bot, original)
    })
  }
}

test('connector failure keeps its form, cancellation clears the token and a later save can succeed', async t => {
  const attempted = []
  const connector = { id: 'github', name: 'GitHub', state: 'off' }
  const app = await mount(t, { page: 'connectors', connectors: [connector], overrides: {
    connectorConnect: async (...args) => {
      attempted.push(args)
      if (attempted.length === 1) throw new Error('Fixture connection refused')
    },
  } })
  const open = async () => act(async () => namedButton(app.container, 'Connect').click())
  const input = () => app.container.querySelector('input[aria-label="GitHub token"]')
  await open()
  await changeField(input(), 'fixture-token-one')
  await act(async () => namedButton(app.container, 'Connect').click())
  assert.equal(app.container.querySelector('[role="alert"]').textContent, 'Fixture connection refused')
  assert.equal(input().value, 'fixture-token-one')
  await act(() => namedButton(app.container, 'Cancel').click())
  assert.equal(app.container.querySelector('.bt-connector-form'), null)
  assert.equal(attempted.length, 1)
  await open()
  assert.equal(input().value, '')
  await changeField(input(), 'fixture-token-two')
  await act(async () => namedButton(app.container, 'Connect').click())
  assert.deepEqual(attempted, [['github', 'fixture-token-one'], ['github', 'fixture-token-two']])
  assert.equal(app.container.querySelector('.bt-connector-form'), null)
  await app.render({ connectors: [{ ...connector, state: 'ready', account: 'fixture-account' }] })
  assert.ok(app.container.textContent.includes('Connected as fixture-account'))
})

test('section headings, action rows and cards use an explicit shared gap without extra heading margins', async t => {
  const container = document.createElement('div')
  const style = document.createElement('style')
  const selectors = ['.bt-set-section', '.bt-set-section h3']
  style.textContent = selectors.map(selector => {
    const start = SHELL_CSS.indexOf(`${selector}{`)
    assert.ok(start >= 0)
    return SHELL_CSS.slice(start, SHELL_CSS.indexOf('}', start) + 1)
  }).join('\n')
  document.head.append(style)
  document.body.append(container)
  const app = createRoot(container)
  await act(() => app.render(h(CapabilitiesPage, { roster, actions: {}, run: promise => promise })))
  t.after(async () => { await act(() => app.unmount()); container.remove(); style.remove() })
  const section = container.querySelector('.bt-set-section')
  assert.ok(section.querySelector(':scope > h3'))
  assert.ok(section.querySelector(':scope > .bt-actions'))
  assert.ok(section.querySelector(':scope > .bt-set-card'))
  const sectionStyle = window.getComputedStyle(section)
  assert.equal(sectionStyle.display, 'flex')
  assert.equal(sectionStyle.flexDirection, 'column')
  assert.equal(sectionStyle.gap, '12px')
  const headingStyle = window.getComputedStyle(section.querySelector('h3'))
  assert.equal(headingStyle.marginBottom, '0px')
  assert.equal(headingStyle.fontWeight, '500')
})
