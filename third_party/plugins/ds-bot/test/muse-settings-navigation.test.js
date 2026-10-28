import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { test } from 'node:test'
import { build } from 'esbuild'
import { JSDOM } from 'jsdom'

const root = fileURLToPath(new URL('../../../../', import.meta.url))
const { outputFiles } = await build({
  stdin: { contents: "export { openHarnessSettings, holdShellShortcuts } from './third_party/plugins/ds-bot/src/client/sidebar.js'; export { MuseAccountLauncher } from './packages/client/ui-muse-account/src/client/MuseAccountLauncher.tsx'; export { en as accountEn, zh as accountZh } from './packages/client/ui-muse-account/src/client/locales.ts'; export { en as modelsEn, zh as modelsZh } from './packages/client/ui-settings-models/src/client/locales.ts';", resolveDir: root },
  bundle: true, format: 'cjs', platform: 'node', write: false, outfile: '/tmp/muse-settings-navigation-test.cjs', logLevel: 'silent', jsx: 'transform', jsxFactory: 'React.createElement',
  loader: { '.css': 'empty' }, external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})

function surface({ language = 'en', panelDelay = 0, mounted = false } = {}) {
  const dom = new JSDOM('<body><main id="app"></main></body>', { url: 'http://127.0.0.1:3397/' })
  const { window } = dom
  const document = window.document
  const frames = []
  const requestAnimationFrame = callback => { frames.push(callback); return frames.length }
  const h = (type, props, ...children) => ({ type, props: { ...props, children: children.flat(Infinity) } })
  const module = { exports: {} }
  runInNewContext(outputFiles[0].text, {
    module, exports: module.exports, window, document, URL, URLSearchParams, setTimeout, clearTimeout,
    React: { createElement: h }, requestAnimationFrame, KeyboardEvent: window.KeyboardEvent,
    require: name => name === 'react' ? { createElement: h }
      : name === '@deepseek-ai/dsh-client-ui-primitives' ? { Tooltip: props => props.children, IconUserOutlineMedium: () => null, IconPaperPlaneOutlineMedium: () => null } : {},
  })
  const ui = module.exports
  const account = language === 'zh' ? ui.accountZh : ui.accountEn
  const modelLabels = language === 'zh' ? ui.modelsZh : ui.modelsEn
  const events = []
  let selected = null
  const panel = () => document.querySelector('[data-shortcut-modal="settings"]')
  const show = () => {
    if (panel()) return
    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    dialog.dataset.shortcutModal = 'settings'
    const nav = document.createElement('nav')
    for (const [id, label] of [['muse-account', account.nav], ['models', modelLabels.nav]]) {
      const button = document.createElement('button')
      button.textContent = label
      button.addEventListener('click', () => { selected = id; events.push(id) })
      nav.append(button)
    }
    dialog.append(nav)
    document.body.append(dialog)
  }
  const later = count => { if (count === 0) show(); else requestAnimationFrame(() => later(count - 1)) }
  const mount = node => {
    if (Array.isArray(node)) return Array.from(node).flatMap(child => { const mounted = mount(child); return Array.isArray(mounted) ? mounted : mounted ? [mounted] : [] })
    if (node === null || node === undefined || node === false) return null
    if (typeof node === 'string' || typeof node === 'number') return document.createTextNode(String(node))
    if (typeof node.type === 'function') return mount(node.type(node.props))
    const element = document.createElement(node.type)
    for (const [key, value] of Object.entries(node.props)) {
      if (key === 'children' || value === undefined || value === null) continue
      if (key.startsWith('on') && typeof value === 'function') element.addEventListener(key.slice(2).toLowerCase(), value)
      else if (key === 'className') element.className = value
      else element.setAttribute(key, String(value))
    }
    for (const child of mount(node.props.children ?? []) ?? []) element.append(child)
    return element
  }
  const launcher = ui.MuseAccountLauncher({ wide: true, feedbackUrl: 'https://example.invalid/feedback',
    t: key => account[key], openSection: id => { selected = id; events.push(id); later(panelDelay) }, openSettings: () => later(panelDelay) })
  document.querySelector('#app').append(mount(launcher))
  if (mounted) show()
  let keyboard = 0
  window.addEventListener('keydown', () => keyboard++)
  const off = ui.holdShellShortcuts({ runtime: 'desktop', platform: 'macos',
    catalog: { getSnapshot: () => [{ id: 'settings.open', binding: { code: 'Comma', modifiers: ['meta'] } }] } })
  return { ui, document, events, panel, selected: () => selected, keyboard: () => keyboard,
    flush: async () => { while (frames.length) { frames.shift()(); await Promise.resolve() } },
    close: () => { off(); dom.window.close() } }
}

for (const language of ['en', 'zh']) {
  test(`model management reaches the actual Muse account launcher and Models navigation in ${language}`, async () => {
    const app = surface({ language, panelDelay: 2 })
    try {
      const account = app.document.querySelector('button[data-muse-account-launcher]')
      assert.ok(account, app.document.body.innerHTML)
      assert.equal(account.getAttribute('aria-label'), 'MUSE')
      const opened = app.ui.openHarnessSettings()
      await app.flush()
      assert.equal(await opened, true)
      assert.deepEqual(app.events, ['muse-account', 'models'])
      assert.equal(app.selected(), 'models')
      assert.equal(app.keyboard(), 0, 'macOS navigation does not rely on synthetic shortcut events')
      assert.ok(app.document.contains(account), 'the native Muse account entry remains mounted')
    } finally { app.close() }
  })
}

test('native Settings navigation does not depend on the account button label', async () => {
  const app = surface({ language: 'zh' })
  try {
    app.document.querySelector('button[data-muse-account-launcher]').setAttribute('aria-label', '团队账号')
    const opened = app.ui.openHarnessSettings()
    await app.flush()
    assert.equal(await opened, true)
    assert.deepEqual(app.events, ['muse-account', 'models'])
    assert.equal(app.keyboard(), 0)
  } finally { app.close() }
})

test('an existing native Settings dialog opens Models without reopening the account panel', async () => {
  const app = surface({ mounted: true })
  try {
    const panel = app.panel()
    const opened = app.ui.openHarnessSettings()
    await app.flush()
    assert.equal(await opened, true)
    assert.deepEqual(app.events, ['models'])
    assert.equal(app.panel(), panel)
  } finally { app.close() }
})

test('a missing Muse Settings launcher does not click a legacy DeepSeek login or claim successful navigation', async () => {
  const app = surface()
  try {
    app.document.querySelector('#app').remove()
    const legacy = app.document.createElement('button')
    legacy.dataset.signedOut = 'true'
    legacy.setAttribute('aria-haspopup', 'menu')
    legacy.setAttribute('aria-label', 'MUSE account')
    let clicked = 0
    legacy.onclick = () => clicked++
    app.document.body.append(legacy)
    const opened = app.ui.openHarnessSettings()
    await app.flush()
    assert.equal(await opened, false)
    assert.equal(clicked, 0)
    assert.equal(app.keyboard(), 0)
  } finally { app.close() }
})
