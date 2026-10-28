// Muse UI regression: curated capability editing without changing Host MCP support.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { after, test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { JSDOM } from 'jsdom'

const dom = new JSDOM('<body></body>', { url: 'http://127.0.0.1:3397/' })
globalThis.window = dom.window
globalThis.document = dom.window.document
globalThis.HTMLElement = dom.window.HTMLElement
globalThis.IS_REACT_ACT_ENVIRONMENT = true
after(() => dom.window.close())
const require = createRequire(new URL('../../../../packages/client/ui-primitives/package.json', import.meta.url))
const { createElement: h, act } = require('react')
const { createRoot } = require('react-dom/client')
const bundle = await build({
  entryPoints: [fileURLToPath(new URL('../src/client/capability-settings.js', import.meta.url))],
  bundle: true, platform: 'node', format: 'cjs', write: false, external: ['react'], logLevel: 'silent',
})
const module = { exports: {} }
runInNewContext(bundle.outputFiles[0].text, { module, exports: module.exports, require, setTimeout, clearTimeout })
const { CapabilitiesPage, BotCapabilitiesCard } = module.exports
const capabilities = [
  { name: 'existing-local', kind: 'mcp', transport: 'stdio', command: 'node', args: ['already-saved.js'], approved: false },
  { name: 'existing-http', kind: 'mcp', transport: 'streamable-http', url: 'https://example.invalid/mcp', approved: true },
  { name: 'dialogue', kind: 'skill', content: 'Keep character voices distinct.', description: 'Dialogue notes' },
  { name: 'production', kind: 'pack', items: ['dialogue', 'existing-local'] },
]
const buttons = node => [...node.querySelectorAll('button')]
const button = (node, label) => buttons(node).find(item => item.textContent.trim() === label)
const field = (node, label) => [...node.querySelectorAll('label')].find(item => item.querySelector('.bt-bs-label')?.textContent === label)?.querySelector('input,textarea,select')
async function click(node) { assert.ok(node); await act(() => node.click()) }
async function change(node, value) {
  assert.ok(node)
  await act(() => {
    const prototype = node.tagName === 'TEXTAREA' ? dom.window.HTMLTextAreaElement.prototype
      : node.tagName === 'SELECT' ? dom.window.HTMLSelectElement.prototype : dom.window.HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(node, value)
    node.dispatchEvent(new dom.window.Event(node.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }))
  })
}
async function mount(t, component = CapabilitiesPage, extra = {}) {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const saved = [], deleted = [], attached = [], approved = []
  const actions = { saveCapability: async payload => saved.push(JSON.parse(JSON.stringify(payload))),
    deleteCapability: async name => deleted.push(name), approveCapability: async name => approved.push(name),
    setBotCapability: async (...args) => attached.push(args) }
  await act(() => root.render(h(component, { roster: { capabilities }, actions, run: promise => promise, ...extra })))
  t.after(async () => { await act(() => root.unmount()); container.remove() })
  return { container, saved, deleted, attached, approved }
}
async function submit(container) {
  await act(async () => container.querySelector('form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })))
}

test('new capability starts as a skill and exposes only skill and pack creation', async t => {
  const app = await mount(t)
  await click(button(app.container, 'Add capability'))
  const type = field(app.container, 'Type')
  assert.equal(type.value, 'skill')
  assert.deepEqual([...type.options].map(option => option.value), ['skill', 'pack'])
  assert.equal(field(app.container, 'Command'), undefined)
  assert.equal(field(app.container, 'URL'), undefined)
  await change(field(app.container, 'Name'), 'new-dialogue')
  await change(field(app.container, 'Description'), 'Voice notes')
  await change(field(app.container, 'Skill instructions'), 'Keep the existing story.')
  await submit(app.container)
  assert.deepEqual(app.saved, [{ name: 'new-dialogue', kind: 'skill', description: 'Voice notes', content: 'Keep the existing story.' }])
})

test('existing skills and packs remain editable and preserve the stored member selection', async t => {
  const app = await mount(t)
  const skillRow = [...app.container.querySelectorAll('.bt-connector')].find(row => row.querySelector('.bt-connector-name')?.textContent === 'dialogue')
  await click(button(skillRow, 'Edit'))
  assert.equal(field(app.container, 'Name').disabled, true)
  assert.equal(field(app.container, 'Skill instructions').value, capabilities[2].content)
  await change(field(app.container, 'Skill instructions'), 'Preserve character voices and continuity.')
  await submit(app.container)
  assert.equal(app.saved[0].content, 'Preserve character voices and continuity.')
  const packRow = [...app.container.querySelectorAll('.bt-connector')].find(row => row.querySelector('.bt-connector-name')?.textContent === 'production')
  await click(button(packRow, 'Edit'))
  assert.equal(field(app.container, 'Type').value, 'pack')
  assert.equal(app.container.querySelectorAll('input[type=checkbox]:checked').length, 2)
  await submit(app.container)
  assert.deepEqual(app.saved[1], { name: 'production', kind: 'pack', description: '', items: ['dialogue', 'existing-local'] })
})

test('a new pack can select existing skills and MCP capabilities without offering MCP connection setup', async t => {
  const app = await mount(t)
  await click(button(app.container, 'Add capability'))
  await change(field(app.container, 'Type'), 'pack')
  await change(field(app.container, 'Name'), 'new-pack')
  const existing = [...app.container.querySelectorAll('label')].find(label => label.textContent === 'existing-http')?.querySelector('input[type=checkbox]')
  await click(existing)
  await submit(app.container)
  assert.deepEqual(app.saved, [{ name: 'new-pack', kind: 'pack', description: '', items: ['existing-http'] }])
})

test('existing MCP rows remain visible and deletable without Edit or Allow actions', async t => {
  const app = await mount(t)
  const rows = [...app.container.querySelectorAll('.bt-connector')].filter(row => row.querySelector('.bt-connector-name')?.textContent.startsWith('existing-'))
  assert.equal(rows.length, 2)
  for (const row of rows) assert.deepEqual(buttons(row).map(item => item.textContent), ['Delete'])
  await click(button(rows[0], 'Delete'))
  assert.deepEqual(app.deleted, [])
  await click(button(app.container, 'Click again to delete.'))
  assert.deepEqual(app.deleted, ['existing-http'])
  assert.deepEqual(app.approved, [])
})

test('Bot capability attachment still includes saved MCP, skills, and packs', async t => {
  const Card = ({ title, children }) => h('section', { 'aria-label': title }, children)
  const SwitchRow = ({ label, on, onChange }) => h('button', { type: 'button', 'aria-pressed': on, onClick: () => onChange(!on) }, label)
  const app = await mount(t, BotCapabilitiesCard, { bot: { id: 'writer', capabilities: ['existing-local'] }, Card, SwitchRow })
  assert.equal(buttons(app.container).length, capabilities.length)
  assert.equal(button(app.container, 'existing-local').getAttribute('aria-pressed'), 'true')
  await click(button(app.container, 'existing-local'))
  await click(button(app.container, 'dialogue'))
  assert.deepEqual(app.attached, [['writer', 'existing-local', false], ['writer', 'dialogue', true]])
})
