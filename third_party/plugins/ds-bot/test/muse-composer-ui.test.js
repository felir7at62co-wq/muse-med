/** Composer controls survive the asynchronous arrival and withdrawal of the Bot roster. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { after, test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { JSDOM } from 'jsdom'
import { createSource, EMPTY_ROSTER, indexRoster } from '../src/client/sources.js'

const dom = new JSDOM('<body></body>', { url: 'http://127.0.0.1:3397/', pretendToBeVisual: true })
const globals = Object.fromEntries(['window', 'document', 'HTMLElement', 'IS_REACT_ACT_ENVIRONMENT']
  .map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]))
globalThis.window = dom.window
globalThis.document = dom.window.document
globalThis.HTMLElement = dom.window.HTMLElement
globalThis.IS_REACT_ACT_ENVIRONMENT = true
after(() => {
  dom.window.close()
  for (const [name, descriptor] of Object.entries(globals)) {
    if (descriptor === undefined) delete globalThis[name]
    else Object.defineProperty(globalThis, name, descriptor)
  }
})
const require = createRequire(new URL('../../../../packages/client/ui-primitives/package.json', import.meta.url))
const { createElement: h, act, useSyncExternalStore } = require('react')
const { createRoot } = require('react-dom/client')
const root = fileURLToPath(new URL('../', import.meta.url))
const bundle = await build({
  stdin: { contents: "export { ComposerPlus } from './src/client/composer.js'", resolveDir: root },
  bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const module = { exports: {} }
runInNewContext(bundle.outputFiles[0].text, { module, exports: module.exports,
  window: dom.window, document: dom.window.document, require, setTimeout, clearTimeout })
const { ComposerPlus } = module.exports

test('Add appears after roster hydration and survives unknown or missing Sessions', async t => {
  const source = createSource(EMPTY_ROSTER)
  const useRoster = select => select(useSyncExternalStore(source.subscribe, source.getSnapshot))
  const container = document.createElement('div')
  document.body.append(container)
  const app = createRoot(container)
  t.after(async () => { await act(() => app.unmount()); container.remove() })
  const calls = []
  const actions = { canReferenceChat: () => false, openSettings: (...args) => calls.push(args) }
  const render = sessionId => act(() => app.render(h('div', { 'data-composer-card': '' },
    h('input', { type: 'file' }), h(ComposerPlus, { sessionId, useRoster, actions }))))
  const add = () => container.querySelector('button[aria-label="Add"]')
  await render('current')
  assert.equal(add(), null)

  const known = indexRoster({ ...EMPTY_ROSTER,
    bots: [{ id: 'writer', sessionId: 'current', name: 'Writer' }] })
  await act(() => source.set(known))
  assert.ok(add(), 'the hydrated Bot has an Add control')
  await act(() => source.set(EMPTY_ROSTER))
  assert.equal(add(), null)
  await act(() => source.set(known))
  assert.ok(add())
  await render(undefined)
  assert.equal(add(), null)
  await render('not-in-team')
  assert.equal(add(), null)
  await render('current')
  assert.ok(add())

  await act(() => add().click())
  const menu = document.querySelector('[role="menu"][aria-label="Add"]')
  assert.ok(menu)
  assert.ok([...menu.querySelectorAll('button')].some(button => button.textContent === 'Add files'))
  const schedule = [...menu.querySelectorAll('button')].find(button => button.textContent === 'Scheduled task')
  assert.ok(schedule)
  await act(() => schedule.click())
  assert.deepEqual(calls, [['schedules', 'writer']])
})
