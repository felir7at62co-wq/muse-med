// Muse ships its own updates. A profile whose `bot` entry replaces the plugin's whole config
// drops `updateCheck: false` from cordis.patch.yml; the update checks then stay off end to
// end: no registry request, no update button in the sidebar, no Update in Settings → About.
// `updateCheck: true` brings them back as before.
import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { install as installUpdate } from '../src/host/update.js'
import { install as installDshUpdate } from '../src/host/dsh-update.js'

const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))
const PKG = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const LATEST = `https://registry.npmjs.org/${PKG.name}/latest`
const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

// The sidebar and the About page run as plain functions over a minimal React stand-in,
// as in sidebar-mains.test.js.
const { outputFiles } = await build({
  stdin: {
    contents: "export { TeamSidebar } from './src/client/sidebar.js'\nexport { AboutPage } from './src/client/about.js'",
    resolveDir: PLUGIN,
  },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const react = {
  createContext: (initial) => { const ctx = { value: initial }; ctx.Provider = ({ value, children }) => { ctx.value = value; return children }; return ctx },
  useContext: ctx => ctx.value,
  useCallback: fn => fn,
  useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
  createElement: (type, props, ...children) => ({ type, props: { ...props, children: children.flat(Infinity) } }), Fragment: Symbol('Fragment'),
  useEffect() {}, useLayoutEffect() {}, useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
  useMemo: make => make(), useRef: current => ({ current }), useId: () => 'id',
}
const module = { exports: {} }
runInNewContext(outputFiles[0].text, {
  module, exports: module.exports, setTimeout, clearTimeout,
  window: { innerWidth: 1280, innerHeight: 800, addEventListener() {}, removeEventListener() {} },
  require: name => (name === 'react' ? react : name === 'react-dom' ? { createPortal: node => node } : {}),
})
const { TeamSidebar, AboutPage } = module.exports

const walk = (node, match, out = []) => {
  if (Array.isArray(node)) { node.forEach(child => walk(child, match, out)); return out }
  if (!node || typeof node !== 'object') return out
  if (match(node)) out.push(node)
  walk(node.props?.children, match, out)
  return out
}

// Both update modules on one host runtime, as the plugin installs them, with the config
// a profile gives the `bot` entry. The registry has a newer DS Bot that verified a newer
// DSH than the running one, so a check that runs finds both.
function host(config) {
  const fetched = []
  const spawns = []
  globalThis.fetch = async (url) => {
    fetched.push(url)
    if (url !== LATEST) return { ok: false, status: 404, json: async () => ({}) }
    return { ok: true, status: 200, json: async () => ({ version: '9.0.0', dsBot: { verifiedDsh: '9.9.9' } }) }
  }
  const pluginManager = {
    listBundles: async () => [{ name: PKG.name, source: `${PKG.name}@^${PKG.version}` }],
    registries: async () => ({ registry: null, fallbackRegistries: [], resolved: 'https://registry.npmjs.org/' }),
    installBundle: async () => ({ application: 'restart-required', version: '9.0.0' }),
  }
  const loader = {
    import: async name => (name === '@deepseek-ai/dsh-app-boot' ? { getDshRuntimeVersion: () => '0.1.0' } : {}),
    unwrapExports: exports => exports,
  }
  const rt = {
    ctx: { get: name => ({ pluginManager, loader, profileContext: {} })[name], effect() {} },
    config,
    warn() {},
    dshSpawn: (command, argv) => {
      spawns.push(argv)
      const child = new EventEmitter()
      child.stdout = new EventEmitter()
      child.stderr = new EventEmitter()
      queueMicrotask(() => child.emit('close', 0))
      return child
    },
  }
  installUpdate(rt)
  installDshUpdate(rt)
  // What the window's update source holds after `update-check` (channel.js).
  const check = async () => ({ ...(await rt.updateCheck({ fresh: true })), dsh: (await rt.dshUpdateCheck({ fresh: true })) ?? null })
  return { rt, check, fetched, spawns }
}

// The cloud button at the top of the open column, run from the sidebar.
function sidebarUpdate(update) {
  const tree = TeamSidebar({
    actions: { openPalette() {}, openNewChat() {}, toggleSidebar() {}, installUpdate: async () => {}, installDshUpdate: async () => {} },
    useSidebarPref: () => 'open',
    useRoster: pick => pick({ bots: [], rooms: [], agents: [], byId: {}, ready: true }), useUi: pick => pick({ unread: {} }), useRegistry: pick => pick({}),
    useSessions: pick => pick({ ids: [], byId: {} }), useUpdate: pick => pick(update),
  })
  const [button] = walk(tree, node => node.type?.name === 'UpdateButton')
  assert.ok(button, 'the open column has an update seat')
  return button.type(button.props)
}

// The Updates section of Settings → About: each row's label and its buttons.
function aboutUpdates(update) {
  const tree = AboutPage({ useUpdate: pick => pick(update), actions: { repoStars: async () => null }, run: promise => promise, Section: 'section', Row: 'row' })
  return walk(tree, node => node.type === 'row' && ['Muse', 'DeepSeek Harness'].includes(node.props.label))
    .map(row => ({ label: row.props.label, buttons: walk(row.props.children, node => node.type === 'button').map(button => button.props.children.join('')) }))
}

test('without updateCheck in the config nothing is fetched and no update control renders', async () => {
  const { rt, check, fetched, spawns } = host({ agentPreset: 'short-drama-v2', mainName: 'Muse' })
  const update = await check()
  assert.deepEqual(fetched, [])
  assert.equal(update.enabled, false)
  assert.equal(update.available, false)
  assert.equal(update.dsh.available, false)
  assert.equal(sidebarUpdate(update), null)
  assert.deepEqual(aboutUpdates(update), [])
  assert.throws(() => rt.updateStart(), /No Muse update/)
  assert.throws(() => rt.dshUpdateStart(), /No DSH update/)
  assert.deepEqual(spawns, [])
})

test('with updateCheck: true the checks run and the update controls render as before', async () => {
  const { check, fetched } = host({ updateCheck: true })
  const update = await check()
  assert.deepEqual(fetched, [LATEST, LATEST])
  assert.equal(update.available, true)
  assert.equal(update.latest, '9.0.0')
  assert.equal(update.dsh.available, true)
  const cloud = sidebarUpdate(update)
  assert.ok(cloud, 'the sidebar shows its update button')
  assert.equal(walk(cloud, node => node.type === 'button' && String(node.props.className).includes('bt-update')).length, 1)
  assert.deepEqual(aboutUpdates(update), [
    { label: 'Muse', buttons: ['Update'] },
    { label: 'DeepSeek Harness', buttons: ['Update'] },
  ])
})
