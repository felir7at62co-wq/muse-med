// Muse UI regression: capability setup stays local to mocked actions in these checks.
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
  { name: 'existing-local', kind: 'mcp', transport: 'stdio', command: 'muse-ui-fixture-command', args: ['--fixture'], env: { API_KEY: '$DSH_SECRET_FIXTURE_KEY' }, approved: false },
  { name: 'existing-http', kind: 'mcp', transport: 'streamable-http', url: 'https://example.invalid/mcp', headers: { Authorization: 'Bearer $DSH_SECRET_FIXTURE_KEY' }, approved: true },
  { name: 'dialogue', kind: 'skill', content: 'Keep character voices distinct.', description: 'Dialogue notes' },
  { name: 'production', kind: 'pack', items: ['dialogue', 'existing-local'] },
]
const buttons = node => [...node.querySelectorAll('button')]
const button = (node, label) => buttons(node).find(item => item.textContent.trim() === label)
const capabilityRow = (node, name) => [...node.querySelectorAll('.bt-connector')].find(row => row.querySelector('.bt-connector-name')?.textContent === name)
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
  const before = structuredClone(capabilities)
  const actions = { saveCapability: async payload => saved.push(JSON.parse(JSON.stringify(payload))),
    deleteCapability: async name => deleted.push(name), approveCapability: async name => approved.push(name),
    setBotCapability: async (...args) => attached.push(args) }
  await act(() => root.render(h(component, { roster: { capabilities }, actions, run: promise => promise, ...extra })))
  t.after(async () => {
    await act(() => root.unmount())
    container.remove()
    assert.deepEqual(capabilities, before)
  })
  return { container, saved, deleted, attached, approved, actions }
}
async function submit(container) {
  await act(async () => container.querySelector('form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })))
}

test('creates a local MCP definition with arguments and secret references through a mock save', async t => {
  const app = await mount(t)
  await click(button(app.container, 'Add capability'))
  const type = field(app.container, 'Type')
  assert.equal(type.value, 'mcp')
  assert.deepEqual([...type.options].map(option => option.value), ['mcp', 'skill', 'pack'])
  assert.equal(field(app.container, 'Connection').value, 'stdio')
  assert.equal(field(app.container, 'URL'), undefined)
  await change(field(app.container, 'Name'), '  mock-local  ')
  await change(field(app.container, 'Description'), 'Offline UI fixture')
  await change(field(app.container, 'Command'), 'muse-ui-fixture-command')
  await change(field(app.container, 'Arguments (one per line)'), '--fixture\n\n--label=UI fixture')
  await change(field(app.container, 'Environment (JSON)'), '{"API_KEY":"$DSH_SECRET_FIXTURE_KEY","MODE":"test"}')
  await submit(app.container)
  assert.deepEqual(app.saved, [{ name: 'mock-local', kind: 'mcp', description: 'Offline UI fixture', transport: 'stdio',
    command: 'muse-ui-fixture-command', args: ['--fixture', '--label=UI fixture'], env: { API_KEY: '$DSH_SECRET_FIXTURE_KEY', MODE: 'test' } }])
  assert.equal(app.container.querySelector('form'), null)
  assert.deepEqual(app.approved, [])
  assert.deepEqual(app.attached, [])
})

test('creates an HTTP MCP definition without local-command fields or making a connection', async t => {
  const app = await mount(t)
  await click(button(app.container, 'Add capability'))
  await change(field(app.container, 'Connection'), 'streamable-http')
  assert.equal(field(app.container, 'Command'), undefined)
  assert.equal(field(app.container, 'Environment (JSON)'), undefined)
  await change(field(app.container, 'Name'), 'mock-http')
  await change(field(app.container, 'URL'), 'https://fixture.example.invalid/mcp')
  await change(field(app.container, 'Headers (JSON)'), '{"Authorization":"Bearer $DSH_SECRET_FIXTURE_KEY"}')
  await submit(app.container)
  assert.deepEqual(app.saved, [{ name: 'mock-http', kind: 'mcp', description: '', transport: 'streamable-http',
    url: 'https://fixture.example.invalid/mcp', headers: { Authorization: 'Bearer $DSH_SECRET_FIXTURE_KEY' } }])
  assert.deepEqual(app.approved, [])
  assert.deepEqual(app.attached, [])
})

for (const [transport, label, fieldLabel] of [
  ['stdio', 'Environment', 'Environment (JSON)'],
  ['streamable-http', 'Headers', 'Headers (JSON)'],
]) {
  for (const [text, message] of [['{', 'must be valid JSON.'], ['[]', 'must be a JSON object.'], ['null', 'must be a JSON object.']]) {
    test(`${transport} rejects ${JSON.stringify(text)} before calling the mock save`, async t => {
      const app = await mount(t)
      await click(button(app.container, 'Add capability'))
      await change(field(app.container, 'Connection'), transport)
      await change(field(app.container, 'Name'), 'mock-invalid')
      await change(field(app.container, fieldLabel), text)
      await submit(app.container)
      assert.equal(app.container.querySelector('[role=alert]').textContent, `${label} ${message}`)
      assert.equal(field(app.container, 'Name').value, 'mock-invalid')
      assert.equal(field(app.container, fieldLabel).value, text)
      assert.deepEqual(app.saved, [])
      await change(field(app.container, fieldLabel), '{}')
      await submit(app.container)
      assert.equal(app.saved.length, 1)
      assert.equal(app.container.querySelector('[role=alert]'), null)
    })
  }
}

test('cancelling new or edited MCP forms leaves saved definitions and attachments intact', async t => {
  const app = await mount(t)
  await click(button(app.container, 'Add capability'))
  await change(field(app.container, 'Name'), 'not-saved')
  await change(field(app.container, 'Command'), 'muse-ui-fixture-command')
  await click(button(app.container, 'Cancel'))
  assert.equal(app.container.querySelector('form'), null)
  await click(button(capabilityRow(app.container, 'existing-http'), 'Edit'))
  await change(field(app.container, 'URL'), 'https://discard.example.invalid/mcp')
  await click(button(app.container, 'Cancel'))
  assert.equal(app.container.querySelector('form'), null)
  assert.deepEqual(app.saved, [])
  assert.deepEqual(app.deleted, [])
  assert.deepEqual(app.attached, [])
  assert.deepEqual(app.approved, [])
})

test('a failed save retains the MCP form and allows a retry without changing existing entries', async t => {
  const app = await mount(t)
  const save = app.actions.saveCapability
  let attempts = 0
  app.actions.saveCapability = async () => { attempts++; throw new Error('Fixture save failed') }
  await click(button(capabilityRow(app.container, 'existing-local'), 'Edit'))
  await change(field(app.container, 'Command'), 'muse-ui-retry-command')
  await submit(app.container)
  assert.equal(attempts, 1)
  assert.equal(app.container.querySelector('[role=alert]').textContent, 'Fixture save failed')
  assert.equal(field(app.container, 'Name').value, 'existing-local')
  assert.equal(field(app.container, 'Command').value, 'muse-ui-retry-command')
  assert.equal(app.container.querySelectorAll('.bt-connector').length, capabilities.length)
  assert.deepEqual(app.saved, [])
  assert.deepEqual(app.attached, [])
  app.actions.saveCapability = save
  await submit(app.container)
  assert.equal(app.saved.length, 1)
  assert.equal(app.saved[0].command, 'muse-ui-retry-command')
  assert.equal(app.container.querySelector('form'), null)
})

test('editing existing MCP definitions preserves their names, transports and secret references', async t => {
  const app = await mount(t)
  await click(button(capabilityRow(app.container, 'existing-local'), 'Edit'))
  assert.equal(field(app.container, 'Name').disabled, true)
  assert.equal(field(app.container, 'Type').disabled, true)
  assert.equal(field(app.container, 'Command').value, capabilities[0].command)
  assert.equal(field(app.container, 'Arguments (one per line)').value, '--fixture')
  assert.deepEqual(JSON.parse(field(app.container, 'Environment (JSON)').value), capabilities[0].env)
  await submit(app.container)
  assert.deepEqual(app.saved[0], { name: 'existing-local', kind: 'mcp', description: '', transport: 'stdio',
    command: capabilities[0].command, args: ['--fixture'], env: { API_KEY: '$DSH_SECRET_FIXTURE_KEY' } })
  await click(button(capabilityRow(app.container, 'existing-http'), 'Edit'))
  assert.equal(field(app.container, 'Connection').value, 'streamable-http')
  assert.equal(field(app.container, 'URL').value, capabilities[1].url)
  assert.deepEqual(JSON.parse(field(app.container, 'Headers (JSON)').value), capabilities[1].headers)
  await submit(app.container)
  assert.deepEqual(app.saved[1], { name: 'existing-http', kind: 'mcp', description: '', transport: 'streamable-http',
    url: capabilities[1].url, headers: { Authorization: 'Bearer $DSH_SECRET_FIXTURE_KEY' } })
  assert.deepEqual(app.attached, [])
  assert.deepEqual(app.deleted, [])
})

test('new skills remain available beside MCP and pack creation', async t => {
  const app = await mount(t)
  await click(button(app.container, 'Add capability'))
  await change(field(app.container, 'Type'), 'skill')
  assert.equal(field(app.container, 'Command'), undefined)
  assert.equal(field(app.container, 'Connection'), undefined)
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

test('a new pack can select existing skills and MCP capabilities', async t => {
  const app = await mount(t)
  await click(button(app.container, 'Add capability'))
  await change(field(app.container, 'Type'), 'pack')
  await change(field(app.container, 'Name'), 'new-pack')
  const existing = [...app.container.querySelectorAll('label')].find(label => label.textContent === 'existing-http')?.querySelector('input[type=checkbox]')
  await click(existing)
  await submit(app.container)
  assert.deepEqual(app.saved, [{ name: 'new-pack', kind: 'pack', description: '', items: ['existing-http'] }])
})

test('existing local MCP rows offer Allow and Edit while HTTP rows remain editable', async t => {
  const app = await mount(t)
  const local = capabilityRow(app.container, 'existing-local')
  const http = capabilityRow(app.container, 'existing-http')
  assert.deepEqual(buttons(local).map(item => item.textContent), ['Allow', 'Edit', 'Delete'])
  assert.deepEqual(buttons(http).map(item => item.textContent), ['Edit', 'Delete'])
  await click(button(local, 'Allow'))
  assert.deepEqual(app.approved, ['existing-local'])
  assert.deepEqual(app.saved, [])
  await click(button(http, 'Delete'))
  assert.deepEqual(app.deleted, [])
  await click(button(app.container, 'Click again to delete.'))
  assert.deepEqual(app.deleted, ['existing-http'])
  assert.deepEqual(app.attached, [])
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

test('an already approved local MCP definition stays editable without another Allow action', async t => {
  const app = await mount(t, CapabilitiesPage, { roster: { capabilities: [{ ...capabilities[0], approved: true }] } })
  assert.deepEqual(buttons(capabilityRow(app.container, 'existing-local')).map(item => item.textContent), ['Edit', 'Delete'])
  assert.deepEqual(app.approved, [])
  assert.deepEqual(app.attached, [])
})
