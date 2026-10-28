// Muse workspace settings navigation and section spacing on real React components.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { after, test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { JSDOM } from 'jsdom'

const dom = new JSDOM('<body></body>', { url: 'http://127.0.0.1:3397/', pretendToBeVisual: true })
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
  stdin: { contents: "export { SettingsDialog } from './src/client/settings.js'; export { CapabilitiesPage } from './src/client/capability-settings.js'; export { SHELL_CSS } from './src/client/styles.js'", resolveDir: root },
  bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const module = { exports: {} }
runInNewContext(bundle.outputFiles[0].text, { module, exports: module.exports, window: dom.window, document: dom.window.document,
  requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
  require: name => name === '@deepseek-ai/dsh-client-ui-primitives' ? {} : require(name), setTimeout, clearTimeout })
const { SettingsDialog, CapabilitiesPage, SHELL_CSS } = module.exports
const roster = { prefs: {}, bots: [], byId: {}, rooms: [], roomsById: {}, connectors: [], capabilities: [] }
async function mount(t, { page = 'general', connectors = [] } = {}) {
  const container = document.createElement('div')
  document.body.append(container)
  const app = createRoot(container)
  const opened = []
  const actions = { closeSettings: () => {}, openSettings: page => opened.push(page), folders: async () => ({}), setSurface: () => {} }
  await act(async () => app.render(h(SettingsDialog, { page, roster: { ...roster, connectors }, actions, useUpdate: read => read({}) })))
  t.after(async () => { await act(() => app.unmount()); container.remove() })
  return { container, opened }
}
const nav = container => [...container.querySelectorAll('nav button')]

test('workspace settings omit upstream capabilities and empty connectors while keeping normal team pages', async t => {
  const { container } = await mount(t)
  const labels = nav(container).map(button => button.textContent)
  assert.ok(!labels.includes('Capabilities'))
  assert.ok(!labels.includes('Connectors'))
  for (const label of ['General', 'Bots', 'Group chats', 'Browser', 'Scheduled tasks', 'Secrets']) assert.ok(labels.includes(label), label)
})

test('an old capabilities page request renders General instead of an orphan editor', async t => {
  const { container } = await mount(t, { page: 'capabilities' })
  assert.equal(container.querySelector('h2').textContent, 'General')
  assert.equal(container.querySelector('nav button[aria-current="page"]').textContent, 'General')
  assert.ok(!container.textContent.includes('Add capability'))
  assert.ok(container.textContent.includes('Appearance'))
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
