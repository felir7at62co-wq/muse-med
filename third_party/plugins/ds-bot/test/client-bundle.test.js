import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { bundleClient } from '../scripts/build-client.mjs'

const committed = () => readFileSync(new URL('../client.js', import.meta.url), 'utf8')

test('client.js is the build of src/client', async () => {
  assert.equal(await bundleClient(), committed(), 'client.js is stale: run `npm run build` and commit it')
  assert.doesNotMatch(committed(), /[ \t]+$/m)
})

// dsh runs client.js as a classic script that hands a factory to the module loader; the
// factory's `require` answers only the shell's platform modules.
test('client.js registers a factory that exports apply and inject', () => {
  const registrations = []
  runInNewContext(committed(), { window: { __ModuleLoader__: { load: registration => registrations.push(registration) } } })
  assert.equal(registrations.length, 1)
  const [{ id, factory, ...rest }] = registrations
  assert.equal(id, 'ds-bot')
  assert.deepEqual(Object.keys(rest), [])

  const requested = []
  const platform = {
    'react': { createElement: () => null, Fragment: Symbol('Fragment'), useState: initial => [initial, () => {}], useEffect: () => {}, useMemo: make => make(), useCallback: fn => fn, useRef: current => ({ current }), useId: () => 'id', useSyncExternalStore: (sub, get) => get(), createContext: initial => ({ value: initial, Provider: () => null }), useContext: ctx => ctx.value },
    'react-dom': { createPortal: node => node },
    '@deepseek-ai/dsh-client-ui-primitives': { MarkdownText: () => null },
  }
  const exports = factory((specifier) => {
    requested.push(specifier)
    if (!(specifier in platform)) throw new Error(`no platform module ${specifier}`)
    return platform[specifier]
  })
  assert.deepEqual([...new Set(requested)].sort(), Object.keys(platform).sort())
  assert.equal(Object.prototype.toString.call(exports), '[object Module]')
  assert.deepEqual(Object.keys(exports), ['apply', 'inject'])
  assert.equal(typeof exports.apply, 'function')
  // No `configForms`: the client never writes the user's DSH settings, such as the
  // work-details mode it once held at `verbose`.
  assert.deepEqual(Array.from(exports.inject), ['sessions', 'uiWorkspace', 'uiConversation', 'slots', 'theme', 'layout'])
})

test('the collapsed mode-selector rail survives Bot to conversation switches until plugin unload', () => {
  let registration
  const styles = new Set()
  const document = {
    styleSheets: [],
    head: { appendChild: style => { style.isConnected = true; styles.add(style) } },
    body: { dataset: {}, style: { setProperty() {}, removeProperty() {} } },
    createElement: () => { const style = { dataset: {}, textContent: '', isConnected: false, remove: () => { style.isConnected = false; styles.delete(style) } }; return style },
    addEventListener() {}, removeEventListener() {},
  }
  runInNewContext(committed(), {
    window: { __ModuleLoader__: { load: value => { registration = value } } }, document,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    MutationObserver: class { observe() {} disconnect() {} }, AbortController, setTimeout, clearTimeout,
  })
  const react = { createElement: () => null, Fragment: Symbol('Fragment'), useState: initial => [initial, () => {}], useEffect() {}, useMemo: make => make(), useCallback: fn => fn, useRef: current => ({ current }), useId: () => 'id', useSyncExternalStore: (_, get) => get(), createContext: value => ({ value }), useContext: ctx => ctx.value }
  const platform = { react, 'react-dom': { createPortal: node => node }, '@deepseek-ai/dsh-client-ui-primitives': { MarkdownText() {}, Tooltip() {} } }
  const plugin = registration.factory(name => platform[name])
  const effects = new Map(), declarations = [], registered = []
  const blankFilters = new Set()
  let retained = 0
  const ctx = {
    effect: (setup, label) => effects.set(label, setup), get: () => undefined,
    inject: () => ({ dispose() {} }), sessions: { list: { getSnapshot: () => ({ byId: {} }) } },
    uiWorkspace: { registerBlankSessionFilter: filter => { blankFilters.add(filter); return () => { blankFilters.delete(filter) } } }, uiConversation: {},
    theme: { overrideTokens: () => () => {} },
    layout: { retainSidebarRail: () => { retained++; return () => { retained-- } } },
    slots: {
      inject: (name, setup) => { declarations.push({ name, setup }); return () => {} },
      register: (options, component) => { registered.push({ options, component }); return () => {} }, entries: () => [],
    },
  }
  plugin.apply(ctx)
  declarations.find(entry => entry.name === 'sidebar.footer.action').setup()
  const surface = registered[0].options.inject().hooks.surface
  const releaseFilter = effects.get('ds-bot: ordinary blank ownership')()
  const [filter] = blankFilters
  assert.equal(filter('ordinary'), false)
  const roster = registered[0].options.inject().hooks.roster
  roster.set({ ...roster.getSnapshot(), ready: true, ownedSessionIds: ['bot', 'past-part', 'group-current'] })
  assert.equal(filter('bot'), false)
  assert.equal(filter('past-part'), false)
  assert.equal(filter('group-current'), false)
  assert.equal(filter('ordinary'), true)
  const releaseRail = effects.get('ds-bot: mode selector rail')()
  const releaseSurface = effects.get('ds-bot: surface')()
  assert.equal(retained, 1)
  assert.ok(declarations.some(entry => entry.name === 'sidebar.workspaces'))
  for (const mode of ['agent', 'bot', 'agent', 'bot']) {
    surface.set({ mode, plain: false })
    assert.equal(retained, 1, `${mode} keeps the collapsed mode controls reachable`)
  }
  releaseSurface()
  assert.equal(retained, 1, 'withdrawing Bot styles does not release the shared rail')
  releaseRail()
  releaseFilter()
  assert.equal(retained, 0)
  assert.equal(blankFilters.size, 0)
  assert.equal(styles.size, 0)
})
